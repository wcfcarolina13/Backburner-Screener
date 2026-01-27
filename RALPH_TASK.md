---
task: Exchange-Side Trailing Stops + GUI Position Adoption
test_command: "npm run build"
---

# Task: Exchange-Side Trailing Stops + GUI Position Adoption

**Priority**: High
**Status**: Complete

**Context**: Paper bots had dynamic in-memory trailing stops while MEXC had static plan orders. This was the #1 cause of paper vs live P&L divergence. Additionally, manually-opened MEXC positions had no SL/trailing stop management.

---

## Success Criteria

1. [x] **MexcTrailingManager created**
   - Server-side trailing stop manager using MEXC plan orders as source of truth
   - ROE-based trail activation with configurable trigger/step/SL percentages
   - Dynamically ratchets SL via `modifyStopOrder()`

2. [x] **Trailing manager integrated into web-server**
   - Price updates feed trailing manager
   - Auto-tracking starts after MEXC execution
   - External close detection in MEXC sync loop
   - Startup reconciliation: Turso restore → MEXC verify → adopt untracked → remove stale

3. [x] **Position adoption endpoint**
   - `POST /api/mexc/adopt-position` creates SL + starts tracking
   - Enriched `/api/mexc/positions` with managed status

4. [x] **Dashboard GUI for position management**
   - Status column shows managed/unmanaged state
   - "Manage" button for untracked positions
   - `adoptPosition()` function with confirm dialog

5. [x] **Turso persistence for server settings + trailing positions**
   - `server_settings` and `trailing_positions` tables
   - Survives Render ephemeral filesystem restarts

6. [x] **SL sanity check on startup**
   - Tightens any SL wider than `initialStopPct` from entry
   - Only for positions where trail hasn't already activated

7. [x] **Build passes**
   - `npm run build` succeeds with no TypeScript errors

---

## Previous Task (Complete)
- Persistent Live Trade Logging + Experimental Bot State Recovery
- All 6 criteria satisfied

## Previous Task (Complete)
- HTF-Based Impulse Detection + Enable 15m Trading
- All 7 criteria satisfied
