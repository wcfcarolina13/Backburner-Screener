# Kelly Criterion Position Sizing Experiment - FAILED

**Bot ID:** `focus-kelly`
**Created:** January 21, 2026
**Removed:** January 23, 2026
**Result:** CATASTROPHIC LOSS - Do not use

---

## What Kelly Criterion Is

The Kelly Criterion is a formula for calculating optimal bet size:

```
f* = (bp - q) / b

where:
  f* = fraction of bankroll to bet
  b  = odds ratio (reward / risk)
  p  = probability of winning
  q  = probability of losing (1 - p)
```

In trading: if you know your win rate and risk/reward ratio, Kelly tells you the "optimal" position size to maximize long-term growth.

---

## How It Was Implemented

```typescript
// From focus-mode-shadow-bot.ts
const estimatedWinRate = signal.qualityScore / 100 * 0.6;  // Scale quality to estimated win rate
const rewardRiskRatio = (signal.suggestedTakeProfit - signal.entryPrice) /
                        Math.abs(signal.entryPrice - signal.suggestedStopLoss);
const kellyFraction = (rewardRiskRatio * estimatedWinRate - (1 - estimatedWinRate)) / rewardRiskRatio;
const safeFraction = Math.max(0, Math.min(kellyFraction * 0.5, 0.25));  // Half-Kelly, max 25%
margin = availableBalance * safeFraction;
```

Safety measures included:
- **Half-Kelly**: Only bet half the suggested fraction
- **25% cap**: Never bet more than 25% of balance
- **Available balance**: Used available (not total) balance

---

## Why It Failed

### Performance Data (Jan 21-23, 2026)

| Metric | Value |
|--------|-------|
| Total Trades | 14 |
| Wins | 10 |
| Losses | 4 |
| Win Rate | **71.4%** |
| Total P&L | **-$1,321.42** |
| Avg Win | +$132 |
| Avg Loss | **-$462** |

### The Core Problem

**Win rate was high but losses were catastrophic because:**

1. **Estimated win rate was fiction**
   - Formula: `signal.qualityScore / 100 * 0.6`
   - This guesses win probability from a "quality score" with no proven correlation to actual outcomes
   - Higher quality score = bigger bet, but quality score didn't predict wins

2. **"High quality" signals got bigger bets**
   - Kelly bet big on trades it thought were "excellent"
   - When those trades lost, they lost BIG
   - 4 losses at ~$462 avg = $1,848 lost
   - 10 wins at ~$132 avg = $1,320 gained
   - Net: -$528 (plus fees = -$1,321)

3. **R:R ratios were theoretical**
   - Used `suggestedTakeProfit` and `suggestedStopLoss`
   - These were targets, not actual exit prices
   - Reality diverged significantly from theory

### Comparison to Fixed Position Sizing

| Bot | Win Rate | Total P&L | Avg Loss |
|-----|----------|-----------|----------|
| focus-kelly | 71.4% | **-$1,321** | -$462 |
| focus-conservative | 81.8% | **+$40.84** | -$85 |
| focus-contrarian-only | 100% | **+$40.54** | $0 |

Conservative bot with 0.75x fixed sizing was profitable with similar conditions.

---

## Key Learnings

### 1. Kelly Requires Accurate Edge Estimation
You cannot estimate win probability from "setup quality" without extensive backtesting to prove correlation. We didn't have this data.

### 2. Small Sample = Huge Variance
With 14 trades, a single bad loss can wipe out 10 wins. Kelly amplifies this by betting more on "high confidence" plays.

### 3. Half-Kelly Isn't Safe Enough
Even with half-Kelly and 25% cap, variance was too high. Some sources recommend quarter-Kelly or less.

### 4. Fixed Position Sizing Is Safer
The conservative bot (fixed 5% of available balance) outperformed Kelly despite lower win rate. Consistency > optimization.

---

## When Kelly MIGHT Work

Kelly criterion can work when:
- You have **thousands** of historical trades proving your edge
- Win rate and R:R are **stable** over time
- You can handle **50%+ drawdowns** (Kelly's historical volatility)
- You're in a **casino/sports betting** context where odds are known

For discretionary trading or new strategies, stick to fixed position sizing (5-10% of balance).

---

## Code Location

The Kelly sizing code remains in `src/focus-mode-shadow-bot.ts`:
- `useKellySizing: boolean` config option (default: false)
- `createKellySizingBot()` factory function

The bot is no longer instantiated in `web-server.ts` but the code is preserved for reference.

---

## Related Files

- `src/focus-mode-shadow-bot.ts` - Contains Kelly implementation
- `data/docs/SHADOW_BOT_STRATEGY_GUIDE.md` - Updated with warning
- `data/analysis/daily-performance-log.md` - Contains performance data
