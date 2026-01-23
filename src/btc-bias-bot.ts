/**
 * BTC Bias Bot - Trades BTC based on macro bias direction
 *
 * Logic:
 * - Only trades BTC (BTCUSDT)
 * - Enters when bias is FAVOR or STRONG in a direction
 * - Holds through NEUTRAL (doesn't exit until bias flips to opposite)
 * - Exits when bias flips to opposite direction
 * - Re-entry requires bias to strengthen (STRONG) after being stopped out
 *
 * Variants:
 * - Trailing: Uses MEXC-style continuous trailing stop (callback %)
 * - Hard Stop: Uses fixed 20% ROI stop loss only
 */

import { getExecutionCostsCalculator } from './execution-costs.js';
import { getDataPersistence } from './data-persistence.js';

export type BiasLevel = 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short';
export type StopType = 'trailing' | 'hard';

export interface BtcBiasBotConfig {
  initialBalance: number;
  positionSizePercent: number;  // 10 or 100
  leverage: number;             // 20 or 50
  stopType: StopType;           // 'trailing' or 'hard'
  callbackPercent: number;      // For trailing: callback % (e.g., 1.0 = 1%)
  hardStopRoiPercent: number;   // For hard stop: ROI % to stop at (e.g., 20)
}

export interface BtcBiasPosition {
  id: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  quantity: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  entryCosts: number;
  entryBias: BiasLevel;
  // Trailing stop tracking
  highestPrice: number;   // For longs
  lowestPrice: number;    // For shorts
  currentStopPrice: number;
  trailActivated: boolean;
  // State
  unrealizedPnL: number;
  unrealizedROI: number;
}

interface ClosedPosition extends BtcBiasPosition {
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnL: number;
  realizedROI: number;
  exitCosts: number;
  durationMs: number;
}

export class BtcBiasBot {
  private config: BtcBiasBotConfig;
  private name: string;
  private balance: number;
  private position: BtcBiasPosition | null = null;
  private closedPositions: ClosedPosition[] = [];
  private lastBias: BiasLevel = 'neutral';
  private wasStoppedOut = false;
  private stoppedOutDirection: 'long' | 'short' | null = null;
  private biasHistory: BiasLevel[] = [];

  // Stats
  private stats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0,
    totalExecutionCosts: 0,
    currentBalance: 0,
    winRate: 0,
  };

  constructor(config: BtcBiasBotConfig, name: string) {
    this.config = config;
    this.name = name;
    this.balance = config.initialBalance;
    this.stats.currentBalance = config.initialBalance;
  }

  /**
   * Process a new BTC bias update
   * Called whenever bias changes or price updates
   */
  processBiasUpdate(
    currentBias: BiasLevel,
    currentPrice: number,
    biasScore?: number
  ): { action: 'open' | 'close' | 'update' | 'none'; position?: BtcBiasPosition } {
    // Track bias history for re-entry logic
    if (currentBias !== this.lastBias) {
      this.biasHistory.push(currentBias);
      if (this.biasHistory.length > 10) this.biasHistory.shift();
    }

    // Update existing position if we have one
    if (this.position) {
      this.updatePosition(currentPrice);

      // Check if we should exit
      const exitReason = this.shouldExit(currentBias, currentPrice);
      if (exitReason) {
        this.closePosition(currentPrice, exitReason);
        this.lastBias = currentBias;
        return { action: 'close' };
      }

      this.lastBias = currentBias;
      return { action: 'update', position: this.position };
    }

    // Check if we should enter
    const entryDirection = this.shouldEnter(currentBias);
    if (entryDirection) {
      const position = this.openPosition(entryDirection, currentPrice, currentBias);
      this.lastBias = currentBias;
      return { action: 'open', position };
    }

    this.lastBias = currentBias;
    return { action: 'none' };
  }

  /**
   * Determine if we should enter a position
   */
  private shouldEnter(bias: BiasLevel): 'long' | 'short' | null {
    // Need FAVOR or STRONG bias to enter
    const isLongBias = bias === 'long' || bias === 'strong_long';
    const isShortBias = bias === 'short' || bias === 'strong_short';

    if (!isLongBias && !isShortBias) return null;

    const direction = isLongBias ? 'long' : 'short';

    // If we were stopped out, require STRONG bias to re-enter same direction
    if (this.wasStoppedOut && this.stoppedOutDirection === direction) {
      // Check if bias cycled (went neutral or opposite, then came back)
      const biasCycled = this.checkBiasCycled(direction);

      if (!biasCycled) {
        // Bias hasn't cycled yet, require STRONG
        if (bias !== 'strong_long' && bias !== 'strong_short') {
          return null;
        }
      }

      // Reset stopped out state since we're re-entering
      this.wasStoppedOut = false;
      this.stoppedOutDirection = null;
    }

    return direction;
  }

  /**
   * Check if bias has cycled (gone neutral/opposite then back)
   */
  private checkBiasCycled(direction: 'long' | 'short'): boolean {
    // Look for pattern: was stopped out -> went neutral/opposite -> came back
    const recent = this.biasHistory.slice(-5);

    if (direction === 'long') {
      // For longs, need to have seen neutral or short bias in between
      return recent.some(b => b === 'neutral' || b === 'short' || b === 'strong_short');
    } else {
      // For shorts, need to have seen neutral or long bias in between
      return recent.some(b => b === 'neutral' || b === 'long' || b === 'strong_long');
    }
  }

  /**
   * Determine if we should exit
   */
  private shouldExit(bias: BiasLevel, currentPrice: number): string | null {
    if (!this.position) return null;

    // Check stop loss hit
    if (this.position.direction === 'long') {
      if (currentPrice <= this.position.currentStopPrice) {
        return this.config.stopType === 'trailing' ? 'Trailing Stop Hit' : 'Hard Stop Loss Hit';
      }
    } else {
      if (currentPrice >= this.position.currentStopPrice) {
        return this.config.stopType === 'trailing' ? 'Trailing Stop Hit' : 'Hard Stop Loss Hit';
      }
    }

    // Check if bias flipped to opposite (not just neutral)
    if (this.position.direction === 'long') {
      if (bias === 'short' || bias === 'strong_short') {
        return 'Bias Flipped to Short';
      }
    } else {
      if (bias === 'long' || bias === 'strong_long') {
        return 'Bias Flipped to Long';
      }
    }

    return null;
  }

  /**
   * Open a new position
   */
  private openPosition(
    direction: 'long' | 'short',
    currentPrice: number,
    bias: BiasLevel
  ): BtcBiasPosition {
    // For single-position bot, available = balance when no position open
    const availableBalance = this.position ? 0 : this.balance;

    const marginAmount = availableBalance * (this.config.positionSizePercent / 100);
    const notionalSize = marginAmount * this.config.leverage;

    // Calculate execution costs
    const costsCalculator = getExecutionCostsCalculator();
    const { effectiveEntryPrice, entryCosts } = costsCalculator.calculateEntryCosts(
      currentPrice,
      notionalSize,
      direction,
      'normal'
    );

    // Calculate initial stop price
    let stopPrice: number;
    if (this.config.stopType === 'hard') {
      // Hard stop: 20% ROI loss = price move of (20 / leverage)%
      const priceDropPercent = this.config.hardStopRoiPercent / this.config.leverage / 100;
      if (direction === 'long') {
        stopPrice = effectiveEntryPrice * (1 - priceDropPercent);
      } else {
        stopPrice = effectiveEntryPrice * (1 + priceDropPercent);
      }
    } else {
      // Trailing: initial stop at callback % from entry
      const callbackDecimal = this.config.callbackPercent / 100;
      if (direction === 'long') {
        stopPrice = effectiveEntryPrice * (1 - callbackDecimal);
      } else {
        stopPrice = effectiveEntryPrice * (1 + callbackDecimal);
      }
    }

    const quantity = notionalSize / effectiveEntryPrice;

    this.position = {
      id: `btc-bias-${this.name}-${Date.now()}`,
      direction,
      entryPrice: effectiveEntryPrice,
      entryTime: Date.now(),
      quantity,
      marginUsed: marginAmount,
      notionalSize,
      leverage: this.config.leverage,
      entryCosts,
      entryBias: bias,
      highestPrice: effectiveEntryPrice,
      lowestPrice: effectiveEntryPrice,
      currentStopPrice: stopPrice,
      trailActivated: this.config.stopType === 'trailing', // Trailing always active
      unrealizedPnL: -entryCosts,
      unrealizedROI: 0,
    };

    this.stats.totalExecutionCosts += entryCosts;

    // Log trade open to persistence
    getDataPersistence().logGenericTrade({
      eventType: 'open',
      botId: `btc-bias-${this.name}`,
      botType: 'btc_bias',
      positionId: this.position.id,
      symbol: 'BTCUSDT',
      direction,
      entryPrice: effectiveEntryPrice,
      entryTime: new Date(this.position.entryTime).toISOString(),
      marginUsed: marginAmount,
      notionalSize,
      leverage: this.config.leverage,
      currentStopPrice: stopPrice,
      entryBias: bias,
      metadata: {
        stopType: this.config.stopType,
        callbackPercent: this.config.callbackPercent,
        positionSizePercent: this.config.positionSizePercent,
      },
    });

    console.log(
      `[BTC-BIAS:${this.name}] OPENED ${direction.toUpperCase()} @ ${effectiveEntryPrice.toFixed(2)} | ` +
      `Margin: $${marginAmount.toFixed(2)} | ${this.config.leverage}x | ` +
      `Stop: ${stopPrice.toFixed(2)} | Bias: ${bias}`
    );

    return this.position;
  }

  /**
   * Update position with current price
   */
  private updatePosition(currentPrice: number): void {
    if (!this.position) return;

    // Update high/low tracking
    if (currentPrice > this.position.highestPrice) {
      this.position.highestPrice = currentPrice;
    }
    if (currentPrice < this.position.lowestPrice) {
      this.position.lowestPrice = currentPrice;
    }

    // Update trailing stop if using trailing
    if (this.config.stopType === 'trailing') {
      const callbackDecimal = this.config.callbackPercent / 100;

      if (this.position.direction === 'long') {
        // Trail up from highest price
        const newStop = this.position.highestPrice * (1 - callbackDecimal);
        if (newStop > this.position.currentStopPrice) {
          this.position.currentStopPrice = newStop;
        }
      } else {
        // Trail down from lowest price
        const newStop = this.position.lowestPrice * (1 + callbackDecimal);
        if (newStop < this.position.currentStopPrice) {
          this.position.currentStopPrice = newStop;
        }
      }
    }

    // Calculate unrealized P&L
    const priceChange = this.position.direction === 'long'
      ? currentPrice - this.position.entryPrice
      : this.position.entryPrice - currentPrice;

    const rawPnL = priceChange * this.position.quantity;
    this.position.unrealizedPnL = rawPnL - this.position.entryCosts;
    this.position.unrealizedROI = (this.position.unrealizedPnL / this.position.marginUsed) * 100;
  }

  /**
   * Close position
   */
  private closePosition(exitPrice: number, reason: string): void {
    if (!this.position) return;

    // Calculate exit costs
    const costsCalculator = getExecutionCostsCalculator();
    const { effectiveExitPrice, exitCosts } = costsCalculator.calculateExitCosts(
      exitPrice,
      this.position.notionalSize,
      this.position.direction,
      'normal'
    );

    // Calculate final P&L
    const priceChange = this.position.direction === 'long'
      ? effectiveExitPrice - this.position.entryPrice
      : this.position.entryPrice - effectiveExitPrice;

    const rawPnL = priceChange * this.position.quantity;
    const totalCosts = this.position.entryCosts + exitCosts;
    const realizedPnL = rawPnL - totalCosts;
    const realizedROI = (realizedPnL / this.position.marginUsed) * 100;

    // Update stats
    this.stats.totalTrades++;
    this.stats.totalPnL += realizedPnL;
    this.stats.totalExecutionCosts += exitCosts;
    this.balance += realizedPnL;
    this.stats.currentBalance = this.balance;

    if (realizedPnL > 0) {
      this.stats.wins++;
    } else {
      this.stats.losses++;
      // Mark as stopped out if it was a stop loss
      if (reason.includes('Stop')) {
        this.wasStoppedOut = true;
        this.stoppedOutDirection = this.position.direction;
      }
    }

    this.stats.winRate = this.stats.totalTrades > 0
      ? (this.stats.wins / this.stats.totalTrades) * 100
      : 0;

    // Create closed position record
    const closed: ClosedPosition = {
      ...this.position,
      exitPrice: effectiveExitPrice,
      exitTime: Date.now(),
      exitReason: reason,
      realizedPnL,
      realizedROI,
      exitCosts,
      durationMs: Date.now() - this.position.entryTime,
    };

    this.closedPositions.push(closed);
    if (this.closedPositions.length > 100) {
      this.closedPositions = this.closedPositions.slice(-100);
    }

    // Log trade close to persistence
    getDataPersistence().logGenericTrade({
      eventType: 'close',
      botId: `btc-bias-${this.name}`,
      botType: 'btc_bias',
      positionId: this.position.id,
      symbol: 'BTCUSDT',
      direction: this.position.direction,
      entryPrice: this.position.entryPrice,
      entryTime: new Date(this.position.entryTime).toISOString(),
      marginUsed: this.position.marginUsed,
      notionalSize: this.position.notionalSize,
      leverage: this.position.leverage,
      exitPrice: effectiveExitPrice,
      exitTime: new Date().toISOString(),
      exitReason: reason,
      realizedPnL,
      realizedROI,
      durationMs: closed.durationMs,
      totalCosts,
      highestPrice: this.position.highestPrice,
      lowestPrice: this.position.lowestPrice,
      entryBias: this.position.entryBias,
    });

    const pnlColor = realizedPnL >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(
      `[BTC-BIAS:${this.name}] CLOSED ${this.position.direction.toUpperCase()} @ ${effectiveExitPrice.toFixed(2)} | ` +
      `${pnlColor}P&L: $${realizedPnL.toFixed(2)} (${realizedROI.toFixed(2)}%)\x1b[0m | ` +
      `Reason: ${reason}`
    );

    this.position = null;
  }

  // Getters
  getName(): string { return this.name; }
  getConfig(): BtcBiasBotConfig { return { ...this.config }; }
  getBalance(): number { return this.balance; }
  getPosition(): BtcBiasPosition | null { return this.position ? { ...this.position } : null; }
  getClosedPositions(limit = 20): ClosedPosition[] { return this.closedPositions.slice(-limit); }
  getStats() { return { ...this.stats }; }
  getUnrealizedPnL(): number { return this.position?.unrealizedPnL || 0; }

  isStoppedOut(): boolean { return this.wasStoppedOut; }
  getStoppedOutDirection(): 'long' | 'short' | null { return this.stoppedOutDirection; }

  /**
   * Reset bot to initial state (for daily reset feature)
   */
  reset(): void {
    this.balance = this.config.initialBalance;
    this.position = null;
    this.closedPositions = [];
    this.lastBias = 'neutral';
    this.wasStoppedOut = false;
    this.stoppedOutDirection = null;
    this.biasHistory = [];
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      totalExecutionCosts: 0,
      currentBalance: this.config.initialBalance,
      winRate: 0,
    };
    console.log(`[BTC-BIAS:${this.name}] Reset to initial state: $${this.balance}`);
  }
}

// Factory function to create all 8 bot variants (ORIGINAL - V1)
export function createBtcBiasBots(initialBalance = 2000): Map<string, BtcBiasBot> {
  const bots = new Map<string, BtcBiasBot>();

  // Trailing stop variants
  bots.set('bias100x20trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 100,
    leverage: 20,
    stopType: 'trailing',
    callbackPercent: 1.0,  // 1% callback
    hardStopRoiPercent: 20,
  }, '100x20-trail'));

  bots.set('bias100x50trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 100,
    leverage: 50,
    stopType: 'trailing',
    callbackPercent: 0.5,  // 0.5% callback (tighter for higher leverage)
    hardStopRoiPercent: 20,
  }, '100x50-trail'));

  bots.set('bias10x20trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    stopType: 'trailing',
    callbackPercent: 1.0,
    hardStopRoiPercent: 20,
  }, '10x20-trail'));

  bots.set('bias10x50trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 50,
    stopType: 'trailing',
    callbackPercent: 0.5,
    hardStopRoiPercent: 20,
  }, '10x50-trail'));

  // Hard stop variants
  bots.set('bias100x20hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 100,
    leverage: 20,
    stopType: 'hard',
    callbackPercent: 1.0,
    hardStopRoiPercent: 20,  // 20% ROI = 1% price move at 20x
  }, '100x20-hard'));

  bots.set('bias100x50hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 100,
    leverage: 50,
    stopType: 'hard',
    callbackPercent: 0.5,
    hardStopRoiPercent: 20,  // 20% ROI = 0.4% price move at 50x
  }, '100x50-hard'));

  bots.set('bias10x20hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    stopType: 'hard',
    callbackPercent: 1.0,
    hardStopRoiPercent: 20,
  }, '10x20-hard'));

  bots.set('bias10x50hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 50,
    stopType: 'hard',
    callbackPercent: 0.5,
    hardStopRoiPercent: 20,
  }, '10x50-hard'));

  return bots;
}

/**
 * Factory function to create V2 BTC Bias bots with IMPROVED parameters
 *
 * Key changes from V1:
 * - Reduced leverage: 10x and 20x instead of 20x and 50x
 * - Reduced position size: 10-20% instead of 10-100%
 * - Wider callbacks: 2-3% instead of 0.5-1%
 * - Higher hard stop: 30% ROI instead of 20%
 *
 * These changes should survive BTC volatility better while still
 * capturing directional moves from bias signals.
 */
export function createBtcBiasBotsV2(initialBalance = 2000): Map<string, BtcBiasBot> {
  const bots = new Map<string, BtcBiasBot>();

  // V2 Trailing stop variants - more conservative
  // 20% position, 10x leverage, 3% callback
  bots.set('bias-v2-20x10-trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 20,   // V1: 100% -> V2: 20%
    leverage: 10,               // V1: 20x -> V2: 10x
    stopType: 'trailing',
    callbackPercent: 3.0,       // V1: 1% -> V2: 3% (wider for volatility)
    hardStopRoiPercent: 30,
  }, 'v2-20x10-trail'));

  // 20% position, 20x leverage, 2% callback
  bots.set('bias-v2-20x20-trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 20,   // V1: 100% -> V2: 20%
    leverage: 20,               // Same as V1
    stopType: 'trailing',
    callbackPercent: 2.0,       // V1: 0.5% -> V2: 2% (wider)
    hardStopRoiPercent: 30,
  }, 'v2-20x20-trail'));

  // 10% position, 10x leverage, 3% callback (most conservative)
  bots.set('bias-v2-10x10-trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    stopType: 'trailing',
    callbackPercent: 3.0,
    hardStopRoiPercent: 30,
  }, 'v2-10x10-trail'));

  // 10% position, 20x leverage, 2% callback
  bots.set('bias-v2-10x20-trail', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    stopType: 'trailing',
    callbackPercent: 2.0,
    hardStopRoiPercent: 30,
  }, 'v2-10x20-trail'));

  // V2 Hard stop variants - with wider stops
  // 20% position, 10x leverage, 30% ROI stop (= 3% price move)
  bots.set('bias-v2-20x10-hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 20,
    leverage: 10,
    stopType: 'hard',
    callbackPercent: 3.0,
    hardStopRoiPercent: 30,     // V1: 20% -> V2: 30% (wider)
  }, 'v2-20x10-hard'));

  // 20% position, 20x leverage, 30% ROI stop (= 1.5% price move)
  bots.set('bias-v2-20x20-hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 20,
    leverage: 20,
    stopType: 'hard',
    callbackPercent: 2.0,
    hardStopRoiPercent: 30,
  }, 'v2-20x20-hard'));

  // 10% position, 10x leverage, 30% ROI stop
  bots.set('bias-v2-10x10-hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    stopType: 'hard',
    callbackPercent: 3.0,
    hardStopRoiPercent: 30,
  }, 'v2-10x10-hard'));

  // 10% position, 20x leverage, 30% ROI stop
  bots.set('bias-v2-10x20-hard', new BtcBiasBot({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    stopType: 'hard',
    callbackPercent: 2.0,
    hardStopRoiPercent: 30,
  }, 'v2-10x20-hard'));

  return bots;
}
