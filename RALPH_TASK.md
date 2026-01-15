---
task: Forensic Backtest on 24h Dataset (Friction Stress Test)
test_command: "cd /sessions/compassionate-funny-cerf/mnt/gemini_projects/Backburner && npm run build"
---

# Task: Forensic Backtest on 24h Dataset (Friction Stress Test)

**Priority**: Immediate

**Context**: We have ~24 hours of market data collected. We must run the strategy logic against this dataset, applying the new "Market Friction" parameters (Spread, Slippage, Latency) to determine if the theoretical Alpha survives real-world drag.

**Key Insight**: Standard backtesting (checking "Close" price) lies to scalpers. We need to simulate the sequence of events INSIDE the candle.

---

## Phase 1: Data Discovery & Suitability Check

### Success Criteria

1. [x] **Locate the collected data**
   - ✅ Local data in `data/signals/` and `data/trades/`
   - **Signals**: 181 total, 48 triggered (Jan 14-15)
   - **Trades**: 305 events, 39 closed trades
   - **Total PnL**: -$11,228.45 (significant losses!)
   - **Symbols with triggers**: 11 unique symbols

2. [x] **Granularity Check**
   - ⚠️ We have EVENT LOGS (signal triggers, trade opens/closes) - NOT raw candle data
   - Signal timeframes: 5m, 15m, 1h
   - **ACTION NEEDED**: Must fetch 1m candles from MEXC for forensic analysis
   - Without 1m data, we cannot apply "wick priority" rule properly

3. [ ] **Volume Check for each asset**
   - Need to fetch 24h volume from MEXC for these symbols:
     - MERLUSDT, RIVERUSDT, XMRUSDT, BARDUSDT, ZENUSDT
     - TRUMPUSDT, FARTCOINUSDT, MAGICUSDT, UNIUSDT, WLFIUSDT, EIGENUSDT
   - Flag low-volume assets for extra slippage

---

## Phase 2: Build the Forensic Backtester

Create a new file `src/forensic-backtest.ts` implementing conservative assumptions.

### Success Criteria

4. [ ] **Implement "Next Open" Execution (Latency Simulation)**
   - Signal generated at Candle `T` (using Close price)
   - Execution MUST fill at Candle `T+1` (Open Price)
   - Rationale: We cannot buy at the price that triggered the signal

5. [ ] **Implement "Wick Priority" Rule (CRITICAL)**
   - Scenario: Single candle hits both Take Profit (High) AND Stop Loss (Low)
   - Logic: If `Low <= Stop_Loss` AND `High >= Take_Profit` in same candle:
     - **ASSUME LOSS** - price wicked down, stopped out, then recovered
     - Record as Max Loss (e.g., -20% ROI on margin)
   - This is the most important conservative assumption

6. [ ] **Apply Friction Math**
   - Use `execution-costs.ts` for calculations
   - Simulated Entry: `T+1_Open * (1 + spread + slippage)`
   - Simulated Exit: `Exit_Price * (1 - spread - slippage)`
   - Include fees in all calculations

7. [ ] **Track "Ghost" Trades (Near Misses)**
   - Identify where `Raw_Signal = TRUE` but `Adjusted_PnL` would be negative
   - These are trades killed by friction
   - Count and log them separately

---

## Phase 3: Run the Backtest

### Success Criteria

8. [ ] **Fetch 1m candle data for backtest period**
   - For each symbol that had signals in the 24h period
   - Fetch 1m candles from MEXC API covering that timeframe
   - Store locally for reproducibility

9. [ ] **Run backtest with both configurations**
   - Run 1: "Paper" mode (no friction, instant fills at signal price)
   - Run 2: "Friction" mode (spread, slippage, next-tick execution, wick priority)
   - Compare results side-by-side

---

## Phase 4: Output Report

10. [ ] **Generate comparison report**

Required output format:
```
[Backtest Results: 24h Friction Test]
-------------------------------------
Data Period:         [Start] - [End]
Symbols Analyzed:    [Count]
Total Signals:       [Count]
Executed Trades:     [Count] (After filtering)

Raw PnL (Paper):     $[Amount] (Assuming perfect fills)
Real PnL (Friction): $[Amount] (With spread/slippage/latency)
Friction Drag:       [%] (How much friction ate)

Win Rate Adjustment:
- Paper Win Rate:    [%]
- Real Win Rate:     [%] (Did friction turn small wins into losses?)

Ghost Trades:        [Count] (Signals killed by friction)

Survivability:
- Max Drawdown:      [%]
- Wick Ambiguity:    [Count] (Candles where TP & SL both hit)
- Assumed Losses:    [Count] (From wick priority rule)

Verdict: [VIABLE / MARGINAL / NOT VIABLE]
```

11. [ ] **All code committed with descriptive messages**

---

## Technical Notes

### Existing Infrastructure
- `execution-costs.ts` - Already has friction calculations (just increased to 15bps base)
- `paper-trading-trailing.ts` - Has cost-aware P&L logic
- Turso database - May have signal/trade history
- MEXC API - Can fetch historical 1m candles

### Key Files to Create/Modify
- `src/forensic-backtest.ts` - NEW - Main backtest engine
- `src/backtest-report.ts` - NEW - Report generation
- May need to add 1m candle fetching to `mexc-api.ts`

### Conservative Assumptions Summary
1. **Latency**: Execute at T+1 Open, not T Close
2. **Wick Priority**: If both TP and SL hit in same candle, assume loss
3. **Friction**: 15bps spread + slippage + fees on every trade
4. **Volume**: Extra slippage for low-volume assets

---

## Ralph Instructions

1. Work on the next incomplete criterion (marked `[ ]`)
2. Check off completed criteria (change `[ ]` to `[x]`)
3. Run the test_command after changes
4. Commit your changes frequently with descriptive messages
5. Update `.ralph/progress.md` with what you accomplished
6. When ALL criteria are `[x]`, say: **"RALPH COMPLETE - all criteria satisfied"**
7. If stuck 3+ times on same issue, say: **"RALPH GUTTER - need fresh context"**
