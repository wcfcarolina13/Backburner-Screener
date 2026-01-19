# V2 Changelog - Exit Strategy Overhaul

**Date:** January 19, 2026
**Problem:** System was mathematically guaranteed to lose money

## The Math Problem (V1)

From analysis of last 3 days of trading data:

| Metric | Value |
|--------|-------|
| Win Rate | 31.8% (5m timeframe) |
| Avg Win | $33.41 |
| Avg Loss | $37.35 |
| Reward:Risk | 0.89:1 |

**Expected Value per Trade (V1):**
```
(0.318 × $33.41) - (0.682 × $37.35) = -$14.85 per trade
```

The more you traded, the more you lost. Mathematically guaranteed.

## Critical Finding: BTC Bias Bots

BTC Bias bots had **0% win rate** and were responsible for **40% of all losses** (~$7,459).

## V2 Changes

### 1. BTC Bias Bots - REMOVED
- All 8 BTC Bias V2 variants disabled
- 0% win rate made them pure money burners

### 2. Timeframe Filter - 5m ONLY
- Changed from `['5m', '15m']` to `['5m']`
- 5m had best win rate (31.8%)
- 15m was marginal, 1h was terrible (0% longs)

### 3. Stop Loss - TIGHTENED (20% → 12%)
- Reduces average loss size
- Gets you out of bad trades faster
- Target: avg loss drops from $37 to ~$22

### 4. Take Profit - WIDENED (20% → 35%)
- Lets winners run further
- Better captures momentum moves
- Target: avg win rises from $33 to ~$50

### 5. Trail Parameters - ADJUSTED
- Trail trigger: 10% → 8% (start trailing sooner)
- Trail step: 10% → 8% (tighter trailing)
- Breakeven trigger: 10% → 8%

### 6. Shadow Bots - RECONFIGURED
- Now testing: 8%, 10%, 15%, 18% stops
- Removed: 25%, 30% (too loose)
- Purpose: Find optimal stop level for V3

## Expected V2 Math

With 12% SL and 35% TP:
- R:R Ratio: 35/12 = **2.9:1**
- Required win rate to break even: **26%**
- Current 5m win rate: **31.8%**

**Expected Value per Trade (V2):**
```
(0.318 × $50) - (0.682 × $22) = $15.90 - $15.00 = +$0.90 per trade
```

Not getting rich, but at least positive expected value.

## Files Changed

- `src/web-server.ts` - All bot configurations updated

## Rollback

To rollback to V1:
```bash
git checkout v1-baseline -- src/web-server.ts
npm run build
```

## Next Steps

1. Monitor V2 performance for 3-5 days
2. Analyze shadow bot data to find optimal stop level
3. Consider V3 with:
   - Dynamic stops based on ATR
   - Better entry filtering (divergence confirmation)
   - Partial profit taking at 1R
