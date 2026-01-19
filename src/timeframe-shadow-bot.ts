/**
 * Timeframe Shadow Bot - A/B Testing Different Timeframe Strategies
 *
 * Based on backtest findings:
 * - 5m: Fade strategy works (RSI signals appear backwards)
 * - 4H: Normal strategy works (RSI signals are reliable)
 *
 * This bot tracks paper trades for specific timeframe/direction combinations
 * to validate backtest findings with real market data.
 */

import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';
import type { BackburnerSetup, Timeframe, MarketType } from './types.js';

const costsCalculator = getExecutionCostsCalculator();

export interface TimeframeShadowBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;

  // Timeframe-specific settings
  allowedTimeframes: Timeframe[];   // Only trade these timeframes
  fadeSignals: boolean;              // If true, take opposite direction
}

export interface ShadowPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  originalSignalDirection: 'long' | 'short';
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

  // Signal metadata
  signalRsi?: number;
  signalState?: string;
}

const DEFAULT_CONFIG: TimeframeShadowBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['5m'],
  fadeSignals: false,
};

export class TimeframeShadowBot {
  private config: TimeframeShadowBotConfig;
  private balance: number;
  private peakBalance: number;
  private positions: Map<string, ShadowPosition> = new Map();
  private closedPositions: ShadowPosition[] = [];
  private botId: string;

  constructor(config: Partial<TimeframeShadowBotConfig> = {}, botId: string = 'tf-shadow') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
  }

  getBotId(): string {
    return this.botId;
  }

  getConfig(): TimeframeShadowBotConfig {
    return { ...this.config };
  }

  getBalance(): number {
    return this.balance;
  }

  private getPositionKey(setup: BackburnerSetup): string {
    // Include fade indicator in key to allow both fade and normal positions for same setup
    const fadeIndicator = this.config.fadeSignals ? 'fade' : 'normal';
    return `${setup.symbol}-${setup.timeframe}-${fadeIndicator}-${setup.marketType}`;
  }

  private generatePositionId(setup: BackburnerSetup): string {
    const fadeIndicator = this.config.fadeSignals ? 'fade' : 'normal';
    return `${this.botId}-${setup.symbol}-${setup.timeframe}-${fadeIndicator}-${Date.now()}`;
  }

  /**
   * Check if setup matches this bot's timeframe filter
   */
  private matchesTimeframe(setup: BackburnerSetup): boolean {
    return this.config.allowedTimeframes.includes(setup.timeframe);
  }

  /**
   * Open a position on a setup
   * - Respects timeframe filter
   * - Optionally fades the signal direction
   */
  openPosition(setup: BackburnerSetup): ShadowPosition | null {
    // Only trade triggered or deep_extreme signals
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only futures
    if (setup.marketType !== 'futures') {
      return null;
    }

    // Timeframe filter
    if (!this.matchesTimeframe(setup)) {
      return null;
    }

    const key = this.getPositionKey(setup);

    // No duplicate positions
    if (this.positions.has(key)) {
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Calculate position size
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;

    if (margin > this.balance) {
      return null;
    }

    // Determine direction: fade or follow the signal
    const direction = this.config.fadeSignals
      ? (setup.direction === 'long' ? 'short' : 'long')
      : setup.direction;

    const entryPrice = setup.currentPrice;
    const volatility = determineVolatility(setup.currentRSI);
    const costs = costsCalculator.calculateEntryCosts(
      entryPrice,
      notional,
      direction,
      volatility
    );

    const effectiveEntryPrice = costs.effectiveEntryPrice;

    // Calculate initial stop loss
    const stopLossMultiplier = direction === 'long'
      ? (1 - this.config.initialStopLossPercent / 100)
      : (1 + this.config.initialStopLossPercent / 100);
    const initialStopLossPrice = effectiveEntryPrice * stopLossMultiplier;

    const position: ShadowPosition = {
      id: this.generatePositionId(setup),
      symbol: setup.symbol,
      direction,
      originalSignalDirection: setup.direction,
      marketType: setup.marketType,
      timeframe: setup.timeframe,

      entryPrice,
      effectiveEntryPrice,
      entryTime: Date.now(),
      entryCosts: costs.entryCosts,

      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,

      initialStopLossPrice,
      currentStopLossPrice: initialStopLossPrice,
      highWaterMark: 0,
      trailLevel: 0,

      currentPrice: entryPrice,
      unrealizedPnL: -costs.entryCosts,
      unrealizedPnLPercent: (-costs.entryCosts / margin) * 100,
      status: 'open',

      signalRsi: setup.currentRSI,
      signalState: setup.state,
    };

    this.balance -= margin;
    this.positions.set(key, position);

    const fadeLabel = this.config.fadeSignals ? `FADE (signal: ${setup.direction})` : 'NORMAL';
    console.log(`[${this.botId}] OPENED ${direction.toUpperCase()} ${setup.symbol} ${setup.timeframe} | ${fadeLabel} @ ${entryPrice.toFixed(6)}`);

    // Note: Trade logging handled by data-persistence module automatically

    return position;
  }

  /**
   * Update position with new price - for when a setup updates
   */
  updatePosition(setup: BackburnerSetup): ShadowPosition | null {
    if (!this.matchesTimeframe(setup)) {
      return null;
    }

    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position || position.status === 'closed') {
      return null;
    }

    return this.updatePositionPrice(position, setup.currentPrice, key);
  }

  /**
   * Update all positions with current prices from price map
   */
  async updateAllPositionPrices(getPrice: (symbol: string, marketType: MarketType) => Promise<number | null>): Promise<{ closed: ShadowPosition[], updated: ShadowPosition[] }> {
    const closed: ShadowPosition[] = [];
    const updated: ShadowPosition[] = [];

    for (const [key, position] of this.positions) {
      const currentPrice = await getPrice(position.symbol, position.marketType);
      if (!currentPrice) continue;

      const result = this.updatePositionPrice(position, currentPrice, key);
      if (result) {
        if (result.status === 'closed') {
          closed.push(result);
        } else {
          updated.push(result);
        }
      }
    }

    return { closed, updated };
  }

  private updatePositionPrice(position: ShadowPosition, currentPrice: number, key: string): ShadowPosition | null {
    position.currentPrice = currentPrice;

    // Calculate unrealized PnL
    const priceChange = position.direction === 'long'
      ? (currentPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
      : (position.effectiveEntryPrice - currentPrice) / position.effectiveEntryPrice;

    const grossPnL = priceChange * position.notionalSize;
    position.unrealizedPnL = grossPnL - position.entryCosts;
    position.unrealizedPnLPercent = (position.unrealizedPnL / position.marginUsed) * 100;

    // Update high water mark
    if (position.unrealizedPnLPercent > position.highWaterMark) {
      position.highWaterMark = position.unrealizedPnLPercent;
    }

    // Check trailing stop logic
    this.updateTrailingStop(position);

    // Check if stop hit
    const stopHit = position.direction === 'long'
      ? currentPrice <= position.currentStopLossPrice
      : currentPrice >= position.currentStopLossPrice;

    if (stopHit) {
      this.closePosition(key, position, currentPrice);
    }

    return position;
  }

  private updateTrailingStop(position: ShadowPosition): void {
    const roiPercent = position.unrealizedPnLPercent;

    // Level 0: Not yet triggered
    if (position.trailLevel === 0) {
      if (roiPercent >= this.config.trailTriggerPercent) {
        // Activate trailing at level 1
        position.trailLevel = 1;
        const lockPercent = this.config.level1LockPercent;
        const lockPrice = position.direction === 'long'
          ? position.effectiveEntryPrice * (1 + lockPercent / 100)
          : position.effectiveEntryPrice * (1 - lockPercent / 100);
        position.currentStopLossPrice = lockPrice;
        console.log(`[${this.botId}] ${position.symbol} trail L1 activated @ ROI ${roiPercent.toFixed(1)}%`);
      }
      return;
    }

    // Higher levels
    const nextLevel = position.trailLevel + 1;
    const nextLevelTrigger = this.config.trailTriggerPercent + (position.trailLevel * this.config.trailStepPercent);

    if (roiPercent >= nextLevelTrigger) {
      position.trailLevel = nextLevel;
      const lockPercent = this.config.level1LockPercent + ((nextLevel - 1) * this.config.trailStepPercent);
      const lockPrice = position.direction === 'long'
        ? position.effectiveEntryPrice * (1 + lockPercent / 100)
        : position.effectiveEntryPrice * (1 - lockPercent / 100);
      position.currentStopLossPrice = lockPrice;
      console.log(`[${this.botId}] ${position.symbol} trail L${nextLevel} @ ROI ${roiPercent.toFixed(1)}%`);
    }
  }

  private closePosition(key: string, position: ShadowPosition, exitPrice: number): void {
    const costs = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction,
      'normal'
    );

    const effectiveExitPrice = costs.effectiveExitPrice;

    const priceChange = position.direction === 'long'
      ? (effectiveExitPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
      : (position.effectiveEntryPrice - effectiveExitPrice) / position.effectiveEntryPrice;

    const grossPnL = priceChange * position.notionalSize;
    const totalCosts = position.entryCosts + costs.exitCosts;
    const realizedPnL = grossPnL - totalCosts;
    const realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;

    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitCosts = costs.exitCosts;
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = realizedPnLPercent;
    position.status = 'closed';

    let closeReason = 'initial_stop';
    if (position.trailLevel > 0) {
      closeReason = `trail_L${position.trailLevel}`;
    }
    position.closeReason = closeReason;

    this.balance += position.marginUsed + realizedPnL;
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    this.positions.delete(key);
    this.closedPositions.push(position);

    const emoji = realizedPnL >= 0 ? '✅' : '❌';
    const fadeLabel = this.config.fadeSignals ? '[FADE]' : '[NORMAL]';
    console.log(`[${this.botId}] ${emoji} CLOSED ${position.direction.toUpperCase()} ${position.symbol} ${position.timeframe} ${fadeLabel} | PnL: $${realizedPnL.toFixed(2)} (${realizedPnLPercent.toFixed(1)}%) | ${closeReason}`);

    // Note: Trade logging handled by data-persistence module automatically
  }

  /**
   * Handle setup removal - close position at current price
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    if (!this.matchesTimeframe(setup)) {
      return;
    }

    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (position) {
      this.closePosition(key, position, position.currentPrice);
    }
  }

  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => (p.realizedPnL || 0) > 0);
    const losses = closed.filter(p => (p.realizedPnL || 0) <= 0);
    const totalPnL = closed.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    // Calculate max drawdown
    let maxDrawdown = 0;
    let runningBalance = this.config.initialBalance;
    let peak = this.config.initialBalance;
    for (const p of closed) {
      runningBalance += p.realizedPnL || 0;
      if (runningBalance > peak) peak = runningBalance;
      const drawdown = peak - runningBalance;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Stats by timeframe
    const byTimeframe: Record<string, { count: number; pnl: number; wins: number }> = {};
    for (const p of closed) {
      if (!byTimeframe[p.timeframe]) {
        byTimeframe[p.timeframe] = { count: 0, pnl: 0, wins: 0 };
      }
      byTimeframe[p.timeframe].count++;
      byTimeframe[p.timeframe].pnl += p.realizedPnL || 0;
      if ((p.realizedPnL || 0) > 0) byTimeframe[p.timeframe].wins++;
    }

    return {
      botId: this.botId,
      fadeMode: this.config.fadeSignals,
      allowedTimeframes: this.config.allowedTimeframes,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      totalPnL,
      maxDrawdown,
      maxDrawdownPercent: (maxDrawdown / this.config.initialBalance) * 100,
      openPositions: this.positions.size,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, p) => s + (p.realizedPnL || 0), 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0) / losses.length) : 0,
      profitFactor: Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0)) > 0
        ? wins.reduce((s, p) => s + (p.realizedPnL || 0), 0) / Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0))
        : wins.length > 0 ? Infinity : 0,
      byTimeframe,
    };
  }

  getOpenPositions(): ShadowPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): ShadowPosition[] {
    return this.closedPositions;
  }

  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    console.log(`[${this.botId}] Reset to $${this.balance}`);
  }
}
