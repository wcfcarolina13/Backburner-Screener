import type { BackburnerSetup, MarketType } from './types.js';
import { getDataPersistence } from './data-persistence.js';
import type { GoldenPocketSetup } from './golden-pocket-detector.js';
import { ExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

/**
 * Golden Pocket Bot Configuration
 *
 * Specialized for the Golden Pocket (Fibonacci) strategy:
 * - Entry in the 0.618-0.65 zone
 * - Stop loss at 0.786 (invalidation)
 * - TP1 at 0.382 (50% of position)
 * - TP2 at 0.0 / swing high retest (remaining 50%)
 */
export interface GoldenPocketBotConfig {
  initialBalance: number;
  positionSizePercent: number;  // % of balance per trade
  leverage: number;
  maxOpenPositions: number;
  requireFutures?: boolean;
  enableFriction?: boolean;     // Enable execution costs modeling (fees + slippage)

  // Split entry configuration (limit orders across the pocket)
  splitEntry: boolean;          // If true, simulate split entries
  entryLevels: number[];        // Fibonacci levels for entries (default: [0.618, 0.635, 0.65])
  entryWeights: number[];       // Weight for each entry level (default: [0.33, 0.33, 0.34])
}

const DEFAULT_CONFIG: GoldenPocketBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 2,       // 2% per trade (more aggressive for hype plays)
  leverage: 10,
  maxOpenPositions: 5,          // Fewer positions, more focused
  requireFutures: true,
  splitEntry: false,            // Start simple - single entry at golden pocket
  entryLevels: [0.618, 0.635, 0.65],
  entryWeights: [0.33, 0.33, 0.34],
};

// Position status with partial close support
export type GPPositionStatus =
  | 'open'
  | 'partial_tp1'      // Hit TP1, closed 50%
  | 'closed_tp1'       // Closed at TP1 only
  | 'closed_tp2'       // Closed at TP2 (full target)
  | 'closed_sl'        // Stop loss hit
  | 'closed_invalidated'; // Broke 0.786 level

export interface GoldenPocketPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;
  timeframe: string;

  // Entry details
  entryPrice: number;           // Average entry price
  entryTime: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Fibonacci-based targets
  tp1Price: number;             // 0.382 level
  tp2Price: number;             // Swing high (0.0 level)
  stopPrice: number;            // 0.786 level

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Partial close tracking
  status: GPPositionStatus;
  remainingSize: number;        // Notional remaining after partial closes
  tp1Closed: boolean;           // Whether TP1 was hit
  tp1PnL?: number;              // PnL from TP1 close

  // Exit details
  exitPrice?: number;
  exitTime?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;

  // Friction costs (if enabled)
  entryCosts?: number;
  exitCosts?: number;
  totalCosts?: number;

  // Golden Pocket specific
  fibHigh: number;              // Swing high for reference
  fibLow: number;               // Swing low for reference
  retracementAtEntry: number;   // Where in the pocket we entered
}

export interface GoldenPocketStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  currentBalance: number;
  peakBalance: number;
  maxDrawdown: number;
  // Golden Pocket specific
  tp1HitRate: number;           // % of trades that hit TP1
  tp2HitRate: number;           // % of trades that hit TP2 (full target)
  avgRetracementAtEntry: number; // Average entry point in the pocket
}

/**
 * Golden Pocket Trading Bot
 *
 * Specialized bot for the Fibonacci Golden Pocket strategy.
 * Features:
 * - Fibonacci-based entry, stop, and targets
 * - Partial position closes (50% at TP1, 50% at TP2)
 * - Tracks retracement levels for analysis
 */
export class GoldenPocketBot {
  private config: GoldenPocketBotConfig;
  private positions: Map<string, GoldenPocketPosition> = new Map();
  private closedPositions: GoldenPocketPosition[] = [];
  private balance: number;
  private peakBalance: number;
  private botId: string;
  private costsCalculator: ExecutionCostsCalculator | null = null;

  // Stats tracking
  private tp1Hits: number = 0;
  private tp2Hits: number = 0;
  private totalRetracementAtEntry: number = 0;

  constructor(config?: Partial<GoldenPocketBotConfig>, botId = 'golden-pocket') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;

    // Initialize friction modeling if enabled
    if (this.config.enableFriction) {
      this.costsCalculator = new ExecutionCostsCalculator();
    }
  }

  getBotId(): string {
    return this.botId;
  }

  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
  }

  private generatePositionId(setup: BackburnerSetup): string {
    return `gp-${setup.symbol}-${setup.timeframe}-${Date.now()}`;
  }

  /**
   * Check if this is a Golden Pocket setup (has fibLevels)
   */
  private isGoldenPocketSetup(setup: BackburnerSetup): setup is GoldenPocketSetup {
    return 'fibLevels' in setup && 'tp1Price' in setup && 'stopPrice' in setup;
  }

  /**
   * Open a position on a Golden Pocket setup
   */
  openPosition(setup: BackburnerSetup): GoldenPocketPosition | null {
    // Must be a Golden Pocket setup
    if (!this.isGoldenPocketSetup(setup)) {
      return null;
    }

    // Only trade triggered or deep_extreme
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only futures
    if (this.config.requireFutures && setup.marketType !== 'futures') {
      return null;
    }

    const key = this.getPositionKey(setup);

    // Check for existing position
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

    const entryPrice = setup.currentPrice;

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

    const position: GoldenPocketPosition = {
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

      // Use Fibonacci-based targets from the setup
      tp1Price: setup.tp1Price,
      tp2Price: setup.tp2Price,
      stopPrice: setup.stopPrice,

      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,

      status: 'open',
      remainingSize: notional,
      tp1Closed: false,
      entryCosts,  // Track entry friction costs

      fibHigh: setup.fibLevels.high,
      fibLow: setup.fibLevels.low,
      retracementAtEntry: setup.retracementPercent,
    };

    // Reserve margin
    this.balance -= margin;
    this.positions.set(key, position);

    // Track for stats
    this.totalRetracementAtEntry += setup.retracementPercent;

    // Log
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[GP:${this.botId} ${timestamp}] OPENED: ${setup.symbol} ${setup.direction.toUpperCase()} @ ${entryPrice.toPrecision(6)} | ` +
      `Retracement: ${setup.retracementPercent.toFixed(1)}% | TP1: ${setup.tp1Price.toPrecision(6)} | TP2: ${setup.tp2Price.toPrecision(6)} | SL: ${setup.stopPrice.toPrecision(6)}`
    );

    // Persist - map GP position fields to PaperPosition format for logging
    try {
      const logPosition = {
        ...position,
        takeProfitPrice: position.tp1Price,  // Map TP1 as initial target
        stopLossPrice: position.stopPrice,
      };
      getDataPersistence().logTradeOpen(this.botId, logPosition as any, setup);
    } catch (e) {
      console.error(`[GP:${this.botId}] Failed to log trade open:`, e);
    }

    return position;
  }

  /**
   * Update position with current price
   */
  updatePosition(setup: BackburnerSetup): GoldenPocketPosition | null {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position || position.status === 'closed_tp2' || position.status === 'closed_sl' || position.status === 'closed_invalidated') {
      return null;
    }

    // Update price
    position.currentPrice = setup.currentPrice;

    // Calculate unrealized PnL on remaining position
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.unrealizedPnL = position.remainingSize * priceChange;
    position.unrealizedPnLPercent = priceChange * 100;

    // Check exit conditions
    this.checkExitConditions(position, setup);

    return position;
  }

  /**
   * Check and handle exit conditions
   */
  private checkExitConditions(position: GoldenPocketPosition, setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);

    // For LONG positions
    if (position.direction === 'long') {
      // Check stop loss first (0.786 invalidation)
      if (position.currentPrice <= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      // Check TP1 (0.382 level) - partial close
      if (!position.tp1Closed && position.currentPrice >= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      // Check TP2 (swing high retest)
      if (position.currentPrice >= position.tp2Price * 0.998) { // Within 0.2% of target
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing High Retest)');
        return;
      }
    }

    // For SHORT positions (if we add them later)
    if (position.direction === 'short') {
      if (position.currentPrice >= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      if (!position.tp1Closed && position.currentPrice <= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      if (position.currentPrice <= position.tp2Price * 1.002) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing Low Retest)');
        return;
      }
    }
  }

  /**
   * Partial close at TP1 (50% of position)
   */
  private partialClose(position: GoldenPocketPosition, level: 'tp1'): void {
    if (level === 'tp1' && !position.tp1Closed) {
      // Close 50% of position
      const closeSize = position.notionalSize * 0.5;
      const priceChange = position.direction === 'long'
        ? (position.currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - position.currentPrice) / position.entryPrice;

      let rawPnL = closeSize * priceChange;

      // Calculate exit costs for partial close if friction enabled
      let partialExitCosts = 0;
      if (this.costsCalculator) {
        const costs = this.costsCalculator.calculateExitCosts(
          position.currentPrice,
          closeSize,
          position.direction,
          'normal'
        );
        partialExitCosts = costs.exitCosts;
      }

      // Apply friction: 50% of entry costs + exit costs for this partial
      const partialEntryCosts = (position.entryCosts || 0) * 0.5;
      const partialTotalCosts = partialEntryCosts + partialExitCosts;
      const pnl = rawPnL - partialTotalCosts;

      position.tp1Closed = true;
      position.tp1PnL = pnl;
      position.remainingSize = position.notionalSize * 0.5;
      position.status = 'partial_tp1';
      // Track remaining entry costs for final close
      position.entryCosts = (position.entryCosts || 0) * 0.5;

      // Return partial margin + PnL to balance
      const marginReturn = position.marginUsed * 0.5;
      this.balance += marginReturn + pnl;
      position.marginUsed *= 0.5;

      // Update peak balance
      if (this.balance > this.peakBalance) {
        this.peakBalance = this.balance;
      }

      this.tp1Hits++;

      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `[GP:${this.botId} ${timestamp}] PARTIAL TP1: ${position.symbol} | Closed 50% @ ${position.currentPrice.toPrecision(6)} | ` +
        `PnL: $${pnl.toFixed(2)} (${(priceChange * 100).toFixed(2)}%) | Remaining: $${position.remainingSize.toFixed(2)}`
      );
    }
  }

  /**
   * Fully close position
   */
  private closePosition(position: GoldenPocketPosition, status: GPPositionStatus, reason: string): void {
    const key = `${position.symbol}-${position.timeframe}-${position.direction}-${position.marketType}`;

    if (!this.positions.has(key)) {
      return;
    }

    // Calculate final PnL on remaining size (raw, before friction)
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    let rawRemainingPnL = position.remainingSize * priceChange;

    // Calculate exit costs for remaining position if friction enabled
    let exitCosts = 0;
    let totalCosts = position.entryCosts || 0;
    if (this.costsCalculator) {
      const costs = this.costsCalculator.calculateExitCosts(
        position.currentPrice,
        position.remainingSize,
        position.direction,
        'normal'
      );
      exitCosts = costs.exitCosts;
      totalCosts += exitCosts;
    }

    const remainingPnL = rawRemainingPnL - totalCosts;
    const totalPnL = (position.tp1PnL || 0) + remainingPnL;

    position.realizedPnL = totalPnL;
    position.realizedPnLPercent = (totalPnL / position.notionalSize) * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;
    position.exitCosts = exitCosts;
    position.totalCosts = totalCosts;

    // Return remaining margin + PnL
    this.balance += position.marginUsed + remainingPnL;

    // Update peak balance
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Track stats
    if (status === 'closed_tp2') {
      this.tp2Hits++;
    }

    // Remove from active
    this.positions.delete(key);
    this.closedPositions.push(position);

    const timestamp = new Date().toLocaleTimeString();
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;
    console.log(
      `[GP:${this.botId} ${timestamp}] CLOSED: ${position.symbol} | ${reason} | ` +
      `PnL: ${pnlStr} (${position.realizedPnLPercent?.toFixed(2)}%) | Balance: $${this.balance.toFixed(2)}`
    );

    // Persist - map GP position fields to PaperPosition format for logging
    try {
      const logPosition = {
        ...position,
        takeProfitPrice: position.tp1Price,
        stopLossPrice: position.stopPrice,
        exitPrice: position.exitPrice || position.currentPrice,
        exitTime: position.exitTime || Date.now(),
        exitReason: reason,
        realizedPnL: totalPnL,
        realizedPnLPercent: position.realizedPnLPercent,
      };
      getDataPersistence().logTradeClose(this.botId, logPosition as any);
    } catch (e) {
      console.error(`[GP:${this.botId}] Failed to log trade close:`, e);
    }
  }

  /**
   * Handle setup removal (close if invalidated)
   */
  onSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (position && position.status === 'open') {
      // Keep position open - we have our own stop loss logic
      // Only close if setup explicitly marked as invalidated
      if (setup.state === 'played_out') {
        // Check if we're in profit or loss
        const priceChange = position.direction === 'long'
          ? (position.currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - position.currentPrice) / position.entryPrice;

        if (priceChange < 0) {
          // In loss - let stop loss handle it
          return;
        }

        // In profit - might want to take it
        if (priceChange > 0.05) { // 5% profit
          this.closePosition(position, 'closed_tp1', 'Setup Removed (In Profit)');
        }
      }
    }
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): GoldenPocketPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get closed positions
   */
  getClosedPositions(limit = 50): GoldenPocketPosition[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  /**
   * Get statistics
   */
  getStats(): GoldenPocketStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);
    const totalPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0 ? (wins.length / this.closedPositions.length) * 100 : 0,
      totalPnL,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      maxDrawdown: this.peakBalance - Math.min(this.balance, ...this.closedPositions.map(() => this.balance)),
      tp1HitRate: this.closedPositions.length > 0 ? (this.tp1Hits / this.closedPositions.length) * 100 : 0,
      tp2HitRate: this.closedPositions.length > 0 ? (this.tp2Hits / this.closedPositions.length) * 100 : 0,
      avgRetracementAtEntry: this.closedPositions.length > 0
        ? this.totalRetracementAtEntry / (this.closedPositions.length + this.positions.size)
        : 0,
    };
  }

  /**
   * Get current balance
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Get total unrealized P&L from all open positions
   */
  getUnrealizedPnL(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.unrealizedPnL || 0;
    }
    return total;
  }

  /**
   * Update all positions with current prices
   * Called periodically to keep unrealized P&L up to date
   */
  updateAllPositionsWithPrices(priceMap: Map<string, number>): void {
    for (const [key, position] of this.positions) {
      const price = priceMap.get(position.symbol);
      if (price && (position.status === 'open' || position.status === 'partial_tp1')) {
        position.currentPrice = price;

        // Calculate unrealized PnL on remaining position
        const priceChange = position.direction === 'long'
          ? (position.currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - position.currentPrice) / position.entryPrice;

        position.unrealizedPnL = position.remainingSize * priceChange;
        position.unrealizedPnLPercent = priceChange * 100;

        // Check exit conditions with current price
        this.checkExitConditionsWithPrice(position, price);
      }
    }
  }

  /**
   * Check exit conditions using just price (no setup needed)
   */
  private checkExitConditionsWithPrice(position: GoldenPocketPosition, currentPrice: number): void {
    // For LONG positions
    if (position.direction === 'long') {
      // Check stop loss first (0.786 invalidation)
      if (currentPrice <= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      // Check TP1 (0.382 level) - partial close
      if (!position.tp1Closed && currentPrice >= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      // Check TP2 (swing high retest)
      if (currentPrice >= position.tp2Price * 0.998) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing High Retest)');
        return;
      }
    }

    // For SHORT positions
    if (position.direction === 'short') {
      // Check stop loss
      if (currentPrice >= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      // Check TP1
      if (!position.tp1Closed && currentPrice <= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      // Check TP2 (swing low retest)
      if (currentPrice <= position.tp2Price * 1.002) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing Low Retest)');
        return;
      }
    }
  }

  /**
   * Get all symbols with open positions (for price fetching)
   */
  getOpenSymbols(): string[] {
    const symbols = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.status === 'open' || position.status === 'partial_tp1') {
        symbols.add(position.symbol);
      }
    }
    return Array.from(symbols);
  }

  /**
   * Restore state from persistence
   */
  restoreState(
    positions: GoldenPocketPosition[],
    closedPositions: GoldenPocketPosition[],
    balance: number
  ): void {
    this.positions.clear();
    for (const pos of positions) {
      const key = `${pos.symbol}-${pos.timeframe}-${pos.direction}-${pos.marketType}`;
      this.positions.set(key, pos);
    }
    this.closedPositions = closedPositions;
    this.balance = balance;

    console.log(`[GP:${this.botId}] Restored state: ${positions.length} open, ${closedPositions.length} closed, balance: $${balance.toFixed(2)}`);
  }
}
