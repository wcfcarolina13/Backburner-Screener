---
task: Audit & Hardening of Paper Trade Simulation Logic (Market Friction)
test_command: "cd /sessions/compassionate-funny-cerf/mnt/gemini_projects/Backburner && npm run build"
---

# Task: Audit & Hardening of Paper Trade Simulation Logic

**Priority**: High (Critical for Strategy Validation)

**Context**: The current paper trading engine may be over-optimizing results by executing at "Chart Price" rather than "Order Book Price." To validate the viability of the high-leverage (20x) scalping strategy on MEXC, we must introduce synthetic friction (spread, slippage, latency) to align simulation data with live market conditions.

---

## Phase 1: Discovery & Audit ✅ COMPLETE

Scan the current execution/backtest modules to determine current state.

### Success Criteria

1. [x] **Audit Execution Timing**
   - Does the bot execute orders on the same tick/candle that the signal is generated?
   - Goal: Identify if we are "looking ahead" or reacting instantly without latency
   - **FINDINGS**:
     - ✅ `paper-trading-trailing.ts` & `mexc-trailing-simulation.ts`: Execute at signal time (same tick)
     - ⚠️ NO "next tick" delay implemented - all bots enter at `setup.currentPrice` immediately
     - The MEXC sim and trailing bots DO track entry costs upfront

2. [x] **Audit Price Logic**
   - Does `entry_price` equal `close_price` or `current_price`?
   - Are we distinguishing between `Bid` (Sell) and `Ask` (Buy) prices, or using a single price feed?
   - **FINDINGS**:
     - ✅ Entry uses `setup.currentPrice` (latest close from candles)
     - ⚠️ Single price feed - NO bid/ask spread distinction
     - ✅ `execution-costs.ts` EXISTS with slippage modeling that applies direction-aware penalties:
       - Long entry: `price * (1 + slippage)` (buy at higher)
       - Long exit: `price * (1 - slippage)` (sell at lower)
       - Short entry: `price * (1 - slippage)` (sell at lower)
       - Short exit: `price * (1 + slippage)` (buy back higher)

3. [x] **Audit Fee/Drag Calculations**
   - Are fees (Maker/Taker) currently deducted from PnL?
   - Is there any existing variable for slippage?
   - **FINDINGS**:
     - ✅ `execution-costs.ts` module ALREADY EXISTS with comprehensive cost modeling:
       - Maker fee: 0.02%, Taker fee: 0.04%
       - Base slippage: 2 bps (0.02%), max 20 bps (0.20%)
       - Volatility multiplier: 1.5x for high volatility
       - Size impact: +0.5bp per $10k notional
       - Funding rate modeling (0.01% per 8h default)
     - ✅ `paper-trading-trailing.ts`: Uses `ExecutionCostsCalculator` for entry/exit costs
     - ✅ `mexc-trailing-simulation.ts`: Uses `ExecutionCostsCalculator` for entry/exit costs
     - ❌ `paper-trading.ts`: NO cost modeling (basic fixed TP/SL bot)
     - ❌ `golden-pocket-bot.ts`: NO cost modeling

---

## Phase 2: Implementation (The "Reality Patch")

Based on the audit, several features ALREADY EXIST. Only gaps need to be filled.

### Success Criteria

4. [x] **Implement "Round Trip" Spread Penalty** - ALREADY EXISTS
   - ✅ `execution-costs.ts` already implements direction-aware spread/slippage:
     - `calculateEffectiveEntryPrice()`: Long buys higher, Short sells lower
     - `calculateEffectiveExitPrice()`: Long sells lower, Short buys higher
   - ✅ Used in `paper-trading-trailing.ts` and `mexc-trailing-simulation.ts`
   - ❌ NOT used in `golden-pocket-bot.ts` or basic `paper-trading.ts`
   - **ACTION**: Add execution costs to GP bot and basic paper trading

5. [x] **Implement Volatility-Based Slippage** - ALREADY EXISTS
   - ✅ `execution-costs.ts` has `calculateSlippageBps()` with:
     - `volatilityMultiplier`: 1.5x for high volatility
     - `sizeImpactFactor`: +0.5bp per $10k notional
     - `VolatilityState`: 'low' | 'normal' | 'high' | 'extreme'
     - `determineVolatility()` helper based on RSI and price change
   - ✅ Used in trailing bots
   - **ACTION**: Increase BASE_SPREAD from 2bps to 15bps per Gemini's recommendation

6. [ ] **Implement "Next Tick" Execution**
   - Currently all bots execute at `setup.currentPrice` (same tick)
   - If Signal is generated at `Time(T)`, Execution must occur at `Time(T+1)` (next candle open)
   - **ACTION**: Add optional `FORCE_NEXT_TICK` mode that queues orders for next price update
   - This is the main missing feature

7. [x] **Refactor ROI Trigger Logic** - ALREADY CORRECT
   - ✅ `paper-trading-trailing.ts` already uses raw PnL for trailing thresholds
   - ✅ The `unrealizedPnL` INCLUDES entry costs and estimated exit costs
   - ✅ Trailing triggers use `rawPnL / margin` for ROI calculation
   - Current behavior is correct: costs reduce final PnL but don't affect trigger timing
   - **NOTE**: The current approach is actually better than Net ROI triggers because it prevents over-trading on noise while still accounting for costs in final P&L

---

## Phase 3: Configuration & Constants

8. [x] **Add Friction Config** - ALREADY EXISTS, NEEDS TUNING
   - ✅ `execution-costs.ts` has `DEFAULT_EXECUTION_COSTS` config:
     ```typescript
     fees: {
       makerFee: 0.0002,   // 0.02%
       takerFee: 0.0004,   // 0.04%
     },
     slippage: {
       baseSlippageBps: 2,           // 0.02% base (GEMINI WANTS 15bps = 0.15%)
       volatilityMultiplier: 1.5,
       sizeImpactFactor: 0.5,
       minSlippageBps: 1,
       maxSlippageBps: 20,
     },
     funding: {
       defaultRatePercent: 0.01,
       extremeRatePercent: 0.1,
       intervalHours: 8,
     },
     enabled: true,
     ```
   - **ACTION**: Update `baseSlippageBps` from 2 to 15 per Gemini's conservative estimate

---

## Phase 4: Validation

9. [ ] **All tests pass**: Run `npm run build` successfully with no errors

10. [x] **Logging Verification** - ALREADY EXISTS
    - ✅ Trailing bot logs show `@ ${effectiveEntryPrice.toPrecision(5)} (mkt: ${entryPrice.toPrecision(5)})`
    - ✅ Close logs show `Raw: $X | Costs: $Y | Net: $Z`
    - **NOTE**: Basic paper trading and GP bots don't have this logging yet

11. [ ] **Code is committed**: All changes committed with descriptive messages

---

## Remaining Work Summary

### Must Do (Gemini's Gaps):
1. [ ] **Add execution costs to `golden-pocket-bot.ts`**
2. [ ] **Add execution costs to `paper-trading.ts`** (or document it as "idealized baseline")
3. [ ] **Increase `baseSlippageBps` from 2 to 15** (0.02% → 0.15%)
4. [ ] **Optional: Implement "Next Tick" execution mode**

### Already Done (No Changes Needed):
- ✅ Round-trip spread penalty (direction-aware slippage)
- ✅ Volatility-based slippage multiplier
- ✅ Fee deduction (maker/taker)
- ✅ Funding rate modeling
- ✅ Size impact on slippage
- ✅ Cost tracking in logs

---

## Acceptance Criteria Summary

1. **PnL Reduction**: ✅ Already happening - trailing bots show Raw vs Net PnL
2. **Visual Check**: ✅ Already shows signal price vs executed price
3. **Survival Check**: Increasing base slippage will require stronger moves

---

## Technical Context

### Key Files
- `src/execution-costs.ts` - **CORE** - Already comprehensive, needs tuning
- `src/paper-trading-trailing.ts` - ✅ Uses execution costs
- `src/mexc-trailing-simulation.ts` - ✅ Uses execution costs
- `src/golden-pocket-bot.ts` - ❌ Needs execution costs added
- `src/paper-trading.ts` - ❌ Needs execution costs added (or documented as baseline)

---

## Ralph Instructions

1. Work on the next incomplete criterion (marked `[ ]`)
2. Check off completed criteria (change `[ ]` to `[x]`)
3. Run the test_command after changes
4. Commit your changes frequently with descriptive messages
5. Update `.ralph/progress.md` with what you accomplished
6. When ALL criteria are `[x]`, say: **"RALPH COMPLETE - all criteria satisfied"**
7. If stuck 3+ times on same issue, say: **"RALPH GUTTER - need fresh context"**
