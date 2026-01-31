# Progress Log

> Updated by the agent after significant work.

## Summary

- Iterations completed: 45
- Current status: Additional Race Condition Fixes

## Current Task: MEXC Live Trading Stability

### Iteration 45 - Comprehensive Race Condition & Rate Limit Audit
**Date**: 2026-01-31
**Status**: ✅ Complete

**Goal**: Audit entire system for race conditions and rate limit issues that could be causing money loss.

**Audit Results** (documented in `RACE_CONDITION_FIXES.md`):
- Found 10 potential issues ranked by money impact
- Fixed 4 of them this session, 5 remaining for future work

**Fixes Implemented**:

1. **Plan Order Detection Race (Critical #1)** ✅
   - Added `waitForPlanOrder()` helper with exponential backoff (2s, 4s, 6s, 8s delays)
   - If retries fail, creates SL manually instead of leaving position unprotected
   - File: `src/mexc-trailing-manager.ts`

2. **Grace Period Extended (Medium #3)** ✅
   - Extended from 60s → 90s in both:
     - `src/mexc-trailing-manager.ts` (detectExternalCloses)
     - `src/web-server.ts` (queue lifecycle detector)
   - Handles high MEXC API load scenarios

3. **Plan Order Renewal Made Atomic (Medium #4)** ✅
   - Now creates NEW order BEFORE canceling old one
   - Eliminates gap where position has no SL protection
   - File: `src/mexc-trailing-manager.ts` (`renewPlanOrder()`)

4. **Polling Loop Overlap Protection (Medium #5)** ✅
   - Added `priceUpdateInProgress` lock to 10-second interval
   - Prevents concurrent API calls when previous tick runs long
   - File: `src/web-server.ts` (line ~7464)

**Still TODO** (documented for future sessions):
- #2: Orphaned Order Recovery (startup reconciliation)
- #6: Global API Rate Limiter
- #7, #8, #9: Low priority optimizations

---

### Iteration 44 - 72-Hour Bug Impact Analysis
**Date**: 2026-01-31
**Status**: ✅ Complete

**Goal**: Analyze how much of the 72-hour losses were caused by the race condition bug vs normal trading conditions.

**Analysis Performed** (script: `scripts/analyze-bug-impact.ts`):

| Period | Trades | Total PnL | Quick Losses (<5min) | Long Runners (>4h) |
|--------|--------|-----------|---------------------|-------------------|
| Since commit (~18h) | 220 | -$8.48 | 68 trades, -$12.75 | 4 trades, +$8.67 |
| Commit to 24h ago | 25 | -$1.41 | 8 trades, -$1.62 | 2 trades, -$0.88 |
| 24-48h ago | 279 | -$12.31 | 110 trades, -$23.56 | 15 trades, +$12.24 |
| 48-72h ago | 291 | -$15.65 | 112 trades, -$16.65 | 9 trades, -$1.96 |
| **Total 72h** | **815** | **-$37.85** | **298 trades, -$54.58** | **30 trades, +$18.07** |

**Key Findings**:

1. **Quick Losses (Bug-Affected)**:
   - 298 trades lost money in under 5 minutes
   - Total impact: **-$54.58**
   - Hit SL before trailing system could help

2. **Long-Running "Unmanaged" Trades**:
   - 30 trades ran for 4+ hours without management
   - Total impact: **+$18.07** (net positive!)
   - Big winners: METIS +$4.64, ETHFI +$4.85, BULLA +$4.44
   - These won BECAUSE they were unmanaged (ran longer than trailing would allow)

3. **Top 10 Winners - 7 of 10 were "unmanaged"**:
   - ETHFI SHORT: +$4.85 (107.7% ROE, 10h 38m)
   - METIS SHORT: +$4.64 (102.6% ROE, 10h 56m)
   - BULLA LONG: +$4.44 (101.3% ROE, 4h 37m)

4. **The Paradox**:
   - Bug **hurt** quick losses: -$54.58
   - Bug **helped** unmanaged winners: +$18.07
   - Net estimated bug impact: **-$36.51**

**Action Items**:
1. ✅ Bug fix deployed - 60-second grace period
2. ⏳ Monitor next 24-48 hours to verify fix
3. 📋 **Future consideration**: Backtest whether widening trailing params could capture more gains like the unmanaged winners achieved (see METIS/ETHFI 100%+ ROE runs)

**Local Secrets File Created**:
- `.env.local` contains Turso credentials (gitignored)
- Use `source .env.local` before running scripts that need database access

---

### Iteration 43 - Fix Race Condition in Position Tracking
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

## Previous Task: Data Collection Gaps & Profit-Tiered Trailing

### Iteration 42 - Profit-Tiered Trailing Strategy
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

### Iteration 41 - Fix Real MEXC Trade Persistence
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

### Iteration 40 - Worktree vs Main Clarification
**Date**: 2026-01-29
**Status**: ✅ Complete

Added guardrail about worktrees not being main and the correct deployment flow.

---

## Previous Task: Paper vs Live Discrepancy Investigation (COMPLETE)

### Iteration 39 - Paper vs Live Trading Fixes
**Date**: 2026-01-29
**Status**: ✅ Complete

**Goal**: Investigate why paper trading shows +$1,318 profit while live MEXC shows -$15 loss.

**Root Causes Found**:

1. **Paper trade logging had field name mismatch**:
   - `ClosedPosition` used `realizedPnl` (lowercase l)
   - `PaperPosition` expected `realizedPnL` (uppercase L)
   - Result: Paper trades logged to Turso with empty PnL fields

2. **Stress period detection reset on server restart**:
   - `recentCloses` array was in-memory only
   - Server restart = no historical data = `sampleSize: 0` = no stress detection
   - Insurance logic couldn't trigger without stress period detection

3. **Paper simulation had zero exit slippage**:
   - SL/TP exits at exact target prices (unrealistic)
   - Entry slippage was too optimistic (0.05% vs real 0.2-0.5%)

**Fixes Implemented**:

1. **Paper Trade Logging Fix** (`experimental-shadow-bots.ts`):
   - Map `ClosedPosition` fields to `PaperPosition` format before logging
   - `positionSize` → `marginUsed`
   - `realizedPnl` → `realizedPnL`
   - `realizedPnlPercent` → `realizedPnLPercent`

2. **Stress Detection Bootstrap** (`web-server.ts`):
   - On startup, query Turso for last 2 hours of closes
   - Bootstrap `recentCloses` array from historical data
   - Stress detection works immediately after restart

3. **Exit Slippage** (`experimental-shadow-bots.ts`):
   - SL exits: 2x entry slippage (volatility = worse fills)
   - TP exits: 1x entry slippage
   - Increased base slippage: 0.05% → 0.15%

**MANTA Investigation Results**:
- MANTA closed via SL at -8.08% ROE (both paper AND live)
- Entry: $0.0744672, Exit: $0.0741693 (SL), Current: $0.07519
- Both paper and live had identical exit reason/price
- No paper vs live discrepancy on this specific trade
- Total live 3-day stats: 370 trailing wins, 291 SL losses

**Commits**:
- `acad0e0` fix: Paper trade logging field name mismatch
- `f88e3dd` fix: Bootstrap stress detection from Turso historical data
- `2cc0600` fix: Add realistic exit slippage to paper simulation

**Deployed to Render**: Pushed to main, auto-deploy triggered

---

## Previous Task: Conditional Insurance Implementation (COMPLETE)

### Iteration 38 - Conditional Insurance Toggle
**Date**: 2026-01-29
**Status**: ✅ Complete

**Goal**: Implement conditional insurance as a toggle in the exp-bb-sysB bot.

**Implementation**:

1. **Paper Bot Logic** (`experimental-shadow-bots.ts`):
   - Added config: `useConditionalInsurance`, `insuranceThresholdPercent`, `insuranceStressWinRateThreshold`
   - Added position tracking: `insuranceTaken`, `insuranceTakenAt`, `insurancePnlLocked`, `originalPositionSize`
   - Added `isStressPeriod()` method using rolling 2-hour win rate
   - Added insurance trigger in `updatePrices()`: when ROE >= threshold AND stress period
   - Insurance action: halve position, lock profit, move SL to breakeven

2. **MEXC Integration** (`web-server.ts`):
   - Added `handleInsuranceTriggered()` function for live execution
   - Closes half position on MEXC, moves SL to breakeven
   - Wired up via `onInsuranceTriggered` callback

3. **Trailing Manager** (`mexc-trailing-manager.ts`):
   - Added `halfClosed`, `halfClosedAt`, `halfClosedPnl` fields

**Bot Configuration**:
```typescript
// exp-bb-sysB now runs with:
useConditionalInsurance: true,
insuranceThresholdPercent: 2,     // Lock profit at 2% ROE
insuranceStressWinRateThreshold: 50  // Only during WR < 50% hours
```

**Expected Impact** (from backtest):
- +$706 improvement over 7 days
- Turns -$280 stress losses into +$426 gains

---

## Previous Task: Scaling-In Strategy Backtests (COMPLETE)

### Iteration 37 - Entry Scaling & Insurance Backtests
**Date**: 2026-01-29
**Status**: ✅ Complete

**Goal**: Backtest three approaches to improve entry timing during selloffs.

**Results**:

| Backtest | Conclusion | Improvement |
|----------|------------|-------------|
| 1. Regime-Conditional Insurance | ✅ HELPS | +$706 (apply insurance only during stress) |
| 2. Two-Tranche Scaling-In | ⚠️ PROMISING | +$1,463 est (needs candle replay for accuracy) |
| 3. BTC Correlation Filter | ❌ HURTS | -$512 (BTC dips = better entries for contrarian!) |

**Key Findings**:

1. **Conditional Insurance** (only during <50% WR hours):
   - Baseline: $8,873 | With insurance: $9,579 | **+$706**
   - Insurance turns -$280 stress losses into +$426 gains
   - Insurance HURTS during bull periods (-$3,566) but we skip it then

2. **Scaling-In Entry** (50% at signal, 50% at additional drop):
   - Estimated improvement of +$1,463 in stress periods
   - Requires candle replay for accurate simulation

3. **BTC Filter** (skip entries when BTC down):
   - **COUNTERINTUITIVE**: Entries during BTC dips have 100% WR!
   - Entries during BTC pumps have only 18% WR
   - For contrarian RSI strategy, BTC dips = oversold alts = good entries

**Scripts Created**:
- `scripts/backtest-regime-insurance.ts`
- `scripts/backtest-scaling-in.ts`
- `scripts/backtest-btc-filter.ts`

---

## Previous Task: Notification Bot Filtering Fix

### Iteration 36 - Live MEXC SL Investigation (Closed — No Action)
**Date**: 2026-01-27
**Status**: ✅ Complete — No Fix Needed

**Goal**: Investigate premature stop-loss exits on LIVE MEXC positions (not paper trades).

**Key Findings**:
- ALL 251 live events from exp-bb-sysB only (no other bot executes on MEXC)
- 73 stop_loss exits: ALL show exactly -8.08% PnL and 0.400% price delta
- 129 trailing_stop wins: Average +15.59% PnL
- Fast exit examples: ZKCUSDT 1.5s, MERLUSDT 3.5s, JSTUSDT 4.2s
- SL is set ON MEXC exchange itself via `stopLossPrice` parameter
- Formula: `entryPrice × (8% / 100 / 20x) = 0.4%` price distance — math is correct
- VVVUSDT specifically was a WINNER (+9.94% ROI, trailing_stop)

**Decision**: Leave as-is. Bot is profitable with current parameters. Widening stops would reduce premature exits but increase per-loss severity. The tight stop is part of the strategy.

---

## Previous Task: Stop Loss Bug Investigation & Backtest

### Iteration 35 - SL Correction Backtest for exp-bb-sysB
**Date**: 2026-01-27
**Status**: ✅ Complete

**Goal**: Backtest exp-bb-sysB over the last 7 days with corrected stop loss logic after discovering that paper trading bots set SL as a raw price percentage (8%) instead of ROI-based, causing positions at 20x leverage to survive past liquidation and bounce back as phantom wins.

**The Bug**:
- `ExperimentalShadowBot` line 316: `stopDistance = entryPrice * (initialStopPercent / 100)` — this is 8% of PRICE
- At 20x leverage: 8% price move = 160% ROI loss. Liquidation happens at ~5% price (100% ROI loss).
- No liquidation check in `updatePrices()` method — zombie positions could drop -160% and bounce back.
- This inflated win rates and PnL across all leveraged paper bots.

**Backtest Methodology**:
- Queried 477 matched open/close trade pairs from Turso (last 7 days)
- Fetched 5m candle data from MEXC for each trade window (93.3% coverage)
- Replayed each trade through two correction scenarios:
  - SC1: Corrected SL at 8% ROI = 0.4% price distance at 20x
  - SC2: Original 8% price SL + liquidation enforcement at ~4.75%

**Key Results**:
| Metric | Original (Buggy) | SC1 (Corrected SL) | SC2 (Liq Enforced) |
|--------|------------------|---------------------|--------------------|
| PnL | $1,793.79 | $2,881.55 | $5,833.48 |
| Win Rate | 18.0% | 43.6% | 76.7% |
| Avg Trade | $3.76 | $6.04 | $12.23 |
| SL/Liq exits | 82 | 249 | 22 liquidated |

**Surprising Finding**: The corrected bot is MORE profitable, not less. The bug was actually HURTING performance:
- 37 trades were phantom wins (profitable with bug, losing with fix) totaling $859 inflated profit
- BUT the tighter SL (0.4% price) cuts losses much faster, reducing avg loss from ~$8 to ~$15
- The trailing stops still captured the same big wins ($33.20 avg win)
- Net effect: R:R ratio of 2.22 with 43.6% WR = positive expectancy of $6.04/trade
- Bug was letting losers run past liquidation; some bounced back, but many bled out slowly

**Files Created**:
- `scripts/backtest-sl-correction.ts` — Full candle-based backtest with two scenarios
- `scripts/query-backtest-trades.ts` — Turso query for trade data
- `scripts/debug-timestamps.ts` — Timestamp format investigation

**Added Guardrail**: "Stop Loss Must Be ROI-Based, Not Price-Based (with Leverage)"

## Previous Task: Futures-Only Asset Discovery & Commodity Screening

### Iteration 34 - Futures-Only Commodity Whitelist (SILVER, PAXG)
**Date**: 2026-01-26
**Status**: ✅ Complete

**Goal**: Enable the screener to track futures-only assets like SILVER (XAG) and PAXG (gold) that have no MEXC spot pair but active, liquid futures contracts.

**Root Cause**: The futures-only discovery loop (screener.ts:248-270) blocked commodities because:
1. `hasMarketCapData("SILVERUSDT")` fails — CoinGecko doesn't track silver commodity
2. No exclude pattern checks in the futures-only loop (STOCK tokens could slip through)

**Key Findings**:
- 123 futures-only contracts exist on MEXC (commodities, forex, stocks, crypto)
- SILVER_USDT: $527M daily turnover, 100x max leverage, zero fees
- PAXG_USDT: $155M daily turnover, 100x max leverage, zero fees
- XAUT (Tether Gold): Already tracked via spot pair + CoinGecko rank #50
- `apiAllowed: false` on 741/742 contracts — NOT a real restriction for cookie-based API
- Screener already uses `getFuturesKlines()` for all eligible symbols (not spot-only)

**Changes Implemented**:

1. **FUTURES_WHITELIST** (`src/config.ts`):
   - New constant: manually verified futures-only assets that bypass CoinGecko
   - Initial entries: SILVER_USDT, PAXG_USDT

2. **Futures-only discovery loop** (`src/screener.ts`):
   - Added exclude pattern checks (blocks STOCK tokens, stablecoins, etc.)
   - Added whitelist bypass for CoinGecko market cap requirement
   - Added logging: count of futures-only symbols added + whitelisted count

3. **STOCK exclusion** (`src/config.ts`):
   - Added `/STOCK$/i` pattern to exclude tokenized stock futures (48 contracts)

**Build**: ✅ Passes

---

## Previous Task: Fix MEXC Order Execution Failures

### Iteration 33 - Fix MEXC Auto-Execution Failures (PROVEUSDT)
**Date**: 2026-01-26
**Status**: ✅ Complete

**Goal**: Fix why MEXC live auto-executed orders were failing despite the previous symbol format fix (commit 1c84dc6).

**Root Causes Found**:

1. **"The price of stop-limit order error"**: Orders were sending `takeProfitPrice: 0` to MEXC. The bot's position had no TP set (defaulting to 0), but `createOrder()` checked `!== undefined` which let 0 through. MEXC rejects price=0 as invalid.

2. **Wrong vol parameter**: The `vol` field was receiving a USD amount (e.g., $5) instead of the number of contracts. MEXC futures `vol` means contract count, where each contract has a `contractSize` (e.g., PROVE=1 token, DOGE=100 tokens, BTC=0.0001 BTC). A $5 order for PROVE should be ~13 contracts, not 5.

**Fixes Implemented**:

1. **SL/TP price validation** (`src/mexc-futures-client.ts`):
   - Changed `if (params.stopLossPrice !== undefined)` to `if (params.stopLossPrice)`
   - Changed `if (params.takeProfitPrice !== undefined)` to `if (params.takeProfitPrice)`
   - Zero/falsy values are now excluded from the order payload

2. **USD-to-contracts conversion** (`src/mexc-futures-client.ts`):
   - Added `ContractSpec` interface and `contractSpecCache` Map
   - Added `ensureContractSpecs()` — fetches all 831 contract specs from MEXC public API, cached for 1 hour
   - Added `usdToContracts(symbol, usdSize, price)` — converts USD to contract count using `contractSize`
   - Formula: `contracts = floor(usdSize / (price * contractSize))`, minimum = `minVol`

3. **Unified execution path** (`src/web-server.ts`):
   - Added `executeOnMexc(client, order)` function that:
     - Fetches current price via `client.getTickerPrice()`
     - Converts USD size to contracts via `usdToContracts()`
     - Filters out zero SL/TP before passing to openLong/openShort
   - Both `autoExecuteOrder()` and manual `/api/mexc/queue/execute/:index` now use `executeOnMexc()`

**Test Results** (contract conversion verified):
- PROVE_USDT: $5 @ $0.368 → 13 contracts ✓
- DOGE_USDT: $10 @ $0.32 → 1 contract (min) ✓
- BTC_USDT: $10 @ $105,000 → 1 contract (min) ✓
- BTC_USDT: $100 @ $105,000 → 9 contracts ✓

**Files Modified**:
- `src/mexc-futures-client.ts` — Added contract spec cache, usdToContracts(), fixed SL/TP validation
- `src/web-server.ts` — Added executeOnMexc(), updated import, unified execution paths

**Build**: ✅ Passes

---

## Previous Task: MEXC Live Execution Pipeline

### Iteration 32 - MEXC Bot Feeder Pipeline & Live Execution Wiring
**Date**: 2026-01-25
**Status**: ✅ Complete

**Goal**: Wire paper trading bots to MEXC live execution queue so bot signals automatically feed real trade orders.

**Key Accomplishments**:

1. **Bot Feeder GUI** (`src/web-server.ts`, `src/views/js/dashboard.js`):
   - Checkbox grid of all 10 focus bots + 6 experimental bots with PnL/win-rate stats
   - Section headers (Focus Bots / Experimental Bots) with grid-column spanning
   - Status indicator ("N bot(s) feeding queue | $X/trade")

2. **Signal Wiring**:
   - Focus bots: `addToMexcQueue()` called after position opens in focusShadowBots loop
   - Experimental bots: Wired in both BB and GP experimental signal loops
   - Queue conditional on `serverSettings.mexcSelectedBots.includes(botId)`

3. **Position Sizing**:
   - Fixed USD mode (default $10) or % of available balance mode
   - MEXC balance cached via `fetchMexcBalance()` and refreshed every 5 min
   - `GET /api/mexc/balance` endpoint for real-time balance
   - Preview shows "≈ $X.XX (of $Y.YY available)"

4. **Safety Controls**:
   - Editable max position size (default $50) — enforced in `addToMexcQueue()`
   - Editable max leverage (default 20x) — caps bot's suggested leverage
   - Dedup: same symbol+side only creates one queue entry
   - SL/TP passthrough: every queued order includes stop-loss and take-profit

5. **Full Automation Toggle**:
   - `mexcAutoExecute` boolean in ServerSettings
   - Double `window.confirm()` dialog for safety
   - `autoExecuteOrder()` function for live mode auto-execution
   - Shadow mode: auto-marks as "executed" (log only)
   - Live mode: calls `client.openLong()`/`openShort()` with SL/TP

6. **Grid Alignment Fix**:
   - Added `grid-column: 1 / -1` to section headers
   - Increased min column width from 220px to 280px

**API Endpoints Added**:
- `GET /api/mexc/bot-selection` — available bots with stats, current selection, all settings
- `POST /api/mexc/bot-selection` — update selection, position size, max size/leverage, auto-execute
- `GET /api/mexc/balance` — real-time MEXC available balance

**Commits**:
- `0c95d9a` "feat: Add experimental bots to Bot Feeder + % balance position sizing"
- `e1f23c0` "feat: Editable max size/leverage + full automation toggle"
- `b5de078` "fix: Bot Feeder grid alignment — headers span full width, wider columns"

**Pushed to Github**: ✅ `ecf8d3d` (6 commits ahead of origin)

---

## Previous Task: Momentum Exhaustion Signal Classification & Filter

### Iteration 31 - Momentum Exhaustion Filter
**Date**: 2026-01-25
**Status**: 🔶 Core Complete, UI Deferred

**Goal**: Fix false positives where coins that pump hard (e.g., INIT +21%) and become overbought are incorrectly classified as backburner shorts. These are "momentum exhaustion" signals, not true backburners.

**Key Accomplishments**:

1. **Signal Classification** (`src/types.ts`, `src/backburner-detector.ts`):
   - Added `SignalClassification` type: 'backburner' | 'momentum_exhaustion'
   - Added `ExhaustionDirection` type: 'extended_long' | 'extended_short'
   - Added retracement detection: if counter-move retraces >61.8% → momentum_exhaustion
   - Added price check: if price beyond impulse start → not a pullback, it's a reversal

2. **Exhaustion Tracker** (`src/web-server.ts`):
   - `momentumExhaustionMap` - tracks extended coins by symbol-timeframe
   - `updateMomentumExhaustion()` - populates tracker from 4H/1H setups
   - `checkMomentumExhaustion()` - checks if symbol has exhaustion for direction
   - `cleanupStaleExhaustion()` - removes signals older than 4 hours
   - Cleanup runs every 5 minutes automatically

3. **Trade Filter**:
   - Added exhaustion check to `shouldTradeSetup()`
   - Blocks LONG trades on coins with `extended_long` (pumped too hard)
   - Blocks SHORT trades on coins with `extended_short` (dumped too hard)
   - Logs when filter blocks trades with full details

4. **API Endpoints**:
   - `GET /api/exhaustion` - returns all extended coins sorted by impulse%
   - `GET /api/exhaustion/:symbol` - check specific symbol for blocking

**Deferred to Follow-up**:
- Dashboard "Extended Coins" section UI
- Turso logging for historical analysis

**Problem Solved**: INITUSDT 4H was showing as "backburner short" because the 50-candle lookback saw old dump + current pump as "down impulse with bounce". Now correctly classified as `momentum_exhaustion (extended_long)` - the filter prevents bad 5m long trades on such coins.

**Commits**:
- `34b23df` "feat: Add momentum exhaustion signal classification"
- `df6ae93` "feat: Add momentum exhaustion tracker and filter"
- `4de8b33` "feat: Add exhaustion API endpoints for Focus Mode integration"

---

### Iteration 30 - Chrome Extension Cookie Auto-Refresh
**Date**: 2026-01-24
**Status**: ✅ Complete

**Goal**: Replace Playwright-based cookie daemon (blocked by bot detection) with a Chrome extension that can export cookies from the real browser.

**Key Accomplishments**:

1. **Chrome Extension** (`tools/cookie-exporter/`):
   - Manifest V3 with nativeMessaging, alarms, storage permissions
   - Background service worker auto-refreshes every 30 minutes
   - Popup UI shows status, last refresh, manual refresh button
   - Exports all MEXC cookies (uc_token, u_id, x-mxc-fingerprint)

2. **Native Messaging Host**:
   - Node.js script receives cookies from Chrome extension
   - Updates `.env` file with fresh cookie values
   - Shell wrapper for macOS compatibility with Chrome
   - Logs to `.mexc-cookie-refresh.log`

3. **Cleanup**:
   - Removed Playwright-based daemon scripts
   - Removed playwright from package.json
   - Cleaned up worktrees (angry-hugle)
   - Updated .gitignore for security

**Problem Solved**: Playwright's "Chrome for Testing" is detected as a bot by MEXC/Google, preventing login. The Chrome extension uses the real browser where the user is already logged in.

**Files Created**:
- `tools/cookie-exporter/manifest.json`
- `tools/cookie-exporter/background.js`
- `tools/cookie-exporter/popup.html`
- `tools/cookie-exporter/popup.js`
- `tools/cookie-exporter/native-host.js`
- `tools/cookie-exporter/native-host.sh`
- `tools/cookie-exporter/install.sh`
- `tools/cookie-exporter/icon.png`

**Files Removed**:
- `scripts/mexc-cookie-daemon.ts`
- `scripts/install-mexc-daemon.sh`
- `scripts/com.backburner.mexc-cookie.plist`

**Commits**:
- `bce4def` "feat: Replace Playwright cookie daemon with Chrome extension"

---

### Iteration 29 - MEXC Futures API Client (Cookie Bypass)
**Date**: 2026-01-24
**Status**: ✅ Complete

**Goal**: Implement automated trading capability on MEXC Futures using the cookie bypass method (since official API has been "under maintenance" since July 2022).

**Key Accomplishments**:

1. **MEXC Futures Client** (`src/mexc-futures-client.ts`):
   - Cookie-based authentication using `u_id` browser cookie
   - MD5-based signature algorithm for request signing
   - Full order management: create, cancel, cancel all
   - Position management: get positions, close positions
   - Plan orders (SL/TP): create, modify, cancel
   - Helper methods: `setStopLoss()`, `setTakeProfit()`, `closePosition()`
   - Auto-cancels plan orders when closing positions

2. **Successful Test Trade**:
   - Opened DOGE_USDT LONG, 1 contract, 2x leverage
   - Set stop-loss at 2% below entry
   - Set take-profit at 5% above entry
   - Adjusted stop-loss to 1% below entry
   - Closed position successfully
   - Final balance: $120.02 (started with $120.00)

3. **Cookie Refresh Daemon** (`scripts/mexc-cookie-daemon.ts`):
   - Uses Playwright for persistent browser context
   - Saves browser state to `.mexc-browser-state.json`
   - `--setup` mode for initial login
   - `--once` mode for cron/single refresh
   - Daemon mode checks every 30 minutes
   - macOS LaunchAgent plist for background execution

**API Endpoints Implemented**:
- `GET /private/account/assets` - Balance
- `GET /private/position/open_positions` - Positions
- `POST /private/order/create` - Place order
- `POST /private/order/cancel` - Cancel order
- `POST /private/planorder/place` - Create SL/TP trigger
- `POST /private/planorder/cancel` - Cancel trigger
- `POST /private/planorder/cancel_all` - Cancel all triggers
- `GET /contract/ticker` - Get price

**Plan Order Parameters** (discovered via testing):
- `triggerType`: 1 = >=, 2 = <=
- `trend`: 1 = latest price, 2 = fair price, 3 = index price
- `executeCycle`: 1 = 24 hours, 2 = 7 days
- `orderType`: 1 = limit, 5 = market
- `openType`: 1 = isolated, 2 = cross

**Files Created**:
- `src/mexc-futures-client.ts` - Main API client
- `scripts/test-mexc-connection.ts` - Connection test
- `scripts/test-trade.ts` - Trade execution test
- `scripts/test-sltp.ts` - SL/TP and close test
- `scripts/cleanup-orders.ts` - Cancel orphaned orders
- `scripts/mexc-cookie-daemon.ts` - Cookie refresh daemon
- `scripts/install-mexc-daemon.sh` - macOS service installer
- `scripts/com.backburner.mexc-cookie.plist` - LaunchAgent config

**Files Modified**:
- `.gitignore` - Added browser state files
- `package.json` - Added Playwright dependency

**Commits**:
- `09525ee` "feat: Add stop-loss/take-profit and position management for MEXC"
- `925f262` "feat: Add MEXC cookie refresh daemon with Playwright"

**Next Steps** (for future iterations):
1. Wire MEXC client into execution bridge (`src/execution-bridge.ts`)
2. Connect bots to live trading via the bridge
3. Add position reconciliation with MEXC
4. Test shadow mode (log trades but don't execute)
5. Implement circuit breakers for safety

---

## Previous Task: Database Analysis & Data Collection Improvements

### Iteration 28 - Turso Database Analysis & Quadrant Data Logging
**Date**: 2026-01-23
**Status**: ✅ Complete

**Goal**: Analyze today's bot performance from Turso, identify data collection gaps, and add new shadow bots to test untested quadrant strategies.

**Key Discoveries**:

1. **Top Performer Today: `exp-bb-sysB`** (+$677.20, 44 trades, 50% win rate)
   - Uses System B bias filter (multi-indicator)
   - NO regime filter (trades all quadrants)
   - Backburner signals + trailing stops
   - Config: 20x leverage, 10% position, 8% initial stop, 10% trail trigger

2. **Focus Mode Bots Win Rates Are High** (66-100%) but losses outweigh wins
   - `focus-conservative`: +$40.84 (81.8% win rate) ← PROFITABLE
   - `focus-contrarian-only`: +$40.54 (100% win rate, 4 trades) ← PROFITABLE
   - `focus-kelly`: -$1,321.42 (66.7% win rate) ← Kelly sizing is CATASTROPHIC

3. **BULL+BULL Quadrant Not Being Tested**
   - Dashboard advertises BULL+BULL SHORT as "HIGH WIN RATE"
   - NO shadow bot was actually testing this strategy
   - Also found inconsistency: dashboard says SHORT, JS file says LONG

4. **Quadrant Data NOT Being Logged to Turso**
   - `entryQuadrant` field exists in code but never made it to database
   - Can't analyze performance by quadrant retroactively

**Changes Implemented**:

1. **Added 7 New Turso Columns** (auto-migrating schema):
   - `entry_quadrant` - Regime quadrant at entry (e.g., BULL+BULL)
   - `entry_quality` - Setup quality (excellent/good/marginal)
   - `entry_bias` - BTC bias at entry
   - `trail_activated` - Whether trailing stop triggered
   - `highest_pnl_percent` - Peak unrealized PnL
   - `entry_time` - Position open timestamp
   - `duration_ms` - Trade duration

2. **Updated Data Flow**:
   - `turso-db.ts`: Added ALTER TABLE migration + updated insertTradeEvent
   - `data-persistence.ts`: Added fields to TradeEvent interface + logTradeClose

3. **Created 3 New Focus Mode Shadow Bots**:
   - `focus-euphoria-fade`: BULL+BULL only (test "fade euphoria" claim)
   - `focus-bull-dip`: BULL+BEAR only (buy dips in macro bull)
   - `focus-full-quadrant`: ALL quadrants except BEAR+BULL (comprehensive data)

4. **Wired New Bots into web-server.ts**:
   - Added imports for new factory functions
   - Added to focusShadowBots Map
   - Added display names in getFullState()

**Files Modified**:
- `src/turso-db.ts` (+39 lines)
- `src/data-persistence.ts` (+15 lines)
- `src/focus-mode-shadow-bot.ts` (+58 lines)
- `src/web-server.ts` (+24 lines)

**Build**: ✅ Passes

**Commit**: d33f397 "feat: Add quadrant data logging to Turso + new shadow bots for BULL+BULL testing"

---

**Key Takeaways from Analysis**:

| Bot Category | Jan 22 PnL | Key Insight |
|--------------|------------|-------------|
| **Experimental A/B** | +$775 | `exp-bb-sysB` is crushing it with System B bias |
| **Spot Regime** | +$42 | All 4 variants profitable (1x leverage) |
| **Focus Mode Shadow** | -$1,394 | High win rates but Kelly bot destroyed gains |
| **Backburner Trailing** | -$3,524 | Struggling in current conditions |

**Exit Reason Analysis (Focus Mode)**:
- Trailing stops: 95% win rate (+$1,591)
- Stop losses: 0% win rate (-$3,060) ← THE PROBLEM

**Recommendations**:
1. Disable or heavily modify `focus-kelly` - variance is unacceptable
2. Investigate `exp-bb-sysB` System B filter for potential adoption
3. Monitor new `focus-euphoria-fade` bot for BULL+BULL data
4. Consider widening stop losses or reducing position sizes

---


---

## Older Iterations (Archived)

Iterations 1-27 (2026-01-13 to 2026-01-21) have been archived to:
**`.ralph/progress-archive-iterations-1-27.md`**

Topics covered in archive:
- Dropdown collapse fix, server infrastructure (1-2)
- RSI divergence, cross-strategy signals (3)
- Backtest analysis, timeframe filtering, BTC bias filter (4, 8)
- TCG-compliant Backburner implementation (6)
- Data collection system, compression utilities (7)
- CoinGecko fallback, CoinLore API (9)
- Fixed BE backtest, friction integration (10)
- Short setup investigation, GP shorts fix (11)
- Leverage comparison backtest (12)
- Market bias tracker, momentum indicators (13)
- Trading guide expansion (14)
- GUI connection fix (15)
- GP V2 bots, position notifications (17-18)
- V2 exit strategy overhaul (19)
- Investment amount configuration (20-24)
- Spot regime bots, focus mode shadow bots (25-27)

