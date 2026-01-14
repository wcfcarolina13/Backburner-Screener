# Daily Bot Performance Log

Tracking bot performance to inform auto-trading decision.

---

## 2026-01-14 (BTC Bull Run Day)

**Analysis Timestamp:** 2026-01-14 ~15:15 UTC
**Market Context:** BTC bullish bias, strong upward momentum
**Data Source:** localhost paper trading

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| Trail Wide | 7 | 5 | 2 | 71% | +$183.94 | +$26.28 |
| Trail Standard (10x) | 6 | 3 | 3 | 50% | +$141.49 | +$23.58 |
| GP-YOLO | 1 | 1 | 0 | 100% | +$122.27 | +$122.27 |
| Trail Aggressive (20x) | 8 | 3 | 5 | 38% | +$54.32 | +$6.79 |
| GP-Aggressive | 1 | 1 | 0 | 100% | +$46.33 | +$46.33 |
| GP-Standard | 1 | 1 | 0 | 100% | +$30.80 | +$30.80 |
| Trail Light (1%) | 6 | 3 | 3 | 50% | +$14.45 | +$2.41 |
| GP-Conservative | 1 | 1 | 0 | 100% | +$9.29 | +$9.29 |
| Fixed TP/SL | 3 | 0 | 3 | 0% | -$209.52 | -$69.84 |

### Notable Trades

**Trail Wide:**
- KGEN long: +$169.56 (Level 9 trailing stop - exceptional runner)
- BEAT long: +$64.35 (Level 4)
- SLP long: +$31.27 (Level 2)
- ENA long: -$53.01 (Initial stop)
- VANA long: -$43.60 (Initial stop)

**Trail Standard:**
- RIVER long: +$86.59 (Level 6)
- KGEN long: +$76.21 (Level 5)

### BTC Bias Bots (Underperforming)

All BTC Bias bots showed losses today - likely got caught shorting during bull run:
- btc-bias-100x50-hard: -$922.74 (2 trades, 0 wins)
- btc-bias-100x50-trail: -$913.08 (2 trades, 0 wins)
- btc-bias-100x20-*: ~-$332 each

### Observations

1. **Trail Wide** performed best with 71% win rate and highest P&L
2. **Trailing stop bots** outperformed fixed TP/SL significantly
3. **10x leverage** bots more consistent than 20x
4. **Fixed TP/SL** strategy failing - all trades hit stop loss
5. **Golden Pocket** bots showing promise but low volume

---

## 2026-01-13

**Market Context:** Mixed/choppy
**Data Source:** localhost paper trading

### Top 5 Performers

| Bot | Trades | Win Rate | Total P&L |
|-----|--------|----------|-----------|
| GP-YOLO | 3 | 67% | +$30.52 |
| GP-Standard | 3 | 67% | +$8.06 |
| GP-Aggressive | 3 | 67% | -$1.55 |
| GP-Conservative | 3 | 67% | -$2.89 |
| Trail Light (1%) | 17 | 29% | -$9.83 |

### Observations

1. Golden Pocket bots were the only profitable strategies
2. Trailing bots struggled in choppy conditions
3. Trail Wide had worst day: -$435

---

## 2026-01-12

**Data Source:** localhost paper trading

### Top 5 Performers

| Bot | Trades | Total P&L |
|-----|--------|-----------|
| Confluence | - | +$9.59 |
| Trail Light (1%) | - | -$16.96 |
| GP-Conservative | - | -$87.71 |
| Trail Aggressive (20x) | - | -$127.69 |
| Trail Standard (10x) | - | -$150.12 |

---

## Cumulative Insights (as of Jan 14)

### Best Candidates for Auto-Trading:

1. **Trail Wide** - Best single-day performance, lets winners run
2. **Trail Standard (10x)** - Consistent, moderate risk
3. **GP-YOLO** - High conviction plays, limited volume

### Avoid:

1. **Fixed TP/SL** - Consistently underperforming
2. **BTC Bias bots (100x)** - Too much leverage, getting stopped out
3. **20x leverage bots** - Higher variance, lower win rate

### Recommended Testing Period:

Continue monitoring through **Jan 17-18** (3-4 more days) to capture:
- Another potential pullback/consolidation
- Weekend trading behavior
- More statistical significance (target: 50+ trades per bot)

---

## Decision Timeline

- **Jan 14:** Initial analysis logged
- **Jan 15-17:** Continue monitoring
- **Jan 18:** Final recommendation for auto-trading candidate
