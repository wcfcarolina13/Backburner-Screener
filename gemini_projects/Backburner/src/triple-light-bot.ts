/**
 * Triple Light Bot
 *
 * Asset-level signal aggregation bot that tracks signals across 3 timeframes.
 * Only enters trades when ALL three timeframes show active signals (3 green lights).
 *
 * Signal Strength Model:
 * - 1 green light = weak signal (no trade)
 * - 2 green lights = medium signal (no trade)
 * - 3 green lights = strong signal (ENTER TRADE)
 *
 * Key Differences from Per-Signal Bots:
 * - ONE position per asset (not per signal/timeframe)
 * - Position stays open while ANY signal remains active
 * - Only opens when all 3 timeframes align
 * - Closes when all signals expire OR stop loss hit
 */

import type { BackburnerSetup, MarketType, Timeframe } from './types.js';
import { getDataPersistence } from './data-persistence.js';
import type { PaperPosition } from './paper-trading.js';
import {
  ExecutionCostsCalculator,
  getExecutionCostsCalculator,
  determineVolatility,
  determineMarketBias,
  type VolatilityState,
} from './execution-costs.js';

// Debug logging
const DEBUG_TRIPLE = false;
const DEBUG_IMPORTANT_ONLY = true;

function debugLog(botId: string, message: string, data?: Record<string, unknown>, important = false): void {
  if (!DEBUG_TRIPLE && !important) return;
  if (!DEBUG_TRIPLE && DEBUG_IMPORTANT_ONLY && !important) return;

  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[TRIPLE:${botId} ${timestamp}]`;
  if (data) {
    console.error(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

// Configuration
export interface TripleLightConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;
  // Timeframes to track (must be exactly 3)
  trackedTimeframes: [Timeframe, Timeframe, Timeframe];
  // Minimum signal strength to enter (1, 2, or 3)
  minLightsToEnter: 1 | 2 | 3;
}

export const DEFAULT_TRIPLE_CONFIG: TripleLightConfig = {
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
  trackedTimeframes: ['5m', '15m', '1h'],
  minLightsToEnter: 3, // Only enter on strong signals
};

// Signal state for a single timeframe
export interface TimeframeSignal {
  timeframe: Timeframe;
  active: boolean;          // "Green light" - is there an active signal?
  direction: 'long' | 'short' | null;
  rsi: number;
  state: string;            // triggered, deep_extreme, etc.
  lastUpdated: number;
  setup?: BackburnerSetup;  // Reference to the actual setup
}

// Aggregated asset-level signal
export interface AssetSignal {
  symbol: string;
  direction: 'long' | 'short' | null;
  signals: Map<Timeframe, TimeframeSignal>;
  greenLights: number;      // Count of active signals (0-3)
  strength: 'none' | 'weak' | 'medium' | 'strong';
  lastUpdated: number;
}

// Position with signal tracking
export interface TripleLightPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;

  // Entry details
  entryPrice: number;
  entryTime: number;
  entryGreenLights: number;  // How many lights were green at entry
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
  currentGreenLights: number;  // Current number of active signals
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Exit details
  status: 'open' | 'closed_trail_stop' | 'closed_sl' | 'closed_no_signals';
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

// Stats
export interface TripleLightStats {
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
  avgEntryLights: number;   // Average green lights at entry
  avgExitLights: number;    // Average green lights at exit

  // Execution costs breakdown
  totalFeesPaid: number;
  totalSlippageCost: number;
  totalFundingPaid: number;
  totalExecutionCosts: number;
  costsAsPercentOfPnL: number;
  avgCostPerTrade: number;
}

/**
 * Triple Light Trading Bot
 * Aggregates signals across timeframes, trades at asset level
 */
export class TripleLightBot {
  private config: TripleLightConfig;
  private assetSignals: Map<string, AssetSignal> = new Map();
  private positions: Map<string, TripleLightPosition> = new Map();
  private closedPositions: TripleLightPosition[] = [];
  private balance: number;
  private peakBalance: number;
  private botId: string;
  private costsCalculator: ExecutionCostsCalculator;

  // Market state for cost calculations
  private currentVolatility: VolatilityState = 'normal';
  private currentMarketBias: 'bullish' | 'bearish' | 'neutral' = 'neutral';

  constructor(config?: Partial<TripleLightConfig>, botId = 'triple') {
    this.config = { ...DEFAULT_TRIPLE_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
    this.costsCalculator = getExecutionCostsCalculator();
  }

  /**
   * Update market conditions for cost calculations
   */
  updateMarketConditions(btcRsi4h?: number, btcPriceChange24h?: number, rsi?: number): void {
    this.currentVolatility = determineVolatility(rsi);
    this.currentMarketBias = determineMarketBias(btcRsi4h, btcPriceChange24h);
  }

  getBotId(): string {
    return this.botId;
  }

  getConfig(): TripleLightConfig {
    return { ...this.config };
  }

  /**
   * Get or create asset signal tracker
   */
  private getAssetSignal(symbol: string): AssetSignal {
    if (!this.assetSignals.has(symbol)) {
      const signals = new Map<Timeframe, TimeframeSignal>();
      for (const tf of this.config.trackedTimeframes) {
        signals.set(tf, {
          timeframe: tf,
          active: false,
          direction: null,
          rsi: 50,
          state: 'none',
          lastUpdated: 0,
        });
      }
      this.assetSignals.set(symbol, {
        symbol,
        direction: null,
        signals,
        greenLights: 0,
        strength: 'none',
        lastUpdated: Date.now(),
      });
    }
    return this.assetSignals.get(symbol)!;
  }

  /**
   * Update signal state from a BackburnerSetup
   */
  private updateTimeframeSignal(asset: AssetSignal, setup: BackburnerSetup): void {
    const tf = setup.timeframe;
    if (!this.config.trackedTimeframes.includes(tf)) {
      return; // Ignore timeframes we don't track
    }

    const signal = asset.signals.get(tf);
    if (!signal) return;

    // Determine if this is an active "green light" signal
    const isActive = setup.state === 'triggered' || setup.state === 'deep_extreme';

    signal.active = isActive;
    signal.direction = isActive ? setup.direction : null;
    signal.rsi = setup.currentRSI;
    signal.state = setup.state;
    signal.lastUpdated = Date.now();
    signal.setup = setup;

    // Recalculate aggregated state
    this.recalculateAssetSignal(asset);
  }

  /**
   * Clear a timeframe signal (when setup is removed)
   */
  private clearTimeframeSignal(asset: AssetSignal, timeframe: Timeframe): void {
    const signal = asset.signals.get(timeframe);
    if (!signal) return;

    signal.active = false;
    signal.direction = null;
    signal.state = 'none';
    signal.lastUpdated = Date.now();
    signal.setup = undefined;

    this.recalculateAssetSignal(asset);
  }

  /**
   * Recalculate aggregated signal strength
   */
  private recalculateAssetSignal(asset: AssetSignal): void {
    let greenLights = 0;
    let direction: 'long' | 'short' | null = null;
    let hasConflict = false;

    for (const signal of asset.signals.values()) {
      if (signal.active) {
        greenLights++;
        if (direction === null) {
          direction = signal.direction;
        } else if (direction !== signal.direction) {
          hasConflict = true;
        }
      }
    }

    // If signals conflict (some long, some short), don't trade
    if (hasConflict) {
      greenLights = 0;
      direction = null;
    }

    asset.greenLights = greenLights;
    asset.direction = direction;
    asset.strength = greenLights === 0 ? 'none' :
                     greenLights === 1 ? 'weak' :
                     greenLights === 2 ? 'medium' : 'strong';
    asset.lastUpdated = Date.now();
  }

  /**
   * Get position key (one position per symbol/direction)
   */
  private getPositionKey(symbol: string, direction: 'long' | 'short'): string {
    return `${symbol}-${direction}`;
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
   * Calculate initial stop loss
   */
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
   * Handle a new setup
   */
  handleNewSetup(setup: BackburnerSetup): TripleLightPosition | null {
    const asset = this.getAssetSignal(setup.symbol);
    this.updateTimeframeSignal(asset, setup);

    return this.evaluateEntry(asset, setup);
  }

  /**
   * Handle setup update
   */
  handleSetupUpdated(setup: BackburnerSetup): TripleLightPosition | null {
    const asset = this.getAssetSignal(setup.symbol);
    this.updateTimeframeSignal(asset, setup);

    // Update existing position if any
    this.updatePosition(asset, setup.currentPrice);

    // Check if we should enter (if not already in position)
    return this.evaluateEntry(asset, setup);
  }

  /**
   * Handle setup removed
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    const asset = this.getAssetSignal(setup.symbol);
    this.clearTimeframeSignal(asset, setup.timeframe);

    // Check if we should close position
    this.evaluateExit(asset, setup.currentPrice);
  }

  /**
   * Evaluate if we should enter a position
   */
  private evaluateEntry(asset: AssetSignal, setup: BackburnerSetup): TripleLightPosition | null {
    // Need enough green lights
    if (asset.greenLights < this.config.minLightsToEnter) {
      return null;
    }

    // Need a direction
    if (!asset.direction) {
      return null;
    }

    // Check if we already have a position for this asset/direction
    const key = this.getPositionKey(asset.symbol, asset.direction);
    if (this.positions.has(key)) {
      return null;
    }

    // Check position limits
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Calculate position size
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
      asset.direction,
      volatility
    );

    // Use effective entry price for stop loss calculation
    const initialStopLoss = this.calculateInitialStopLoss(effectiveEntryPrice, asset.direction);

    const position: TripleLightPosition = {
      id: `triple-${asset.symbol}-${asset.direction}-${Date.now()}`,
      symbol: asset.symbol,
      direction: asset.direction,
      marketType: setup.marketType,
      entryPrice: effectiveEntryPrice,  // Use effective price after slippage
      entryTime: Date.now(),
      entryGreenLights: asset.greenLights,
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,
      initialStopLossPrice: initialStopLoss,
      currentStopLossPrice: initialStopLoss,
      highWaterMark: 0,
      trailLevel: 0,
      currentPrice: entryPrice,  // Current market price (not effective)
      currentGreenLights: asset.greenLights,
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
    const paperPos = this.toPaperPosition(position, setup);
    getDataPersistence().logTradeOpen(this.botId, paperPos, setup);

    debugLog(this.botId, `OPENED: ${asset.symbol} ${asset.direction.toUpperCase()} @ ${effectiveEntryPrice.toPrecision(5)} (mkt: ${entryPrice.toPrecision(5)}, ${asset.greenLights} lights)`, {
      key,
      greenLights: asset.greenLights,
      strength: asset.strength,
      entryCosts: entryCosts.toFixed(2),
    }, true);

    return position;
  }

  /**
   * Update position with current price
   */
  private updatePosition(asset: AssetSignal, currentPrice: number): void {
    // Check both long and short positions for this asset
    for (const direction of ['long', 'short'] as const) {
      const key = this.getPositionKey(asset.symbol, direction);
      const position = this.positions.get(key);
      if (!position) continue;

      position.currentPrice = currentPrice;
      position.currentGreenLights = asset.greenLights;

      // Calculate raw PnL (before costs) for trailing stop logic
      const priceChange = direction === 'long'
        ? (currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - currentPrice) / position.entryPrice;

      const rawPnL = position.notionalSize * priceChange;

      // Calculate holding time for funding estimate
      const holdingTimeMs = Date.now() - position.entryTime;

      // Calculate estimated exit costs
      const { exitCosts } = this.costsCalculator.calculateExitCosts(
        currentPrice,
        position.notionalSize,
        direction,
        this.currentVolatility
      );

      // Calculate funding paid so far
      const fundingPaid = this.costsCalculator.calculateFunding(
        position.notionalSize,
        direction,
        holdingTimeMs,
        this.currentMarketBias
      );

      // Update position with costs
      position.fundingPaid = fundingPaid;

      // Unrealized PnL includes entry costs, estimated exit costs, and funding
      const estimatedTotalCosts = position.entryCosts + exitCosts + fundingPaid;
      position.unrealizedPnL = rawPnL - estimatedTotalCosts;
      position.unrealizedPnLPercent = (position.unrealizedPnL / position.notionalSize) * 100;

      // Use raw PnL percent for trailing stop logic
      const rawPnLPercent = priceChange * 100;

      // Update high water mark (based on raw PnL, not after costs)
      if (rawPnLPercent > position.highWaterMark) {
        position.highWaterMark = rawPnLPercent;
      }

      // Check trailing stop adjustment (uses high water mark)
      this.adjustTrailingStop(position);

      // Check for stop loss hit
      const hitSL = direction === 'long'
        ? currentPrice <= position.currentStopLossPrice
        : currentPrice >= position.currentStopLossPrice;

      if (hitSL) {
        const reason = position.trailLevel > 0 ? 'Trailing Stop Hit' : 'Initial Stop Loss Hit';
        const status = position.trailLevel > 0 ? 'closed_trail_stop' : 'closed_sl';
        this.closePosition(position, status, reason);
      }
    }
  }

  /**
   * Adjust trailing stop based on profit
   */
  private adjustTrailingStop(position: TripleLightPosition): void {
    const roiPercent = position.unrealizedPnLPercent;
    const triggerPercent = this.config.trailTriggerPercent;
    const stepPercent = this.config.trailStepPercent;

    // Calculate what trail level we should be at
    let newTrailLevel = 0;
    if (roiPercent >= triggerPercent) {
      newTrailLevel = 1 + Math.floor((roiPercent - triggerPercent) / stepPercent);
    }

    if (newTrailLevel > position.trailLevel) {
      position.trailLevel = newTrailLevel;

      // Calculate new stop loss
      const lockedROIPercent = newTrailLevel === 1
        ? this.config.level1LockPercent
        : this.config.level1LockPercent + (newTrailLevel - 1) * stepPercent;

      const lockedROIDecimal = lockedROIPercent / 100;

      if (position.direction === 'long') {
        position.currentStopLossPrice = position.entryPrice * (1 + lockedROIDecimal);
      } else {
        position.currentStopLossPrice = position.entryPrice * (1 - lockedROIDecimal);
      }

      debugLog(this.botId, `TRAIL ADJUSTED: ${position.symbol} Level ${position.trailLevel} | New SL: ${position.currentStopLossPrice.toPrecision(5)}`, {
        trailLevel: position.trailLevel,
        lockedROIPercent,
      }, true);
    }
  }

  /**
   * Evaluate if we should close a position (no more signals)
   */
  private evaluateExit(asset: AssetSignal, currentPrice: number): void {
    // Check both directions
    for (const direction of ['long', 'short'] as const) {
      const key = this.getPositionKey(asset.symbol, direction);
      const position = this.positions.get(key);
      if (!position) continue;

      // Update current state
      position.currentPrice = currentPrice;
      position.currentGreenLights = asset.greenLights;

      // If position direction matches asset direction, signals still align
      // If asset has no direction or different direction, check if ALL signals gone
      const signalsForDirection = Array.from(asset.signals.values())
        .filter(s => s.active && s.direction === direction);

      if (signalsForDirection.length === 0) {
        // No more signals supporting this position
        this.closePosition(position, 'closed_no_signals', 'All signals expired');
      }
    }
  }

  /**
   * Close a position
   */
  private closePosition(
    position: TripleLightPosition,
    status: TripleLightPosition['status'],
    reason: string
  ): void {
    const key = this.getPositionKey(position.symbol, position.direction);

    // Calculate raw PnL (before costs)
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    const rawPnL = position.notionalSize * priceChange;
    position.rawPnL = rawPnL;

    // Calculate actual exit costs
    const { exitCosts } = this.costsCalculator.calculateExitCosts(
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
    position.rawPnL = rawPnL;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;

    // Return margin + raw PnL - exit costs only
    // Entry costs were already deducted from balance at open time
    const exitOnlyCosts = exitCosts + fundingPaid;
    this.balance += position.marginUsed + rawPnL - exitOnlyCosts;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    debugLog(this.botId, `CLOSED: ${position.symbol} ${position.direction.toUpperCase()} - ${reason} | Raw: $${rawPnL.toFixed(2)} | Costs: $${position.totalCosts.toFixed(2)} | Net: $${position.realizedPnL?.toFixed(2)} | Lights: ${position.entryGreenLights}→${position.currentGreenLights}`, {
      key,
      entry: position.entryPrice,
      exit: position.exitPrice,
      trailLevel: position.trailLevel,
      entryCosts: position.entryCosts.toFixed(2),
      exitCosts: exitCosts.toFixed(2),
      funding: fundingPaid.toFixed(2),
    }, true);

    this.positions.delete(key);
    this.closedPositions.push(position);

    // Log to data persistence
    const paperPos = this.toPaperPosition(position);
    getDataPersistence().logTradeClose(this.botId, paperPos);
  }

  /**
   * Convert to PaperPosition for data persistence
   */
  private toPaperPosition(position: TripleLightPosition, setup?: BackburnerSetup): PaperPosition {
    return {
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      marketType: position.marketType,
      timeframe: 'multi', // Indicates multi-timeframe
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      marginUsed: position.marginUsed,
      notionalSize: position.notionalSize,
      leverage: position.leverage,
      takeProfitPrice: 0,
      stopLossPrice: position.currentStopLossPrice,
      currentPrice: position.currentPrice,
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLPercent: position.unrealizedPnLPercent,
      status: position.status === 'open' ? 'open' :
              position.status === 'closed_trail_stop' ? 'closed_tp' :
              position.status === 'closed_sl' ? 'closed_sl' : 'closed_played_out',
      exitPrice: position.exitPrice,
      exitTime: position.exitTime,
      realizedPnL: position.realizedPnL,
      realizedPnLPercent: position.realizedPnLPercent,
      exitReason: position.exitReason,
    };
  }

  /**
   * Update orphaned positions (positions without active setups)
   */
  async updateOrphanedPositions(priceGetter: (symbol: string) => Promise<number | null>): Promise<void> {
    for (const position of this.positions.values()) {
      const price = await priceGetter(position.symbol);
      if (price) {
        const asset = this.getAssetSignal(position.symbol);
        this.updatePosition(asset, price);
      }
    }
  }

  // Getters for UI
  getBalance(): number {
    return this.balance;
  }

  getOpenPositions(): TripleLightPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(limit?: number): TripleLightPosition[] {
    if (limit) {
      return this.closedPositions.slice(-limit);
    }
    return [...this.closedPositions];
  }

  getUnrealizedPnL(): number {
    return Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.unrealizedPnL, 0);
  }

  /**
   * Get current signal state for all tracked assets
   */
  getAssetSignals(): AssetSignal[] {
    return Array.from(this.assetSignals.values())
      .filter(a => a.greenLights > 0)
      .sort((a, b) => b.greenLights - a.greenLights);
  }

  /**
   * Get signal summary for a specific symbol
   */
  getSymbolSignalSummary(symbol: string): {
    symbol: string;
    greenLights: number;
    strength: string;
    direction: string | null;
    timeframes: { tf: Timeframe; active: boolean; rsi: number; state: string }[];
  } | null {
    const asset = this.assetSignals.get(symbol);
    if (!asset) return null;

    return {
      symbol: asset.symbol,
      greenLights: asset.greenLights,
      strength: asset.strength,
      direction: asset.direction,
      timeframes: this.config.trackedTimeframes.map(tf => {
        const signal = asset.signals.get(tf);
        return {
          tf,
          active: signal?.active ?? false,
          rsi: signal?.rsi ?? 50,
          state: signal?.state ?? 'none',
        };
      }),
    };
  }

  getStats(): TripleLightStats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);

    const totalWinAmount = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));
    const totalPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    const avgEntryLights = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.entryGreenLights, 0) / this.closedPositions.length
      : 0;

    const avgExitLights = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.currentGreenLights, 0) / this.closedPositions.length
      : 0;

    // Calculate execution costs breakdown
    const totalFeesPaid = this.closedPositions.reduce((sum, p) => sum + (p.entryCosts || 0) + (p.exitCosts || 0), 0);
    const totalSlippageCost = this.closedPositions.reduce((sum, p) => {
      // Slippage is embedded in effective entry price difference
      const entrySlippage = Math.abs(p.effectiveEntryPrice - p.entryPrice) * (p.notionalSize / p.effectiveEntryPrice);
      return sum + entrySlippage;
    }, 0);
    const totalFundingPaid = this.closedPositions.reduce((sum, p) => sum + (p.fundingPaid || 0), 0);
    const totalExecutionCosts = this.closedPositions.reduce((sum, p) => sum + (p.totalCosts || 0), 0);

    // Raw PnL is PnL before costs (realized PnL already has costs deducted)
    const totalRawPnL = this.closedPositions.reduce((sum, p) => sum + (p.rawPnL || (p.realizedPnL || 0) + (p.totalCosts || 0)), 0);
    const costsAsPercentOfPnL = totalRawPnL > 0 ? (totalExecutionCosts / totalRawPnL) * 100 : 0;
    const avgCostPerTrade = this.closedPositions.length > 0 ? totalExecutionCosts / this.closedPositions.length : 0;

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0 ? (wins.length / this.closedPositions.length) * 100 : 0,
      totalPnL,
      totalPnLPercent: (totalPnL / this.config.initialBalance) * 100,
      largestWin: wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnL || 0)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(p => p.realizedPnL || 0)) : 0,
      averageWin: wins.length > 0 ? totalWinAmount / wins.length : 0,
      averageLoss: losses.length > 0 ? totalLossAmount / losses.length : 0,
      profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      maxDrawdown: this.peakBalance - Math.min(this.balance, ...this.closedPositions.map(p => this.config.initialBalance + (p.realizedPnL || 0))),
      maxDrawdownPercent: ((this.peakBalance - this.balance) / this.peakBalance) * 100,
      avgEntryLights,
      avgExitLights,
      // Execution costs
      totalFeesPaid,
      totalSlippageCost,
      totalFundingPaid,
      totalExecutionCosts,
      costsAsPercentOfPnL,
      avgCostPerTrade,
    };
  }

  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    this.assetSignals.clear();
  }
}
