/**
 * Base Bot Abstract Class
 *
 * Provides shared infrastructure for all trading bots while preserving
 * each variant's unique entry/exit logic through abstract methods.
 *
 * Shared functionality:
 * - Balance and margin management
 * - Position size calculation
 * - PnL calculation (both unrealized and realized)
 * - Stats tracking (win rate, profit factor, drawdown, etc.)
 * - Trailing stop infrastructure
 * - Trade logging hooks
 *
 * Variant-specific (abstract):
 * - canEnter(): Whether to open a position given current market data
 * - calculateStops(): How to set TP/SL based on entry
 * - shouldExit(): Additional exit conditions beyond TP/SL
 * - Position type (single vs multi-position)
 */

import { getDataPersistence } from '../data-persistence.js';

// ============= Core Types =============

export interface BaseBotConfig {
  botId: string;
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  maxOpenPositions: number;

  // Stop loss / Take profit (optional - variants can override)
  takeProfitPercent?: number;
  stopLossPercent?: number;

  // Trailing stop (optional)
  trailTriggerPercent?: number;   // ROI % to activate trailing
  trailStepPercent?: number;      // ROI % per trail level

  // Breakeven (optional)
  breakevenTriggerPercent?: number;

  // Filters
  requireFutures?: boolean;

  // Execution costs (optional)
  enableFriction?: boolean;
  feePercent?: number;
  slippagePercent?: number;
}

export type BasePositionStatus =
  | 'open'
  | 'closed_tp'
  | 'closed_sl'
  | 'closed_trailing'
  | 'closed_breakeven'
  | 'closed_signal'     // Closed due to signal condition (e.g., RSI cooloff)
  | 'closed_manual';

export interface BasePosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: 'spot' | 'futures';
  timeframe: string;

  // Entry
  entryPrice: number;
  entryTime: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Risk management
  takeProfitPrice?: number;
  stopLossPrice: number;
  initialStopLossPrice: number;

  // Trailing stop tracking
  trailActivated: boolean;
  trailLevel: number;
  highWaterMark: number;          // Highest ROI seen

  // Breakeven
  breakevenLocked: boolean;

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;   // ROI as %

  // Exit (if closed)
  status: BasePositionStatus;
  exitPrice?: number;
  exitTime?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;

  // Costs
  entryCosts?: number;
  exitCosts?: number;
  totalCosts?: number;

  // Variant-specific data (each bot can extend)
  metadata?: Record<string, unknown>;
}

export interface BaseBotStats {
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
}

// ============= Market Data Interface =============
// Generic interface - each bot variant can extend with specific fields

export interface MarketData {
  symbol: string;
  currentPrice: number;
  timestamp: number;
  direction?: 'long' | 'short';
  timeframe?: string;
  marketType?: 'spot' | 'futures';
  // Variants can add more fields via extension
  [key: string]: unknown;
}

// ============= Abstract Base Bot =============

export abstract class BaseBot<
  TConfig extends BaseBotConfig = BaseBotConfig,
  TPosition extends BasePosition = BasePosition,
  TMarketData extends MarketData = MarketData,
  TStats extends BaseBotStats = BaseBotStats
> {
  protected config: TConfig;
  protected balance: number;
  protected peakBalance: number;
  protected closedPositions: TPosition[] = [];

  constructor(config: TConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.peakBalance = config.initialBalance;
  }

  // ============= Abstract Methods (variant-specific) =============

  /**
   * Determine if we should enter a position based on market data.
   * Return the direction to trade, or null to skip.
   */
  protected abstract canEnter(data: TMarketData): 'long' | 'short' | null;

  /**
   * Calculate stop loss and optional take profit for a new position.
   * Return the prices to set.
   */
  protected abstract calculateStops(
    entryPrice: number,
    direction: 'long' | 'short',
    data: TMarketData
  ): { stopLoss: number; takeProfit?: number };

  /**
   * Check if a position should be closed based on current market data.
   * Return the exit reason, or null to keep open.
   * This is in addition to automatic TP/SL/trailing checks.
   */
  protected abstract shouldExit(position: TPosition, data: TMarketData): string | null;

  /**
   * Create a position key for tracking (multi-position bots).
   * Single-position bots can return a constant.
   */
  protected abstract getPositionKey(data: TMarketData): string;

  /**
   * Generate a unique position ID.
   */
  protected abstract generatePositionId(data: TMarketData): string;

  /**
   * Get all open positions (abstract to support single vs multi-position bots).
   */
  public abstract getOpenPositions(): TPosition[];

  /**
   * Check if a position with the given key already exists.
   */
  protected abstract hasPosition(key: string): boolean;

  /**
   * Store a new position.
   */
  protected abstract storePosition(key: string, position: TPosition): void;

  /**
   * Get a position by key.
   */
  protected abstract getPosition(key: string): TPosition | undefined;

  /**
   * Remove a position from storage.
   */
  protected abstract removePosition(key: string): void;

  /**
   * Get the current number of open positions.
   */
  protected abstract getPositionCount(): number;

  // ============= Shared Implementation =============

  /**
   * Get bot ID
   */
  getBotId(): string {
    return this.config.botId;
  }

  /**
   * Get current balance
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Get config
   */
  getConfig(): TConfig {
    return { ...this.config };
  }

  /**
   * Calculate position size based on config
   */
  protected calculatePositionSize(): { margin: number; notional: number } {
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;
    return { margin, notional };
  }

  /**
   * Calculate PnL for a position
   */
  protected calculatePnL(
    entryPrice: number,
    currentPrice: number,
    direction: 'long' | 'short',
    notionalSize: number
  ): { pnl: number; pnlPercent: number } {
    const priceChange = direction === 'long'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;

    return {
      pnl: notionalSize * priceChange,
      pnlPercent: priceChange * 100,
    };
  }

  /**
   * Calculate ROI (return on margin)
   */
  protected calculateROI(pnl: number, margin: number): number {
    return margin > 0 ? (pnl / margin) * 100 : 0;
  }

  /**
   * Open a new position (shared logic with variant hooks)
   */
  protected openPositionInternal(data: TMarketData): TPosition | null {
    // Check entry condition (variant-specific)
    const direction = this.canEnter(data);
    if (!direction) return null;

    // Check filters
    if (this.config.requireFutures !== false && data.marketType !== 'futures') {
      return null;
    }

    const key = this.getPositionKey(data);

    // Check for existing position
    if (this.hasPosition(key)) {
      return null;
    }

    // Check max positions
    if (this.getPositionCount() >= this.config.maxOpenPositions) {
      return null;
    }

    // Calculate position size
    const { margin, notional } = this.calculatePositionSize();

    // Check balance
    if (margin > this.balance) {
      return null;
    }

    const entryPrice = data.currentPrice;

    // Calculate stops (variant-specific)
    const { stopLoss, takeProfit } = this.calculateStops(entryPrice, direction, data);

    // Calculate entry costs if friction enabled
    let entryCosts = 0;
    if (this.config.enableFriction && this.config.feePercent) {
      entryCosts = notional * (this.config.feePercent / 100);
    }

    // Create position
    const position: BasePosition = {
      id: this.generatePositionId(data),
      symbol: data.symbol,
      direction,
      marketType: data.marketType || 'futures',
      timeframe: data.timeframe || '1h',

      entryPrice,
      entryTime: Date.now(),
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,

      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
      initialStopLossPrice: stopLoss,

      trailActivated: false,
      trailLevel: 0,
      highWaterMark: 0,

      breakevenLocked: false,

      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,

      status: 'open',
      entryCosts,
    };

    // Reserve margin
    this.balance -= margin;

    // Store position
    this.storePosition(key, position as TPosition);

    // Log trade
    this.logTradeOpen(position as TPosition, data);

    return position as TPosition;
  }

  /**
   * Update a position with new market data
   */
  protected updatePositionInternal(data: TMarketData): TPosition | null {
    const key = this.getPositionKey(data);
    const position = this.getPosition(key);

    if (!position || position.status !== 'open') {
      return null;
    }

    // Update current price
    position.currentPrice = data.currentPrice;

    // Calculate PnL
    const { pnl, pnlPercent } = this.calculatePnL(
      position.entryPrice,
      position.currentPrice,
      position.direction,
      position.notionalSize
    );

    position.unrealizedPnL = pnl;
    position.unrealizedPnLPercent = pnlPercent;

    const roi = this.calculateROI(pnl, position.marginUsed);

    // Update high water mark
    if (roi > position.highWaterMark) {
      position.highWaterMark = roi;
    }

    // Check breakeven lock
    if (
      this.config.breakevenTriggerPercent !== undefined &&
      !position.breakevenLocked &&
      roi >= this.config.breakevenTriggerPercent
    ) {
      position.stopLossPrice = position.entryPrice;
      position.breakevenLocked = true;
      this.onBreakevenLocked(position);
    }

    // Check trailing stop
    if (this.config.trailTriggerPercent !== undefined && this.config.trailStepPercent !== undefined) {
      this.updateTrailingStop(position, roi);
    }

    // Check exit conditions
    const exitResult = this.checkExitConditions(position, data);
    if (exitResult) {
      return this.closePositionInternal(position, exitResult.status, exitResult.reason);
    }

    return position;
  }

  /**
   * Update trailing stop based on ROI
   */
  protected updateTrailingStop(position: TPosition, roi: number): void {
    const triggerPercent = this.config.trailTriggerPercent!;
    const stepPercent = this.config.trailStepPercent!;

    // Activate trailing if not already
    if (!position.trailActivated && roi >= triggerPercent) {
      position.trailActivated = true;
      this.onTrailingActivated(position);
    }

    if (!position.trailActivated) return;

    // Calculate new trail level
    const newTrailLevel = Math.floor((roi - triggerPercent) / stepPercent) + 1;

    if (newTrailLevel > position.trailLevel) {
      position.trailLevel = newTrailLevel;

      // Calculate locked ROI
      const lockedROIPercent = (newTrailLevel - 1) * stepPercent;
      const lockedPriceRatio = lockedROIPercent / 100 / position.leverage;

      // Move stop loss
      const newSL = position.direction === 'long'
        ? position.entryPrice * (1 + lockedPriceRatio)
        : position.entryPrice * (1 - lockedPriceRatio);

      const isImprovement = position.direction === 'long'
        ? newSL > position.stopLossPrice
        : newSL < position.stopLossPrice;

      if (isImprovement) {
        position.stopLossPrice = newSL;
        this.onTrailingMoved(position, newTrailLevel, lockedROIPercent);
      }
    }
  }

  /**
   * Check all exit conditions
   */
  protected checkExitConditions(
    position: TPosition,
    data: TMarketData
  ): { status: BasePositionStatus; reason: string } | null {
    const price = position.currentPrice;

    // Check stop loss
    if (position.direction === 'long' && price <= position.stopLossPrice) {
      if (position.trailActivated) {
        return { status: 'closed_trailing', reason: 'Trailing stop hit' };
      } else if (position.breakevenLocked) {
        return { status: 'closed_breakeven', reason: 'Breakeven stop hit' };
      } else {
        return { status: 'closed_sl', reason: 'Stop loss hit' };
      }
    }

    if (position.direction === 'short' && price >= position.stopLossPrice) {
      if (position.trailActivated) {
        return { status: 'closed_trailing', reason: 'Trailing stop hit' };
      } else if (position.breakevenLocked) {
        return { status: 'closed_breakeven', reason: 'Breakeven stop hit' };
      } else {
        return { status: 'closed_sl', reason: 'Stop loss hit' };
      }
    }

    // Check take profit
    if (position.takeProfitPrice !== undefined) {
      if (position.direction === 'long' && price >= position.takeProfitPrice) {
        return { status: 'closed_tp', reason: 'Take profit hit' };
      }
      if (position.direction === 'short' && price <= position.takeProfitPrice) {
        return { status: 'closed_tp', reason: 'Take profit hit' };
      }
    }

    // Check variant-specific exit conditions
    const customExitReason = this.shouldExit(position, data);
    if (customExitReason) {
      return { status: 'closed_signal', reason: customExitReason };
    }

    return null;
  }

  /**
   * Close a position
   */
  protected closePositionInternal(
    position: TPosition,
    status: BasePositionStatus,
    reason: string
  ): TPosition {
    const key = `${position.symbol}-${position.timeframe}-${position.direction}-${position.marketType}`;

    // Calculate final PnL
    const { pnl: rawPnl } = this.calculatePnL(
      position.entryPrice,
      position.currentPrice,
      position.direction,
      position.notionalSize
    );

    // Calculate exit costs
    let exitCosts = 0;
    let totalCosts = position.entryCosts || 0;
    if (this.config.enableFriction && this.config.feePercent) {
      exitCosts = position.notionalSize * (this.config.feePercent / 100);
      totalCosts += exitCosts;
    }

    // Apply friction
    const realizedPnL = rawPnl - totalCosts;

    // Update position
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;
    position.exitCosts = exitCosts;
    position.totalCosts = totalCosts;

    // Remove from active positions FIRST (prevent duplicate closes)
    this.removePosition(key);

    // Return margin + PnL
    this.balance += position.marginUsed + realizedPnL;

    // Update peak balance
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Store in closed positions
    this.closedPositions.push(position);

    // Log trade
    this.logTradeClose(position);

    return position;
  }

  /**
   * Get closed positions (most recent first)
   */
  getClosedPositions(limit = 50): TPosition[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  /**
   * Get total unrealized PnL
   */
  getUnrealizedPnL(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.unrealizedPnL, 0);
  }

  /**
   * Get trading statistics
   */
  getStats(): TStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);

    const totalWins = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));

    const realizedPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    const reservedMargin = this.getOpenPositions().reduce((sum, p) => sum + p.marginUsed, 0);
    const effectiveBalance = this.balance + reservedMargin;

    const maxDrawdown = this.peakBalance - effectiveBalance;

    const stats: BaseBotStats = {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0
        ? (wins.length / this.closedPositions.length) * 100
        : 0,
      totalPnL: realizedPnL,
      totalPnLPercent: (realizedPnL / this.config.initialBalance) * 100,
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
      maxDrawdown,
      maxDrawdownPercent: this.peakBalance > 0 ? (maxDrawdown / this.peakBalance) * 100 : 0,
    };

    return stats as TStats;
  }

  /**
   * Reset bot to initial state
   */
  reset(): void {
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.onReset();
  }

  /**
   * Update initial balance configuration
   */
  setInitialBalance(amount: number): void {
    this.config.initialBalance = amount;
  }

  // ============= Logging Hooks =============

  protected logTradeOpen(position: TPosition, data: TMarketData): void {
    try {
      getDataPersistence().logTradeOpen(this.config.botId, position as any, data as any);
    } catch (e) {
      // Don't fail trading on logging errors
    }

    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[${this.config.botId} ${timestamp}] OPENED: ${position.symbol} ${position.direction.toUpperCase()} @ ${position.entryPrice.toPrecision(6)} | ` +
      `SL: ${position.stopLossPrice.toPrecision(6)}${position.takeProfitPrice ? ` | TP: ${position.takeProfitPrice.toPrecision(6)}` : ''}`
    );
  }

  protected logTradeClose(position: TPosition): void {
    try {
      getDataPersistence().logTradeClose(this.config.botId, position as any);
    } catch (e) {
      // Don't fail trading on logging errors
    }

    const timestamp = new Date().toLocaleTimeString();
    const pnlStr = (position.realizedPnL || 0) >= 0
      ? `+$${(position.realizedPnL || 0).toFixed(2)}`
      : `-$${Math.abs(position.realizedPnL || 0).toFixed(2)}`;

    console.log(
      `[${this.config.botId} ${timestamp}] CLOSED: ${position.symbol} ${position.direction.toUpperCase()} @ ${position.exitPrice?.toPrecision(6)} | ` +
      `PnL: ${pnlStr} (${(position.realizedPnLPercent || 0).toFixed(2)}% ROI) | ${position.exitReason}`
    );
  }

  // ============= Event Hooks (optional overrides) =============

  protected onBreakevenLocked(position: TPosition): void {
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[${this.config.botId} ${timestamp}] BREAKEVEN LOCK: ${position.symbol} - SL moved to entry @ ${position.entryPrice.toPrecision(6)}`
    );
  }

  protected onTrailingActivated(position: TPosition): void {
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[${this.config.botId} ${timestamp}] TRAILING ACTIVATED: ${position.symbol}`
    );
  }

  protected onTrailingMoved(position: TPosition, level: number, lockedROI: number): void {
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[${this.config.botId} ${timestamp}] TRAIL L${level}: ${position.symbol} SL moved to ${position.stopLossPrice.toPrecision(6)} (locking ${lockedROI.toFixed(1)}% ROI)`
    );
  }

  protected onReset(): void {
    console.log(`[${this.config.botId}] Reset to initial state: $${this.balance.toFixed(2)}`);
  }
}

// ============= Single Position Bot Mixin =============

/**
 * Abstract class for bots that maintain only one position at a time (e.g., BTC bots)
 */
export abstract class SinglePositionBot<
  TConfig extends BaseBotConfig = BaseBotConfig,
  TPosition extends BasePosition = BasePosition,
  TMarketData extends MarketData = MarketData,
  TStats extends BaseBotStats = BaseBotStats
> extends BaseBot<TConfig, TPosition, TMarketData, TStats> {
  protected position: TPosition | null = null;

  protected getPositionKey(_data: TMarketData): string {
    return 'single'; // Single position - always same key
  }

  public getOpenPositions(): TPosition[] {
    return this.position ? [this.position] : [];
  }

  protected hasPosition(_key: string): boolean {
    return this.position !== null;
  }

  protected storePosition(_key: string, position: TPosition): void {
    this.position = position;
  }

  protected getPosition(_key: string): TPosition | undefined {
    return this.position || undefined;
  }

  protected removePosition(_key: string): void {
    this.position = null;
  }

  protected getPositionCount(): number {
    return this.position ? 1 : 0;
  }

  /**
   * Get the single position (convenience method)
   */
  getPosition2(): TPosition | null {
    return this.position;
  }

  protected onReset(): void {
    this.position = null;
    super.onReset();
  }
}

// ============= Multi Position Bot Mixin =============

/**
 * Abstract class for bots that can hold multiple positions (e.g., Golden Pocket, Paper Trading)
 */
export abstract class MultiPositionBot<
  TConfig extends BaseBotConfig = BaseBotConfig,
  TPosition extends BasePosition = BasePosition,
  TMarketData extends MarketData = MarketData,
  TStats extends BaseBotStats = BaseBotStats
> extends BaseBot<TConfig, TPosition, TMarketData, TStats> {
  protected positions: Map<string, TPosition> = new Map();

  public getOpenPositions(): TPosition[] {
    return Array.from(this.positions.values());
  }

  protected hasPosition(key: string): boolean {
    return this.positions.has(key);
  }

  protected storePosition(key: string, position: TPosition): void {
    this.positions.set(key, position);
  }

  protected getPosition(key: string): TPosition | undefined {
    return this.positions.get(key);
  }

  protected removePosition(key: string): void {
    this.positions.delete(key);
  }

  protected getPositionCount(): number {
    return this.positions.size;
  }

  /**
   * Get all open symbols (for price fetching)
   */
  getOpenSymbols(): string[] {
    const symbols = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.status === 'open') {
        symbols.add(position.symbol);
      }
    }
    return Array.from(symbols);
  }

  /**
   * Update all positions with a price map
   */
  updateAllPositionsWithPrices(priceMap: Map<string, number>): void {
    for (const position of this.positions.values()) {
      const price = priceMap.get(position.symbol);
      if (price && position.status === 'open') {
        position.currentPrice = price;

        const { pnl, pnlPercent } = this.calculatePnL(
          position.entryPrice,
          price,
          position.direction,
          position.notionalSize
        );

        position.unrealizedPnL = pnl;
        position.unrealizedPnLPercent = pnlPercent;
      }
    }
  }

  protected onReset(): void {
    this.positions.clear();
    super.onReset();
  }
}
