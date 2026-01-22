# Progress Log

> Updated by the agent after significant work.

## Summary

- Iterations completed: 27
- Current status: Focus Mode Shadow Bots Wired Up

## Current Task: Focus Mode Shadow Bots

### Iteration 27 - Create and Wire Focus Mode Shadow Bots
**Date**: 2026-01-21
**Status**: ✅ Complete

**Goal**: Create shadow bots that simulate manual leveraged trading using Focus Mode guidance - testing multiple strategy variants for future automated trading.

**New File Created**: `src/focus-mode-shadow-bot.ts`

**Bot Variants Created** (8 total):

1. **focus-baseline**: Standard Focus Mode rules, max 5 positions
2. **focus-conflict**: Closes positions when regime becomes conflicting (5 min grace period)
3. **focus-excellent**: Allows +2 extra positions for "excellent" quality setups
4. **focus-hybrid**: Combines conflict-close + excellent-overflow
5. **focus-aggressive**: 1.5x leverage multiplier, 8 max positions, tighter stops
6. **focus-conservative**: 0.75x leverage, wider stops, stricter entry rules, closes on conflict
7. **focus-kelly**: Uses Kelly criterion for position sizing based on R:R and quality
8. **focus-contrarian-only**: Only trades in NEU+BEAR and BEAR+BEAR quadrants

**Key Features**:
- Uses signal's suggested leverage (clamped 3-15x by default)
- Dynamic position sizing based on setup quality
- Trailing stops with Focus Mode's tiered system
- Quality scoring (excellent/good/marginal/skip) based on impulse strength and RSI
- Regime detection with conflict-close option
- Realistic execution costs (fees + slippage)

**Configuration Options**:
```typescript
interface FocusModeShadowBotConfig {
  maxPositions: number;           // Base position limit
  maxExcellentOverflow: number;   // Extra for excellent setups
  leverageMultiplier: number;     // Scale suggested leverage
  closeOnConflict: boolean;       // Close on regime conflict
  conflictGracePeriodMs: number;  // Wait before conflict-close
  minQualityScore: number;        // Entry filter (0-100)
  allowedQuadrants: Quadrant[];   // Which quadrants to trade
  useKellySizing: boolean;        // Kelly vs fixed sizing
}
```

**Integration in web-server.ts**:
- Signal processing calculates Focus Mode trade parameters (SL, TP, leverage, quality)
- Price updates in main loop update all positions
- Logged to Turso via dataPersistence
- Added to getFullState for GUI visibility
- Added to reset and setInitialBalance functions

**Build**: ✅ Passes

---

## Previous Task: Wire Up Spot Regime Bots

### Iteration 26 - Wire Spot Regime Bots into Web Server
**Date**: 2026-01-21
**Status**: ✅ Complete

**Goal**: Wire up the existing `spot-regime-bot.ts` (contrarian quadrant-based trading) into web-server.ts so it actually runs and logs trades.

**Changes Made**:

1. **Import added** (line 14):
   ```typescript
   import { SpotRegimeBot, createStrictFilterBot, createLooseFilterBot, createStandardFilterBot, createContrarianOnlyBot } from './spot-regime-bot.js';
   ```

2. **Bot instances created** (after line 761):
   - `spot-standard` - 65% thresholds, 15% stop loss
   - `spot-strict` - 70% thresholds, 12% stop loss (fewer trades, higher conviction)
   - `spot-loose` - 60% thresholds, 18% stop loss (more trades, lower conviction)
   - `spot-contrarian` - Bearish-only quadrants (NEU+BEAR, BEAR+BEAR)

3. **Signal processing** (after fade bots in handleNewSetup):
   - Converts BackburnerSetup to Signal format for regime bots
   - Processes ALL triggered/deep_extreme signals to build regime history
   - Only opens positions in profitable quadrants
   - Logs trades via `dataPersistence.logTradeOpen()`

4. **Price updates** (in main loop after fade bots):
   - Updates all spot regime positions with current spot prices
   - Tracks trailing stops and stop losses
   - Logs closes via `dataPersistence.logTradeClose()`
   - Broadcasts position updates to GUI

5. **GUI state** (in getFullState):
   - Added `spotRegimeBots` section showing regime stats, positions, trades

**Bot Configurations**:
- **spot-standard**: Default 65% micro threshold, 15% SL, 10% trail trigger
- **spot-strict**: 70% threshold (fewer but higher conviction), 12% SL, 8% trail
- **spot-loose**: 60% threshold (more trades), 18% SL, 12% trail
- **spot-contrarian**: Only trades in bearish micro regimes (NEU+BEAR, BEAR+BEAR)

**Quadrant Rules**:
- ✅ Profitable: NEU+BEAR, NEU+BULL, BEAR+BEAR
- ⛔ Forbidden: BEAR+BULL (0% win rate - bull trap)
- ⏭️ Skipped: All others

**Build**: ✅ Passes

**Note**: These bots are SPOT (long-only, 1x leverage) and implement realistic execution costs (slippage, fees, bad fills).

---

## Previous Task: Bot Performance Analysis

### Iteration 25 - Turso Database Performance Analysis
**Date**: 2026-01-21
**Status**: ✅ Complete

**Goal**: Analyze shadow bot and overall bot performance from Render server via Turso database.

**Turso Database Info**:
- URL: `libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io`
- Auth: Requires `TURSO_AUTH_TOKEN` environment variable
- Query script: `scripts/query-turso.ts`

**Working SQL Queries for Turso**:

```sql
-- Query 1: All bot performance summary
SELECT
  bot_id,
  COUNT(*) as total_events,
  SUM(CASE WHEN event_type = 'open' THEN 1 ELSE 0 END) as opens,
  SUM(CASE WHEN event_type = 'close' THEN 1 ELSE 0 END) as closes,
  SUM(CASE WHEN event_type = 'close' AND realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN event_type = 'close' AND realized_pnl <= 0 THEN 1 ELSE 0 END) as losses,
  ROUND(SUM(CASE WHEN event_type = 'close' THEN realized_pnl ELSE 0 END), 2) as total_pnl
FROM trade_events
GROUP BY bot_id
ORDER BY total_pnl DESC;

-- Query 2: Daily PnL summary (last 7 days)
SELECT date,
  COUNT(*) as events,
  SUM(CASE WHEN event_type = 'close' THEN realized_pnl ELSE 0 END) as daily_pnl
FROM trade_events
WHERE date >= date('now', '-7 days')
GROUP BY date
ORDER BY date DESC;

-- Query 3: Shadow bot performance
SELECT
  bot_id,
  COUNT(*) as closes,
  SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN realized_pnl <= 0 THEN 1 ELSE 0 END) as losses,
  ROUND(100.0 * SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
  ROUND(SUM(realized_pnl), 2) as total_pnl,
  ROUND(AVG(realized_pnl), 2) as avg_pnl
FROM trade_events
WHERE event_type = 'close' AND bot_id LIKE 'shadow%'
GROUP BY bot_id
ORDER BY total_pnl DESC;
```

**Key Findings (Jan 14-21, 2026)**:

1. **ONLY GP2 (loose threshold) bots are profitable**:
   - gp2-yolo: +$123.09 (75% win rate, 4 trades)
   - gp2-aggressive: +$50.89 (75% win rate)
   - gp2-standard: +$38.32 (75% win rate)
   - gp2-conservative: +$15.45 (75% win rate)

2. **Shadow Bot Results** (testing stop-loss levels):
   - 8% SL: -$206 (40% win rate) ← Best performer
   - 10% SL: -$330 (33% win rate)
   - 15% SL: -$340 (33% win rate)
   - 18% SL: -$352 (33% win rate)
   - **Conclusion**: Tighter stops are better but all still losing

3. **Catastrophic Performers**:
   - BTC Bias 100x bots: -$5,000 to -$5,400 each (0% win rate!)
   - Aggressive trailing: -$3,293 to -$3,580
   - Total 7-day loss: **~$39,700**

4. **Daily Performance**:
   - Only 1 profitable day in 8 (Jan 20: +$76)
   - Worst day: Jan 15 (-$12,349)

**Important Discovery**:
- The `spot-regime-bot.ts` (contrarian quadrant bot mimicking Focus Mode) EXISTS but is NOT wired into web-server.ts
- Focus Mode is manual-only - no automated contrarian quadrant trading is running

**Recommendations**:
1. **DISABLE all BTC Bias bots** - 0% win rate is catastrophic
2. **Consider disabling aggressive trailing bots** - losing badly
3. **GP2 bots are the only winners** - consider focusing here
4. **Wire up spot-regime-bot** if we want to auto-trade the contrarian system

---

## Previous Task: Investment Amount in Focus Mode

### Iteration 24 - Add Investment Amount to Focus Mode Dashboard
**Date**: 2026-01-20
**Status**: ✅ Complete

**Problem**: User couldn't find the investment amount setting in Focus Mode - it was only accessible from the main dashboard Settings modal, but Focus Mode is a separate page.

**Solution**: Added investment amount input directly in the Focus Mode toolbar:

1. **Investment input group in search-filter bar**:
   - Placed between the active count and Close All button
   - Includes $ label, number input, and Save button
   - Separated from other controls with a left border

2. **CSS styling** (`.investment-input-group`, `.investment-input`, `.investment-save-btn`):
   - Consistent dark theme styling
   - Green save button matches existing UI
   - Disabled state during save operation

3. **JavaScript functions**:
   - `loadInvestmentAmount()` - fetches current value from `/api/investment-amount` on page load
   - `saveInvestmentAmount()` - POSTs new value with loading state and toast feedback

4. **API integration**:
   - Uses existing `/api/investment-amount` endpoints from web-server.ts
   - No backend changes needed

**Files Modified**:
- `src/focus-mode-dashboard.ts`:
  - Added CSS for investment input (~40 lines)
  - Added HTML input group to search-filter bar
  - Added `loadInvestmentAmount()` and `saveInvestmentAmount()` functions (~60 lines)
  - Auto-loads investment amount on page load

**Build**: ✅ Passes successfully

---

## Previous Task: Conflict Detection

### Iteration 23 - Add Visible Conflict Badge for Opposing Signals
**Date**: 2026-01-20
**Status**: ✅ Complete

**Problem**: When tracking a position, if the signal flips to the opposite direction (e.g., you're LONG but signal now says SHORT), it wasn't immediately clear in the collapsed card header.

**Solution**: Added prominent conflict detection in the card header:

1. **"⚠️ CONFLICT" badge**:
   - Shows in header when position direction opposes current signal
   - Red pulsing animation to draw attention
   - Only visible when there's an actual conflict

2. **Improved suggestion text**:
   - Now explicitly says: "CONFLICT: Signal now says SHORT but you are LONG. Consider closing."
   - Uses danger class (red text) for conflicts

3. **Header styling**:
   - Added `.header-suggestion.danger` class with red bold text
   - Conflict badge has pulse animation

**CSS Changes**:
- Added `.header-suggestion.danger` style
- Added `.header-conflict-badge` with visibility toggle and pulse animation

**Logic Changes**:
- Separated conflict detection (regimeStatus === 'bad') from other dangers
- Conflict gets higher urgency score (85) vs other warnings (80)
- Header suggestion uses danger class for conflicts

**Files Modified**:
- `src/focus-mode-dashboard.ts`:
  - Added conflict badge CSS (+20 lines)
  - Added conflict badge to both card templates
  - Added conflict badge visibility logic in updatePositionHealth()
  - Improved suggestion text for conflicts
  - Added danger class handling for header suggestion

**Build**: ✅ Passes successfully

---

## Previous Task: Close All Button

### Iteration 22 - Add "Close All" Button to Focus Mode
**Date**: 2026-01-20
**Status**: ✅ Complete

**Problem**: User needed a quick way to stop tracking all positions at once (e.g., end of day, regime flip against all positions).

**Solution**: Added a "🛑 Close All" button to the Focus Mode toolbar:

1. **Button placement**: In the search/filter bar, next to the active count
2. **Visibility**: Only shows when there are active positions being tracked
3. **Confirmation**: Prompts user with count and reminder to close on MEXC manually
4. **Action**: Clears all tracked positions, resets UI for all cards

**Features**:
- Red outlined button with hover state
- Hidden when no positions (uses CSS class toggle)
- Updates after each enter/exit trade
- Clears localStorage position data
- Shows toast with count of positions stopped

**Files Modified**:
- `src/focus-mode-dashboard.ts`:
  - Added `.close-all-btn` CSS styles (+20 lines)
  - Added button to search filter bar
  - Added `closeAllPositions()` function
  - Added `updateCloseAllButton()` helper
  - Called helper in `enterTrade()`, `exitTrade()`, `restoreActivePositions()`

**Build**: ✅ Passes successfully

---

## Previous Task: Trail Alert Fix

### Iteration 21 - Fix Trail Alerts Breaking After Entry Adjustment
**Date**: 2026-01-20
**Status**: ✅ Complete

**Problem**: When user adjusted position entry price in Focus Mode (to sync with real MEXC data), the trailing stop alerts would stop working. Even if the position was still above trailing thresholds, no alerts would fire.

**Root Cause**: The trail alert system uses "previous" tracking values (`prevRoiPct`, `prevTrailStatus`, etc.) to detect threshold crossings. When entry was adjusted:
1. Old `prevRoiPct` was 30% (from wrong entry)
2. New actual ROI is 15% (from correct entry)
3. Check `roiPct >= 30 && prevRoi < 30` fails because prevRoi=30 is NOT < 30
4. Check `roiPct >= 15 && prevRoi < 15` fails because prevRoi=30 is NOT < 15
5. Result: No alert fires, even though user should see trail at 50%

**Solution**: Reset all tracking values when entry price is adjusted:
- `prevPnlPct`, `prevRoiPct`, `prevTrailStatus`, `prevDangers` → undefined
- `trailStopAlerted`, `trailStopAlertedAt` → false/null

This allows the alert system to "re-discover" the current trail level and fire appropriate notifications.

**Files Modified**:
- `src/focus-mode-dashboard.ts`:
  - `updateManualEntry()` - added tracking reset (+8 lines)
  - `updateFromROI()` - added tracking reset (+8 lines)

**Build**: ✅ Passes successfully

---

## Previous Task: Investment Amount Configuration

### Iteration 20 - Configurable Investment Amount
**Date**: 2026-01-20
**Status**: ✅ Complete

**Problem**: Each tracked setup assumed a fixed $2000 balance, causing ROI calculations to be off when the user's actual MEXC investment differed.

**Solution Implemented**:

1. **Added `setInitialBalance()` method to all bot classes**:
   - PaperTradingEngine
   - TrailingStopEngine
   - TimeframeShadowBot
   - GoldenPocketBot, GoldenPocketBotV2
   - GpShadowBot
   - CombinedStrategyBot
   - ConfluenceBot
   - BTCExtremeBot, BTCTrendBot
   - TrendOverrideBot, TrendFlipBot
   - FadeBot
   - MexcTrailingSimulation

2. **Added `investmentAmount` to ServerSettings**:
   - Persisted to `data/server-settings.json`
   - Survives server restarts

3. **Created API endpoints**:
   - `GET /api/investment-amount` - returns current investment
   - `POST /api/investment-amount` - updates investment and optionally resets bots

4. **Added Settings UI**:
   - New "💰 Investment Amount" section in Settings modal
   - Input field for USD amount
   - "Save (Keep Balances)" - updates config for future resets
   - "Save & Reset Bots" - updates and immediately resets all bots

5. **Updated reset messages**:
   - Manual reset shows current investment amount instead of hardcoded $2000
   - Server logs reflect configured investment amount

**Files Modified**:
- `src/paper-trading.ts` (+7 lines)
- `src/paper-trading-trailing.ts` (+7 lines)
- `src/timeframe-shadow-bot.ts` (+4 lines)
- `src/golden-pocket-bot.ts` (+4 lines)
- `src/golden-pocket-bot-v2.ts` (+4 lines)
- `src/gp-shadow-bot.ts` (+4 lines)
- `src/combined-strategy-bot.ts` (+4 lines)
- `src/confluence-bot.ts` (+4 lines)
- `src/btc-extreme-bot.ts` (+4 lines)
- `src/btc-trend-bot.ts` (+4 lines)
- `src/trend-override-bot.ts` (+4 lines)
- `src/trend-flip-bot.ts` (+4 lines)
- `src/fade-bot.ts` (+4 lines)
- `src/mexc-trailing-simulation.ts` (+4 lines)
- `src/web-server.ts` (~150 lines - settings, API, UI, helper functions)

**Build**: ✅ Passes successfully

---

## Previous Task: V2 Exit Strategy Overhaul

### Iteration 19 - V2: Exit Strategy Overhaul for Positive Expected Value
**Date**: 2026-01-19
**Status**: ✅ Complete

**Problem**: System was mathematically guaranteed to lose money
- Win rate: 31.8% (5m timeframe)
- Avg win: $33.41 | Avg loss: $37.35
- R:R ratio: 0.89:1
- Expected value: **-$14.85 per trade**

**Critical Finding**: BTC Bias bots had **0% win rate**, responsible for **40% of losses** (~$7,459)

**V2 Changes Implemented**:

1. **REMOVED BTC Bias V2 Bots** (all 8 variants)
   - Commented out import and creation
   - Removed from botVisibility
   - Empty map placeholder to prevent runtime errors

2. **5m Timeframe Only**
   - Changed `ALLOWED_TIMEFRAMES` from `['5m', '15m']` to `['5m']`
   - 5m had best win rate (31.8%), 15m marginal, 1h terrible

3. **Tightened Stop Loss** (20% → 12%)
   - All fixed TP/SL bots: stopLossPercent: 12
   - All trailing bots: initialStopLossPercent: 12
   - Target: reduce avg loss from $37 to ~$22

4. **Widened Take Profit** (20% → 35%)
   - fixedTPBot: takeProfitPercent: 35
   - fixedBreakevenBot: takeProfitPercent: 35
   - Target: increase avg win from $33 to ~$50

5. **Adjusted Trail Parameters**
   - trailTriggerPercent: 10% → 8%
   - trailStepPercent: 10% → 8%
   - breakevenTriggerPercent: 10% → 8%

6. **Reconfigured Shadow Bots**
   - Old: 10%, 15%, 25%, 30% stops
   - New: 8%, 10%, 15%, 18% stops (tighter range)
   - Purpose: Find optimal stop level for V3

**V2 Expected Math**:
- R:R Ratio: 35/12 = 2.9:1
- Required win rate for breakeven: 26%
- Actual 5m win rate: 31.8%
- Expected value: **+$0.90 to +$1.85 per trade** (depending on win rate impact)

**Files Modified**:
- `src/web-server.ts` - All bot configurations updated with V2 CHANGE comments

**Files Created**:
- `V2_CHANGELOG.md` - Full documentation of changes and rollback instructions
- `src/v2-validation.ts` - Validation script showing math improvement

**Commit**: a657585 "V2: Exit strategy overhaul for positive expected value"
**Pushed to GitHub**: ✅ (user pushed manually)
**Render Deploy**: In progress (auto-deploy from GitHub)

**Build**: ✅ Passes successfully

---

## Previous Task: Focus Mode Fix

### Iteration 18 - Focus Mode Support for GP V2 Bots
**Date**: 2026-01-15
**Status**: ✅ Complete

**Problem**: Focus Mode wasn't working for GP bots (V1 or V2)
- When selecting `gp-yolo` or any GP bot, no notifications or GUI updates
- The `getTargetBotPositions()` function didn't include GP V2 bots
- Focus Mode lookup code only checked `goldenPocketBots` (V1), not `goldenPocketBotsV2`
- GUI dropdown was missing all GP V2 bot options

**Root Causes**:
1. `FocusTargetBot` type in focus-mode.ts didn't include `gp2-*` variants
2. `getTargetBotPositions()` had no case for `gp2-*` bots
3. `handleNewSetup()` and `handleSetupUpdated()` only checked `goldenPocketBots.get()`, never `goldenPocketBotsV2`
4. Focus Mode dropdown in HTML missing GP V2 options

**Fixes Applied**:
1. Added `gp2-conservative | gp2-standard | gp2-aggressive | gp2-yolo` to `FocusTargetBot` type
2. Added case block for `gp2-*` bots in `getTargetBotPositions()`
3. Updated `handleNewSetup()` to check both V1 and V2 bot maps
4. Updated `handleSetupUpdated()` to check both V1 and V2 bot maps
5. Added "Golden Pocket V2 (Loose)" optgroup to Focus Mode dropdown

**Files Modified**:
- `src/focus-mode.ts` - Added gp2-* to FocusTargetBot type
- `src/web-server.ts` - Updated getTargetBotPositions, handleNewSetup, handleSetupUpdated, and HTML dropdown

**Build**: ✅ Passes successfully

---

## Previous Task: GP V2 Bot Functionality

### Iteration 17 - GP V2 Detector Wired Up + Position Notifications
**Date**: 2026-01-15
**Status**: ✅ Complete

**Problem**: GP V2 (loose threshold) bots weren't receiving any trades while V1 bots were trading
- V2 detector existed but was NEVER instantiated in screener.ts
- No V2 setups were being generated (all setups lacked `isV2: true` flag)
- V2 bots had nothing to trade on
- Desktop notifications were missing when GP bots opened positions

**Root Cause**: The screener only created the V1 GoldenPocketDetector, never the V2 version
- Line 78 in screener.ts only instantiated V1 detector
- V2 detector code existed in `golden-pocket-detector-v2.ts` but was unused

**Fixes Applied**:
1. Added V2 detector import and instantiation in screener.ts
2. Added V2 tracking maps (`previousGPV2Setups`, `playedOutGPV2Setups`)
3. Added `processGoldenPocketV2Setup()` method (mirrors V1 but with V2 tracking)
4. Wired V2 analysis into both full scan and incremental scan loops
5. Added cleanup for V2 setups in `cleanupExpiredSetups()`
6. Added `getGoldenPocketV2Setups()` getter
7. Exposed V2 setups in web-server's `getFullState()` as `goldenPocketV2`
8. Added `notifyGPPositionOpened()` function for powerful desktop alerts

**V2 Thresholds (vs V1)**:
- Impulse: 4% (V1: 5%)
- Volume: 1.5x average (V1: 2x)
- Long RSI trigger: < 50 (V1: < 40)
- Short RSI trigger: > 50 (V1: > 60)

**Files Modified**:
- `src/screener.ts` - Added V2 detector, tracking, and getters
- `src/web-server.ts` - Added V2 state exposure and position notifications

**Build**: ✅ Passes successfully

---

### Iteration 16 - Remove V1 BTC Bias Bots from GUI
**Date**: 2026-01-15
**Status**: ✅ Complete

**Problem**: Archived V1 BTC Bias bots (8 total) still showing in GUI cluttering the interface

**Solution**:
- Created archive document: `data/archived/BTC_BIAS_V1_EXPERIMENT.md`
- Contains full performance results (-$12k loss), root cause analysis, lessons learned
- Removed ALL V1 bot code from GUI:
  - Toggle controls and stats sections
  - State broadcasting in `getFullState()`
  - Bias update processing
  - Config/snapshot logging
  - Import of `createBtcBiasBots`

**Files Created**:
- `data/archived/BTC_BIAS_V1_EXPERIMENT.md`

**Files Modified**:
- `src/web-server.ts` - Removed V1 BTC Bias bot code

---

## Previous Task: GUI Connection Fix

### Iteration 15 - Fix "Connecting..." Status Bug
**Date**: 2026-01-15
**Status**: ✅ Complete

**Problem**: GUI showed "Connecting..." forever on both localhost:3000 and backburner.onrender.com
- No trades/setups were populating
- Analytics section showed loading states
- Browser console showed: `SyntaxError: Unexpected token '<'` at line 1393

**Root Cause**: Duplicate `<script>` tag in the HTML template
- Lines 3301-3302 had `<script>\n<script>` instead of just `<script>`
- This caused JavaScript parsing to fail
- SSE event handlers never initialized properly
- The page appeared to connect but couldn't process incoming events

**Fix Applied**:
- Removed the duplicate `<script>` tag at line 3301
- Single line deletion in src/web-server.ts

**Verification**:
- Local server starts and serves HTML correctly
- SSE endpoint (`/events`) returns valid JSON events
- `curl` test confirms events are properly formatted

**Files Modified**:
- `src/web-server.ts` (-1 line - removed duplicate script tag)

**Guardrails Added**:
- "Check for Duplicate HTML Tags" - search for `<script><script>` after editing HTML
- "Test SSE Endpoints After Changes" - use curl to verify JSON events

**Build**: ✅ Passes successfully

**Note**: Push to GitHub required to trigger Render redeploy (user needs to push)

---

## Previous Task: Documentation Update

### Iteration 14 - Trading Guide Expansion
**Date**: 2026-01-15
**Status**: ✅ Complete

**Goal**: Update Trading Guide to cover all non-archived bots (user noticed Override/Flip were missing).

**Changes Made**:

1. **Added Trend Override Strategy Section**:
   - Explains conflict-detection logic (single-TF backburner vs BTC trend)
   - Shows how direction is overridden to ride with trend
   - Includes example scenario

2. **Added Trend Flip Strategy Section**:
   - Same entry logic as Override
   - Explains flip mechanism on profitable close
   - Shows example trade flow

3. **Added BTC-Only Strategies Section**:
   - **BTCExtremeBot (Contrarian)**: Fades RSI extremes, 50x leverage
   - **BTCTrendBot (Momentum)**: Follows strong bias, 50x leverage
   - **BTC Bias V2 (Multi-Level)**: Four bots at different thresholds (±80/60/40/20%)

**Performance Note**: Override and Flip bots have **0 trades** so far - they haven't triggered yet. Their conditions (single-TF setup conflicting with BTC trend) are specific.

**Files Modified**:
- `src/web-server.ts` (+56 lines in Trading Guide modal)

**Build**: ✅ Passes successfully

---

## Previous Task: Market Bias Tracker Enhancement

### Iteration 13 - Replace Chart with Actionable Indicators
**Date**: 2026-01-15
**Status**: ✅ Complete

**Goal**: Remove the unused RSI chart and replace with actionable trading indicators.

**Changes Made**:

1. **Removed RSI Multi-Timeframe Chart**:
   - Removed Chart.js canvas and related code
   - Removed chart.js and chartjs-adapter-date-fns script imports
   - Removed `btcRsiChart` variable and `updateBtcRsiChart()` function

2. **Added Momentum Indicators Panel**:
   - **BTC Price**: Current price with 1h, 4h, 24h % changes (color-coded green/red)
   - **Volatility (ATR)**: 14-period ATR as % of price with level indicator (Low/Normal/Elevated/HIGH)
   - **Volume vs Avg**: Current volume ratio vs 20-period average (High Activity/Above Avg/Average/Low Activity)
   - **24h Range Position**: Where price is in the 24h high-low range (Near High/Upper/Mid/Lower/Near Low)

3. **Added Strategy Performance Summary**:
   - **GP Bots PnL**: Total PnL and win/loss count from all GP bots (best performers)
   - **Trailing Bots PnL**: Total PnL and win/loss count from trailing bots
   - **Active Positions**: Count of open positions with total unrealized PnL
   - **Setup Counts**: Active GP setups and Backburner setups
   - **Choppy Market Warning**: Displays when detected (low net movement, high back-and-forth)

4. **Backend Momentum Calculation** (`/api/btc-rsi` endpoint):
   - Added momentum data calculation from 1h candles
   - Calculates: price, change1h, change4h, change24h, atrPercent, volumeRatio, rangePosition
   - Choppy market detection: netMove < 2% && efficiency < 0.3

**Files Modified**:
- `src/web-server.ts`:
  - Removed chart HTML (~20 lines)
  - Added momentum indicators HTML (~30 lines)
  - Added performance summary HTML (~30 lines)
  - Removed chart JS code (~130 lines)
  - Added `updateMomentumIndicators()` function (~60 lines)
  - Added `updatePerformanceSummary()` function (~45 lines)
  - Added momentum calculation to API (~55 lines)

**Build**: ✅ Passes successfully

---

## Previous Task: Leverage Impact Analysis

### Iteration 12 - Leverage Comparison Backtest
**Date**: 2026-01-15
**Status**: ✅ Complete

**Goal**: Analyze whether lower leverage would have protected bots during choppy Jan 14-15 conditions.

**Analysis Tool Created**: `src/backtest-leverage-comparison.ts`
- Recalculates historical trades at different leverage levels
- Applies friction modeling (fees + slippage)
- Compares SL/TP hit rates at each leverage level

**Key Findings**:

#### Trailing Bots (69 trades, Jan 13-15):
| Leverage | Total PnL | Win Rate | SL Hits | TP Hits |
|----------|-----------|----------|---------|---------|
| 3x       | -$73.85   | 33.3%    | 0/69    | 0/69    |
| 5x       | -$123.21  | 33.3%    | 0/69    | 2/69    |
| 10x      | -$247.11  | 33.3%    | 8/69    | 5/69    |
| 20x      | -$496.96  | 33.3%    | 33/69   | 10/69   |

**Insight**: Lower leverage reduced losses by ~75% (3x vs 20x), but win rate stayed same (33%). Fewer stop-outs, but also fewer TP hits.

#### Golden Pocket Bots (5 trades, Jan 13-15):
| Leverage | Total PnL | Win Rate | SL Hits | TP Hits |
|----------|-----------|----------|---------|---------|
| 3x       | +$24.17   | 60.0%    | 0/5     | 0/5     |
| 5x       | +$40.27   | 60.0%    | 0/5     | 3/5     |
| 10x      | +$80.45   | 60.0%    | 0/5     | 3/5     |
| 15x      | +$120.52  | 60.0%    | 2/5     | 3/5     |
| 20x      | +$160.50  | 60.0%    | 2/5     | 3/5     |

**Insight**: GP bots were profitable at ALL leverage levels! Higher leverage = higher returns (linear scaling). 60% win rate survived friction.

#### BTC Bias Bots (67 trades, Jan 13-15):
| Leverage | Total PnL | Win Rate | SL Hits | TP Hits |
|----------|-----------|----------|---------|---------|
| 5x       | -$3,072   | 3.0%     | 0/67    | 0/67    |
| 10x      | -$6,254   | 3.0%     | 0/67    | 0/67    |
| 20x      | -$12,944  | 3.0%     | 6/67    | 0/67    |
| 50x      | -$35,631  | 3.0%     | 45/67   | 2/67    |

**Insight**: BTC Bias bots fundamentally broken (3% win rate). Lower leverage reduces loss magnitude but doesn't fix the strategy.

**Conclusions**:
1. **Lower leverage reduces loss magnitude** but doesn't improve win rate
2. **GP bots are the best performers** - profitable at all leverage levels, 60% win rate
3. **Trailing bots lost money** even at 3x leverage - strategy needs refinement
4. **BTC Bias V1 is NOT VIABLE** - should be disabled
5. **GP short fix** (commit 1ee27c1) hasn't generated data yet - needs time to collect

**Files Created**:
- `src/backtest-leverage-comparison.ts` - Leverage comparison analysis tool
- `data/reports/leverage-comparison-2026-01-15.json` - Full report data

---

## Previous Task: Short Setup Investigation

### Iteration 11 - Why Are There Few Short Setups?
**Date**: 2026-01-15
**Status**: ✅ Diagnosis Complete

**Problem**: Despite bearish market bias all day (BTC bias: short/strong_short), system detected 74 long triggers vs only 14 short triggers.

**Root Causes Identified**:

1. **Impulse Detection Requires Bounce** (`indicators.ts:379-381`):
   - For SHORT setups, price must bounce 1%+ from recent low
   - In a straight dump, this never happens → no short detected

2. **RSI Threshold Asymmetry**:
   - LONGs trigger at RSI < 30 (oversold)
   - SHORTs trigger at RSI > 70 (overbought)
   - In a dump, coins go oversold frequently but rarely reach overbought
   - Jan 15 data: 218 new long setups vs 123 new short setups

3. **HTF Trend Filter** (`backburner-detector.ts:196-200`):
   - Shorts require HTF to be bearish
   - Many coins still show bullish HTF structure during fresh dumps

**Fundamental Issue**: Backburner is **mean reversion**, not momentum:
- LONG = buy oversold dips in uptrends (RSI < 30)
- SHORT = sell overbought bounces in downtrends (RSI > 70)

In a straight dump without bounces, shorts won't trigger.

**Potential Fixes** (not implemented - need user decision):
1. Lower bounce threshold for shorts (1% → 0.5%)
2. Add momentum-based short detection (RSI dropping through 50)
3. Reduce RSI threshold for shorts in bearish markets (70 → 65)
4. Separate "trend following" bot for catching dumps

**Also Completed**:
- Added friction to `golden-pocket-bot.ts` (commit e04266f)

**BUG FOUND & FIXED - GP Shorts Were Broken**:
- `golden-pocket-detector.ts` was hardcoded to ONLY check LONG setups!
- Line 104: `const longKey = this.getSetupKey(symbol, timeframe, 'long')`
- SHORT direction was NEVER checked despite code supporting it
- Fix: Now loops through both `['long', 'short']` directions (commit 1ee27c1)

---

## Previous Task: Fixed BE Backtest & Friction Integration

### Iteration 10 - PaperTradingEngine Friction Integration
**Date**: 2026-01-15
**Status**: ✅ Complete

**Work Completed**:

1. **Added friction modeling to `paper-trading.ts`**:
   - Imported `ExecutionCostsCalculator` from `execution-costs.ts`
   - Added `enableFriction?: boolean` config option
   - Track `entryCosts`, `exitCosts`, `totalCosts` per position
   - Adjusted realized PnL by subtracting friction at close

2. **Enabled friction on Fixed and Fixed BE bots** (web-server.ts):
   - Both `fixedTPBot` and `fixedBreakevenBot` now have `enableFriction: true`
   - Trailing bots already had friction via `paper-trading-trailing.ts`

3. **Created Fixed BE backtest script** (`src/backtest-fixed-be.ts`):
   - Simulates Fixed BE strategy on historical trade data
   - Raw vs Net PnL comparison
   - Ghost trade detection (profitable raw, unprofitable after friction)
   - Breakeven lock analysis

4. **Backtest Results** (Jan 14-15, 2026):
   - 13 unique trades analyzed
   - Raw PnL: -$1.97
   - Net PnL (with friction): -$10.96
   - Friction costs: $8.99 total (~$0.69/trade)
   - 0 breakeven locks triggered (market didn't reach +10% ROI threshold)
   - 0 ghost trades (friction didn't flip any winners to losers)

**Previous Remaining Work** (from Iteration 7):
1. [x] Add execution costs to `paper-trading.ts` ← DONE this iteration
2. [x] Increase `baseSlippageBps` from 2 to 15 ← Was already done (execution-costs.ts line 57)
3. [ ] Add execution costs to `golden-pocket-bot.ts` ← Still TODO
4. [ ] Optional: Implement "Next Tick" execution mode

**Files modified**:
- src/paper-trading.ts (+40 lines - friction integration)
- src/web-server.ts (+2 lines - enabled friction on Fixed bots)
- src/backtest-fixed-be.ts (NEW - 600+ lines)

**Commits**:
- f98cade "feat: Add Fixed BE bot with breakeven lock at +10% ROI"
- d59a4bb "feat: Add friction modeling to PaperTradingEngine and Fixed BE backtest"

---

## Previous: Iteration 7 - Market Friction Audit
**Date**: 2026-01-15
**Status**: Phase 1 Complete → Now superseded by Iteration 10

**Audit Findings**:

1. **Execution Timing**: All bots execute at signal time (same tick). NO "next tick" delay implemented.

2. **Price Logic**: Uses `setup.currentPrice` (candle close). Single price feed - no bid/ask spread.
   - BUT `execution-costs.ts` already applies direction-aware slippage penalties

3. **Fee/Drag Calculations**: Comprehensive `execution-costs.ts` module EXISTS:
   - ✅ Maker/Taker fees (0.02%/0.04%)
   - ✅ Slippage: 15bps base (was 2bps, updated per Gemini recommendation)
   - ✅ Size impact: +1bp per $10k
   - ✅ Funding rate modeling
   - Now used by: `paper-trading-trailing.ts`, `mexc-trailing-simulation.ts`, `paper-trading.ts`
   - Still NOT used by: `golden-pocket-bot.ts`

---

## Previous Sessions

## How This Works

Progress is tracked in THIS FILE, not in LLM context.
When context is rotated (fresh agent), the new agent reads this file.
This is how Ralph maintains continuity across iterations.

## Session History

### Iteration 1 - Dropdown Collapse Fix
**Date**: 2026-01-13
**Completed Criteria**: 1, 2, 3

Fixed the collapsible section toggle issue in web-server.ts:
- **Root cause**: Duplicate onclick handlers on both section header div and toggle span caused event bubbling. Clicking the toggle span fired both handlers, toggling twice and returning to original state.
- **Solution**: Removed onclick attribute from all toggle spans (lines 1964, 2099, 2160, 2210, 2253)
- **Debugging**: Added console logging to toggleSection() function using string concatenation (template literals not supported in inline HTML)
- **Verification**: Build passes successfully with `npm run build`
- **Commit**: aaef84f "ralph: Fix dropdown collapse by removing duplicate onclick handlers"

**Files modified**:
- src/web-server.ts (10 insertions, 5 deletions)

### Iteration 2 - Server Infrastructure Verification
**Date**: 2026-01-13
**Completed Criteria**: 4, 5, 6, 7

Verified server infrastructure and enabled hot reload for development:
- **Criterion 4 (Server startup logging)**: Already implemented at web-server.ts:4270-4278. Server logs startup messages and URL when binding to port 3000.
- **Criterion 5 (Graceful shutdown)**: Already implemented at web-server.ts:4308-4333. Handles SIGINT, SIGTERM, uncaughtException, and unhandledRejection with proper cleanup via `saveAllPositions()`.
- **Criterion 6 (Hot reload)**: Updated package.json to use `tsx watch` for dev:web script (changed from `tsx src/web-server.ts` to `tsx watch src/web-server.ts`). This enables automatic file watching and server restart on changes.
- **Criterion 7 (Build passes)**: Verified `npm run build` completes successfully with no TypeScript errors.

**Files modified**:
- package.json (changed dev:web script to enable watch mode)

**Commits**:
- 69a3430 "ralph: Enable hot reload for dev:web and verify server infrastructure"

**Status**: ALL CRITERIA COMPLETE

### Iteration 3 - RSI Divergence & Cross-Strategy Signals
**Date**: 2026-01-13
**Task**: Improve divergence detection and add cross-strategy signal matching

Implemented three major enhancements:

1. **Relaxed swing detection threshold**:
   - Changed swingLookback from 5 to 3 bars in detectDivergence function
   - This finds more swing points for divergence comparison
   - Files: src/indicators.ts, src/backburner-detector.ts

2. **Added divergence detection to Golden Pocket detector**:
   - Imported detectDivergence and calculateRSI to GP detector
   - Added divergence detection in both detectNewSetup() and updateExistingSetup()
   - Only includes divergences that align with setup direction (bullish for long, bearish for short)
   - Added Div column to GP table in web-server.ts
   - File: src/golden-pocket-detector.ts, src/web-server.ts

3. **Added cross-strategy signal indicators (X-Sig column)**:
   - Added getCrossStrategySignal() function to detect when same symbol has setups in both BB and GP
   - Shows 🎯✓ (green) when GP aligns with BB signal
   - Shows 🎯✗ (red) when GP conflicts with BB signal
   - Shows 🎯⚠ (yellow) when mixed signals exist
   - GP tab shows 🔥✓/🔥✗/🔥⚠ for BB signals
   - File: src/web-server.ts

**Files modified**:
- src/indicators.ts (1 line - default swingLookback changed)
- src/backburner-detector.ts (1 line - explicit swingLookback=3)
- src/golden-pocket-detector.ts (+50 lines - divergence detection)
- src/web-server.ts (+70 lines - Div column for GP, X-Sig columns for both tables)

**Commit**: 87cc0cd "feat: Add RSI divergence detection to GP + cross-strategy signals"

### Iteration 4 - Backtest Analysis & Timeframe Filtering
**Date**: 2026-01-13
**Task**: Analyze trade data and implement filters to improve bot performance

**Problem Identified**: User noticed Backburner triggers seemed flawed, triggering contrarian setups against BTC's movements.

**Backtest Analysis** (312 closed trades across 4 days):
| Timeframe | Direction | Trades | Win Rate | PnL |
|-----------|-----------|--------|----------|-----|
| 1h LONG | 27 | **0%** | -$1,058 |
| 1h SHORT | 68 | **13%** | -$1,291 |
| 15m LONG | 69 | **57%** | +$6 |
| 15m SHORT | 57 | 47% | -$490 |
| 5m LONG | 66 | 38% | -$559 |
| 5m SHORT | 25 | 32% | -$410 |

**Key Findings**:
1. **1h timeframe is catastrophic** - 0% win rate for longs, 13% for shorts, 100% stopped out
2. **15m LONG is the only profitable combo** - 57% win rate with actual TP hits
3. **No TP hits on 1h** - all 95 trades exited via stop loss
4. **5m trades suffer from contrarian entries** against BTC trend

**Solution Implemented**:
Added `shouldTradeSetup()` filter function at web-server.ts:38-62:
1. **Disable 1h timeframe entirely** - Only allow `['5m', '15m']`
2. **Add BTC trend filter for 5m**:
   - Skip long setups when BTC is bearish (short/strong_short)
   - Skip short setups when BTC is bullish (long/strong_long)
3. Applied filter to both `handleNewSetup()` and `handleSetupUpdated()` functions
4. Existing positions still get updated (so they can close properly)

**Files modified**:
- src/web-server.ts (~40 lines - filter function + handler modifications)

**Build**: Passes successfully

### Iteration 5 - UI Improvements: Hyperlinks, Settings, Persistence
**Date**: 2026-01-13
**Task**: Multiple UI improvements requested by user

**Changes Implemented**:

1. **Hyperlinks in Backburner tab**:
   - Added `getMexcUrl()` function to Backburner table (renderSetupsTable)
   - Symbol column now links to MEXC (same as GP tab already had)

2. **Changed default link destination to Trading Bots**:
   - Default URL format: `https://www.mexc.com/futures/trading-bots/grid/SYMBOL_USDT`
   - Previously was: `https://www.mexc.com/futures/SYMBOL_USDT`
   - Created unified `getMexcUrl()` function that respects settings

3. **Settings modal**:
   - Added ⚙️ button in header next to ? (guide) button
   - Settings modal with radio buttons to toggle link destination:
     - 🤖 Trading Bots (default) - opens grid bot page
     - 📊 Futures Trading - opens futures trading page
   - Also shows saved list count and clear button

4. **Persisted saved lists with localStorage**:
   - `savedList` Set now persists to `backburner_savedList` in localStorage
   - `appSettings` object persists to `backburner_settings` in localStorage
   - `loadPersistedData()` restores both on page load
   - `persistSavedList()` called when items added/removed
   - `persistSettings()` called when settings changed
   - Lists survive page refreshes, rebuilds, and server restarts

**Files modified**:
- src/web-server.ts:
  - +50 lines for localStorage persistence functions
  - +45 lines for settings modal HTML
  - +50 lines for settings JS functions (openSettings, closeSettings, updateLinkSetting, clearSavedList)
  - Modified renderSetupsTable, renderGoldenPocketTable, renderSavedListTable to use getMexcUrl()

**Build**: Passes successfully

### Iteration 6 - TCG-Compliant Backburner Implementation
**Date**: 2026-01-13
**Task**: Implement proper TCG methodology based on ChatGPT feedback

**Problem Identified**: User shared ChatGPT analysis revealing 5 major deviations from proper TCG Backburner methodology:

1. **Missing timeframe hierarchy** - 5m signals should mark hourly higher lows; 1h signals should mark daily higher lows
2. **ROI-based stops** - Using fixed 20% ROI stops instead of structure-based stops below pullback low
3. **"Is below" vs "crossed"** - Triggering on RSI being below 30, not on the cross event
4. **Fixed % trailing** - Using fixed percentage trailing instead of trailing under last higher low
5. **No position building** - Missing tiered entry logic (Entry 1 @ RSI<30, Entry 2 @ RSI<20)

**Solutions Implemented**:

1. **Timeframe hierarchy enforcement** (Fix 1):
   - Added `detectHTFTrend()` function to indicators.ts
   - Checks if higher timeframe supports setup direction
   - For longs: HTF must be bullish; for shorts: HTF must be bearish
   - Added `htfConfirmed` field to BackburnerSetup type

2. **Structure-based stops** (Fix 2):
   - Added `findPullbackLow()` and `findBounceHigh()` functions to indicators.ts
   - Finds actual swing structure during pullback phase
   - Added `calculateStructureStop()` to set stop below pullback low (longs) or above bounce high (shorts)
   - Updated paper-trading.ts and paper-trading-trailing.ts to use `structureStopPrice` with ROI fallback

3. **RSI transition detection** (Fix 3):
   - Added `detectRSICross()` function to indicators.ts
   - Entry triggers on RSI crossing below 30 (long) or above 70 (short)
   - Tracks `previousRSI`, `rsiCrossedThreshold`, and `rsiCrossTime` in setup

4. **Technical trailing data** (Fix 4):
   - Added `findRecentSwingLows()` and `findRecentSwingHighs()` to indicators.ts
   - Populates `recentSwingLows` and `recentSwingHighs` arrays in setup
   - Paper trading can use these for structure-based trailing

5. **Position building logic** (Fix 5):
   - Added `detectRSITrend()` function to identify if RSI is still dropping/rising
   - Added `canAddPosition` (true if RSI still worsening) and `positionTier` (1 or 2) fields
   - Tier 1 entry @ RSI<30, Tier 2 only available if RSI reaches <20 while still dropping

**Files modified**:
- src/types.ts (+20 lines - TCG-compliant fields in BackburnerSetup interface)
- src/indicators.ts (+250 lines - 8 new helper functions)
- src/backburner-detector.ts (~100 lines rewritten - detectNewSetup with all 5 fixes)
- src/paper-trading.ts (~20 lines - structureStopPrice support in calculateTargets)
- src/paper-trading-trailing.ts (~20 lines - structureStopPrice support in calculateInitialStopLoss)

**Build**: Passes successfully

### Iteration 7 - Comprehensive Data Collection System
**Date**: 2026-01-13
**Task**: Improve data collection to enable proper backtesting and historical analysis

**Problem Identified**: Only 1 day of historical data (Jan 9) available. Several data collection features were broken:
- Missing directories: daily/, positions/, crashes/, hourly/
- BTC Bias bots not logging trades
- No hourly snapshots for portfolio state tracking
- No data compression for old market snapshots

**Solutions Implemented**:

1. **Created missing directories**:
   - Added data/daily/, data/positions/, data/crashes/, data/hourly/
   - Updated ensureDirectories() to include HOURLY_DIR

2. **Added GenericTradeEvent type**:
   - New universal trade event format for any bot type
   - Supports open/close/update events with full position details
   - Includes metadata field for bot-specific context
   - Stored in trades/{date}-all.json

3. **Added HourlySnapshot system**:
   - New hourly callback system to capture portfolio state every hour
   - Tracks all bot balances, open positions, unrealized P&L
   - Includes BTC price, bias, RSI data
   - Stored in hourly/{date}.json

4. **Connected BTC Bias bots to persistence**:
   - Added logGenericTrade() calls in openPosition() and closePosition()
   - Logs entry/exit with full context (bias, stop type, callback %, etc.)
   - All 8 bot variants now log trades

5. **Added data compression utilities**:
   - compressMarketData(date): Compresses minute-level data to hourly averages
   - compressOldMarketData(daysToKeep): Auto-compress data older than N days
   - getDataStats(): Returns storage statistics by category
   - Original data preserved as {date}-full.json backup

6. **Registered hourly snapshot callback in web-server**:
   - Captures trailing bots (4) and BTC Bias bots (8) state hourly
   - Includes active setup counts and BTC market conditions

**Files modified**:
- src/data-persistence.ts (+200 lines):
  - GenericTradeEvent and HourlySnapshot interfaces
  - logGenericTrade() method
  - checkHourlySnapshot() and saveHourlySnapshot() methods
  - compressMarketData(), compressOldMarketData(), getDataStats() utilities
  - Updated loadTodaysData() and checkDateRollover() for new data types

- src/btc-bias-bot.ts (+40 lines):
  - Import getDataPersistence
  - logGenericTrade() calls in openPosition() and closePosition()

- src/web-server.ts (+100 lines):
  - Added lastBtcPrice and lastBtcRsiData globals
  - Log BTC Bias bot configurations
  - Registered hourly snapshot callback with full bot state collection

**Data Directory Structure** (after changes):
```
data/
├── signals/           # Signal lifecycle events
├── trades/            # Trade open/close events (legacy format)
│   └── {date}-all.json  # GenericTradeEvent format (all bots)
├── market/            # BTC price/RSI snapshots (every 60s)
├── configs/           # Bot configuration snapshots
├── daily/             # End-of-day summaries (NEW - working)
├── hourly/            # Hourly portfolio snapshots (NEW)
├── positions/         # Position persistence (NEW - working)
└── crashes/           # Error logs (NEW - working)
```

**Note**: Build not tested (node_modules not in worktree). Changes will take effect on next server restart.

### Iteration 8 - Universal BTC Bias Filter & Bug Fixes
**Date**: 2026-01-14
**Task**: Fix trading filter bypasses, extend BTC bias filter to all timeframes

**Problem Identified**: Analysis of Jan 13 data revealed:
1. 69 trades on 1h timeframe despite `ALLOWED_TIMEFRAMES` excluding 1h
2. 88 short trades on a bullish day (BTC +4.7%) causing -$1,131.86 loss
3. 1h timeframe alone lost -$1,427 (more than total system loss)
4. MEXC sim bots and Golden Pocket bots were bypassing the filter entirely
5. `detector is not defined` crash in hourlySnapshotCallback

**Root Causes Found**:
1. MEXC sim bots called `openPosition(setup)` without checking `passesFilter`
2. Golden Pocket bots called `openPosition(setup)` without checking `passesFilter`
3. BTC bias filter only applied to 5m timeframe, not 15m
4. `detector` variable referenced in hourly callback but was scoped inside startServer()

**Solutions Implemented**:

1. **Fixed detector reference error**:
   - Changed `detector.getAllSetups()` to `screener.getAllSetups()` (line 4761)
   - `screener` is module-scoped and accessible in callback

2. **Applied filter to MEXC sim bots** (handleNewSetup):
   - Wrapped MEXC bot loop in `if (passesFilter) { ... }` block

3. **Applied filter to Golden Pocket bots** (handleNewSetup & handleSetupUpdated):
   - Now only opens GP positions if `passesFilter` is true
   - Existing positions still get updated (for proper exits)
   - Added logging for skipped GP setups

4. **Extended BTC bias filter to ALL timeframes**:
   - Removed the `if (setup.timeframe === '5m')` condition
   - Now filters ALL setups based on BTC bias alignment
   - Long setups skipped when BTC bearish
   - Short setups skipped when BTC bullish

5. **Applied 1h filter to trendOverride/trendFlip bots**:
   - Added `ALLOWED_TIMEFRAMES.includes(setup.timeframe)` check
   - These bots are intentionally contrarian but still skip 1h

6. **Fixed TypeScript type errors**:
   - Cast `unrealizedROI` access with `(p as any).unrealizedROI`
   - Cast `btcRsi` object as `Record<string, number>`

**Files modified**:
- src/web-server.ts:
  - Line 67-82: Removed 5m-only condition from BTC bias filter
  - Line 411: Added ALLOWED_TIMEFRAMES check for trend bots
  - Lines 444-452: Wrapped MEXC bots in passesFilter check
  - Lines 454-468: Wrapped GP bots in passesFilter check + logging
  - Lines 592-612: Added passesFilter check for GP bots in handleSetupUpdated
  - Line 4742: Fixed unrealizedROI type cast
  - Line 4761: Fixed detector → screener reference
  - Line 4785-4791: Fixed btcRsi type cast

**Expected Impact**:
- No more 1h trades from any bot
- No more contrarian trades against BTC bias (on 5m AND 15m)
- Hourly snapshots will work without crashing
- Render deployment should work with Docker runtime

**Build**: ✅ Passes successfully

### Iteration 9 - MEXC API Failures on Render
**Date**: 2026-01-14
**Task**: Investigate and fix why Render deployment shows 0 symbols

**Problem**: Dashboard deploys successfully to Render but MEXC API calls fail:
```
Failed to fetch page 1 after retries
Failed to fetch page 2 after retries
Failed to fetch page 3 after retries
Failed to fetch page 4 after retries
[STATE] Monitoring 0S + 0F symbols | 0 active | 0 played out
```

**Root Cause Identified**: CoinGecko API IP blocking
- CoinGecko blocks requests from cloud provider IPs (Render, AWS, etc.)
- This is documented behavior to prevent abuse from datacenter ASNs
- All 4 pages failed → 0 coins cached → `requireMarketCap` filtered all symbols

**Solution Implemented**:
1. Added `isCoinGeckoAvailable()` to track API availability
2. If all 4 pages fail, mark CoinGecko as blocked (not just rate-limited)
3. Modified `isEligibleSymbol()` to skip market cap check when CoinGecko unavailable
4. Falls back to volume-only filtering on cloud deployments

**Files modified**:
- src/coingecko-api.ts (+48 lines - availability tracking, failure detection)
- src/screener.ts (+2 lines - import and condition check)

**Commits**:
- 3294454 "fix: Handle CoinGecko IP blocking on cloud providers"
- e105d1a "ralph: Update progress for Iteration 9 - CoinGecko fix"
- e5f2085 "feat: Add CoinLore as fallback API for market cap data"

**CoinLore Fallback Added**:
- CoinLore API: No API key required, no IP blocking
- Fetches top 1000 coins (10 pages × 100 coins)
- Unified MarketData interface for both APIs
- Strategy: CoinGecko → CoinLore → volume-only filtering

**Status**: Ready to push to trigger Render rebuild

