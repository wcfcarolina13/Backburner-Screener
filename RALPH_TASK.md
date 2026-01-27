---
task: Persistent Live Trade Logging + Experimental Bot State Recovery
test_command: "npm run build"
---

# Task: Persistent Live Trade Logging + Experimental Bot State Recovery

**Priority**: High
**Status**: Complete

**Context**: After the first day of live trading via the paper-to-MEXC execution bridge, two critical gaps were identified:
1. No way to distinguish paper vs live trades in the database
2. Experimental bot state (trailing stops, positions) is lost on server restart — critical because paper bot trailing stops drive MEXC live position exits

---

## Success Criteria

1. [x] **Add `execution_mode` column to Turso**
   - New column in `trade_events` table via ALTER TABLE migration
   - Values: 'paper', 'live', 'shadow', 'dry_run'

2. [x] **Thread `executionMode` through data-persistence layer**
   - Added to `TradeEvent` interface
   - Passed through `logTradeOpen()` and `logTradeClose()` methods
   - Written to Turso via `insertTradeEvent()`

3. [x] **Pass `executionMode` at all call sites**
   - Added `getExecutionModeForBot()` helper: checks if bot is in `mexcSelectedBots` + current execution mode
   - Updated all 6 logTradeOpen/logTradeClose call sites in web-server.ts
   - Updated internal calls in experimental-shadow-bots.ts
   - Added `setExecutionMode()` method to ExperimentalShadowBot
   - Syncs mode on startup, mode change, and bot selection change

4. [x] **Add saveState/restoreState to ExperimentalShadowBot**
   - `saveState()` serializes: balance, peakBalance, open positions (Map entries), closed positions
   - `restoreState()` rebuilds positions Map from serialized data
   - Preserves trailing stop state: stopLoss, trailActivated, highestPnlPercent

5. [x] **Integrate experimental bot persistence into save/restore cycle**
   - Save: Added to `saveAllBotStates()` — runs every 5 minutes + on shutdown
   - Restore: Added after `loadServerSettings()` on startup — before main loop
   - Uses `dataPersistence.savePositions()` / `loadPositions()` for disk + Turso storage

6. [x] **Build passes**
   - `npm run build` succeeds with no TypeScript errors

---

## Technical Notes

### Execution Mode Logic
- `getExecutionModeForBot(botId)`:
  - If bot in `mexcSelectedBots` AND mode is 'live' → 'live'
  - If bot in `mexcSelectedBots` AND mode is 'shadow' → 'shadow'
  - Otherwise → 'paper'

### Files Modified
- `src/turso-db.ts` — Added `execution_mode TEXT` to schema migration + INSERT
- `src/data-persistence.ts` — Added `executionMode` to TradeEvent, logTradeOpen, logTradeClose
- `src/experimental-shadow-bots.ts` — Added `executionMode`, `setExecutionMode()`, `saveState()`, `restoreState()`
- `src/web-server.ts` — Added `getExecutionModeForBot()`, updated all call sites, save/restore integration

### Deployment Note
The 7 currently-open MEXC positions will maintain their trailing stops across restarts once this update is deployed. The save happens every 5 minutes, so positions opened between saves and a crash would be lost (acceptable risk vs. real-time persistence complexity).

---

## Previous Task (Complete)
- HTF-Based Impulse Detection + Enable 15m Trading
- All 7 criteria satisfied
