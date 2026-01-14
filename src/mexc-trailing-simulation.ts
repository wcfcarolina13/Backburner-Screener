/**
 * MEXC Trailing Stop Simulation
 *
 * Simulates MEXC's continuous trailing stop behavior for paper trading comparison.
 *
 * MEXC Trailing Stop Logic:
 * - Activation Price: Price must reach this level to enable trailing
 * - Callback Rate (%): The trailing distance as percentage of peak/trough
 * - Once activated, stop continuously trails at callback% below peak (long) or above trough (short)
 * - Trigger when price retraces by callback% from the extreme
 *
 * Formula:
 * - Long: trigger_price = peak_price × (1 - callback_rate)
 * - Short: trigger_price = trough_price × (1 + callback_rate)
 *
 * This differs from our discrete level system which only moves stops at specific ROI thresholds.
 */

import { BackburnerSetup } from './types.js';
import { getExecutionCostsCalculator, type ExecutionCostsCalculator } from './execution-costs.js';
import { getDataPersistence } from './data-persistence.js';

// Debug logging helper
const DEBUG = process.env.DEBUG_BOTS === 'true';
function debugLog(botId: string, message: string, data?: any, force = false) {
  if (DEBUG || force) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] [MEXC-SIM:${botId}] ${message}`, data ? JSON.stringify(data) : '');
  }
}

export interface MexcTrailingConfig {
  initialBalance: number;
  positionSizePercent: number;  // 10 = 10% of balance per trade
  leverage: number;             // 10x, 20x, etc.

  // MEXC-style trailing parameters
  activationPercent: number;    // ROI% to activate trailing (e.g., 5 = activate at 5% ROI)
  callbackPercent: number;      // Callback rate (e.g., 1 = 1% retracement triggers stop)

  // Initial stop loss (before activation)
  initialStopLossPercent: number;  // ROI% for initial stop (e.g., -20 = -20% ROI stop)

  maxOpenPositions: number;
}

const DEFAULT_MEXC_CONFIG: MexcTrailingConfig = {
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  activationPercent: 10,      // Activate trailing at 10% ROI
  callbackPercent: 1,         // 1% callback rate
  initialStopLossPercent: -20, // -20% ROI initial stop
  maxOpenPositions: 10,
};

interface MexcTrailingPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: 'spot' | 'futures';

  entryPrice: number;
  currentPrice: number;
  notionalSize: number;
  marginUsed: number;
  leverage: number;

  // MEXC trailing state
  isTrailingActivated: boolean;
  peakPrice: number;          // Highest price since entry (for longs)
  troughPrice: number;        // Lowest price since entry (for shorts)
  currentStopPrice: number;

  // Costs
  entryCosts: number;

  // P&L tracking
  unrealizedPnL: number;
  unrealizedPnLPercent: number;

  // Timestamps
  entryTime: number;

  // Exit info (when closed)
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitCosts?: number;
  totalCosts?: number;
  status?: 'open' | 'closed';
}

export class MexcTrailingSimulation {
  private config: MexcTrailingConfig;
  private botId: string;
  private balance: number;
  private peakBalance: number;
  private positions: Map<string, MexcTrailingPosition> = new Map();
  private closedPositions: MexcTrailingPosition[] = [];
  private costsCalculator: ExecutionCostsCalculator;

  constructor(config?: Partial<MexcTrailingConfig>, botId = 'mexc-sim') {
    this.config = { ...DEFAULT_MEXC_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
    this.costsCalculator = getExecutionCostsCalculator();
  }

  getName(): string {
    return `MEXC-Sim ${this.config.positionSizePercent}% ${this.config.leverage}x ${this.config.callbackPercent}%cb`;
  }

  getConfig(): MexcTrailingConfig {
    return { ...this.config };
  }

  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
  }

  private calculatePositionSize(): { margin: number; notional: number } {
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;
    return { margin, notional };
  }

  /**
   * Calculate initial stop loss price based on ROI%
   * For -20% ROI at 20x leverage: price must move 1% against us
   * pricePercent = roiPercent / leverage
   */
  private calculateInitialStopPrice(entryPrice: number, direction: 'long' | 'short'): number {
    const pricePercent = Math.abs(this.config.initialStopLossPercent) / this.config.leverage / 100;

    if (direction === 'long') {
      return entryPrice * (1 - pricePercent);
    } else {
      return entryPrice * (1 + pricePercent);
    }
  }

  /**
   * Calculate trailing stop price using MEXC's continuous trailing logic
   */
  private calculateTrailingStopPrice(
    peakOrTrough: number,
    direction: 'long' | 'short'
  ): number {
    const callbackRate = this.config.callbackPercent / 100;

    if (direction === 'long') {
      // Long: stop trails below peak
      return peakOrTrough * (1 - callbackRate);
    } else {
      // Short: stop trails above trough
      return peakOrTrough * (1 + callbackRate);
    }
  }

  /**
   * Check if trailing should be activated based on ROI
   */
  private shouldActivateTrailing(position: MexcTrailingPosition): boolean {
    const roi = position.marginUsed > 0
      ? (position.unrealizedPnL / position.marginUsed) * 100
      : 0;
    return roi >= this.config.activationPercent;
  }

  /**
   * Open a new position
   */
  openPosition(setup: BackburnerSetup): MexcTrailingPosition | null {
    const key = this.getPositionKey(setup);

    // Check if position already exists
    if (this.positions.has(key)) {
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Only trade triggered/deep_extreme setups
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    const { margin, notional } = this.calculatePositionSize();

    if (margin > this.balance) {
      return null;
    }

    const entryPrice = setup.currentPrice;

    // Calculate entry costs using the correct API
    const entryCostResult = this.costsCalculator.calculateEntryCosts(
      entryPrice,
      notional,
      setup.direction
    );
    const entryCosts = entryCostResult.entryCosts;

    const initialStopPrice = this.calculateInitialStopPrice(entryPrice, setup.direction);

    const position: MexcTrailingPosition = {
      id: `${key}-${Date.now()}`,
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
      marketType: setup.marketType,
      entryPrice,
      currentPrice: entryPrice,
      notionalSize: notional,
      marginUsed: margin,
      leverage: this.config.leverage,

      // MEXC trailing state - not activated yet
      isTrailingActivated: false,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      currentStopPrice: initialStopPrice,

      entryCosts,
      unrealizedPnL: -entryCosts,  // Start negative due to entry costs
      unrealizedPnLPercent: 0,
      entryTime: Date.now(),
      status: 'open',
    };

    // Deduct margin + entry costs
    this.balance -= margin + entryCosts;
    this.positions.set(key, position);

    console.log(`[MEXC-SIM:${this.botId}] OPENED ${setup.direction.toUpperCase()} ${setup.symbol} @ ${entryPrice.toPrecision(5)} | Margin: $${margin.toFixed(2)} | Stop: ${initialStopPrice.toPrecision(5)} | Activation: ${this.config.activationPercent}% ROI`);

    return position;
  }

  /**
   * Update position with new price - core MEXC trailing logic
   */
  updatePosition(setup: BackburnerSetup, currentPrice: number): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position) return;

    position.currentPrice = currentPrice;

    // Calculate raw P&L
    const priceChange = position.direction === 'long'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;

    const rawPnL = position.notionalSize * priceChange;

    // Estimate exit costs for unrealized P&L
    const exitCostResult = this.costsCalculator.calculateExitCosts(
      currentPrice,
      position.notionalSize,
      position.direction
    );
    const exitCosts = exitCostResult.exitCosts;

    position.unrealizedPnL = rawPnL - position.entryCosts - exitCosts;
    position.unrealizedPnLPercent = (position.unrealizedPnL / position.notionalSize) * 100;

    // Update peak/trough tracking
    if (position.direction === 'long') {
      if (currentPrice > position.peakPrice) {
        position.peakPrice = currentPrice;

        // If trailing is activated, update stop
        if (position.isTrailingActivated) {
          const newStop = this.calculateTrailingStopPrice(position.peakPrice, 'long');
          if (newStop > position.currentStopPrice) {
            position.currentStopPrice = newStop;
            debugLog(this.botId, `Trailing stop raised: ${position.symbol}`, {
              peak: position.peakPrice.toPrecision(5),
              newStop: newStop.toPrecision(5),
            });
          }
        }
      }
    } else {
      if (currentPrice < position.troughPrice) {
        position.troughPrice = currentPrice;

        // If trailing is activated, update stop
        if (position.isTrailingActivated) {
          const newStop = this.calculateTrailingStopPrice(position.troughPrice, 'short');
          if (newStop < position.currentStopPrice) {
            position.currentStopPrice = newStop;
            debugLog(this.botId, `Trailing stop lowered: ${position.symbol}`, {
              trough: position.troughPrice.toPrecision(5),
              newStop: newStop.toPrecision(5),
            });
          }
        }
      }
    }

    // Check if trailing should be activated
    if (!position.isTrailingActivated && this.shouldActivateTrailing(position)) {
      position.isTrailingActivated = true;

      // Set initial trailing stop from current peak/trough
      if (position.direction === 'long') {
        position.currentStopPrice = this.calculateTrailingStopPrice(position.peakPrice, 'long');
      } else {
        position.currentStopPrice = this.calculateTrailingStopPrice(position.troughPrice, 'short');
      }

      const roi = position.marginUsed > 0
        ? (position.unrealizedPnL / position.marginUsed) * 100
        : 0;

      console.log(`[MEXC-SIM:${this.botId}] TRAILING ACTIVATED ${position.symbol} @ ${roi.toFixed(1)}% ROI | Stop: ${position.currentStopPrice.toPrecision(5)}`);
    }

    // Check if stop is hit
    const stopHit = position.direction === 'long'
      ? currentPrice <= position.currentStopPrice
      : currentPrice >= position.currentStopPrice;

    if (stopHit) {
      const reason = position.isTrailingActivated ? 'trailing_stop' : 'initial_stop';
      this.closePosition(key, reason);
    }
  }

  /**
   * Close position
   */
  closePosition(key: string, reason: string): MexcTrailingPosition | null {
    const position = this.positions.get(key);
    if (!position) return null;

    const holdingTimeMs = Date.now() - position.entryTime;

    // Calculate final P&L
    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    const rawPnL = position.notionalSize * priceChange;

    // Calculate exit costs
    const exitCostResult = this.costsCalculator.calculateExitCosts(
      position.currentPrice,
      position.notionalSize,
      position.direction
    );
    const exitCosts = exitCostResult.exitCosts;

    position.exitCosts = exitCosts;
    position.totalCosts = position.entryCosts + exitCosts;
    position.realizedPnL = rawPnL - position.totalCosts;
    position.realizedPnLPercent = (position.realizedPnL / position.notionalSize) * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.exitReason = reason;
    position.status = 'closed';

    // Return margin + raw PnL - exit costs only (entry costs already deducted)
    const exitOnlyCosts = exitCosts;
    this.balance += position.marginUsed + rawPnL - exitOnlyCosts;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    const roi = position.marginUsed > 0
      ? (position.realizedPnL / position.marginUsed) * 100
      : 0;

    console.log(`[MEXC-SIM:${this.botId}] CLOSED ${position.symbol} ${position.direction.toUpperCase()} - ${reason} | PnL: $${position.realizedPnL?.toFixed(2)} (${roi.toFixed(1)}% ROI) | Trailing: ${position.isTrailingActivated ? 'YES' : 'NO'}`);

    this.closedPositions.push(position);
    this.positions.delete(key);

    return position;
  }

  /**
   * Handle setup removal - DON'T close, mark as orphaned
   * Real MEXC trailing stops don't care about RSI - they only care about price hitting the stop
   */
  onSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);
    if (position) {
      // Mark as orphaned but keep tracking - just like real MEXC trailing stop
      (position as any).orphaned = true;
      debugLog(this.botId, `Setup removed, keeping position open: ${setup.symbol}`, {
        direction: position.direction,
        isTrailingActivated: position.isTrailingActivated,
        currentStopPrice: position.currentStopPrice,
      });
    }
  }

  /**
   * Update orphaned positions (setups no longer exist)
   */
  async updateOrphanedPositions(
    getCurrentPrice: (symbol: string) => Promise<number | null>
  ): Promise<void> {
    for (const [key, position] of this.positions) {
      try {
        const currentPrice = await getCurrentPrice(position.symbol);
        if (currentPrice) {
          // Create a minimal setup for update - use Partial and cast to avoid full interface requirement
          const mockSetup = {
            symbol: position.symbol,
            direction: position.direction,
            timeframe: position.timeframe,
            marketType: position.marketType,
            state: 'triggered' as const,
            currentRSI: 50,
            currentPrice,
            impulsePercentMove: 0,
            detectedAt: position.entryTime,
            impulseHigh: currentPrice,
            impulseLow: currentPrice,
            impulseStartTime: position.entryTime,
            impulseEndTime: position.entryTime,
            lastUpdated: Date.now(),
            impulseAvgVolume: 0,
            pullbackAvgVolume: 0,
            volumeContracting: false,
            liquidityRisk: 'low' as const,
          } as BackburnerSetup;
          this.updatePosition(mockSetup, currentPrice);
        }
      } catch (err) {
        // Ignore price fetch errors
      }
    }
  }

  /**
   * Update ALL open positions with real-time prices (not just orphaned)
   * This ensures P&L is always calculated from live ticker data
   */
  async updateAllPositionPrices(
    getCurrentPrice: (symbol: string) => Promise<number | null>
  ): Promise<void> {
    for (const [key, position] of this.positions) {
      try {
        const currentPrice = await getCurrentPrice(position.symbol);
        if (currentPrice) {
          const mockSetup = {
            symbol: position.symbol,
            direction: position.direction,
            timeframe: position.timeframe,
            marketType: position.marketType,
            state: 'triggered' as const,
            currentRSI: 50,
            currentPrice,
            impulsePercentMove: 0,
            detectedAt: position.entryTime,
            impulseHigh: currentPrice,
            impulseLow: currentPrice,
            impulseStartTime: position.entryTime,
            impulseEndTime: position.entryTime,
            lastUpdated: Date.now(),
            impulseAvgVolume: 0,
            pullbackAvgVolume: 0,
            volumeContracting: false,
            liquidityRisk: 'low' as const,
          } as BackburnerSetup;
          this.updatePosition(mockSetup, currentPrice);
        }
      } catch (err) {
        // Ignore price fetch errors
      }
    }
  }

  getOpenPositions(): MexcTrailingPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): MexcTrailingPosition[] {
    return [...this.closedPositions];
  }

  getBalance(): number {
    return this.balance;
  }

  getUnrealizedPnL(): number {
    return Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.unrealizedPnL, 0);
  }

  getStats() {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) < 0);

    const totalWins = wins.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + (p.realizedPnL || 0), 0));
    const realizedPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    const reservedMargin = Array.from(this.positions.values()).reduce((sum, p) => sum + p.marginUsed, 0);
    const effectiveBalance = this.balance + reservedMargin;

    const totalCosts = this.closedPositions.reduce((sum, p) => sum + (p.totalCosts || 0), 0);

    // Count how many activated trailing vs initial stop
    const trailingActivated = this.closedPositions.filter(p => p.isTrailingActivated).length;
    const trailingStops = this.closedPositions.filter(p => p.exitReason === 'trailing_stop').length;
    const initialStops = this.closedPositions.filter(p => p.exitReason === 'initial_stop').length;

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0
        ? (wins.length / this.closedPositions.length) * 100
        : 0,
      totalPnL: realizedPnL,
      totalPnLPercent: (realizedPnL / this.config.initialBalance) * 100,
      currentBalance: effectiveBalance,
      peakBalance: this.peakBalance,
      totalExecutionCosts: totalCosts,

      // MEXC-specific stats
      trailingActivatedCount: trailingActivated,
      trailingStopExits: trailingStops,
      initialStopExits: initialStops,
      playedOutExits: this.closedPositions.filter(p => p.exitReason === 'played_out').length,
    };
  }

  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
  }
}

/**
 * Factory to create MEXC simulation variants of our top 3 bots
 */
export function createMexcSimulationBots(initialBalance = 2000): Map<string, MexcTrailingSimulation> {
  const bots = new Map<string, MexcTrailingSimulation>();

  // Variant of Trail Aggressive (10% pos, 20x lev)
  // Original uses discrete levels: 10% -> breakeven, 20% -> +10%, etc.
  // MEXC sim: activate at 10% ROI, 1% callback
  bots.set('mexc-aggressive', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    activationPercent: 10,    // Activate at 10% ROI (matches our L1 trigger)
    callbackPercent: 1,       // 1% callback (tight trailing)
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'aggressive'));

  // Variant with 2% callback (wider trailing)
  bots.set('mexc-aggressive-2cb', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 20,
    activationPercent: 10,
    callbackPercent: 2,       // 2% callback (wider)
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'aggressive-2cb'));

  // Variant of Trail Wide (10% pos, 10x lev, wide triggers)
  // Original: 20% trigger to start, 10% L1
  // MEXC sim: activate at 20% ROI, 1% callback
  bots.set('mexc-wide', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    activationPercent: 20,    // Activate at 20% ROI (matches Wide's trigger)
    callbackPercent: 1,
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'wide'));

  // Variant with 2% callback
  bots.set('mexc-wide-2cb', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    activationPercent: 20,
    callbackPercent: 2,
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'wide-2cb'));

  // Variant of Trail Standard (10% pos, 10x lev)
  // Original: 10% trigger, standard levels
  // MEXC sim: activate at 10% ROI, 1% callback
  bots.set('mexc-standard', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    activationPercent: 10,
    callbackPercent: 1,
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'standard'));

  // Variant with 0.5% callback (very tight)
  bots.set('mexc-standard-05cb', new MexcTrailingSimulation({
    initialBalance,
    positionSizePercent: 10,
    leverage: 10,
    activationPercent: 10,
    callbackPercent: 0.5,     // 0.5% callback (very tight)
    initialStopLossPercent: -20,
    maxOpenPositions: 10,
  }, 'standard-05cb'));

  return bots;
}
