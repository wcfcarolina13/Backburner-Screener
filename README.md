# Backburner Screener

Real-time MEXC screener for The Chart Guys Backburner trading strategy. Monitors RSI oversold/overbought conditions across multiple timeframes and runs paper trading simulations with various bot strategies.

## Quick Start

```bash
# Install dependencies
npm install

# Run the web dashboard (development)
npm run dev:web

# Run the web dashboard (production)
npm run build && npm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev:web` | Start development server with hot reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run production server |
| `npm run summary` | Generate daily performance summary |
| `npm run check` | Check a specific symbol |
| `npm run analyze` | Run analysis tools |

## Daily Summary Auto-Generation

The project includes a script to automatically generate daily performance summaries of all paper trading bots.

### Manual Run

```bash
# Summarize today's trades
npm run summary

# Summarize a specific date
npm run summary 2026-01-14
```

### Automatic Scheduling (macOS)

To run the summary automatically at 11:55 PM every day:

```bash
# Make setup script executable
chmod +x scripts/setup-daily-summary.sh

# Run the setup (creates launchd job)
./scripts/setup-daily-summary.sh
```

### Managing the Schedule

```bash
# Check if scheduled
launchctl list | grep backburner

# Disable scheduling
launchctl unload ~/Library/LaunchAgents/com.backburner.daily-summary.plist

# Re-enable scheduling
launchctl load ~/Library/LaunchAgents/com.backburner.daily-summary.plist

# Completely remove
launchctl unload ~/Library/LaunchAgents/com.backburner.daily-summary.plist
rm ~/Library/LaunchAgents/com.backburner.daily-summary.plist
```

### Output

Summaries are appended to `data/analysis/daily-performance-log.md` with:
- Per-bot statistics (trades, wins, losses, win rate, P&L)
- Notable winning trades
- Market context analysis
- Observations and insights

Logs are written to `logs/daily-summary.log`.

## Paper Trading Bots

The system runs multiple paper trading strategies simultaneously:

### Core Bots
| Bot | Strategy |
|-----|----------|
| Fixed 20/20 | 1% position, 10x leverage, fixed 20% TP / 20% SL |
| Fixed BE | 1% position, 10x leverage, 20% TP, **SL moves to breakeven at +10% ROI** |
| Trail Light | 1% position, 10x leverage, trailing stops |
| Trail Standard | 10% position, 10x leverage, trailing stops |
| Trail Aggressive | 10% position, 20x leverage, trailing stops |
| Trail Wide | 10% position, 20x leverage, 20% trail trigger, 10% L1 lock |
| Confluence | Multi-timeframe confirmation (5m + 15m/1h required) |

### BTC-Specific Bots
| Bot | Strategy |
|-----|----------|
| BTC Contrarian | 10% position, 50x leverage, fades extreme RSI |
| BTC Momentum | 10% position, 50x leverage, follows strong trends |

### Golden Pocket Bots (Fibonacci Retracement)
| Bot | Strategy |
|-----|----------|
| GP-Conservative | 1% position, 5x leverage, strictest filters |
| GP-Standard | 5% position, 10x leverage, balanced approach |
| GP-Aggressive | 10% position, 20x leverage, looser filters |
| GP-YOLO | 25% position, 50x leverage, maximum risk |

### BTC Bias V2 Bots (Conservative)
8 variants with 10-20% position sizing, 10-20x leverage, 2-3% callback rates.

### Archived Bots
**BTC Bias V1** (8 variants with 100% position sizing, 50x leverage) - **DISABLED** due to catastrophic losses (-$12k in Jan 2026). Data preserved for analysis but no longer trading.

## Environment Variables

For Render deployment with persistent storage:

```
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
```

## Data Storage

- `data/trades/` - Daily trade JSON files
- `data/signals/` - Signal event logs
- `data/daily/` - Daily snapshot data
- `data/analysis/` - Performance analysis and logs
- `logs/` - Application logs

## License

MIT
