# Shadow Bot Strategy Testing Guide

## Overview

This document describes the shadow bots running on the Backburner screener and how to evaluate their performance. Shadow bots are paper trading bots that track hypothetical positions based on different strategies.

**Last Updated:** January 2026

---

## Active Shadow Bot Categories

### 1. Backburner Shadow Bots (Timeframe A/B Testing)

These bots use the **full Backburner detection logic**:
- Requires impulse move first
- RSI must cross threshold (< 30 for long, > 70 for short)
- State machine: watching → triggered → deep_extreme

| Bot ID | Strategy | Based On |
|--------|----------|----------|
| `shadow-5m-fade` | 5m timeframe, FADE signals | Backtest showed 5m fade beats normal |
| `shadow-5m-normal` | 5m timeframe, NORMAL signals | Control group |
| `shadow-4h-normal` | 4H timeframe, NORMAL signals | Backtest showed 4H normal beats fade |
| `shadow-4h-fade` | 4H timeframe, FADE signals | Control group |

**Backtest Results (Jan 2026):**
- 5m Fade: +$180, 1.09 PF (beat 5m Normal which was -$250)
- 4H Normal: +$412, 6.13 PF, 89.5% win rate (beat 4H Fade which was -$130)

---

### 2. GP Shadow Bots (Golden Pocket RSI Zone Strategy)

These bots use **simpler entry logic** than Backburner:
- No impulse requirement
- No state machine
- Just check if RSI is in "golden pocket" zone

**Golden Pocket Zones (Fibonacci levels):**
- Long zone: RSI 23.6 - 38.2
- Short zone: RSI 61.8 - 76.4

| Bot ID | Strategy | Based On |
|--------|----------|----------|
| `gp-4h-normal` | 4H timeframe, NORMAL direction | Backtest: +$10,672 profit |
| `gp-4h-fade` | 4H timeframe, FADE direction | Control group |
| `gp-5m-normal` | 5m timeframe, NORMAL direction | Control group |
| `gp-5m-fade` | 5m timeframe, FADE direction | Testing if 5m fade works for GP |

**Backtest Results (Jan 2026, 83 days of 4H data, 152 symbols):**

| Strategy | Trades | Win Rate | Profit Factor | Total P&L |
|----------|--------|----------|---------------|-----------|
| Backburner 4H Normal | ~19 | 89.5% | 6.13 | +$412 |
| GP Zone 4H Normal | 152 | 27.6% | 1.69 | +$10,672 |

**Key Insight:** GP Zone strategy generated MORE trades and MORE profit despite lower win rate. The impulse requirement in Backburner may be too restrictive.

---

### 3. Combined Strategy Bot

Tests the hypothesis: Use 4H to establish trend direction, then use 5m fade for entry timing.

| Bot ID | Strategy |
|--------|----------|
| `combined-4h5m` | 4H establishes bias, 5m fade times entry |

**Logic:**
- 4H LONG signal → stores bullish bias for that symbol (valid 12 hours)
- When 5m SHORT signal appears → FADE it (go LONG) = aligned with 4H
- 4H SHORT signal → stores bearish bias
- When 5m LONG signal appears → FADE it (go SHORT) = aligned with 4H

**Status:** Collecting data. No historical 4H signals in database yet (4H scanning just added).

---

## Position Parameters (All Shadow Bots)

All shadow bots use identical position management:

```
Initial Balance:       $2,000
Position Size:         5% of balance
Leverage:              10x
Initial Stop Loss:     15% from entry
Trail Trigger:         10% ROI
Trail Step:            5%
Level 1 Lock:          2% (moves stop to breakeven)
Max Open Positions:    50
```

---

## How to Check Performance

### 1. API Endpoint

```bash
curl https://your-render-url.com/api/bots
```

Returns all bot balances and stats.

### 2. Dashboard

Visit the web dashboard and check the "Bots" section for real-time balances.

### 3. Data Files

Historical snapshots are saved to:
- `data/hourly-snapshots/` - Hourly bot states
- `data/trades/` - Individual trade logs

---

## Evaluation Checklist (After 3-5 Days)

### Compare Backburner vs GP for 4H:
- [ ] `shadow-4h-normal` vs `gp-4h-normal` - Which has higher P&L?
- [ ] Does GP generate more trades? (Expected: yes)
- [ ] Which has better profit factor?

### Compare Fade vs Normal for 5m:
- [ ] `shadow-5m-fade` vs `shadow-5m-normal` - Does fade still win?
- [ ] `gp-5m-fade` vs `gp-5m-normal` - Does fade work for GP too?

### Combined Strategy:
- [ ] `combined-4h5m` - Any trades opened?
- [ ] Compare to standalone `shadow-4h-normal` and `shadow-5m-fade`

### Key Questions to Answer:
1. **Does GP outperform Backburner in live trading?** (Backtest says yes for 4H)
2. **Does the simpler strategy (GP) scale better with more signals?**
3. **Does fade work for GP like it does for Backburner on 5m?**
4. **Is combining 4H+5m better than either alone?**

---

## Strategy Differences Summary

| Aspect | Backburner | GP Zone |
|--------|------------|---------|
| Entry Logic | Impulse → RSI cross → state machine | RSI in zone (that's it) |
| Long Threshold | RSI crosses below 30 | RSI 23.6 - 38.2 |
| Short Threshold | RSI crosses above 70 | RSI 61.8 - 76.4 |
| Signal Count | Fewer (more selective) | More (broader) |
| Expected Win Rate | Higher (~89% in backtest) | Lower (~28% in backtest) |
| Expected Trade Count | Lower | Higher |

---

## Files Reference

### Source Code:
- `src/timeframe-shadow-bot.ts` - Backburner shadow bots
- `src/gp-shadow-bot.ts` - GP zone shadow bots
- `src/combined-strategy-bot.ts` - Combined 4H+5m strategy
- `src/web-server.ts` - Bot instantiation and wiring

### Backtest Code:
- `src/backtest-cli.ts` - Main backtester (uses Backburner signals)
- `src/backtest-combined-candles.ts` - GP zone backtester
- `src/backtest-engine.ts` - Core backtest logic

### NPM Scripts:
```bash
npm run backtest                    # Backburner strategy backtest
npm run backtest-combined-candles   # GP zone backtest
```

---

## Next Steps (After Evaluation)

Based on results, consider:

1. **If GP 4H outperforms Backburner 4H:**
   - Consider making GP the primary strategy for 4H
   - May simplify codebase (remove impulse detection for 4H)

2. **If Combined strategy outperforms standalone:**
   - Implement as main trading strategy
   - Test different HTF validity windows (4h, 8h, 12h, 24h)

3. **If 5m fade works for both Backburner AND GP:**
   - Strong confirmation that 5m signals are counter-trend
   - Consider fade-only mode for 5m timeframe

---

---

## 4. Experimental A/B Testing Bots

These bots test different combinations of signal sources and bias filters. Created in Jan 2026 to A/B test:
- **System A** (RSI-only bias) vs **System B** (multi-indicator bias)
- **Backburner** vs **Golden Pocket** signal sources
- **With/without** regime quadrant filters

**Source:** `src/experimental-shadow-bots.ts`

---

### exp-bb-sysB (TOP PERFORMER 🏆)

**Performance History:**
| Date | Trades | Win Rate | Daily PnL | Avg PnL |
|------|--------|----------|-----------|---------|
| Jan 23 (8h) | 62 | 50.0% | **+$1,534.32** | +$49.49 |
| Jan 22 | 44 | 50.0% | **+$677.20** | +$30.78 |
| **Total** | **106** | **50.0%** | **+$2,211.52** | **+$20.86** |

**Top Trades (Jan 23):**
| Symbol | Direction | PnL | Exit |
|--------|-----------|-----|------|
| WAXPUSDT | SHORT | +$215.75 | trailing_stop |
| MBGUSDT | LONG | +$182.54 | trailing_stop |
| ELSAUSDT | SHORT | +$93.64 | trailing_stop |
| ACUUSDT | LONG | +$89.06 | trailing_stop |
| XRDUSDT | LONG | +$65.49 | trailing_stop |

**All 62 trades exited via trailing_stop** - no stop losses hit overnight!

**Configuration:**
```typescript
{
  botId: 'exp-bb-sysB',
  description: 'BB + System B bias filter',
  initialBalance: 2000,
  positionSizePercent: 10,     // 10% of balance per trade
  leverage: 20,                 // 20x leverage
  maxPositions: 10,             // Max 10 concurrent positions
  initialStopPercent: 8,        // 8% initial stop loss
  trailTriggerPercent: 10,      // Trail activates at +10% ROI
  trailStepPercent: 5,          // Trail steps by 5%
  takeProfitPercent: 0,         // NO fixed TP - trailing only
  useBiasFilter: true,          // USE System B filter
  biasSystem: 'B',              // Multi-indicator bias
  useRegimeFilter: false,       // NO regime filter - trades ALL quadrants
  longOnly: false,              // Both directions
  feePercent: 0.04,             // 0.04% taker fee
  slippagePercent: 0.05,        // 0.05% slippage
}
```

---

### System B Bias Filter (What Makes It Special)

**Source:** `src/market-bias-system-b.ts`

System B uses **5 weighted indicators** to determine market bias:

| Indicator | Weight | What It Measures |
|-----------|--------|------------------|
| RSI Multi-TF | 3x | RSI across 4h, 1h, 15m, 5m, 1m timeframes |
| Funding Rate | 2x | Contrarian: extreme funding = reversal likely |
| Open Interest | 2x | Rising OI + price direction = trend strength |
| Premium/Discount | 1x | Futures vs index price spread |
| Momentum | 1x | 24h price change |

**Bias Thresholds:**
- `strong_long`: score > 50 AND ≥60% indicators bullish
- `long`: score > 25
- `neutral`: -25 ≤ score ≤ 25
- `short`: score < -25
- `strong_short`: score < -50 AND ≥60% indicators bearish

**Key Difference from System A:**
- System A: RSI-only (simple but can be fooled by choppy markets)
- System B: Multi-indicator consensus (more robust, fewer false signals)

---

### All Experimental Bots Performance (Jan 21-23)

| Bot ID | Total Trades | Win Rate | Total PnL | Status |
|--------|--------------|----------|-----------|--------|
| **exp-bb-sysB** | 106 | 50.0% | **+$2,211.52** | ⭐ BEST |
| exp-bb-sysB-contrarian | 12 | 50.0% | +$133.22 | ✅ Good |
| exp-gp-sysB | 18 | 38.9% | +$79.78 | Testing |
| exp-gp-sysA | 14 | 35.7% | +$27.55 | Testing |
| exp-gp-regime | 6 | 16.7% | -$68.03 | ❌ Poor |
| exp-gp-sysB-contrarian | 6 | 16.7% | -$68.03 | ❌ Poor |

**Key Insights:**
1. **Backburner + System B** beats all GP combinations
2. **No regime filter** outperforms contrarian-only filtering
3. **System B** consistently beats System A (multi-indicator > RSI-only)
4. **Golden Pocket bots** underperform Backburner bots with same filters

---

### Bot Configuration Matrix

| Bot ID | Signal | Bias | Regime | Leverage | Stop |
|--------|--------|------|--------|----------|------|
| exp-bb-sysB | Backburner | System B | None | 20x | 8% |
| exp-bb-sysB-contrarian | Backburner | System B | NEU+BEAR, BEAR+BEAR | 20x | 8% |
| exp-gp-sysA | Golden Pocket | System A (RSI) | None | 10x | GP stops |
| exp-gp-sysB | Golden Pocket | System B | None | 10x | GP stops |
| exp-gp-regime | Golden Pocket | None | NEU+BEAR, BEAR+BEAR | 10x | GP stops |
| exp-gp-sysB-contrarian | Golden Pocket | System B | NEU+BEAR, BEAR+BEAR | 10x | GP stops |

**Why exp-bb-sysB Wins:**
1. **Higher leverage (20x)** - amplifies gains when direction is right
2. **System B filter** - better directional accuracy
3. **No regime filter** - more opportunities
4. **Trailing-only exits** - lets winners run, 100% of Jan 23 exits were trail hits

---

## 5. Focus Mode Shadow Bots

These simulate manual leveraged trading using Focus Mode quadrant guidance. Created Jan 21, 2026.

### Performance Summary (Jan 22, 2026)

| Bot ID | Win Rate | PnL | Strategy |
|--------|----------|-----|----------|
| focus-conservative | 81.8% | +$40.84 | 0.75x leverage, wider stops |
| focus-contrarian-only | 100% | +$40.54 | NEU+BEAR, BEAR+BEAR only |
| focus-excellent | 81.3% | +$10.51 | +2 positions for excellent setups |
| focus-aggressive | 81.8% | -$21.34 | 1.5x leverage, 8 max positions |
| focus-hybrid | 71.4% | -$39.27 | Conflict-close + excellent overflow |
| focus-baseline | 73.9% | -$50.00 | Standard rules |
| focus-conflict | 70.8% | -$53.65 | Closes on regime conflict |
| focus-kelly | 66.7% | **-$1,321** | ⚠️ DANGEROUS - Kelly sizing |

### New Bots Added (Jan 23, 2026)

| Bot ID | Quadrants | Strategy |
|--------|-----------|----------|
| focus-euphoria-fade | BULL+BULL | SHORT when market euphoric |
| focus-bull-dip | BULL+BEAR | BUY dips in macro bull |
| focus-full-quadrant | ALL (except BEAR+BULL) | Comprehensive data collection |

**Source:** `src/focus-mode-shadow-bot.ts`

---

## Historical Context

### Why We Added These Bots (Jan 2026):

1. **Backtest Discovery:** 4H normal dramatically outperformed 4H fade (+$412 vs -$130)
2. **Opposite of 5m:** 5m fade beat 5m normal (+$180 vs -$250)
3. **GP Zone Surprise:** Simple RSI zone detection outperformed full Backburner on 4H ($10,672 vs $412)

### The Core Hypothesis:

RSI behavior differs by timeframe:
- **5m:** Signals are "backwards" - fade them for profit
- **4H:** Signals are reliable - follow them normally
- **GP Zone:** Simpler entry logic may capture more profitable setups
