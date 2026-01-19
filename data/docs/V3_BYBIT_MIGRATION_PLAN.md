# V3 Migration Plan: MEXC → Bybit for Automated Futures Trading

**Created:** January 2026
**Status:** Planning Phase
**Target:** Automated futures trading with real money ($100 initial)

---

## Executive Summary

### Why Migrate from MEXC?

**MEXC Futures API has been disabled for retail users since July 2022** ([source](https://finance.yahoo.com/news/mexc-reopen-futures-api-mexc-113941940.html))

- Only institutional users can access futures API
- Spot API works, but we need futures for leveraged trading
- Recent account freezes for "auto trading via API"

### Why Bybit?

1. **Full futures API access** for retail users
2. **Zero bot fees** - just standard trading fees
3. **Available in Mexico** with full KYC
4. **Excellent Node.js/TypeScript SDK** ([bybit-api](https://github.com/tiagosiebler/bybit-api))
5. **SDK provides 400 req/sec rate limit** (higher than VIP tier)
6. **$1 minimum order** with SDK (vs $5 default)
7. **Testnet available** for paper trading

---

## Bybit Account Setup Checklist

### Step 1: Create Account
- [ ] Register at [bybit.com](https://www.bybit.com)
- [ ] Wait 48 hours (new account API restriction)

### Step 2: Complete KYC (Required for Trading)
- [ ] **Level 1 (Standard)** - Minimum required
  - Government-issued ID (passport, driver's license, or national ID)
  - Selfie verification
  - Takes 5-10 minutes
  - Unlocks: 1M USDT daily withdrawal limit

- [ ] **Level 2 (Advanced)** - Optional but recommended
  - Proof of address (utility bill, bank statement - dated within 3 months)
  - Unlocks: 2M USDT daily withdrawal limit

### Step 3: Enable 2FA Security
- [ ] Enable Google Authenticator or similar 2FA
- [ ] Required before creating API keys

### Step 4: Create API Keys
- [ ] Go to: Account → API Management
- [ ] Create new key with permissions:
  - ✅ Read (account info, positions)
  - ✅ Trade (place/cancel orders)
  - ❌ Withdraw (NEVER enable for bots)
  - ❌ Transfer (not needed)
- [ ] **Save API Key and Secret immediately** (shown only once!)
- [ ] Set IP whitelist (your server IP)

### Step 5: Fund Account
- [ ] Minimum deposit: $1 USDT (but we're starting with $100)
- [ ] Deposit methods:
  - Crypto transfer (cheapest - use TRC20 or similar low-fee network)
  - Fiat deposit (min $2 USD)

### Step 6: Upgrade to Unified Trading Account (UTA)
- [ ] Enables single margin pool across all products
- [ ] Better capital efficiency for our strategy

---

## Technical Migration Plan

### Current Architecture (MEXC)

```
src/mexc-api.ts          → MEXC REST API calls
src/mexc-futures-api.ts  → Futures-specific calls (limited)
src/web-server.ts        → Paper trading simulation
```

### New Architecture (Bybit V3)

```
src/bybit-api.ts         → Bybit REST API wrapper
src/bybit-websocket.ts   → Real-time price feeds
src/bybit-trading.ts     → Order execution engine
src/v3-live-trader.ts    → Production trading bot
```

### SDK Installation

```bash
npm install bybit-api
```

### Key Differences: MEXC vs Bybit

| Feature | MEXC | Bybit |
|---------|------|-------|
| Futures API | ❌ Disabled for retail | ✅ Full access |
| Rate Limit | 10 req/sec | 400 req/sec with SDK |
| Min Order | ~$5 | $1 with SDK |
| WebSocket | Basic | Full trading support |
| Testnet | Limited | Full testnet available |

### API Endpoint Mapping

| Function | MEXC Endpoint | Bybit V5 Endpoint |
|----------|---------------|-------------------|
| Get Price | `/api/v3/ticker/price` | `/v5/market/tickers` |
| Place Order | N/A (disabled) | `/v5/order/create` |
| Cancel Order | N/A | `/v5/order/cancel` |
| Get Position | N/A | `/v5/position/list` |
| Account Balance | `/api/v3/account` | `/v5/account/wallet-balance` |

### Code Migration Steps

#### Phase 1: API Layer (Week 1)
- [ ] Create `src/bybit-api.ts` with REST client
- [ ] Implement authentication (HMAC signature)
- [ ] Add price fetching for screener
- [ ] Add testnet support

#### Phase 2: WebSocket (Week 1-2)
- [ ] Create `src/bybit-websocket.ts`
- [ ] Subscribe to price updates
- [ ] Subscribe to position updates
- [ ] Handle reconnection logic

#### Phase 3: Trading Engine (Week 2)
- [ ] Create `src/bybit-trading.ts`
- [ ] Implement order placement
- [ ] Implement stop loss orders
- [ ] Implement trailing stop logic
- [ ] Add position management

#### Phase 4: Live Trader (Week 3)
- [ ] Create `src/v3-live-trader.ts`
- [ ] Integrate with existing strategy bots
- [ ] Add safety checks (max position, daily loss limit)
- [ ] Add logging and monitoring

#### Phase 5: Testing (Week 3-4)
- [ ] Test on Bybit testnet
- [ ] Verify order execution
- [ ] Verify stop loss triggering
- [ ] Verify trailing stop behavior

---

## Bybit API Quick Reference

### Authentication

```typescript
import { RestClientV5 } from 'bybit-api';

const client = new RestClientV5({
  key: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  testnet: true, // false for live trading
});
```

### Place Futures Order

```typescript
const order = await client.submitOrder({
  category: 'linear',           // USDT perpetuals
  symbol: 'BTCUSDT',
  side: 'Buy',
  orderType: 'Market',
  qty: '0.001',
  positionIdx: 0,               // One-way mode
  // For limit orders:
  // orderType: 'Limit',
  // price: '50000',
});
```

### Set Stop Loss

```typescript
const sl = await client.setTradingStop({
  category: 'linear',
  symbol: 'BTCUSDT',
  stopLoss: '49000',
  slTriggerBy: 'LastPrice',
  positionIdx: 0,
});
```

### Get Position

```typescript
const positions = await client.getPositionInfo({
  category: 'linear',
  symbol: 'BTCUSDT',
});
```

### WebSocket Price Feed

```typescript
import { WebsocketClient } from 'bybit-api';

const ws = new WebsocketClient({
  market: 'v5',
  testnet: true,
});

ws.subscribe(['tickers.BTCUSDT']);

ws.on('update', (data) => {
  console.log('Price update:', data);
});
```

---

## Rate Limits

### With bybit-api SDK (Automatic Benefits)
- **400 requests/second** (vs 120/sec for regular users)
- **$1 minimum order** (vs $5 default)
- No action required - automatic with SDK

### Connection Limits
- Max 500 WebSocket connections per 5 minutes
- Max 1,000 WebSocket connections per IP for market data

### Order Limits
- Max 500 active orders per symbol
- Max 10 conditional orders per symbol

---

## Risk Management for Live Trading

### Safety Parameters

```typescript
const SAFETY_CONFIG = {
  maxPositionSize: 50,          // Max $50 per position (50% of $100)
  maxDailyLoss: 20,             // Stop trading if down $20 (20%)
  maxOpenPositions: 5,          // Max 5 concurrent positions
  minTimeBetweenTrades: 60000,  // 1 minute cooldown
  requireConfirmation: true,    // Confirm large orders
};
```

### Scaling Plan

| Phase | Account Size | Position Size | Max Risk/Trade |
|-------|--------------|---------------|----------------|
| 1 | $100 | 5% = $5 | $0.75 (15% SL) |
| 2 | $500 | 5% = $25 | $3.75 |
| 3 | $1,000 | 5% = $50 | $7.50 |
| 4 | $2,000+ | 5% = $100 | $15.00 |

### Progression Criteria
- Move to next phase after **50 profitable trades**
- Must maintain >1.0 profit factor
- No single day loss >10% of account

---

## Testnet First!

### Bybit Testnet URLs
- **Website**: https://testnet.bybit.com
- **API**: https://api-testnet.bybit.com
- **WebSocket**: wss://stream-testnet.bybit.com

### Get Testnet Funds
1. Create testnet account (separate from mainnet)
2. Use faucet or request test funds
3. Full trading functionality available

---

## Timeline

| Week | Task | Deliverable |
|------|------|-------------|
| Now | Shadow bots collecting data | Validate strategy |
| Week 1 | Bybit account setup | KYC complete, API keys ready |
| Week 1-2 | API migration | `bybit-api.ts`, `bybit-websocket.ts` |
| Week 2-3 | Trading engine | `bybit-trading.ts`, `v3-live-trader.ts` |
| Week 3-4 | Testnet testing | 50+ simulated trades |
| Week 4+ | Live trading | $100 real money |

---

## Files to Create

```
src/
├── bybit/
│   ├── bybit-client.ts       # REST API wrapper
│   ├── bybit-websocket.ts    # WebSocket handler
│   ├── bybit-trading.ts      # Order execution
│   └── bybit-types.ts        # TypeScript types
├── v3/
│   ├── live-trader.ts        # Main trading bot
│   ├── risk-manager.ts       # Safety checks
│   └── trade-logger.ts       # Trade history
└── config/
    └── bybit-config.ts       # API keys, settings
```

---

## Environment Variables (for .env)

```bash
# Bybit API (NEVER commit these!)
BYBIT_API_KEY=your_api_key
BYBIT_API_SECRET=your_api_secret
BYBIT_TESTNET=true

# Trading parameters
MAX_POSITION_SIZE_USD=50
MAX_DAILY_LOSS_USD=20
MAX_OPEN_POSITIONS=5
```

---

## Sources

- [Bybit API Documentation](https://bybit-exchange.github.io/docs/v5/intro)
- [bybit-api npm package](https://www.npmjs.com/package/bybit-api)
- [Bybit KYC Requirements](https://www.bybit.com/en/help-center/article/How-to-Complete-Individual-KYC-Verification/)
- [Bybit Rate Limits](https://bybit-exchange.github.io/docs/v5/rate-limit)
- [MEXC Futures API Status](https://finance.yahoo.com/news/mexc-reopen-futures-api-mexc-113941940.html)
