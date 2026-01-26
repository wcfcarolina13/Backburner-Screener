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

---

## 2026-01-19

**Analysis Timestamp:** 2026-01-19T06:10:51.890Z
**Market Context:** Bearish (mostly shorts)
**Total Trades:** 141 | **Total P&L:** $-1738.63

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| Fixed TP/SL | 3 | 1 | 2 | 33% | +$37.71 | +$12.57 |
| wide-2cb | 10 | 2 | 8 | 20% | +$35.46 | +$3.55 |
| shadow-10pct10x-sl15 | 7 | 1 | 6 | 14% | +$13.46 | +$1.92 |
| shadow-10pct10x-sl10 | 7 | 1 | 6 | 14% | +$8.21 | +$1.17 |
| Trail Light (1%) | 8 | 1 | 7 | 13% | $-12.36 | $-1.54 |
| GP-Conservative | 3 | 0 | 3 | 0% | $-27.87 | $-9.29 |
| Trail Standard (10x) | 8 | 1 | 7 | 13% | $-44.70 | $-5.59 |
| GP-Standard | 3 | 0 | 3 | 0% | $-85.66 | $-28.55 |
| shadow-10pct10x-sl25 | 8 | 1 | 7 | 13% | $-93.66 | $-11.71 |
| standard | 10 | 4 | 6 | 40% | $-111.24 | $-11.12 |
| shadow-10pct10x-sl30 | 8 | 1 | 7 | 13% | $-112.64 | $-14.08 |
| GP-Aggressive | 3 | 0 | 3 | 0% | $-123.86 | $-41.29 |
| standard-05cb | 12 | 5 | 7 | 42% | $-154.37 | $-12.86 |
| Trail Aggressive (20x) | 9 | 1 | 8 | 11% | $-165.24 | $-18.36 |
| aggressive-2cb | 10 | 0 | 10 | 0% | $-171.82 | $-17.18 |
| GP-YOLO | 2 | 0 | 2 | 0% | $-179.75 | $-89.87 |
| aggressive | 13 | 0 | 13 | 0% | $-206.22 | $-15.86 |
| Trail Wide | 17 | 3 | 14 | 18% | $-344.09 | $-20.24 |

### Notable Winning Trades

- **Fixed TP/SL**: ZEN +$37.71
- **wide-2cb**: VIRTUAL +$256.76
- **shadow-10pct10x-sl15**: GLM +$167.45

### Observations

1. **Top performer:** Fixed TP/SL with +$37.71 (33% win rate)
2. **Underperformer:** Trail Wide with $-344.09
3. **Average win rate across all bots:** 13.5%

---

## 2026-01-20

**Analysis Timestamp:** 2026-01-20T05:58:35.149Z
**Market Context:** Bullish (mostly longs)
**Total Trades:** 6 | **Total P&L:** $-48.16

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| aggressive | 1 | 1 | 0 | 100% | +$36.57 | +$36.57 |
| standard-05cb | 1 | 1 | 0 | 100% | +$23.62 | +$23.62 |
| standard | 1 | 1 | 0 | 100% | +$18.36 | +$18.36 |
| aggressive-2cb | 1 | 0 | 1 | 0% | $-14.43 | $-14.43 |
| Trail Wide | 1 | 0 | 1 | 0% | $-56.14 | $-56.14 |
| wide-2cb | 1 | 0 | 1 | 0% | $-56.14 | $-56.14 |

### Notable Winning Trades

- **aggressive**: ZBCN +$36.57
- **standard-05cb**: ZBCN +$23.62
- **standard**: ZBCN +$18.36

### Observations

1. **Top performer:** aggressive with +$36.57 (100% win rate)
2. **Underperformer:** wide-2cb with $-56.14
3. **Average win rate across all bots:** 50.0%

---

## 2026-01-21

**Analysis Timestamp:** 2026-01-21T05:55:05.515Z
**Market Context:** Mixed
**Total Trades:** 15 | **Total P&L:** $-307.00

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| aggressive | 1 | 0 | 1 | 0% | $-17.89 | $-17.89 |
| standard-05cb | 2 | 1 | 1 | 50% | $-40.57 | $-20.28 |
| wide-2cb | 4 | 3 | 1 | 75% | $-46.53 | $-11.63 |
| Trail Wide | 1 | 0 | 1 | 0% | $-63.02 | $-63.02 |
| standard | 1 | 0 | 1 | 0% | $-63.02 | $-63.02 |
| aggressive-2cb | 6 | 3 | 3 | 50% | $-75.97 | $-12.66 |

### Observations

2. **Underperformer:** aggressive-2cb with $-75.97
3. **Average win rate across all bots:** 29.2%

---

## 2026-01-22

**Analysis Timestamp:** 2026-01-22T05:55:01.313Z
**Market Context:** Bearish (mostly shorts)
**Total Trades:** 165 | **Total P&L:** $-14101.23

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| aggressive | 6 | 3 | 3 | 50% | +$131.44 | +$21.91 |
| standard-05cb | 8 | 4 | 4 | 50% | +$69.73 | +$8.72 |
| standard | 9 | 4 | 5 | 44% | +$5.14 | +$0.57 |
| Fixed TP/SL | 2 | 0 | 2 | 0% | +$0.00 | +$0.00 |
| spot-strict | 1 | 0 | 1 | 0% | $-0.08 | $-0.08 |
| spot-contrarian | 1 | 0 | 1 | 0% | $-0.08 | $-0.08 |
| spot-standard | 1 | 0 | 1 | 0% | $-0.08 | $-0.08 |
| spot-loose | 1 | 0 | 1 | 0% | $-0.23 | $-0.23 |
| aggressive-2cb | 8 | 2 | 6 | 25% | $-5.63 | $-0.70 |
| wide-2cb | 6 | 2 | 4 | 33% | $-9.35 | $-1.56 |
| Trail Light (1%) | 6 | 1 | 5 | 17% | $-25.67 | $-4.28 |
| focus-conservative | 2 | 0 | 2 | 0% | $-74.28 | $-37.14 |
| focus-hybrid | 4 | 2 | 2 | 50% | $-82.90 | $-20.72 |
| focus-excellent | 3 | 1 | 2 | 33% | $-89.91 | $-29.97 |
| focus-baseline | 5 | 2 | 3 | 40% | $-138.23 | $-27.65 |
| focus-conflict | 5 | 2 | 3 | 40% | $-140.61 | $-28.12 |
| focus-contrarian-only | 5 | 2 | 3 | 40% | $-145.04 | $-29.01 |
| shadow-10pct10x-sl8 | 10 | 3 | 7 | 30% | $-166.55 | $-16.66 |
| shadow-10pct10x-sl10 | 11 | 1 | 10 | 9% | $-167.05 | $-15.19 |
| Trail Standard (10x) | 11 | 1 | 10 | 9% | $-195.99 | $-17.82 |
| Trail Wide | 17 | 7 | 10 | 41% | $-205.66 | $-12.10 |
| Trail Aggressive (20x) | 9 | 2 | 7 | 22% | $-242.69 | $-26.97 |
| shadow-10pct10x-sl18 | 9 | 0 | 9 | 0% | $-244.47 | $-27.16 |
| shadow-10pct10x-sl15 | 9 | 0 | 9 | 0% | $-247.45 | $-27.49 |
| focus-aggressive | 11 | 4 | 7 | 36% | $-300.30 | $-27.30 |
| focus-kelly | 5 | 2 | 3 | 40% | $-11825.29 | $-2365.06 |

### Notable Winning Trades

- **aggressive**: GWEI +$262.38
- **standard-05cb**: GWEI +$148.86
- **standard**: GWEI +$141.70

### Observations

1. **Top performer:** aggressive with +$131.44 (50% win rate)
2. **Underperformer:** focus-kelly with $-11825.29
3. **Average win rate across all bots:** 23.5%

---

## 2026-01-22 (Comprehensive Analysis via Turso)

**Analysis Timestamp:** 2026-01-23T~15:00 UTC
**Market Context:** Bearish (mostly shorts), choppy conditions
**Total Closed Trades:** 528 | **Total P&L:** -$5,150.43
**Data Source:** Turso Database (Render production server)

### Performance by Bot Category

| Category | Closed | Win Rate | Total PnL | Avg PnL |
|----------|--------|----------|-----------|---------|
| **Experimental A/B** | 48 | 50.0% | **+$775.32** | +$32.31 |
| **Spot Regime** | 16 | 43.8% | **+$42.10** | +$2.63 |
| Golden Pocket | 8 | 0.0% | -$50.94 | -$6.37 |
| Trailing Shadow | 72 | 23.6% | -$999.24 | -$13.88 |
| **Focus Mode Shadow** | 155 | **76.8%** | -$1,393.80 | -$8.99 |
| Backburner Trailing | 229 | 31.9% | -$3,523.87 | -$15.46 |

### 🏆 Top Performer: exp-bb-sysB

| Bot ID | Trades | Win Rate | Total PnL | Avg PnL |
|--------|--------|----------|-----------|---------|
| **exp-bb-sysB** | 44 | 50.0% | **+$677.20** | +$30.78 |
| exp-gp-sysB | 2 | 50.0% | +$49.06 | +$49.06 |
| exp-gp-sysA | 2 | 50.0% | +$49.06 | +$49.06 |

**exp-bb-sysB Configuration:**
- Uses System B bias filter (multi-indicator, not RSI-only)
- NO regime filter (trades all quadrants)
- Backburner signals as entry source
- 20x leverage, 10% position size, 8% initial stop, 10% trail trigger

### Focus Mode Shadow Bots (Detailed)

| Bot ID | Trades | Wins | Losses | Win Rate | Total PnL | Avg PnL |
|--------|--------|------|--------|----------|-----------|---------|
| **focus-conservative** | 11 | 9 | 2 | **81.8%** | **+$40.84** | +$3.71 |
| **focus-contrarian-only** | 4 | 4 | 0 | **100%** | **+$40.54** | +$10.13 |
| focus-excellent | 16 | 13 | 3 | 81.3% | +$10.51 | +$0.66 |
| focus-aggressive | 44 | 36 | 8 | 81.8% | -$21.34 | -$0.49 |
| focus-hybrid | 21 | 15 | 6 | 71.4% | -$39.27 | -$1.87 |
| focus-baseline | 23 | 17 | 6 | 73.9% | -$50.00 | -$2.17 |
| focus-conflict | 24 | 17 | 7 | 70.8% | -$53.65 | -$2.24 |
| **focus-kelly** | 12 | 8 | 4 | 66.7% | **-$1,321.42** | -$110.12 |

### Exit Reason Analysis (Focus Mode)

| Exit Reason | Count | Wins | Win Rate | Total PnL |
|-------------|-------|------|----------|-----------|
| trailing_stop | 121 | 115 | **95.0%** | **+$1,591.56** |
| take_profit | 4 | 4 | 100% | +$82.82 |
| regime_conflict | 2 | 0 | 0% | -$7.30 |
| stop_loss | 28 | 0 | 0% | **-$3,060.88** |

**Critical Insight:** Trailing stops are working extremely well (95% win rate). Stop losses are the entire source of losses.

### Spot Regime Bots (All Profitable)

| Bot ID | Trades | Wins | Win Rate | Total PnL | Avg PnL |
|--------|--------|------|----------|-----------|---------|
| spot-standard | 5 | 3 | 60.0% | +$17.29 | +$3.46 |
| spot-strict | 4 | 2 | 50.0% | +$12.90 | +$3.22 |
| spot-contrarian | 3 | 1 | 33.3% | +$6.07 | +$2.02 |
| spot-loose | 4 | 1 | 25.0% | +$5.84 | +$1.46 |

### Key Observations

1. **exp-bb-sysB is the clear winner** - System B multi-indicator bias filter + Backburner signals
2. **Focus Mode has excellent win rates** (66-100%) but losses are too large
3. **Kelly criterion sizing is CATASTROPHIC** - disabled immediately recommended
4. **focus-contrarian-only and focus-conservative are the only profitable Focus variants**
5. **Spot regime bots (1x leverage) are consistently profitable** - low risk, low reward
6. **Stop losses account for -$3,060 of the -$1,393 Focus Mode loss**

### Data Collection Gap Identified

**BULL+BULL quadrant was NOT being tested** despite dashboard claiming it's "HIGH WIN RATE" for shorts.
- Added `focus-euphoria-fade` bot to test this claim
- Added `focus-bull-dip` bot for BULL+BEAR (buy dips in uptrend)
- Added `focus-full-quadrant` bot for comprehensive quadrant data

### Multi-Day Trend

| Date | Events | Closes | Total PnL |
|------|--------|--------|-----------|
| Jan 23 (partial) | 337 | 163 | -$846.91 |
| **Jan 22** | 1,286 | 528 | **-$5,150.43** |
| Jan 21 | 1,567 | 528 | -$13,599.95 |
| Jan 20 | 518 | 214 | +$76.15 |
| Jan 19 | 408 | 153 | -$3,501.98 |

---

## 2026-01-23 (Partial Day via Turso)

**Analysis Timestamp:** 2026-01-23T~15:00 UTC
**Total Closed Trades:** 163 | **Total P&L:** -$846.91
**Data Source:** Turso Database (Render production server)

### Focus Mode Early Results

| Bot ID | Trades | Wins | Win Rate | Total PnL |
|--------|--------|------|----------|-----------|
| focus-kelly | 2 | 2 | 100% | +$132.29 |
| focus-excellent | 4 | 4 | 100% | +$41.68 |
| focus-baseline | 6 | 5 | 83.3% | +$0.87 |
| focus-conflict | 6 | 5 | 83.3% | +$0.87 |
| focus-hybrid | 6 | 5 | 83.3% | +$0.87 |
| focus-contrarian-only | 2 | 1 | 50% | -$35.84 |
| focus-aggressive | 11 | 8 | 72.7% | -$132.04 |

**Note:** Kelly bot showing recovery but small sample size. Monitoring continues.

---

## 2026-01-25

**Analysis Timestamp:** 2026-01-25T05:55:02.192Z
**Market Context:** Mixed
**Total Trades:** 42 | **Total P&L:** +$1312.57

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
| exp-bb-sysB | 12 | 6 | 6 | 50% | +$389.61 | +$32.47 |
| Trail Wide | 2 | 2 | 0 | 100% | +$192.61 | +$96.31 |
| aggressive | 2 | 1 | 1 | 50% | +$128.37 | +$64.18 |
| Trail Aggressive (20x) | 1 | 1 | 0 | 100% | +$124.76 | +$124.76 |
| focus-aggressive | 4 | 3 | 1 | 75% | +$94.18 | +$23.55 |
| standard-05cb | 2 | 2 | 0 | 100% | +$77.02 | +$38.51 |
| standard | 2 | 1 | 1 | 50% | +$64.47 | +$32.23 |
| shadow-10pct10x-sl8 | 1 | 1 | 0 | 100% | +$59.35 | +$59.35 |
| focus-baseline | 3 | 3 | 0 | 100% | +$32.13 | +$10.71 |
| focus-conflict | 3 | 3 | 0 | 100% | +$32.13 | +$10.71 |
| focus-full-quadrant | 3 | 3 | 0 | 100% | +$32.13 | +$10.71 |
| focus-excellent | 2 | 2 | 0 | 100% | +$25.49 | +$12.74 |
| focus-hybrid | 2 | 2 | 0 | 100% | +$25.49 | +$12.74 |
| exp-bb-sysB-contrarian | 2 | 1 | 1 | 50% | +$22.98 | +$11.49 |
| focus-conservative | 1 | 1 | 0 | 100% | +$11.84 | +$11.84 |

### Notable Winning Trades

- **exp-bb-sysB**: CYBER +$137.38
- **Trail Wide**: CYBER +$124.76
- **aggressive**: CYBER +$135.53

### Observations

1. **Top performer:** exp-bb-sysB with +$389.61 (50% win rate)
3. **Average win rate across all bots:** 85.0%
