/**
 * EXPERIMENTAL SHADOW BOTS
 *
 * These bots test different combinations of:
 * - Signal sources (Backburner, Golden Pocket)
 * - Bias filters (System A: RSI-only, System B: Multi-indicator)
 * - Regime filters (Signal-ratio quadrants)
 *
 * All bots run in shadow mode (paper trading) to collect performance data
 * without risking real capital.
 *
 * Experiments:
 * 1. Backburner + System B filter (instead of System A)
 * 2. Golden Pocket + Signal-ratio regime filter
 * 3. Golden Pocket + System A filter
 * 4. Golden Pocket + System B filter
 */

import { EventEmitter } from 'events';
import type { BackburnerSetup, MarketType } from './types.js';
import type { GoldenPocketV2Setup } from './golden-pocket-detector-v2.js';
import { getMarketBiasSystemB, type BiasLevel, type SystemBBiasResult } from './market-bias-system-b.js';
import { getDataPersistence } from './data-persistence.js';

// ============= Types =============

export type MacroRegime = 'bull' | 'bear' | 'neutral';
export type MicroRegime = 'bullish' | 'bearish' | 'neutral';
export type Quadrant = 'BULL+BULL' | 'BULL+BEAR' | 'BULL+NEU' |
                       'BEAR+BULL' | 'BEAR+BEAR' | 'BEAR+NEU' |
                       'NEU+BULL' | 'NEU+BEAR' | 'NEU+NEU';

interface Signal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
}

interface ShadowPosition {
  id: string;
  botId: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  trailActivated: boolean;
  highestPnlPercent: number;
  entryBias?: BiasLevel;
  entryQuadrant?: Quadrant;
  // Insurance tracking
  insuranceTaken: boolean;
  insuranceTakenAt?: number;
  insurancePnlLocked?: number;  // $ locked in from insurance sell
  originalPositionSize?: number;  // Size before insurance halved it
}

interface ClosedPosition extends ShadowPosition {
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnl: number;
  realizedPnlPercent: number;
}

interface BotStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnl: string;
  avgWin: string;
  avgLoss: string;
  profitFactor: string;
  currentBalance: string;
  peakBalance: string;
  drawdown: string;
  byBias: Record<string, { trades: number; pnl: number; wins: number }>;
  byQuadrant: Record<string, { trades: number; pnl: number; wins: number }>;
}

interface ExperimentalBotConfig {
  botId: string;
  description: string;
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  maxPositions: number;

  // Stop/Trail settings
  initialStopPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;  // Default trail step (used when profit-tiered is disabled)
  takeProfitPercent: number;

  // Profit-tiered trailing (tighter trail at higher profits)
  useProfitTieredTrail?: boolean;  // Default: true
  profitTiers?: Array<{ minRoePct: number; trailStepPct: number }>;

  // Filter settings
  useBiasFilter: boolean;
  biasSystem: 'A' | 'B';
  useRegimeFilter: boolean;
  allowedQuadrants: Quadrant[];

  // Direction settings
  longOnly: boolean;

  // Fees
  feePercent: number;
  slippagePercent: number;

  // Conditional Insurance settings (optional - defaults to disabled)
  useConditionalInsurance?: boolean;
  insuranceThresholdPercent?: number;  // ROE% at which to take insurance (e.g., 2)
  insuranceStressWinRateThreshold?: number;  // WR% below which is "stress" (e.g., 50)
}

// Internal config with all optional fields resolved to required
type ResolvedBotConfig = Required<ExperimentalBotConfig>;

// ============= Signal Ratio Regime Detector =============

class SignalRatioRegimeDetector {
  private signalHistory: Signal[] = [];
  private macroWindowHours: number = 24;
  private microWindowHours: number = 4;

  addSignal(signal: Signal): void {
    this.signalHistory.push(signal);
    // Keep only last 48 hours
    const cutoff = signal.timestamp - 48 * 60 * 60 * 1000;
    this.signalHistory = this.signalHistory.filter(s => s.timestamp > cutoff);
  }

  getMacroRegime(timestamp: number): MacroRegime {
    const windowMs = this.macroWindowHours * 60 * 60 * 1000;
    const windowStart = timestamp - windowMs;
    const signals = this.signalHistory.filter(s => s.timestamp >= windowStart && s.timestamp < timestamp);

    const longs = signals.filter(s => s.direction === 'long').length;
    const shorts = signals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    if (total < 10) return 'neutral';

    const longRatio = longs / total;
    if (longRatio > 0.55) return 'bull';
    if (longRatio < 0.45) return 'bear';
    return 'neutral';
  }

  getMicroRegime(timestamp: number): MicroRegime {
    const windowMs = this.microWindowHours * 60 * 60 * 1000;
    const windowStart = timestamp - windowMs;
    const signals = this.signalHistory.filter(s => s.timestamp >= windowStart && s.timestamp < timestamp);

    const longs = signals.filter(s => s.direction === 'long').length;
    const shorts = signals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    if (total < 3) return 'neutral';

    const shortRatio = shorts / total;
    const longRatio = longs / total;

    if (shortRatio > 0.65) return 'bearish';
    if (longRatio > 0.65) return 'bullish';
    return 'neutral';
  }

  getQuadrant(timestamp: number): Quadrant {
    const macro = this.getMacroRegime(timestamp);
    const micro = this.getMicroRegime(timestamp);
    const macroShort = macro === 'bull' ? 'BULL' : macro === 'bear' ? 'BEAR' : 'NEU';
    const microShort = micro === 'bullish' ? 'BULL' : micro === 'bearish' ? 'BEAR' : 'NEU';
    return `${macroShort}+${microShort}` as Quadrant;
  }

  getSignalCount(): number {
    return this.signalHistory.length;
  }
}

// ============= Base Experimental Shadow Bot =============

// Track recent closes for hourly win rate calculation
interface HourlyCloseRecord {
  timestamp: number;
  isWin: boolean;
}

class ExperimentalShadowBot extends EventEmitter {
  protected config: ResolvedBotConfig;
  protected positions: Map<string, ShadowPosition> = new Map();
  protected closedPositions: ClosedPosition[] = [];
  protected balance: number;
  protected peakBalance: number;
  protected regimeDetector: SignalRatioRegimeDetector;
  protected lastBiasResult: SystemBBiasResult | null = null;
  protected executionMode: string = 'paper';

  // For conditional insurance: track recent closes to calculate hourly win rate
  protected recentCloses: HourlyCloseRecord[] = [];

  // Callback for when insurance is triggered (used by web-server to close half on MEXC)
  public onInsuranceTriggered?: (position: ShadowPosition, lockedPnl: number) => void;

  // Default profit tiers for paper trailing (matches MEXC trailing manager)
  private static DEFAULT_PROFIT_TIERS = [
    { minRoePct: 50, trailStepPct: 2 },
    { minRoePct: 30, trailStepPct: 3 },
    { minRoePct: 20, trailStepPct: 4 },
    { minRoePct: 0, trailStepPct: 5 },
  ];

  constructor(config: ExperimentalBotConfig) {
    super();
    // Apply defaults for optional settings
    this.config = {
      ...config,
      useConditionalInsurance: config.useConditionalInsurance ?? false,
      insuranceThresholdPercent: config.insuranceThresholdPercent ?? 2,
      insuranceStressWinRateThreshold: config.insuranceStressWinRateThreshold ?? 50,
      useProfitTieredTrail: config.useProfitTieredTrail ?? true,
      profitTiers: config.profitTiers ?? ExperimentalShadowBot.DEFAULT_PROFIT_TIERS,
    };
    this.balance = config.initialBalance;
    this.peakBalance = config.initialBalance;
    this.regimeDetector = new SignalRatioRegimeDetector();
  }

  /**
   * Get the current trail step % based on peak ROE (profit-tiered trailing)
   * Higher profits = tighter trail to capture more gains
   */
  protected getCurrentTrailStep(peakRoePct: number): number {
    if (!this.config.useProfitTieredTrail || !this.config.profitTiers) {
      return this.config.trailStepPercent;
    }

    // Find the applicable tier (tiers are sorted highest to lowest minRoePct)
    for (const tier of this.config.profitTiers) {
      if (peakRoePct >= tier.minRoePct) {
        return tier.trailStepPct;
      }
    }

    return this.config.trailStepPercent;
  }

  getBotId(): string {
    return this.config.botId;
  }

  getDescription(): string {
    return this.config.description;
  }

  // Set execution mode for trade logging (paper/shadow/live)
  setExecutionMode(mode: string): void {
    this.executionMode = mode;
  }

  // Feed signals to regime detector (called for ALL signals, not just ones we trade)
  feedSignal(signal: Signal): void {
    this.regimeDetector.addSignal(signal);
  }

  // Update current bias from System B
  updateBias(biasResult: SystemBBiasResult): void {
    this.lastBiasResult = biasResult;
  }

  // Check if we're in a "stress" period (low hourly win rate)
  protected isStressPeriod(): boolean {
    if (!this.config.useConditionalInsurance) return false;

    // Keep only last 2 hours of closes for rolling window
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    this.recentCloses = this.recentCloses.filter(c => c.timestamp > twoHoursAgo);

    // Need at least 3 closes to make a determination
    if (this.recentCloses.length < 3) return false;

    const wins = this.recentCloses.filter(c => c.isWin).length;
    const winRate = (wins / this.recentCloses.length) * 100;

    return winRate < this.config.insuranceStressWinRateThreshold;
  }

  // Get current hourly win rate (for display/logging)
  getRecentWinRate(): { winRate: number; sampleSize: number } {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const recent = this.recentCloses.filter(c => c.timestamp > twoHoursAgo);
    if (recent.length === 0) return { winRate: 0, sampleSize: 0 };
    const wins = recent.filter(c => c.isWin).length;
    return { winRate: (wins / recent.length) * 100, sampleSize: recent.length };
  }

  // Check if conditional insurance is enabled
  isConditionalInsuranceEnabled(): boolean {
    return this.config.useConditionalInsurance;
  }

  // Toggle conditional insurance on/off
  setConditionalInsurance(enabled: boolean): void {
    this.config.useConditionalInsurance = enabled;
    console.log(`[EXP:${this.config.botId}] Conditional insurance ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  // Check if setup passes bias filter
  protected passesBiasFilter(direction: 'long' | 'short'): { passes: boolean; reason: string; bias?: BiasLevel } {
    if (!this.config.useBiasFilter) {
      return { passes: true, reason: 'Bias filter disabled' };
    }

    if (this.config.biasSystem === 'B') {
      if (!this.lastBiasResult) {
        return { passes: false, reason: 'No System B data available' };
      }

      const bias = this.lastBiasResult.bias;

      // Allow aligned or neutral
      if (direction === 'long') {
        if (bias === 'short' || bias === 'strong_short') {
          return { passes: false, reason: `System B bias is ${bias}`, bias };
        }
      } else {
        if (bias === 'long' || bias === 'strong_long') {
          return { passes: false, reason: `System B bias is ${bias}`, bias };
        }
      }

      return { passes: true, reason: `System B bias ${bias} allows ${direction}`, bias };
    }

    // System A would be handled by the caller (currentBtcBias)
    return { passes: true, reason: 'System A handled externally' };
  }

  // Check if setup passes regime filter
  protected passesRegimeFilter(timestamp: number): { passes: boolean; reason: string; quadrant: Quadrant } {
    const quadrant = this.regimeDetector.getQuadrant(timestamp);

    if (!this.config.useRegimeFilter) {
      return { passes: true, reason: 'Regime filter disabled', quadrant };
    }

    if (this.config.allowedQuadrants.includes(quadrant)) {
      return { passes: true, reason: `Quadrant ${quadrant} allowed`, quadrant };
    }

    return { passes: false, reason: `Quadrant ${quadrant} not allowed`, quadrant };
  }

  // Process a Backburner setup
  processBackburnerSetup(
    setup: BackburnerSetup,
    currentPrice: number,
    currentBtcBias?: BiasLevel
  ): { action: 'open' | 'skip'; reason: string; position?: ShadowPosition } {
    // Skip if wrong direction
    if (this.config.longOnly && setup.direction === 'short') {
      return { action: 'skip', reason: 'Long only mode' };
    }

    // Check max positions
    if (this.positions.size >= this.config.maxPositions) {
      return { action: 'skip', reason: 'Max positions reached' };
    }

    // Check if already have position in this symbol
    const existingKey = `${setup.symbol}-${setup.direction}`;
    if (this.positions.has(existingKey)) {
      return { action: 'skip', reason: 'Already have position' };
    }

    // Check bias filter
    if (this.config.biasSystem === 'A' && currentBtcBias) {
      // System A filter
      if (setup.direction === 'long' && (currentBtcBias === 'short' || currentBtcBias === 'strong_short')) {
        return { action: 'skip', reason: `System A bias ${currentBtcBias} blocks long` };
      }
      if (setup.direction === 'short' && (currentBtcBias === 'long' || currentBtcBias === 'strong_long')) {
        return { action: 'skip', reason: `System A bias ${currentBtcBias} blocks short` };
      }
    }

    const biasCheck = this.passesBiasFilter(setup.direction);
    if (!biasCheck.passes) {
      return { action: 'skip', reason: biasCheck.reason };
    }

    // Check regime filter
    const regimeCheck = this.passesRegimeFilter(setup.triggeredAt || Date.now());
    if (!regimeCheck.passes) {
      return { action: 'skip', reason: regimeCheck.reason };
    }

    // Calculate AVAILABLE balance (total balance minus capital in open positions)
    const allocatedCapital = Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.positionSize, 0);
    const availableBalance = Math.max(0, this.balance - allocatedCapital);

    // Calculate position size from AVAILABLE balance, not total balance
    const positionSize = availableBalance * (this.config.positionSizePercent / 100);

    // Skip if insufficient available capital
    if (positionSize < 10) {  // Minimum $10 position
      return { action: 'skip', reason: `Insufficient available balance ($${availableBalance.toFixed(2)} available, $${allocatedCapital.toFixed(2)} allocated)` };
    }
    const entryPrice = currentPrice * (1 + this.config.slippagePercent / 100 * (setup.direction === 'long' ? 1 : -1));

    // SL is ROE-based: initialStopPercent is max ROE% loss, convert to price distance
    const stopDistance = entryPrice * (this.config.initialStopPercent / 100 / this.config.leverage);
    const stopLoss = setup.direction === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    const tpDistance = entryPrice * (this.config.takeProfitPercent / 100);
    const takeProfit = this.config.takeProfitPercent > 0
      ? (setup.direction === 'long' ? entryPrice + tpDistance : entryPrice - tpDistance)
      : 0;

    const position: ShadowPosition = {
      id: `${this.config.botId}-${setup.symbol}-${Date.now()}`,
      botId: this.config.botId,
      symbol: setup.symbol,
      direction: setup.direction,
      entryPrice,
      entryTime: Date.now(),
      positionSize,
      leverage: this.config.leverage,
      stopLoss,
      takeProfit,
      currentPrice,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      trailActivated: false,
      highestPnlPercent: 0,
      entryBias: biasCheck.bias,
      entryQuadrant: regimeCheck.quadrant,
      insuranceTaken: false,
    };

    this.positions.set(existingKey, position);

    // Log trade open
    const dataPersistence = getDataPersistence();
    dataPersistence.logTradeOpen(this.config.botId, position as any, setup, this.executionMode);

    return { action: 'open', reason: `Opened in ${regimeCheck.quadrant}`, position };
  }

  // Process a Golden Pocket setup
  processGoldenPocketSetup(
    setup: GoldenPocketV2Setup,
    currentPrice: number,
    currentBtcBias?: BiasLevel
  ): { action: 'open' | 'skip'; reason: string; position?: ShadowPosition } {
    // Skip if wrong direction
    if (this.config.longOnly && setup.direction === 'short') {
      return { action: 'skip', reason: 'Long only mode' };
    }

    // Check max positions
    if (this.positions.size >= this.config.maxPositions) {
      return { action: 'skip', reason: 'Max positions reached' };
    }

    // Check if already have position in this symbol
    const existingKey = `${setup.symbol}-${setup.direction}`;
    if (this.positions.has(existingKey)) {
      return { action: 'skip', reason: 'Already have position' };
    }

    // Check bias filter
    if (this.config.biasSystem === 'A' && currentBtcBias) {
      if (setup.direction === 'long' && (currentBtcBias === 'short' || currentBtcBias === 'strong_short')) {
        return { action: 'skip', reason: `System A bias ${currentBtcBias} blocks long` };
      }
      if (setup.direction === 'short' && (currentBtcBias === 'long' || currentBtcBias === 'strong_long')) {
        return { action: 'skip', reason: `System A bias ${currentBtcBias} blocks short` };
      }
    }

    const biasCheck = this.passesBiasFilter(setup.direction);
    if (!biasCheck.passes) {
      return { action: 'skip', reason: biasCheck.reason };
    }

    // Check regime filter
    const regimeCheck = this.passesRegimeFilter(setup.detectedAt || Date.now());
    if (!regimeCheck.passes) {
      return { action: 'skip', reason: regimeCheck.reason };
    }

    // Calculate AVAILABLE balance (total balance minus capital in open positions)
    const allocatedCapital = Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.positionSize, 0);
    const availableBalance = Math.max(0, this.balance - allocatedCapital);

    // Use GP's built-in TP/SL levels
    const entryPrice = currentPrice * (1 + this.config.slippagePercent / 100 * (setup.direction === 'long' ? 1 : -1));
    const positionSize = availableBalance * (this.config.positionSizePercent / 100);

    // Skip if insufficient available capital
    if (positionSize < 10) {  // Minimum $10 position
      return { action: 'skip', reason: `Insufficient available balance ($${availableBalance.toFixed(2)} available, $${allocatedCapital.toFixed(2)} allocated)` };
    }

    const position: ShadowPosition = {
      id: `${this.config.botId}-${setup.symbol}-${Date.now()}`,
      botId: this.config.botId,
      symbol: setup.symbol,
      direction: setup.direction,
      entryPrice,
      entryTime: Date.now(),
      positionSize,
      leverage: this.config.leverage,
      stopLoss: setup.stopPrice,
      takeProfit: setup.tp2Price,  // Use TP2 (full target)
      currentPrice,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      trailActivated: false,
      highestPnlPercent: 0,
      entryBias: biasCheck.bias,
      entryQuadrant: regimeCheck.quadrant,
      insuranceTaken: false,
    };

    this.positions.set(existingKey, position);

    // Log trade open
    const dataPersistence = getDataPersistence();
    dataPersistence.logTradeOpen(this.config.botId, position as any, setup as any, this.executionMode);

    return { action: 'open', reason: `Opened GP in ${regimeCheck.quadrant}`, position };
  }

  // Update positions with current prices
  updatePrices(prices: Map<string, number>): ClosedPosition[] {
    const closedThisUpdate: ClosedPosition[] = [];

    for (const [key, position] of this.positions) {
      const currentPrice = prices.get(position.symbol);
      if (!currentPrice) continue;

      position.currentPrice = currentPrice;

      // Calculate P&L
      const priceDiff = position.direction === 'long'
        ? currentPrice - position.entryPrice
        : position.entryPrice - currentPrice;

      position.unrealizedPnlPercent = (priceDiff / position.entryPrice) * 100 * position.leverage;
      position.unrealizedPnl = position.positionSize * (position.unrealizedPnlPercent / 100);

      // Track highest P&L
      if (position.unrealizedPnlPercent > position.highestPnlPercent) {
        position.highestPnlPercent = position.unrealizedPnlPercent;
      }

      // CONDITIONAL INSURANCE: During stress periods, lock in half when hitting threshold
      if (
        this.config.useConditionalInsurance &&
        !position.insuranceTaken &&
        position.unrealizedPnlPercent >= this.config.insuranceThresholdPercent &&
        this.isStressPeriod()
      ) {
        // Take insurance: sell half, lock in profit, move SL to breakeven
        position.insuranceTaken = true;
        position.insuranceTakenAt = Date.now();
        position.originalPositionSize = position.positionSize;

        // Calculate locked profit from half the position at insurance threshold
        const halfSize = position.positionSize / 2;
        const lockedPnlPercent = this.config.insuranceThresholdPercent;
        const lockedPnl = halfSize * (lockedPnlPercent / 100);
        position.insurancePnlLocked = lockedPnl;

        // Reduce position size (remaining half rides)
        position.positionSize = halfSize;

        // Move stop loss to breakeven for remaining half
        position.stopLoss = position.entryPrice;

        const { winRate, sampleSize } = this.getRecentWinRate();
        console.log(`[EXP:${this.config.botId}] 🛡️ INSURANCE triggered for ${position.symbol} @ ${position.unrealizedPnlPercent.toFixed(1)}% ROE | Locked $${lockedPnl.toFixed(2)} | Stress WR: ${winRate.toFixed(0)}% (${sampleSize} trades)`);

        // Notify callback (used by web-server to close half on MEXC)
        if (this.onInsuranceTriggered) {
          this.onInsuranceTriggered(position, lockedPnl);
        }
      }

      // Check trail activation
      if (!position.trailActivated && position.unrealizedPnlPercent >= this.config.trailTriggerPercent) {
        position.trailActivated = true;
        // Get dynamic trail step based on peak ROE
        const activationTrailStep = this.getCurrentTrailStep(position.highestPnlPercent);
        // Move stop to breakeven + small profit using dynamic trail step
        const beDistance = position.entryPrice * ((this.config.trailTriggerPercent - activationTrailStep) / 100 / position.leverage);
        position.stopLoss = position.direction === 'long'
          ? position.entryPrice + beDistance
          : position.entryPrice - beDistance;
      }

      // Update trailing stop with profit-tiered trail step
      if (position.trailActivated) {
        // Get dynamic trail step based on peak ROE (tighter at higher profits)
        const currentTrailStep = this.getCurrentTrailStep(position.highestPnlPercent);
        const trailPnl = position.highestPnlPercent - currentTrailStep;

        if (trailPnl > 0) {
          const trailDistance = position.entryPrice * (trailPnl / 100 / position.leverage);
          const newStop = position.direction === 'long'
            ? position.entryPrice + trailDistance
            : position.entryPrice - trailDistance;

          const wouldUpdate = position.direction === 'long' ? newStop > position.stopLoss : newStop < position.stopLoss;

          // Debug logging for high-profit positions
          if (position.highestPnlPercent > 30 && wouldUpdate) {
            console.log(`[TRAIL-DEBUG] ${position.symbol} peak=${position.highestPnlPercent.toFixed(1)}% trailStep=${currentTrailStep}% trailPnl=${trailPnl.toFixed(1)}% oldSL=$${position.stopLoss.toFixed(6)} newSL=$${newStop.toFixed(6)}`);
          }

          if (position.direction === 'long' && newStop > position.stopLoss) {
            position.stopLoss = newStop;
          } else if (position.direction === 'short' && newStop < position.stopLoss) {
            position.stopLoss = newStop;
          }
        }
      }

      // Check exit conditions
      let exitReason = '';
      let exitPrice = 0;

      // Liquidation check: at isolated margin, liquidation ~ entryPrice * (1 - 1/leverage) for longs
      // Using 90% of margin as liquidation threshold (exchange takes maintenance margin)
      const liqDistance = position.entryPrice / position.leverage * 0.9;
      if (position.direction === 'long' && currentPrice <= position.entryPrice - liqDistance) {
        exitReason = 'liquidation';
        exitPrice = position.entryPrice - liqDistance;
      } else if (position.direction === 'short' && currentPrice >= position.entryPrice + liqDistance) {
        exitReason = 'liquidation';
        exitPrice = position.entryPrice + liqDistance;
      }

      // Stop loss (only if not already liquidated)
      // Apply exit slippage: real SL fills are typically worse than trigger price
      // Use 2x entry slippage for exits (SL fills in volatile conditions = more slippage)
      const exitSlippagePct = this.config.slippagePercent * 2;

      if (!exitReason && position.direction === 'long' && currentPrice <= position.stopLoss) {
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
        // Long exit slippage = lower fill price
        exitPrice = position.stopLoss * (1 - exitSlippagePct / 100);
        // Debug high-profit exits
        if (position.highestPnlPercent > 20) {
          const currentRoePct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage;
          const slRoePct = ((position.stopLoss - position.entryPrice) / position.entryPrice) * 100 * position.leverage;
          console.log(`[EXIT-DEBUG] ${position.symbol} LONG ${exitReason} | peak=${position.highestPnlPercent.toFixed(1)}% | SL ROE=${slRoePct.toFixed(1)}% | currentPrice ROE=${currentRoePct.toFixed(1)}% | entry=$${position.entryPrice} SL=$${position.stopLoss.toFixed(6)} price=$${currentPrice.toFixed(6)}`);
        }
      } else if (!exitReason && position.direction === 'short' && currentPrice >= position.stopLoss) {
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
        // Short exit slippage = higher fill price
        exitPrice = position.stopLoss * (1 + exitSlippagePct / 100);
        // Debug high-profit exits
        if (position.highestPnlPercent > 20) {
          const currentRoePct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100 * position.leverage;
          const slRoePct = ((position.entryPrice - position.stopLoss) / position.entryPrice) * 100 * position.leverage;
          console.log(`[EXIT-DEBUG] ${position.symbol} SHORT ${exitReason} | peak=${position.highestPnlPercent.toFixed(1)}% | SL ROE=${slRoePct.toFixed(1)}% | currentPrice ROE=${currentRoePct.toFixed(1)}% | entry=$${position.entryPrice} SL=$${position.stopLoss.toFixed(6)} price=$${currentPrice.toFixed(6)}`);
        }
      }

      // Take profit
      // TP also gets slippage (though typically less severe than SL)
      if (position.takeProfit > 0) {
        if (position.direction === 'long' && currentPrice >= position.takeProfit) {
          exitReason = 'take_profit';
          // Long TP slippage = lower fill than target
          exitPrice = position.takeProfit * (1 - this.config.slippagePercent / 100);
        } else if (position.direction === 'short' && currentPrice <= position.takeProfit) {
          exitReason = 'take_profit';
          // Short TP slippage = higher fill than target
          exitPrice = position.takeProfit * (1 + this.config.slippagePercent / 100);
        }
      }

      if (exitReason) {
        // Close position
        let netPnl: number;
        let netPnlPercent: number;

        if (exitReason === 'liquidation') {
          // Liquidation = lose entire margin (position size)
          netPnl = -position.positionSize;
          netPnlPercent = -100;
        } else {
          const finalPriceDiff = position.direction === 'long'
            ? exitPrice - position.entryPrice
            : position.entryPrice - exitPrice;

          const grossPnlPercent = (finalPriceDiff / position.entryPrice) * 100 * position.leverage;
          const fees = position.positionSize * (this.config.feePercent / 100) * 2;
          const grossPnl = position.positionSize * (grossPnlPercent / 100);
          netPnl = grossPnl - fees;
          netPnlPercent = (netPnl / position.positionSize) * 100;
        }

        // If insurance was taken, add the locked profit to total PnL
        if (position.insuranceTaken && position.insurancePnlLocked) {
          netPnl += position.insurancePnlLocked;
          // Recalculate percent based on original position size
          const originalSize = position.originalPositionSize || position.positionSize * 2;
          netPnlPercent = (netPnl / originalSize) * 100;

          // Update exit reason to indicate insurance was used
          if (exitReason === 'stop_loss') {
            exitReason = 'insurance_be';  // Hit breakeven after insurance
          }
        }

        const closedPos: ClosedPosition = {
          ...position,
          exitPrice,
          exitTime: Date.now(),
          exitReason,
          realizedPnl: netPnl,
          realizedPnlPercent: netPnlPercent,
        };

        this.closedPositions.push(closedPos);
        closedThisUpdate.push(closedPos);
        this.positions.delete(key);

        // Track this close for win rate calculation (used by conditional insurance)
        this.recentCloses.push({
          timestamp: Date.now(),
          isWin: netPnl > 0,
        });

        // Update balance
        this.balance += netPnl;
        if (this.balance > this.peakBalance) {
          this.peakBalance = this.balance;
        }

        // Log trade close - map ClosedPosition fields to PaperPosition format
        const dataPersistence = getDataPersistence();
        const paperPosFormat = {
          ...closedPos,
          marketType: 'futures' as const,
          timeframe: '5m',
          marginUsed: closedPos.positionSize,  // Map positionSize to marginUsed
          notionalSize: closedPos.positionSize * closedPos.leverage,
          realizedPnL: closedPos.realizedPnl,  // Map lowercase to uppercase
          realizedPnLPercent: closedPos.realizedPnlPercent,  // Map lowercase to uppercase
          highestPnlPercent: closedPos.highestPnlPercent,
          trailActivated: closedPos.trailActivated,
        };
        dataPersistence.logTradeClose(this.config.botId, paperPosFormat as any, this.executionMode);
      }
    }

    return closedThisUpdate;
  }

  // Get current state
  getState(): {
    botId: string;
    description: string;
    balance: number;
    unrealizedPnl: number;
    openPositions: ShadowPosition[];
    closedPositions: ClosedPosition[];
    stats: BotStats;
  } {
    const openPositions = Array.from(this.positions.values());
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    // Calculate stats
    const wins = this.closedPositions.filter(p => p.realizedPnl > 0);
    const losses = this.closedPositions.filter(p => p.realizedPnl <= 0);
    const totalPnl = this.closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const grossWins = wins.reduce((sum, p) => sum + p.realizedPnl, 0);
    const grossLosses = Math.abs(losses.reduce((sum, p) => sum + p.realizedPnl, 0));

    // Stats by bias
    const byBias: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const p of this.closedPositions) {
      const bias = p.entryBias || 'unknown';
      if (!byBias[bias]) byBias[bias] = { trades: 0, pnl: 0, wins: 0 };
      byBias[bias].trades++;
      byBias[bias].pnl += p.realizedPnl;
      if (p.realizedPnl > 0) byBias[bias].wins++;
    }

    // Stats by quadrant
    const byQuadrant: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const p of this.closedPositions) {
      const quadrant = p.entryQuadrant || 'unknown';
      if (!byQuadrant[quadrant]) byQuadrant[quadrant] = { trades: 0, pnl: 0, wins: 0 };
      byQuadrant[quadrant].trades++;
      byQuadrant[quadrant].pnl += p.realizedPnl;
      if (p.realizedPnl > 0) byQuadrant[quadrant].wins++;
    }

    return {
      botId: this.config.botId,
      description: this.config.description,
      balance: this.balance,
      unrealizedPnl,
      openPositions,
      closedPositions: this.closedPositions.slice(-20),
      stats: {
        totalTrades: this.closedPositions.length,
        wins: wins.length,
        losses: losses.length,
        winRate: this.closedPositions.length > 0
          ? ((wins.length / this.closedPositions.length) * 100).toFixed(1)
          : '0',
        totalPnl: totalPnl.toFixed(2),
        avgWin: wins.length > 0 ? (grossWins / wins.length).toFixed(2) : '0',
        avgLoss: losses.length > 0 ? (grossLosses / losses.length).toFixed(2) : '0',
        profitFactor: grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : '0',
        currentBalance: this.balance.toFixed(2),
        peakBalance: this.peakBalance.toFixed(2),
        drawdown: ((this.peakBalance - this.balance) / this.peakBalance * 100).toFixed(2),
        byBias,
        byQuadrant,
      },
    };
  }

  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.recentCloses = [];
  }

  // Set the initial balance (for when user syncs real MEXC investment)
  setInitialBalance(amount: number): void {
    this.config.initialBalance = amount;
    console.log(`[EXP:${this.config.botId}] Initial balance updated to $${amount}`);
  }

  // Serialize bot state for persistence (survives restarts)
  saveState(): {
    botId: string;
    balance: number;
    peakBalance: number;
    openPositions: Array<[string, ShadowPosition]>;
    closedPositions: ClosedPosition[];
    savedAt: string;
  } {
    return {
      botId: this.config.botId,
      balance: this.balance,
      peakBalance: this.peakBalance,
      openPositions: Array.from(this.positions.entries()),
      closedPositions: this.closedPositions.slice(-100), // Keep last 100
      savedAt: new Date().toISOString(),
    };
  }

  // Update leverage for new positions (does not change existing open positions)
  setLeverage(newLeverage: number): void {
    const old = this.config.leverage;
    if (old !== newLeverage) {
      this.config.leverage = newLeverage;
      console.log(`[EXP:${this.config.botId}] Leverage updated: ${old}x → ${newLeverage}x`);
    }
  }

  getLeverage(): number {
    return this.config.leverage;
  }

  // Restore bot state from persisted data
  restoreState(state: {
    balance: number;
    peakBalance: number;
    openPositions: Array<[string, ShadowPosition]>;
    closedPositions: ClosedPosition[];
  }): void {
    this.balance = state.balance;
    this.peakBalance = state.peakBalance;
    this.positions.clear();
    for (const [key, pos] of state.openPositions) {
      this.positions.set(key, pos);
    }
    this.closedPositions = state.closedPositions || [];
    console.log(`[EXP:${this.config.botId}] Restored state: balance=$${this.balance.toFixed(2)}, ${this.positions.size} open positions, ${this.closedPositions.length} closed`);
  }

  // Bootstrap recent closes for stress detection (from Turso historical data)
  bootstrapRecentCloses(closes: Array<{ timestamp: number; isWin: boolean }>): void {
    // Filter to last 2 hours only
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const recent = closes.filter(c => c.timestamp > twoHoursAgo);
    this.recentCloses = recent;
    console.log(`[EXP:${this.config.botId}] Bootstrapped ${recent.length} recent closes for stress detection`);
  }
}

// ============= Bot Factory =============

// Contrarian quadrants (best performing in backtests)
const CONTRARIAN_QUADRANTS: Quadrant[] = ['NEU+BEAR', 'BEAR+BEAR'];
const ALL_PROFITABLE_QUADRANTS: Quadrant[] = ['NEU+BEAR', 'BEAR+BEAR', 'NEU+NEU', 'NEU+BULL'];

export function createExperimentalBots(initialBalance: number = 2000): Map<string, ExperimentalShadowBot> {
  const bots = new Map<string, ExperimentalShadowBot>();

  // ============= Backburner + System B Experiments =============

  // BB + System B (Multi-Indicator) - All quadrants
  // Conditional insurance: sell half at 2% ROE when hourly WR < 50%, move SL to breakeven
  bots.set('exp-bb-sysB', new ExperimentalShadowBot({
    botId: 'exp-bb-sysB',
    description: 'BB + System B bias filter',
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    maxPositions: 10,
    initialStopPercent: 8,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,  // Use trailing only
    useBiasFilter: true,
    biasSystem: 'B',
    useRegimeFilter: false,
    allowedQuadrants: ALL_PROFITABLE_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
    // Conditional insurance: only during stress periods (WR < 50%)
    useConditionalInsurance: true,
    insuranceThresholdPercent: 2,
    insuranceStressWinRateThreshold: 50,
  }));

  // BB + System B + Contrarian quadrants only
  bots.set('exp-bb-sysB-contrarian', new ExperimentalShadowBot({
    botId: 'exp-bb-sysB-contrarian',
    description: 'BB + System B + Contrarian quadrants',
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    maxPositions: 10,
    initialStopPercent: 8,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,
    useBiasFilter: true,
    biasSystem: 'B',
    useRegimeFilter: true,
    allowedQuadrants: CONTRARIAN_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
  }));

  // ============= Golden Pocket + Regime Experiments =============

  // GP + Signal-ratio regime (contrarian only)
  bots.set('exp-gp-regime', new ExperimentalShadowBot({
    botId: 'exp-gp-regime',
    description: 'GP + Signal-ratio regime filter',
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    maxPositions: 10,
    initialStopPercent: 0,  // Use GP's Fib-based stops
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,  // Use GP's Fib-based TPs
    useBiasFilter: false,
    biasSystem: 'A',
    useRegimeFilter: true,
    allowedQuadrants: CONTRARIAN_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
  }));

  // GP + System A bias
  bots.set('exp-gp-sysA', new ExperimentalShadowBot({
    botId: 'exp-gp-sysA',
    description: 'GP + System A (RSI) bias filter',
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    maxPositions: 10,
    initialStopPercent: 0,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,
    useBiasFilter: true,
    biasSystem: 'A',
    useRegimeFilter: false,
    allowedQuadrants: ALL_PROFITABLE_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
  }));

  // GP + System B bias
  bots.set('exp-gp-sysB', new ExperimentalShadowBot({
    botId: 'exp-gp-sysB',
    description: 'GP + System B (Multi) bias filter',
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    maxPositions: 10,
    initialStopPercent: 0,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,
    useBiasFilter: true,
    biasSystem: 'B',
    useRegimeFilter: false,
    allowedQuadrants: ALL_PROFITABLE_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
  }));

  // GP + System B + Contrarian regime (double filter)
  bots.set('exp-gp-sysB-contrarian', new ExperimentalShadowBot({
    botId: 'exp-gp-sysB-contrarian',
    description: 'GP + System B + Contrarian regime',
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    maxPositions: 10,
    initialStopPercent: 0,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    takeProfitPercent: 0,
    useBiasFilter: true,
    biasSystem: 'B',
    useRegimeFilter: true,
    allowedQuadrants: CONTRARIAN_QUADRANTS,
    longOnly: false,
    feePercent: 0.04,
    slippagePercent: 0.15,  // Realistic alt slippage (was 0.05)
  }));

  return bots;
}

export { ExperimentalShadowBot, SignalRatioRegimeDetector };
export type { ExperimentalBotConfig, ShadowPosition, ClosedPosition, BotStats };
