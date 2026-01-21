# Backburner Project Info

## Render Server
- **URL:** https://backburner.onrender.com/

## Turso Database
- **URL:** libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io
- **Database Name:** backburner-trades

## Useful Queries

```sql
-- Bot performance (last 24h)
SELECT bot_id, COUNT(*) as trades,
  SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(SUM(realized_pnl), 2) as total_pnl
FROM trade_events
WHERE event_type = 'close' AND timestamp > datetime('now', '-24 hours')
GROUP BY bot_id ORDER BY total_pnl DESC;

-- Check Focus Mode Shadow Bots
SELECT bot_id, event_type, COUNT(*) as count
FROM trade_events
WHERE bot_id LIKE 'focus-%'
GROUP BY bot_id, event_type;

-- Most recent trades
SELECT bot_id, event_type, timestamp, symbol
FROM trade_events ORDER BY timestamp DESC LIMIT 10;
```

## Current State (Jan 2026)

### Market Bias Systems
- **System A**: RSI-only bias (existing, simple)
- **System B**: Multi-indicator (RSI + Funding Rate + OI + Premium/Discount + Momentum)
- Tabbed UI at root endpoint for A/B comparison

### Bot Performance Winners (from overnight tests)
- GP2 bots: Best performers (+$123 to +$15, ~75% win rate)
- GP1 bots and shadow bots: Generally losing

---

# Refactoring Analysis

## Project Stats
- **72 TypeScript files** in src/
- **49,160 total lines** of code
- **15 bot classes** (many with duplicate logic)
- **18 backtest files** (lots of one-off experiments)
- **26 API endpoints** in web-server.ts

## Critical Problem Areas

### 1. `web-server.ts` - 7,883 lines (CRITICAL)
The web server has become a monolith containing:
- 26 API endpoints
- 523+ inline HTML/CSS/JS elements
- Bot instantiation and management
- Signal processing logic
- Dashboard rendering
- Market data aggregation

### 2. `focus-mode-dashboard.ts` - 4,841 lines
Another monolith with:
- HTML generation
- Trade setup calculations
- Support/resistance analysis
- UI rendering logic

### 3. Bot Code Duplication
15 bot files with similar patterns:
- btc-bias-bot.ts, btc-extreme-bot.ts, btc-trend-bot.ts
- golden-pocket-bot.ts, golden-pocket-bot-v2.ts
- gp-shadow-bot.ts, focus-mode-shadow-bot.ts
- trend-flip-bot.ts, trend-override-bot.ts
- etc.

Most share: position management, entry/exit logic, trailing stops, risk calculations

### 4. Backtest Sprawl
18+ backtest files, many one-off experiments:
- backtest-spot-turso.ts, backtest-spot-real.ts, backtest-spot-aligned.ts
- backtest-combined.ts, backtest-combined-db.ts, backtest-combined-candles.ts
- backtest-gp-4h.ts, backtest-gp-4h-aligned.ts
- etc.

## Recommended Refactoring Phases

### Phase 1: Extract Views (Quick Win)
Create `src/views/` directory:
- `views/dashboard.html` - Main dashboard template
- `views/focus-mode.html` - Focus mode UI
- `views/partials/` - Reusable components (header, bot-card, etc.)
- Use template engine (EJS/Handlebars) or static files

### Phase 2: Extract API Routes
Create `src/routes/` directory:
- `routes/api/bots.ts` - Bot status, performance endpoints
- `routes/api/signals.ts` - Signal generation endpoints
- `routes/api/market-data.ts` - RSI, bias, candle endpoints
- `routes/api/focus-mode.ts` - Focus mode specific endpoints

### Phase 3: Abstract Base Bot Class
Create `src/bots/base-bot.ts`:
```typescript
abstract class BaseBot {
  protected position: Position | null;
  protected config: BotConfig;

  abstract shouldEnter(signal: Signal): boolean;
  abstract shouldExit(position: Position): boolean;

  // Shared methods
  protected calculatePositionSize(): number;
  protected applyTrailingStop(): void;
  protected logTrade(): void;
}
```

Then refactor bots to extend it:
- `bots/golden-pocket-bot.ts`
- `bots/focus-shadow-bot.ts`
- `bots/trend-bot.ts`
- etc.

### Phase 4: Consolidate Backtests
Create unified backtest engine:
- `src/backtest/engine.ts` - Core backtest logic
- `src/backtest/strategies/` - Strategy configurations
- `src/backtest/presets.ts` - Common backtest configurations
- Archive old one-off backtest files to `data/archived/`

### Phase 5: Service Layer
Create `src/services/`:
- `services/market-data.ts` - All MEXC API interactions
- `services/bias-calculator.ts` - System A/B bias logic
- `services/signal-generator.ts` - Signal detection
- `services/trade-executor.ts` - Position management

## Suggested Directory Structure

```
src/
├── index.ts              # Entry point
├── web-server.ts         # Slim Express setup only
├── config.ts             # Configuration
├── types.ts              # Type definitions
│
├── routes/               # API routes
│   ├── index.ts
│   ├── bots.ts
│   ├── signals.ts
│   ├── market-data.ts
│   └── focus-mode.ts
│
├── views/                # HTML templates
│   ├── dashboard.html
│   ├── focus-mode.html
│   └── partials/
│
├── bots/                 # Bot implementations
│   ├── base-bot.ts
│   ├── golden-pocket-bot.ts
│   ├── focus-shadow-bot.ts
│   └── ...
│
├── services/             # Business logic
│   ├── market-data.ts
│   ├── bias-calculator.ts
│   ├── signal-generator.ts
│   └── trade-executor.ts
│
├── indicators/           # Technical indicators
│   ├── rsi.ts
│   ├── sma.ts
│   └── divergence.ts
│
├── backtest/             # Unified backtesting
│   ├── engine.ts
│   └── strategies/
│
└── utils/                # Utilities
    ├── notifications.ts
    └── logging.ts
```

## Priority Order
1. **Extract HTML from web-server.ts** (biggest impact, lowest risk)
2. **Create routes directory** (modular API)
3. **Abstract base bot class** (reduce duplication)
4. **Consolidate backtests** (clean up experiments)

## Files Safe to Archive
These appear to be one-off experiments:
- check-rsi-debug.ts
- debug-signals.ts
- check-symbol.ts
- v2-validation.ts
- Most backtest-*.ts files (keep backtest-engine.ts)
