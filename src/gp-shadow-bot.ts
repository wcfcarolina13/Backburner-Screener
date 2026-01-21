/**
 * GP Shadow Bot - Golden Pocket RSI Zone Strategy
 *
 * ============================================================================
 * STRATEGY OVERVIEW
 * ============================================================================
 *
 * This bot uses a SIMPLER entry logic than Backburner:
 * - Backburner: Requires impulse move → RSI crosses threshold → state machine
 * - GP Zone: Just checks if RSI is in the golden pocket zone
 *
 * GOLDEN POCKET RSI ZONES:
 * - Long zone:  RSI 23.6 - 38.2 (Fibonacci retracement levels)
 * - Short zone: RSI 61.8 - 76.4 (Fibonacci retracement levels)
 *
 * ============================================================================
 * BACKTEST FINDINGS (Jan 2026)
 * ============================================================================
 *
 * Using 83 days of 4H candle data across 152 symbols:
 *
 * | Strategy                    | Trades | Win%  | PF   | P&L       |
 * |-----------------------------|--------|-------|------|-----------|
 * | Backburner 4H Normal        | ~19    | 89.5% | 6.13 | +$412     |
 * | GP Zone 4H Normal           | 152    | 27.6% | 1.69 | +$10,672  |
 *
 * Key insight: The simpler GP zone approach generated MORE trades and
 * MORE profit despite lower win rate. The impulse requirement in
 * Backburner may be filtering out profitable setups.
 *
 * ============================================================================
 * CONFIGURATIONS TO TEST
 * ============================================================================
 *
 * This file creates multiple shadow bots to A/B test:
 *
 * 1. gp-4h-normal: 4H timeframe, normal direction (backtest winner)
 *    - RSI 23.6-38.2 → LONG
 *    - RSI 61.8-76.4 → SHORT
 *
 * 2. gp-4h-fade: 4H timeframe, faded direction (control)
 *    - RSI 23.6-38.2 → SHORT (opposite)
 *    - RSI 61.8-76.4 → LONG (opposite)
 *
 * 3. gp-5m-normal: 5m timeframe, normal direction (control)
 *
 * 4. gp-5m-fade: 5m timeframe, faded direction
 *    - Previous backtests showed 5m fade beats 5m normal for Backburner
 *    - Testing if same holds true for GP zone strategy
 *
 * ============================================================================
 * HOW TO EVALUATE RESULTS
 * ============================================================================
 *
 * After several days of real-time paper trading:
 *
 * 1. Check /api/bots endpoint for current balances
 * 2. Compare GP bots vs Backburner bots (shadow-4h-normal, shadow-5m-fade)
 * 3. Key metrics to compare:
 *    - Total P&L
 *    - Win rate
 *    - Number of trades (GP should have more)
 *    - Profit factor
 *
 * Expected outcomes based on backtests:
 * - gp-4h-normal should outperform shadow-4h-normal (more trades, similar edge)
 * - gp-5m-fade vs shadow-5m-fade: unclear, needs real data
 *
 * ============================================================================
 */

import { getExecutionCostsCalculator } from './execution-costs.js';
import type { BackburnerSetup, Timeframe, MarketType } from './types.js';

const costsCalculator = getExecutionCostsCalculator();

// Golden Pocket RSI Zones (Fibonacci levels)
const GP_LONG_LOWER = 23.6;
const GP_LONG_UPPER = 38.2;
const GP_SHORT_LOWER = 61.8;
const GP_SHORT_UPPER = 76.4;

export interface GpShadowBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;

  // Strategy settings
  allowedTimeframes: Timeframe[];
  fadeSignals: boolean;  // If true, take opposite of GP zone direction

  // GP Zone thresholds (can be customized)
  gpLongLower: number;
  gpLongUpper: number;
  gpShortLower: number;
  gpShortUpper: number;
}

export interface GpPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  gpZoneDirection: 'long' | 'short';  // What the GP zone indicated
  marketType: MarketType;
  timeframe: Timeframe;

  entryPrice: number;
  effectiveEntryPrice: number;
  entryTime: number;
  entryCosts: number;

  marginUsed: number;
  notionalSize: number;
  leverage: number;

  initialStopLossPrice: number;
  currentStopLossPrice: number;
  highWaterMark: number;
  lowWaterMark: number;
  trailLevel: number;

  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  status: 'open' | 'closed';

  exitPrice?: number;
  exitTime?: number;
  exitCosts?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  closeReason?: string;

  // Signal metadata for analysis
  signalRsi: number;
  signalState?: string;
}

const DEFAULT_CONFIG: GpShadowBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['4h'],
  fadeSignals: false,
  gpLongLower: GP_LONG_LOWER,
  gpLongUpper: GP_LONG_UPPER,
  gpShortLower: GP_SHORT_LOWER,
  gpShortUpper: GP_SHORT_UPPER,
};

export class GpShadowBot {
  private config: GpShadowBotConfig;
  private balance: number;
  private peakBalance: number;
  private positions: Map<string, GpPosition> = new Map();
  private closedPositions: GpPosition[] = [];
  private botId: string;

  constructor(config: Partial<GpShadowBotConfig> = {}, botId: string = 'gp-shadow') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
  }

  getBotId(): string {
    return this.botId;
  }

  getConfig(): GpShadowBotConfig {
    return { ...this.config };
  }

  getBalance(): number {
    return this.balance;
  }

  /**
   * Check if RSI is in a Golden Pocket zone
   * Returns 'long', 'short', or null
   */
  private getGpZone(rsi: number): 'long' | 'short' | null {
    if (rsi >= this.config.gpLongLower && rsi <= this.config.gpLongUpper) {
      return 'long';
    }
    if (rsi >= this.config.gpShortLower && rsi <= this.config.gpShortUpper) {
      return 'short';
    }
    return null;
  }

  /**
   * Process a setup from the screener
   *
   * Unlike Backburner bots which use the setup's direction,
   * GP bots determine direction purely from RSI zone.
   */
  openPosition(setup: BackburnerSetup): GpPosition | null {
    // Filter by timeframe
    if (!this.config.allowedTimeframes.includes(setup.timeframe)) {
      return null;
    }

    // Check if RSI is in a GP zone
    const gpZone = this.getGpZone(setup.currentRSI);
    if (!gpZone) {
      return null;  // RSI not in golden pocket zone
    }

    // Only enter on triggered or deep_extreme states
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Check if already have position for this symbol
    const positionKey = `${setup.symbol}-${setup.marketType}`;
    if (this.positions.has(positionKey)) {
      return null;
    }

    // Determine actual trade direction (fade if configured)
    const tradeDirection = this.config.fadeSignals
      ? (gpZone === 'long' ? 'short' : 'long')
      : gpZone;

    // Calculate position sizing
    const marginToUse = this.balance * (this.config.positionSizePercent / 100);
    const notionalSize = marginToUse * this.config.leverage;

    // Calculate entry with execution costs
    const { effectiveEntryPrice, entryCosts } = costsCalculator.calculateEntryCosts(
      setup.currentPrice,
      notionalSize,
      tradeDirection
    );

    // Calculate initial stop loss
    const stopDistance = effectiveEntryPrice * (this.config.initialStopLossPercent / 100);
    const initialStopLoss = tradeDirection === 'long'
      ? effectiveEntryPrice - stopDistance
      : effectiveEntryPrice + stopDistance;

    const position: GpPosition = {
      id: `${this.botId}-${Date.now()}-${setup.symbol}`,
      symbol: setup.symbol,
      direction: tradeDirection,
      gpZoneDirection: gpZone,
      marketType: setup.marketType,
      timeframe: setup.timeframe,

      entryPrice: setup.currentPrice,
      effectiveEntryPrice,
      entryTime: Date.now(),
      entryCosts,

      marginUsed: marginToUse,
      notionalSize,
      leverage: this.config.leverage,

      initialStopLossPrice: initialStopLoss,
      currentStopLossPrice: initialStopLoss,
      highWaterMark: effectiveEntryPrice,
      lowWaterMark: effectiveEntryPrice,
      trailLevel: 0,

      currentPrice: setup.currentPrice,
      unrealizedPnL: -entryCosts,
      unrealizedPnLPercent: (-entryCosts / marginToUse) * 100,
      status: 'open',

      signalRsi: setup.currentRSI,
      signalState: setup.state,
    };

    this.positions.set(positionKey, position);

    console.log(`[${this.botId}] Opened ${tradeDirection.toUpperCase()} ${setup.symbol} @ $${setup.currentPrice.toFixed(4)} | RSI: ${setup.currentRSI.toFixed(1)} (GP zone: ${gpZone}) | TF: ${setup.timeframe}`);

    return position;
  }

  /**
   * Update position with new price data
   */
  updatePosition(setup: BackburnerSetup): void {
    const positionKey = `${setup.symbol}-${setup.marketType}`;
    const position = this.positions.get(positionKey);

    if (!position || position.status !== 'open') {
      return;
    }

    this.updatePositionPrice(position, setup.currentPrice);
  }

  /**
   * Update all positions with current prices
   */
  async updateAllPositionPrices(
    getPrice: (symbol: string, marketType: MarketType) => Promise<number | null>
  ): Promise<void> {
    for (const [key, position] of this.positions) {
      if (position.status !== 'open') continue;

      const price = await getPrice(position.symbol, position.marketType);
      if (price && price > 0) {
        this.updatePositionPrice(position, price);
      }
    }
  }

  private updatePositionPrice(position: GpPosition, currentPrice: number): void {
    position.currentPrice = currentPrice;

    // Update water marks
    if (currentPrice > position.highWaterMark) {
      position.highWaterMark = currentPrice;
    }
    if (currentPrice < position.lowWaterMark) {
      position.lowWaterMark = currentPrice;
    }

    // Calculate unrealized P&L
    const priceMove = position.direction === 'long'
      ? currentPrice - position.effectiveEntryPrice
      : position.effectiveEntryPrice - currentPrice;

    const pnlPercent = (priceMove / position.effectiveEntryPrice) * 100;
    const leveragedPnLPercent = pnlPercent * position.leverage;

    position.unrealizedPnL = (position.marginUsed * leveragedPnLPercent / 100) - position.entryCosts;
    position.unrealizedPnLPercent = (position.unrealizedPnL / position.marginUsed) * 100;

    // Check trailing stop progression
    this.updateTrailingStop(position, leveragedPnLPercent);

    // Check if stop loss hit
    const stopHit = position.direction === 'long'
      ? currentPrice <= position.currentStopLossPrice
      : currentPrice >= position.currentStopLossPrice;

    if (stopHit) {
      this.closePosition(position, position.currentStopLossPrice, this.getCloseReason(position));
    }
  }

  private updateTrailingStop(position: GpPosition, leveragedPnLPercent: number): void {
    const { level1LockPercent, trailTriggerPercent, trailStepPercent } = this.config;

    // Level 1: Lock in breakeven
    if (position.trailLevel === 0 && leveragedPnLPercent >= level1LockPercent) {
      position.trailLevel = 1;
      position.currentStopLossPrice = position.effectiveEntryPrice;
      console.log(`[${this.botId}] ${position.symbol} Trail L1: Stop → breakeven`);
    }

    // Level 2+: Progressive trailing
    if (leveragedPnLPercent >= trailTriggerPercent) {
      const levelsAboveTrigger = Math.floor(
        (leveragedPnLPercent - trailTriggerPercent) / trailStepPercent
      );
      const newLevel = 2 + levelsAboveTrigger;

      if (newLevel > position.trailLevel) {
        position.trailLevel = newLevel;

        // Calculate new stop based on high/low water mark
        if (position.direction === 'long') {
          const trailDistance = position.highWaterMark * (trailStepPercent / 100);
          const newStop = position.highWaterMark - trailDistance;
          if (newStop > position.currentStopLossPrice) {
            position.currentStopLossPrice = newStop;
          }
        } else {
          const trailDistance = position.lowWaterMark * (trailStepPercent / 100);
          const newStop = position.lowWaterMark + trailDistance;
          if (newStop < position.currentStopLossPrice) {
            position.currentStopLossPrice = newStop;
          }
        }

        console.log(`[${this.botId}] ${position.symbol} Trail L${position.trailLevel}: Stop → $${position.currentStopLossPrice.toFixed(4)}`);
      }
    }
  }

  private getCloseReason(position: GpPosition): string {
    if (position.trailLevel === 0) return 'initial_stop';
    if (position.trailLevel === 1) return 'breakeven_stop';
    return 'trailing_stop';
  }

  private closePosition(position: GpPosition, exitPrice: number, reason: string): void {
    const positionKey = `${position.symbol}-${position.marketType}`;

    // Calculate exit costs
    const { effectiveExitPrice, exitCosts } = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction
    );

    // Calculate final P&L
    const priceMove = position.direction === 'long'
      ? effectiveExitPrice - position.effectiveEntryPrice
      : position.effectiveEntryPrice - effectiveExitPrice;

    const pnlPercent = (priceMove / position.effectiveEntryPrice) * 100;
    const leveragedPnLPercent = pnlPercent * position.leverage;
    const realizedPnL = (position.marginUsed * leveragedPnLPercent / 100) - position.entryCosts - exitCosts;

    // Update position
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitCosts = exitCosts;
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;
    position.closeReason = reason;

    // Update balance
    this.balance += realizedPnL;
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Move to closed positions
    this.positions.delete(positionKey);
    this.closedPositions.push(position);

    const pnlSign = realizedPnL >= 0 ? '+' : '';
    console.log(`[${this.botId}] Closed ${position.symbol} | ${pnlSign}$${realizedPnL.toFixed(2)} (${pnlSign}${position.realizedPnLPercent?.toFixed(1)}%) | ${reason} | Balance: $${this.balance.toFixed(2)}`);
  }

  /**
   * Handle setup removal (position played out)
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    const positionKey = `${setup.symbol}-${setup.marketType}`;
    const position = this.positions.get(positionKey);

    if (position && position.status === 'open') {
      // Close at current price when setup is removed
      this.closePosition(position, position.currentPrice, 'setup_removed');
    }
  }

  /**
   * Reset bot to initial state
   */
  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    console.log(`[${this.botId}] Reset to $${this.config.initialBalance}`);
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }

  /**
   * Get all open positions
   */
  getOpenPositions(): GpPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  /**
   * Get closed positions (most recent first)
   */
  getClosedPositions(limit?: number): GpPosition[] {
    const sorted = [...this.closedPositions].sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Get performance statistics
   */
  getStats(): {
    currentBalance: number;
    peakBalance: number;
    drawdown: number;
    totalPnL: number;
    openPositions: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
  } {
    const closed = this.closedPositions;
    const wins = closed.filter(p => (p.realizedPnL || 0) > 0);
    const losses = closed.filter(p => (p.realizedPnL || 0) <= 0);

    const grossProfit = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));

    return {
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      drawdown: ((this.peakBalance - this.balance) / this.peakBalance) * 100,
      totalPnL: this.balance - this.config.initialBalance,
      openPositions: this.positions.size,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    };
  }
}
