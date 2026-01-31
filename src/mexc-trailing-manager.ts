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
  initialStopPct: number;      // ROE% for initial SL (converted to price% via leverage)
  planOrderCreatedAt: number;  // Timestamp for 7-day renewal
  botId: string;               // Which bot owns this
  startedAt: number;           // When tracking began
  // Insurance tracking (conditional half-close during stress periods)
  halfClosed?: boolean;        // Whether insurance was triggered
  halfClosedAt?: number;       // When insurance was triggered
  halfClosedPnl?: number;      // Locked profit from half close
}

// Profit-tiered trailing: tighter trail as profits increase
// Based on data analysis showing high-profit trades give back 5-12% before trail fires
export interface ProfitTier {
  minRoePct: number;   // Minimum ROE% to trigger this tier
  trailStepPct: number; // Trail step at this tier
}

export interface TrailingManagerConfig {
  trailTriggerPct: number;     // Default: 10 (10% ROE to activate)
  trailStepPct: number;        // Default: 5 (5% ROE trailing step) - used as fallback
  initialStopPct: number;      // Default: 8 (8% ROE loss, converted to price% via leverage)
  renewalDays: number;         // Default: 6 (renew plan orders after 6 days)
  minModifyIntervalMs: number; // Default: 5000 (don't spam MEXC API)
  useProfitTieredTrail: boolean; // Default: true - enable profit-tiered trailing
  profitTiers: ProfitTier[];   // Profit tiers for dynamic trail step
}

// Profit tiers based on backtest analysis:
// - 30%+ peaks give back 5-12% before current 5% trail fires
// - Tighter trail at higher profits captures more gains
const DEFAULT_PROFIT_TIERS: ProfitTier[] = [
  { minRoePct: 50, trailStepPct: 2 },  // 50%+ ROE: very tight 2% trail
  { minRoePct: 30, trailStepPct: 3 },  // 30-50% ROE: tight 3% trail
  { minRoePct: 20, trailStepPct: 4 },  // 20-30% ROE: moderate 4% trail
  { minRoePct: 0, trailStepPct: 5 },   // 0-20% ROE: standard 5% trail
];

const DEFAULT_CONFIG: TrailingManagerConfig = {
  trailTriggerPct: 10,
  trailStepPct: 5,
  initialStopPct: 8,
  renewalDays: 6,
  minModifyIntervalMs: 5000,
  useProfitTieredTrail: true,
  profitTiers: DEFAULT_PROFIT_TIERS,
};

export class MexcTrailingManager {
  private positions = new Map<string, TrackedPosition>();
  private config: TrailingManagerConfig;
  private lastModifyTime = new Map<string, number>();
  private onPositionClosed?: (symbol: string, reason: string) => void;
  private recentCloses: Array<{
    symbol: string;
    direction: string;
    entryPrice: number;
    exitPrice?: number;
    reason: string;
    closedAt: string;
    realizedPnl?: number;  // Actual $ PnL from MEXC
  }> = [];

  constructor(config?: Partial<TrailingManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the current trail step % based on peak ROE (profit-tiered trailing)
   * Higher profits = tighter trail to capture more gains
   */
  private getCurrentTrailStep(peakRoePct: number): number {
    if (!this.config.useProfitTieredTrail) {
      return this.config.trailStepPct;
    }

    // Find the applicable tier (tiers are sorted highest to lowest minRoePct)
    for (const tier of this.config.profitTiers) {
      if (peakRoePct >= tier.minRoePct) {
        return tier.trailStepPct;
      }
    }

    // Fallback to default trail step
    return this.config.trailStepPct;
  }

  /**
   * Get recent closed positions for debugging/comparison
   */
  getRecentCloses(): typeof this.recentCloses {
    return this.recentCloses.slice(-20);  // Last 20
  }

  /**
   * Record a position close for tracking
   */
  recordClose(symbol: string, direction: string, entryPrice: number, reason: string, exitPrice?: number, realizedPnl?: number): void {
    this.recentCloses.push({
      symbol,
      direction,
      entryPrice,
      exitPrice,
      reason,
      closedAt: new Date().toISOString(),
      realizedPnl,
    });
    // Keep only last 50
    if (this.recentCloses.length > 50) {
      this.recentCloses = this.recentCloses.slice(-50);
    }
  }

  /**
   * Register a callback for when a tracked position is detected as closed
   */
  setOnPositionClosed(cb: (symbol: string, reason: string) => void): void {
    this.onPositionClosed = cb;
  }

  /**
   * Wait for a plan order to appear in MEXC API with retries.
   * MEXC has API lag - orders created don't immediately appear in getPlanOrders().
   */
  private async waitForPlanOrder(
    client: MexcFuturesClient,
    symbol: string,
    direction: 'long' | 'short',
    maxRetries: number = 4
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 2s, 4s, 6s, 8s
        const delayMs = 2000 * attempt;
        console.log(`[TRAIL-MGR] Waiting ${delayMs/1000}s for plan order to appear for ${symbol} (attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delayMs));
      }

      try {
        const planOrders = await client.getPlanOrders(symbol);
        if (planOrders.success && planOrders.data && planOrders.data.length > 0) {
          // Find the SL plan order (for longs: triggerType=2 means <=, for shorts: triggerType=1 means >=)
          const slOrder = planOrders.data.find((o: any) =>
            direction === 'long' ? o.triggerType === 2 : o.triggerType === 1
          );
          if (slOrder) {
            console.log(`[TRAIL-MGR] Found plan order for ${symbol} on attempt ${attempt + 1}`);
            return String(slOrder.id);
          }
          // Take the first plan order as fallback
          console.log(`[TRAIL-MGR] Found fallback plan order for ${symbol} on attempt ${attempt + 1}`);
          return String(planOrders.data[0].id);
        }
      } catch (err) {
        console.error(`[TRAIL-MGR] Error fetching plan orders for ${symbol}:`, (err as Error).message);
      }
    }
    return ''; // Not found after all retries
  }

  /**
   * Start tracking a newly opened MEXC position.
   * Fetches the SL plan order ID from MEXC with retry logic for API lag.
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

    // Wait for plan order with retries (MEXC API has lag)
    let planOrderId = await this.waitForPlanOrder(client, symbol, params.direction);

    // If still no plan order found after retries, try to create one
    if (!planOrderId) {
      console.warn(`[TRAIL-MGR] No plan order found for ${symbol} after retries — creating SL manually`);
      try {
        const slResult = await client.setStopLoss(symbol, params.stopLossPrice);
        if (slResult.success && slResult.data?.id) {
          planOrderId = String(slResult.data.id);
          console.log(`[TRAIL-MGR] Created manual SL for ${symbol}: ${planOrderId}`);
        } else {
          console.error(`[TRAIL-MGR] Failed to create manual SL for ${symbol}: ${slResult.error}`);
        }
      } catch (err) {
        console.error(`[TRAIL-MGR] Error creating manual SL for ${symbol}:`, (err as Error).message);
      }
    }

    if (!planOrderId) {
      console.error(`[TRAIL-MGR] ⚠️ CRITICAL: ${symbol} position is UNPROTECTED — no SL could be created!`);
      // Still track it, but this is a serious issue that should be investigated
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

        // Get dynamic trail step based on peak ROE
        const activationTrailStep = this.getCurrentTrailStep(pos.highestRoePct);
        pos.trailStepPct = activationTrailStep; // Set initial trail step for position

        console.log(`[TRAIL-MGR] Trail ACTIVATED for ${symbol} | Peak ROE: ${pos.highestRoePct.toFixed(1)}% | Trigger: ${pos.trailTriggerPct}% | Trail: ${activationTrailStep}%`);

        // Move SL to breakeven + buffer using dynamic trail step
        const beBuffer = pos.entryPrice * ((pos.trailTriggerPct - activationTrailStep) / 100 / pos.leverage);
        const newStop = pos.direction === 'long'
          ? pos.entryPrice + beBuffer
          : pos.entryPrice - beBuffer;

        const didModify = await this.modifyStopOnMexc(client, pos, newStop);
        if (didModify) modified.push(symbol);
      }

      // Ratchet trailing stop with profit-tiered trail step
      if (pos.trailActivated) {
        // Get dynamic trail step based on peak ROE (tighter at higher profits)
        const currentTrailStep = this.getCurrentTrailStep(pos.highestRoePct);
        const trailPnl = pos.highestRoePct - currentTrailStep;

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
            // Log tier change for monitoring
            if (currentTrailStep !== pos.trailStepPct) {
              console.log(`[TRAIL-MGR] ${pos.symbol} trail tightened: ${pos.trailStepPct}% → ${currentTrailStep}% (peak ROE: ${pos.highestRoePct.toFixed(1)}%)`);
              pos.trailStepPct = currentTrailStep; // Update position's trail step
            }
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

    // AUTO-RECOVER: If planOrderId is missing, try to fetch it from MEXC
    if (!pos.planOrderId) {
      console.warn(`[TRAIL-MGR] ${pos.symbol} missing planOrderId — attempting to recover from MEXC`);
      try {
        const planOrders = await client.getPlanOrders(pos.symbol);
        if (planOrders.success && planOrders.data && planOrders.data.length > 0) {
          // Find SL order (stopLossPrice exists or triggerType indicates SL)
          const slOrder = planOrders.data.find((o: any) =>
            o.stopLossPrice > 0 || o.triggerType === 2 // triggerType 2 = stop loss
          );
          if (slOrder) {
            pos.planOrderId = slOrder.id || slOrder.orderId;
            pos.planOrderCreatedAt = slOrder.createTime || Date.now();
            console.log(`[TRAIL-MGR] RECOVERED planOrderId for ${pos.symbol}: ${pos.planOrderId}`);
          } else {
            // No SL order exists - create one
            console.warn(`[TRAIL-MGR] ${pos.symbol} has no SL order on MEXC — creating one at $${newStopPrice.toFixed(4)}`);
            const slResult = await client.setStopLoss(pos.symbol, newStopPrice);
            if (slResult.success) {
              // Fetch the newly created order ID
              const newPlanOrders = await client.getPlanOrders(pos.symbol);
              if (newPlanOrders.success && newPlanOrders.data) {
                const newSlOrder = newPlanOrders.data.find((o: any) => o.stopLossPrice > 0 || o.triggerType === 2);
                if (newSlOrder) {
                  pos.planOrderId = newSlOrder.id || newSlOrder.orderId;
                  pos.planOrderCreatedAt = Date.now();
                  pos.currentStopPrice = newStopPrice;
                  console.log(`[TRAIL-MGR] Created new SL for ${pos.symbol}: $${newStopPrice.toFixed(4)} (planOrderId: ${pos.planOrderId})`);
                  return true;
                }
              }
            }
            console.error(`[TRAIL-MGR] Failed to create SL for ${pos.symbol}: ${slResult.error}`);
            return false;
          }
        } else {
          // No plan orders at all - create SL
          console.warn(`[TRAIL-MGR] ${pos.symbol} has no plan orders — creating SL at $${newStopPrice.toFixed(4)}`);
          const slResult = await client.setStopLoss(pos.symbol, newStopPrice);
          if (slResult.success) {
            const newPlanOrders = await client.getPlanOrders(pos.symbol);
            if (newPlanOrders.success && newPlanOrders.data) {
              const newSlOrder = newPlanOrders.data.find((o: any) => o.stopLossPrice > 0 || o.triggerType === 2);
              if (newSlOrder) {
                pos.planOrderId = newSlOrder.id || newSlOrder.orderId;
                pos.planOrderCreatedAt = Date.now();
                pos.currentStopPrice = newStopPrice;
                console.log(`[TRAIL-MGR] Created new SL for ${pos.symbol}: $${newStopPrice.toFixed(4)} (planOrderId: ${pos.planOrderId})`);
                return true;
              }
            }
          }
          console.error(`[TRAIL-MGR] Failed to create SL for ${pos.symbol}: ${slResult.error}`);
          return false;
        }
      } catch (err) {
        console.error(`[TRAIL-MGR] Error recovering planOrderId for ${pos.symbol}:`, (err as Error).message);
        return false;
      }
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
    const oldPlanOrderId = pos.planOrderId;
    console.log(`[TRAIL-MGR] Renewing plan order for ${pos.symbol} (age: ${((Date.now() - pos.planOrderCreatedAt) / 86400000).toFixed(1)} days, old ID: ${oldPlanOrderId})`);

    try {
      // RACE CONDITION FIX: Create new order FIRST, then cancel old one
      // This ensures we're never unprotected during the renewal window

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
        const newOrderId = String(result.data.id || result.data);
        pos.planOrderId = newOrderId;
        pos.planOrderCreatedAt = Date.now();
        console.log(`[TRAIL-MGR] Created new plan order for ${pos.symbol}: ${newOrderId}`);

        // Now safely cancel old order (we have the new one in place)
        if (oldPlanOrderId) {
          try {
            await client.cancelPlanOrder(oldPlanOrderId);
            console.log(`[TRAIL-MGR] Cancelled old plan order ${oldPlanOrderId} for ${pos.symbol}`);
          } catch (cancelErr) {
            // Old order might have expired or been triggered — not critical since new one is in place
            console.warn(`[TRAIL-MGR] Could not cancel old order ${oldPlanOrderId}: ${(cancelErr as Error).message}`);
          }
        }
      } else {
        // New order failed — keep old order, don't cancel it
        console.error(`[TRAIL-MGR] Failed to renew plan order for ${pos.symbol}: ${result.error} — keeping old order ${oldPlanOrderId}`);
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
   * Detect positions that MIGHT be closed externally (not in MEXC API response).
   * Returns symbols to check - caller MUST verify via order history before stopping tracking.
   * Does NOT stop tracking - caller must call confirmExternalClose() after verification.
   */
  detectPotentialCloses(mexcOpenSymbols: Set<string>): string[] {
    const potentiallyClosedSymbols: string[] = [];
    const now = Date.now();
    for (const [symbol, pos] of this.positions) {
      // GRACE PERIOD: Don't check if tracking started less than 90 seconds ago
      const timeSinceStart = pos.startedAt ? now - pos.startedAt : Infinity;
      if (timeSinceStart < 90000) {
        continue; // Skip - too soon to determine if position is really closed
      }

      if (!mexcOpenSymbols.has(symbol)) {
        // Position not in MEXC API response - but DON'T stop tracking yet
        // Caller must verify via order history before confirming close
        potentiallyClosedSymbols.push(symbol);
        console.log(`[TRAIL-MGR] ${symbol} not in getOpenPositions() — needs verification (tracked for ${Math.round(timeSinceStart / 1000)}s)`);
      }
    }
    return potentiallyClosedSymbols;
  }

  /**
   * Confirm a position was actually closed after verification.
   * Call this ONLY after verifying via order history that a close order exists.
   */
  confirmExternalClose(symbol: string, exitPrice?: number, realizedPnl?: number): void {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    console.log(`[TRAIL-MGR] ${symbol} VERIFIED closed externally — stopping tracking`);
    this.recordClose(symbol, pos.direction, pos.entryPrice, 'external_close', exitPrice, realizedPnl);
    this.stopTracking(symbol);
    if (this.onPositionClosed) {
      this.onPositionClosed(symbol, 'external_close');
    }
  }

  /**
   * @deprecated Use detectPotentialCloses + confirmExternalClose instead
   * Legacy method that immediately stops tracking - kept for backward compatibility
   */
  detectExternalCloses(mexcOpenSymbols: Set<string>): string[] {
    // WARNING: This method has a bug - it doesn't verify positions are actually closed
    // Use detectPotentialCloses + confirmExternalClose for safe closure detection
    return this.detectPotentialCloses(mexcOpenSymbols);
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
   * Get all tracked positions (for debugging/comparison)
   */
  getAllPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
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

        // Sanity check: tighten SL if it's wider than initialStopPct (ROE-based)
        const slPriceDistance = pos.initialStopPct / 100 / pos.leverage;
        const correctStop = pos.direction === 'long'
          ? pos.entryPrice * (1 - slPriceDistance)
          : pos.entryPrice * (1 + slPriceDistance);

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
