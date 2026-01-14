# Backburner Strategy Learnings

A running log of insights, edge cases, and lessons learned from running the Backburner screener.

---

## 2025-01-14: ZEN_USDT "Wrong Direction" Signal

### What Happened
- ZEN_USDT was flagged as a **SHORT** setup
- At the time, ZEN appeared to be in an uptrend on the 4H chart (bullish structure)
- The signal looked "wrong" - shorting an uptrending coin doesn't match the Backburner strategy

### The Twist
- ZEN actually DID pull back ~17-20% after the signal (from ~$12 to ~$10)
- The "wrong" signal would have been profitable!

### Why We Didn't Change the Strategy
The signal worked by **coincidence**, not by **methodology**:

1. **HTF was bullish** - The 4H showed higher highs and higher lows, price above rising MAs
2. **No clean down impulse** - The "down impulse" detected was choppy consolidation, not a dominant move
3. **TradingView showed bullish divergence** - RSI was recovering from oversold, buyers regaining control
4. **Risk/Reward** - Even if it worked this time, shorting bullish HTF structure is lower probability over time

### The Principle
> A signal that happens to work doesn't validate the methodology. We want signals that work **because** the setup was correct, not by accident.

### Changes Made (for signal quality)
1. **HTF Trend Enforcement** - Now REJECT (not just mark) setups that fight the higher timeframe trend
2. **Impulse Dominance Scoring** - Require >50% of candles to move in impulse direction (filters choppy consolidation)
3. **Recency Check** - Impulse end must be in last 50% of lookback period

### Decision
**Prioritize signal quality over signal quantity.** Fewer, higher-conviction setups > more signals with mixed quality.

---

## Template for Future Learnings

### Date: [YYYY-MM-DD] - [Title]

**What Happened:**
-

**Analysis:**
-

**Decision:**
-

**Changes Made (if any):**
-
