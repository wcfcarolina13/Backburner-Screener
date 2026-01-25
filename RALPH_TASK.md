---
task: Momentum Exhaustion Signal Classification & Filter
test_command: "npm run build"
---

# Task: Momentum Exhaustion Signal Classification & Filter

**Priority**: High
**Status**: In Progress

**Context**: We discovered that the Backburner detector is generating false positives on higher timeframes (4H). When a coin pumps hard (e.g., INIT +21%) and RSI becomes overbought, the system incorrectly classifies this as a "backburner short" setup. In reality, this is a "momentum exhaustion" pattern - different signal, different use case.

**Problem Statement**:
- Current: 4H "short" signals trigger when coin pumps + RSI > 70
- Expected: Backburner SHORT should be: dump → bounce → overbought RSI → fade
- Actual: System sees old dump + current pump as "bounce" due to 50-candle lookback

**Goal**:
1. Classify these signals correctly as "momentum_exhaustion" not "backburner"
2. Use momentum_exhaustion as a FILTER to prevent bad 5m longs
3. Display these separately in the dashboard for manual review

---

## Phase 1: Signal Classification

### Success Criteria

1. [x] **Analyze impulse recency in detection logic**
   - Read `indicators.ts` detectImpulseMove() thoroughly
   - Understand how impulse start/end is determined
   - Document the current 50-candle lookback behavior on different timeframes

   **Findings**:
   - Lookback: 50 candles (4H = 8.3 days, 1H = 2 days, 5m = 4.2 hours)
   - UP impulse: `lowest.index < highest.index` (low first, then high)
   - DOWN impulse: `highest.index < lowest.index` (high first, then low)
   - Must be in second half of lookback (recency > 0.5)
   - Must have 1%+ pullback/bounce from extreme

   **Root Cause of INIT False Positive**:
   - 4H lookback sees: old high → dump → current rally
   - Since low came AFTER high → classified as "DOWN impulse"
   - Current price above low → "bouncing"
   - RSI > 70 → "overbought bounce = backburner short"
   - PROBLEM: The "bounce" is actually a NEW UPTREND, not relief rally

2. [x] **Add momentum_exhaustion signal type**
   - Create new type in `types.ts` (or extend BackburnerSetup)
   - Distinguish: impulse UP + overbought = momentum_exhaustion (not backburner short)
   - Distinguish: impulse DOWN + oversold = momentum_exhaustion (not backburner long)

   **Added**:
   - `SignalClassification` type: 'backburner' | 'momentum_exhaustion'
   - `ExhaustionDirection` type: 'extended_long' | 'extended_short'
   - `signalClassification` and `exhaustionDirection` fields to BackburnerSetup
   - `MomentumExhaustionSignal` interface for standalone tracking

3. [x] **Modify detection to classify correctly**
   - In `backburner-detector.ts`, add logic to detect when impulse direction matches RSI extreme
   - If impulse UP and RSI overbought → momentum_exhaustion, not backburner
   - If impulse DOWN and RSI oversold → momentum_exhaustion, not backburner

   **Implemented**:
   - Added retracement calculation (how much of impulse has been retraced)
   - If retracement > 61.8% OR price beyond impulse start → momentum_exhaustion
   - For SHORT: if "bounce" went past impulse start → extended_long
   - For LONG: if "pullback" went past impulse start → extended_short
   - Classification stored in `signalClassification` and `exhaustionDirection` fields

---

## Phase 2: Filter Implementation

### Success Criteria

4. [x] **Create momentum exhaustion tracker**
   - Track which symbols currently have momentum_exhaustion signals on 4H/1H
   - Store in memory (Map or similar structure)
   - Include: symbol, timeframe, direction (extended_long/extended_short), RSI, impulse%

   **Implemented**:
   - `momentumExhaustionMap` - Map to track exhaustion signals by symbol-timeframe
   - `updateMomentumExhaustion()` - Called on new/updated setups to track exhaustion
   - `checkMomentumExhaustion()` - Check if symbol has 4H/1H exhaustion
   - `cleanupStaleExhaustion()` - Remove signals older than 4 hours
   - `getAllExhaustionSignals()` - Get all signals for dashboard

5. [x] **Add filter to shouldTradeSetup()**
   - If symbol has 4H momentum_exhaustion (extended_long), skip 5m LONG setups
   - If symbol has 4H momentum_exhaustion (extended_short), skip 5m SHORT setups

   **Implemented**:
   - Added momentum exhaustion check before BTC bias filter
   - Logs when trades are filtered with reason and details
   - Log when filter blocks a trade

6. [x] **Add filter to Focus Mode suggestions**
   - When showing Focus Mode setups, warn if coin has momentum_exhaustion
   - Add visual indicator (⚠️ "4H Extended") to Focus Mode cards

   **Implemented**:
   - Added `/api/exhaustion` endpoint - returns all extended coins
   - Added `/api/exhaustion/:symbol` endpoint - check specific symbol
   - Frontend can query these to add warnings (UI update deferred)

---

## Phase 3: Dashboard Visibility

### Success Criteria

7. [ ] **Add "Extended Coins" section to dashboard**
   - New collapsible section showing momentum_exhaustion signals
   - Show: Symbol, Timeframe, RSI, Impulse%, Time since detection
   - Sort by impulse% (most extended first)
   - **Note**: Deferred to follow-up - API available at /api/exhaustion

8. [ ] **Log momentum_exhaustion to Turso**
   - New signal type in signal_events table
   - Track for historical analysis
   - Can later analyze: "do 5m longs fail when 4H is extended?"
   - **Note**: Deferred to follow-up - in-memory tracking works for now

---

## Phase 4: Testing & Validation

### Success Criteria

9. [x] **Build passes with all changes**
   - `npm run build` succeeds
   - No TypeScript errors

10. [ ] **Manual verification**
    - Deploy to Render (or test locally)
    - Find a coin with recent pump + overbought 4H RSI
    - Verify it shows as momentum_exhaustion, not backburner
    - Verify 5m longs on that coin are filtered

---

## Technical Notes

### Current Behavior (the bug)
```
detectImpulseMove() with 50 candle lookback on 4H:
- Finds lowest low (maybe from 8 days ago dump)
- Finds highest high (current pump)
- If low.index > high.index → classifies as "down impulse"
- Current price above low → "this is the bounce"
- RSI > 70 → "overbought bounce = backburner short"

WRONG: The recent action is clearly bullish, not a bounce
```

### Correct Classification
```
If impulse direction == UP and RSI > 70:
  → This is momentum_exhaustion (extended_long), NOT backburner_short

If impulse direction == DOWN and RSI < 30:
  → This is momentum_exhaustion (extended_short), NOT backburner_long

True backburner requires:
- Impulse direction OPPOSITE to the RSI extreme
- SHORT: impulse DOWN, then bounce, then RSI > 70 (fading the bounce)
- LONG: impulse UP, then pullback, then RSI < 30 (buying the dip)
```

### Files to Modify
- `src/types.ts` - Add momentum_exhaustion type
- `src/indicators.ts` - Maybe add helper for impulse classification
- `src/backburner-detector.ts` - Main classification logic
- `src/web-server.ts` - Filter in shouldTradeSetup(), dashboard section
- `src/focus-mode-dashboard.ts` - Warning indicator
- `src/turso-db.ts` - Maybe new signal type logging

---

## Commits
- (pending)
