/**
 * EXECUTION BRIDGE - Connects Focus Mode Shadow Bots to MEXC Trading Client
 *
 * This module bridges the gap between paper trading (shadow bots) and live execution.
 * It can operate in three modes:
 *
 * 1. DRY_RUN: Logs what would be executed, no API calls (for testing)
 * 2. SHADOW: Paper trade alongside live execution (mirror mode)
 * 3. LIVE: Execute real trades on MEXC
 *
 * For US users limited to spot trading:
 * - Set mode to 'spot' for spot-only execution
 * - Automatically filters to LONG setups only
 * - Uses 1x leverage (no leverage)
 */

import { EventEmitter } from 'events';
import {
  FocusModeShadowBot,
  FocusModeSignal,
  ShadowPosition,
  ClosedPosition,
  createAggressiveBot,
  createBaselineBot,
  createConservativeBot,
  createContrarianOnlyBot,
} from './focus-mode-shadow-bot.js';
import {
  getTradingClient,
  initializeTradingClient,
  OrderResult,
  PositionInfo,
} from './mexc-trading-client.js';

// ============= Types =============

export type ExecutionMode = 'dry_run' | 'shadow' | 'live';
export type TradingMode = 'futures' | 'spot';

export interface ExecutionBridgeConfig {
  mode: ExecutionMode;
  tradingMode: TradingMode;

  // Bot selection
  botType: 'baseline' | 'aggressive' | 'conservative' | 'contrarian';

  // Position limits
  maxConcurrentPositions: number;
  maxDailyTrades: number;

  // Risk limits
  maxPositionSizeUsd: number;
  maxTotalExposureUsd: number;
  maxLossPerDayUsd: number;

  // Spot mode specific (for US users)
  spotOnly: boolean;
  longOnly: boolean;

  // Reconciliation
  reconcileIntervalMs: number;
  autoCloseOrphans: boolean;

  // Logging
  logToConsole: boolean;
  logToFile: boolean;
  logPath: string;
}

export const DEFAULT_BRIDGE_CONFIG: ExecutionBridgeConfig = {
  mode: 'dry_run',
  tradingMode: 'futures',
  botType: 'aggressive',
  maxConcurrentPositions: 5,
  maxDailyTrades: 50,
  maxPositionSizeUsd: 100,
  maxTotalExposureUsd: 500,
  maxLossPerDayUsd: 100,
  spotOnly: false,
  longOnly: false,
  reconcileIntervalMs: 60000, // 1 minute
  autoCloseOrphans: false,
  logToConsole: true,
  logToFile: false,
  logPath: './logs/execution.log',
};

export interface ExecutedTrade {
  timestamp: number;
  signalId: string;
  symbol: string;
  direction: 'long' | 'short';
  action: 'open' | 'close';
  quantity: number;
  price: number;
  leverage: number;
  mode: ExecutionMode;
  orderId?: string;
  success: boolean;
  error?: string;
  shadowPositionId?: string;
}

export interface BridgeStats {
  totalSignalsReceived: number;
  signalsAccepted: number;
  signalsRejected: number;
  tradesExecuted: number;
  tradesFailed: number;
  openPositions: number;
  dailyPnl: number;
  dailyTrades: number;
  lastReconcileTime: number;
  orphanedPositions: number;
}

// ============= Execution Bridge =============

export class ExecutionBridge extends EventEmitter {
  private config: ExecutionBridgeConfig;
  private bot: FocusModeShadowBot;
  private stats: BridgeStats;
  private executedTrades: ExecutedTrade[] = [];
  private reconcileInterval: NodeJS.Timeout | null = null;
  private dailyResetTime: number = 0;

  // Track mapping between shadow positions and exchange orders
  private positionMapping: Map<string, { orderId: string; exchangePosition?: PositionInfo }> = new Map();

  constructor(config: Partial<ExecutionBridgeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };

    // Apply spot mode constraints
    if (this.config.spotOnly || this.config.tradingMode === 'spot') {
      this.config.longOnly = true;
      this.config.tradingMode = 'spot';
      console.log('[BRIDGE] Spot mode enabled: LONG positions only, 1x leverage');
    }

    // Create the appropriate bot
    this.bot = this.createBot();

    // Initialize stats
    this.stats = {
      totalSignalsReceived: 0,
      signalsAccepted: 0,
      signalsRejected: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      openPositions: 0,
      dailyPnl: 0,
      dailyTrades: 0,
      lastReconcileTime: 0,
      orphanedPositions: 0,
    };

    this.dailyResetTime = this.getNextMidnight();

    // Wire up bot events
    this.setupBotEvents();
  }

  private createBot(): FocusModeShadowBot {
    switch (this.config.botType) {
      case 'aggressive':
        return createAggressiveBot();
      case 'conservative':
        return createConservativeBot();
      case 'contrarian':
        return createContrarianOnlyBot();
      case 'baseline':
      default:
        return createBaselineBot();
    }
  }

  private setupBotEvents(): void {
    this.bot.on('position_opened', (position: ShadowPosition) => {
      this.handlePositionOpened(position);
    });

    this.bot.on('position_closed', (position: ClosedPosition) => {
      this.handlePositionClosed(position);
    });

    this.bot.on('trail_activated', (position: ShadowPosition) => {
      this.log(`Trail activated for ${position.symbol} at ${position.unrealizedPnlPercent.toFixed(1)}% ROI`);
    });
  }

  // ============= Public API =============

  /**
   * Initialize the bridge - must be called before processing signals
   */
  async initialize(): Promise<boolean> {
    this.log('Initializing Execution Bridge...');
    this.log(`Mode: ${this.config.mode}`);
    this.log(`Trading Mode: ${this.config.tradingMode}`);
    this.log(`Bot Type: ${this.config.botType}`);

    // Initialize trading client if in live mode
    if (this.config.mode === 'live') {
      const clientReady = initializeTradingClient();
      if (!clientReady) {
        this.log('WARNING: Trading client failed to initialize. Falling back to dry_run mode.');
        this.config.mode = 'dry_run';
      } else {
        const client = getTradingClient();
        const canTrade = client.canTrade();
        if (!canTrade.allowed) {
          this.log(`WARNING: Live trading not allowed: ${canTrade.reason}. Falling back to dry_run mode.`);
          this.config.mode = 'dry_run';
        }
      }
    }

    // Start reconciliation loop
    if (this.config.reconcileIntervalMs > 0) {
      this.startReconciliation();
    }

    this.log('Execution Bridge initialized');
    return true;
  }

  /**
   * Process a Focus Mode signal
   */
  async processSignal(signal: FocusModeSignal): Promise<{
    action: 'executed' | 'rejected' | 'error';
    reason: string;
    trade?: ExecutedTrade;
  }> {
    this.stats.totalSignalsReceived++;
    this.checkDailyReset();

    // Apply spot mode filter (long only)
    if (this.config.longOnly && signal.direction === 'short') {
      this.stats.signalsRejected++;
      return { action: 'rejected', reason: 'SHORT signal rejected (long-only mode)' };
    }

    // Check daily trade limit
    if (this.stats.dailyTrades >= this.config.maxDailyTrades) {
      this.stats.signalsRejected++;
      return { action: 'rejected', reason: `Daily trade limit reached (${this.config.maxDailyTrades})` };
    }

    // Check daily loss limit
    if (this.stats.dailyPnl <= -this.config.maxLossPerDayUsd) {
      this.stats.signalsRejected++;
      return { action: 'rejected', reason: `Daily loss limit reached ($${this.config.maxLossPerDayUsd})` };
    }

    // Modify signal for spot mode
    const modifiedSignal = this.config.tradingMode === 'spot'
      ? this.modifySignalForSpot(signal)
      : signal;

    // Pass to shadow bot for processing
    const botResult = this.bot.processSignal(modifiedSignal);

    if (botResult.action === 'skip') {
      this.stats.signalsRejected++;
      return { action: 'rejected', reason: botResult.reason };
    }

    // Bot accepted - now execute
    this.stats.signalsAccepted++;

    if (!botResult.position) {
      return { action: 'error', reason: 'Bot accepted but no position created' };
    }

    // Execute the trade
    const trade = await this.executeTrade(
      modifiedSignal,
      botResult.position,
      'open'
    );

    if (trade.success) {
      this.stats.tradesExecuted++;
      this.stats.dailyTrades++;
      this.stats.openPositions = this.bot.getPositions().length;
      return { action: 'executed', reason: 'Trade executed successfully', trade };
    } else {
      this.stats.tradesFailed++;
      return { action: 'error', reason: trade.error || 'Execution failed', trade };
    }
  }

  /**
   * Update positions with current prices
   */
  async updatePrices(priceMap: Map<string, number>): Promise<ClosedPosition[]> {
    const closedPositions = this.bot.updatePrices(priceMap);
    this.stats.openPositions = this.bot.getPositions().length;
    return closedPositions;
  }

  /**
   * Force close a position
   */
  async forceClose(positionId: string, reason: string = 'manual_close'): Promise<ExecutedTrade | null> {
    const position = this.bot.getPositions().find(p => p.positionId === positionId);
    if (!position) {
      this.log(`Position ${positionId} not found for force close`);
      return null;
    }

    // Create a mock signal for the close
    const closeSignal: FocusModeSignal = {
      timestamp: Date.now(),
      symbol: position.symbol,
      direction: position.direction,
      timeframe: position.timeframe,
      rsi: 50,
      currentPrice: position.currentPrice,
      entryPrice: position.currentPrice,
      suggestedLeverage: position.leverage,
      suggestedPositionSize: position.marginUsed,
      suggestedStopLoss: position.stopLoss,
      suggestedTakeProfit: position.takeProfit,
      trailTriggerPercent: 10,
      macroRegime: 'neutral',
      microRegime: 'neutral',
      quadrant: 'NEU+NEU',
      quality: 'skip',
      qualityScore: 0,
      impulsePercent: 0,
    };

    return this.executeTrade(closeSignal, position, 'close');
  }

  /**
   * Emergency close all positions
   */
  async emergencyCloseAll(): Promise<{ closed: number; failed: number }> {
    this.log('EMERGENCY CLOSE ALL triggered');

    let closed = 0;
    let failed = 0;

    for (const position of this.bot.getPositions()) {
      const trade = await this.forceClose(position.positionId, 'emergency_close');
      if (trade?.success) {
        closed++;
      } else {
        failed++;
      }
    }

    // Also close on exchange if in live mode
    if (this.config.mode === 'live') {
      const client = getTradingClient();
      const result = await client.emergencyCloseAll();
      this.log(`Exchange emergency close: ${result.closed} closed, ${result.failed} failed`);
    }

    return { closed, failed };
  }

  // ============= Private Methods =============

  private modifySignalForSpot(signal: FocusModeSignal): FocusModeSignal {
    // For spot trading:
    // - Set leverage to 1
    // - Adjust position size accordingly
    // - Widen stops (no liquidation risk)
    return {
      ...signal,
      suggestedLeverage: 1,
      suggestedPositionSize: signal.suggestedPositionSize * signal.suggestedLeverage, // Scale up since no leverage
    };
  }

  private async executeTrade(
    signal: FocusModeSignal,
    position: ShadowPosition,
    action: 'open' | 'close'
  ): Promise<ExecutedTrade> {
    const trade: ExecutedTrade = {
      timestamp: Date.now(),
      signalId: position.positionId,
      symbol: signal.symbol,
      direction: signal.direction,
      action,
      quantity: position.notionalSize / signal.currentPrice, // Convert to quantity
      price: signal.currentPrice,
      leverage: position.leverage,
      mode: this.config.mode,
      success: false,
      shadowPositionId: position.positionId,
    };

    this.log(`${action.toUpperCase()} ${signal.symbol} ${signal.direction.toUpperCase()} @ ${signal.currentPrice}`);

    switch (this.config.mode) {
      case 'dry_run':
        // Just log, no execution
        trade.success = true;
        this.log(`[DRY RUN] Would ${action} ${signal.symbol} ${signal.direction} x${position.leverage} qty:${trade.quantity.toFixed(4)}`);
        break;

      case 'shadow':
        // Paper trade only (shadow bot handles it)
        trade.success = true;
        this.log(`[SHADOW] Paper ${action} ${signal.symbol} ${signal.direction}`);
        break;

      case 'live':
        // Execute on exchange
        const result = await this.executeOnExchange(signal, position, action);
        trade.success = result.success;
        trade.orderId = result.orderId;
        trade.error = result.error;

        if (result.success) {
          this.positionMapping.set(position.positionId, { orderId: result.orderId! });
          this.log(`[LIVE] Executed ${action} ${signal.symbol} ${signal.direction} - Order ID: ${result.orderId}`);
        } else {
          this.log(`[LIVE] FAILED ${action} ${signal.symbol}: ${result.error}`);
        }
        break;
    }

    this.executedTrades.push(trade);
    this.emit('trade_executed', trade);

    return trade;
  }

  private async executeOnExchange(
    signal: FocusModeSignal,
    position: ShadowPosition,
    action: 'open' | 'close'
  ): Promise<OrderResult> {
    const client = getTradingClient();

    // Convert notional to quantity
    const quantity = position.notionalSize / signal.currentPrice;

    if (action === 'open') {
      return client.placeMarketOrder(
        signal.symbol,
        signal.direction,
        quantity,
        position.leverage,
        false // not reduce-only
      );
    } else {
      return client.closePosition(signal.symbol, signal.direction, quantity);
    }
  }

  private handlePositionOpened(position: ShadowPosition): void {
    this.log(`Position opened: ${position.symbol} ${position.direction.toUpperCase()} @ ${position.entryPrice}`);
    this.emit('position_opened', position);
  }

  private handlePositionClosed(position: ClosedPosition): void {
    this.stats.dailyPnl += position.realizedPnl;
    this.stats.openPositions = this.bot.getPositions().length;

    this.log(`Position closed: ${position.symbol} | PnL: $${position.realizedPnl.toFixed(2)} | Reason: ${position.exitReason}`);
    this.emit('position_closed', position);

    // Clean up mapping
    this.positionMapping.delete(position.positionId);

    // Execute close on exchange if in live mode
    if (this.config.mode === 'live') {
      this.executeCloseOnExchange(position);
    }
  }

  private async executeCloseOnExchange(position: ClosedPosition): Promise<void> {
    const mapping = this.positionMapping.get(position.positionId);
    if (!mapping) return;

    const client = getTradingClient();
    const result = await client.closePosition(
      position.symbol,
      position.direction
    );

    if (!result.success) {
      this.log(`WARNING: Failed to close ${position.symbol} on exchange: ${result.error}`);
    }
  }

  // ============= Reconciliation =============

  private startReconciliation(): void {
    if (this.reconcileInterval) return;

    this.reconcileInterval = setInterval(async () => {
      await this.reconcile();
    }, this.config.reconcileIntervalMs);

    this.log(`Reconciliation started (every ${this.config.reconcileIntervalMs / 1000}s)`);
  }

  /**
   * Reconcile shadow positions with exchange positions
   */
  async reconcile(): Promise<{ matched: number; orphaned: number; missing: number }> {
    if (this.config.mode !== 'live') {
      return { matched: 0, orphaned: 0, missing: 0 };
    }

    const client = getTradingClient();
    if (!client.isReady()) {
      return { matched: 0, orphaned: 0, missing: 0 };
    }

    try {
      const exchangePositions = await client.getOpenPositions();
      const shadowPositions = this.bot.getPositions();

      let matched = 0;
      let orphaned = 0;
      let missing = 0;

      // Check each exchange position
      for (const exchPos of exchangePositions) {
        const shadowMatch = shadowPositions.find(
          sp => sp.symbol === exchPos.symbol &&
                sp.direction === (exchPos.side === 'LONG' ? 'long' : 'short')
        );

        if (shadowMatch) {
          matched++;
        } else {
          orphaned++;
          this.log(`WARNING: Orphaned exchange position: ${exchPos.symbol} ${exchPos.side}`);

          if (this.config.autoCloseOrphans) {
            this.log(`Auto-closing orphaned position: ${exchPos.symbol}`);
            await client.closePosition(
              exchPos.symbol,
              exchPos.side === 'LONG' ? 'long' : 'short'
            );
          }
        }
      }

      // Check for shadow positions without exchange counterpart
      for (const shadowPos of shadowPositions) {
        const exchMatch = exchangePositions.find(
          ep => ep.symbol === shadowPos.symbol &&
                ep.side === (shadowPos.direction === 'long' ? 'LONG' : 'SHORT')
        );

        if (!exchMatch) {
          missing++;
          this.log(`WARNING: Shadow position missing on exchange: ${shadowPos.symbol} ${shadowPos.direction}`);
        }
      }

      this.stats.lastReconcileTime = Date.now();
      this.stats.orphanedPositions = orphaned;

      return { matched, orphaned, missing };
    } catch (error) {
      this.log(`Reconciliation error: ${(error as Error).message}`);
      return { matched: 0, orphaned: 0, missing: 0 };
    }
  }

  // ============= Utility =============

  private checkDailyReset(): void {
    if (Date.now() >= this.dailyResetTime) {
      this.log('Daily reset triggered');
      this.stats.dailyPnl = 0;
      this.stats.dailyTrades = 0;
      this.dailyResetTime = this.getNextMidnight();
    }
  }

  private getNextMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    return midnight.getTime();
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[BRIDGE ${timestamp}] ${message}`;

    if (this.config.logToConsole) {
      console.log(logMessage);
    }

    // TODO: Add file logging if needed
    this.emit('log', logMessage);
  }

  // ============= Getters =============

  getStats(): BridgeStats {
    return { ...this.stats };
  }

  getConfig(): ExecutionBridgeConfig {
    return { ...this.config };
  }

  getBotStats() {
    return this.bot.getStats();
  }

  getOpenPositions(): ShadowPosition[] {
    return this.bot.getPositions();
  }

  getExecutedTrades(limit?: number): ExecutedTrade[] {
    if (limit) {
      return this.executedTrades.slice(-limit);
    }
    return [...this.executedTrades];
  }

  getCurrentRegime() {
    return this.bot.getCurrentRegime();
  }

  getBalance(): number {
    return this.bot.getBalance();
  }

  // ============= Cleanup =============

  destroy(): void {
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }
    this.removeAllListeners();
    this.log('Execution Bridge destroyed');
  }
}

// ============= Factory Functions =============

/**
 * Create a bridge for US users (spot only, long only)
 */
export function createSpotOnlyBridge(balance: number = 2000): ExecutionBridge {
  return new ExecutionBridge({
    mode: 'dry_run',
    tradingMode: 'spot',
    spotOnly: true,
    longOnly: true,
    botType: 'aggressive',
    maxPositionSizeUsd: balance * 0.25, // 25% max per position
    maxTotalExposureUsd: balance * 0.8,  // 80% max total
    maxLossPerDayUsd: balance * 0.05,    // 5% max daily loss
  });
}

/**
 * Create a bridge for futures trading
 */
export function createFuturesBridge(balance: number = 2000): ExecutionBridge {
  return new ExecutionBridge({
    mode: 'dry_run',
    tradingMode: 'futures',
    botType: 'aggressive',
    maxPositionSizeUsd: balance * 0.1,   // 10% max per position
    maxTotalExposureUsd: balance * 0.5,  // 50% max total
    maxLossPerDayUsd: balance * 0.1,     // 10% max daily loss
  });
}

/**
 * Create a bridge configured for live trading
 * WARNING: This will execute real trades!
 */
export function createLiveBridge(
  config: Partial<ExecutionBridgeConfig>
): ExecutionBridge {
  // Force some safety settings
  const safeConfig: Partial<ExecutionBridgeConfig> = {
    ...config,
    mode: 'live',
    reconcileIntervalMs: Math.max(config.reconcileIntervalMs || 60000, 30000), // Min 30s
    autoCloseOrphans: false, // Never auto-close in live mode by default
  };

  return new ExecutionBridge(safeConfig);
}

// Export types
export type { FocusModeSignal, ShadowPosition, ClosedPosition };
