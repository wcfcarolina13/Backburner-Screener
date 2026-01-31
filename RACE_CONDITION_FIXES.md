# Race Condition & Rate Limit Fixes

## Priority Assessment

Based on the audit, here are the issues ranked by potential money impact:

---

## 🔴 CRITICAL (Fix Immediately)

### 1. Plan Order Detection Race - Positions Run Unprotected

**File:** `src/mexc-trailing-manager.ts` lines 169-192
**Impact:** HIGH - Positions can trade without stop loss protection

**Current Behavior:**
```typescript
// After order execution, immediately fetches plan orders
const planOrders = await client.getPlanOrders(symbol);
// If not found, just warns but still tracks with planOrderId = ''
if (!planOrderId) {
  console.warn(`... position is unprotected!`);
}
```

**Problem:** MEXC API doesn't immediately reflect newly created plan orders. When SL is created during order execution, `getPlanOrders()` called milliseconds later returns empty.

**Fix:**
1. Add retry loop with exponential backoff
2. If after retries still no plan order found, create one manually
3. Don't start tracking until we have a valid plan order ID

```typescript
// In startTracking(), after initial getPlanOrders() fails:
async function waitForPlanOrder(client, symbol, direction, maxRetries = 5): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 2000 * (i + 1))); // 2s, 4s, 6s, 8s, 10s
    const planOrders = await client.getPlanOrders(symbol);
    // ... check for SL order
    if (slOrderId) return slOrderId;
  }
  return ''; // Still not found after 30s total
}
```

---

### 2. Unprotected Window During Order Execution

**File:** `src/web-server.ts` lines 3386-3440
**Impact:** HIGH - Server crash = orphaned position on exchange

**Current Behavior:**
```typescript
const result = await client.openLong(...);  // Line ~3386
// Position now exists on MEXC
// ... some processing ...
await trailingManager.startTracking(...);  // Line ~3422
// If crash between these, position is orphaned
```

**Fix:**
1. Save order state to persistent storage BEFORE startTracking
2. On startup, check for orphaned orders and reconcile
3. Add try/catch with cleanup on failure

```typescript
// After successful order execution:
await saveOrderToTurso({ orderId: result.orderId, symbol, side, status: 'executed', startedTracking: false });
try {
  await trailingManager.startTracking(...);
  await updateOrderInTurso(result.orderId, { startedTracking: true });
} catch (e) {
  // Order exists but tracking failed - will reconcile on next startup
  console.error(`Tracking failed for ${symbol} - will reconcile on restart`);
}
```

---

## 🟡 MEDIUM (Fix This Week)

### 3. 60-Second Grace Period May Be Insufficient

**File:** `src/mexc-trailing-manager.ts` line 419
**Impact:** MEDIUM - Premature position closure detection

**Current:** 60 second grace period before marking position as closed.

**Issue:** During high MEXC load, API lag can exceed 60 seconds.

**Fix:** Extend to 90-120 seconds, add position history check:
```typescript
// If position not in getOpenPositions() AND grace period elapsed:
// Check position history to confirm it actually closed vs just API lag
const history = await client.getPositionHistory(symbol);
const recentClose = history.data?.find(p => p.symbol === symbol && p.updateTime > pos.startedAt);
if (recentClose) {
  // Actually closed
} else {
  // API lag - keep tracking
}
```

---

### 4. Plan Order Renewal Atomic Gap

**File:** `src/mexc-trailing-manager.ts` lines 357-393
**Impact:** MEDIUM - Brief unprotected window during SL renewal

**Current Behavior:**
```typescript
await client.cancelAllPlanOrders(symbol);  // Old SL gone
// ... gap where no SL exists ...
await client.createPlanOrder(...);  // New SL created
```

**Fix:** Create new order BEFORE canceling old one:
```typescript
// Create new SL first
const newOrder = await client.createPlanOrder(...);
if (newOrder.success) {
  // Only now cancel old order
  await client.cancelPlanOrder(oldPlanOrderId);
  pos.planOrderId = newOrder.data.id;
}
```

---

### 5. Polling Loop Overlap

**File:** `src/web-server.ts` line 8113
**Impact:** MEDIUM - API rate limits during high load

**Current:** 10-second interval can overlap if previous iteration runs long.

**Fix:** Add lock or use dynamic interval:
```typescript
let updateInProgress = false;
setInterval(async () => {
  if (updateInProgress) {
    console.warn('[POLL] Previous update still running, skipping');
    return;
  }
  updateInProgress = true;
  try {
    await updateAllPrices();
  } finally {
    updateInProgress = false;
  }
}, 10000);
```

---

### 6. Global API Rate Limiter Missing

**Files:** Multiple - all MEXC API calls
**Impact:** MEDIUM - 429 errors, missed updates

**Current:** No global coordination of API requests across:
- Trailing manager price updates
- Screener kline fetches
- Balance queries
- Position reconciliation

**Fix:** Implement global request queue:
```typescript
// src/mexc-rate-limiter.ts
class MexcRateLimiter {
  private queue: (() => Promise<any>)[] = [];
  private processing = false;
  private requestsThisSecond = 0;
  private MAX_REQUESTS_PER_SECOND = 8;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()); }
        catch (e) { reject(e); }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      if (this.requestsThisSecond >= this.MAX_REQUESTS_PER_SECOND) {
        await new Promise(r => setTimeout(r, 200)); // Wait a bit
        continue;
      }
      const fn = this.queue.shift();
      this.requestsThisSecond++;
      setTimeout(() => this.requestsThisSecond--, 1000);
      await fn?.();
    }
    this.processing = false;
  }
}
```

---

## 🟢 LOW (Fix When Time Permits)

### 7. Startup Verification Grace Period

**File:** `src/mexc-trailing-manager.ts` line 490
**Impact:** LOW - Unnecessary API calls on startup

**Fix:** Wait 5s after startup before verifying plan orders.

---

### 8. Screener Batch Size During Live Trading

**File:** `src/screener.ts` line 406
**Impact:** LOW - Occasional rate limits during heavy scanning

**Fix:** Reduce `BATCH_SIZE` from 8 to 5 when live trading is enabled.

---

### 9. Price Cache for Position Updates

**File:** `src/web-server.ts` lines 7464-7540
**Impact:** LOW - Minor state inconsistency across bots

**Fix:** Pre-fetch all prices once per 10s tick, share across all bots.

---

## Implementation Status

### ✅ COMPLETED (2026-01-31)

| # | Issue | Fix Applied |
|---|-------|-------------|
| 1 | Plan Order Detection Race | Added `waitForPlanOrder()` with exponential backoff (2s, 4s, 6s, 8s) + manual SL creation fallback |
| 2 | Orphaned Order Recovery | **Already implemented** in startup reconciliation (lines 7276-7314): detects untracked MEXC positions, creates SL, starts tracking |
| 3 | Grace Period Insufficient | Extended from 60s → 90s in both trailing manager and queue lifecycle |
| 4 | Plan Order Renewal Gap | Now creates new order BEFORE canceling old one (atomic renewal) |
| 5 | Polling Loop Overlap | Added `priceUpdateInProgress` lock to prevent concurrent 10s ticks |

### 🔲 TODO (Future Sessions)

| # | Issue | Priority |
|---|-------|----------|
| 6 | Global API Rate Limiter | MEDIUM - Coordinate all MEXC calls |
| 7 | Startup Verification Delay | LOW |
| 8 | Screener Batch Size | LOW |
| 9 | Price Cache Sharing | LOW |

---

## Metrics to Track Post-Fix

- Count of "position is unprotected!" warnings (should drop to 0)
- Count of 429 rate limit errors
- Count of orphaned positions found on startup
- Count of plan order renewal gaps > 1 second
