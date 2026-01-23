# Semi-Automated Trading System Plan

**Created:** January 23, 2026
**Status:** Planning Phase
**Goal:** Human-in-the-loop trade execution using MEXC API

---

## 1. Concept Overview

### What We're Building

A "trading assistant" that:
1. **Runs bot logic automatically** (same as current shadow bots)
2. **Displays actionable signals** with an "Execute" button
3. **Requires human click** to place actual trades
4. **Uses MEXC API** to execute orders on your real account

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Shadow Bot     │────▶│  "Execute Trade" │────▶│   MEXC API      │
│  Generates      │     │   Button in UI   │     │   Places Order  │
│  Signal         │     │   (Human clicks) │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              ↑
                         Human decision
```

### Why This Approach

1. **Legal/ToS Compliance**: Human makes final decision, not a fully autonomous bot
2. **Risk Control**: You can skip signals you don't like
3. **Learning**: See what the bot would do, decide if you agree
4. **Gradual Automation**: Start manual, gain confidence, then consider full automation

---

## 2. Architecture

### Phase 1: Read-Only Integration (Low Risk)

Connect to MEXC API for **reading data only**:
- Real account balance
- Open positions
- Current prices
- Order history

**Benefits:**
- Shadow bots use real balance instead of simulated $2000
- See if your real positions match shadow positions
- No risk - read-only operations

### Phase 2: Signal Queue + Execute Button

When a shadow bot opens a position:
1. Position appears in shadow bot's state (as now)
2. NEW: Also appears in "Pending Executions" queue
3. Queue shows: Symbol, Direction, Size, Entry Price, Stop Loss, Take Profit
4. "Execute on MEXC" button sends order via API

### Phase 3: Position Sync + Management

- Track which shadow positions have been mirrored to MEXC
- Update trailing stops on MEXC when shadow bot trails
- Close MEXC position when shadow bot closes
- Still requires human confirmation for each action

---

## 3. MEXC API Setup

### Getting API Credentials

1. Log into MEXC
2. Go to: **Profile → API Management**
3. Create new API key with:
   - **Spot Trading**: OFF (we're doing futures)
   - **Futures Trading**: ON
   - **Withdrawal**: OFF (never enable this)
   - **IP Restriction**: Recommended (add your server IP)

### Required Permissions

| Permission | Required | Why |
|------------|----------|-----|
| Read | Yes | Get balance, positions, prices |
| Futures Trade | Yes | Place orders |
| Spot Trade | No | Not using spot |
| Withdraw | **NO** | Security risk |

### Environment Variables

```bash
# Add to .env file (never commit this!)
MEXC_API_KEY=mx0vgl...
MEXC_API_SECRET=abc123...
```

### API Endpoints We'll Use

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/private/account/assets` | GET | Get futures balance |
| `/api/v1/private/position/open_positions` | GET | Get open positions |
| `/api/v1/private/order/submit` | POST | Place order |
| `/api/v1/private/order/cancel` | POST | Cancel order |
| `/api/v1/private/position/close` | POST | Close position |

---

## 4. UI Design

### New "Execution Queue" Panel

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚡ Pending Executions (exp-bb-sysB)                    [Settings]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 🟢 WAXPUSDT LONG                              2 minutes ago    │
│ Entry: $0.0432 | Size: $200 | Stop: $0.0398 | TP: Trail        │
│ [Execute on MEXC] [Skip] [Details]                             │
│                                                                 │
│ 🔴 ACUUSDT SHORT                              5 minutes ago    │
│ Entry: $0.0891 | Size: $200 | Stop: $0.0963 | TP: Trail        │
│ [Execute on MEXC] [Skip] [Details]                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Execution Flow

1. **Signal appears** → Notification + queue entry
2. **You review** → Check chart, regime, your gut feeling
3. **Click Execute** → Confirmation dialog with final details
4. **API places order** → Success/failure feedback
5. **Position tracked** → Linked to shadow position for sync

### Safety Features

- **Confirmation dialog** before every execution
- **Max position size limit** (configurable)
- **Daily loss limit** (stop showing signals if hit)
- **Execution timeout** (signals expire after X minutes)
- **Emergency stop** button to disable all executions

---

## 5. Risk Management

### Guardrails

| Guardrail | Default | Purpose |
|-----------|---------|---------|
| Max position size | $200 | Limit single trade risk |
| Max open positions | 5 | Limit total exposure |
| Daily loss limit | $500 | Stop trading if losing |
| Signal timeout | 5 min | Don't execute stale signals |
| Require confirmation | ON | Prevent accidental clicks |

### What Could Go Wrong

| Risk | Mitigation |
|------|------------|
| API key stolen | IP restriction, no withdrawal permission |
| Fat finger click | Confirmation dialog, size limits |
| Bot goes haywire | Daily loss limit, manual kill switch |
| Slippage worse than expected | Compare expected vs actual, adjust |
| MEXC API down | Queue signals, execute when back |

---

## 6. Implementation Phases

### Phase 1: Foundation (1-2 days)
- [ ] Create `src/mexc-api.ts` with authenticated requests
- [ ] Add environment variable handling for API keys
- [ ] Implement read-only endpoints (balance, positions)
- [ ] Add "MEXC Status" indicator to dashboard

### Phase 2: Execution Queue (2-3 days)
- [ ] Create execution queue data structure
- [ ] Add queue UI panel to dashboard
- [ ] Implement "Execute" button with confirmation
- [ ] Add order placement API call
- [ ] Track executed positions

### Phase 3: Position Sync (2-3 days)
- [ ] Link shadow positions to MEXC positions
- [ ] Sync trailing stop updates
- [ ] Sync position closes
- [ ] Add "Synced" indicator to positions

### Phase 4: Polish (1-2 days)
- [ ] Add settings for guardrails
- [ ] Implement daily loss limit
- [ ] Add execution history log
- [ ] Create documentation

---

## 7. Questions to Decide

Before implementation:

1. **Which bot(s) to enable first?**
   - Current leader: `exp-bb-sysB`
   - Wait for more data before deciding

2. **Position sizing approach?**
   - Option A: Fixed dollar amount (e.g., $200)
   - Option B: Percentage of MEXC balance (e.g., 10%)
   - Option C: Match shadow bot logic exactly

3. **Signal expiration?**
   - How long should a signal remain executable?
   - 2 minutes? 5 minutes? Until price moves X%?

4. **Notification preference?**
   - Browser notification for each signal?
   - Sound alert?
   - Telegram integration?

5. **When to start?**
   - After X more days of shadow testing?
   - After exp-bb-sysB proves consistent?

---

## 8. MEXC ToS Considerations

### What MEXC Says About API Trading

MEXC explicitly provides API access for trading, so API trading itself is allowed. Their concerns are typically:

- **Market manipulation** - We're not doing this (small positions)
- **HFT exploitation** - We're human-speed, not millisecond
- **Wash trading** - We're directional trading, not self-dealing

### Our "Human-in-the-Loop" Advantage

- Every trade requires a click
- Human can reject any signal
- Execution speed is human-limited
- We're a "trading assistant" not autonomous bot

### Recommendation

Start with small positions ($100-200) and conservative limits. If MEXC has concerns, the impact is minimal and you can adjust.

---

## 9. Next Steps

1. **Set up MEXC API credentials** (you do this)
2. **Wait for more bot performance data** (3-5 more days)
3. **Implement Phase 1** (read-only integration)
4. **Verify data accuracy** (shadow balance vs real balance)
5. **Implement Phase 2** (execution queue)
6. **Start with tiny positions** ($50-100 per trade)
7. **Scale up as confidence grows**

---

## 10. File Locations (Planned)

```
src/
  mexc-api.ts           # MEXC API client
  execution-queue.ts    # Queue management
  routes/
    execution.ts        # API endpoints for execution

src/views/js/
  execution-panel.js    # UI for execution queue

data/docs/
  SEMI_AUTOMATED_TRADING_PLAN.md  # This file
```

---

## Appendix: MEXC API Reference

### Authentication

MEXC uses HMAC-SHA256 signature:

```typescript
const signature = crypto
  .createHmac('sha256', apiSecret)
  .update(queryString + timestamp)
  .digest('hex');
```

### Rate Limits

- 20 requests per second for trading endpoints
- 10 requests per second for account endpoints

### Example: Get Futures Balance

```typescript
GET /api/v1/private/account/assets
Headers:
  ApiKey: {your_api_key}
  Request-Time: {timestamp_ms}
  Signature: {hmac_signature}
```

### Example: Place Order

```typescript
POST /api/v1/private/order/submit
Body:
  symbol: "WAXP_USDT"
  side: 1 (open long) | 2 (close short) | 3 (open short) | 4 (close long)
  type: 5 (market)
  vol: 100  // contracts
  leverage: 20
```
