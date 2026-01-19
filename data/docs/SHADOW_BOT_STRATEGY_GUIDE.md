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
