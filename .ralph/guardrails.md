# Ralph Guardrails (Signs)

> Lessons learned from past failures. READ THESE BEFORE ACTING.

## Core Signs

### Sign: Read Before Writing
- **Trigger**: Before modifying any file
- **Instruction**: Always read the existing file first to understand context
- **Added after**: Core principle

### Sign: Test After Changes
- **Trigger**: After any code change
- **Instruction**: Run tests to verify nothing broke
- **Added after**: Core principle

### Sign: Commit Checkpoints
- **Trigger**: Before risky changes
- **Instruction**: Commit current working state first
- **Added after**: Core principle

### Sign: One Task Focus
- **Trigger**: When context grows large
- **Instruction**: Focus on single criterion, complete it, commit, move on
- **Added after**: Core principle

### Sign: Update Progress
- **Trigger**: After completing any criterion
- **Instruction**: Update .ralph/progress.md AND check off the criterion in RALPH_TASK.md
- **Added after**: Core principle

---

## Learned Signs

### Sign: Double-Escape Quotes in Template Literals
- **Trigger**: When building HTML with onclick handlers inside a template literal (backticks)
- **Instruction**: Use `\\'` not `\'` for quotes inside onclick attributes. Single escape gets consumed by the template literal, leaving unescaped quotes in browser output.
- **Added after**: Iteration 2 - toggleGpFilter('watching') broke because `\'` became `'` in output, causing "Unexpected identifier" JS error

### Sign: Check for Duplicate HTML Tags
- **Trigger**: When editing large template literal HTML blocks (especially around section boundaries)
- **Instruction**: After editing, search for duplicate tags like `<script><script>` or `</div></div>`. These cause JavaScript parsing errors ("SyntaxError: Unexpected token '<'") and break functionality without obvious errors.
- **Added after**: Iteration 15 - GUI showed "Connecting..." forever because duplicate `<script>` tag at line 3301-3302 caused JS parsing failure

### Sign: Test SSE Endpoints After Changes
- **Trigger**: When modifying web-server.ts HTML generation or event broadcasting
- **Instruction**: Test the `/events` SSE endpoint with `curl -s -N "http://localhost:3000/events" | head -50` to verify JSON events are being sent correctly
- **Added after**: Iteration 15 - SSE connection appeared broken but was actually working; the client-side JS couldn't parse events due to HTML error

### Sign: Verify Data Flow End-to-End
- **Trigger**: When adding new data fields to track (especially for analytics)
- **Instruction**: Trace the FULL data flow: source → intermediate processing → persistence layer → database insert. A field can exist in code but never reach the database if any step in the chain doesn't pass it along.
- **Added after**: Iteration 28 - `entryQuadrant` field was being tracked in position objects and passed to `logTradeClose()`, but `insertTradeEvent()` wasn't including it in the SQL INSERT. Result: weeks of lost quadrant data.

### Sign: Test Dashboard Claims Against Bot Configs
- **Trigger**: When user-facing documentation/UI makes claims about strategy performance
- **Instruction**: Verify that at least ONE bot is actually testing the claimed strategy. Dashboard can show recommendations that no automated system is validating.
- **Added after**: Iteration 28 - Focus Mode dashboard said BULL+BULL shorts have "HIGH WIN RATE" but `allowedQuadrants` array excluded BULL+BULL from all 8 shadow bots. The claim was untested.

### Sign: Check Kelly Criterion Bots Daily
- **Trigger**: When any bot uses Kelly criterion or dynamic position sizing
- **Instruction**: Kelly sizing amplifies variance enormously. A bot can have 66% win rate but still lose catastrophically if losses are larger than wins. Monitor daily and disable if drawdown exceeds 50%.
- **Added after**: Iteration 28 - `focus-kelly` had 66.7% win rate but lost $1,321 in one day due to position sizing variance

### Sign: Playwright Gets Detected as Bot
- **Trigger**: When needing to automate login or interact with sites that have bot detection (MEXC, Google, etc.)
- **Instruction**: Don't use Playwright/Puppeteer/headless browsers for login flows. They get blocked by "Chrome for Testing" detection. Instead, use the real browser via Chrome extension + native messaging, or manual cookie export.
- **Added after**: Iteration 30 - MEXC blocked Playwright login with "This browser or app may not be secure"

### Sign: Chrome Native Messaging Needs Shell Wrapper on macOS
- **Trigger**: When implementing Chrome native messaging host
- **Instruction**: On macOS, Chrome requires the native host path to be a shell script, not a direct Node.js file. Use a `.sh` wrapper that calls `node script.js`. Also use `stdin.on('readable')` not `stdin.on('end')` for reading - Chrome keeps the pipe open.
- **Added after**: Iteration 30 - Native host kept timing out because it waited for stdin 'end' which Chrome doesn't send until after response

### Sign: MEXC Futures vol is Contracts, Not USD
- **Trigger**: When placing orders on MEXC futures API
- **Instruction**: The `vol` parameter in MEXC futures orders is the **number of contracts**, NOT a USD amount. Each contract has a `contractSize` (e.g., DOGE=100, BTC=0.0001, PROVE=1). Must fetch contract specs from `/api/v1/contract/detail` and convert: `contracts = floor(usdSize / (price * contractSize))`. Use `usdToContracts()` from mexc-futures-client.ts.
- **Added after**: Iteration 33 - Orders were passing USD amount (e.g., $5) directly as vol, resulting in wrong position sizes

### Sign: MEXC Rejects Zero SL/TP Prices
- **Trigger**: When sending stop-loss or take-profit prices to MEXC order API
- **Instruction**: Never send `stopLossPrice: 0` or `takeProfitPrice: 0` to MEXC. A value of 0 is semantically "no price" but MEXC interprets it as a literal price of $0, which is invalid. Always check for falsy values (`if (price)` not `if (price !== undefined)`) before including SL/TP in the order payload.
- **Added after**: Iteration 33 - PROVEUSDT order failed with "The price of stop-limit order error" because takeProfitPrice was 0

