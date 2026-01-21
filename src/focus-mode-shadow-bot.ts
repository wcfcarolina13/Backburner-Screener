/**
 * FOCUS MODE SHADOW BOTS - Simulates manual trading using Focus Mode guidance
 *
 * These bots mirror how a human would trade using Focus Mode:
 * - Uses quadrant rules (NEU+BEAR, BEAR+BEAR are contrarian/good)
 * - Dynamic leverage based on signal's suggested R:R
 * - Trailing stops with Focus Mode's tiered system
 * - Multiple strategy variants to test different approaches
 *
 * Strategy Variants:
 * 1. BASELINE: Standard Focus Mode rules, max 5 positions
 * 2. CONFLICT_CLOSE: Closes positions when regime conflicts (not neutral)
 * 3. EXCELLENT_OVERFLOW: Allows extra positions for "excellent" setups
 * 4. HYBRID: Combines conflict-close + excellent-overflow
 * 5. AGGRESSIVE: Higher leverage multiplier, tighter stops
 * 6. CONSERVATIVE: Lower leverage, wider stops, stricter entry rules
 */

import { EventEmitter } from 'events';

// ============= Types =============

export type MacroRegime = 'bull' | 'bear' | 'neutral';
export type MicroRegime = 'bullish' | 'bearish' | 'neutral';
export type Quadrant = 'BULL+BULL' | 'BULL+BEAR' | 'BULL+NEU' |
                       'BEAR+BULL' | 'BEAR+BEAR' | 'BEAR+NEU' |
                       'NEU+BULL' | 'NEU+BEAR' | 'NEU+NEU';

export type SetupQuality = 'excellent' | 'good' | 'marginal' | 'skip';

export interface FocusModeSignal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  currentPrice: number;
  entryPrice: number;

  // Focus Mode specific
  suggestedLeverage: number;
  suggestedPositionSize: number;  // Dollar amount
  suggestedStopLoss: number;      // Price level
  suggestedTakeProfit: number;    // Price level
  trailTriggerPercent: number;    // When to start trailing

  // Regime info
  macroRegime: MacroRegime;
  microRegime: MicroRegime;
  quadrant: Quadrant;

  // Quality assessment
  quality: SetupQuality;
  qualityScore: number;  // 0-100
  impulsePercent: number;
}

export interface ShadowPosition {
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;

  // Entry
  entryPrice: number;
  entryTime: number;

  // Size
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Risk management
  stopLoss: number;
  takeProfit: number;
  trailTriggerPercent: number;
  trailActivated: boolean;
  highestPnlPercent: number;

  // Regime at entry
  entryQuadrant: Quadrant;
  entryQuality: SetupQuality;

  // Tracking
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface ClosedPosition extends ShadowPosition {
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnl: number;
  realizedPnlPercent: number;
  durationMs: number;
}

// ============= Configuration =============

export interface FocusModeShadowBotConfig {
  botId: string;
  initialBalance: number;

  // Position limits
  maxPositions: number;
  maxExcellentOverflow: number;  // Extra positions allowed for excellent setups

  // Leverage
  useSuggestedLeverage: boolean;
  leverageMultiplier: number;    // 1.0 = use as-is, 0.5 = half, 2.0 = double
  maxLeverage: number;

  // Position sizing
  useKellySizing: boolean;
  fixedPositionPercent: number;  // % of balance if not Kelly
  useSuggestedSize: boolean;     // Use signal's suggested size

  // Stop loss
  useTrailingStop: boolean;
  initialStopPercent: number;    // If not using signal's stop
  trailStepPercent: number;

  // Take profit
  useTakeProfit: boolean;
  takeProfitMultiplier: number;  // Multiplier on signal's TP

  // Regime rules
  closeOnConflict: boolean;      // Close if regime becomes conflicting
  conflictGracePeriodMs: number; // How long to wait before closing on conflict

  // Entry filters
  minQualityScore: number;       // Minimum quality to enter (0-100)
  allowedQuadrants: Quadrant[];  // Which quadrants to trade in

  // Execution costs
  feePercent: number;
  slippagePercent: number;
}

export const DEFAULT_CONFIG: FocusModeShadowBotConfig = {
  botId: 'focus-shadow',
  initialBalance: 2000,

  maxPositions: 5,
  maxExcellentOverflow: 2,

  useSuggestedLeverage: true,
  leverageMultiplier: 1.0,
  maxLeverage: 20,

  useKellySizing: false,
  fixedPositionPercent: 10,
  useSuggestedSize: true,

  useTrailingStop: true,
  initialStopPercent: 8,
  trailStepPercent: 3,

  useTakeProfit: true,
  takeProfitMultiplier: 1.0,

  closeOnConflict: false,
  conflictGracePeriodMs: 5 * 60 * 1000,  // 5 minutes

  minQualityScore: 50,
  allowedQuadrants: ['NEU+BEAR', 'NEU+BULL', 'BEAR+BEAR'],

  feePercent: 0.04,  // MEXC futures taker
  slippagePercent: 0.05,
};

// Quadrant trading rules
const GOOD_QUADRANTS: Quadrant[] = ['NEU+BEAR', 'BEAR+BEAR'];  // Contrarian - best
const NEUTRAL_QUADRANTS: Quadrant[] = ['NEU+BULL', 'NEU+NEU'];  // Can trade
const CONFLICTING_QUADRANTS: Quadrant[] = ['BEAR+BULL'];  // Bull trap - never trade
const TREND_QUADRANTS: Quadrant[] = ['BULL+BULL', 'BULL+BEAR', 'BULL+NEU', 'BEAR+NEU'];  // Trend-following

// ============= Regime Detector (shared with spot-regime-bot) =============

export class RegimeDetector {
  private signalHistory: FocusModeSignal[] = [];
  private macroWindowHours: number = 24;
  private microWindowHours: number = 4;
  private bearishThreshold: number = 0.65;
  private bullishThreshold: number = 0.65;

  addSignal(signal: FocusModeSignal): void {
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
    const shortRatio = shorts / total;

    if (longRatio > 0.55) return 'bull';
    if (shortRatio > 0.55) return 'bear';
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

    if (shortRatio > this.bearishThreshold) return 'bearish';
    if (longRatio > this.bullishThreshold) return 'bullish';
    return 'neutral';
  }

  getQuadrant(macro: MacroRegime, micro: MicroRegime): Quadrant {
    const macroShort = macro === 'bull' ? 'BULL' : macro === 'bear' ? 'BEAR' : 'NEU';
    const microShort = micro === 'bullish' ? 'BULL' : micro === 'bearish' ? 'BEAR' : 'NEU';
    return `${macroShort}+${microShort}` as Quadrant;
  }

  getCurrentRegime(timestamp: number = Date.now()): { macro: MacroRegime; micro: MicroRegime; quadrant: Quadrant } {
    const macro = this.getMacroRegime(timestamp);
    const micro = this.getMicroRegime(timestamp);
    const quadrant = this.getQuadrant(macro, micro);
    return { macro, micro, quadrant };
  }
}

// ============= Focus Mode Shadow Bot =============

export class FocusModeShadowBot extends EventEmitter {
  private config: FocusModeShadowBotConfig;
  private regimeDetector: RegimeDetector;
  private positions: Map<string, ShadowPosition> = new Map();
  private closedPositions: ClosedPosition[] = [];
  private balance: number;
  private peakBalance: number;
  private conflictTimers: Map<string, number> = new Map();  // positionId -> conflictStartTime

  constructor(config: Partial<FocusModeShadowBotConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.regimeDetector = new RegimeDetector();
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  /**
   * Process a new signal from Focus Mode
   */
  processSignal(signal: FocusModeSignal): { action: 'open' | 'skip'; reason: string; position?: ShadowPosition } {
    // Add to regime detector history
    this.regimeDetector.addSignal(signal);

    // Get current regime
    const { quadrant } = this.regimeDetector.getCurrentRegime(signal.timestamp);

    // Check if quadrant is allowed
    if (!this.config.allowedQuadrants.includes(quadrant)) {
      return { action: 'skip', reason: `Quadrant ${quadrant} not allowed` };
    }

    // Check quality threshold
    if (signal.qualityScore < this.config.minQualityScore) {
      return { action: 'skip', reason: `Quality ${signal.qualityScore} below minimum ${this.config.minQualityScore}` };
    }

    // Check position limits
    const currentPositions = this.positions.size;
    const isExcellent = signal.quality === 'excellent';
    const maxAllowed = this.config.maxPositions + (isExcellent ? this.config.maxExcellentOverflow : 0);

    if (currentPositions >= maxAllowed) {
      return { action: 'skip', reason: `Max positions reached (${currentPositions}/${maxAllowed})` };
    }

    // Check if at base limit and not excellent
    if (currentPositions >= this.config.maxPositions && !isExcellent) {
      return { action: 'skip', reason: `At position limit, need excellent quality` };
    }

    // Check if already have position in this symbol
    const existingPos = Array.from(this.positions.values()).find(p => p.symbol === signal.symbol);
    if (existingPos) {
      return { action: 'skip', reason: `Already have position in ${signal.symbol}` };
    }

    // Calculate position size
    const positionSize = this.calculatePositionSize(signal);
    if (positionSize.margin <= 0) {
      return { action: 'skip', reason: 'Insufficient balance for position' };
    }

    // Open position
    const position = this.openPosition(signal, positionSize);
    this.emit('position_opened', position);

    return { action: 'open', reason: `Opened in ${quadrant}`, position };
  }

  private calculatePositionSize(signal: FocusModeSignal): { margin: number; leverage: number; notional: number } {
    // Determine leverage
    let leverage = signal.suggestedLeverage;
    if (!this.config.useSuggestedLeverage) {
      leverage = 10;  // Default
    }
    leverage = Math.min(leverage * this.config.leverageMultiplier, this.config.maxLeverage);

    // Determine margin
    let margin: number;
    if (this.config.useSuggestedSize) {
      margin = signal.suggestedPositionSize;
    } else if (this.config.useKellySizing) {
      // Kelly formula: f* = (bp - q) / b
      // where b = odds ratio (reward/risk), p = win probability, q = 1-p
      const estimatedWinRate = signal.qualityScore / 100 * 0.6;  // Scale quality to estimated win rate
      const rewardRiskRatio = (signal.suggestedTakeProfit - signal.entryPrice) /
                              Math.abs(signal.entryPrice - signal.suggestedStopLoss);
      const kellyFraction = (rewardRiskRatio * estimatedWinRate - (1 - estimatedWinRate)) / rewardRiskRatio;
      const safeFraction = Math.max(0, Math.min(kellyFraction * 0.5, 0.25));  // Half-Kelly, max 25%
      margin = this.balance * safeFraction;
    } else {
      margin = this.balance * (this.config.fixedPositionPercent / 100);
    }

    // Cap at available balance
    margin = Math.min(margin, this.balance * 0.9);  // Leave 10% buffer

    const notional = margin * leverage;

    return { margin, leverage, notional };
  }

  private openPosition(signal: FocusModeSignal, size: { margin: number; leverage: number; notional: number }): ShadowPosition {
    // Apply slippage to entry
    const slippage = signal.entryPrice * (this.config.slippagePercent / 100);
    const entryPrice = signal.direction === 'long'
      ? signal.entryPrice + slippage
      : signal.entryPrice - slippage;

    // Calculate stop loss
    let stopLoss: number;
    if (signal.suggestedStopLoss > 0) {
      stopLoss = signal.suggestedStopLoss;
    } else {
      const stopDistance = entryPrice * (this.config.initialStopPercent / 100);
      stopLoss = signal.direction === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
    }

    // Calculate take profit
    let takeProfit = signal.suggestedTakeProfit * this.config.takeProfitMultiplier;
    if (takeProfit <= 0) {
      // Default to 2:1 R:R
      const riskDistance = Math.abs(entryPrice - stopLoss);
      takeProfit = signal.direction === 'long' ? entryPrice + riskDistance * 2 : entryPrice - riskDistance * 2;
    }

    const position: ShadowPosition = {
      positionId: `${signal.symbol}-${signal.timeframe}-${signal.timestamp}`,
      symbol: signal.symbol,
      direction: signal.direction,
      timeframe: signal.timeframe,
      entryPrice,
      entryTime: signal.timestamp,
      marginUsed: size.margin,
      notionalSize: size.notional,
      leverage: size.leverage,
      stopLoss,
      takeProfit,
      trailTriggerPercent: signal.trailTriggerPercent || 10,
      trailActivated: false,
      highestPnlPercent: 0,
      entryQuadrant: signal.quadrant,
      entryQuality: signal.quality,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
    };

    // Deduct entry fees
    const entryFees = size.notional * (this.config.feePercent / 100);
    this.balance -= entryFees;

    this.positions.set(position.positionId, position);
    return position;
  }

  /**
   * Update all positions with current prices
   */
  updatePrices(priceMap: Map<string, number>, currentTimestamp: number = Date.now()): ClosedPosition[] {
    const closed: ClosedPosition[] = [];
    const { quadrant: currentQuadrant } = this.regimeDetector.getCurrentRegime(currentTimestamp);

    for (const [posId, position] of this.positions) {
      const price = priceMap.get(position.symbol);
      if (!price) continue;

      position.currentPrice = price;

      // Calculate P&L
      const priceDiff = position.direction === 'long'
        ? price - position.entryPrice
        : position.entryPrice - price;
      const pnlPercent = (priceDiff / position.entryPrice) * 100 * position.leverage;
      const pnl = (priceDiff / position.entryPrice) * position.notionalSize;

      position.unrealizedPnl = pnl;
      position.unrealizedPnlPercent = pnlPercent;

      // Track highest P&L for trailing
      if (pnlPercent > position.highestPnlPercent) {
        position.highestPnlPercent = pnlPercent;
      }

      // Check trailing stop activation
      if (!position.trailActivated && pnlPercent >= position.trailTriggerPercent) {
        position.trailActivated = true;
        this.emit('trail_activated', position);
      }

      // Update trailing stop
      if (position.trailActivated && this.config.useTrailingStop) {
        const trailDistance = position.highestPnlPercent - this.config.trailStepPercent;
        if (trailDistance > 0) {
          const newStopPnl = trailDistance / position.leverage;
          const newStopDistance = position.entryPrice * (newStopPnl / 100);
          const newStop = position.direction === 'long'
            ? position.entryPrice + newStopDistance
            : position.entryPrice - newStopDistance;

          // Only move stop in our favor
          if (position.direction === 'long' && newStop > position.stopLoss) {
            position.stopLoss = newStop;
          } else if (position.direction === 'short' && newStop < position.stopLoss) {
            position.stopLoss = newStop;
          }
        }
      }

      // Check exit conditions
      let exitReason: string | null = null;

      // Stop loss hit
      if (position.direction === 'long' && price <= position.stopLoss) {
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
      } else if (position.direction === 'short' && price >= position.stopLoss) {
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
      }

      // Take profit hit
      if (this.config.useTakeProfit) {
        if (position.direction === 'long' && price >= position.takeProfit) {
          exitReason = 'take_profit';
        } else if (position.direction === 'short' && price <= position.takeProfit) {
          exitReason = 'take_profit';
        }
      }

      // Regime conflict check
      if (this.config.closeOnConflict && !exitReason) {
        const isConflicting = this.isPositionConflicting(position, currentQuadrant);

        if (isConflicting) {
          // Start or check grace period timer
          if (!this.conflictTimers.has(posId)) {
            this.conflictTimers.set(posId, currentTimestamp);
          } else {
            const conflictStart = this.conflictTimers.get(posId)!;
            if (currentTimestamp - conflictStart >= this.config.conflictGracePeriodMs) {
              exitReason = 'regime_conflict';
            }
          }
        } else {
          // Clear conflict timer if regime is no longer conflicting
          this.conflictTimers.delete(posId);
        }
      }

      // Close position if exit condition met
      if (exitReason) {
        const closedPos = this.closePosition(position, price, currentTimestamp, exitReason);
        closed.push(closedPos);
      }
    }

    return closed;
  }

  private isPositionConflicting(position: ShadowPosition, currentQuadrant: Quadrant): boolean {
    // A position is conflicting if:
    // - LONG position in BEAR+BULL quadrant (bull trap)
    // - SHORT position in BULL+BEAR quadrant
    // - Any position in opposite macro regime

    if (position.direction === 'long') {
      return currentQuadrant === 'BEAR+BULL' || currentQuadrant.startsWith('BEAR+');
    } else {
      return currentQuadrant === 'BULL+BEAR' || currentQuadrant.startsWith('BULL+');
    }
  }

  private closePosition(position: ShadowPosition, exitPrice: number, exitTime: number, exitReason: string): ClosedPosition {
    // Apply slippage to exit
    const slippage = exitPrice * (this.config.slippagePercent / 100);
    const finalExitPrice = position.direction === 'long'
      ? exitPrice - slippage
      : exitPrice + slippage;

    // Calculate final P&L
    const priceDiff = position.direction === 'long'
      ? finalExitPrice - position.entryPrice
      : position.entryPrice - finalExitPrice;
    const realizedPnlPercent = (priceDiff / position.entryPrice) * 100 * position.leverage;
    const realizedPnl = (priceDiff / position.entryPrice) * position.notionalSize;

    // Deduct exit fees
    const exitFees = position.notionalSize * (this.config.feePercent / 100);

    const closedPos: ClosedPosition = {
      ...position,
      exitPrice: finalExitPrice,
      exitTime,
      exitReason,
      realizedPnl: realizedPnl - exitFees,
      realizedPnlPercent,
      durationMs: exitTime - position.entryTime,
    };

    // Update balance
    this.balance += position.marginUsed + closedPos.realizedPnl;
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Remove from active, add to closed
    this.positions.delete(position.positionId);
    this.conflictTimers.delete(position.positionId);
    this.closedPositions.push(closedPos);

    this.emit('position_closed', closedPos);
    return closedPos;
  }

  // ============= Getters =============

  getPositions(): ShadowPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(limit?: number): ClosedPosition[] {
    if (limit) {
      return this.closedPositions.slice(-limit);
    }
    return this.closedPositions;
  }

  getBalance(): number {
    return this.balance;
  }

  getUnrealizedPnl(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => p.realizedPnl > 0);
    const losses = closed.filter(p => p.realizedPnl <= 0);

    const totalPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0);
    const grossProfit = wins.reduce((sum, p) => sum + p.realizedPnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p.realizedPnl, 0));

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    // By exit reason
    const byExitReason: Record<string, { count: number; pnl: number }> = {};
    for (const p of closed) {
      if (!byExitReason[p.exitReason]) {
        byExitReason[p.exitReason] = { count: 0, pnl: 0 };
      }
      byExitReason[p.exitReason].count++;
      byExitReason[p.exitReason].pnl += p.realizedPnl;
    }

    // By quadrant
    const byQuadrant: Record<string, { count: number; pnl: number; wins: number }> = {};
    for (const p of closed) {
      if (!byQuadrant[p.entryQuadrant]) {
        byQuadrant[p.entryQuadrant] = { count: 0, pnl: 0, wins: 0 };
      }
      byQuadrant[p.entryQuadrant].count++;
      byQuadrant[p.entryQuadrant].pnl += p.realizedPnl;
      if (p.realizedPnl > 0) byQuadrant[p.entryQuadrant].wins++;
    }

    return {
      totalTrades: closed.length,
      openPositions: this.positions.size,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0',
      totalPnl: totalPnl.toFixed(2),
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Inf' : '0'),
      currentBalance: this.balance.toFixed(2),
      peakBalance: this.peakBalance.toFixed(2),
      drawdown: (((this.peakBalance - this.balance) / this.peakBalance) * 100).toFixed(2),
      unrealizedPnl: this.getUnrealizedPnl().toFixed(2),
      byExitReason,
      byQuadrant,
    };
  }

  getConfig(): FocusModeShadowBotConfig {
    return this.config;
  }

  getCurrentRegime() {
    return this.regimeDetector.getCurrentRegime();
  }

  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.conflictTimers.clear();
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  setInitialBalance(amount: number): void {
    this.config.initialBalance = amount;
    this.balance = amount;
    this.peakBalance = amount;
  }
}

// ============= Factory Functions for Bot Variants =============

/**
 * BASELINE: Standard Focus Mode rules
 * - Max 5 positions
 * - Uses suggested leverage and size
 * - Trailing stops enabled
 * - No conflict-close
 */
export function createBaselineBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-baseline',
    maxPositions: 5,
    maxExcellentOverflow: 0,
    closeOnConflict: false,
  });
}

/**
 * CONFLICT_CLOSE: Closes positions when regime conflicts
 * - Same as baseline but closes on regime conflict
 * - 5 minute grace period before closing
 */
export function createConflictCloseBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-conflict',
    maxPositions: 5,
    maxExcellentOverflow: 0,
    closeOnConflict: true,
    conflictGracePeriodMs: 5 * 60 * 1000,
  });
}

/**
 * EXCELLENT_OVERFLOW: Allows extra positions for excellent setups
 * - Max 5 normal positions
 * - +2 extra for excellent quality setups
 * - Higher quality threshold for base positions
 */
export function createExcellentOverflowBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-excellent',
    maxPositions: 5,
    maxExcellentOverflow: 2,
    minQualityScore: 60,  // Slightly higher bar
    closeOnConflict: false,
  });
}

/**
 * HYBRID: Combines conflict-close + excellent-overflow
 * - Best of both strategies
 * - Closes on conflict, allows overflow for excellent
 */
export function createHybridBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-hybrid',
    maxPositions: 5,
    maxExcellentOverflow: 2,
    closeOnConflict: true,
    conflictGracePeriodMs: 5 * 60 * 1000,
    minQualityScore: 55,
  });
}

/**
 * AGGRESSIVE: Higher risk, higher reward
 * - 1.5x leverage multiplier
 * - Tighter stops (6%)
 * - Lower quality threshold
 * - More positions allowed
 */
export function createAggressiveBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-aggressive',
    maxPositions: 8,
    maxExcellentOverflow: 3,
    leverageMultiplier: 1.5,
    maxLeverage: 30,
    initialStopPercent: 6,
    trailStepPercent: 2,
    minQualityScore: 40,
    closeOnConflict: false,
  });
}

/**
 * CONSERVATIVE: Lower risk, consistent returns
 * - 0.75x leverage multiplier
 * - Wider stops (12%)
 * - Higher quality threshold
 * - Fewer positions
 * - Closes on conflict
 */
export function createConservativeBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-conservative',
    maxPositions: 3,
    maxExcellentOverflow: 1,
    leverageMultiplier: 0.75,
    maxLeverage: 15,
    initialStopPercent: 12,
    trailStepPercent: 4,
    minQualityScore: 70,
    closeOnConflict: true,
    conflictGracePeriodMs: 3 * 60 * 1000,
  });
}

/**
 * KELLY_SIZING: Uses Kelly criterion for position sizing
 * - Dynamic position sizing based on quality and R:R
 * - Otherwise similar to baseline
 */
export function createKellySizingBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-kelly',
    maxPositions: 5,
    maxExcellentOverflow: 2,
    useKellySizing: true,
    useSuggestedSize: false,
    closeOnConflict: false,
  });
}

/**
 * CONTRARIAN_ONLY: Only trades in bearish micro-regimes
 * - NEU+BEAR and BEAR+BEAR only
 * - Pure "buy the blood" strategy
 */
export function createContrarianOnlyBot(): FocusModeShadowBot {
  return new FocusModeShadowBot({
    botId: 'focus-contrarian-only',
    maxPositions: 5,
    maxExcellentOverflow: 2,
    allowedQuadrants: ['NEU+BEAR', 'BEAR+BEAR'],
    closeOnConflict: true,
    conflictGracePeriodMs: 3 * 60 * 1000,
  });
}
