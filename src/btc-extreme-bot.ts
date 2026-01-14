/**
 * BTC Extreme Conditions Bot
 *
 * Trades BTCUSDT only when RSI conditions are extreme across timeframes.
 * - 50x leverage
 * - 10% position size
 * - Opens long when deeply oversold, short when deeply overbought
 * - Closes when conditions normalize
 * - 20% initial stop loss, trails at 10% profit intervals
 */

export interface BTCExtremeBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  // RSI thresholds for extreme conditions
  extremeOversoldThreshold: number;   // e.g., 25 - deeply oversold
  extremeOverboughtThreshold: number; // e.g., 75 - deeply overbought
  coolOffThreshold: number;           // e.g., 45-55 range = cooled off
}

export const DEFAULT_BTC_EXTREME_CONFIG: BTCExtremeBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 50,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  extremeOversoldThreshold: 30,
  extremeOverboughtThreshold: 70,
  coolOffThreshold: 50,  // Close when RSI crosses back toward 50
};

export type BTCPositionStatus = 'open' | 'closed_trail_stop' | 'closed_sl' | 'closed_cooloff';

export interface BTCExtremePosition {
  id: string;
  direction: 'long' | 'short';

  // Entry details
  entryPrice: number;
  entryTime: number;
  entryRSI: number;        // RSI at entry
  entryBias: string;       // Market bias at entry
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Trailing stop tracking
  initialStopLossPrice: number;
  currentStopLossPrice: number;
  highWaterMark: number;
  trailLevel: number;

  // Current state
  currentPrice: number;
  currentRSI: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Exit details
  status: BTCPositionStatus;
  exitPrice?: number;
  exitTime?: number;
  exitRSI?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
}

export interface BTCExtremeStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  totalPnLPercent: number;
  largestWin: number;
  largestLoss: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  currentBalance: number;
  peakBalance: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  avgTrailLevel: number;
  avgHoldTime: number;  // Average hold time in ms
}

// RSI data from multi-timeframe analysis
export interface BTCRSIData {
  rsi4h: number;
  rsi1h: number;
  rsi15m: number;
  rsi5m: number;
  rsi1m: number;
  bias: string;         // 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short'
  biasScore: number;    // -100 to +100
}

/**
 * BTC Extreme Conditions Trading Bot
 */
export class BTCExtremeBot {
  private config: BTCExtremeBotConfig;
  private position: BTCExtremePosition | null = null;
  private closedPositions: BTCExtremePosition[] = [];
  private balance: number;
  private peakBalance: number;
  private lastPrice: number = 0;

  constructor(config?: Partial<BTCExtremeBotConfig>) {
    this.config = { ...DEFAULT_BTC_EXTREME_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  /**
   * Check if conditions are extreme enough to open a position
   */
  private shouldOpenPosition(rsiData: BTCRSIData): 'long' | 'short' | null {
    // Already have a position
    if (this.position) return null;

    // Check for extreme oversold - potential long
    // Use weighted average favoring higher timeframes
    const weightedRSI = (
      rsiData.rsi4h * 3 +
      rsiData.rsi1h * 2 +
      rsiData.rsi15m * 1 +
      rsiData.rsi5m * 0.5 +
      rsiData.rsi1m * 0.25
    ) / 6.75;

    // Strong oversold with bearish bias (contrarian entry)
    if (weightedRSI < this.config.extremeOversoldThreshold &&
        (rsiData.bias === 'short' || rsiData.bias === 'strong_short')) {
      return 'long';
    }

    // Strong overbought with bullish bias (contrarian entry)
    if (weightedRSI > this.config.extremeOverboughtThreshold &&
        (rsiData.bias === 'long' || rsiData.bias === 'strong_long')) {
      return 'short';
    }

    return null;
  }

  /**
   * Check if conditions have cooled off enough to close
   */
  private shouldCloseOnCoolOff(rsiData: BTCRSIData): boolean {
    if (!this.position) return false;

    // Weighted RSI toward 50 = conditions cooling
    const weightedRSI = (
      rsiData.rsi4h * 3 +
      rsiData.rsi1h * 2 +
      rsiData.rsi15m * 1 +
      rsiData.rsi5m * 0.5 +
      rsiData.rsi1m * 0.25
    ) / 6.75;

    if (this.position.direction === 'long') {
      // Close long when RSI recovers above cooloff threshold
      return weightedRSI > this.config.coolOffThreshold;
    } else {
      // Close short when RSI drops below cooloff threshold
      return weightedRSI < this.config.coolOffThreshold;
    }
  }

  /**
   * Calculate position size
   */
  private calculatePositionSize(): { margin: number; notional: number } {
    const margin = this.balance * (this.config.positionSizePercent / 100);
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
      id: `btc-extreme-${Date.now()}`,
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
    };

    this.balance -= margin;
    this.lastPrice = price;

    console.error(`[BTC-EXTREME] OPENED ${direction.toUpperCase()} @ ${price.toFixed(2)} | RSI: ${weightedRSI.toFixed(1)} | Bias: ${rsiData.bias} | Margin: $${margin.toFixed(2)} | SL: ${initialStopLoss.toFixed(2)}`);

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

    // Calculate ROI (return on margin) - this is what we use for trailing thresholds
    const roi = this.position.marginUsed > 0
      ? (this.position.unrealizedPnL / this.position.marginUsed) * 100
      : 0;

    // Update high water mark (now tracking ROI, not price change)
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
            console.error(`[BTC-EXTREME] TRAIL UP L${newTrailLevel}: SL moved to ${newSL.toFixed(2)} (locking ${lockedROIPercent}% ROI)`);
          }
        } else {
          const newSL = this.position.entryPrice * (1 - lockedPriceRatio);
          if (newSL < this.position.currentStopLossPrice) {
            this.position.currentStopLossPrice = newSL;
            console.error(`[BTC-EXTREME] TRAIL UP L${newTrailLevel}: SL moved to ${newSL.toFixed(2)} (locking ${lockedROIPercent}% ROI)`);
          }
        }
      }
    }

    // Check if conditions have cooled off
    if (this.shouldCloseOnCoolOff(rsiData)) {
      return this.closePosition('closed_cooloff', `Conditions cooled off - RSI: ${weightedRSI.toFixed(1)}`);
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

    console.error(`[BTC-EXTREME] CLOSED ${position.direction.toUpperCase()} @ ${position.exitPrice.toFixed(2)} | P&L: $${position.realizedPnL.toFixed(2)} (${position.realizedPnLPercent.toFixed(2)}%) | Hold: ${holdTimeStr} | Reason: ${reason}`);

    this.closedPositions.push(position);
    this.position = null;

    return position;
  }

  /**
   * Force close the position (e.g., for manual intervention)
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
   * Get trading stats
   */
  getStats(): BTCExtremeStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) < 0);

    const totalWins = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));
    const totalPnL = totalWins - totalLosses;

    const reservedMargin = this.position?.marginUsed || 0;
    const effectiveBalance = this.balance + reservedMargin;

    // Average trail level
    const avgTrailLevel = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.trailLevel, 0) / this.closedPositions.length
      : 0;

    // Average hold time
    const avgHoldTime = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + ((p.exitTime || 0) - p.entryTime), 0) / this.closedPositions.length
      : 0;

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0
        ? (wins.length / this.closedPositions.length) * 100
        : 0,
      totalPnL,
      totalPnLPercent: (totalPnL / this.config.initialBalance) * 100,
      largestWin: wins.length > 0
        ? Math.max(...wins.map(p => p.realizedPnL || 0))
        : 0,
      largestLoss: losses.length > 0
        ? Math.min(...losses.map(p => p.realizedPnL || 0))
        : 0,
      averageWin: wins.length > 0 ? totalWins / wins.length : 0,
      averageLoss: losses.length > 0 ? totalLosses / losses.length : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
      currentBalance: effectiveBalance,
      peakBalance: this.peakBalance,
      maxDrawdown: this.peakBalance - effectiveBalance,
      maxDrawdownPercent: ((this.peakBalance - effectiveBalance) / this.peakBalance) * 100,
      avgTrailLevel,
      avgHoldTime,
    };
  }

  /**
   * Get config
   */
  getConfig(): BTCExtremeBotConfig {
    return this.config;
  }

  /**
   * Reset the bot
   */
  reset(): void {
    this.position = null;
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }
}
