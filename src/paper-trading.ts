import type { BackburnerSetup, MarketType } from './types.js';
import { getDataPersistence } from './data-persistence.js';
import { ExecutionCostsCalculator, determineVolatility, type TradeCosts } from './execution-costs.js';

// Debug logging - set to true to see detailed paper trading decisions
const DEBUG_PAPER_TRADING = false;  // Disabled - was too spammy
const DEBUG_IMPORTANT_ONLY = true;  // Only log opens/closes, not skips

function debugLog(message: string, data?: Record<string, unknown>, important = false): void {
  // Skip all debug if disabled
  if (!DEBUG_PAPER_TRADING && !important) return;
  // If only important logging is enabled, skip non-important messages
  if (!DEBUG_PAPER_TRADING && DEBUG_IMPORTANT_ONLY && !important) return;

  const timestamp = new Date().toLocaleTimeString();
  if (data) {
    console.error(`[PT ${timestamp}] ${message}`, JSON.stringify(data));
  } else {
    console.error(`[PT ${timestamp}] ${message}`);
  }
}

// Paper trading configuration
export interface PaperTradingConfig {
  initialBalance: number;      // Starting balance (e.g., $2000)
  positionSizePercent: number; // % of balance per trade (e.g., 1%)
  leverage: number;            // Leverage multiplier (e.g., 10x)
  takeProfitPercent: number;   // Take profit % (e.g., 20%)
  stopLossPercent: number;     // Stop loss % (e.g., 20%)
  maxOpenPositions: number;    // Max concurrent positions
  requireFutures?: boolean;    // Only trade setups available on futures (default true)
  breakevenTriggerPercent?: number;  // Move SL to breakeven when ROI hits this % (e.g., 10)
  enableFriction?: boolean;    // Enable execution costs modeling (fees + slippage)
}

export const DEFAULT_PAPER_CONFIG: PaperTradingConfig = {
  initialBalance: 2000,
  positionSizePercent: 1,      // 1% of balance = $20 margin
  leverage: 10,                // 10x leverage = $200 notional
  takeProfitPercent: 20,       // 20% profit target (or RSI played_out, whichever first)
  stopLossPercent: 20,         // 20% stop loss
  maxOpenPositions: 10,        // Max 10 positions at once
};

// Position status
export type PositionStatus = 'open' | 'closed_tp' | 'closed_sl' | 'closed_breakeven' | 'closed_played_out';

// A paper trading position
export interface PaperPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;
  timeframe: string;

  // Entry details
  entryPrice: number;
  entryTime: number;
  marginUsed: number;          // Actual margin (e.g., $20)
  notionalSize: number;        // Leveraged size (e.g., $200)
  leverage: number;

  // Targets
  takeProfitPrice: number;
  stopLossPrice: number;
  initialStopLossPrice?: number;  // Original SL before breakeven lock
  breakevenLocked?: boolean;      // Whether SL has been moved to breakeven

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Exit details (if closed)
  status: PositionStatus;
  exitPrice?: number;
  exitTime?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;

  // Friction costs (if enabled)
  entryCosts?: number;
  exitCosts?: number;
  totalCosts?: number;
}

// Trading stats
export interface TradingStats {
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
  profitFactor: number;        // Gross profit / Gross loss
  currentBalance: number;
  peakBalance: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
}

/**
 * Paper Trading Engine
 * Simulates trading based on Backburner signals
 */
export class PaperTradingEngine {
  private config: PaperTradingConfig;
  private positions: Map<string, PaperPosition> = new Map();
  private closedPositions: PaperPosition[] = [];
  private balance: number;
  private peakBalance: number;
  private botId: string;
  private lastSetups: Map<string, BackburnerSetup> = new Map(); // Track setups for logging
  private costsCalculator: ExecutionCostsCalculator | null = null;

  constructor(config?: Partial<PaperTradingConfig>, botId = 'default') {
    this.config = { ...DEFAULT_PAPER_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;

    // Initialize friction modeling if enabled
    if (this.config.enableFriction) {
      this.costsCalculator = new ExecutionCostsCalculator();
    }
  }

  /**
   * Get bot ID
   */
  getBotId(): string {
    return this.botId;
  }

  /**
   * Generate unique position ID
   */
  private generatePositionId(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}-${Date.now()}`;
  }

  /**
   * Get position key for tracking (one position per symbol/timeframe/direction/market)
   */
  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
  }

  /**
   * Calculate position size based on config
   */
  private calculatePositionSize(): { margin: number; notional: number } {
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;
    return { margin, notional };
  }

  /**
   * Calculate TP/SL targets - now structure-aware (TCG compliant)
   * Prefers structure-based stop (below pullback low) over fixed % stop
   */
  private calculateTargets(
    entryPrice: number,
    direction: 'long' | 'short',
    structureStopPrice?: number
  ): { takeProfit: number; stopLoss: number } {
    const tpPercent = this.config.takeProfitPercent / 100;
    const slPercent = this.config.stopLossPercent / 100;

    let stopLoss: number;

    // TCG-COMPLIANT: Use structure-based stop if available
    if (structureStopPrice !== undefined) {
      const stopDistance = Math.abs(structureStopPrice - entryPrice) / entryPrice;
      // Only use structure stop if it's between 0.5% and 10% from entry
      if (stopDistance >= 0.005 && stopDistance <= 0.10) {
        stopLoss = structureStopPrice;
      } else {
        // Fall back to fixed %
        stopLoss = direction === 'long'
          ? entryPrice * (1 - slPercent)
          : entryPrice * (1 + slPercent);
      }
    } else {
      stopLoss = direction === 'long'
        ? entryPrice * (1 - slPercent)
        : entryPrice * (1 + slPercent);
    }

    const takeProfit = direction === 'long'
      ? entryPrice * (1 + tpPercent)
      : entryPrice * (1 - tpPercent);

    return { takeProfit, stopLoss };
  }

  /**
   * Open a new position based on a triggered setup
   */
  openPosition(setup: BackburnerSetup): PaperPosition | null {
    const key = this.getPositionKey(setup);

    // Only trade on triggered or deep_extreme
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only trade futures setups (realistic for leveraged trading on MEXC)
    // Default to true if not specified - we want realistic paper trading
    const requireFutures = this.config.requireFutures !== false;
    if (requireFutures && setup.marketType !== 'futures') {
      return null;
    }

    // Check if we already have a position for this symbol/direction
    if (this.positions.has(key)) {
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Calculate position size
    const { margin, notional } = this.calculatePositionSize();

    // Check if we have enough balance
    if (margin > this.balance) {
      return null;
    }

    const entryPrice = setup.currentPrice;
    // TCG-COMPLIANT: Pass structure-based stop price if available
    const { takeProfit, stopLoss } = this.calculateTargets(
      entryPrice,
      setup.direction,
      setup.structureStopPrice
    );

    // Calculate entry costs if friction is enabled
    let entryCosts = 0;
    if (this.costsCalculator) {
      const volatility = determineVolatility(setup.currentRSI);
      const costs = this.costsCalculator.calculateEntryCosts(
        entryPrice,
        notional,
        setup.direction,
        volatility
      );
      entryCosts = costs.entryCosts;
    }

    const position: PaperPosition = {
      id: this.generatePositionId(setup),
      symbol: setup.symbol,
      direction: setup.direction,
      marketType: setup.marketType,
      timeframe: setup.timeframe,
      entryPrice,
      entryTime: Date.now(),
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,
      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
      initialStopLossPrice: stopLoss,  // Store original SL for breakeven tracking
      breakevenLocked: false,
      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      status: 'open',
      entryCosts,  // Track entry friction costs
    };

    // Reserve margin (entry costs are deducted from PnL at close)
    this.balance -= margin;
    this.positions.set(key, position);

    // Track setup for logging
    this.lastSetups.set(key, setup);

    // Log to persistence
    try {
      getDataPersistence().logTradeOpen(this.botId, position, setup);
    } catch (e) {
      // Don't fail trading on logging errors
    }

    debugLog(`OPENED: ${setup.symbol} ${setup.direction.toUpperCase()} ${setup.timeframe} @ ${entryPrice}`, {
      key,
      tp: takeProfit,
      sl: stopLoss,
    }, true);  // Important - always log

    return position;
  }

  /**
   * Update position with current price and check for exits
   */
  updatePosition(setup: BackburnerSetup): PaperPosition | null {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position) {
      return null;
    }

    // Guard: Check if position is already closed (race condition prevention)
    if (position.status !== 'open') {
      return null;
    }

    // Update current price
    position.currentPrice = setup.currentPrice;

    // Calculate unrealized PnL
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.unrealizedPnL = position.notionalSize * priceChange;
    position.unrealizedPnLPercent = priceChange * 100;

    // Breakeven lock: Move SL to entry price when profit exceeds trigger
    if (this.config.breakevenTriggerPercent !== undefined &&
        !position.breakevenLocked &&
        position.unrealizedPnLPercent >= this.config.breakevenTriggerPercent) {
      // Lock in breakeven
      position.initialStopLossPrice = position.stopLossPrice;
      position.stopLossPrice = position.entryPrice;
      position.breakevenLocked = true;
      debugLog(`BREAKEVEN LOCK: ${position.symbol} ${position.direction.toUpperCase()} - SL moved to entry @ ${position.entryPrice}`, {
        triggerPercent: this.config.breakevenTriggerPercent,
        currentPnLPercent: position.unrealizedPnLPercent,
      }, true);
    }

    // Check for exit conditions
    let shouldClose = false;
    let exitReason = '';
    let exitStatus: PositionStatus = 'open';

    // Check take profit
    if (position.direction === 'long' && position.currentPrice >= position.takeProfitPrice) {
      shouldClose = true;
      exitReason = 'Take Profit Hit';
      exitStatus = 'closed_tp';
    } else if (position.direction === 'short' && position.currentPrice <= position.takeProfitPrice) {
      shouldClose = true;
      exitReason = 'Take Profit Hit';
      exitStatus = 'closed_tp';
    }

    // Check stop loss
    if (position.direction === 'long' && position.currentPrice <= position.stopLossPrice) {
      shouldClose = true;
      // Differentiate between breakeven exit and regular stop loss
      if (position.breakevenLocked) {
        exitReason = 'Breakeven Stop Hit';
        exitStatus = 'closed_breakeven';
      } else {
        exitReason = 'Stop Loss Hit';
        exitStatus = 'closed_sl';
      }
    } else if (position.direction === 'short' && position.currentPrice >= position.stopLossPrice) {
      shouldClose = true;
      if (position.breakevenLocked) {
        exitReason = 'Breakeven Stop Hit';
        exitStatus = 'closed_breakeven';
      } else {
        exitReason = 'Stop Loss Hit';
        exitStatus = 'closed_sl';
      }
    }

    // Check if setup played out
    if (setup.state === 'played_out') {
      shouldClose = true;
      exitReason = 'Setup Played Out';
      exitStatus = 'closed_played_out';
    }

    if (shouldClose) {
      this.closePosition(position, exitStatus, exitReason);
    }

    return position;
  }

  /**
   * Close a position
   */
  private closePosition(position: PaperPosition, status: PositionStatus, reason: string): void {
    const key = `${position.symbol}-${position.timeframe}-${position.direction}-${position.marketType}`;

    // Guard: Check if position is still open (prevent duplicate closes)
    if (!this.positions.has(key)) {
      return; // Already closed
    }

    // Guard: Check if already closed (status already set)
    if (position.status !== 'open') {
      return; // Already closed
    }

    // Calculate final PnL (raw, before friction)
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    let rawPnL = position.notionalSize * priceChange;

    // Calculate exit costs if friction is enabled
    let exitCosts = 0;
    let totalCosts = position.entryCosts || 0;
    if (this.costsCalculator) {
      const costs = this.costsCalculator.calculateExitCosts(
        position.currentPrice,
        position.notionalSize,
        position.direction,
        'normal'  // Use normal volatility for exit
      );
      exitCosts = costs.exitCosts;
      totalCosts += exitCosts;
    }

    // Apply friction to realized PnL
    position.realizedPnL = rawPnL - totalCosts;
    position.realizedPnLPercent = (position.realizedPnL / position.marginUsed) * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;
    position.exitCosts = exitCosts;
    position.totalCosts = totalCosts;

    // IMPORTANT: Remove from positions map FIRST to prevent duplicate closes
    this.positions.delete(key);

    // Return margin + PnL to balance
    this.balance += position.marginUsed + position.realizedPnL;

    // Update peak balance
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Log to persistence
    try {
      getDataPersistence().logTradeClose(this.botId, position);
    } catch (e) {
      // Don't fail trading on logging errors
    }

    debugLog(`CLOSED: ${position.symbol} ${position.direction.toUpperCase()} ${position.timeframe} - ${reason} | PnL: $${position.realizedPnL?.toFixed(2)}`, {
      key,
      entry: position.entryPrice,
      exit: position.exitPrice,
    }, true);  // Important - always log

    // Move to closed positions
    this.closedPositions.push(position);

    // Clean up setup tracking
    this.lastSetups.delete(key);
  }

  /**
   * Handle setup removed - DO NOT close position
   * Positions will only close via TP/SL or RSI played_out
   * This prevents premature exits when setups cycle
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position) return;

    // Just update the price, don't close
    position.currentPrice = setup.currentPrice;

    // Recalculate unrealized PnL
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.unrealizedPnL = position.notionalSize * priceChange;
    position.unrealizedPnLPercent = priceChange * 100;

    debugLog(`SETUP REMOVED (keeping position): ${setup.symbol} ${setup.direction.toUpperCase()} ${setup.timeframe}`, {
      key,
      pnl: position.unrealizedPnL.toFixed(2),
    }, true);

    // Position stays open - will be closed by TP/SL or manual intervention
    // Mark as orphaned so we know to fetch prices directly
    (position as any).orphaned = true;
  }

  /**
   * Update orphaned positions with current prices from API
   */
  async updateOrphanedPositions(getPriceFn: (symbol: string) => Promise<number>): Promise<void> {
    for (const [key, position] of this.positions) {
      if (!(position as any).orphaned) continue;

      // Guard: Check if position is already closed (race condition prevention)
      if (position.status !== 'open') continue;

      try {
        const currentPrice = await getPriceFn(position.symbol);
        position.currentPrice = currentPrice;

        // Recalculate PnL
        const priceChange = position.direction === 'long'
          ? (currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - currentPrice) / position.entryPrice;

        position.unrealizedPnL = position.notionalSize * priceChange;
        position.unrealizedPnLPercent = priceChange * 100;

        // Check TP/SL
        if (position.direction === 'long') {
          if (currentPrice >= position.takeProfitPrice) {
            this.closePosition(position, 'closed_tp', 'Take Profit Hit');
          } else if (currentPrice <= position.stopLossPrice) {
            this.closePosition(position, 'closed_sl', 'Stop Loss Hit');
          }
        } else {
          if (currentPrice <= position.takeProfitPrice) {
            this.closePosition(position, 'closed_tp', 'Take Profit Hit');
          } else if (currentPrice >= position.stopLossPrice) {
            this.closePosition(position, 'closed_sl', 'Stop Loss Hit');
          }
        }
      } catch (error) {
        // Silently fail - will retry next cycle
      }
    }
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get closed positions (most recent first)
   */
  getClosedPositions(limit = 50): PaperPosition[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  /**
   * Get trading statistics
   */
  getStats(): TradingStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) < 0);

    const totalWins = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));

    // Calculate realized P&L only from closed positions (not affected by open position margin)
    const realizedPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    // Current balance includes reserved margin for open positions, so add it back for true balance
    const reservedMargin = Array.from(this.positions.values()).reduce((sum, p) => sum + p.marginUsed, 0);
    const effectiveBalance = this.balance + reservedMargin;

    const maxDrawdown = this.peakBalance - Math.min(effectiveBalance, ...this.closedPositions.map(p => {
      return this.config.initialBalance; // Simplified
    }));

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0
        ? (wins.length / this.closedPositions.length) * 100
        : 0,
      totalPnL: realizedPnL,  // Only realized P&L from closed trades
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
      currentBalance: effectiveBalance,  // Show balance as if no positions were open
      peakBalance: this.peakBalance,
      maxDrawdown: this.peakBalance - effectiveBalance,
      maxDrawdownPercent: ((this.peakBalance - effectiveBalance) / this.peakBalance) * 100,
    };
  }

  /**
   * Get current balance
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Get total unrealized PnL
   */
  getUnrealizedPnL(): number {
    return Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.unrealizedPnL, 0);
  }

  /**
   * Get config
   */
  getConfig(): PaperTradingConfig {
    return { ...this.config };
  }

  /**
   * Reset paper trading (start fresh)
   */
  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  /**
   * Update the initial balance configuration
   * Used when syncing with real MEXC investment amount
   */
  setInitialBalance(amount: number): void {
    this.config.initialBalance = amount;
  }
}
