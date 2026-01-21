/**
 * Backburner Trend Override Bot
 *
 * Strategy: When a single-timeframe backburner signal CONFLICTS with BTC macro trend,
 * take the OPPOSITE direction (trade WITH the trend instead of against it).
 *
 * Logic:
 * - 5m RSI oversold (normally LONG) + BTC FAVOR_LONGS/STRONG_LONG → SHORT instead
 * - 5m RSI overbought (normally SHORT) + BTC FAVOR_SHORTS/STRONG_SHORT → LONG instead
 *
 * The hypothesis: In strong trends, mean-reversion bounces are weak and get faded.
 * Better to ride the trend than fight it.
 */

import { getExecutionCostsCalculator, type TradeCosts } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();
import type { BackburnerSetup, Timeframe } from './types.js';

interface TrendOverrideConfig {
  initialBalance: number;
  positionSizePercent: number;  // % of balance per trade
  leverage: number;
  initialStopLossPercent: number;  // ROI-based stop loss
  trailTriggerPercent: number;     // ROI % to activate trailing
  trailStepPercent: number;        // ROI % between trail levels
  level1LockPercent: number;       // ROI % to lock at level 1 (0 = breakeven)
  maxOpenPositions: number;
}

interface TrendOverridePosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: 'spot' | 'futures';
  timeframe: Timeframe;

  // Original setup info
  originalSetupDirection: 'long' | 'short';  // What backburner would have done
  btcBiasAtEntry: string;  // BTC bias when we entered

  // Entry details
  entryPrice: number;
  effectiveEntryPrice: number;  // After slippage
  entryTime: number;
  entryCosts: number;

  // Position sizing
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Stop loss tracking
  initialStopLossPrice: number;
  currentStopLossPrice: number;
  highWaterMark: number;  // Best unrealized PnL seen
  trailLevel: number;     // 0 = not trailing, 1+ = trail levels

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  status: 'open' | 'closed';

  // Exit details (when closed)
  exitPrice?: number;
  exitTime?: number;
  exitCosts?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  closeReason?: string;
  fundingPaid?: number;
  totalCosts?: number;
}

export class TrendOverrideBot {
  private config: TrendOverrideConfig;
  private balance: number;
  private positions: Map<string, TrendOverridePosition> = new Map();
  private closedPositions: TrendOverridePosition[] = [];
  private peakBalance: number;
  private botName: string;

  // Track which setups we've already acted on
  private processedSetups: Set<string> = new Set();

  constructor(config: TrendOverrideConfig, name: string = 'trend_override') {
    this.config = config;
    this.balance = config.initialBalance;
    this.peakBalance = config.initialBalance;
    this.botName = name;
  }

  /**
   * Check if a setup qualifies for trend override
   * Returns the direction to trade if it qualifies, null otherwise
   */
  private shouldOverride(
    setup: BackburnerSetup,
    btcBias: string,
    activeTimeframes: Timeframe[]
  ): 'long' | 'short' | null {
    // Only single-timeframe setups qualify
    if (activeTimeframes.length > 1) {
      return null;
    }

    const setupDirection = setup.direction;

    // Check for conflict with BTC trend
    if (setupDirection === 'long') {
      // Backburner says LONG (oversold bounce expected)
      // If BTC is bearish, override to SHORT (ride the downtrend)
      if (btcBias === 'short' || btcBias === 'strong_short') {
        return 'short';
      }
    } else if (setupDirection === 'short') {
      // Backburner says SHORT (overbought pullback expected)
      // If BTC is bullish, override to LONG (ride the uptrend)
      if (btcBias === 'long' || btcBias === 'strong_long') {
        return 'long';
      }
    }

    return null;
  }

  /**
   * Process a new setup - check if we should take a trend override position
   */
  processSetup(
    setup: BackburnerSetup,
    btcBias: string,
    activeTimeframes: Timeframe[],
    currentPrice: number
  ): TrendOverridePosition | null {
    // Create unique key for this setup
    const setupKey = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;

    // Skip if already processed
    if (this.processedSetups.has(setupKey)) {
      return null;
    }

    // Check if setup qualifies for override
    const overrideDirection = this.shouldOverride(setup, btcBias, activeTimeframes);
    if (!overrideDirection) {
      return null;
    }

    // Check position limits
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Check if we already have a position for this symbol
    const existingKey = `override-${setup.symbol}-${setup.timeframe}-${overrideDirection}-${setup.marketType}`;
    if (this.positions.has(existingKey)) {
      return null;
    }

    // Calculate position size
    const availableBalance = this.balance;
    const positionMargin = availableBalance * (this.config.positionSizePercent / 100);

    if (positionMargin < 1) {
      return null;  // Too small
    }

    const notionalSize = positionMargin * this.config.leverage;

    // Calculate execution costs
    const { effectiveEntryPrice, entryCosts } = costsCalculator.calculateEntryCosts(
      currentPrice,
      notionalSize,
      overrideDirection,
      'normal'
    );

    // Calculate initial stop loss (ROI-based)
    const initialStopLossPrice = this.calculateInitialStopLoss(effectiveEntryPrice, overrideDirection);

    // Mark setup as processed
    this.processedSetups.add(setupKey);

    // Deduct margin from balance
    this.balance -= positionMargin;

    // Create position
    const position: TrendOverridePosition = {
      id: existingKey + '-' + Date.now(),
      symbol: setup.symbol,
      direction: overrideDirection,
      marketType: setup.marketType,
      timeframe: setup.timeframe,

      originalSetupDirection: setup.direction,
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
      unrealizedPnL: -entryCosts,  // Start negative due to entry costs
      unrealizedPnLPercent: (-entryCosts / positionMargin) * 100,
      status: 'open',
    };

    this.positions.set(existingKey, position);

    return position;
  }

  /**
   * Calculate initial stop loss price (ROI-based)
   */
  private calculateInitialStopLoss(entryPrice: number, direction: 'long' | 'short'): number {
    // Convert ROI% to price% by dividing by leverage
    const roiPercent = this.config.initialStopLossPercent / 100;
    const pricePercent = roiPercent / this.config.leverage;

    if (direction === 'long') {
      return entryPrice * (1 - pricePercent);
    } else {
      return entryPrice * (1 + pricePercent);
    }
  }

  /**
   * Update all open positions with current prices
   */
  updatePositions(
    getCurrentPrice: (symbol: string) => Promise<number | null>,
    onPositionClosed?: (position: TrendOverridePosition) => void
  ): Promise<void> {
    return this.updatePositionsInternal(getCurrentPrice, onPositionClosed);
  }

  private async updatePositionsInternal(
    getCurrentPrice: (symbol: string) => Promise<number | null>,
    onPositionClosed?: (position: TrendOverridePosition) => void
  ): Promise<void> {
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

      // Update high water mark
      if (position.unrealizedPnLPercent > position.highWaterMark) {
        position.highWaterMark = position.unrealizedPnLPercent;
      }

      // Check stop loss
      const hitStopLoss = position.direction === 'long'
        ? currentPrice <= position.currentStopLossPrice
        : currentPrice >= position.currentStopLossPrice;

      if (hitStopLoss) {
        this.closePosition(key, currentPrice, position.trailLevel > 0 ? `Trail L${position.trailLevel} hit` : 'Stop loss hit');
        onPositionClosed?.(position);
        continue;
      }

      // Check trailing stop activation and advancement
      this.updateTrailingStop(position);
    }
  }

  /**
   * Update trailing stop for a position
   */
  private updateTrailingStop(position: TrendOverridePosition): void {
    const roiPercent = position.unrealizedPnLPercent;

    // Calculate what trail level we should be at
    const triggerPercent = this.config.trailTriggerPercent;
    const stepPercent = this.config.trailStepPercent;

    let newTrailLevel = 0;
    if (roiPercent >= triggerPercent) {
      // Level 1 achieved
      newTrailLevel = 1;

      // Check for higher levels
      let nextLevelThreshold = triggerPercent + stepPercent;
      while (roiPercent >= nextLevelThreshold) {
        newTrailLevel++;
        nextLevelThreshold += stepPercent;
      }
    }

    // Update trail level if it advanced
    if (newTrailLevel > position.trailLevel) {
      position.trailLevel = newTrailLevel;

      // Calculate new stop loss price based on trail level
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
  private closePosition(key: string, exitPrice: number, reason: string): void {
    const position = this.positions.get(key);
    if (!position) return;

    // Calculate exit costs
    const { exitCosts } = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction,
      'normal'
    );

    // Calculate realized PnL
    const priceDiff = position.direction === 'long'
      ? exitPrice - position.effectiveEntryPrice
      : position.effectiveEntryPrice - exitPrice;

    const rawPnL = (priceDiff / position.effectiveEntryPrice) * position.notionalSize;
    const totalCosts = position.entryCosts + exitCosts;
    const realizedPnL = rawPnL - totalCosts;

    // Update position
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitCosts = exitCosts;
    position.fundingPaid = 0;  // TODO: calculate funding if needed
    position.totalCosts = totalCosts;
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;
    position.closeReason = reason;

    // Return margin + PnL to balance
    this.balance += position.marginUsed + realizedPnL;

    // Update peak balance
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Move to closed positions
    this.closedPositions.unshift(position);
    this.positions.delete(key);

    // Log
    const timestamp = new Date().toLocaleTimeString();
    const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
    console.log(`[TREND-OVERRIDE:${this.botName} ${timestamp}] CLOSED ${position.direction.toUpperCase()} ${position.symbol} | ${pnlStr} (${position.realizedPnLPercent?.toFixed(1)}% ROI) | ${reason} | Override: ${position.originalSetupDirection}→${position.direction}`);
  }

  /**
   * Handle setup state changes (e.g., played_out)
   */
  onSetupStateChange(setup: BackburnerSetup, newState: string): void {
    // For trend override, we don't exit on played_out since we're trading WITH the trend
    // The trailing stop handles exits
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): TrendOverridePosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get closed positions (most recent first)
   */
  getClosedPositions(limit: number = 50): TrendOverridePosition[] {
    return this.closedPositions.slice(0, limit);
  }

  /**
   * Get current balance
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Get unrealized PnL across all positions
   */
  getUnrealizedPnL(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.unrealizedPnL;
    }
    return total;
  }

  /**
   * Get bot statistics
   */
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
      totalFeesPaid,
      totalFundingPaid,
      totalExecutionCosts,
      costsAsPercentOfPnL: totalPnL !== 0 ? (totalExecutionCosts / Math.abs(totalPnL)) * 100 : 0,
      avgCostPerTrade: totalTrades > 0 ? totalExecutionCosts / totalTrades : 0,
    };
  }

  /**
   * Get bot config
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Reset bot state
   */
  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    this.processedSetups.clear();
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }

  /**
   * Update orphaned positions (positions whose setups no longer exist)
   */
  async updateOrphanedPositions(
    getCurrentPrice: (symbol: string) => Promise<number | null>
  ): Promise<void> {
    await this.updatePositionsInternal(getCurrentPrice);
  }
}
