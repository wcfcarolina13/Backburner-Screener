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

| Bot | Strategy |
|-----|----------|
| Trail Wide | Wide trailing stops, lets winners run |
| Trail Standard (10x) | Standard trailing with 10x leverage |
| Trail Aggressive (20x) | Aggressive trailing with 20x leverage |
| Trail Light (1%) | Light 1% trailing stop |
| Fixed TP/SL | Fixed take profit and stop loss |
| GP-Conservative | Golden Pocket entry, conservative sizing |
| GP-Standard | Golden Pocket entry, standard sizing |
| GP-Aggressive | Golden Pocket entry, aggressive sizing |
| GP-YOLO | Golden Pocket entry, maximum conviction |

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
