import { BackburnerDetector } from './backburner-detector.js';
import { getExchangeInfo, get24hTickers, getKlines } from './mexc-api.js';
import { DEFAULT_CONFIG, TIMEFRAME_MS, SETUP_EXPIRY_MS } from './config.js';
import type { Timeframe, BackburnerSetup, SymbolInfo, ScreenerConfig, QualityTier } from './types.js';

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
export class BackburnerScreener {
  private detector: BackburnerDetector;
  private config: ScreenerConfig;
  private events: ScreenerEvents;
  private isRunning = false;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private eligibleSymbols: string[] = [];
  private symbolVolumes: Map<string, number> = new Map();
  private lastFullScan: Map<Timeframe, number> = new Map();
  private previousSetups: Map<string, BackburnerSetup> = new Map();

  constructor(config?: Partial<ScreenerConfig>, events?: ScreenerEvents) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events || {};
    this.detector = new BackburnerDetector(this.config);
  }

  /**
   * Start the screener
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Screener is already running');
    }

    this.isRunning = true;

    // Initial symbol discovery
    await this.discoverSymbols();

    // Initial full scan
    await this.runFullScan();

    // Set up continuous scanning
    this.scanInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.runIncrementalScan();
      }
    }, this.config.updateIntervalMs);
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
  }

  /**
   * Discover eligible trading symbols
   */
  private async discoverSymbols(): Promise<void> {
    this.events.onScanProgress?.(0, 1, 'Fetching exchange info...');

    try {
      // Get all symbols
      const [exchangeInfo, tickers] = await Promise.all([
        getExchangeInfo(),
        get24hTickers(),
      ]);

      // Create a map of volume by symbol
      for (const ticker of tickers) {
        this.symbolVolumes.set(ticker.symbol, parseFloat(ticker.quoteVolume));
      }

      // Filter symbols
      this.eligibleSymbols = exchangeInfo
        .filter((s: SymbolInfo) => this.isEligibleSymbol(s, this.symbolVolumes.get(s.symbol) || 0))
        .map((s: SymbolInfo) => s.symbol);

      this.events.onScanProgress?.(
        1,
        1,
        `Found ${this.eligibleSymbols.length} eligible symbols`
      );
    } catch (error) {
      this.events.onError?.(error as Error);
      throw error;
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
   */
  async runFullScan(): Promise<void> {
    const totalOperations = this.eligibleSymbols.length * this.config.timeframes.length;
    let completed = 0;

    this.events.onScanProgress?.(0, totalOperations, `Starting full scan of ${this.eligibleSymbols.length} symbols...`);

    for (const timeframe of this.config.timeframes) {
      this.events.onScanProgress?.(
        completed,
        totalOperations,
        `Scanning ${timeframe} (${this.eligibleSymbols.length} symbols)...`
      );

      for (const symbol of this.eligibleSymbols) {
        if (!this.isRunning) break;

        try {
          await this.analyzeSymbol(symbol, timeframe);
        } catch (error) {
          this.events.onError?.(error as Error, symbol);
        }

        completed++;
        // Update progress every 10 symbols for more frequent feedback
        if (completed % 10 === 0) {
          this.events.onScanProgress?.(
            completed,
            totalOperations,
            `Scanning ${timeframe}: ${symbol.replace('USDT', '')}...`
          );
        }
      }

      this.lastFullScan.set(timeframe, Date.now());
    }

    this.events.onScanProgress?.(totalOperations, totalOperations, 'Scan complete');
  }

  /**
   * Run an incremental scan (only update active setups and check for new ones)
   */
  async runIncrementalScan(): Promise<void> {
    // Get current active setups
    const activeSetups = this.detector.getActiveSetups();

    // Update existing setups first
    if (activeSetups.length > 0) {
      this.events.onScanStatus?.(`Updating ${activeSetups.length} active setups...`);
    }
    for (const setup of activeSetups) {
      try {
        await this.analyzeSymbol(setup.symbol, setup.timeframe);
      } catch (error) {
        this.events.onError?.(error as Error, setup.symbol);
      }
    }

    // Check a subset of symbols for new setups (rotating through)
    const symbolsToCheck = this.getSymbolsForIncrementalCheck();
    this.events.onScanStatus?.(`Checking ${symbolsToCheck.length} symbols for new setups...`);

    for (const timeframe of this.config.timeframes) {
      for (const symbol of symbolsToCheck) {
        if (!this.isRunning) break;

        // Skip if already have an active setup
        const existingSetup = activeSetups.find(
          s => s.symbol === symbol && s.timeframe === timeframe
        );
        if (existingSetup) continue;

        try {
          await this.analyzeSymbol(symbol, timeframe);
        } catch (error) {
          // Silently ignore errors in incremental scan
        }
      }
    }

    // Clean up expired setups
    this.cleanupExpiredSetups();
    this.events.onScanStatus?.(`Monitoring ${this.eligibleSymbols.length} symbols...`);
  }

  /**
   * Get a subset of symbols to check in incremental scan
   */
  private getSymbolsForIncrementalCheck(): string[] {
    // Rotate through symbols to spread the load
    const now = Date.now();
    const rotationIndex = Math.floor(now / 60000) % 10; // Change every minute

    return this.eligibleSymbols.filter((_, i) => i % 10 === rotationIndex);
  }

  /**
   * Analyze a single symbol on a single timeframe
   */
  private async analyzeSymbol(symbol: string, timeframe: Timeframe): Promise<void> {
    const candles = await getKlines(symbol, timeframe);

    if (candles.length < 50) {
      return;
    }

    // Get higher timeframe for trend confirmation
    let higherTFCandles;
    if (timeframe === '5m') {
      try {
        higherTFCandles = await getKlines(symbol, '1h');
      } catch {
        // Ignore - optional
      }
    } else if (timeframe === '15m') {
      try {
        higherTFCandles = await getKlines(symbol, '4h');
      } catch {
        // Ignore - optional
      }
    }

    // analyzeSymbol now returns an array (can have both long and short setups)
    const setups = this.detector.analyzeSymbol(symbol, timeframe, candles, higherTFCandles);

    for (const setup of setups) {
      // Add volume and quality tier info
      const volume24h = this.symbolVolumes.get(symbol) || 0;
      setup.volume24h = volume24h;
      setup.qualityTier = this.getQualityTier(volume24h);

      const key = `${symbol}-${timeframe}-${setup.direction}`;
      const previousSetup = this.previousSetups.get(key);

      if (setup.state === 'played_out') {
        // Setup removed
        if (previousSetup) {
          this.previousSetups.delete(key);
          this.events.onSetupRemoved?.(setup);
        }
      } else if (!previousSetup) {
        // New setup
        this.previousSetups.set(key, setup);
        this.events.onNewSetup?.(setup);
      } else {
        // Existing setup updated
        if (previousSetup.state !== setup.state || Math.abs(previousSetup.currentRSI - setup.currentRSI) > 1) {
          this.events.onSetupUpdated?.(setup);
        }
        this.previousSetups.set(key, setup);
      }
    }
  }

  /**
   * Clean up setups that have expired based on their timeframe
   */
  private cleanupExpiredSetups(): void {
    const now = Date.now();
    const activeSetups = this.detector.getActiveSetups();

    for (const setup of activeSetups) {
      const expiryMs = SETUP_EXPIRY_MS[setup.timeframe];
      const age = now - setup.detectedAt;

      if (age > expiryMs) {
        this.detector.removeSetup(setup.symbol, setup.timeframe, setup.direction);
        this.previousSetups.delete(`${setup.symbol}-${setup.timeframe}-${setup.direction}`);
        this.events.onSetupRemoved?.(setup);
      }
    }
  }

  /**
   * Get all currently active setups
   */
  getActiveSetups(): BackburnerSetup[] {
    return this.detector.getActiveSetups();
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
   * Get quality tier based on 24h volume
   */
  private getQualityTier(volume24h: number): QualityTier {
    if (volume24h >= this.config.volumeTiers.bluechip) {
      return 'bluechip';
    } else if (volume24h >= this.config.volumeTiers.midcap) {
      return 'midcap';
    } else {
      return 'shitcoin';
    }
  }
}
