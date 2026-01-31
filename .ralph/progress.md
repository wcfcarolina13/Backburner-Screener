# Progress Log

> Updated by the agent after significant work.

## Summary

- Iterations completed: 44
- Current status: Race Condition Fix + MEXC History Import

## Current Task: MEXC Live Trading Stability

### Iteration 44 - Fix Race Condition in Position Tracking
**Date**: 2026-01-31
**Status**: ✅ Complete

**Goal**: Fix critical bug where MEXC positions were being marked "closed" within seconds of execution, breaking trailing stop management and Turso persistence.

**Problem Discovered**:
- 197 out of 197 queue entries were marked "closed" within 2-10 seconds of execution
- Root cause: MEXC `getOpenPositions()` API has lag — new positions don't appear immediately
- Lifecycle detector ran every 10 seconds, checking if position existed
- If MEXC API didn't show position yet → marked as "closed" → removed from trailing manager
- Result: Positions ran unmanaged, no trailing stops, no profit-tiered trailing, no Turso persistence

**Evidence**:
- METIS SHORT: executed at 05:39, marked "closed" at 05:40 (10 seconds)
- ETHFI SHORT: executed at 05:57, marked "closed" at 05:58 (9 seconds)
- But actual MEXC position stayed open 10+ hours, hitting 102-107% ROE!

**Fixes Implemented**:

1. **Queue lifecycle grace period** (`src/web-server.ts`):
   ```typescript
   // Don't mark as closed if executed less than 60 seconds ago
   const timeSinceExecution = order.executedAt ? Date.now() - order.executedAt : Infinity;
   if (timeSinceExecution < 60000) {
     continue; // Skip - too soon to determine if position is really closed
   }
   ```

2. **Trailing manager grace period** (`src/mexc-trailing-manager.ts`):
   ```typescript
   const timeSinceStart = pos.startedAt ? now - pos.startedAt : Infinity;
   if (timeSinceStart < 60000) {
     continue; // Skip - too soon to determine if position is really closed
   }
   ```

3. **MEXC history import endpoint** (`src/web-server.ts`):
   - `POST /api/mexc/import-history?hours=48` - Imports position history to Turso
   - Fetches multiple pages, deduplicates by positionId
   - Logs with `bot_id='mexc-live'`, `exit_reason='historical'`

4. **Position history pagination** (`src/web-server.ts`):
   - `GET /api/mexc/position-history?page=1&limit=100` - Now supports pagination
   - Can fetch more than 50 trades for analysis

**Why This Also Fixes Turso Persistence**:
- Persistence code runs when position closes (lines 7747+ and 7890+)
- With positions staying tracked for 60+ seconds, the code path is now reachable
- Real-time `mexc-live` trades will persist with proper exit reasons

**Trade Performance Analysis** (last 50 visible MEXC trades):

| Metric | Value |
|--------|-------|
| Total Trades | 50 |
| Net PnL | **+$9.94** |
| Win Rate | 38% (19W / 31L) |
| Avg Win | $0.92 |
| Avg Loss | -$0.24 |
| Biggest Win | $4.85 (ETHFI, 107% ROE) |
| Biggest Loss | -$0.51 |

**Loss Pattern** (confirming user observation):
- Tiny (<$0.10): 9 trades, -$0.42
- Small ($0.10-$0.30): 7 trades, -$1.07
- Medium ($0.30-$0.50): 14 trades, -$5.46 ← Most losses
- Large (>$0.50): 1 trade, -$0.51

**MEXC Dashboard Sync**:
- MEXC uses UTC+8 timezone for "Today's PNL"
- Today = Jan 30 16:00 UTC to Jan 31 15:59 UTC
- 3 big winners (+$14.24) closed at 16:36 UTC → count as "tomorrow"

**Files Modified**:
- `src/web-server.ts` - Grace period + import endpoint + pagination
- `src/mexc-trailing-manager.ts` - Grace period in detectExternalCloses
- `scripts/import-mexc-history.ts` - New import script (requires Turso credentials)

**Guardrails Added**:
- "MEXC API Has Lag — Add Grace Periods for Position Detection"
- "MEXC Dashboard Uses UTC+8 Timezone"

**Build**: ✅ Passes

---

### Iteration 43 - MEXC Position History Backfill to Turso
**Date**: 2026-01-30
**Status**: ✅ Complete

**Goal**: Backfill closed MEXC positions to Turso on startup so we have historical trade data.

**Background**:
- MEXC standard order history API returns "Not Found" (broken since 2022)
- Found `/private/position/list/history_positions` endpoint works via cookie auth
- Created `/api/mexc/position-history` endpoint to fetch closed positions
- Needed to persist this data to Turso for historical analysis

**Implementation**:

1. **Startup Backfill** (`src/web-server.ts`):
   - Added step 5 to reconciliation IIFE: MEXC position history backfill
   - Fetches last 100 closed positions via `getPositionHistory()`
   - Queries Turso for existing `position_id` values with `bot_id='mexc-live'`
   - Only inserts positions not already in database (deduplication)
   - Maps MEXC position fields to `trade_events` schema

2. **Data Mapping**:
   - `positionId` → `position_id` (for deduplication)
   - `positionType: 1` → `direction: 'long'`, `2` → `'short'`
   - `holdAvgPrice` → `entry_price`
   - `closeAvgPrice` → `exit_price`
   - `realised` → `realized_pnl`
   - Calculates `margin_used`, `notional_size`, `realized_pnl_percent`

3. **Logging**:
   - `[MEXC-BACKFILL] Found N closed positions to check`
   - `[MEXC-BACKFILL] Inserted N new closed positions to Turso`
   - `[MEXC-BACKFILL] All N positions already in Turso` (if no new ones)

**Files Modified**:
- `src/web-server.ts` - Added import for `insertTradeEvent`, `getTurso`; added backfill logic in reconciliation

---

### Iteration 42 - Insurance Disabled + MEXC Persistence Fix
**Date**: 2026-01-30
**Status**: ✅ Complete

**Problem**: Paper bot lost $3,132 on Jan 30 despite having trades with 84% peak ROE. Insurance was halving big winners.

**Root Cause**: Insurance triggers at 2% ROE, closes half position, moves SL to breakeven. Remaining half trails to 79%, but combined exit = (2% + 79%)/2 = 40.5% instead of 79%.

**Fixes**:
1. **Disabled insurance** in `src/experimental-shadow-bots.ts` - default changed to `false`
2. **MEXC persistence fix** - Added persistence in trailing manager's external close detection

---

## Previous Task: Data Collection Gaps & Profit-Tiered Trailing

### Iteration 41 - Profit-Tiered Trailing Strategy
**Date**: 2026-01-29
**Status**: ✅ Complete

**Goal**: Implement profit-tiered trailing stops as a risk reduction measure.

**Background** (from data analysis):
- Trades with 30%+ peaks give back 5-12% before 5% trail fires
- Tighter trails at higher profits should capture more gains
- Backtest scripts showed potential improvement from adaptive trailing

**Implementation**:

1. **MEXC Trailing Manager** (`src/mexc-trailing-manager.ts`):
   - Added `ProfitTier` interface and `profitTiers` config
   - Added `useProfitTieredTrail` boolean (default: true)
   - Added `getCurrentTrailStep(peakRoePct)` helper method
   - Updated `updatePrices()` to use dynamic trail step

2. **Paper Shadow Bots** (`src/experimental-shadow-bots.ts`):
   - Added same profit-tiered trailing logic for consistency
   - Added `DEFAULT_PROFIT_TIERS` static array
   - Updated constructor with profit-tier defaults
   - Updated trailing logic in `updatePrices()`

**Profit Tiers** (both MEXC and paper):
| Peak ROE | Trail Step | Rationale |
|----------|------------|-----------|
| 50%+ | 2% | Very tight - lock in big winners |
| 30-50% | 3% | Tight - capture more of peaks |
| 20-30% | 4% | Moderate - balance risk/reward |
| 0-20% | 5% | Standard - original trail step |

**Logging**:
- When trail step changes due to new profit tier: `[TRAIL-MGR] {symbol} trail tightened: 5% → 3% (peak ROE: 32.5%)`

**Files Modified**:
- `src/mexc-trailing-manager.ts` - Added profit-tiered trailing
- `src/experimental-shadow-bots.ts` - Added profit-tiered trailing for paper bots

**Build**: ✅ Passes

---

### Iteration 40 - Fix Real MEXC Trade Persistence
**Date**: 2026-01-29
**Status**: ✅ Complete

**Goal**: Fix critical data collection gap where real MEXC trades weren't being persisted to Turso.

**Problem Discovered**:
- Paper simulation showed +$658 profit
- Real MEXC account showed -$22 loss over 48 hours
- **~$680 discrepancy** - paper and real were diverging significantly
- Root cause: Real MEXC trade results logged to console but never persisted to database

**Root Causes**:
1. **No Turso persistence for real MEXC trades**: The code at line ~7677 logged `[MEXC-SYNC]` results to console but never called `dataPersistence.logTradeClose()`
2. **In-memory `mexcMirrorTracker`**: Only existed in RAM, lost on server restart
3. **Paper logs masked as "live"**: Paper trades logged with `executionMode: 'live'` but used paper margin sizes

**Fixes Implemented**:

1. **Added real MEXC trade persistence to Turso**:
   - When MEXC position closes, now logs to Turso with `bot_id='mexc-live'`
   - Captures: entry price, exit price, realized PnL (actual from MEXC), duration, leverage
   - Uses `executionMode: 'mexc-live'` to distinguish from paper trades
   - Location: `src/web-server.ts` around line 7700

2. **Added timestamp tracking to QueuedOrder interface**:
   - `executedAt?: number` - When order was executed on MEXC
   - `createdAt?: number` - When order was created in queue
   - These enable accurate duration calculation for real trades

3. **Added guardrails to Ralph**:
   - "Paper Trading PnL ≠ Real Exchange PnL — Always Verify Both"
   - "Verify Data Actually Reaches Database — Trace the Full Flow"

**Query to check real vs paper performance**:
```sql
-- Real MEXC results
SELECT * FROM trade_events WHERE bot_id = 'mexc-live' ORDER BY timestamp DESC;

-- Paper results (for comparison)
SELECT * FROM trade_events WHERE bot_id LIKE 'exp-%' ORDER BY timestamp DESC;
```

**Files Modified**:
- `src/web-server.ts` - Added MEXC trade persistence, QueuedOrder timestamps
- `.ralph/guardrails.md` - Added 2 new guardrails

**Build**: ✅ Passes

---

(Previous iterations truncated for brevity - see git history)
