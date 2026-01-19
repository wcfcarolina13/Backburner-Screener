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

---

## 2026-01-14

**Analysis Timestamp:** 2026-01-14T15:25:33.722Z
**Market Context:** Bullish (mostly longs)
**Total Trades:** 50 | **Total P&L:** $-2313.97

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
| btc-bias-10x20-trail | 2 | 0 | 2 | 0% | $-29.11 | $-14.56 |
| btc-bias-10x20-hard | 2 | 0 | 2 | 0% | $-29.11 | $-14.56 |
| btc-bias-10x50-trail | 2 | 0 | 2 | 0% | $-73.66 | $-36.83 |
| btc-bias-10x50-hard | 2 | 0 | 2 | 0% | $-74.72 | $-37.36 |
| Fixed TP/SL | 3 | 0 | 3 | 0% | $-209.52 | $-69.84 |
| btc-bias-100x20-trail | 2 | 0 | 2 | 0% | $-332.45 | $-166.23 |
| btc-bias-100x20-hard | 2 | 0 | 2 | 0% | $-332.45 | $-166.23 |
| btc-bias-100x50-trail | 2 | 0 | 2 | 0% | $-913.08 | $-456.54 |
| btc-bias-100x50-hard | 2 | 0 | 2 | 0% | $-922.74 | $-461.37 |

### Notable Winning Trades

- **Trail Wide**: KGEN +$169.56
- **Trail Standard (10x)**: RIVER +$86.59
- **GP-YOLO**: DOG +$122.27

### Observations

1. **Top performer:** Trail Wide with +$183.94 (71% win rate)
2. **Underperformer:** btc-bias-100x50-hard with $-922.74
3. **Average win rate across all bots:** 35.8%

---

## 2026-01-14

**Analysis Timestamp:** 2026-01-14T15:25:38.980Z
**Market Context:** Bullish (mostly longs)
**Total Trades:** 50 | **Total P&L:** $-2313.97

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
| btc-bias-10x20-trail | 2 | 0 | 2 | 0% | $-29.11 | $-14.56 |
| btc-bias-10x20-hard | 2 | 0 | 2 | 0% | $-29.11 | $-14.56 |
| btc-bias-10x50-trail | 2 | 0 | 2 | 0% | $-73.66 | $-36.83 |
| btc-bias-10x50-hard | 2 | 0 | 2 | 0% | $-74.72 | $-37.36 |
| Fixed TP/SL | 3 | 0 | 3 | 0% | $-209.52 | $-69.84 |
| btc-bias-100x20-trail | 2 | 0 | 2 | 0% | $-332.45 | $-166.23 |
| btc-bias-100x20-hard | 2 | 0 | 2 | 0% | $-332.45 | $-166.23 |
| btc-bias-100x50-trail | 2 | 0 | 2 | 0% | $-913.08 | $-456.54 |
| btc-bias-100x50-hard | 2 | 0 | 2 | 0% | $-922.74 | $-461.37 |

### Notable Winning Trades

- **Trail Wide**: KGEN +$169.56
- **Trail Standard (10x)**: RIVER +$86.59
- **GP-YOLO**: DOG +$122.27

### Observations

1. **Top performer:** Trail Wide with +$183.94 (71% win rate)
2. **Underperformer:** btc-bias-100x50-hard with $-922.74
3. **Average win rate across all bots:** 35.8%

---

## 2026-01-15

**Analysis Timestamp:** 2026-01-15T05:55:08.900Z
**Market Context:** Mixed
**Total Trades:** 7 | **Total P&L:** $-3982.26

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| btc-bias-10x20-trail | 1 | 0 | 1 | 0% | $-50.83 | $-50.83 |
| btc-bias-10x20-hard | 1 | 0 | 1 | 0% | $-50.83 | $-50.83 |
| btc-bias-10x50-hard | 1 | 0 | 1 | 0% | $-99.25 | $-99.25 |
| btc-bias-100x20-trail | 1 | 0 | 1 | 0% | $-536.91 | $-536.91 |
| btc-bias-100x20-hard | 1 | 0 | 1 | 0% | $-536.91 | $-536.91 |
| btc-bias-100x50-trail | 1 | 0 | 1 | 0% | $-1353.77 | $-1353.77 |
| btc-bias-100x50-hard | 1 | 0 | 1 | 0% | $-1353.77 | $-1353.77 |

### Observations

2. **Underperformer:** btc-bias-100x50-hard with $-1353.77
3. **Average win rate across all bots:** 0.0%

---

## 2026-01-16

**Analysis Timestamp:** 2026-01-16T05:59:15.757Z
**Market Context:** Bearish (mostly shorts)
**Total Trades:** 46 | **Total P&L:** $-138.66

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| standard | 5 | 4 | 1 | 80% | +$66.06 | +$13.21 |
| standard-05cb | 5 | 4 | 1 | 80% | +$43.94 | +$8.79 |
| wide-2cb | 4 | 3 | 1 | 75% | +$15.10 | +$3.78 |
| Trail Standard (10x) | 5 | 2 | 3 | 40% | $-0.25 | $-0.05 |
| Trail Light (1%) | 5 | 2 | 3 | 40% | $-0.33 | $-0.07 |
| Trail Wide | 8 | 5 | 3 | 63% | $-41.41 | $-5.18 |
| aggressive | 6 | 2 | 4 | 33% | $-58.30 | $-9.72 |
| aggressive-2cb | 4 | 2 | 2 | 50% | $-68.67 | $-17.17 |
| Trail Aggressive (20x) | 4 | 2 | 2 | 50% | $-94.81 | $-23.70 |

### Notable Winning Trades

- **standard**: FRAX +$53.16
- **standard-05cb**: XCN +$37.27
- **wide-2cb**: FRAX +$37.19

### Observations

1. **Top performer:** standard with +$66.06 (80% win rate)
2. **Underperformer:** Trail Aggressive (20x) with $-94.81
3. **Average win rate across all bots:** 56.8%

---

## 2026-01-17

**Analysis Timestamp:** 2026-01-17T05:55:05.779Z
**Market Context:** Bearish (mostly shorts)
**Total Trades:** 52 | **Total P&L:** $-861.81

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| Trail Wide | 6 | 4 | 2 | 67% | +$156.72 | +$26.12 |
| standard | 3 | 2 | 1 | 67% | +$89.20 | +$29.73 |
| Trail Aggressive (20x) | 2 | 1 | 1 | 50% | +$84.86 | +$42.43 |
| aggressive | 2 | 1 | 1 | 50% | +$52.98 | +$26.49 |
| standard-05cb | 2 | 1 | 1 | 50% | +$52.08 | +$26.04 |
| Trail Light (1%) | 1 | 0 | 1 | 0% | $-0.68 | $-0.68 |
| Trail Standard (10x) | 1 | 0 | 1 | 0% | $-4.21 | $-4.21 |
| shadow-10pct10x-sl15 | 1 | 0 | 1 | 0% | $-4.68 | $-4.68 |
| shadow-10pct10x-sl10 | 1 | 0 | 1 | 0% | $-5.72 | $-5.72 |
| wide-2cb | 3 | 1 | 2 | 33% | $-6.64 | $-2.21 |
| aggressive-2cb | 1 | 0 | 1 | 0% | $-43.47 | $-43.47 |
| btc-bias-v2-10x10-trail | 3 | 0 | 3 | 0% | $-58.39 | $-19.46 |
| btc-bias-v2-10x10-hard | 3 | 0 | 3 | 0% | $-58.39 | $-19.46 |
| shadow-10pct10x-sl30 | 2 | 0 | 2 | 0% | $-76.86 | $-38.43 |
| shadow-10pct10x-sl25 | 3 | 0 | 3 | 0% | $-107.86 | $-35.95 |
| btc-bias-v2-20x10-trail | 3 | 0 | 3 | 0% | $-116.60 | $-38.87 |
| btc-bias-v2-10x20-trail | 3 | 0 | 3 | 0% | $-116.60 | $-38.87 |
| btc-bias-v2-20x10-hard | 3 | 0 | 3 | 0% | $-116.60 | $-38.87 |
| btc-bias-v2-10x20-hard | 3 | 0 | 3 | 0% | $-116.60 | $-38.87 |
| btc-bias-v2-20x20-trail | 3 | 0 | 3 | 0% | $-232.16 | $-77.39 |
| btc-bias-v2-20x20-hard | 3 | 0 | 3 | 0% | $-232.16 | $-77.39 |

### Notable Winning Trades

- **Trail Wide**: ZEN +$104.53
- **standard**: GUN +$83.06
- **Trail Aggressive (20x)**: ZEN +$109.19

### Observations

1. **Top performer:** Trail Wide with +$156.72 (67% win rate)
2. **Underperformer:** btc-bias-v2-20x20-hard with $-232.16
3. **Average win rate across all bots:** 15.1%

---

## 2026-01-18

**Analysis Timestamp:** 2026-01-18T05:55:06.339Z
**Market Context:** Mixed
**Total Trades:** 44 | **Total P&L:** $-1076.60

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| shadow-10pct10x-sl25 | 1 | 1 | 0 | 100% | +$5.70 | +$5.70 |
| Fixed TP/SL | 1 | 0 | 1 | 0% | +$0.00 | +$0.00 |
| Trail Light (1%) | 3 | 1 | 2 | 33% | $-8.99 | $-3.00 |
| shadow-10pct10x-sl10 | 2 | 0 | 2 | 0% | $-51.14 | $-25.57 |
| shadow-10pct10x-sl30 | 2 | 1 | 1 | 50% | $-52.60 | $-26.30 |
| aggressive | 3 | 1 | 2 | 33% | $-69.97 | $-23.32 |
| shadow-10pct10x-sl15 | 2 | 0 | 2 | 0% | $-71.67 | $-35.83 |
| Trail Standard (10x) | 3 | 1 | 2 | 33% | $-79.76 | $-26.59 |
| standard-05cb | 4 | 1 | 3 | 25% | $-83.80 | $-20.95 |
| standard | 5 | 1 | 4 | 20% | $-88.93 | $-17.79 |
| Trail Aggressive (20x) | 2 | 0 | 2 | 0% | $-99.09 | $-49.55 |
| aggressive-2cb | 3 | 1 | 2 | 33% | $-109.43 | $-36.48 |
| wide-2cb | 5 | 1 | 4 | 20% | $-172.17 | $-34.43 |
| Trail Wide | 8 | 2 | 6 | 25% | $-194.75 | $-24.34 |

### Notable Winning Trades

- **shadow-10pct10x-sl25**: BEAT +$5.70

### Observations

1. **Top performer:** shadow-10pct10x-sl25 with +$5.70 (100% win rate)
2. **Underperformer:** Trail Wide with $-194.75
3. **Average win rate across all bots:** 26.7%
