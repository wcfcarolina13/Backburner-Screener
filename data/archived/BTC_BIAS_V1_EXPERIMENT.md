# BTC Bias V1 Experiment - ARCHIVED

**Experiment Period**: January 13-15, 2026
**Status**: FAILED - Archived
**Archived Date**: January 15, 2026

---

## Executive Summary

The BTC Bias V1 strategy was an attempt to trade BTC directionally based on macro RSI bias across multiple timeframes. **It lost -$12,000+ in paper trading over 2 days** due to extreme position sizing and leverage.

**Final Verdict**: NOT VIABLE - Do not use in production.

---

## Strategy Overview

### Concept
Trade BTC in the direction of the macro bias:
- When 4H + 1H RSI aligned bullish → Go LONG
- When 4H + 1H RSI aligned bearish → Go SHORT
- Hold through neutral, exit on opposite bias or stop

### Bot Configurations (8 variants)

| Bot ID | Position % | Leverage | Stop Type | Callback/ROI |
|--------|------------|----------|-----------|--------------|
| bias100x20trail | 100% | 20x | Trailing | 1% callback |
| bias100x50trail | 100% | 50x | Trailing | 0.5% callback |
| bias10x20trail | 10% | 20x | Trailing | 1% callback |
| bias10x50trail | 10% | 50x | Trailing | 0.5% callback |
| bias100x20hard | 100% | 20x | Hard Stop | 20% ROI |
| bias100x50hard | 100% | 50x | Hard Stop | 20% ROI |
| bias10x20hard | 10% | 20x | Hard Stop | 20% ROI |
| bias10x50hard | 10% | 50x | Hard Stop | 20% ROI |

---

## Performance Results

### Total Losses: -$8,385.36

| Bot ID | PnL | Win Rate | Trades | Notes |
|--------|-----|----------|--------|-------|
| btc-bias-100x50-trail | **-$3,478.83** | 17% | 6 | Worst performer |
| btc-bias-100x50-hard | **-$3,163.79** | 0% | 3 | Disaster |
| btc-bias-100x20-trail | -$724.98 | 0% | 2 | Bad |
| btc-bias-100x20-hard | -$557.50 | 0% | 1 | Bad |
| btc-bias-10x50-hard | -$244.36 | 0% | 3 | Moderate loss |
| btc-bias-10x50-trail | -$96.24 | 40% | 5 | Least bad |
| btc-bias-10x20-trail | -$66.76 | 0% | 2 | Small loss |
| btc-bias-10x20-hard | -$52.89 | 0% | 1 | Small loss |

### Key Statistics
- **Total Trades**: 33
- **Overall Win Rate**: ~10%
- **Largest Single Loss**: -$1,353.77 (100x50 config)
- **100% position bots**: Lost -$7,925 (94% of total losses)
- **10% position bots**: Lost -$460 (6% of total losses)

---

## Why It Failed

### 1. Position Sizing Was Suicidal
- 100% of balance in a single trade = **zero margin for error**
- One bad trade wiped out the entire account
- No ability to average down or wait for recovery

### 2. Leverage Amplified Losses Exponentially
- 50x leverage means a 2% move = 100% account move
- 0.5% callback at 50x = only 0.01% price tolerance before stop
- BTC routinely moves 0.5% in seconds

### 3. Trailing Stops Were Too Tight
- 0.5% callback at 50x leverage is absurd
- Even 1% callback at 20x got stopped out on normal volatility
- BTC needs at least 2-3% breathing room

### 4. "Hold Through Neutral" = Death by Whipsaw
- Market oscillated between long/short bias rapidly
- Bot would hold through chop, accumulating losses
- No mechanism to cut losses during sideways action

### 5. Bias Signal Quality Issues
- RSI-based bias changes frequently on LTF (5m, 15m)
- HTF (4H) bias more stable but slower to react
- Weighted combination still gave many false signals

---

## Lessons Learned

### Position Sizing
1. **NEVER use 100% position size** - Maximum should be 20-25%
2. **Scale into positions** - Start smaller, add on confirmation
3. **Leave margin for recovery** - Losing trades happen

### Leverage
1. **50x is gambling, not trading** - Stick to 10-20x max
2. **Higher leverage = tighter required precision** - Usually impossible
3. **Test at low leverage first** - If it doesn't work at 10x, 50x won't fix it

### Trailing Stops
1. **BTC needs 2-3% minimum callback** - Less gets stopped by noise
2. **Scale callback with leverage** - Higher leverage = wider callback
3. **Consider ATR-based dynamic callbacks** - Adapt to volatility

### Strategy Design
1. **"Hold through neutral" needs an escape hatch** - Time-based exit or max loss
2. **Directional strategies need strong trend filters** - Don't trade chop
3. **Simpler is often better** - Fewer parameters = fewer ways to fail

---

## What Replaced V1

### BTC Bias V2 (Conservative Parameters)
Created with survival-focused settings:

| Parameter | V1 (Failed) | V2 (New) |
|-----------|-------------|----------|
| Position Size | 10-100% | 10-20% |
| Leverage | 20-50x | 10-20x |
| Trailing Callback | 0.5-1% | 2-3% |
| Hard Stop ROI | 20% | 30% |

V2 bots are still being tested as of archival date.

---

## Files Removed

The following were removed from the active GUI:
- Toggle controls for 8 V1 bots
- Stats display panels for 8 V1 bots
- Section headers ("BTC Bias Bots", "BTC Bias Bot Stats")

### Files Retained (Historical Reference)
- `src/btc-bias-bot.ts` - Contains both V1 and V2 factories
- `data/trades/` - Historical trade logs preserved
- `data/configs/` - Bot configuration snapshots preserved
- This document

---

## Recommendations for Future Experiments

1. **Start with paper trading at conservative settings**
2. **Run for at least 1 week before increasing risk**
3. **Set a maximum loss threshold** (e.g., -$500) for auto-shutdown
4. **Document failures immediately** - Memory fades, lessons get lost
5. **Don't scale leverage to "fix" a losing strategy**

---

*Archived by Ralph methodology. Original bot code in `src/btc-bias-bot.ts`, function `createBtcBiasBots()`.*
