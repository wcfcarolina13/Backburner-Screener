# Backburner Data Analysis Notes

This document tracks known issues, bug fixes, and data quality notes for historical analysis.

---

## Bug Fixes

### 2026-01-09: Entry Cost Double-Counting Fix

**Issue:** The `totalPnL` metric in bot stats was double-counting entry costs, making P&L appear worse than actual performance.

**Root Cause:**
1. Entry costs were deducted from balance when opening a position: `this.balance -= margin + entryCosts`
2. Entry costs were ALSO included in `totalCosts` and subtracted from `realizedPnL` at close: `realizedPnL = rawPnL - totalCosts`
3. The `realizedPnL` (with entry costs already subtracted) was then added back to balance

This meant entry costs were subtracted twice from the P&L calculation.

**Affected Bots:**
- Trail Light (trailing1pct)
- Trail Standard (trailing10pct10x)
- Trail Aggressive (trailing10pct20x)
- Trail Wide (trailWide)
- Triple Light (tripleLight)

**Non-Affected Bots:**
- Fixed 20/20 (fixedTP) - no execution cost modeling
- BTC Contrarian (btcExtreme) - no execution cost modeling
- BTC Momentum (btcTrend) - no execution cost modeling
- Confluence (confluence) - no execution cost modeling
- Trend Override (trendOverride) - no execution cost modeling
- Trend Flip (trendFlip) - no execution cost modeling

**Impact on Historical Data:**
- `currentBalance` is CORRECT and reflects true performance
- `totalPnL` is UNDERSTATED (shows worse than reality)
- To get true P&L for affected bots: `truePnL = currentBalance - 2000` (initial balance)

**Files Modified:**
- `src/paper-trading-trailing.ts`
- `src/triple-light-bot.ts`

**Example of Impact:**
Before fix, Trail Aggressive showed:
- Balance: $2,525.91 (correct)
- P&L: -$109.73 (wrong - should be +$525.91)

The discrepancy was the double-counted entry costs across all closed positions.

---

## Data Collection Notes

### Session Continuity
- Data is collected in real-time to JSON files in `data/` subdirectories
- Each day gets a new file (YYYY-MM-DD.json format)
- Analysis can be run at any time without stopping the screener
- Server restarts will reset bot state but historical data files are preserved

### Bot State vs Historical Data
- Bot stats (balance, P&L, positions) are in-memory and reset on restart
- Trade events logged to `data/trades/` are permanent
- Signal events logged to `data/signals/` are permanent
- Market snapshots logged to `data/market/` are permanent

---

## Analysis Best Practices

1. **Always check currentBalance for true performance** - especially for trailing stop bots before 2026-01-09 fix
2. **Compare multiple metrics** - win rate, trade count, balance change, not just totalPnL
3. **Account for unrealized P&L** - open positions aren't in totalPnL until closed
4. **Consider execution costs** - bots with cost modeling show more realistic results
5. **Check for session breaks** - server restarts will show discontinuities in bot state
