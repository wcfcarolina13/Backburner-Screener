/**
 * BTC Trend-Following Bot
 *
 * Trades BTCUSDT following the trend when bias is strong.
 * "Trend is your friend" - goes with momentum, not against it.
 * - 50x leverage
 * - 10% position size
 * - Opens long when strong bullish bias, short when strong bearish bias
 * - Closes when bias weakens or reverses
 * - 20% initial stop loss, trails at 10% ROI intervals
 */

import type { BTCRSIData, BTCExtremePosition, BTCPositionStatus, BTCExtremeStats } from './btc-extreme-bot.js';

export interface BTCTrendBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;    // ROI % to trigger trailing
  trailStepPercent: number;       // ROI % per trail level
  // Trend entry thresholds
  strongBiasThreshold: number;    // Bias score threshold for entry (e.g., 60 = strong trend)
  exitBiasThreshold: number;      // Exit when bias weakens below this
}

export const DEFAULT_BTC_TREND_CONFIG: BTCTrendBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 50,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,        // Trail after 10% ROI
  trailStepPercent: 10,           // Lock in 10% ROI increments
  strongBiasThreshold: 70,        // Enter when bias score > 70 or < -70
  exitBiasThreshold: 30,          // Exit when bias weakens to < 30 (or > -30 for shorts)
};

/**
 * BTC Trend-Following Trading Bot
 */
export class BTCTrendBot {
  private config: BTCTrendBotConfig;
  private position: BTCExtremePosition | null = null;
  private closedPositions: BTCExtremePosition[] = [];
  private balance: number;
  private peakBalance: number;
  private lastPrice: number = 0;

  constructor(config?: Partial<BTCTrendBotConfig>) {
    this.config = { ...DEFAULT_BTC_TREND_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  /**
   * Check if trend is strong enough to open a position
   */
  private shouldOpenPosition(rsiData: BTCRSIData): 'long' | 'short' | null {
    // Already have a position
    if (this.position) return null;

    // Strong bullish bias - go long with the trend
    if (rsiData.biasScore >= this.config.strongBiasThreshold &&
        (rsiData.bias === 'long' || rsiData.bias === 'strong_long')) {
      return 'long';
    }

    // Strong bearish bias - go short with the trend
    if (rsiData.biasScore <= -this.config.strongBiasThreshold &&
        (rsiData.bias === 'short' || rsiData.bias === 'strong_short')) {
      return 'short';
    }

    return null;
  }

  /**
   * Check if trend has weakened enough to exit
   */
  private shouldExitOnTrendWeakening(rsiData: BTCRSIData): boolean {
    if (!this.position) return false;

    if (this.position.direction === 'long') {
      // Exit long if bias turns negative or weakens significantly
      return rsiData.biasScore < this.config.exitBiasThreshold;
    } else {
      // Exit short if bias turns positive or weakens significantly
      return rsiData.biasScore > -this.config.exitBiasThreshold;
    }
  }

  /**
   * Calculate position size from AVAILABLE balance
   */
  private calculatePositionSize(): { margin: number; notional: number } {
    // For single-position bot, available = balance when no position open
    // This bot only holds one position at a time (this.position), so no need to sum
    const availableBalance = this.position ? 0 : this.balance;

    const margin = availableBalance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;
    return { margin, notional };
  }

  /**
   * Calculate initial stop loss price
   */
  private calculateInitialStopLoss(entryPrice: number, direction: 'long' | 'short'): number {
    // initialStopLossPercent is ROI% (e.g., 20% = max 20% loss on margin)
    // Convert to price% by dividing by leverage
    // Example: 20% ROI stop with 50x leverage = 0.4% price move
    const roiPercent = this.config.initialStopLossPercent / 100;
    const pricePercent = roiPercent / this.config.leverage;

    if (direction === 'long') {
      return entryPrice * (1 - pricePercent);
    } else {
      return entryPrice * (1 + pricePercent);
    }
  }

  /**
   * Open a new position
   */
  openPosition(price: number, rsiData: BTCRSIData): BTCExtremePosition | null {
    const direction = this.shouldOpenPosition(rsiData);
    if (!direction) return null;

    const { margin, notional } = this.calculatePositionSize();

    if (margin > this.balance) {
      return null;
    }

    const initialStopLoss = this.calculateInitialStopLoss(price, direction);

    // Use weighted RSI for entry RSI
    const weightedRSI = (
      rsiData.rsi4h * 3 +
      rsiData.rsi1h * 2 +
      rsiData.rsi15m * 1 +
      rsiData.rsi5m * 0.5 +
      rsiData.rsi1m * 0.25
    ) / 6.75;

    this.position = {
      id: `btc-trend-${Date.now()}`,
      direction,
      entryPrice: price,
      entryTime: Date.now(),
      entryRSI: weightedRSI,
      entryBias: rsiData.bias,
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,
      initialStopLossPrice: initialStopLoss,
      currentStopLossPrice: initialStopLoss,
      highWaterMark: 0,
      trailLevel: 0,
      currentPrice: price,
      currentRSI: weightedRSI,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      status: 'open',
      openReason: `Strong ${direction === 'long' ? 'bullish' : 'bearish'} trend (${rsiData.biasScore.toFixed(0)}%)`,
    } as BTCExtremePosition & { openReason?: string };

    this.balance -= margin;
    this.lastPrice = price;

    console.error(`[BTC-TREND] OPENED ${direction.toUpperCase()} @ ${price.toFixed(2)} | Bias: ${rsiData.bias} (${rsiData.biasScore.toFixed(0)}%) | Margin: $${margin.toFixed(2)} | SL: ${initialStopLoss.toFixed(2)}`);

    return this.position;
  }

  /**
   * Update position with new price and RSI data
   */
  update(price: number, rsiData: BTCRSIData): BTCExtremePosition | null {
    this.lastPrice = price;

    if (!this.position) {
      // Try to open a new position
      return this.openPosition(price, rsiData);
    }

    // Update current values
    this.position.currentPrice = price;

    const weightedRSI = (
      rsiData.rsi4h * 3 +
      rsiData.rsi1h * 2 +
      rsiData.rsi15m * 1 +
      rsiData.rsi5m * 0.5 +
      rsiData.rsi1m * 0.25
    ) / 6.75;
    this.position.currentRSI = weightedRSI;

    // Calculate P&L
    const priceChange = this.position.direction === 'long'
      ? (price - this.position.entryPrice) / this.position.entryPrice
      : (this.position.entryPrice - price) / this.position.entryPrice;

    this.position.unrealizedPnL = this.position.notionalSize * priceChange;
    this.position.unrealizedPnLPercent = priceChange * 100;

    // Calculate ROI (return on margin) for trailing
    const roi = this.position.marginUsed > 0
      ? (this.position.unrealizedPnL / this.position.marginUsed) * 100
      : 0;

    // Update high water mark (tracking ROI)
    if (roi > this.position.highWaterMark) {
      this.position.highWaterMark = roi;
    }

    // Check for stop loss hit
    if (this.position.direction === 'long' && price <= this.position.currentStopLossPrice) {
      return this.closePosition('closed_sl', `Stop loss hit at ${price.toFixed(2)}`);
    }
    if (this.position.direction === 'short' && price >= this.position.currentStopLossPrice) {
      return this.closePosition('closed_sl', `Stop loss hit at ${price.toFixed(2)}`);
    }

    // Check for trailing stop adjustment (based on ROI)
    const trailTrigger = this.config.trailTriggerPercent;
    const trailStep = this.config.trailStepPercent;

    if (roi >= trailTrigger) {
      const newTrailLevel = Math.floor((roi - trailTrigger) / trailStep) + 1;

      if (newTrailLevel > this.position.trailLevel) {
        this.position.trailLevel = newTrailLevel;

        // Move stop loss to lock in profit (convert ROI back to price)
        const lockedROIPercent = (newTrailLevel - 1) * trailStep;
        const lockedPriceRatio = lockedROIPercent / 100 / this.position.leverage;

        if (this.position.direction === 'long') {
          const newSL = this.position.entryPrice * (1 + lockedPriceRatio);
          if (newSL > this.position.currentStopLossPrice) {
            this.position.currentStopLossPrice = newSL;
            console.error(`[BTC-TREND] TRAIL UP L${newTrailLevel}: SL moved to ${newSL.toFixed(2)} (locking ${lockedROIPercent}% ROI)`);
          }
        } else {
          const newSL = this.position.entryPrice * (1 - lockedPriceRatio);
          if (newSL < this.position.currentStopLossPrice) {
            this.position.currentStopLossPrice = newSL;
            console.error(`[BTC-TREND] TRAIL UP L${newTrailLevel}: SL moved to ${newSL.toFixed(2)} (locking ${lockedROIPercent}% ROI)`);
          }
        }
      }
    }

    // Check if trend has weakened
    if (this.shouldExitOnTrendWeakening(rsiData)) {
      return this.closePosition('closed_cooloff', `Trend weakened - Bias: ${rsiData.biasScore.toFixed(0)}%`);
    }

    return this.position;
  }

  /**
   * Close the current position
   */
  closePosition(status: BTCPositionStatus, reason: string): BTCExtremePosition | null {
    if (!this.position) return null;

    const position = this.position;

    // Calculate final P&L
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.realizedPnL = position.notionalSize * priceChange;
    position.realizedPnLPercent = priceChange * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.exitRSI = position.currentRSI;
    position.exitReason = reason;
    (position as any).closeReason = reason;
    position.status = status;

    // Update balance
    this.balance += position.marginUsed + position.realizedPnL;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Calculate hold time
    const holdTimeMs = position.exitTime - position.entryTime;
    const holdTimeStr = holdTimeMs < 60000
      ? `${Math.floor(holdTimeMs / 1000)}s`
      : holdTimeMs < 3600000
        ? `${Math.floor(holdTimeMs / 60000)}m`
        : `${(holdTimeMs / 3600000).toFixed(1)}h`;

    const roi = position.marginUsed > 0
      ? (position.realizedPnL / position.marginUsed) * 100
      : 0;

    console.error(`[BTC-TREND] CLOSED ${position.direction.toUpperCase()} @ ${position.exitPrice.toFixed(2)} | P&L: $${position.realizedPnL.toFixed(2)} (${roi.toFixed(1)}% ROI) | Hold: ${holdTimeStr} | Reason: ${reason}`);

    this.closedPositions.push(position);
    this.position = null;

    return position;
  }

  /**
   * Force close the position
   */
  forceClose(reason: string = 'Manual close'): BTCExtremePosition | null {
    if (!this.position) return null;
    return this.closePosition('closed_cooloff', reason);
  }

  /**
   * Get current position
   */
  getPosition(): BTCExtremePosition | null {
    return this.position;
  }

  /**
   * Get closed positions
   */
  getClosedPositions(limit = 20): BTCExtremePosition[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  /**
   * Get current balance
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Get unrealized P&L
   */
  getUnrealizedPnL(): number {
    return this.position?.unrealizedPnL || 0;
  }

  /**
   * Get bot configuration
   */
  getConfig(): BTCTrendBotConfig {
    return { ...this.config };
  }

  /**
   * Get trading stats
   */
  getStats(): BTCExtremeStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);

    const totalPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalWinPnL = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLossPnL = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));

    const avgHoldTime = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + ((p.exitTime || 0) - p.entryTime), 0) / this.closedPositions.length
      : 0;

    const maxDrawdown = this.peakBalance - Math.min(this.balance, ...this.closedPositions.map(p => {
      const balanceAfter = this.config.initialBalance + this.closedPositions
        .slice(0, this.closedPositions.indexOf(p) + 1)
        .reduce((sum, pos) => sum + (pos.realizedPnL || 0), 0);
      return balanceAfter;
    }));

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0 ? (wins.length / this.closedPositions.length) * 100 : 0,
      totalPnL,
      totalPnLPercent: (totalPnL / this.config.initialBalance) * 100,
      largestWin: wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnL || 0)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(p => p.realizedPnL || 0)) : 0,
      averageWin: wins.length > 0 ? totalWinPnL / wins.length : 0,
      averageLoss: losses.length > 0 ? totalLossPnL / losses.length : 0,
      profitFactor: totalLossPnL > 0 ? totalWinPnL / totalLossPnL : totalWinPnL > 0 ? Infinity : 0,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      maxDrawdown,
      maxDrawdownPercent: this.peakBalance > 0 ? (maxDrawdown / this.peakBalance) * 100 : 0,
      avgTrailLevel: this.closedPositions.length > 0
        ? this.closedPositions.reduce((sum, p) => sum + p.trailLevel, 0) / this.closedPositions.length
        : 0,
      avgHoldTime,
    };
  }

  /**
   * Reset the bot
   */
  reset(): void {
    this.position = null;
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.lastPrice = 0;
    console.error('[BTC-TREND] Bot reset');
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }
}
