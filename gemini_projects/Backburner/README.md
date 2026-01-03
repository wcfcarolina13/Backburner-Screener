# Backburner Screener

Real-time MEXC screener implementing **The Chart Guys' Backburner strategy**.

## Strategy Overview

The Backburner strategy targets high-probability bounce entries by identifying:

1. **Impulse Move**: A strong directional move (≥5% by default)
2. **First Oversold**: The FIRST RSI reading below 30 after that impulse
3. **Entry**: Buy on the first oversold condition for a high-probability bounce

The key insight is that the **first** oversold reading after a strong move has a much higher probability of bouncing than subsequent oversold readings.

## How It Works

### Detection Logic

For each symbol on each timeframe (5m, 15m, 1h):

1. **Find Impulse Move**
   - Scans last 50 candles for a swing low → swing high move
   - Move must be ≥5% to qualify
   - Higher timeframe trend should be bullish (optional confirmation)

2. **Check RSI Condition**
   - RSI < 30 = **Triggered** (primary entry signal)
   - RSI < 20 = **Deep Oversold** (secondary add opportunity)
   - Must be the FIRST oversold reading since the impulse

3. **Volume Confirmation**
   - Volume should contract during pullback vs impulse
   - Indicates orderly pullback, not panic selling

4. **Setup Lifecycle**
   - `triggered` → RSI just broke below 30
   - `deep_oversold` → RSI below 20 (stronger signal)
   - `bouncing` → RSI recovering above 30
   - `played_out` → Setup complete or invalidated

### Timeframes

Each timeframe is scanned independently:

| Timeframe | Use Case | Setup Expiry |
|-----------|----------|--------------|
| 5m | Scalping, quick bounces | 2 hours |
| 15m | Intraday swings | 6 hours |
| 1h | Larger swings | 24 hours |

A symbol can have active setups on multiple timeframes simultaneously.

## Installation

```bash
cd /Users/roti/gemini_projects/Backburner
npm install
```

## Usage

```bash
# Default settings (5m, 15m, 1h | $5M volume | 5% impulse)
npm run dev

# Custom timeframes
npm run dev -- -t 15m,1h

# Higher volume filter
npm run dev -- -v 10000000    # $10M minimum

# Bigger impulse moves
npm run dev -- -m 8           # 8% minimum move

# All options
npm run dev -- -t 5m,15m,1h -v 5000000 -m 5 -i 15
```

### Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `-t, --timeframes` | Comma-separated timeframes | `5m,15m,1h` |
| `-v, --min-volume` | Minimum 24h volume (USDT) | `5000000` |
| `-m, --min-impulse` | Minimum impulse move % | `5` |
| `-i, --interval` | Update interval (seconds) | `10` |
| `-h, --help` | Show help | |

## Display

```
╔══════════════════════════════════════════════════════════════════╗
║  BACKBURNER SCREENER - TCG Strategy Scanner for MEXC             ║
╠══════════════════════════════════════════════════════════════════╣
║  Strategy: First RSI < 30 after impulse move = High prob bounce  ║
║  Timeframes: 5m, 15m, 1h | RSI Triggers: <30 (entry), <20 (add)  ║
╚══════════════════════════════════════════════════════════════════╝

● Backburner Screener | 127 symbols | 2 active setups
  Last update: 3:45:22 PM | Monitoring 127 symbols...

  Triggered: 1 | Deep Oversold: 0 | Bouncing: 1
  5m: 1 | 15m: 0 | 1h: 1

┌───────────┬─────┬───────────────┬───────┬─────────────┬─────────┬─────────┬─────┬───────────┐
│ Symbol    │ TF  │ State         │ RSI   │ Price       │ Impulse │ Vol Rat │ HTF │ Detected  │
├───────────┼─────┼───────────────┼───────┼─────────────┼─────────┼─────────┼─────┼───────────┤
│ SOL       │ 5m  │  TRIGGERED    │ 28.4  │ 185.23      │ +7.82%  │ 0.45    │ ↑   │ 2m ago    │
│ AVAX      │ 1h  │  BOUNCING     │ 35.2  │ 42.15       │ +5.21%  │ 0.62    │ ↑   │ 45m ago   │
└───────────┴─────┴───────────────┴───────┴─────────────┴─────────┴─────────┴─────┴───────────┘
```

### Column Descriptions

| Column | Description |
|--------|-------------|
| Symbol | Trading pair (USDT suffix removed) |
| TF | Timeframe (5m, 15m, 1h) |
| State | Setup state (TRIGGERED, DEEP OVERSOLD, BOUNCING) |
| RSI | Current RSI value |
| Price | Current price |
| Impulse | Size of the impulse move that preceded the setup |
| Vol Ratio | Pullback volume / Impulse volume (lower = better) |
| HTF | Higher timeframe trend (↑ bullish, ↓ bearish) |
| Detected | Time since setup was first detected |

## Filters

### Volume Filter
- Default: $5M minimum 24h volume
- Filters out illiquid shitcoins

### Exclusions
Automatically excludes:
- Stablecoins (USDT, USDC, DAI, etc.)
- Leveraged tokens (3L, 3S, BULL, BEAR)
- Wrapped tokens (WBTC, WETH)
- Low-quality meme patterns (SafeMoon clones, random INU coins)
- Rebasing tokens (AMPL, OHM)

## API

Uses MEXC's free public API:
- No API key required
- No cost
- Rate limited to respect MEXC's limits

## Architecture

```
src/
├── index.ts              # CLI entry point
├── config.ts             # Configuration and defaults
├── types.ts              # TypeScript interfaces
├── mexc-api.ts           # MEXC API client with rate limiting
├── indicators.ts         # RSI, volume, trend calculations
├── backburner-detector.ts # Core detection algorithm
├── screener.ts           # Real-time scanning engine
└── display.ts            # Terminal UI
```

## Notes

- The strategy is selective - you may see few/no setups during quiet markets
- More setups appear during volatility and after strong moves
- Each timeframe is independent - same symbol can trigger on multiple TFs
- Setups auto-expire based on timeframe (2h for 5m, 6h for 15m, 24h for 1h)
