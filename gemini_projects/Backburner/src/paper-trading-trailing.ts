import type { BackburnerSetup, MarketType } from './types.js';
import { getDataPersistence } from './data-persistence.js';
import type { PaperPosition } from './paper-trading.js';
import {
  ExecutionCostsCalculator,
  getExecutionCostsCalculator,
  determineVolatility,
  determineMarketBias,
  type VolatilityState,
  type TradeCosts,
} from './execution-costs.js';

// Debug logging
const DEBUG_TRAILING = false;
const DEBUG_IMPORTANT_ONLY = true;

function debugLog(botId: string, message: string, data?: Record<string, unknown>, important = false): void {
  if (!DEBUG_TRAILING && !important) return;
  if (!DEBUG_TRAILING && DEBUG_IMPORTANT_ONLY && !important) return;

  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[TRAIL:${botId} ${timestamp}]`;
  if (data) {
    console.error(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

// Trailing stop configuration
export interface TrailingStopConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;   // Initial stop loss (e.g., 20%)
  trailTriggerPercent: number;      // When to start trailing (e.g., 10%)
  trailStepPercent: number;         // Trail every X% profit (e.g., 10%)
  level1LockPercent: number;        // What ROI% to lock at Level 1 (default 0 = breakeven)
  maxOpenPositions: number;
  requireFutures?: boolean;          // Only trade setups available on futures (default true)
}

export const DEFAULT_TRAILING_CONFIG: TrailingStopConfig = {
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  initialStopLossPercent: 20,    // Start with 20% stop loss
  trailTriggerPercent: 10,       // Start trailing after 10% profit
  trailStepPercent: 10,          // Lock in profit every 10% gain
  level1LockPercent: 0,          // Level 1 locks at breakeven (0% ROI)
  maxOpenPositions: 10,
};

// Position status
export type TrailingPositionStatus = 'open' | 'closed_trail_stop' | 'closed_sl' | 'closed_played_out';

// A trailing stop position
export interface TrailingPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;
  timeframe: string;

  // Entry details
  entryPrice: number;
  entryTime: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Trailing stop tracking
  initialStopLossPrice: number;   // Original SL
  currentStopLossPrice: number;   // Trailing SL (moves up with profit)
  highWaterMark: number;          // Highest profit % reached
  trailLevel: number;             // Current trail level (0, 1, 2... = 0%, 10%, 20%...)

  // Current state
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Exit details (if closed)
  status: TrailingPositionStatus;
  exitPrice?: number;
  exitTime?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;

  // Execution costs tracking
  effectiveEntryPrice: number;     // Entry price after slippage
  entryCosts: number;              // Entry fee + slippage
  exitCosts?: number;              // Exit fee + slippage (on close)
  fundingPaid?: number;            // Cumulative funding paid/received
  totalCosts?: number;             // Sum of all costs
  rawPnL?: number;                 // PnL before costs (for comparison)
}

// Trading stats for trailing strategy
export interface TrailingStats {
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
  avgTrailLevel: number;  // Average trail level at exit

  // Execution costs breakdown
  totalFeesPaid: number;          // Entry + exit fees
  totalSlippageCost: number;      // Entry + exit slippage
  totalFundingPaid: number;       // Net funding paid/received
  totalExecutionCosts: number;    // Sum of all costs
  costsAsPercentOfPnL: number;    // How much costs ate into raw profits
  avgCostPerTrade: number;        // Average cost per trade
}

/**
 * Trailing Stop Paper Trading Engine
 * Uses trailing stops instead of fixed TP - locks in profit as price moves
 */
export class TrailingStopEngine {
  private config: TrailingStopConfig;
  private positions: Map<string, TrailingPosition> = new Map();
  private closedPositions: TrailingPosition[] = [];
  private balance: number;
  private peakBalance: number;
  private botId: string;
  private costsCalculator: ExecutionCostsCalculator;

  // Market state for cost calculations (updated externally)
  private currentVolatility: VolatilityState = 'normal';
  private currentMarketBias: 'bullish' | 'bearish' | 'neutral' = 'neutral';

  constructor(config?: Partial<TrailingStopConfig>, botId = 'default') {
    this.config = { ...DEFAULT_TRAILING_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
    this.costsCalculator = getExecutionCostsCalculator();
  }

  /**
   * Update market conditions for cost calculations
   * Call this periodically with BTC RSI and price change data
   */
  updateMarketConditions(btcRsi4h?: number, btcPriceChange24h?: number, rsi?: number): void {
    this.currentVolatility = determineVolatility(rsi);
    this.currentMarketBias = determineMarketBias(btcRsi4h, btcPriceChange24h);
  }

  /**
   * Get bot ID
   */
  getBotId(): string {
    return this.botId;
  }

  private generatePositionId(setup: BackburnerSetup): string {
    return `trail-${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}-${Date.now()}`;
  }

  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
  }

  private calculatePositionSize(): { margin: number; notional: number } {
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;
    return { margin, notional };
  }

  private calculateInitialStopLoss(entryPrice: number, direction: 'long' | 'short'): number {
    // initialStopLossPercent is ROI% (e.g., 20% = max 20% loss on margin)
    // Convert to price% by dividing by leverage
    // Example: 20% ROI stop with 10x leverage = 2% price move
    const roiPercent = this.config.initialStopLossPercent / 100;
    const pricePercent = roiPercent / this.config.leverage;

    if (direction === 'long') {
      return entryPrice * (1 - pricePercent);
    } else {
      return entryPrice * (1 + pricePercent);
    }
  }

  /**
   * Convert TrailingPosition to PaperPosition for data persistence logging
   */
  private toPaperPosition(pos: TrailingPosition): PaperPosition {
    return {
      id: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      marketType: pos.marketType,
      timeframe: pos.timeframe,
      entryPrice: pos.entryPrice,
      entryTime: pos.entryTime,
      marginUsed: pos.marginUsed,
      notionalSize: pos.notionalSize,
      leverage: pos.leverage,
      takeProfitPrice: 0, // Trailing doesn't use fixed TP
      stopLossPrice: pos.currentStopLossPrice,
      currentPrice: pos.currentPrice,
      unrealizedPnL: pos.unrealizedPnL,
      unrealizedPnLPercent: pos.unrealizedPnLPercent,
      status: pos.status === 'open' ? 'open' :
              pos.status === 'closed_trail_stop' ? 'closed_tp' :
              pos.status === 'closed_sl' ? 'closed_sl' : 'closed_played_out',
      exitPrice: pos.exitPrice,
      exitTime: pos.exitTime,
      realizedPnL: pos.realizedPnL,
      realizedPnLPercent: pos.realizedPnLPercent,
      exitReason: pos.exitReason,
    };
  }

  /**
   * Open a new position based on a triggered setup
   */
  openPosition(setup: BackburnerSetup): TrailingPosition | null {
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

    // Check if we already have a position for this symbol/tf/direction/market combo
    if (this.positions.has(key)) {
      debugLog(this.botId, `SKIPPED (duplicate): ${setup.symbol} ${setup.direction.toUpperCase()} ${setup.timeframe} - position already exists`, { key }, true);
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    const { margin, notional } = this.calculatePositionSize();

    if (margin > this.balance) {
      return null;
    }

    const entryPrice = setup.currentPrice;

    // Calculate entry costs (slippage + fees)
    const volatility = determineVolatility(setup.currentRSI);
    const { effectiveEntryPrice, entryCosts } = this.costsCalculator.calculateEntryCosts(
      entryPrice,
      notional,
      setup.direction,
      volatility
    );

    // Use effective entry price for stop loss calculation
    const initialStopLoss = this.calculateInitialStopLoss(effectiveEntryPrice, setup.direction);

    const position: TrailingPosition = {
      id: this.generatePositionId(setup),
      symbol: setup.symbol,
      direction: setup.direction,
      marketType: setup.marketType,
      timeframe: setup.timeframe,
      entryPrice: effectiveEntryPrice,  // Use effective price after slippage
      entryTime: Date.now(),
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,
      initialStopLossPrice: initialStopLoss,
      currentStopLossPrice: initialStopLoss,
      highWaterMark: 0,
      trailLevel: 0,
      currentPrice: entryPrice,  // Current market price (not effective)
      unrealizedPnL: -entryCosts,  // Start negative due to entry costs
      unrealizedPnLPercent: (-entryCosts / notional) * 100,
      status: 'open',
      effectiveEntryPrice,
      entryCosts,
    };

    // Deduct margin + entry costs from balance
    this.balance -= margin + entryCosts;
    this.positions.set(key, position);

    // Log to data persistence
    const paperPos = this.toPaperPosition(position);
    getDataPersistence().logTradeOpen(this.botId, paperPos, setup);

    debugLog(this.botId, `OPENED (TRAILING): ${setup.symbol} ${setup.direction.toUpperCase()} ${setup.timeframe} @ ${effectiveEntryPrice.toPrecision(5)} (mkt: ${entryPrice.toPrecision(5)})`, {
      key,
      initialSL: initialStopLoss,
      entryCosts: entryCosts.toFixed(2),
      slippage: ((effectiveEntryPrice - entryPrice) / entryPrice * 100).toFixed(3) + '%',
    }, true);

    return position;
  }

  /**
   * Update position with current price and adjust trailing stop
   */
  updatePosition(setup: BackburnerSetup): TrailingPosition | null {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position) {
      return null;
    }

    // Guard: Check if position is already closed (race condition prevention)
    if (position.status !== 'open') {
      return null;
    }

    position.currentPrice = setup.currentPrice;

    // Calculate raw PnL (before costs) for trailing stop logic
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    const rawPnL = position.notionalSize * priceChange;

    // Calculate holding time for funding estimate
    const holdingTimeMs = Date.now() - position.entryTime;

    // Calculate estimated exit costs
    const { exitCosts } = this.costsCalculator.calculateExitCosts(
      position.currentPrice,
      position.notionalSize,
      position.direction,
      this.currentVolatility
    );

    // Calculate funding paid so far
    const fundingPaid = this.costsCalculator.calculateFunding(
      position.notionalSize,
      position.direction,
      holdingTimeMs,
      this.currentMarketBias
    );

    // Update position with costs
    position.fundingPaid = fundingPaid;

    // Unrealized PnL includes entry costs (already paid), estimated exit costs, and funding
    const estimatedTotalCosts = position.entryCosts + exitCosts + fundingPaid;
    position.unrealizedPnL = rawPnL - estimatedTotalCosts;
    position.unrealizedPnLPercent = (position.unrealizedPnL / position.notionalSize) * 100;

    // Calculate ROI (return on margin) - use raw PnL for trailing stop thresholds
    // We don't want costs to affect the trailing logic, only the final PnL
    const roi = position.marginUsed > 0 ? (rawPnL / position.marginUsed) * 100 : 0;

    // Update high water mark (now tracking ROI, not price change)
    if (roi > position.highWaterMark) {
      position.highWaterMark = roi;
    }

    // Check for trailing stop adjustment
    // Trail every trailStepPercent ROI after reaching trailTriggerPercent ROI
    const triggerThreshold = this.config.trailTriggerPercent;
    const stepSize = this.config.trailStepPercent;

    if (position.highWaterMark >= triggerThreshold) {
      // Calculate new trail level based on high water mark ROI
      // e.g., if HWM ROI is 25% and step is 10%, trail level is 2 (locked at 10% ROI)
      const newTrailLevel = Math.floor((position.highWaterMark - triggerThreshold) / stepSize) + 1;

      if (newTrailLevel > position.trailLevel) {
        // Move stop loss up to lock in profit
        // Trail level 1 = lock at level1LockPercent (default 0% = breakeven, can be configured)
        // Trail level 2 = lock at level1LockPercent + stepSize
        // Trail level 3 = lock at level1LockPercent + 2*stepSize, etc.
        // Convert ROI back to price ratio: ROI% = priceChange% * leverage
        const level1Lock = this.config.level1LockPercent;
        const lockedROIPercent = level1Lock + (newTrailLevel - 1) * stepSize;
        const lockedPriceRatio = lockedROIPercent / 100 / position.leverage;

        if (position.direction === 'long') {
          position.currentStopLossPrice = position.entryPrice * (1 + lockedPriceRatio);
        } else {
          position.currentStopLossPrice = position.entryPrice * (1 - lockedPriceRatio);
        }

        debugLog(this.botId, `TRAIL ADJUSTED: ${position.symbol} Level ${position.trailLevel} → ${newTrailLevel} | New SL: ${position.currentStopLossPrice.toPrecision(5)} (locking ${lockedROIPercent}% ROI)`, {
          key,
          hwm: position.highWaterMark.toFixed(2),
          roi: roi.toFixed(2),
        }, true);

        position.trailLevel = newTrailLevel;
      }
    }

    // Check for exit conditions
    let shouldClose = false;
    let exitReason = '';
    let exitStatus: TrailingPositionStatus = 'open';

    // Check stop loss (initial or trailing)
    if (position.direction === 'long') {
      if (position.currentPrice <= position.currentStopLossPrice) {
        shouldClose = true;
        if (position.trailLevel > 0) {
          exitReason = `Trailing Stop Hit (Level ${position.trailLevel})`;
          exitStatus = 'closed_trail_stop';
        } else {
          exitReason = 'Initial Stop Loss Hit';
          exitStatus = 'closed_sl';
        }
      }
    } else {
      if (position.currentPrice >= position.currentStopLossPrice) {
        shouldClose = true;
        if (position.trailLevel > 0) {
          exitReason = `Trailing Stop Hit (Level ${position.trailLevel})`;
          exitStatus = 'closed_trail_stop';
        } else {
          exitReason = 'Initial Stop Loss Hit';
          exitStatus = 'closed_sl';
        }
      }
    }

    // Check if setup played out (RSI exit)
    if (setup.state === 'played_out') {
      shouldClose = true;
      exitReason = 'Setup Played Out (RSI)';
      exitStatus = 'closed_played_out';
    }

    if (shouldClose) {
      this.closePosition(position, exitStatus, exitReason);
    }

    return position;
  }

  private closePosition(position: TrailingPosition, status: TrailingPositionStatus, reason: string): void {
    const key = `${position.symbol}-${position.timeframe}-${position.direction}-${position.marketType}`;

    // Guard: Check if position is still open (prevent duplicate closes)
    if (!this.positions.has(key)) {
      return; // Already closed
    }

    // Guard: Check if already closed (status already set)
    if (position.status !== 'open') {
      return; // Already closed
    }

    // IMPORTANT: Remove from positions map FIRST to prevent duplicate closes
    this.positions.delete(key);

    // Calculate raw PnL (before costs)
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    const rawPnL = position.notionalSize * priceChange;
    position.rawPnL = rawPnL;

    // Calculate actual exit costs
    const { effectiveExitPrice, exitCosts } = this.costsCalculator.calculateExitCosts(
      position.currentPrice,
      position.notionalSize,
      position.direction,
      this.currentVolatility
    );

    // Calculate final funding
    const holdingTimeMs = Date.now() - position.entryTime;
    const fundingPaid = this.costsCalculator.calculateFunding(
      position.notionalSize,
      position.direction,
      holdingTimeMs,
      this.currentMarketBias
    );

    // Store cost breakdown
    position.exitCosts = exitCosts;
    position.fundingPaid = fundingPaid;
    position.totalCosts = position.entryCosts + exitCosts + fundingPaid;

    // Calculate realized PnL after all costs (for reporting)
    position.realizedPnL = rawPnL - position.totalCosts;
    position.realizedPnLPercent = (position.realizedPnL / position.notionalSize) * 100;
    position.rawPnL = rawPnL;  // Store raw PnL for analysis
    position.exitPrice = position.currentPrice;  // Log market price (not effective)
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;

    // Return margin + raw PnL - exit costs only
    // Entry costs were already deducted from balance at open time, so don't double-count them
    const exitOnlyCosts = exitCosts + fundingPaid;
    this.balance += position.marginUsed + rawPnL - exitOnlyCosts;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    debugLog(this.botId, `CLOSED (TRAILING): ${position.symbol} ${position.direction.toUpperCase()} - ${reason} | Raw: $${rawPnL.toFixed(2)} | Costs: $${position.totalCosts.toFixed(2)} | Net: $${position.realizedPnL?.toFixed(2)} | Trail Level: ${position.trailLevel}`, {
      key,
      entry: position.entryPrice,
      exit: position.exitPrice,
      hwm: position.highWaterMark.toFixed(2),
      entryCosts: position.entryCosts.toFixed(2),
      exitCosts: exitCosts.toFixed(2),
      funding: fundingPaid.toFixed(2),
    }, true);

    // Position already removed from map at start of function
    this.closedPositions.push(position);

    // Log to data persistence
    const paperPos = this.toPaperPosition(position);
    getDataPersistence().logTradeClose(this.botId, paperPos);
  }

  /**
   * Handle setup removed - keep position open, mark as orphaned
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position) return;

    position.currentPrice = setup.currentPrice;

    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.unrealizedPnL = position.notionalSize * priceChange;
    position.unrealizedPnLPercent = priceChange * 100;

    debugLog(this.botId, `SETUP REMOVED (keeping trailing position): ${setup.symbol} ${setup.direction.toUpperCase()} ${setup.timeframe}`, {
      key,
      pnl: position.unrealizedPnL.toFixed(2),
      trailLevel: position.trailLevel,
    }, true);

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

        const priceChange = position.direction === 'long'
          ? (currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - currentPrice) / position.entryPrice;

        position.unrealizedPnL = position.notionalSize * priceChange;
        position.unrealizedPnLPercent = priceChange * 100;

        // Calculate ROI (return on margin) - this is what we use for trailing thresholds
        const roi = position.marginUsed > 0 ? (position.unrealizedPnL / position.marginUsed) * 100 : 0;

        // Update high water mark (now tracking ROI, not price change)
        if (roi > position.highWaterMark) {
          position.highWaterMark = roi;
        }

        // Check trailing stop adjustment
        const triggerThreshold = this.config.trailTriggerPercent;
        const stepSize = this.config.trailStepPercent;

        if (position.highWaterMark >= triggerThreshold) {
          const newTrailLevel = Math.floor((position.highWaterMark - triggerThreshold) / stepSize) + 1;

          if (newTrailLevel > position.trailLevel) {
            // Convert ROI back to price ratio using level1LockPercent
            const level1Lock = this.config.level1LockPercent;
            const lockedROIPercent = level1Lock + (newTrailLevel - 1) * stepSize;
            const lockedPriceRatio = lockedROIPercent / 100 / position.leverage;

            if (position.direction === 'long') {
              position.currentStopLossPrice = position.entryPrice * (1 + lockedPriceRatio);
            } else {
              position.currentStopLossPrice = position.entryPrice * (1 - lockedPriceRatio);
            }

            position.trailLevel = newTrailLevel;
          }
        }

        // Check stop loss
        if (position.direction === 'long') {
          if (currentPrice <= position.currentStopLossPrice) {
            const reason = position.trailLevel > 0
              ? `Trailing Stop Hit (Level ${position.trailLevel})`
              : 'Initial Stop Loss Hit';
            const status = position.trailLevel > 0 ? 'closed_trail_stop' : 'closed_sl';
            this.closePosition(position, status, reason);
          }
        } else {
          if (currentPrice >= position.currentStopLossPrice) {
            const reason = position.trailLevel > 0
              ? `Trailing Stop Hit (Level ${position.trailLevel})`
              : 'Initial Stop Loss Hit';
            const status = position.trailLevel > 0 ? 'closed_trail_stop' : 'closed_sl';
            this.closePosition(position, status, reason);
          }
        }
      } catch (error) {
        // Silently fail - will retry next cycle
      }
    }
  }

  /**
   * Update ALL open positions with real-time prices (not just orphaned)
   * This ensures P&L is always calculated from live ticker data, not stale candle closes
   */
  async updateAllPositionPrices(getPriceFn: (symbol: string, marketType: MarketType) => Promise<number | null>): Promise<void> {
    for (const [key, position] of this.positions) {
      // Guard: Check if position is already closed (race condition prevention)
      if (position.status !== 'open') continue;

      try {
        const currentPrice = await getPriceFn(position.symbol, position.marketType);
        if (currentPrice === null) continue;
        position.currentPrice = currentPrice;

        // Calculate raw P&L
        const priceChange = position.direction === 'long'
          ? (currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - currentPrice) / position.entryPrice;

        const rawPnL = position.notionalSize * priceChange;

        // Calculate holding time for funding estimate
        const holdingTimeMs = Date.now() - position.entryTime;

        // Calculate estimated exit costs
        const { exitCosts } = this.costsCalculator.calculateExitCosts(
          currentPrice,
          position.notionalSize,
          position.direction,
          this.currentVolatility
        );

        // Calculate funding paid so far
        const fundingPaid = this.costsCalculator.calculateFunding(
          position.notionalSize,
          position.direction,
          holdingTimeMs,
          this.currentMarketBias
        );

        // Update position with costs
        position.fundingPaid = fundingPaid;

        // Unrealized PnL includes entry costs (already paid), estimated exit costs, and funding
        const estimatedTotalCosts = position.entryCosts + exitCosts + fundingPaid;
        position.unrealizedPnL = rawPnL - estimatedTotalCosts;
        position.unrealizedPnLPercent = (position.unrealizedPnL / position.notionalSize) * 100;

        // Calculate ROI for trailing stop logic
        const roi = position.marginUsed > 0 ? (rawPnL / position.marginUsed) * 100 : 0;

        // Update high water mark
        if (roi > position.highWaterMark) {
          position.highWaterMark = roi;
        }

        // Check trailing stop adjustment
        const triggerThreshold = this.config.trailTriggerPercent;
        const stepSize = this.config.trailStepPercent;

        if (position.highWaterMark >= triggerThreshold) {
          const newTrailLevel = Math.floor((position.highWaterMark - triggerThreshold) / stepSize) + 1;

          if (newTrailLevel > position.trailLevel) {
            const level1Lock = this.config.level1LockPercent;
            const lockedROIPercent = level1Lock + (newTrailLevel - 1) * stepSize;
            const lockedPriceRatio = lockedROIPercent / 100 / position.leverage;

            if (position.direction === 'long') {
              position.currentStopLossPrice = position.entryPrice * (1 + lockedPriceRatio);
            } else {
              position.currentStopLossPrice = position.entryPrice * (1 - lockedPriceRatio);
            }

            debugLog(this.botId, `TRAIL ADJUSTED (price update): ${position.symbol} Level ${position.trailLevel} → ${newTrailLevel}`, {
              key,
              roi: roi.toFixed(2),
              hwm: position.highWaterMark.toFixed(2),
            }, true);

            position.trailLevel = newTrailLevel;
          }
        }

        // Check stop loss
        if (position.direction === 'long') {
          if (currentPrice <= position.currentStopLossPrice) {
            const reason = position.trailLevel > 0
              ? `Trailing Stop Hit (Level ${position.trailLevel})`
              : 'Initial Stop Loss Hit';
            const status = position.trailLevel > 0 ? 'closed_trail_stop' : 'closed_sl';
            this.closePosition(position, status, reason);
          }
        } else {
          if (currentPrice >= position.currentStopLossPrice) {
            const reason = position.trailLevel > 0
              ? `Trailing Stop Hit (Level ${position.trailLevel})`
              : 'Initial Stop Loss Hit';
            const status = position.trailLevel > 0 ? 'closed_trail_stop' : 'closed_sl';
            this.closePosition(position, status, reason);
          }
        }
      } catch (error) {
        // Silently fail - will retry next cycle
      }
    }
  }

  getOpenPositions(): TrailingPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(limit = 50): TrailingPosition[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  getStats(): TrailingStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) < 0);

    const totalWins = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));
    const realizedPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    const reservedMargin = Array.from(this.positions.values()).reduce((sum, p) => sum + p.marginUsed, 0);
    const effectiveBalance = this.balance + reservedMargin;

    // Calculate average trail level at exit
    const avgTrailLevel = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.trailLevel, 0) / this.closedPositions.length
      : 0;

    // Calculate execution costs breakdown
    const totalEntryCosts = this.closedPositions.reduce((sum, p) => sum + (p.entryCosts || 0), 0);
    const totalExitCosts = this.closedPositions.reduce((sum, p) => sum + (p.exitCosts || 0), 0);
    const totalFunding = this.closedPositions.reduce((sum, p) => sum + (p.fundingPaid || 0), 0);
    const totalCosts = this.closedPositions.reduce((sum, p) => sum + (p.totalCosts || 0), 0);
    const totalRawPnL = this.closedPositions.reduce((sum, p) => sum + (p.rawPnL || p.realizedPnL || 0), 0);

    // Fee breakdown (entry + exit fees, not including slippage or funding)
    const feeRate = this.costsCalculator.getFeeStructure().takerFee;
    const totalNotional = this.closedPositions.reduce((sum, p) => sum + p.notionalSize, 0);
    const estimatedFees = totalNotional * feeRate * 2; // Entry + exit

    // Slippage estimate (total costs minus fees minus funding)
    const estimatedSlippage = totalCosts - estimatedFees - totalFunding;

    return {
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
      maxDrawdown: this.peakBalance - effectiveBalance,
      maxDrawdownPercent: ((this.peakBalance - effectiveBalance) / this.peakBalance) * 100,
      avgTrailLevel,

      // Execution costs breakdown
      totalFeesPaid: estimatedFees,
      totalSlippageCost: Math.max(0, estimatedSlippage),
      totalFundingPaid: totalFunding,
      totalExecutionCosts: totalCosts,
      costsAsPercentOfPnL: totalRawPnL !== 0 ? (totalCosts / Math.abs(totalRawPnL)) * 100 : 0,
      avgCostPerTrade: this.closedPositions.length > 0 ? totalCosts / this.closedPositions.length : 0,
    };
  }

  getBalance(): number {
    return this.balance;
  }

  getUnrealizedPnL(): number {
    return Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.unrealizedPnL, 0);
  }

  getConfig(): TrailingStopConfig {
    return { ...this.config };
  }

  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }

  /**
   * Save positions to disk for persistence across restarts
   */
  saveState(): void {
    const positions = Array.from(this.positions.values());
    getDataPersistence().savePositions(
      this.botId,
      positions,
      this.closedPositions,
      this.balance,
      this.peakBalance
    );
  }

  /**
   * Load positions from disk after restart
   */
  loadState(): boolean {
    const data = getDataPersistence().loadPositions(this.botId);
    if (!data) {
      return false;
    }

    // Restore positions
    this.positions.clear();
    for (const pos of data.openPositions as TrailingPosition[]) {
      const key = `${pos.symbol}-${pos.timeframe}-${pos.direction}-${pos.marketType}`;
      this.positions.set(key, pos);
    }

    // Restore closed positions
    this.closedPositions = data.closedPositions as TrailingPosition[];

    // Restore balance
    this.balance = data.balance;
    this.peakBalance = data.peakBalance;

    console.log(`[${this.botId}] Restored state: ${this.positions.size} open, ${this.closedPositions.length} closed, balance: $${this.balance.toFixed(2)}`);
    return true;
  }
}
