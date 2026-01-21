/**
 * Backburner Trend Flip Bot
 *
 * Strategy: Same as Trend Override, but when a position closes IN PROFIT,
 * it FLIPS to the opposite direction to catch the reversal.
 *
 * Logic:
 * 1. Enter opposite to backburner when BTC trend conflicts (same as TrendOverride)
 * 2. When position closes via trailing stop (profit), flip to opposite direction
 * 3. The flip catches the mean reversion that backburner originally signaled
 *
 * The hypothesis: Ride momentum until it exhausts, then catch the reversal.
 */

import { getExecutionCostsCalculator } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();
import type { BackburnerSetup, Timeframe } from './types.js';

interface TrendFlipConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;
  // Flip-specific config
  flipOnProfit: boolean;  // Whether to flip when closing in profit
  flipStopLossPercent: number;  // ROI stop loss for flipped positions
}

interface TrendFlipPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: 'spot' | 'futures';
  timeframe: Timeframe;

  // Position origin tracking
  isFlipped: boolean;  // Whether this is a flipped position
  flipCount: number;   // How many times we've flipped (0 = original)
  originalSetupDirection: 'long' | 'short';
  btcBiasAtEntry: string;

  // Entry details
  entryPrice: number;
  effectiveEntryPrice: number;
  entryTime: number;
  entryCosts: number;

  // Position sizing
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Stop loss tracking
  initialStopLossPrice: number;
  currentStopLossPrice: number;
  highWaterMark: number;
  trailLevel: number;

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  status: 'open' | 'closed';

  // Exit details
  exitPrice?: number;
  exitTime?: number;
  exitCosts?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  closeReason?: string;
  fundingPaid?: number;
  totalCosts?: number;
}

export class TrendFlipBot {
  private config: TrendFlipConfig;
  private balance: number;
  private positions: Map<string, TrendFlipPosition> = new Map();
  private closedPositions: TrendFlipPosition[] = [];
  private peakBalance: number;
  private botName: string;

  private processedSetups: Set<string> = new Set();

  // Pending flips - positions waiting to be created after a profitable close
  private pendingFlips: Array<{
    symbol: string;
    direction: 'long' | 'short';
    marketType: 'spot' | 'futures';
    timeframe: Timeframe;
    originalSetupDirection: 'long' | 'short';
    flipCount: number;
    triggerPrice: number;  // Price at which the flip was triggered
  }> = [];

  constructor(config: TrendFlipConfig, name: string = 'trend_flip') {
    this.config = config;
    this.balance = config.initialBalance;
    this.peakBalance = config.initialBalance;
    this.botName = name;
  }

  /**
   * Check if a setup qualifies for trend override
   */
  private shouldOverride(
    setup: BackburnerSetup,
    btcBias: string,
    activeTimeframes: Timeframe[]
  ): 'long' | 'short' | null {
    if (activeTimeframes.length > 1) {
      return null;
    }

    const setupDirection = setup.direction;

    if (setupDirection === 'long') {
      if (btcBias === 'short' || btcBias === 'strong_short') {
        return 'short';
      }
    } else if (setupDirection === 'short') {
      if (btcBias === 'long' || btcBias === 'strong_long') {
        return 'long';
      }
    }

    return null;
  }

  /**
   * Process a new setup
   */
  processSetup(
    setup: BackburnerSetup,
    btcBias: string,
    activeTimeframes: Timeframe[],
    currentPrice: number
  ): TrendFlipPosition | null {
    const setupKey = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;

    if (this.processedSetups.has(setupKey)) {
      return null;
    }

    const overrideDirection = this.shouldOverride(setup, btcBias, activeTimeframes);
    if (!overrideDirection) {
      return null;
    }

    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    const existingKey = `flip-${setup.symbol}-${setup.timeframe}-${setup.marketType}`;
    if (this.positions.has(existingKey)) {
      return null;
    }

    this.processedSetups.add(setupKey);

    return this.openPosition(
      setup.symbol,
      overrideDirection,
      setup.marketType,
      setup.timeframe,
      currentPrice,
      setup.direction,
      btcBias,
      false,  // not flipped
      0       // flip count
    );
  }

  /**
   * Open a new position (either original or flipped)
   */
  private openPosition(
    symbol: string,
    direction: 'long' | 'short',
    marketType: 'spot' | 'futures',
    timeframe: Timeframe,
    currentPrice: number,
    originalSetupDirection: 'long' | 'short',
    btcBias: string,
    isFlipped: boolean,
    flipCount: number
  ): TrendFlipPosition | null {
    const availableBalance = this.balance;
    const positionMargin = availableBalance * (this.config.positionSizePercent / 100);

    if (positionMargin < 1) {
      return null;
    }

    const notionalSize = positionMargin * this.config.leverage;

    const { effectiveEntryPrice, entryCosts } = costsCalculator.calculateEntryCosts(
      currentPrice,
      notionalSize,
      direction,
      'normal'
    );

    // Use different stop loss for flipped positions
    const stopLossPercent = isFlipped
      ? this.config.flipStopLossPercent
      : this.config.initialStopLossPercent;
    const initialStopLossPrice = this.calculateStopLoss(effectiveEntryPrice, direction, stopLossPercent);

    this.balance -= positionMargin;

    const positionKey = `flip-${symbol}-${timeframe}-${marketType}`;
    const position: TrendFlipPosition = {
      id: positionKey + '-' + Date.now(),
      symbol,
      direction,
      marketType,
      timeframe,

      isFlipped,
      flipCount,
      originalSetupDirection,
      btcBiasAtEntry: btcBias,

      entryPrice: currentPrice,
      effectiveEntryPrice,
      entryTime: Date.now(),
      entryCosts,

      marginUsed: positionMargin,
      notionalSize,
      leverage: this.config.leverage,

      initialStopLossPrice,
      currentStopLossPrice: initialStopLossPrice,
      highWaterMark: 0,
      trailLevel: 0,

      currentPrice,
      unrealizedPnL: -entryCosts,
      unrealizedPnLPercent: (-entryCosts / positionMargin) * 100,
      status: 'open',
    };

    this.positions.set(positionKey, position);

    const timestamp = new Date().toLocaleTimeString();
    const flipInfo = isFlipped ? ` [FLIP #${flipCount}]` : '';
    console.log(`[TREND-FLIP:${this.botName} ${timestamp}] OPENED ${direction.toUpperCase()} ${symbol}${flipInfo} @ ${currentPrice.toPrecision(5)} | Margin: $${positionMargin.toFixed(2)}`);

    return position;
  }

  /**
   * Calculate stop loss price
   */
  private calculateStopLoss(entryPrice: number, direction: 'long' | 'short', roiStopPercent: number): number {
    const pricePercent = roiStopPercent / 100 / this.config.leverage;

    if (direction === 'long') {
      return entryPrice * (1 - pricePercent);
    } else {
      return entryPrice * (1 + pricePercent);
    }
  }

  /**
   * Update all open positions
   */
  async updatePositions(
    getCurrentPrice: (symbol: string) => Promise<number | null>,
    btcBias: string,
    onPositionClosed?: (position: TrendFlipPosition, wasProfit: boolean) => void
  ): Promise<TrendFlipPosition[]> {
    const newPositions: TrendFlipPosition[] = [];

    // First, process any pending flips
    for (const flip of this.pendingFlips) {
      const currentPrice = await getCurrentPrice(flip.symbol);
      if (currentPrice === null) continue;

      const newPos = this.openPosition(
        flip.symbol,
        flip.direction,
        flip.marketType,
        flip.timeframe,
        currentPrice,
        flip.originalSetupDirection,
        btcBias,
        true,
        flip.flipCount
      );

      if (newPos) {
        newPositions.push(newPos);
      }
    }
    this.pendingFlips = [];

    // Update existing positions
    for (const [key, position] of this.positions) {
      const currentPrice = await getCurrentPrice(position.symbol);
      if (currentPrice === null) continue;

      position.currentPrice = currentPrice;

      // Calculate unrealized PnL
      const priceDiff = position.direction === 'long'
        ? currentPrice - position.effectiveEntryPrice
        : position.effectiveEntryPrice - currentPrice;

      const rawPnL = (priceDiff / position.effectiveEntryPrice) * position.notionalSize;
      position.unrealizedPnL = rawPnL - position.entryCosts;
      position.unrealizedPnLPercent = (position.unrealizedPnL / position.marginUsed) * 100;

      if (position.unrealizedPnLPercent > position.highWaterMark) {
        position.highWaterMark = position.unrealizedPnLPercent;
      }

      // Check stop loss
      const hitStopLoss = position.direction === 'long'
        ? currentPrice <= position.currentStopLossPrice
        : currentPrice >= position.currentStopLossPrice;

      if (hitStopLoss) {
        const wasProfit = position.trailLevel > 0;
        const reason = wasProfit ? `Trail L${position.trailLevel} hit` : 'Stop loss hit';

        this.closePosition(key, currentPrice, reason, wasProfit);
        onPositionClosed?.(position, wasProfit);
        continue;
      }

      // Update trailing stop
      this.updateTrailingStop(position);
    }

    return newPositions;
  }

  /**
   * Update trailing stop
   */
  private updateTrailingStop(position: TrendFlipPosition): void {
    const roiPercent = position.unrealizedPnLPercent;
    const triggerPercent = this.config.trailTriggerPercent;
    const stepPercent = this.config.trailStepPercent;

    let newTrailLevel = 0;
    if (roiPercent >= triggerPercent) {
      newTrailLevel = 1;
      let nextLevelThreshold = triggerPercent + stepPercent;
      while (roiPercent >= nextLevelThreshold) {
        newTrailLevel++;
        nextLevelThreshold += stepPercent;
      }
    }

    if (newTrailLevel > position.trailLevel) {
      position.trailLevel = newTrailLevel;

      const lockPercent = position.trailLevel === 1
        ? this.config.level1LockPercent
        : (position.trailLevel - 1) * stepPercent;

      const lockPricePercent = lockPercent / 100 / this.config.leverage;

      if (position.direction === 'long') {
        position.currentStopLossPrice = position.effectiveEntryPrice * (1 + lockPricePercent);
      } else {
        position.currentStopLossPrice = position.effectiveEntryPrice * (1 - lockPricePercent);
      }
    }
  }

  /**
   * Close a position
   */
  private closePosition(key: string, exitPrice: number, reason: string, wasProfit: boolean): void {
    const position = this.positions.get(key);
    if (!position) return;

    const { exitCosts } = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction,
      'normal'
    );

    const priceDiff = position.direction === 'long'
      ? exitPrice - position.effectiveEntryPrice
      : position.effectiveEntryPrice - exitPrice;

    const rawPnL = (priceDiff / position.effectiveEntryPrice) * position.notionalSize;
    const totalCosts = position.entryCosts + exitCosts;
    const realizedPnL = rawPnL - totalCosts;

    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitCosts = exitCosts;
    position.fundingPaid = 0;  // TODO: calculate funding if needed
    position.totalCosts = totalCosts;
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;
    position.closeReason = reason;

    this.balance += position.marginUsed + realizedPnL;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    this.closedPositions.unshift(position);
    this.positions.delete(key);

    const timestamp = new Date().toLocaleTimeString();
    const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
    const flipInfo = position.isFlipped ? ` [FLIP #${position.flipCount}]` : '';
    console.log(`[TREND-FLIP:${this.botName} ${timestamp}] CLOSED ${position.direction.toUpperCase()} ${position.symbol}${flipInfo} | ${pnlStr} (${position.realizedPnLPercent?.toFixed(1)}% ROI) | ${reason}`);

    // If closed in profit and flip is enabled, queue a flip
    if (this.config.flipOnProfit && wasProfit && realizedPnL > 0) {
      const flipDirection = position.direction === 'long' ? 'short' : 'long';

      this.pendingFlips.push({
        symbol: position.symbol,
        direction: flipDirection,
        marketType: position.marketType,
        timeframe: position.timeframe,
        originalSetupDirection: position.originalSetupDirection,
        flipCount: position.flipCount + 1,
        triggerPrice: exitPrice,
      });

      console.log(`[TREND-FLIP:${this.botName} ${timestamp}] QUEUED FLIP to ${flipDirection.toUpperCase()} for ${position.symbol}`);
    }
  }

  /**
   * Handle setup state changes
   */
  onSetupStateChange(setup: BackburnerSetup, newState: string): void {
    // Don't exit on played_out - trailing stop handles exits
  }

  getOpenPositions(): TrendFlipPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(limit: number = 50): TrendFlipPosition[] {
    return this.closedPositions.slice(0, limit);
  }

  getBalance(): number {
    return this.balance;
  }

  getUnrealizedPnL(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.unrealizedPnL;
    }
    return total;
  }

  getPendingFlips(): number {
    return this.pendingFlips.length;
  }

  getStats() {
    const totalTrades = this.closedPositions.length;
    const winningTrades = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0).length;
    const losingTrades = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0).length;

    const totalPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalPnLPercent = (totalPnL / this.config.initialBalance) * 100;

    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);

    const largestWin = wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnL || 0)) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(p => p.realizedPnL || 0)) : 0;

    const averageWin = wins.length > 0 ? wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0) / wins.length : 0;
    const averageLoss = losses.length > 0 ? losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0) / losses.length : 0;

    const grossProfit = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const maxDrawdown = this.peakBalance - Math.min(this.balance, ...this.closedPositions.map((_, i) => {
      const balanceAtPoint = this.config.initialBalance + this.closedPositions.slice(i).reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
      return balanceAtPoint;
    }));

    const avgTrailLevel = totalTrades > 0
      ? this.closedPositions.reduce((sum, p) => sum + (p.trailLevel || 0), 0) / totalTrades
      : 0;

    // Flip-specific stats
    const flippedTrades = this.closedPositions.filter(p => p.isFlipped);
    const flippedWins = flippedTrades.filter(p => (p.realizedPnL || 0) > 0).length;
    const flippedPnL = flippedTrades.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    // Cost tracking
    const totalFeesPaid = this.closedPositions.reduce((sum, p) => sum + (p.entryCosts || 0) + (p.exitCosts || 0), 0);
    const totalFundingPaid = this.closedPositions.reduce((sum, p) => sum + (p.fundingPaid || 0), 0);
    const totalExecutionCosts = this.closedPositions.reduce((sum, p) => sum + (p.totalCosts || 0), 0);

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      totalPnL,
      totalPnLPercent,
      largestWin,
      largestLoss,
      averageWin,
      averageLoss,
      profitFactor,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      maxDrawdown,
      maxDrawdownPercent: this.peakBalance > 0 ? (maxDrawdown / this.peakBalance) * 100 : 0,
      avgTrailLevel,
      // Flip stats
      flippedTrades: flippedTrades.length,
      flippedWinRate: flippedTrades.length > 0 ? (flippedWins / flippedTrades.length) * 100 : 0,
      flippedPnL,
      // Costs
      totalFeesPaid,
      totalFundingPaid,
      totalExecutionCosts,
      costsAsPercentOfPnL: totalPnL !== 0 ? (totalExecutionCosts / Math.abs(totalPnL)) * 100 : 0,
      avgCostPerTrade: totalTrades > 0 ? totalExecutionCosts / totalTrades : 0,
    };
  }

  getConfig() {
    return { ...this.config };
  }

  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    this.processedSetups.clear();
    this.pendingFlips = [];
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }

  async updateOrphanedPositions(
    getCurrentPrice: (symbol: string) => Promise<number | null>,
    btcBias: string = 'neutral'
  ): Promise<void> {
    await this.updatePositions(getCurrentPrice, btcBias);
  }
}
