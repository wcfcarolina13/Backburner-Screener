import { BackburnerDetector } from './backburner-detector.js';
import { GoldenPocketDetector, type GoldenPocketSetup } from './golden-pocket-detector.js';
import { GoldenPocketDetectorV2, type GoldenPocketV2Setup } from './golden-pocket-detector-v2.js';
import {
  getExchangeInfo,
  get24hTickers,
  getKlines,
  getFuturesContracts,
  getFuturesTickers,
  getFuturesKlines,
  futuresSymbolToSpot,
  type FuturesSymbolInfo,
  type FuturesTickerInfo,
} from './mexc-api.js';
import { DEFAULT_CONFIG, TIMEFRAME_MS, SETUP_EXPIRY_MS, FUTURES_WHITELIST } from './config.js';
import {
  buildMarketDataCache,
  getMarketCap,
  getMarketCapRank,
  getCoinName,
  hasMarketCapData,
  isCoinGeckoAvailable,
} from './coingecko-api.js';
import type { Timeframe, BackburnerSetup, SymbolInfo, ScreenerConfig, QualityTier, MarketType, LiquidityRisk } from './types.js';

// Eligible symbol with market type info
interface EligibleSymbol {
  symbol: string;           // Standardized symbol (BTCUSDT format)
  futuresSymbol?: string;   // Futures symbol if applicable (BTC_USDT format)
  marketType: MarketType;
  volume24h: number;
  liquidityRisk: LiquidityRisk;
}

export interface ScreenerEvents {
  onNewSetup?: (setup: BackburnerSetup) => void;
  onSetupUpdated?: (setup: BackburnerSetup) => void;
  onSetupRemoved?: (setup: BackburnerSetup) => void;
  onScanProgress?: (completed: number, total: number, phase: string) => void;
  onScanStatus?: (status: string) => void;
  onError?: (error: Error, symbol?: string) => void;
}

/**
 * Real-time Backburner Screener
 *
 * Continuously scans all MEXC assets for Backburner setups
 * and maintains an up-to-date list of candidates.
 */
// How often to refresh the symbol list (30 minutes)
const SYMBOL_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export class BackburnerScreener {
  private detector: BackburnerDetector;
  private goldenPocketDetector: GoldenPocketDetector;
  private goldenPocketDetectorV2: GoldenPocketDetectorV2;
  private config: ScreenerConfig;
  private events: ScreenerEvents;
  private isRunning = false;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private symbolRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private eligibleSymbols: EligibleSymbol[] = [];
  private symbolVolumes: Map<string, number> = new Map();
  private lastFullScan: Map<Timeframe, number> = new Map();
  private lastSymbolRefresh: number = 0;
  private previousSetups: Map<string, BackburnerSetup> = new Map();
  // Keep played-out setups visible (no longer updated, but shown in display)
  private playedOutSetups: Map<string, BackburnerSetup> = new Map();
  // Track futures symbols that consistently fail (don't retry them)
  private badFuturesSymbols: Set<string> = new Set();
  // Golden Pocket specific tracking (V1 strict)
  private previousGPSetups: Map<string, GoldenPocketSetup> = new Map();
  private playedOutGPSetups: Map<string, GoldenPocketSetup> = new Map();
  // Golden Pocket V2 tracking (loose thresholds)
  private previousGPV2Setups: Map<string, GoldenPocketV2Setup> = new Map();
  private playedOutGPV2Setups: Map<string, GoldenPocketV2Setup> = new Map();

  constructor(config?: Partial<ScreenerConfig>, events?: ScreenerEvents) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events || {};
    this.detector = new BackburnerDetector(this.config);
    // Golden Pocket detector with specific config for hype plays (V1 - strict)
    this.goldenPocketDetector = new GoldenPocketDetector({
      minImpulsePercent: 5,          // 5% move minimum
      impulseLookbackCandles: 12,    // ~60min on 5m, ~3h on 15m
      minRelativeVolume: 2,          // 2x average volume (lowered from 3x for more signals)
    });
    // Golden Pocket V2 - loosened thresholds for more signals
    this.goldenPocketDetectorV2 = new GoldenPocketDetectorV2({
      minImpulsePercent: 4,          // 4% move (vs 5% in V1)
      impulseLookbackCandles: 15,    // Wider lookback
      minRelativeVolume: 1.5,        // 1.5x volume (vs 2x in V1)
    });
  }

  /**
   * Start the screener
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Screener is already running');
    }

    this.isRunning = true;

    // Fetch CoinGecko market data for market cap filtering
    await buildMarketDataCache((msg) => {
      this.events.onScanProgress?.(0, 1, msg);
    });

    // Initial symbol discovery
    await this.discoverSymbols();
    this.lastSymbolRefresh = Date.now();

    // Initial full scan
    await this.runFullScan();

    // Set up continuous scanning
    this.scanInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.runIncrementalScan();
      }
    }, this.config.updateIntervalMs);

    // Set up periodic symbol refresh (every 30 minutes)
    this.symbolRefreshInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.refreshSymbols();
      }
    }, SYMBOL_REFRESH_INTERVAL_MS);
  }

  /**
   * Stop the screener
   */
  stop(): void {
    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.symbolRefreshInterval) {
      clearInterval(this.symbolRefreshInterval);
      this.symbolRefreshInterval = null;
    }
  }

  /**
   * Calculate liquidity risk based on 24h volume
   */
  private getLiquidityRisk(volume24h: number): LiquidityRisk {
    if (volume24h >= 5_000_000) return 'low';      // $5M+ = safe
    if (volume24h >= 1_000_000) return 'medium';   // $1M-$5M = moderate
    return 'high';                                  // <$1M = risky for leverage
  }

  /**
   * Discover eligible trading symbols from both spot and futures markets
   */
  private async discoverSymbols(): Promise<void> {
    this.events.onScanProgress?.(0, 1, 'Fetching spot and futures info...');

    try {
      // Fetch spot and futures data in parallel with retry on failure
      const [exchangeInfo, spotTickers, futuresContracts, futuresTickers] = await Promise.all([
        getExchangeInfo().catch((e) => {
          console.error('[Screener] Failed to fetch exchange info:', e.message);
          return [] as SymbolInfo[];
        }),
        get24hTickers().catch((e) => {
          console.error('[Screener] Failed to fetch spot tickers:', e.message);
          return [] as { symbol: string; quoteVolume: string }[];
        }),
        getFuturesContracts().catch(() => [] as FuturesSymbolInfo[]),
        getFuturesTickers().catch(() => [] as FuturesTickerInfo[]),
      ]);

      // If exchange info failed, retry once after delay
      if (exchangeInfo.length === 0) {
        console.log('[Screener] Retrying exchange info fetch after 5s...');
        await new Promise(r => setTimeout(r, 5000));
        const retryInfo = await getExchangeInfo().catch(() => [] as SymbolInfo[]);
        if (retryInfo.length > 0) {
          exchangeInfo.push(...retryInfo);
        }
      }

      if (exchangeInfo.length === 0) {
        console.error('[Screener] Could not fetch exchange info - will retry on next refresh');
        return;
      }

      // Build volume maps
      const spotVolumeMap = new Map<string, number>();
      for (const ticker of spotTickers) {
        spotVolumeMap.set(ticker.symbol, parseFloat(ticker.quoteVolume));
        this.symbolVolumes.set(ticker.symbol, parseFloat(ticker.quoteVolume));
      }

      const futuresVolumeMap = new Map<string, number>();
      for (const ticker of futuresTickers) {
        futuresVolumeMap.set(ticker.symbol, ticker.amount24);
      }

      // Build set of futures symbols (convert to spot format for comparison)
      const futuresSymbolSet = new Set<string>();
      const futuresSymbolMap = new Map<string, string>(); // spotSymbol -> futuresSymbol
      for (const contract of futuresContracts) {
        const spotSymbol = futuresSymbolToSpot(contract.symbol);
        futuresSymbolSet.add(spotSymbol);
        futuresSymbolMap.set(spotSymbol, contract.symbol);
      }

      this.eligibleSymbols = [];

      // Process spot symbols — only include those with MEXC futures contracts.
      // Spot-only symbols are skipped entirely since we trade on futures.
      // Only add the futures entry to avoid scanning each symbol twice.
      let skippedNoFutures = 0;
      for (const info of exchangeInfo) {
        const volume24h = spotVolumeMap.get(info.symbol) || 0;
        if (!this.isEligibleSymbol(info, volume24h)) continue;

        // Must have a futures contract to be tradeable
        const hasFutures = futuresSymbolSet.has(info.symbol);
        const futuresSymbol = futuresSymbolMap.get(info.symbol);
        if (!hasFutures || !futuresSymbol) {
          skippedNoFutures++;
          continue;
        }

        const futuresVolume = futuresVolumeMap.get(futuresSymbol) || 0;

        // Add futures entry only — this is what we actually trade on
        this.eligibleSymbols.push({
          symbol: info.symbol,
          futuresSymbol,
          marketType: 'futures',
          volume24h: futuresVolume,
          liquidityRisk: this.getLiquidityRisk(futuresVolume),
        });
        this.symbolVolumes.set(`futures:${info.symbol}`, futuresVolume);
      }
      if (skippedNoFutures > 0) {
        console.log(`[Screener] Skipped ${skippedNoFutures} spot-only symbols (no futures contract)`);
      }

      // Also add futures-only symbols (not on spot but on futures)
      let futuresOnlyAdded = 0;
      let futuresOnlyWhitelisted = 0;
      for (const contract of futuresContracts) {
        const spotSymbol = futuresSymbolToSpot(contract.symbol);
        const alreadyAdded = this.eligibleSymbols.some(
          s => s.symbol === spotSymbol && s.marketType === 'futures'
        );

        if (!alreadyAdded) {
          const volume24h = futuresVolumeMap.get(contract.symbol) || 0;
          // Apply basic filters for futures-only
          if (volume24h < this.config.minVolume24h) continue;

          // Check exclude patterns (STOCK tokens, stablecoins, etc.)
          const baseAsset = contract.baseCoin || spotSymbol.replace(/USDT$/i, '');
          let excluded = false;
          for (const pattern of this.config.excludePatterns) {
            if (pattern.test(baseAsset) || pattern.test(spotSymbol)) {
              excluded = true;
              break;
            }
          }
          if (excluded) continue;

          // Allow whitelisted futures-only symbols (commodities, RWA) to bypass CoinGecko
          const isWhitelisted = FUTURES_WHITELIST.includes(contract.symbol);
          if (!isWhitelisted && this.config.requireMarketCap && !hasMarketCapData(spotSymbol)) continue;

          this.eligibleSymbols.push({
            symbol: spotSymbol,
            futuresSymbol: contract.symbol,
            marketType: 'futures',
            volume24h,
            liquidityRisk: this.getLiquidityRisk(volume24h),
          });
          this.symbolVolumes.set(`futures:${spotSymbol}`, volume24h);
          futuresOnlyAdded++;
          if (isWhitelisted) futuresOnlyWhitelisted++;
        }
      }
      if (futuresOnlyAdded > 0) {
        console.log(`[Screener] Added ${futuresOnlyAdded} futures-only symbols (${futuresOnlyWhitelisted} whitelisted)`);
      }

      const spotCount = this.eligibleSymbols.filter(s => s.marketType === 'spot').length;
      const futuresCount = this.eligibleSymbols.filter(s => s.marketType === 'futures').length;

      this.events.onScanProgress?.(
        1,
        1,
        `Found ${spotCount} spot + ${futuresCount} futures symbols`
      );
    } catch (error) {
      this.events.onError?.(error as Error);
      throw error;
    }
  }

  /**
   * Refresh symbol list and CoinGecko data periodically
   */
  private async refreshSymbols(): Promise<void> {
    try {
      this.events.onScanStatus?.('Refreshing symbol list...');

      // Refresh CoinGecko market data first
      await buildMarketDataCache((msg) => {
        this.events.onScanStatus?.(msg);
      });

      const prevCount = this.eligibleSymbols.length;

      // Re-run full discovery
      await this.discoverSymbols();

      const newCount = this.eligibleSymbols.length;
      const diff = newCount - prevCount;

      this.lastSymbolRefresh = Date.now();

      this.events.onScanStatus?.(
        `Refreshed: ${newCount} symbols (${diff >= 0 ? '+' : ''}${diff})`
      );

      // Run a full scan after refresh
      if (diff > 0) {
        await this.runFullScan();
      }
    } catch (error) {
      this.events.onError?.(error as Error);
      // Don't throw - just log and continue with existing symbols
    }
  }

  /**
   * Check if a symbol is eligible for screening
   */
  private isEligibleSymbol(info: SymbolInfo, volume24h: number): boolean {
    // Must be actively trading (MEXC uses "1" for enabled)
    if (info.status !== '1' && info.status !== 'ENABLED') {
      return false;
    }

    // Must be USDT pair (most liquid)
    if (info.quoteAsset !== 'USDT') {
      return false;
    }

    // Must meet minimum volume
    if (volume24h < this.config.minVolume24h) {
      return false;
    }

    // Check market cap requirements (filters fake volume)
    // Skip if CoinGecko is unavailable (blocked on cloud providers like Render)
    if (this.config.requireMarketCap && isCoinGeckoAvailable()) {
      if (!hasMarketCapData(info.symbol)) {
        return false; // Not on CoinGecko = likely scam/fake
      }
      const marketCap = getMarketCap(info.symbol);
      if (!marketCap || marketCap < this.config.minMarketCap) {
        return false; // Below minimum market cap
      }
    }

    // Check exclusion patterns
    for (const pattern of this.config.excludePatterns) {
      if (pattern.test(info.baseAsset) || pattern.test(info.symbol)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Run a full scan of all symbols across all timeframes
   * Uses parallel batch processing for speed (5x faster than sequential)
   */
  async runFullScan(): Promise<void> {
    const totalSymbols = this.eligibleSymbols.length;
    let completed = 0;

    // Sort symbols to prioritize 5m timeframe detection (shorter timeframes first)
    // Group by unique symbol, prioritizing futures (typically more liquid)
    const sortedSymbols = [...this.eligibleSymbols].sort((a, b) => {
      // Futures first (more liquid, what user trades)
      if (a.marketType !== b.marketType) {
        return a.marketType === 'futures' ? -1 : 1;
      }
      // Higher volume first
      return b.volume24h - a.volume24h;
    });

    this.events.onScanProgress?.(0, totalSymbols, `Starting parallel scan of ${totalSymbols} symbols...`);

    // Process in parallel batches of 8 (MEXC can handle ~10 concurrent requests)
    const BATCH_SIZE = 8;

    for (let i = 0; i < sortedSymbols.length; i += BATCH_SIZE) {
      if (!this.isRunning) break;

      const batch = sortedSymbols.slice(i, i + BATCH_SIZE);

      // Process batch in parallel
      await Promise.all(
        batch.map(async (eligibleSymbol) => {
          try {
            await this.analyzeSymbolAllTimeframes(eligibleSymbol);
          } catch (error) {
            this.events.onError?.(error as Error, eligibleSymbol.symbol);
          }
        })
      );

      completed += batch.length;

      // Update progress
      const lastSymbol = batch[batch.length - 1];
      const label = lastSymbol.marketType === 'futures' ? '[F]' : '[S]';
      this.events.onScanProgress?.(
        completed,
        totalSymbols,
        `Scanning: ${label} ${lastSymbol.symbol.replace('USDT', '')} (${completed}/${totalSymbols})...`
      );
    }

    // Mark all timeframes as scanned
    const now = Date.now();
    for (const tf of this.config.timeframes) {
      this.lastFullScan.set(tf, now);
    }

    this.events.onScanProgress?.(totalSymbols, totalSymbols, 'Scan complete');
  }

  /**
   * Run an incremental scan (only update active setups and check for new ones)
   * Priority: triggered/deep_extreme setups get updated first
   */
  async runIncrementalScan(): Promise<void> {
    // Get current active setups
    const activeSetups = this.detector.getActiveSetups();

    // Prioritize triggered and deep_extreme setups (these need real-time updates)
    const prioritySetups = activeSetups.filter(
      s => s.state === 'triggered' || s.state === 'deep_extreme'
    );
    const otherSetups = activeSetups.filter(
      s => s.state !== 'triggered' && s.state !== 'deep_extreme'
    );

    // Update priority setups first (triggered/deep_extreme)
    if (prioritySetups.length > 0) {
      this.events.onScanStatus?.(`Updating ${prioritySetups.length} priority setups...`);
      for (const setup of prioritySetups) {
        try {
          await this.analyzeSymbol(setup.symbol, setup.timeframe, setup.marketType);
        } catch (error) {
          this.events.onError?.(error as Error, setup.symbol);
        }
      }
    }

    // Update other active setups (reversing, watching)
    for (const setup of otherSetups) {
      try {
        await this.analyzeSymbol(setup.symbol, setup.timeframe, setup.marketType);
      } catch (error) {
        this.events.onError?.(error as Error, setup.symbol);
      }
    }

    // Check a subset of symbols for new setups (rotating through)
    const symbolsToCheck = this.getSymbolsForIncrementalCheck();
    this.events.onScanStatus?.(`Checking ${symbolsToCheck.length} symbols for new setups...`);

    for (const timeframe of this.config.timeframes) {
      for (const eligibleSymbol of symbolsToCheck) {
        if (!this.isRunning) break;

        // Skip if already have an active setup for this symbol/tf/market combo
        const existingSetup = activeSetups.find(
          s => s.symbol === eligibleSymbol.symbol &&
               s.timeframe === timeframe &&
               s.marketType === eligibleSymbol.marketType
        );
        if (existingSetup) continue;

        try {
          await this.analyzeSymbol(eligibleSymbol.symbol, timeframe, eligibleSymbol.marketType);
        } catch (error) {
          // Silently ignore errors in incremental scan
        }
      }
    }

    // Clean up expired setups (both active and played-out)
    this.cleanupExpiredSetups();

    const totalActive = activeSetups.length;
    const totalPlayedOut = this.playedOutSetups.size;
    const spotCount = this.eligibleSymbols.filter(s => s.marketType === 'spot').length;
    const futuresCount = this.eligibleSymbols.filter(s => s.marketType === 'futures').length;
    this.events.onScanStatus?.(`Monitoring ${spotCount}S + ${futuresCount}F symbols | ${totalActive} active | ${totalPlayedOut} played out`);
  }

  /**
   * Get a subset of symbols to check in incremental scan
   * Faster rotation: checks 20% of symbols every 30 seconds = full cycle in 2.5 minutes
   */
  private getSymbolsForIncrementalCheck(): EligibleSymbol[] {
    const now = Date.now();
    // Rotate every 30 seconds, 5 buckets = full scan every 2.5 minutes
    const rotationIndex = Math.floor(now / 30000) % 5;

    // Prioritize futures and higher volume in each bucket
    const bucket = this.eligibleSymbols.filter((_, i) => i % 5 === rotationIndex);

    // Sort by priority: futures first, then by volume
    return bucket.sort((a, b) => {
      if (a.marketType !== b.marketType) {
        return a.marketType === 'futures' ? -1 : 1;
      }
      return b.volume24h - a.volume24h;
    });
  }

  /**
   * Analyze a single symbol across all configured timeframes (more efficient)
   * Fetches all timeframe data in parallel, then analyzes each
   */
  private async analyzeSymbolAllTimeframes(eligibleSymbol: EligibleSymbol): Promise<void> {
    const { symbol, futuresSymbol, marketType, volume24h, liquidityRisk } = eligibleSymbol;
    const timeframes = this.config.timeframes;

    // Skip futures symbols that have consistently failed
    if (marketType === 'futures' && futuresSymbol && this.badFuturesSymbols.has(futuresSymbol)) {
      return;
    }

    // Choose the right API based on market type
    const fetchKlines = marketType === 'futures' && futuresSymbol
      ? (sym: string, tf: Timeframe) => getFuturesKlines(futuresSymbol, tf)
      : getKlines;

    // Fetch candles for all timeframes in parallel
    let allFailed = true;
    const candlePromises = timeframes.map(tf =>
      fetchKlines(symbol, tf).then(result => {
        allFailed = false;
        return result;
      }).catch(() => null)
    );

    // Also fetch higher timeframes for confirmation (1h for 5m/15m, 4h for 1h)
    const htfPromises = [
      fetchKlines(symbol, '1h').catch(() => null),  // HTF for 5m, 15m
      fetchKlines(symbol, '4h').catch(() => null),  // HTF for 1h
    ];

    const [candleResults, htfResults] = await Promise.all([
      Promise.all(candlePromises),
      Promise.all(htfPromises),
    ]);

    // If all fetches failed for a futures symbol, mark it as bad
    if (marketType === 'futures' && futuresSymbol && allFailed) {
      this.badFuturesSymbols.add(futuresSymbol);
      // Don't log - it's been added to the skip list
      return;
    }

    const [htf1h, htf4h] = htfResults;

    // Analyze each timeframe with the fetched data
    for (let i = 0; i < timeframes.length; i++) {
      const timeframe = timeframes[i];
      const candles = candleResults[i];

      if (!candles || candles.length < 50) {
        continue;
      }

      // Select appropriate higher timeframe
      // TCG pairings: 5m entry → 1h HTF, 15m entry → 4h HTF
      let higherTFCandles;
      if (timeframe === '5m') {
        higherTFCandles = htf1h ?? undefined;
      } else if (timeframe === '15m') {
        higherTFCandles = htf4h ?? undefined;
      }
      // 1h and 4h: no HTF pairing — dashboard-only, not for auto-trading

      // analyzeSymbol returns an array (can have both long and short setups)
      const setups = this.detector.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);

      for (const setup of setups) {
        this.processSetup(setup, symbol, timeframe, marketType, volume24h, liquidityRisk);
      }

      // Also run Golden Pocket detectors (for hype/pump plays)
      // Only run on 5m and 15m timeframes where the strategy is most effective
      if (timeframe === '5m' || timeframe === '15m') {
        // V1 (strict thresholds)
        const gpSetups = this.goldenPocketDetector.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);
        for (const gpSetup of gpSetups) {
          this.processGoldenPocketSetup(gpSetup as GoldenPocketSetup, symbol, timeframe, marketType, volume24h, liquidityRisk);
        }
        // V2 (loose thresholds - should generate more signals)
        const gpV2Setups = this.goldenPocketDetectorV2.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);
        for (const gpV2Setup of gpV2Setups) {
          this.processGoldenPocketV2Setup(gpV2Setup as GoldenPocketV2Setup, symbol, timeframe, marketType, volume24h, liquidityRisk);
        }
      }
    }
  }

  /**
   * Process a detected setup (add metadata and emit events)
   */
  private processSetup(
    setup: BackburnerSetup,
    symbol: string,
    timeframe: Timeframe,
    marketType: MarketType = 'spot',
    volume24h: number = 0,
    liquidityRisk: LiquidityRisk = 'medium'
  ): void {
    // Add volume and quality tier info
    setup.volume24h = volume24h || this.symbolVolumes.get(symbol) || 0;

    // Add CoinGecko data
    setup.coinName = getCoinName(symbol);
    setup.marketCap = getMarketCap(symbol);
    setup.marketCapRank = getMarketCapRank(symbol);

    // Quality tier now based on market cap
    setup.qualityTier = this.getQualityTier(setup.marketCap || 0);

    // Add market type and liquidity risk
    setup.marketType = marketType;
    setup.liquidityRisk = liquidityRisk;

    const key = `${symbol}-${timeframe}-${setup.direction}-${marketType}`;
    const previousSetup = this.previousSetups.get(key);
    const recentlyPlayedOut = this.playedOutSetups.get(key);

    if (setup.state === 'played_out') {
      // Setup played out - move to played-out list (stays visible, no longer updated)
      if (previousSetup) {
        this.previousSetups.delete(key);
        // Mark when it played out
        setup.playedOutAt = Date.now();
        this.playedOutSetups.set(key, setup);
        this.events.onSetupRemoved?.(setup);
      }
    } else if (!previousSetup) {
      // Check if this setup recently played out - don't re-trigger too quickly
      // This prevents the same setup from being opened/closed repeatedly
      if (recentlyPlayedOut) {
        const timeSincePlayedOut = Date.now() - (recentlyPlayedOut.playedOutAt || 0);
        // Cooldown period based on timeframe: 5m=5min, 15m=15min, 1h=30min
        const cooldownMs = timeframe === '5m' ? 5 * 60 * 1000 :
                           timeframe === '15m' ? 15 * 60 * 1000 :
                           30 * 60 * 1000;
        if (timeSincePlayedOut < cooldownMs) {
          // Still in cooldown, don't treat as new setup
          return;
        }
        // Cooldown expired, remove from played out and allow as new
        this.playedOutSetups.delete(key);
      }
      // New setup
      this.previousSetups.set(key, setup);
      this.events.onNewSetup?.(setup);
    } else {
      // Existing setup updated
      // Trigger update if: state changed, RSI moved significantly, or price moved significantly
      const priceChangePercent = Math.abs(
        (setup.currentPrice - previousSetup.currentPrice) / previousSetup.currentPrice
      ) * 100;
      const shouldUpdate =
        previousSetup.state !== setup.state ||
        Math.abs(previousSetup.currentRSI - setup.currentRSI) > 0.5 ||
        priceChangePercent > 0.1; // Update on >0.1% price move for real-time P&L

      if (shouldUpdate) {
        this.events.onSetupUpdated?.(setup);
      }
      this.previousSetups.set(key, setup);
    }
  }

  /**
   * Process a Golden Pocket setup (similar to processSetup but for GP strategy)
   * Golden Pocket setups are identified with 'gp-' prefix in their key
   */
  private processGoldenPocketSetup(
    setup: GoldenPocketSetup,
    symbol: string,
    timeframe: Timeframe,
    marketType: MarketType = 'spot',
    volume24h: number = 0,
    liquidityRisk: LiquidityRisk = 'medium'
  ): void {
    // Add metadata
    setup.volume24h = volume24h || this.symbolVolumes.get(symbol) || 0;
    setup.coinName = getCoinName(symbol);
    setup.marketCap = getMarketCap(symbol);
    setup.marketCapRank = getMarketCapRank(symbol);
    setup.qualityTier = this.getQualityTier(setup.marketCap || 0);
    setup.marketType = marketType;
    setup.liquidityRisk = liquidityRisk;

    // Use 'gp-' prefix to distinguish from regular Backburner setups
    const key = `gp-${symbol}-${timeframe}-${setup.direction}-${marketType}`;
    const previousSetup = this.previousGPSetups.get(key);
    const recentlyPlayedOut = this.playedOutGPSetups.get(key);

    if (setup.state === 'played_out') {
      if (previousSetup) {
        this.previousGPSetups.delete(key);
        setup.playedOutAt = Date.now();
        this.playedOutGPSetups.set(key, setup);
        this.events.onSetupRemoved?.(setup);
      }
    } else if (!previousSetup) {
      // Check cooldown
      if (recentlyPlayedOut) {
        const timeSincePlayedOut = Date.now() - (recentlyPlayedOut.playedOutAt || 0);
        const cooldownMs = timeframe === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
        if (timeSincePlayedOut < cooldownMs) {
          return;
        }
        this.playedOutGPSetups.delete(key);
      }
      // New Golden Pocket setup
      this.previousGPSetups.set(key, setup);
      // Log for visibility
      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `[GP ${timestamp}] NEW SETUP: ${symbol} ${setup.direction.toUpperCase()} ${timeframe} | ` +
        `Retracement: ${setup.retracementPercent.toFixed(1)}% | State: ${setup.state}`
      );
      this.events.onNewSetup?.(setup);
    } else {
      // Update existing
      const priceChangePercent = Math.abs(
        (setup.currentPrice - previousSetup.currentPrice) / previousSetup.currentPrice
      ) * 100;
      const shouldUpdate =
        previousSetup.state !== setup.state ||
        Math.abs(previousSetup.retracementPercent - setup.retracementPercent) > 1 ||
        priceChangePercent > 0.1;

      if (shouldUpdate) {
        this.events.onSetupUpdated?.(setup);
      }
      this.previousGPSetups.set(key, setup);
    }
  }

  /**
   * Process a Golden Pocket V2 setup (loose thresholds version)
   * V2 setups are identified with 'gp2-' prefix and have isV2: true flag
   */
  private processGoldenPocketV2Setup(
    setup: GoldenPocketV2Setup,
    symbol: string,
    timeframe: Timeframe,
    marketType: MarketType = 'spot',
    volume24h: number = 0,
    liquidityRisk: LiquidityRisk = 'medium'
  ): void {
    // Add metadata
    setup.volume24h = volume24h || this.symbolVolumes.get(symbol) || 0;
    setup.coinName = getCoinName(symbol);
    setup.marketCap = getMarketCap(symbol);
    setup.marketCapRank = getMarketCapRank(symbol);
    setup.qualityTier = this.getQualityTier(setup.marketCap || 0);
    setup.marketType = marketType;
    setup.liquidityRisk = liquidityRisk;

    // Use 'gp2-' prefix to distinguish from V1 setups
    const key = `gp2-${symbol}-${timeframe}-${setup.direction}-${marketType}`;
    const previousSetup = this.previousGPV2Setups.get(key);
    const recentlyPlayedOut = this.playedOutGPV2Setups.get(key);

    if (setup.state === 'played_out') {
      if (previousSetup) {
        this.previousGPV2Setups.delete(key);
        setup.playedOutAt = Date.now();
        this.playedOutGPV2Setups.set(key, setup);
        this.events.onSetupRemoved?.(setup);
      }
    } else if (!previousSetup) {
      // Check cooldown
      if (recentlyPlayedOut) {
        const timeSincePlayedOut = Date.now() - (recentlyPlayedOut.playedOutAt || 0);
        const cooldownMs = timeframe === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
        if (timeSincePlayedOut < cooldownMs) {
          return;
        }
        this.playedOutGPV2Setups.delete(key);
      }
      // New Golden Pocket V2 setup
      this.previousGPV2Setups.set(key, setup);
      // Log for visibility - mark as V2
      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `[GP-V2 ${timestamp}] NEW SETUP: ${symbol} ${setup.direction.toUpperCase()} ${timeframe} | ` +
        `Retracement: ${setup.retracementPercent.toFixed(1)}% | State: ${setup.state}`
      );
      this.events.onNewSetup?.(setup);
    } else {
      // Update existing
      const priceChangePercent = Math.abs(
        (setup.currentPrice - previousSetup.currentPrice) / previousSetup.currentPrice
      ) * 100;
      const shouldUpdate =
        previousSetup.state !== setup.state ||
        Math.abs(previousSetup.retracementPercent - setup.retracementPercent) > 1 ||
        priceChangePercent > 0.1;

      if (shouldUpdate) {
        this.events.onSetupUpdated?.(setup);
      }
      this.previousGPV2Setups.set(key, setup);
    }
  }

  /**
   * Analyze a single symbol on a single timeframe
   * Used for incremental updates of specific setups
   * Now supports both spot and futures with market type awareness
   */
  private async analyzeSymbol(
    symbol: string,
    timeframe: Timeframe,
    marketType: MarketType = 'spot'
  ): Promise<void> {
    // Find the eligible symbol info
    const eligibleSymbol = this.eligibleSymbols.find(
      s => s.symbol === symbol && s.marketType === marketType
    );

    // CRITICAL: Skip symbols that are not in the eligible list
    // This prevents analyzing delisted/invalid symbols that may still have stale setups
    if (!eligibleSymbol) {
      // Clean up any stale setups for this symbol
      this.cleanupStaleSetups(symbol, timeframe, marketType);
      return;
    }

    // Skip futures symbols that have consistently failed
    if (marketType === 'futures' && eligibleSymbol?.futuresSymbol &&
        this.badFuturesSymbols.has(eligibleSymbol.futuresSymbol)) {
      return;
    }

    // Choose the right API based on market type
    const fetchKlines = marketType === 'futures' && eligibleSymbol?.futuresSymbol
      ? (sym: string, tf: Timeframe) => getFuturesKlines(eligibleSymbol.futuresSymbol!, tf)
      : getKlines;

    const candles = await fetchKlines(symbol, timeframe);

    if (candles.length < 50) {
      return;
    }

    // Get higher timeframe for trend confirmation
    let higherTFCandles;
    if (timeframe === '5m' || timeframe === '15m') {
      try {
        higherTFCandles = await fetchKlines(symbol, '1h');
      } catch {
        // Ignore - optional
      }
    } else if (timeframe === '1h') {
      try {
        higherTFCandles = await fetchKlines(symbol, '4h');
      } catch {
        // Ignore - optional
      }
    }

    // analyzeSymbol returns an array (can have both long and short setups)
    const setups = this.detector.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);

    const volume24h = eligibleSymbol?.volume24h || 0;
    const liquidityRisk = eligibleSymbol?.liquidityRisk || 'medium';

    for (const setup of setups) {
      this.processSetup(setup, symbol, timeframe, marketType, volume24h, liquidityRisk);
    }

    // Also run Golden Pocket detectors for incremental updates
    if (timeframe === '5m' || timeframe === '15m') {
      // V1 (strict thresholds)
      const gpSetups = this.goldenPocketDetector.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);
      for (const gpSetup of gpSetups) {
        this.processGoldenPocketSetup(gpSetup as GoldenPocketSetup, symbol, timeframe, marketType, volume24h, liquidityRisk);
      }
      // V2 (loose thresholds)
      const gpV2Setups = this.goldenPocketDetectorV2.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);
      for (const gpV2Setup of gpV2Setups) {
        this.processGoldenPocketV2Setup(gpV2Setup as GoldenPocketV2Setup, symbol, timeframe, marketType, volume24h, liquidityRisk);
      }
    }
  }

  /**
   * Clean up stale setups for a symbol that is no longer in the eligible list
   * Called when analyzeSymbol() is invoked for a symbol that doesn't exist anymore
   */
  private cleanupStaleSetups(symbol: string, timeframe: Timeframe, marketType: MarketType): void {
    // Remove from Backburner detector
    for (const direction of ['long', 'short'] as const) {
      this.detector.removeSetup(symbol, timeframe, direction);
      const key = `${symbol}-${timeframe}-${direction}-${marketType}`;
      if (this.previousSetups.has(key)) {
        const setup = this.previousSetups.get(key);
        this.previousSetups.delete(key);
        if (setup) this.events.onSetupRemoved?.(setup);
      }
    }

    // Remove from Golden Pocket V1 detector
    for (const direction of ['long', 'short'] as const) {
      this.goldenPocketDetector.removeSetup(symbol, timeframe, direction);
      const key = `gp-${symbol}-${timeframe}-${direction}-${marketType}`;
      if (this.previousGPSetups.has(key)) {
        const setup = this.previousGPSetups.get(key);
        this.previousGPSetups.delete(key);
        if (setup) this.events.onSetupRemoved?.(setup);
      }
    }

    // Remove from Golden Pocket V2 detector
    for (const direction of ['long', 'short'] as const) {
      this.goldenPocketDetectorV2.removeSetup(symbol, timeframe, direction);
      const key = `gp2-${symbol}-${timeframe}-${direction}-${marketType}`;
      if (this.previousGPV2Setups.has(key)) {
        const setup = this.previousGPV2Setups.get(key);
        this.previousGPV2Setups.delete(key);
        if (setup) this.events.onSetupRemoved?.(setup);
      }
    }

    console.log(`[SCREENER] Cleaned up stale setups for ${symbol} ${timeframe} (no longer eligible)`);
  }

  /**
   * Clean up setups that have expired based on their timeframe
   */
  private cleanupExpiredSetups(): void {
    const now = Date.now();
    const activeSetups = this.detector.getActiveSetups();

    // Clean up expired active setups
    for (const setup of activeSetups) {
      const expiryMs = SETUP_EXPIRY_MS[setup.timeframe];
      const age = now - setup.detectedAt;

      if (age > expiryMs) {
        this.detector.removeSetup(setup.symbol, setup.timeframe, setup.direction);
        this.previousSetups.delete(`${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`);
        this.events.onSetupRemoved?.(setup);
      }
    }

    // Clean up old played-out setups (keep visible for 30 minutes after playing out)
    const PLAYED_OUT_DISPLAY_MS = 30 * 60 * 1000; // 30 minutes
    for (const [key, setup] of this.playedOutSetups) {
      if (setup.playedOutAt && now - setup.playedOutAt > PLAYED_OUT_DISPLAY_MS) {
        this.playedOutSetups.delete(key);
      }
    }

    // Clean up Golden Pocket setups
    const gpActiveSetups = this.goldenPocketDetector.getActiveSetups();
    for (const setup of gpActiveSetups) {
      const expiryMs = SETUP_EXPIRY_MS[setup.timeframe];
      const age = now - setup.detectedAt;

      if (age > expiryMs) {
        this.goldenPocketDetector.removeSetup(setup.symbol, setup.timeframe, setup.direction);
        this.previousGPSetups.delete(`gp-${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`);
        this.events.onSetupRemoved?.(setup);
      }
    }

    // Clean up old played-out GP setups
    for (const [key, setup] of this.playedOutGPSetups) {
      if (setup.playedOutAt && now - setup.playedOutAt > PLAYED_OUT_DISPLAY_MS) {
        this.playedOutGPSetups.delete(key);
      }
    }

    // Clean up Golden Pocket V2 setups
    const gpV2ActiveSetups = this.goldenPocketDetectorV2.getActiveSetups();
    for (const setup of gpV2ActiveSetups) {
      const expiryMs = SETUP_EXPIRY_MS[setup.timeframe];
      const age = now - setup.detectedAt;

      if (age > expiryMs) {
        this.goldenPocketDetectorV2.removeSetup(setup.symbol, setup.timeframe, setup.direction);
        this.previousGPV2Setups.delete(`gp2-${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`);
        this.events.onSetupRemoved?.(setup);
      }
    }

    // Clean up old played-out GP V2 setups
    for (const [key, setup] of this.playedOutGPV2Setups) {
      if (setup.playedOutAt && now - setup.playedOutAt > PLAYED_OUT_DISPLAY_MS) {
        this.playedOutGPV2Setups.delete(key);
      }
    }
  }

  /**
   * Get all currently active setups (excludes played-out)
   */
  getActiveSetups(): BackburnerSetup[] {
    return this.detector.getActiveSetups();
  }

  /**
   * Get played-out setups (no longer updated, but visible)
   */
  getPlayedOutSetups(): BackburnerSetup[] {
    return Array.from(this.playedOutSetups.values());
  }

  /**
   * Get all setups (active + played-out) for display
   */
  getAllSetups(): BackburnerSetup[] {
    return [...this.detector.getActiveSetups(), ...this.playedOutSetups.values()];
  }

  /**
   * Get active Golden Pocket setups (V1 - strict thresholds)
   */
  getGoldenPocketSetups(): import('./golden-pocket-detector.js').GoldenPocketSetup[] {
    // Return from screener's tracking, not detector's internal state
    return Array.from(this.previousGPSetups.values());
  }

  /**
   * Get active Golden Pocket V2 setups (loose thresholds)
   */
  getGoldenPocketV2Setups(): GoldenPocketV2Setup[] {
    return Array.from(this.previousGPV2Setups.values());
  }

  /**
   * Get setups filtered by timeframe
   */
  getSetupsByTimeframe(timeframe: Timeframe): BackburnerSetup[] {
    return this.detector.getSetupsByTimeframe(timeframe);
  }

  /**
   * Get count of eligible symbols
   */
  getEligibleSymbolCount(): number {
    return this.eligibleSymbols.length;
  }

  /**
   * Check if the screener is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Force a refresh of a specific symbol
   */
  async refreshSymbol(symbol: string): Promise<void> {
    for (const timeframe of this.config.timeframes) {
      try {
        await this.analyzeSymbol(symbol, timeframe);
      } catch (error) {
        this.events.onError?.(error as Error, symbol);
      }
    }
  }

  /**
   * Get quality tier based on market cap
   */
  private getQualityTier(marketCap: number): QualityTier {
    if (marketCap >= this.config.volumeTiers.bluechip) {
      return 'bluechip';
    } else if (marketCap >= this.config.volumeTiers.midcap) {
      return 'midcap';
    } else {
      return 'shitcoin';
    }
  }
}
