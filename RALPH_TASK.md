---
task: HTF-Based Impulse Detection + 15m Trading
test_command: "npm run build"
---

# Task: HTF-Based Impulse Detection + Enable 15m Trading

**Priority**: High
**Status**: Complete

**Context**: BackBurner detector required a 5%+ impulse on the entry timeframe (5m), but TCG methodology says the impulse belongs on the HIGHER timeframe. A BackBurner is a cross-timeframe divergence: HTF trending one way, LTF temporarily RSI-extreme the other way. Also, 15m was disabled for trading despite being a core TCG timeframe pairing (15m entry → 4h trend).

---

## Success Criteria

1. [x] **Move impulse detection to HTF candles**
   - Primary: detect impulse on HTF candles (1h for 5m, 4h for 15m)
   - Fallback: LTF with per-timeframe thresholds when no HTF data
   - Added `TIMEFRAME_IMPULSE_MIN` config for fallback thresholds

2. [x] **Fix timeframe pairings**
   - 5m entry → 1h HTF (was correct)
   - 15m entry → 4h HTF (was incorrectly mapped to 1h)
   - 1h/4h → no HTF pairing (dashboard-only)

3. [x] **Adapt index-based references for HTF impulse**
   - Added `findCandleIndexByTime()` helper for timestamp mapping
   - All LTF operations use `ltfImpulseEndIndex` (mapped from HTF)
   - impulseCandles use `sourceCandles` (HTF or LTF as appropriate)
   - counterMoveCandles use LTF candles from impulse end

4. [x] **Add impulseSource tracking**
   - New `impulseSource: 'htf' | 'ltf'` field on BackburnerSetup
   - Tracks whether impulse came from HTF or LTF fallback

5. [x] **Enable 15m for trading**
   - Added '15m' to ALLOWED_TIMEFRAMES in web-server.ts

6. [x] **Remove overly strict RSI cross filter**
   - RSI cross filter blocked 75% of valid entries
   - Detector already gates on RSI < 30 + first-oversold check

7. [x] **Build passes**
   - `npm run build` succeeds with no TypeScript errors

---

## Technical Notes

### TCG BackBurner Methodology
- HTF provides trend/impulse (directional context)
- LTF reaches RSI extreme (oversold/overbought) = entry signal
- Cross-timeframe divergence: HTF bullish + LTF oversold = LONG
- Pairings: 5m→1h, 15m→4h (user-confirmed)

### Files Modified
- `src/backburner-detector.ts` — HTF-first impulse, timestamp mapping, impulseSource tracking
- `src/config.ts` — Added TIMEFRAME_IMPULSE_MIN fallback thresholds
- `src/types.ts` — Added impulseSource field to BackburnerSetup
- `src/screener.ts` — Fixed HTF mapping (15m→4h instead of 15m→1h)
- `src/web-server.ts` — Enabled 15m trading, removed RSI cross filter

---

## Previous Task (Complete)
- Futures-Only Asset Discovery & Commodity Screening
- Commits: 0e95826, d669874
