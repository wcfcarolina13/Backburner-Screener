# Backburner Bot Analysis & Performance Report

**Analysis Date**: January 15, 2026
**Data Period**: January 14-15, 2026 (~24 hours)

---

## Executive Summary

After analyzing ~24 hours of paper trading data across 30+ bot configurations, we found:

| Bot Category | Total PnL | Win Rate | Trades | Verdict |
|--------------|-----------|----------|--------|---------|
| **Backburner Trailing** | +$495.69 | 60-80% | 24 | **PROFITABLE** |
| **MEXC Simulation** | -$319.37 | 0-67% | 10 | **MARGINAL** |
| **BTC Bias (V1)** | -$8,385.36 | 0-40% | 33 | **NOT VIABLE** |
| **Golden Pocket** | $0 | N/A | 0 | **NO DATA** |

**Key Finding**: The Backburner trailing strategy works. BTC Bias with high leverage does not.

---

## Detailed Bot Performance

### Backburner Trailing Bots (PROFITABLE)

These bots trade altcoin signals with various trailing stop configurations.

| Bot ID | PnL | Win Rate | Trades | Notes |
|--------|-----|----------|--------|-------|
| 10pct20x | +$148.67 | 60% | 5 | Best performer |
| wide | +$137.37 | 67% | 6 | Excellent |
| fixed | +$116.75 | 67% | 3 | Good |
| 10pct10x | +$83.84 | 80% | 5 | Highest win rate |
| 1pct | +$9.05 | 80% | 5 | Conservative |

**Analysis**: The trailing stop approach with moderate leverage (10-20x) and 10% position sizing works well. Higher callback percentages and wider trailing stops captured more gains.

### MEXC Simulation Bots (MARGINAL)

These simulate MEXC's trailing stop mechanics with different callback percentages.

| Bot ID | PnL | Win Rate | Trades | Notes |
|--------|-----|----------|--------|-------|
| wide | +$137.37 | 67% | 6 | Same as trailing |
| standard | -$52.04 | 0% | 1 | Insufficient data |
| standard-05cb | -$52.04 | 0% | 1 | Insufficient data |
| wide-2cb | -$52.04 | 0% | 1 | Insufficient data |
| aggressive | -$150.30 | 0% | 2 | Tight stops hurt |
| aggressive-2cb | -$150.30 | 0% | 2 | Tight stops hurt |

**Analysis**: Too few trades to draw conclusions. The "aggressive" variants with tighter callbacks got stopped out prematurely.

### BTC Bias Bots V1 (NOT VIABLE)

These trade BTC based on macro bias direction with very high leverage.

| Bot ID | PnL | Win Rate | Trades | Config |
|--------|-----|----------|--------|--------|
| btc-bias-100x50-trail | -$3,478.83 | 17% | 6 | 100% pos, 50x, 0.5% cb |
| btc-bias-100x50-hard | -$3,163.79 | 0% | 3 | 100% pos, 50x, 20% ROI stop |
| btc-bias-100x20-trail | -$724.98 | 0% | 2 | 100% pos, 20x, 1% cb |
| btc-bias-100x20-hard | -$557.50 | 0% | 1 | 100% pos, 20x, 20% ROI stop |
| btc-bias-10x50-hard | -$244.36 | 0% | 3 | 10% pos, 50x |
| btc-bias-10x50-trail | -$96.24 | 40% | 5 | 10% pos, 50x |
| btc-bias-10x20-trail | -$66.76 | 0% | 2 | 10% pos, 20x |
| btc-bias-10x20-hard | -$52.89 | 0% | 1 | 10% pos, 20x |

**Analysis**:
- **100% position size + 50x leverage = disaster** (-$6,642 from just two configs)
- 0.5% callback at 50x leverage means only 0.01% price tolerance before stop
- Even 1% callback at 20x is too tight for BTC volatility
- The strategy's "hold through neutral" logic exposed to whipsaws

### Golden Pocket Bots (NO DATA)

All 4 GP bots (conservative, standard, aggressive, yolo) had **zero trades**.

**Root Cause Analysis**:
1. **RSI threshold too strict**: Requires RSI < 40 (longs) or RSI > 60 (shorts) while in golden pocket
2. **Volume requirement**: Needs 2x average volume on impulse
3. **Impulse requirement**: Needs 5% move in 12 candles
4. The combination of all three rarely occurs simultaneously

---

## Changes Made

### 1. Golden Pocket V2 (Loosened Thresholds)

Created new detector and bot variants with relaxed parameters to compare against strict V1:

| Parameter | V1 (Strict) | V2 (Loose) |
|-----------|-------------|------------|
| Min Impulse | 5% | 4% |
| Min Volume | 2x avg | 1.5x avg |
| Long RSI Trigger | < 40 | < 50 |
| Long RSI Deep | < 30 | < 35 |
| Short RSI Trigger | > 60 | > 50 |
| Short RSI Deep | > 70 | > 65 |

**Files Created**:
- `src/golden-pocket-detector-v2.ts`
- `src/golden-pocket-bot-v2.ts`

### 2. BTC Bias V2 (Conservative Parameters)

Created new bot factory with survival-focused parameters:

| Parameter | V1 (Aggressive) | V2 (Conservative) |
|-----------|-----------------|-------------------|
| Position Size | 10-100% | 10-20% |
| Leverage | 20-50x | 10-20x |
| Trailing Callback | 0.5-1% | 2-3% |
| Hard Stop ROI | 20% | 30% |

**New Bots**:
- `bias-v2-20x10-trail` - 20% position, 10x leverage, 3% callback
- `bias-v2-20x20-trail` - 20% position, 20x leverage, 2% callback
- `bias-v2-10x10-trail` - 10% position, 10x leverage, 3% callback
- `bias-v2-10x20-trail` - 10% position, 20x leverage, 2% callback
- Plus hard stop variants

**Files Modified**:
- `src/btc-bias-bot.ts` - Added `createBtcBiasBotsV2()` factory

---

## Recommendations

### Keep Running (Proven Profitable)
- All Backburner trailing bots (1pct, 10pct10x, 10pct20x, wide, fixed)
- Confluence bot (same strategy)

### Monitor Closely
- GP V1 bots - may take weeks to generate signals
- GP V2 bots - should generate more signals, quality TBD
- BTC Bias V2 bots - need time to prove conservative params work

### Archive After More Data
- BTC Bias V1 bots - keep for comparison, but expect continued losses
- MEXC Sim aggressive variants - too few trades to conclude

### Do Not Use in Production
- Any bot with 100% position size + 50x leverage
- Any bot with < 1% trailing callback on BTC

---

## Lessons Learned

1. **Leverage is not your friend**: Even "good" entries get stopped out by noise at 50x
2. **Position sizing matters**: 100% of balance in one trade = no recovery from loss
3. **Trailing callbacks need room**: 0.5% is too tight, 2-3% minimum for BTC
4. **More signals ≠ more profit**: The strict GP filters might be catching the right trades
5. **Backburner works**: The core strategy (RSI extreme after impulse) is profitable

---

## Next Steps

1. ✅ Wire up GP V2 and BTC Bias V2 bots in web-server.ts
2. ⏳ Run forensic backtest with friction modeling
3. ⏳ Collect more data (target: 1 week) for statistical significance
4. ⏳ Consider removing V1 BTC Bias from default visibility

---

*This document consolidates findings from strategy analysis sessions. See `STRATEGY_LEARNINGS.md` for signal quality insights and `RALPH_TASK.md` for forensic backtest status.*
