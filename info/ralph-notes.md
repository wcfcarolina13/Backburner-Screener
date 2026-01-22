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

## Refactoring Progress

### Phase 1 ✅ Complete (Jan 21, 2026)
**Extract CSS/JS to static files**

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| web-server.ts | 7883 | 5042 | -36% |
| focus-mode-dashboard.ts | 4841 | 1211 | -75% |

Static files created:
- `src/views/css/dashboard.css` (182 lines)
- `src/views/js/dashboard.js` (2662 lines)
- `src/views/css/focus-mode.css` (1549 lines)
- `src/views/js/focus-mode.js` (2088 lines)

### Phase 2 ✅ Complete (Jan 21, 2026)
**Add route modules infrastructure**

New files:
- `src/server-context.ts` (61 lines) - Shared state interface
- `src/routes/settings.ts` (108 lines) - Settings API routes
- `src/routes/focus-mode.ts` (71 lines) - Focus mode routes
- `src/routes/index.ts` (7 lines) - Route exports

Route modules mounted at:
- `/api/*` - Settings routes (daily-reset, notifications, investment)
- `/api/focus/*` - Focus mode routes

Note: Original routes still exist as fallback; future cleanup will remove duplicates.

### Phase 3 ✅ Complete (Jan 21, 2026)
**Abstract base bot class**

New files in `src/bots/`:
- `base-bot.ts` (~450 lines) - Abstract base class with shared infrastructure
- `btc-trend-bot-v2.ts` (~200 lines) - Proof of concept refactored bot
- `index.ts` - Exports all bot classes

BaseBot provides:
- `BaseBot<TConfig, TPosition, TMarketData, TStats>` - Generic abstract class
- `SinglePositionBot` - For bots that maintain one position (e.g., BTC bots)
- `MultiPositionBot` - For bots that maintain multiple positions (e.g., Golden Pocket)

Shared functionality (no longer duplicated):
- Balance and margin management
- Position size calculation
- PnL calculation (unrealized and realized)
- Stats tracking (win rate, profit factor, drawdown)
- Trailing stop infrastructure with ROI-based levels
- Breakeven lock mechanism
- Trade logging hooks

Variant-specific (abstract methods):
- `canEnter(data)` - Whether to open a position
- `calculateStops(entry, direction, data)` - TP/SL calculation
- `shouldExit(position, data)` - Custom exit conditions
- Position storage methods (key generation, store, get, remove)

Migration path:
1. Create V2 version extending BaseBot (like `btc-trend-bot-v2.ts`)
2. Test V2 alongside original
3. Swap out when confident
4. Delete old implementation

### Phase 4 ✅ Complete (Jan 21, 2026)
**Consolidate backtests and debug files**

Organized 26 files (~13,000 lines) into structured folders:

**Kept in src/ (core infrastructure):**
- `backtest-engine.ts` - Core simulation engine
- `backtest-cli.ts` - Command line interface
- `backtest-combined.ts` - 4H trend + 5m fade strategy
- `backtest-combined-db.ts` - Same, using Turso DB signals
- `backtest-combined-candles.ts` - Same, candle-aligned
- `backtest-fixed-be.ts` - Fixed TP/SL with breakeven
- `forensic-backtest.ts` - Conservative validation

**Moved to src/debug/:**
- `debug-signals.ts` - Signal alignment checker
- `check-rsi-debug.ts` - RSI calculation validator
- `check-symbol.ts` - Symbol lookup utility
- `v2-validation.ts` - V2 validation tests

**Archived to src/archive/backtest-experiments/:**
- `backtest-contrarian.ts` - Bearish regime only
- `backtest-counter-trend.ts` - Mean reversion
- `backtest-skip-bearish.ts` - Cash during bear
- `backtest-macro-aware.ts` - 2-level regime
- `backtest-regime-matrix.ts` - Quadrant testing
- `backtest-spot-only.ts` - Spot vs futures comparison
- `backtest-spot-real.ts` - Historical spot analysis
- `backtest-spot-aligned.ts` - Spot with BTC alignment
- `backtest-spot-turso.ts` - Spot using Turso DB
- `backtest-spot-regime-realistic.ts` - Spot regime validation
- `backtest-gp-4h.ts` - Golden Pocket 4H zones
- `backtest-gp-4h-aligned.ts` - GP 4H with alignment
- `backtest-window-comparison.ts` - Regime window tuning
- `backtest-leverage-comparison.ts` - Leverage analysis
- `backtest-leveraged-regime.ts` - Regime + leverage

## Refactoring Complete

All 4 phases complete:
1. ✅ Extract CSS/JS to static files
2. ✅ Add route modules infrastructure
3. ✅ Abstract base bot class
4. ✅ Consolidate backtests

**Results:**
- web-server.ts: 7883 → 5042 lines (-36%)
- focus-mode-dashboard.ts: 4841 → 1211 lines (-75%)
- Bot duplication: Centralized in BaseBot class
- Backtest organization: 26 files organized into 3 categories

---

## Task Queue

### Pending Tasks

#### 1. Timezone/Time-of-Day Analysis (Priority: High)
**Hypothesis:** Best trades may correlate with active trading sessions (US open, Asia open, Europe open, etc.)

**Analysis needed:**
- Extract entry_time from historical trades
- Convert to hour-of-day (UTC and major timezones)
- Group by:
  - Hour of day (0-23)
  - Trading session (Asia: 00-08 UTC, Europe: 07-16 UTC, US: 13-22 UTC)
  - Day of week
- Metrics per bucket:
  - Win rate
  - Average P&L
  - Trade count
  - Profit factor

**Query sketch:**
```sql
SELECT
  strftime('%H', datetime(entry_time/1000, 'unixepoch')) as hour_utc,
  COUNT(*) as trades,
  SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(pnl_percent), 2) as avg_pnl
FROM trades
WHERE status = 'closed' AND bot_id LIKE 'focus-%'
GROUP BY hour_utc
ORDER BY avg_pnl DESC;
```

**Expected outcome:** Identify optimal trading windows, potentially filter signals outside peak hours.

---

## Automation Status (Jan 21, 2026)

### Created
- `src/execution-bridge.ts` - Connects FocusModeShadowBot to MexcTradingClient
- `src/routes/execution.ts` - API endpoints for dashboard control
- `src/spot-backtest-cli.ts` - Configurable spot backtest CLI

### MEXC Research Findings (IMPORTANT)
**US users are BANNED from MEXC:**
- US is on "Prohibited Countries" list
- Using VPN violates ToS → account suspension, funds locked
- No SEC/CFTC/FinCEN licenses

**Alternatives to consider:**
- Coinbase Advanced (US-compliant, has API)
- Kraken (US-compliant, has API)
- Keep MEXC manual-only (no API automation)

### Spot Backtest CLI
```bash
npm run spot-backtest -- --help
npm run spot-backtest -- --days 7 --compare
npm run spot-backtest -- --verbose
```

---

## Backtesting Framework & Findings

### Current Tools

1. **`spot-backtest-cli.ts`** - Backtests against Turso trade history
   - Uses actual bot trades from database
   - Limited to data we've collected (currently ~7 days for focus bots)
   - Good for: validating live bot performance

2. **`backtest-engine.ts`** - Backtests against historical candle data
   - Fetches OHLC from MEXC API
   - Replays signal detection logic
   - Good for: testing strategy over longer periods

3. **Historical Strategy Backtest** (TO BUILD)
   - Fetch 30+ days of candle data from MEXC
   - Run Focus Mode signal detection
   - Simulate spot-only (long, 1x) trading
   - Compare to leveraged results

### Key Findings (Jan 21, 2026)

#### Bot Performance Summary (7-day Turso data)
| Bot Type | Direction | Trades | Avg PnL | Win Rate |
|----------|-----------|--------|---------|----------|
| focus-aggressive | long | 15 | +8.72% | 93% |
| focus-baseline | long | 3 | +14.17% | 100% |
| gp2-* | long | 4 | +6.5% | 100% |
| wide/aggressive/standard | long | 300+ | -0.5% to -0.8% | 10-40% |

**Conclusion:** Focus Mode bots significantly outperform other strategies, but sample size is small (27 trades vs 870+ for others).

#### Spot vs Leveraged Reality Check
- At 22.5x leverage: +10% ROI from a 0.44% price move
- At 1x spot: same trade = +0.44% ROI
- **Spot requires 22.5x more trades OR larger position sizes to match leveraged returns**

#### Spot Backtest Results (Focus bots, 7 days, long-only)
| Position Size | End Balance | Return | Win Rate | Max DD |
|---------------|-------------|--------|----------|--------|
| 10% | $2,003 | +0.13% | 92.9% | 0.3% |
| 25% | $2,006 | +0.32% | 92.9% | 0.7% |
| 50% | $2,013 | +0.64% | 92.9% | 1.4% |
| 75% | $2,019 | +0.96% | 92.9% | 2.1% |

**Observation:** High win rate but tiny returns at spot. Larger position sizes help but increase drawdown risk.

### Task Queue

#### 2. Historical Strategy Backtest (Priority: High) - READY TO TEST
**Goal:** Test Focus Mode strategy against 30+ days of historical MEXC data

**Status:** Tool built (`src/historical-backtest.ts`), needs to run from local machine (sandbox can't reach MEXC API).

**Usage:**
```bash
# Quick test (5 symbols, 14 days)
npm run historical-backtest -- --symbols 5 --days 14 --compare

# Full test (20 symbols, 30 days)
npm run historical-backtest -- --symbols 20 --days 30 --compare

# Spot-only mode
npm run historical-backtest -- --spot-only --days 30
```

**Approach:**
- Fetches candle data from MEXC API (up to 1000 candles per request)
- Runs BackburnerDetector signal detection (RSI + impulse)
- Looks for "triggered" or "deep_extreme" setup states
- Simulates trades with trailing stops (3% trigger, 1.5% trail)
- `--compare` flag runs both spot (1x) and leveraged (10x) scenarios

**Expected output:**
- Statistically significant sample (100+ trades)
- Realistic performance expectations for spot trading
- Identify if strategy works historically or just recent luck

---

## Experimental Shadow Bots (Jan 22, 2026)

### Overview
Created `src/experimental-shadow-bots.ts` to test untested combinations of bias systems and regime filters.

### Bot Configurations

| Bot ID | Signal Source | Bias Filter | Regime Filter | Description |
|--------|---------------|-------------|---------------|-------------|
| `exp-bb-sysB` | Backburner | System B (Multi-Indicator) | None | Tests System B (funding, OI, premium) instead of System A (RSI-only) |
| `exp-bb-sysB-contrarian` | Backburner | System B | Contrarian only | System B + only trade in NEU+BEAR, BEAR+BEAR quadrants |
| `exp-gp-regime` | Golden Pocket | None | Contrarian only | GP signals filtered by signal-ratio regime |
| `exp-gp-sysA` | Golden Pocket | System A (RSI) | None | GP signals filtered by BTC RSI bias |
| `exp-gp-sysB` | Golden Pocket | System B | None | GP signals filtered by multi-indicator bias |
| `exp-gp-sysB-contrarian` | Golden Pocket | System B | Contrarian only | Double filter: System B + contrarian quadrants |

### Hypothesis Testing

1. **System B vs System A**: Does multi-indicator bias outperform RSI-only?
2. **GP + Filters**: GP bots have no bias/regime filters - would adding them improve performance?
3. **Contrarian Quadrants**: NEU+BEAR and BEAR+BEAR showed 93% win rate historically - validate this

### Signal Processing Flow
- ALL signals feed into regime detectors for history building
- Backburner setups → `exp-bb-*` bots
- Golden Pocket setups → `exp-gp-*` bots
- System B bias updates every 10 seconds

### Data Collection
- All trades logged to Turso with `entryBias` and `entryQuadrant` fields
- Stats tracked by bias level and quadrant for later analysis
- Dashboard state includes `experimentalBots` section

### Usage Notes
- Run `npm run start` to start server with experimental bots
- Check `/api/state` for experimental bot performance
- Bots reset with daily reset or manual reset

---

#### 1. Timezone/Time-of-Day Analysis (Priority: Medium)
(moved down - need more data first)
