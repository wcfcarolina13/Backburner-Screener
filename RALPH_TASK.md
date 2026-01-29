---
task: Premature Stop Loss Investigation + Bug Queue
test_command: "npm run build"
---

# Task: Premature Stop Loss Exits Investigation

**Priority**: Critical
**Status**: Complete — No Action Required

**Context**: After the SL bug fix (commit 67ec711 on cranky-dewdney/epic-lewin branches), the ROE-based SL formula divides by leverage, making the stop distance very tight on high-leverage volatile altcoins. At 20x leverage with 8% SL, the price distance is only 0.4%, causing positions to stop out within seconds on normal volatility.

---

## Success Criteria

1. [x] **Identify premature SL pattern in live data**
   - Queried Turso: 272 out of 4,506 closes (6%) happened under 1 minute in last 3 days
   - exp-bb-sysB examples: MERLUSDT stopped in 3.5s, PTBUSDT in 11.1s, JSTUSDT in 4.2s
   - All show `stop_loss` exit with ~0.4% price move at 20x leverage = 8% ROI

2. [x] **Trace the SL calculation path**
   - **Paper bots (exp-bb-*)**: Use line 316 formula: `stopDistance = entryPrice * (initialStopPercent / 100 / leverage)`
   - **Focus Mode bots**: Use `calculateSmartTradeSetup()` → S/R-based SL (different path)
   - **Live MEXC**: SL price from bot position passed directly to MEXC `openLong/openShort`
   - The ROE fix (67ec711) is CORRECT mathematically but produces 0.4% price stops at 20x

3. [x] **Root cause confirmed**
   - The math IS correct: 8% ROI / 20x leverage = 0.4% price distance
   - Problem: 0.4% is below normal bid-ask spread + volatility noise on altcoins
   - This isn't a "bug" — it's a parameter problem. 8% ROI SL at 20x is too tight for volatile assets
   - VVVUSDT example: exp-bb-sysB trades were actually profitable (trail activated, +5.3% and +27.7% ROI) — the user may have been seeing OTHER bot types stop out (10pct10x, shadow-* bots)

4. [x] **Decision: Leave as-is**
   - Live data shows bot is profitable despite tight stops
   - 129 trailing_stop wins (avg +15.59%) vs 73 stop_loss losses (avg -10.19%)
   - Widening stops would reduce premature exits but increase per-loss severity
   - The tight stop IS part of the strategy — fast cuts, let winners ride
   - User decision: leave it alone, revisit only if overall PnL degrades

---

## Key Findings

### The SL is mathematically correct but practically too tight

| Leverage | initialStopPercent | Price Distance | Typical Altcoin 5m Volatility |
|----------|--------------------|----------------|-------------------------------|
| 20x      | 8%                 | **0.4%**       | 0.5-2%                        |
| 10x      | 8%                 | **0.8%**       | 0.5-2%                        |
| 3x       | 8%                 | **2.67%**      | 0.5-2%                        |
| 20x      | 20%                | **1.0%**       | 0.5-2%                        |

At 20x leverage, even a 20% ROI SL only gives 1% price distance. The fix needs to ensure the price distance is above noise levels.

### Duration Distribution (last 3 days, 4,506 closes)
- Under 1 min: 272 (6.0%)
- 1-2 min: 144 (3.2%)
- 2-5 min: 434 (9.6%)
- Over 5 min: 3,656 (81.1%)

### VVVUSDT specifically
- exp-bb-sysB had 2 VVV trades — BOTH profitable via trailing stop (+5.3% and +27.7% ROI)
- The "premature" stops the user saw were from other bot types (10pct10x, shadow-*, wide, etc.)
- These bots use the `paper-trading-trailing.ts` SL path, which may have a separate issue

### LIVE MEXC Execution Data (251 events, all exp-bb-sysB)
- **73 stop_loss exits**: ALL show exactly -8.08% PnL and 0.400% price delta
- **129 trailing_stop wins**: Average +15.59% PnL
- **Net result**: Profitable — wins outnumber and outsize losses
- Fast SL examples: ZKCUSDT 1.5s, MERLUSDT 3.5s, JSTUSDT 4.2s, CYBERUSDT 5.0s
- SL is set ON MEXC exchange via `stopLossPrice` parameter in order creation
- **Decision**: Leave as-is. The tight 0.4% stop is part of what makes the system work

---

## Queued Tasks

### Task 2: Notification Bot Filtering
- **Status**: Complete
- **Problem**: `notifyGPPositionOpened()` only checked global `isNotificationsEnabled()`, never per-bot `serverSettings.botNotifications[botId]`
- **Fix**: Added `isBotNotificationEnabled(botId)` server-side helper; updated `notifyGPPositionOpened()` to use it
- **Files**: `src/web-server.ts` (line ~1008 helper, line ~1092 check)

### Task 3: Stale Order Cleanup
- **Status**: Complete
- **Problem**: When MEXC positions close via exchange-side SL/TP trigger, the other plan order becomes orphaned
- **Fixes**:
  1. Added `cancelAllPlanOrders(futuresSymbol)` in lifecycle detector when position closure detected
  2. Added `POST /api/mexc/cleanup-orders` endpoint for manual one-time cleanup
- **Files**: `src/web-server.ts` (lifecycle detector ~line 6424, cleanup endpoint ~line 2705)

### Task 4: Instant Close Bug (Leverage Cap SL Mismatch)
- **Status**: Complete (commit 371c351)
- **Symptoms**: NILUSDT, SPXUSDT, SAHARAUSDT positions opening and closing within seconds on live MEXC
- **Root Cause**: `addToMexcQueue()` capped leverage (e.g., 20x → 3x per `mexcMaxLeverage`) but did NOT recalculate SL price
  - Paper bot calculated SL for 20x leverage: 8% ROE = 0.4% price distance
  - Live execution at 3x leverage: 0.4% price distance = only 1.2% ROE (not 8%)
  - Normal volatility easily triggers SL within seconds
- **Fix**: When capping leverage, recalculate SL to maintain same ROE%:
  ```
  oldSlDistance = |SL - entry| / entry
  impliedRoePct = oldSlDistance * originalLeverage * 100
  newSlDistance = impliedRoePct / 100 / cappedLeverage
  newSL = entry * (1 ± newSlDistance)  // + for short, - for long
  ```
- **Example**:
  - Original: 8% ROE at 20x → 0.4% SL distance
  - Fixed: 8% ROE at 3x → 2.67% SL distance (appropriate for 3x)
- **Files**: `src/web-server.ts` (addToMexcQueue ~line 2978-3000)

---

## Previous Task (Complete)
- Stop Loss Bug Backtest
- Result: Bot IS profitable with corrected SL ($2,881 over 7 days)

## Current Task: Scaling-In Strategy Backtests

**Priority**: Active
**Status**: In Progress

### Observation from Insurance Analysis (2026-01-28)
- Insurance strategy HURTS overall PnL (-$143 at 2% threshold over 7 days)
- BUT performance is **regime-dependent**:
  - Jan 26-28: 56-99% WR → Insurance hurts (let winners run)
  - Jan 29: 43% WR during selloff → Insurance might help
- Key data: 66% of SL trades were up 2%+ ROE before failing (avg peak +5.1%)

### Success Criteria

1. [x] **Backtest 1: Regime-Conditional Insurance** ✅
   - Only activate insurance during detected market stress
   - Stress signal used: Alt win rate <50% in current hour
   - **Results** (1,140 trades with peak data over 7 days):
     - Full Ride: $8,872.81
     - Always Insurance @2%: $6,012.76 (-$2,860 vs full ride)
     - **Conditional Insurance @2%: $9,578.79 (+$706 vs full ride)**
   - **Finding**: Insurance HELPS during stress (+$706 savings) but HURTS during bull (-$3,566 cost)
   - **Conclusion**: Conditional insurance at 2% ROE during <50% WR hours improves overall returns
   - Script: `scripts/backtest-regime-insurance.ts`

2. [x] **Backtest 2: Two-Tranche Scaling-In Entry** ✅
   - First RSI <30 trigger: Enter 50% position
   - Second trigger (RSI <25 OR additional 1-2% drop): Enter remaining 50%
   - **Results** (estimated without candle replay, 1,426 trades):
     - Stress period baseline: -$1,716 PnL
     - With 1% drop second entry: -$253 PnL (+$1,463 improvement)
     - With 2% drop second entry: -$169 PnL (+$1,546 improvement)
     - Normal period also benefits: +$478 to +$740
   - **Caveat**: This is a heuristic estimate. Proper implementation needs:
     1. Candle replay from entry time
     2. RSI recalculation at each candle
     3. Handle case where second entry never triggers (half position)
   - **Conclusion**: Shows promise, especially during stress periods. Worth implementing properly.
   - Script: `scripts/backtest-scaling-in.ts`

3. [x] **Backtest 3: BTC Correlation Filter** ✅
   - Hypothesis: Skip entries during BTC selloffs to avoid catching falling knives
   - **Results** (1,426 trades, 7 days):
     - Baseline (all trades): 71.4% WR, $8,744 PnL
     - Skip if BTC < -1%: 71.0% WR, $8,232 PnL (**WORSE** by $512)
     - Skip if BTC < -0.5%: 71.9% WR, $7,841 PnL (**WORSE** by $903)
   - **Surprising finding**: Trades during BTC dips OUTPERFORM!
     | BTC 1h Change | Win Rate | Avg ROE |
     |---------------|----------|---------|
     | BTC -2% to -1% | **100%** | +19.0% |
     | BTC -1% to 0% | 69% | +3.1% |
     | BTC 0% to +1% | 78% | +4.4% |
     | BTC +1% to +2% | **18%** | -2.4% |
   - **Conclusion**: For contrarian RSI oversold strategy, BTC dips = better entries
     The filter would HURT us. If anything, skip entries when BTC is UP 1%+.
   - Script: `scripts/backtest-btc-filter.ts`

---

## Previous Backtest Results (Parking Lot)

### TCG Insurance Sale Strategy (TESTED - NEGATIVE)
- **Concept**: Sell 50% of position at first bounce (+1-2% ROE), move SL to breakeven on remaining 50%
- **Backtest Result** (2026-01-28): Insurance HURTS performance for exp-bb-sysB
  - Current strategy: $574.81 PnL (7 days)
  - Insurance @ 2%: $431.77 (-$143, -25%)
  - Insurance @ 3%: $446.71 (-$128, -22%)
  - Insurance @ 5%: $498.10 (-$77, -13%)
- **Why**: Current trailing stop system already protects winners. Insurance cuts big wins in half.
- Saved 88 trades from full loss at 2% threshold, but cost half of every big winner

### Position Size Scaling
- Test Kelly Criterion sizing vs fixed sizing
- Existing data: focus-kelly lost $1,321 in one day despite 66.7% win rate (variance)

### Leverage Optimization
- Current: 20x on paper, but MEXC caps to 10x for most assets
- Test: What if paper matched MEXC leverage exactly?

### MEXC Position Sizing Investigation (Parking Lot)
- **Observation**: Some positions are undersized (ETH: $2.96 margin vs expected $4.70)
- **Cause**: When target USD < 1 contract's value, only minimum 1 contract is bought
  - Example: ETH contract = $29.59, target = $5 → buy 1 contract = $2.96 margin
- **Also noted**: Leverage doesn't increase margin used; it increases notional exposure
  - 10% balance sizing = $4.80 margin regardless of 10x or 20x leverage
  - Higher leverage = same dollar risk, but tighter stop in price terms

---

## Older Tasks (Complete)
- HTF-Based Impulse Detection + 15m Trading (cca674a)
- Futures-Only Asset Discovery & Commodity Screening (0e95826, d669874)
