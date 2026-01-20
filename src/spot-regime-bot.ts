#!/usr/bin/env node
/**
 * SPOT REGIME BOT - Production-Ready Contrarian Strategy
 *
 * Based on backtesting findings:
 * - Only trades in profitable quadrants: NEU+BEAR, NEU+BULL, BEAR+BEAR
 * - NEVER trades in BEAR+BULL (0% win rate - bull trap)
 * - Implements realistic execution costs (slippage, fees, bad fills)
 *
 * This is for SPOT trading (long-only, 1x leverage) on MEXC.
 */

import { EventEmitter } from 'events';

// ============= Configuration =============

export interface SpotRegimeBotConfig {
  botId: string;
  positionSizeDollars: number;      // Fixed dollar amount per trade
  initialStopLossPercent: number;   // Initial stop loss %
  trailTriggerPercent: number;      // When to start trailing
  trailStepPercent: number;         // Trail step size
  level1LockPercent: number;        // When to lock breakeven

  // Regime detection windows
  macroWindowHours: number;         // Window for macro regime (default: 24h)
  microWindowHours: number;         // Window for micro regime (default: 4h)

  // Regime thresholds
  microBearishThreshold: number;    // Short ratio above this = bearish (default: 0.65)
  microBullishThreshold: number;    // Long ratio above this = bullish (default: 0.65)
  macroBearThreshold: number;       // Short ratio above this = macro bear (default: 0.55)
  macroBullThreshold: number;       // Long ratio above this = macro bull (default: 0.55)

  // Execution costs (realistic simulation)
  makerFeePercent: number;          // MEXC maker fee (default: 0.1%)
  takerFeePercent: number;          // MEXC taker fee (default: 0.1%)
  slippagePercent: number;          // Expected slippage (default: 0.05%)
  badFillProbability: number;       // Probability of bad fill (default: 0.1 = 10%)
  badFillExtraSlippage: number;     // Extra slippage on bad fill (default: 0.1%)
}

export const DEFAULT_CONFIG: SpotRegimeBotConfig = {
  botId: 'spot-regime',
  positionSizeDollars: 100,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,

  macroWindowHours: 24,
  microWindowHours: 4,

  microBearishThreshold: 0.65,
  microBullishThreshold: 0.65,
  macroBearThreshold: 0.55,
  macroBullThreshold: 0.55,

  // Realistic MEXC costs
  makerFeePercent: 0.1,
  takerFeePercent: 0.1,
  slippagePercent: 0.05,
  badFillProbability: 0.10,
  badFillExtraSlippage: 0.1,
};

// ============= Types =============

export type MacroRegime = 'bull' | 'bear' | 'neutral';
export type MicroRegime = 'bullish' | 'bearish' | 'neutral';
export type Quadrant = 'BULL+BULL' | 'BULL+BEAR' | 'BULL+NEU' |
                       'BEAR+BULL' | 'BEAR+BEAR' | 'BEAR+NEU' |
                       'NEU+BULL' | 'NEU+BEAR' | 'NEU+NEU';

// For debugging - maps full names to short quadrant names
export { PROFITABLE_QUADRANTS, FORBIDDEN_QUADRANTS };

// Profitable quadrants based on backtesting
// NEU+BULL showed 0% win rate in latest 7-day period - keeping for now but monitoring
const PROFITABLE_QUADRANTS: Quadrant[] = ['NEU+BEAR', 'NEU+BULL', 'BEAR+BEAR'];
const FORBIDDEN_QUADRANTS: Quadrant[] = ['BEAR+BULL'];  // 0% win rate - bull trap

// More conservative variant - only pure contrarian quadrants
const PURE_CONTRARIAN_QUADRANTS: Quadrant[] = ['NEU+BEAR', 'BEAR+BEAR'];

export interface Signal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  price: number;
  entryPrice: number;
}

export interface Position {
  positionId: string;
  symbol: string;
  entryPrice: number;
  entryPriceWithSlippage: number;  // Actual fill price after slippage
  entryTime: number;
  quantity: number;                 // Amount of asset
  dollarValue: number;
  stopLoss: number;
  highestPrice: number;
  trailActivated: boolean;
  level1Locked: boolean;
  timeframe: string;
  rsi: number;
  macroRegime: MacroRegime;
  microRegime: MicroRegime;
  quadrant: Quadrant;
  entryFees: number;
}

export interface TradeResult {
  positionId: string;
  symbol: string;
  entryPrice: number;
  entryPriceWithSlippage: number;
  exitPrice: number;
  exitPriceWithSlippage: number;
  entryTime: number;
  exitTime: number;
  quantity: number;
  grossPnL: number;
  fees: number;
  slippage: number;
  netPnL: number;
  netPnLPercent: number;
  exitReason: string;
  timeframe: string;
  macroRegime: MacroRegime;
  microRegime: MicroRegime;
  quadrant: Quadrant;
  hadBadFill: boolean;
}

// ============= Execution Cost Calculator =============

export class ExecutionCostCalculator {
  private config: SpotRegimeBotConfig;

  constructor(config: SpotRegimeBotConfig) {
    this.config = config;
  }

  /**
   * Calculate entry costs including slippage and fees
   * For spot LONG: we're BUYING, so slippage makes price HIGHER
   */
  calculateEntryExecution(idealPrice: number, quantity: number): {
    fillPrice: number;
    slippage: number;
    fees: number;
    hadBadFill: boolean;
  } {
    // Determine if this is a bad fill
    const hadBadFill = Math.random() < this.config.badFillProbability;

    // Calculate slippage
    let slippagePercent = this.config.slippagePercent;
    if (hadBadFill) {
      slippagePercent += this.config.badFillExtraSlippage;
    }

    // For buying, slippage increases the price
    const slippageAmount = idealPrice * (slippagePercent / 100);
    const fillPrice = idealPrice + slippageAmount;

    // Calculate fees (taker fee for market orders)
    const notionalValue = fillPrice * quantity;
    const fees = notionalValue * (this.config.takerFeePercent / 100);

    return {
      fillPrice,
      slippage: slippageAmount * quantity,
      fees,
      hadBadFill,
    };
  }

  /**
   * Calculate exit costs including slippage and fees
   * For spot LONG exit: we're SELLING, so slippage makes price LOWER
   */
  calculateExitExecution(idealPrice: number, quantity: number, isStopLoss: boolean): {
    fillPrice: number;
    slippage: number;
    fees: number;
    hadBadFill: boolean;
  } {
    // Stop losses have higher probability of bad fill (volatility at stop levels)
    const badFillProb = isStopLoss
      ? this.config.badFillProbability * 1.5  // 50% more likely on stop loss
      : this.config.badFillProbability;

    const hadBadFill = Math.random() < badFillProb;

    let slippagePercent = this.config.slippagePercent;
    if (hadBadFill) {
      slippagePercent += this.config.badFillExtraSlippage;
    }
    if (isStopLoss) {
      slippagePercent *= 1.5;  // Stop losses often get worse fills
    }

    // For selling, slippage decreases the price
    const slippageAmount = idealPrice * (slippagePercent / 100);
    const fillPrice = idealPrice - slippageAmount;

    const notionalValue = fillPrice * quantity;
    const fees = notionalValue * (this.config.takerFeePercent / 100);

    return {
      fillPrice,
      slippage: slippageAmount * quantity,
      fees,
      hadBadFill,
    };
  }
}

// ============= Regime Detector =============

export class RegimeDetector {
  private config: SpotRegimeBotConfig;
  private signalHistory: Signal[] = [];

  constructor(config: SpotRegimeBotConfig) {
    this.config = config;
  }

  addSignal(signal: Signal): void {
    this.signalHistory.push(signal);

    // Keep only last 48 hours of signals to avoid memory bloat
    // Use the signal's timestamp as reference (not Date.now()) to support backtesting
    const cutoff = signal.timestamp - 48 * 60 * 60 * 1000;
    this.signalHistory = this.signalHistory.filter(s => s.timestamp > cutoff);
  }

  getMacroRegime(timestamp: number): MacroRegime {
    const windowMs = this.config.macroWindowHours * 60 * 60 * 1000;
    const windowStart = timestamp - windowMs;

    const windowSignals = this.signalHistory.filter(s =>
      s.timestamp >= windowStart && s.timestamp < timestamp
    );

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    if (total < 10) return 'neutral';  // Not enough data

    const longRatio = longs / total;
    const shortRatio = shorts / total;

    if (longRatio > this.config.macroBullThreshold) return 'bull';
    if (shortRatio > this.config.macroBearThreshold) return 'bear';
    return 'neutral';
  }

  getMicroRegime(timestamp: number): { regime: MicroRegime; shortRatio: number; longRatio: number } {
    const windowMs = this.config.microWindowHours * 60 * 60 * 1000;
    const windowStart = timestamp - windowMs;

    const windowSignals = this.signalHistory.filter(s =>
      s.timestamp >= windowStart && s.timestamp < timestamp
    );

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    if (total < 3) {
      return { regime: 'neutral', shortRatio: 0.5, longRatio: 0.5 };
    }

    const longRatio = longs / total;
    const shortRatio = shorts / total;

    let regime: MicroRegime = 'neutral';
    if (shortRatio > this.config.microBearishThreshold) regime = 'bearish';
    else if (longRatio > this.config.microBullishThreshold) regime = 'bullish';

    return { regime, shortRatio, longRatio };
  }

  getQuadrant(macro: MacroRegime, micro: MicroRegime): Quadrant {
    // Convert to short form for quadrant naming
    const macroShort = macro === 'bull' ? 'BULL' : macro === 'bear' ? 'BEAR' : 'NEU';
    const microShort = micro === 'bullish' ? 'BULL' : micro === 'bearish' ? 'BEAR' : 'NEU';
    const key = `${macroShort}+${microShort}`;
    return key as Quadrant;
  }

  shouldTrade(macro: MacroRegime, micro: MicroRegime): { allowed: boolean; reason: string } {
    const quadrant = this.getQuadrant(macro, micro);

    if (FORBIDDEN_QUADRANTS.includes(quadrant)) {
      return { allowed: false, reason: `Forbidden quadrant: ${quadrant} (bull trap)` };
    }

    if (PROFITABLE_QUADRANTS.includes(quadrant)) {
      return { allowed: true, reason: `Profitable quadrant: ${quadrant}` };
    }

    return { allowed: false, reason: `Unprofitable quadrant: ${quadrant}` };
  }

  getRegimeStats(): {
    macroRegime: MacroRegime;
    microRegime: MicroRegime;
    quadrant: Quadrant;
    signalCount: number;
    longRatio: number;
    shortRatio: number;
  } {
    const now = Date.now();
    const macro = this.getMacroRegime(now);
    const { regime: micro, longRatio, shortRatio } = this.getMicroRegime(now);
    const quadrant = this.getQuadrant(macro, micro);

    return {
      macroRegime: macro,
      microRegime: micro,
      quadrant,
      signalCount: this.signalHistory.length,
      longRatio,
      shortRatio,
    };
  }
}

// ============= Spot Regime Bot =============

export class SpotRegimeBot extends EventEmitter {
  private config: SpotRegimeBotConfig;
  private regimeDetector: RegimeDetector;
  private costCalculator: ExecutionCostCalculator;
  private positions: Map<string, Position> = new Map();
  private trades: TradeResult[] = [];
  private balance: number;
  private initialBalance: number;

  constructor(config: Partial<SpotRegimeBotConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.regimeDetector = new RegimeDetector(this.config);
    this.costCalculator = new ExecutionCostCalculator(this.config);
    this.balance = 2000;  // Starting balance
    this.initialBalance = 2000;
  }

  /**
   * Process an incoming signal from the screener
   */
  processSignal(signal: Signal): { action: 'open' | 'skip'; reason: string; position?: Position } {
    // Add to regime detector's history
    this.regimeDetector.addSignal(signal);

    // Only process LONG signals (spot can't short)
    if (signal.direction !== 'long') {
      return { action: 'skip', reason: 'Short signal (spot-only)' };
    }

    // Check if already have position in this symbol
    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (this.positions.has(posKey)) {
      return { action: 'skip', reason: 'Already have position' };
    }

    // Get current regime
    const macro = this.regimeDetector.getMacroRegime(signal.timestamp);
    const { regime: micro } = this.regimeDetector.getMicroRegime(signal.timestamp);
    const quadrant = this.regimeDetector.getQuadrant(macro, micro);

    // Check if we should trade in this quadrant
    const { allowed, reason } = this.regimeDetector.shouldTrade(macro, micro);

    if (!allowed) {
      this.emit('signal_skipped', { signal, reason, quadrant });
      return { action: 'skip', reason };
    }

    // Open position
    const position = this.openPosition(signal, macro, micro, quadrant);
    if (position) {
      this.emit('position_opened', position);
      return { action: 'open', reason, position };
    }

    return { action: 'skip', reason: 'Failed to open position' };
  }

  private openPosition(signal: Signal, macro: MacroRegime, micro: MicroRegime, quadrant: Quadrant): Position | null {
    const idealPrice = signal.entryPrice;
    const quantity = this.config.positionSizeDollars / idealPrice;

    // Calculate entry execution with slippage and fees
    const entry = this.costCalculator.calculateEntryExecution(idealPrice, quantity);

    // Calculate stop loss based on ACTUAL fill price
    const stopDistance = entry.fillPrice * (this.config.initialStopLossPercent / 100);
    const stopLoss = entry.fillPrice - stopDistance;

    const position: Position = {
      positionId: `${signal.symbol}-${signal.timeframe}-${signal.timestamp}`,
      symbol: signal.symbol,
      entryPrice: idealPrice,
      entryPriceWithSlippage: entry.fillPrice,
      entryTime: signal.timestamp,
      quantity,
      dollarValue: entry.fillPrice * quantity,
      stopLoss,
      highestPrice: entry.fillPrice,
      trailActivated: false,
      level1Locked: false,
      timeframe: signal.timeframe,
      rsi: signal.rsi,
      macroRegime: macro,
      microRegime: micro,
      quadrant,
      entryFees: entry.fees,
    };

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    this.positions.set(posKey, position);

    return position;
  }

  /**
   * Update position with new price data
   */
  updatePrice(symbol: string, timeframe: string, price: number, timestamp: number): TradeResult | null {
    const posKey = `${symbol}-${timeframe}`;
    const position = this.positions.get(posKey);
    if (!position) return null;

    // Update highest price
    if (price > position.highestPrice) {
      position.highestPrice = price;
    }

    // Calculate current P&L percent (based on actual entry with slippage)
    const pnlPercent = ((price - position.entryPriceWithSlippage) / position.entryPriceWithSlippage) * 100;

    // Level 1 lock (breakeven)
    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      // Lock stop at slight profit above entry (accounting for fees)
      position.stopLoss = position.entryPriceWithSlippage * 1.002;
      this.emit('level1_locked', position);
    }

    // Trail activation
    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
      this.emit('trail_activated', position);
    }

    // Update trailing stop
    if (position.trailActivated) {
      const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
      if (trailStop > position.stopLoss) {
        position.stopLoss = trailStop;
      }
    }

    // Check stop loss hit
    if (price <= position.stopLoss) {
      const exitReason = position.trailActivated ? 'trailing_stop' :
                         (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
      return this.closePosition(posKey, position.stopLoss, timestamp, exitReason, true);
    }

    return null;
  }

  private closePosition(posKey: string, idealExitPrice: number, exitTime: number, reason: string, isStopLoss: boolean): TradeResult | null {
    const position = this.positions.get(posKey);
    if (!position) return null;

    this.positions.delete(posKey);

    // Calculate exit execution with slippage and fees
    const exit = this.costCalculator.calculateExitExecution(idealExitPrice, position.quantity, isStopLoss);

    // Calculate P&L
    const grossPnL = (exit.fillPrice - position.entryPriceWithSlippage) * position.quantity;
    const totalFees = position.entryFees + exit.fees;
    const totalSlippage = (position.entryPriceWithSlippage - position.entryPrice) * position.quantity +
                          (idealExitPrice - exit.fillPrice) * position.quantity;
    const netPnL = grossPnL - totalFees;

    const result: TradeResult = {
      positionId: position.positionId,
      symbol: position.symbol,
      entryPrice: position.entryPrice,
      entryPriceWithSlippage: position.entryPriceWithSlippage,
      exitPrice: idealExitPrice,
      exitPriceWithSlippage: exit.fillPrice,
      entryTime: position.entryTime,
      exitTime,
      quantity: position.quantity,
      grossPnL,
      fees: totalFees,
      slippage: totalSlippage,
      netPnL,
      netPnLPercent: (netPnL / this.config.positionSizeDollars) * 100,
      exitReason: reason,
      timeframe: position.timeframe,
      macroRegime: position.macroRegime,
      microRegime: position.microRegime,
      quadrant: position.quadrant,
      hadBadFill: exit.hadBadFill,
    };

    this.trades.push(result);
    this.balance += netPnL;

    this.emit('position_closed', result);
    return result;
  }

  /**
   * Get current regime stats
   */
  getRegimeStats() {
    return this.regimeDetector.getRegimeStats();
  }

  /**
   * Get bot statistics
   */
  getStats() {
    const trades = this.trades;
    const wins = trades.filter(t => t.netPnL > 0);
    const losses = trades.filter(t => t.netPnL <= 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
    const totalSlippage = trades.reduce((sum, t) => sum + t.slippage, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.netPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnL, 0));

    // By quadrant
    const byQuadrant: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const trade of trades) {
      if (!byQuadrant[trade.quadrant]) {
        byQuadrant[trade.quadrant] = { trades: 0, pnl: 0, wins: 0 };
      }
      byQuadrant[trade.quadrant].trades++;
      byQuadrant[trade.quadrant].pnl += trade.netPnL;
      if (trade.netPnL > 0) byQuadrant[trade.quadrant].wins++;
    }

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
      totalPnL: totalPnL.toFixed(2),
      totalFees: totalFees.toFixed(2),
      totalSlippage: totalSlippage.toFixed(4),
      avgWin: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0',
      avgLoss: losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0',
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Inf' : '0'),
      balance: this.balance.toFixed(2),
      byQuadrant,
    };
  }

  /**
   * Get open positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get trade history
   */
  getTrades(): TradeResult[] {
    return this.trades;
  }

  /**
   * Get config
   */
  getConfig(): SpotRegimeBotConfig {
    return this.config;
  }
}

// ============= Factory Functions =============

/**
 * STRICT FILTER: Requires strong regime confirmation (70%+ threshold)
 * - Fewer trades, higher conviction
 * - Tighter stops, earlier trail
 */
export function createStrictFilterBot(): SpotRegimeBot {
  return new SpotRegimeBot({
    botId: 'spot-strict',
    positionSizeDollars: 100,
    initialStopLossPercent: 12,    // Tighter stop
    trailTriggerPercent: 8,        // Trail sooner
    trailStepPercent: 4,
    level1LockPercent: 1.5,        // Lock breakeven sooner
    microBearishThreshold: 0.70,   // Require 70%+ shorts for bearish
    microBullishThreshold: 0.70,   // Require 70%+ longs for bullish
  });
}

/**
 * LOOSE FILTER: Accepts weaker regime signals (60%+ threshold)
 * - More trades, lower conviction per trade
 * - Wider stops to avoid noise
 */
export function createLooseFilterBot(): SpotRegimeBot {
  return new SpotRegimeBot({
    botId: 'spot-loose',
    positionSizeDollars: 100,
    initialStopLossPercent: 18,    // Wider stop
    trailTriggerPercent: 12,       // Trail later
    trailStepPercent: 6,
    level1LockPercent: 3,
    microBearishThreshold: 0.60,   // Accept 60%+ shorts as bearish
    microBullishThreshold: 0.60,   // Accept 60%+ longs as bullish
  });
}

/**
 * STANDARD FILTER: Balanced defaults (65% threshold)
 */
export function createStandardFilterBot(): SpotRegimeBot {
  return new SpotRegimeBot({
    botId: 'spot-standard',
  });
}

/**
 * CONTRARIAN ONLY: Only trades in bearish micro-regimes (NEU+BEAR, BEAR+BEAR)
 * - Removes NEU+BULL which showed 0% win rate in testing
 * - Pure "buy the dip" strategy
 */
export function createContrarianOnlyBot(): SpotRegimeBot {
  return new SpotRegimeBot({
    botId: 'spot-contrarian',
    positionSizeDollars: 100,
    initialStopLossPercent: 18,
    trailTriggerPercent: 12,
    trailStepPercent: 6,
    level1LockPercent: 3,
    microBearishThreshold: 0.60,   // Accept weaker bearish signals
    microBullishThreshold: 0.95,   // Effectively disable bullish quadrants
  });
}

// Legacy aliases for backwards compatibility
export const createConservativeSpotBot = createStrictFilterBot;
export const createAggressiveSpotBot = createLooseFilterBot;
export const createStandardSpotBot = createStandardFilterBot;
export const createPureContrarianSpotBot = createContrarianOnlyBot;

// ============= CLI for Testing =============

/**
 * Print bot configuration (can be called from CLI or test scripts)
 */
export function printBotConfig(): void {
  console.log('='.repeat(60));
  console.log('SPOT REGIME BOT - Configuration Test');
  console.log('='.repeat(60));
  console.log('');

  const bot = createStandardSpotBot();
  const config = bot.getConfig();

  console.log('📊 Bot Configuration:');
  console.log(`   Position Size: $${config.positionSizeDollars}`);
  console.log(`   Initial Stop Loss: ${config.initialStopLossPercent}%`);
  console.log(`   Trail Trigger: ${config.trailTriggerPercent}%`);
  console.log(`   Trail Step: ${config.trailStepPercent}%`);
  console.log('');

  console.log('📈 Regime Detection:');
  console.log(`   Macro Window: ${config.macroWindowHours}h`);
  console.log(`   Micro Window: ${config.microWindowHours}h`);
  console.log(`   Micro Bearish Threshold: ${config.microBearishThreshold * 100}% shorts`);
  console.log(`   Micro Bullish Threshold: ${config.microBullishThreshold * 100}% longs`);
  console.log('');

  console.log('💰 Execution Costs:');
  console.log(`   Maker Fee: ${config.makerFeePercent}%`);
  console.log(`   Taker Fee: ${config.takerFeePercent}%`);
  console.log(`   Expected Slippage: ${config.slippagePercent}%`);
  console.log(`   Bad Fill Probability: ${config.badFillProbability * 100}%`);
  console.log(`   Bad Fill Extra Slippage: ${config.badFillExtraSlippage}%`);
  console.log('');

  console.log('✅ Profitable Quadrants:', PROFITABLE_QUADRANTS.join(', '));
  console.log('⛔ Forbidden Quadrants:', FORBIDDEN_QUADRANTS.join(', '));
  console.log('');

  console.log('Bot ready for integration with screener.');
}
