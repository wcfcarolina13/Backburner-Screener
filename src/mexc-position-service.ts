/**
 * MEXC Position Service - Phase 1 (Wrapper)
 *
 * This is a facade that wraps existing position management code.
 * Phase 1 goal: NO behavior changes, just consolidation and logging.
 *
 * All MEXC position operations should go through this service.
 * Internally, it delegates to:
 * - MexcTrailingManager (trailing stop logic)
 * - MexcFuturesClient (API calls)
 * - Existing queue in web-server.ts (via callbacks)
 */

import { EventEmitter } from 'events';
import type { MexcFuturesClient } from './mexc-futures-client.js';
import type { MexcTrailingManager, TrackedPosition } from './mexc-trailing-manager.js';
import {
  type MexcPosition,
  type PositionState,
  type QueueParams,
  type ExecutionResult,
  type ReconcileResult,
  type PositionEvent,
  type PositionEventHandler,
  type PositionServiceConfig,
  type ExitReason,
  isValidTransition,
  isTerminalState,
  generatePositionId,
  spotToFuturesSymbol,
} from './mexc-position-types.js';

// ============= Service Implementation =============

export class MexcPositionService extends EventEmitter {
  private static instance: MexcPositionService | null = null;

  // Internal state - maps symbol to position
  private positions: Map<string, MexcPosition> = new Map();

  // External dependencies (injected)
  private client: MexcFuturesClient | null = null;
  private trailingManager: MexcTrailingManager | null = null;

  // Config
  private config: PositionServiceConfig;

  // Callbacks for integration with web-server.ts queue
  private onQueueAdd?: (params: QueueParams) => void;
  private onQueueExecute?: (symbol: string) => Promise<ExecutionResult>;

  private constructor() {
    super();
    this.config = this.getDefaultConfig();
    console.log('[POS-SVC] MexcPositionService initialized (Phase 1 wrapper)');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MexcPositionService {
    if (!MexcPositionService.instance) {
      MexcPositionService.instance = new MexcPositionService();
    }
    return MexcPositionService.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    MexcPositionService.instance = null;
  }

  // ============= Configuration =============

  private getDefaultConfig(): PositionServiceConfig {
    return {
      defaultLeverage: 10,
      defaultMarginUsd: 50,
      maxMarginUsd: 100,
      maxLeverage: 20,
      defaultInitialStopPct: 8,
      trailTriggerPct: 10,
      trailStepPct: 5,
      useProfitTieredTrail: true,
      profitTiers: [
        { minRoePct: 50, trailStepPct: 2 },
        { minRoePct: 30, trailStepPct: 3 },
        { minRoePct: 20, trailStepPct: 4 },
        { minRoePct: 0, trailStepPct: 5 },
      ],
      gracePeriodsMs: 90000,
      minSlModifyIntervalMs: 5000,
      planOrderRenewalDays: 6,
      executionMode: 'shadow',
      autoExecute: false,
    };
  }

  /**
   * Update service configuration
   */
  updateConfig(partial: Partial<PositionServiceConfig>): void {
    this.config = { ...this.config, ...partial };
    console.log('[POS-SVC] Config updated:', Object.keys(partial).join(', '));
  }

  /**
   * Get current configuration
   */
  getConfig(): PositionServiceConfig {
    return { ...this.config };
  }

  // ============= Dependency Injection =============

  /**
   * Inject MEXC API client
   */
  setClient(client: MexcFuturesClient): void {
    this.client = client;
    console.log('[POS-SVC] MEXC client injected');
  }

  /**
   * Inject trailing manager (Phase 1: delegate to existing manager)
   */
  setTrailingManager(manager: MexcTrailingManager): void {
    this.trailingManager = manager;
    console.log('[POS-SVC] Trailing manager injected');
  }

  /**
   * Set queue callbacks for integration with web-server.ts
   */
  setQueueCallbacks(
    onAdd: (params: QueueParams) => void,
    onExecute: (symbol: string) => Promise<ExecutionResult>
  ): void {
    this.onQueueAdd = onAdd;
    this.onQueueExecute = onExecute;
    console.log('[POS-SVC] Queue callbacks registered');
  }

  // ============= Queue Operations =============

  /**
   * Add a position to the execution queue
   * Phase 1: Delegates to web-server.ts queue via callback
   */
  addToQueue(params: QueueParams): MexcPosition | null {
    const futuresSymbol = spotToFuturesSymbol(params.symbol);

    // Check if already have position in this symbol
    if (this.positions.has(futuresSymbol)) {
      console.log(`[POS-SVC] Skipping ${futuresSymbol} - already have position`);
      return null;
    }

    // Create position object
    const position: MexcPosition = {
      id: generatePositionId(params.botId, futuresSymbol),
      symbol: futuresSymbol,
      state: 'queued',
      stateHistory: [{ from: 'queued', to: 'queued', timestamp: Date.now(), reason: 'created' }],
      direction: params.direction,
      entryPrice: 0,  // Will be filled on execution
      entryTime: 0,
      volume: 0,
      leverage: params.leverage ?? this.config.defaultLeverage,
      marginUsed: params.marginUsd ?? this.config.defaultMarginUsd,
      initialStopPrice: 0,
      currentStopPrice: 0,
      planOrderId: '',
      planOrderCreatedAt: 0,
      trailActivated: false,
      trailTriggerPct: this.config.trailTriggerPct,
      trailStepPct: this.config.trailStepPct,
      highestRoePct: 0,
      highestPrice: 0,
      lowestPrice: 0,
      botId: params.botId,
      signalSource: params.signalSource,
      entryQuadrant: params.entryQuadrant,
      entryBias: params.entryBias,
      executionMode: this.config.executionMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Store in our map
    this.positions.set(futuresSymbol, position);

    // Delegate to existing queue
    if (this.onQueueAdd) {
      this.onQueueAdd(params);
    }

    console.log(`[POS-SVC] Queued ${futuresSymbol} ${params.direction} from ${params.botId}`);
    this.emitEvent({ type: 'stateChange', position, oldState: 'queued', newState: 'queued' });

    return position;
  }

  /**
   * Get all queued positions
   */
  getQueuedPositions(): MexcPosition[] {
    return Array.from(this.positions.values()).filter(p => p.state === 'queued');
  }

  /**
   * Remove a position from the queue
   */
  removeFromQueue(symbol: string): boolean {
    const futuresSymbol = spotToFuturesSymbol(symbol);
    const pos = this.positions.get(futuresSymbol);

    if (!pos || pos.state !== 'queued') {
      return false;
    }

    this.positions.delete(futuresSymbol);
    console.log(`[POS-SVC] Removed ${futuresSymbol} from queue`);
    return true;
  }

  // ============= Execution =============

  /**
   * Execute a queued position
   * Phase 1: Delegates to existing execution logic via callback
   */
  async execute(symbol: string): Promise<ExecutionResult> {
    const futuresSymbol = spotToFuturesSymbol(symbol);
    const pos = this.positions.get(futuresSymbol);

    if (!pos) {
      return { success: false, error: `Position ${futuresSymbol} not found` };
    }

    if (pos.state !== 'queued') {
      return { success: false, error: `Position ${futuresSymbol} not in queued state (is ${pos.state})` };
    }

    // Transition to executing
    this.transitionState(pos, 'executing', 'execution started');

    // Delegate to existing execution
    if (this.onQueueExecute) {
      try {
        const result = await this.onQueueExecute(symbol);

        if (result.success) {
          this.transitionState(pos, 'open', 'execution succeeded');
          pos.updatedAt = Date.now();
          console.log(`[POS-SVC] Executed ${futuresSymbol} successfully`);
        } else {
          this.transitionState(pos, 'failed', result.error || 'execution failed');
          console.log(`[POS-SVC] Execution failed for ${futuresSymbol}: ${result.error}`);
        }

        return result;
      } catch (err) {
        this.transitionState(pos, 'failed', (err as Error).message);
        return { success: false, error: (err as Error).message };
      }
    }

    return { success: false, error: 'No execution callback registered' };
  }

  // ============= Position Management =============

  /**
   * Get a position by symbol
   */
  getPosition(symbol: string): MexcPosition | undefined {
    const futuresSymbol = symbol.includes('_') ? symbol : spotToFuturesSymbol(symbol);
    return this.positions.get(futuresSymbol);
  }

  /**
   * Get all positions
   */
  getAllPositions(): MexcPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions by state
   */
  getPositionsByState(state: PositionState): MexcPosition[] {
    return Array.from(this.positions.values()).filter(p => p.state === state);
  }

  /**
   * Sync internal state from trailing manager
   * Phase 1: Pull state from existing manager into our unified view
   */
  syncFromTrailingManager(): void {
    if (!this.trailingManager) {
      console.warn('[POS-SVC] Cannot sync - no trailing manager');
      return;
    }

    const trackedPositions = this.trailingManager.getTrackedPositions();

    for (const tracked of trackedPositions) {
      let pos = this.positions.get(tracked.symbol);

      if (!pos) {
        // Position exists in trailing manager but not in our map - adopt it
        pos = this.adoptFromTrailingManager(tracked);
        this.positions.set(tracked.symbol, pos);
        console.log(`[POS-SVC] Adopted ${tracked.symbol} from trailing manager`);
      } else {
        // Update our position with trailing manager state
        pos.currentStopPrice = tracked.currentStopPrice;
        pos.planOrderId = tracked.planOrderId;
        pos.trailActivated = tracked.trailActivated;
        pos.highestRoePct = tracked.highestRoePct;
        pos.highestPrice = tracked.highestPrice;
        pos.lowestPrice = tracked.lowestPrice;

        // Update state if trail activated
        if (tracked.trailActivated && pos.state === 'open') {
          this.transitionState(pos, 'trailing', 'trail activated');
        }

        pos.updatedAt = Date.now();
      }
    }

    // Check for positions we have that trailing manager doesn't
    const trackedSymbols = new Set(trackedPositions.map(p => p.symbol));
    for (const [symbol, pos] of this.positions) {
      if (!isTerminalState(pos.state) && !trackedSymbols.has(symbol) && pos.state !== 'queued') {
        // Position closed externally
        console.log(`[POS-SVC] ${symbol} no longer in trailing manager - may have closed`);
      }
    }
  }

  /**
   * Create MexcPosition from TrackedPosition
   */
  private adoptFromTrailingManager(tracked: TrackedPosition): MexcPosition {
    return {
      id: `adopted-${tracked.symbol}-${Date.now()}`,
      symbol: tracked.symbol,
      state: tracked.trailActivated ? 'trailing' : 'open',
      stateHistory: [{ from: 'open', to: tracked.trailActivated ? 'trailing' : 'open', timestamp: Date.now(), reason: 'adopted' }],
      direction: tracked.direction,
      entryPrice: tracked.entryPrice,
      entryTime: tracked.startedAt || Date.now(),
      volume: tracked.volume,
      leverage: tracked.leverage,
      marginUsed: 0,  // Unknown for adopted positions
      initialStopPrice: tracked.initialStopPct ? tracked.entryPrice * (1 - tracked.initialStopPct / 100 / tracked.leverage) : tracked.currentStopPrice,
      currentStopPrice: tracked.currentStopPrice,
      planOrderId: tracked.planOrderId,
      planOrderCreatedAt: tracked.planOrderCreatedAt || Date.now(),
      trailActivated: tracked.trailActivated,
      trailActivatedAt: tracked.trailActivated ? Date.now() : undefined,
      trailTriggerPct: this.config.trailTriggerPct,
      trailStepPct: this.config.trailStepPct,
      highestRoePct: tracked.highestRoePct,
      highestPrice: tracked.highestPrice,
      lowestPrice: tracked.lowestPrice,
      botId: tracked.botId || 'unknown',
      signalSource: 'reconciled',
      executionMode: 'live',
      createdAt: tracked.startedAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ============= Stop Loss Operations =============

  /**
   * Update stop loss for a position
   * Phase 1: Delegates to trailing manager
   */
  async updateStopLoss(symbol: string, newPrice: number): Promise<boolean> {
    const futuresSymbol = symbol.includes('_') ? symbol : spotToFuturesSymbol(symbol);
    const pos = this.positions.get(futuresSymbol);

    if (!pos) {
      console.warn(`[POS-SVC] Cannot update SL - position ${futuresSymbol} not found`);
      return false;
    }

    if (!this.trailingManager || !this.client) {
      console.warn('[POS-SVC] Cannot update SL - missing dependencies');
      return false;
    }

    const oldPrice = pos.currentStopPrice;

    // Delegate to trailing manager
    const tracked = this.trailingManager.getPosition(futuresSymbol);
    if (tracked) {
      // The trailing manager will handle the actual MEXC call
      // For Phase 1, we just update our view
      pos.currentStopPrice = newPrice;
      pos.updatedAt = Date.now();

      console.log(`[POS-SVC] SL updated ${futuresSymbol}: $${oldPrice.toFixed(4)} → $${newPrice.toFixed(4)}`);
      this.emitEvent({ type: 'slUpdated', position: pos, oldPrice, newPrice });
      return true;
    }

    return false;
  }

  // ============= Close Detection =============

  /**
   * Mark a position as closed
   */
  markClosed(symbol: string, exitData: {
    exitPrice: number;
    exitReason: ExitReason;
    realizedPnl?: number;
    realizedPnlPct?: number;
  }): void {
    const futuresSymbol = symbol.includes('_') ? symbol : spotToFuturesSymbol(symbol);
    const pos = this.positions.get(futuresSymbol);

    if (!pos) {
      console.warn(`[POS-SVC] Cannot mark closed - position ${futuresSymbol} not found`);
      return;
    }

    pos.exitPrice = exitData.exitPrice;
    pos.exitTime = Date.now();
    pos.exitReason = exitData.exitReason;
    pos.realizedPnl = exitData.realizedPnl;
    pos.realizedPnlPct = exitData.realizedPnlPct;
    pos.updatedAt = Date.now();

    this.transitionState(pos, 'closed', exitData.exitReason);
    console.log(`[POS-SVC] Closed ${futuresSymbol}: ${exitData.exitReason} @ $${exitData.exitPrice.toFixed(4)} | PnL: $${exitData.realizedPnl?.toFixed(2) ?? '?'}`);
    this.emitEvent({ type: 'closed', position: pos });
  }

  // ============= State Management =============

  /**
   * Transition position to new state with validation
   */
  private transitionState(pos: MexcPosition, newState: PositionState, reason?: string): boolean {
    const oldState = pos.state;

    if (!isValidTransition(oldState, newState)) {
      console.error(`[POS-SVC] Invalid state transition ${pos.symbol}: ${oldState} → ${newState}`);
      return false;
    }

    pos.state = newState;
    pos.stateHistory.push({
      from: oldState,
      to: newState,
      timestamp: Date.now(),
      reason,
    });
    pos.updatedAt = Date.now();

    console.log(`[POS-SVC] ${pos.symbol} state: ${oldState} → ${newState}${reason ? ` (${reason})` : ''}`);
    this.emitEvent({ type: 'stateChange', position: pos, oldState, newState });

    return true;
  }

  // ============= Events =============

  /**
   * Emit a position event
   */
  private emitEvent(event: PositionEvent): void {
    this.emit(event.type, event);
    this.emit('*', event);  // Wildcard for all events
  }

  /**
   * Subscribe to position events
   */
  onEvent(handler: PositionEventHandler): void {
    this.on('*', handler);
  }

  // ============= Diagnostics =============

  /**
   * Get service summary for logging/debugging
   */
  getSummary(): string {
    const byState: Record<PositionState, number> = {
      queued: 0,
      executing: 0,
      open: 0,
      trailing: 0,
      closing: 0,
      closed: 0,
      failed: 0,
    };

    for (const pos of this.positions.values()) {
      byState[pos.state]++;
    }

    const parts: string[] = [];
    if (byState.queued > 0) parts.push(`${byState.queued} queued`);
    if (byState.open > 0) parts.push(`${byState.open} open`);
    if (byState.trailing > 0) parts.push(`${byState.trailing} trailing`);
    if (byState.closed > 0) parts.push(`${byState.closed} closed`);

    return `[POS-SVC] ${this.positions.size} positions: ${parts.join(', ') || 'none'}`;
  }

  /**
   * Get detailed state for API response
   */
  getState(): {
    config: PositionServiceConfig;
    positions: MexcPosition[];
    summary: { byState: Record<PositionState, number>; total: number };
  } {
    const byState: Record<PositionState, number> = {
      queued: 0,
      executing: 0,
      open: 0,
      trailing: 0,
      closing: 0,
      closed: 0,
      failed: 0,
    };

    for (const pos of this.positions.values()) {
      byState[pos.state]++;
    }

    return {
      config: this.config,
      positions: Array.from(this.positions.values()),
      summary: { byState, total: this.positions.size },
    };
  }
}

// Export singleton accessor
export function getPositionService(): MexcPositionService {
  return MexcPositionService.getInstance();
}
