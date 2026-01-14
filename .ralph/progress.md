# Progress Log

> Updated by the agent after significant work.

## Summary

- Iterations completed: 6
- Current status: TCG-compliant Backburner implementation (5 major fixes)

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

**Status**: Investigation in progress...

