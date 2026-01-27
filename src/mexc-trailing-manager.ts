/**
 * MEXC Exchange-Side Trailing Stop Manager
 *
 * Manages trailing stops directly on MEXC via plan order modifications.
 * The exchange-side SL plan order is the source of truth — it fires
 * regardless of whether our server is running.
 *
 * The server's role is to IMPROVE the SL by ratcheting it up.
 * If the server goes down, the last-set SL still protects the position.
 */

import type { MexcFuturesClient } from './mexc-futures-client.js';

// Tracked position with exchange-side trailing stop
export interface TrackedPosition {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  leverage: number;            // Actual MEXC leverage (e.g. 3x)
  volume: number;              // Contract volume on MEXC
  planOrderId: string;         // MEXC SL plan order ID
  currentStopPrice: number;    // Current SL trigger price on MEXC
  highestPrice: number;        // Peak price since entry (longs)
  lowestPrice: number;         // Trough price since entry (shorts)
  highestRoePct: number;       // Peak ROE% seen
  trailActivated: boolean;     // Whether trail has been activated
  trailTriggerPct: number;     // ROE% to activate trail
  trailStepPct: number;        // ROE% trailing step
  initialStopPct: number;      // Price% for initial SL
  planOrderCreatedAt: number;  // Timestamp for 7-day renewal
  botId: string;               // Which bot owns this
  startedAt: number;           // When tracking began
}

export interface TrailingManagerConfig {
  trailTriggerPct: number;     // Default: 10 (10% ROE to activate)
  trailStepPct: number;        // Default: 5 (5% ROE trailing step)
  initialStopPct: number;      // Default: 8 (8% price distance)
  renewalDays: number;         // Default: 6 (renew plan orders after 6 days)
  minModifyIntervalMs: number; // Default: 5000 (don't spam MEXC API)
}

const DEFAULT_CONFIG: TrailingManagerConfig = {
  trailTriggerPct: 10,
  trailStepPct: 5,
  initialStopPct: 8,
  renewalDays: 6,
  minModifyIntervalMs: 5000,
};

export class MexcTrailingManager {
  private positions = new Map<string, TrackedPosition>();
  private config: TrailingManagerConfig;
  private lastModifyTime = new Map<string, number>();
  private onPositionClosed?: (symbol: string, reason: string) => void;

  constructor(config?: Partial<TrailingManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a callback for when a tracked position is detected as closed
   */
  setOnPositionClosed(cb: (symbol: string, reason: string) => void): void {
    this.onPositionClosed = cb;
  }

  /**
   * Start tracking a newly opened MEXC position.
   * Fetches the SL plan order ID from MEXC.
   */
  async startTracking(
    client: MexcFuturesClient,
    params: {
      symbol: string;
      direction: 'long' | 'short';
      entryPrice: number;
      leverage: number;
      volume: number;
      stopLossPrice: number;
      botId: string;
      trailTriggerPct?: number;
      trailStepPct?: number;
      initialStopPct?: number;
    }
  ): Promise<boolean> {
    const { symbol } = params;

    // Fetch plan orders to find the SL order ID
    let planOrderId = '';
    try {
      const planOrders = await client.getPlanOrders(symbol);
      if (planOrders.success && planOrders.data && planOrders.data.length > 0) {
        // Find the SL plan order (for longs: triggerType=2 means <=, for shorts: triggerType=1 means >=)
        const slOrder = planOrders.data.find((o: any) =>
          params.direction === 'long' ? o.triggerType === 2 : o.triggerType === 1
        );
        if (slOrder) {
          planOrderId = String(slOrder.id);
        } else {
          // Take the first plan order as fallback
          planOrderId = String(planOrders.data[0].id);
        }
      }
    } catch (err) {
      console.error(`[TRAIL-MGR] Failed to fetch plan orders for ${symbol}:`, (err as Error).message);
    }

    if (!planOrderId) {
      console.warn(`[TRAIL-MGR] No plan order found for ${symbol} — position is unprotected!`);
      // Still track it — we can create a plan order later
    }

    const tracked: TrackedPosition = {
      symbol,
      direction: params.direction,
      entryPrice: params.entryPrice,
      leverage: params.leverage,
      volume: params.volume,
      planOrderId,
      currentStopPrice: params.stopLossPrice,
      highestPrice: params.entryPrice,
      lowestPrice: params.entryPrice,
      highestRoePct: 0,
      trailActivated: false,
      trailTriggerPct: params.trailTriggerPct ?? this.config.trailTriggerPct,
      trailStepPct: params.trailStepPct ?? this.config.trailStepPct,
      initialStopPct: params.initialStopPct ?? this.config.initialStopPct,
      planOrderCreatedAt: Date.now(),
      botId: params.botId,
      startedAt: Date.now(),
    };

    this.positions.set(symbol, tracked);
    console.log(`[TRAIL-MGR] Tracking ${symbol} ${params.direction} @ $${params.entryPrice} | ${params.leverage}x | SL: $${params.stopLossPrice} | PlanOrder: ${planOrderId || 'NONE'}`);
    return true;
  }

  /**
   * Update prices and manage trailing stops on MEXC.
   * Call this on every price tick.
   * Returns symbols that had their SL modified.
   */
  async updatePrices(
    client: MexcFuturesClient,
    priceMap: Map<string, number>
  ): Promise<string[]> {
    const modified: string[] = [];

    for (const [symbol, pos] of this.positions) {
      const currentPrice = priceMap.get(symbol);
      if (!currentPrice) continue;

      // Update peak/trough price
      if (pos.direction === 'long') {
        if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      } else {
        if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;
      }

      // Calculate current ROE% at actual MEXC leverage
      const priceDiff = pos.direction === 'long'
        ? currentPrice - pos.entryPrice
        : pos.entryPrice - currentPrice;
      const currentRoePct = (priceDiff / pos.entryPrice) * 100 * pos.leverage;

      // Track peak ROE
      if (currentRoePct > pos.highestRoePct) {
        pos.highestRoePct = currentRoePct;
      }

      // Check trail activation
      if (!pos.trailActivated && pos.highestRoePct >= pos.trailTriggerPct) {
        pos.trailActivated = true;
        console.log(`[TRAIL-MGR] Trail ACTIVATED for ${symbol} | Peak ROE: ${pos.highestRoePct.toFixed(1)}% | Trigger: ${pos.trailTriggerPct}%`);

        // Move SL to breakeven + buffer
        const beBuffer = pos.entryPrice * ((pos.trailTriggerPct - pos.trailStepPct) / 100 / pos.leverage);
        const newStop = pos.direction === 'long'
          ? pos.entryPrice + beBuffer
          : pos.entryPrice - beBuffer;

        const didModify = await this.modifyStopOnMexc(client, pos, newStop);
        if (didModify) modified.push(symbol);
      }

      // Ratchet trailing stop
      if (pos.trailActivated) {
        const trailPnl = pos.highestRoePct - pos.trailStepPct;
        if (trailPnl > 0) {
          const trailDistance = pos.entryPrice * (trailPnl / 100 / pos.leverage);
          const newStop = pos.direction === 'long'
            ? pos.entryPrice + trailDistance
            : pos.entryPrice - trailDistance;

          // Only ratchet UP for longs, DOWN for shorts
          const shouldUpdate = pos.direction === 'long'
            ? newStop > pos.currentStopPrice
            : newStop < pos.currentStopPrice;

          if (shouldUpdate) {
            const didModify = await this.modifyStopOnMexc(client, pos, newStop);
            if (didModify) modified.push(symbol);
          }
        }
      }

      // Check plan order renewal (6 days = renew before 7-day expiry)
      const ageMs = Date.now() - pos.planOrderCreatedAt;
      const renewalMs = this.config.renewalDays * 24 * 60 * 60 * 1000;
      if (pos.planOrderId && ageMs > renewalMs) {
        await this.renewPlanOrder(client, pos);
      }
    }

    return modified;
  }

  /**
   * Modify the SL plan order on MEXC
   */
  private async modifyStopOnMexc(
    client: MexcFuturesClient,
    pos: TrackedPosition,
    newStopPrice: number
  ): Promise<boolean> {
    // Rate limit: don't spam MEXC API
    const lastModify = this.lastModifyTime.get(pos.symbol) || 0;
    if (Date.now() - lastModify < this.config.minModifyIntervalMs) {
      return false;
    }

    if (!pos.planOrderId) {
      console.warn(`[TRAIL-MGR] Cannot modify SL for ${pos.symbol} — no plan order ID`);
      return false;
    }

    try {
      const result = await client.modifyStopOrder({
        stopPlanOrderId: pos.planOrderId,
        stopLossPrice: newStopPrice,
      });

      if (result.success) {
        const oldStop = pos.currentStopPrice;
        pos.currentStopPrice = newStopPrice;
        this.lastModifyTime.set(pos.symbol, Date.now());
        console.log(`[TRAIL-MGR] SL modified for ${pos.symbol}: $${oldStop.toFixed(4)} → $${newStopPrice.toFixed(4)} | ROE peak: ${pos.highestRoePct.toFixed(1)}% | Trail: ${pos.trailActivated ? 'ACTIVE' : 'inactive'}`);
        return true;
      } else {
        console.error(`[TRAIL-MGR] Failed to modify SL for ${pos.symbol}: ${result.error}`);
        return false;
      }
    } catch (err) {
      console.error(`[TRAIL-MGR] Error modifying SL for ${pos.symbol}:`, (err as Error).message);
      return false;
    }
  }

  /**
   * Renew a plan order that's approaching 7-day expiry.
   * Cancels old order and creates a new one at the same trigger price.
   */
  private async renewPlanOrder(
    client: MexcFuturesClient,
    pos: TrackedPosition
  ): Promise<void> {
    console.log(`[TRAIL-MGR] Renewing plan order for ${pos.symbol} (age: ${((Date.now() - pos.planOrderCreatedAt) / 86400000).toFixed(1)} days)`);

    try {
      // Cancel old plan order
      if (pos.planOrderId) {
        await client.cancelPlanOrder(pos.planOrderId);
      }

      // Create new plan order at current stop price
      // Import OrderSide values: CLOSE_LONG = 4, CLOSE_SHORT = 2
      const side = pos.direction === 'long' ? 4 : 2;
      const triggerType = pos.direction === 'long' ? 2 : 1; // <= for long SL, >= for short SL

      const result = await client.createStopOrder({
        symbol: pos.symbol,
        vol: pos.volume,
        side,
        triggerPrice: pos.currentStopPrice,
        triggerType,
        executeCycle: 2, // 7 days
        orderType: 5,    // Market
        leverage: pos.leverage,
      });

      if (result.success && result.data) {
        pos.planOrderId = String(result.data.id || result.data);
        pos.planOrderCreatedAt = Date.now();
        console.log(`[TRAIL-MGR] Renewed plan order for ${pos.symbol}: new ID ${pos.planOrderId}`);
      } else {
        console.error(`[TRAIL-MGR] Failed to renew plan order for ${pos.symbol}: ${result.error}`);
      }
    } catch (err) {
      console.error(`[TRAIL-MGR] Error renewing plan order for ${pos.symbol}:`, (err as Error).message);
    }
  }

  /**
   * Stop tracking a position (when it's closed).
   */
  stopTracking(symbol: string): TrackedPosition | undefined {
    const pos = this.positions.get(symbol);
    if (pos) {
      this.positions.delete(symbol);
      this.lastModifyTime.delete(symbol);
      console.log(`[TRAIL-MGR] Stopped tracking ${symbol} | Trail was ${pos.trailActivated ? 'ACTIVE' : 'inactive'} | Final SL: $${pos.currentStopPrice.toFixed(4)}`);
    }
    return pos;
  }

  /**
   * Detect positions closed externally (SL fired on MEXC, manual close, etc.)
   * Call with the current list of MEXC open position symbols.
   */
  detectExternalCloses(mexcOpenSymbols: Set<string>): string[] {
    const closedSymbols: string[] = [];
    for (const [symbol] of this.positions) {
      if (!mexcOpenSymbols.has(symbol)) {
        closedSymbols.push(symbol);
        console.log(`[TRAIL-MGR] ${symbol} no longer on MEXC — position was closed externally`);
        this.stopTracking(symbol);
        if (this.onPositionClosed) {
          this.onPositionClosed(symbol, 'external_close');
        }
      }
    }
    return closedSymbols;
  }

  /**
   * Get all tracked positions (for display/persistence)
   */
  getTrackedPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Check if a symbol is being tracked
   */
  isTracking(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  /**
   * Get a specific tracked position
   */
  getPosition(symbol: string): TrackedPosition | undefined {
    return this.positions.get(symbol);
  }

  /**
   * Get serializable state for Turso persistence
   */
  getState(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Restore state from Turso persistence.
   * Does NOT verify plan orders — call verifyPlanOrders() after.
   */
  restoreState(positions: TrackedPosition[]): void {
    this.positions.clear();
    for (const pos of positions) {
      this.positions.set(pos.symbol, pos);
      console.log(`[TRAIL-MGR] Restored ${pos.symbol} ${pos.direction} | SL: $${pos.currentStopPrice.toFixed(4)} | Trail: ${pos.trailActivated ? 'ACTIVE' : 'inactive'}`);
    }
    console.log(`[TRAIL-MGR] Restored ${positions.length} tracked positions from persistence`);
  }

  /**
   * Verify that tracked positions still have valid plan orders on MEXC.
   * Also corrects any SL that is wider than initialStopPct.
   * Call after restoreState() on startup.
   */
  async verifyPlanOrders(client: MexcFuturesClient): Promise<void> {
    for (const [symbol, pos] of this.positions) {
      try {
        const planOrders = await client.getPlanOrders(symbol);
        if (!planOrders.success || !planOrders.data || planOrders.data.length === 0) {
          console.warn(`[TRAIL-MGR] No plan orders found for ${symbol} — recreating SL at $${pos.currentStopPrice.toFixed(4)}`);
          await this.renewPlanOrder(client, pos);
        } else {
          // Update plan order ID in case it changed
          const slOrder = planOrders.data.find((o: any) =>
            pos.direction === 'long' ? o.triggerType === 2 : o.triggerType === 1
          );
          if (slOrder) {
            pos.planOrderId = String(slOrder.id);
          }
        }

        // Sanity check: tighten SL if it's wider than initialStopPct
        const correctStop = pos.direction === 'long'
          ? pos.entryPrice * (1 - pos.initialStopPct / 100)
          : pos.entryPrice * (1 + pos.initialStopPct / 100);

        const isTooWide = pos.direction === 'long'
          ? pos.currentStopPrice < correctStop
          : pos.currentStopPrice > correctStop;

        if (isTooWide && !pos.trailActivated) {
          const oldStop = pos.currentStopPrice;
          const didModify = await this.modifyStopOnMexc(client, pos, correctStop);
          if (didModify) {
            console.log(`[TRAIL-MGR] Tightened SL for ${symbol}: $${oldStop.toFixed(4)} → $${correctStop.toFixed(4)} (was wider than ${pos.initialStopPct}%)`);
          }
        }
      } catch (err) {
        console.error(`[TRAIL-MGR] Error verifying plan orders for ${symbol}:`, (err as Error).message);
      }
    }
  }

  /**
   * Get summary stats for logging
   */
  getSummary(): string {
    const count = this.positions.size;
    if (count === 0) return '[TRAIL-MGR] No positions tracked';

    const lines = [`[TRAIL-MGR] Tracking ${count} positions:`];
    for (const [symbol, pos] of this.positions) {
      const priceDiff = pos.direction === 'long'
        ? ((pos.highestPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)
        : ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice * 100).toFixed(2);
      lines.push(`  ${symbol} ${pos.direction} ${pos.leverage}x | SL: $${pos.currentStopPrice.toFixed(4)} | Peak: ${priceDiff}% | Trail: ${pos.trailActivated ? 'ACTIVE' : 'waiting'}`);
    }
    return lines.join('\n');
  }
}
