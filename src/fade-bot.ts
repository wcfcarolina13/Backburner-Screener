/**
 * Fade Bot - Contrarian Strategy
 *
 * Hypothesis: RSI signals might be backwards. When RSI says "oversold, go long",
 * price often continues dumping. This bot takes the OPPOSITE direction.
 *
 * Logic:
 * - Setup says LONG (RSI oversold) → We go SHORT
 * - Setup says SHORT (RSI overbought) → We go LONG
 *
 * Uses trailing stops to let winners run, same as other bots.
 */

import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';
import type { BackburnerSetup, Timeframe } from './types.js';

const costsCalculator = getExecutionCostsCalculator();

interface FadeBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;
}

interface FadePosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  originalSignalDirection: 'long' | 'short';  // What backburner said (we do opposite)
  marketType: 'spot' | 'futures';
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
}

const DEFAULT_CONFIG: FadeBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 5,  // Conservative leverage
  initialStopLossPercent: 12,
  trailTriggerPercent: 8,
  trailStepPercent: 6,
  level1LockPercent: 2,
  maxOpenPositions: 10,
};

export class FadeBot {
  private config: FadeBotConfig;
  private balance: number;
  private positions: Map<string, FadePosition> = new Map();
  private closedPositions: FadePosition[] = [];
  private botId: string;

  constructor(config: Partial<FadeBotConfig> = {}, botId: string = 'fade') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.botId = botId;
  }

  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-fade-${setup.marketType}`;
  }

  private generatePositionId(setup: BackburnerSetup): string {
    return `fade-${setup.symbol}-${setup.timeframe}-${Date.now()}`;
  }

  /**
   * Open a FADE position - opposite direction of the signal
   */
  openPosition(setup: BackburnerSetup): FadePosition | null {
    // Only trade triggered or deep_extreme signals
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only futures
    if (setup.marketType !== 'futures') {
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

    // FADE: Take OPPOSITE direction
    const fadeDirection = setup.direction === 'long' ? 'short' : 'long';

    const entryPrice = setup.currentPrice;
    const volatility = determineVolatility(setup.currentRSI);
    const costs = costsCalculator.calculateEntryCosts(
      entryPrice,
      notional,
      fadeDirection,
      volatility
    );

    // Use the effective entry price from costs calculator (already includes slippage)
    const effectiveEntryPrice = costs.effectiveEntryPrice;

    // Calculate initial stop loss
    const stopLossMultiplier = fadeDirection === 'long'
      ? (1 - this.config.initialStopLossPercent / 100)
      : (1 + this.config.initialStopLossPercent / 100);
    const initialStopLossPrice = effectiveEntryPrice * stopLossMultiplier;

    const position: FadePosition = {
      id: this.generatePositionId(setup),
      symbol: setup.symbol,
      direction: fadeDirection,
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
    };

    this.balance -= margin;
    this.positions.set(key, position);

    console.log(`[FADE:${this.botId}] OPENED ${fadeDirection.toUpperCase()} ${setup.symbol} (signal was ${setup.direction}) @ ${entryPrice.toFixed(6)}`);

    return position;
  }

  /**
   * Update all open positions with current prices
   */
  updatePositions(prices: Map<string, number>): { closed: FadePosition[], updated: FadePosition[] } {
    const closed: FadePosition[] = [];
    const updated: FadePosition[] = [];

    for (const [key, position] of this.positions) {
      const currentPrice = prices.get(position.symbol);
      if (!currentPrice) continue;

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
        closed.push(position);
      } else {
        updated.push(position);
      }
    }

    return { closed, updated };
  }

  private updateTrailingStop(position: FadePosition): void {
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
    }
  }

  private closePosition(key: string, position: FadePosition, exitPrice: number): void {
    const costs = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction,
      'normal'
    );

    // Use the effective exit price from costs calculator (already includes slippage)
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
      closeReason = `Trailing Stop Hit (Level ${position.trailLevel})`;
    }
    position.closeReason = closeReason;

    this.balance += position.marginUsed + realizedPnL;
    this.positions.delete(key);
    this.closedPositions.push(position);

    const emoji = realizedPnL >= 0 ? '✅' : '❌';
    console.log(`[FADE:${this.botId}] ${emoji} CLOSED ${position.direction.toUpperCase()} ${position.symbol} | PnL: $${realizedPnL.toFixed(2)} (${realizedPnLPercent.toFixed(1)}%) | ${closeReason}`);
  }

  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => (p.realizedPnL || 0) > 0);
    const losses = closed.filter(p => (p.realizedPnL || 0) <= 0);
    const totalPnL = closed.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    return {
      botId: this.botId,
      currentBalance: this.balance,
      totalPnL,
      openPositions: this.positions.size,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, p) => s + (p.realizedPnL || 0), 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, p) => s + (p.realizedPnL || 0), 0) / losses.length : 0,
    };
  }

  getOpenPositions(): FadePosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): FadePosition[] {
    return this.closedPositions;
  }

  reset(): void {
    this.balance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }
}
