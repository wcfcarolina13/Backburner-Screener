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

### Sign: Stop Loss Must Be ROI-Based, Not Price-Based (with Leverage)
- **Trigger**: When setting stop loss distance in any paper trading or shadow bot with leverage > 1x
- **Instruction**: A stop loss at "X% of price" with leverage Y means X*Y% ROI loss. At 20x leverage, an 8% price SL = 160% ROI loss, which is past liquidation. The correct formula: `SL_price_distance = entry * (SL_ROI_percent / 100 / leverage)`. Also ALWAYS add a liquidation check: `if (unrealizedPnlPercent <= -100) → liquidate`. Without this, paper bots report phantom profits from positions that would have been liquidated in reality.
- **Added after**: Iteration 35 - exp-bb-sysB reported +$7,140 PnL with 41.6% WR, but the 8% price SL at 20x leverage meant positions could survive -160% ROI and bounce back. Candle-based backtest showed the bot IS still profitable ($2,881) but with very different characteristics (43.6% WR, more SL exits).

### Sign: Recalculate SL When Capping Leverage
- **Trigger**: When enforcing a leverage cap on orders (e.g., `mexcMaxLeverage`)
- **Instruction**: If you cap leverage from X to Y, you MUST recalculate the SL price. The SL was calculated for leverage X, so capping to Y without adjustment makes the SL too tight. Formula: `newSlDistance = (|oldSL - entry| / entry) * (oldLeverage / cappedLeverage)`. At 20x, 8% ROE = 0.4% price distance. At 3x, same ROE = 2.67% price distance.
- **Added after**: Iteration 36 - exp-bb-sysB positions (NIL, SPX, SAHARA, GRASS, IP, PENDLE, etc.) were stopping out within 1-8 seconds. Bot calculated SL for 20x (0.4% distance), but `mexcMaxLeverage=3` capped leverage without recalculating SL. Result: 0.4% distance at 3x = only 1.2% ROE, easily triggered by normal volatility.

### Sign: TCG Insurance Sale Doesn't Help With Trailing Stops
- **Trigger**: When considering "sell half early, move SL to breakeven" strategy
- **Instruction**: If you already have a trailing stop system, adding an "insurance sale" at first bounce (1-3% ROE) HURTS performance. Backtest showed -42% to -44% worse results. The trailing stop already protects winners; insurance just cuts your winning trades in half.
- **Added after**: Iteration 37 - Backtested TCG's insurance sale strategy on 408 exp-bb-sysB trades. Current: $190.96 PnL. With insurance: $107-110 PnL. Insurance saved 62-99 trades from full losses but cost half of every big winner (+15% avg trailing stop wins).

### Sign: In-Memory State Resets on Server Restart
- **Trigger**: When tracking any data that needs to persist across server restarts (recent closes, win rates, stress detection, etc.)
- **Instruction**: NEVER rely solely on in-memory state for important data. Always bootstrap from Turso on startup. Any `Array<>` or `Map<>` that tracks historical data must be populated from the database at startup using `executeReadQuery()`. Otherwise, restarts wipe the data (e.g., stress detection showed `sampleSize: 0` after restart).
- **Added after**: Iteration 39 - Stress period detection relied on in-memory `recentCloses` array that reset on restart, causing insurance logic to never trigger.

### Sign: Field Name Case Sensitivity in TypeScript
- **Trigger**: When mapping between different interfaces (e.g., ClosedPosition → PaperPosition)
- **Instruction**: Check field name casing carefully. TypeScript interfaces in different parts of the codebase may use different conventions: `realizedPnl` vs `realizedPnL` (lowercase vs uppercase L). Using `as any` casts hides these mismatches, causing data to be logged as empty/null in the database.
- **Added after**: Iteration 39 - Paper trades logged to Turso with empty PnL because `ClosedPosition` used `realizedPnl` (lowercase) but `logTradeClose()` expected `realizedPnL` (uppercase).

### Sign: Turso Auth Token Required for Database Queries
- **Trigger**: When running scripts that query Turso locally
- **Instruction**: Local scripts need `TURSO_AUTH_TOKEN` environment variable. Check Render env vars or the deployed server for the token. The server gets it from Render's environment, not from local `.env`. For local testing, either: (1) export the token, (2) use the server's API endpoints instead of direct Turso queries.
- **Added after**: Iteration 39 - Script failed with HTTP 401 when trying to query Turso locally without auth token.

### Sign: Worktrees Are NOT Main — Check Before Deploying
- **Trigger**: When working in a git worktree (path contains `.claude-worktrees` or working directory differs from `/Users/roti/gemini_projects/Backburner`)
- **Instruction**:
  1. **Check your location**: Run `pwd` and `git branch --show-current` at the start of each session
  2. **Worktrees are sandboxes**: Changes in worktrees (e.g., `lucid-bardeen`) don't deploy until merged to `main`
  3. **To deploy**: Must merge worktree branch → main, then push main to GitHub
  4. **The correct flow**:
     ```bash
     # From worktree: commit changes
     git add -A && git commit -m "message"
     git push origin <branch-name>
     # From MAIN repo: merge and push
     cd /Users/roti/gemini_projects/Backburner
     git fetch origin && git merge origin/<branch-name>
     git push origin main
     ```
  5. **Never assume** the worktree branch IS main or that pushing the worktree deploys anything
  6. **Check Render URL**: Production is `backburner.onrender.com`, NOT `lucid-bardeen.onrender.com`
- **Added after**: Iteration 40 - Repeatedly confused worktree branch with main, tried to access wrong Render URL, and didn't realize changes weren't deployed. Wasted time debugging a "down" server that was actually just accessed at wrong URL.

### Sign: Use Server API Endpoints, Not Direct File Paths
- **Trigger**: When debugging running Render server
- **Instruction**: For Render deployments, use HTTP endpoints (e.g., `/api/export-trades`, `/api/debug/paper-vs-live`) rather than trying to read files or query Turso directly. The server is the authoritative source and has the tokens/connections. Before creating new endpoints, check what already exists by grepping for `app.get` or `app.post`.
- **Added after**: Iteration 39 - Tried multiple nonexistent endpoints before finding `/api/export-trades` already existed.

### Sign: Paper Trading PnL ≠ Real Exchange PnL — Always Verify Both
- **Trigger**: When analyzing bot performance or discussing PnL numbers
- **Instruction**: Paper simulation results can diverge SIGNIFICANTLY from actual exchange results due to: (1) execution slippage, (2) funding fees, (3) liquidation mechanics, (4) timing differences in SL/TP execution. NEVER trust paper PnL alone. Always compare with ACTUAL exchange data using `/api/debug/paper-vs-live` or checking real MEXC account. Query `bot_id='mexc-live'` for actual exchange results vs `bot_id LIKE 'exp-%'` for paper results.
- **Added after**: Iteration 41 - Paper simulation showed +$658 profit while actual MEXC showed -$22 loss over 48 hours (~$680 discrepancy). Root causes: (1) Real MEXC trades weren't being persisted to Turso, (2) Paper logs used paper margin sizes while calling it "live", (3) In-memory `mexcMirrorTracker` didn't persist across restarts.

### Sign: Verify Data Actually Reaches Database — Trace the Full Flow
- **Trigger**: When adding new data fields to track (especially for trade analytics)
- **Instruction**: Data flow from source to database has MULTIPLE failure points. A field can exist in logging statements but never reach Turso if ANY step breaks the chain: source → object creation → function call → SQL INSERT. When adding new tracking, verify by: (1) Check the INSERT statement includes the column, (2) Query Turso to confirm data is actually stored, (3) Don't trust console.log statements alone — they prove the code ran, not that data persisted.
- **Added after**: Iteration 41 - Real MEXC trade results were being logged to console (`[MEXC-SYNC]`) but never persisted to Turso. The code existed, ran, and logged — but the actual INSERT was missing.

### Sign: MEXC API Has Lag — Add Grace Periods for Position Detection
- **Trigger**: When checking if a position exists on MEXC immediately after execution
- **Instruction**: MEXC's `getOpenPositions()` API can take up to 30-60 seconds to reflect newly opened positions. If you check whether a position is "closed" too soon after execution, the API may not yet show it, causing false "position gone" detection. Always add a grace period (60+ seconds) before treating a missing position as actually closed. Check `order.executedAt` or `pos.startedAt` timestamps to enforce the grace period.
- **Added after**: Iteration 43 - 197 out of 197 queue entries were marked "closed" within 2-10 seconds of execution because the lifecycle detector ran every 10 seconds and MEXC API hadn't yet reflected the new positions. This broke trailing stop management, Turso persistence, and profit-tiered trailing — positions were removed from tracking before they could be managed.

### Sign: MEXC Dashboard Uses UTC+8 Timezone
- **Trigger**: When comparing system PnL with MEXC dashboard "Today" figures
- **Instruction**: MEXC's "Today's PNL" is calculated in UTC+8 (Beijing time), not UTC. "Today" runs from 00:00 to 23:59 UTC+8, which equals 16:00 UTC yesterday to 15:59 UTC today. When reconciling PnL, filter trades by `updateTime` within this UTC range, NOT by calendar date in UTC. A trade closing at 16:30 UTC counts as "tomorrow" on MEXC.
- **Added after**: Iteration 43 - Three winning trades (+$14.24 total) closed at 16:36 UTC but won't appear in MEXC "Today" dashboard because they're past the 16:00 UTC cutoff (midnight UTC+8).

### Sign: Render Production URL is backburner.onrender.com
- **Trigger**: When accessing the deployed server API
- **Instruction**: The correct production URL is `https://backburner.onrender.com`, NOT `backburner-screener.onrender.com` or `backburner-screener-1.onrender.com`. The render.yaml may reference different URLs but the actual deployed service is at `backburner.onrender.com`. Save this in `.env` or `.ralph/` for quick reference.
- **Added after**: Iteration 47 - Wasted time trying wrong URLs (`backburner-screener.onrender.com` returned 404 with `x-render-routing: no-server`).

### Sign: Avoid Bash Echo Blocks with Complex Commands
- **Trigger**: When running multiple curl/jq commands with labels
- **Instruction**: Don't use `echo "LABEL" && curl ... && echo "LABEL2" && curl ...` chains — they can fail with "permission denied" on some shells. Instead, run each curl command separately or use a simple script. Also avoid `!=` in jq — use `> 0` for null safety.
- **Added after**: Iteration 47 - Multi-echo bash block failed with "permission denied" and jq `!=` caused compile errors.

### Sign: Verify Position Actually Closed Before Marking Closed
- **Trigger**: When checking if MEXC position has closed (in queue lifecycle OR trailing manager)
- **Instruction**: Don't trust `getOpenPositions()` returning empty or missing a symbol as proof of closure. MEXC API can return incomplete data. ALWAYS verify by checking order history for a close order (side 2 or 4, state 3) that happened AFTER the order execution/tracking start time. Only mark as closed if verification succeeds. This applies to BOTH the queue lifecycle detector AND the trailing manager's `detectExternalCloses`.
- **Added after**: Iteration 48-49 - Positions were repeatedly lost and re-adopted because trailing manager's `detectExternalCloses()` immediately stopped tracking without verification. Fixed by splitting into `detectPotentialCloses()` + `confirmExternalClose()`.

### Sign: Always Verify planOrderId Exists Before Modifying SL
- **Trigger**: When trailing stop tries to update SL on MEXC
- **Instruction**: If `planOrderId` is empty, the modify call will silently fail. Auto-recover by fetching plan orders from MEXC, finding the SL order ID, or creating a new SL if none exists. DUSK ran to 49% profit but SL never moved because planOrderId was missing.
- **Added after**: Iteration 48 - DUSK had `trailActivated: true` at 49% ROE but SL stayed at initial 8% loss level. User had to manually close to lock in profit.

### Sign: Always Cancel Existing Plan Orders Before Creating New Ones
- **Trigger**: When creating a stop-loss, take-profit, or any plan order on MEXC
- **Instruction**: Multiple code paths can create plan orders: `setStopLoss`, `renewPlanOrder`, recovery logic in `modifyStopOnMexc`, position adoption, startup reconciliation. Without explicit cleanup, duplicate orders accumulate (e.g., 56 orders for 13 positions). ALWAYS call `cancelAllPlanOrders(symbol)` BEFORE creating a new order. The `setStopLoss` function now does this automatically.
- **Added after**: Iteration 50 - Found 56 open orders for 13 positions. Root cause: `renewPlanOrder` created new order then cancelled old (race condition), recovery logic created new without cancelling existing, and startup didn't clean up duplicates.

