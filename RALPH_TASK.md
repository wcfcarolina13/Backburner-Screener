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

## Older Tasks (Complete)
- HTF-Based Impulse Detection + 15m Trading (cca674a)
- Futures-Only Asset Discovery & Commodity Screening (0e95826, d669874)
