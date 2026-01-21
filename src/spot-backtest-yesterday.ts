/**
 * Spot-Only Backtest using Yesterday's Focus Mode Signals
 *
 * Simulates US-compliant spot trading:
 * - LONG only (no shorts)
 * - 1x leverage (spot)
 * - Sequential trades (capital tied up until position closes)
 * - Uses actual trigger prices and outcomes from paper trading
 */

// Raw data from Turso - opens
const opens = [
  { timestamp: "2026-01-21T13:03:12.347Z", symbol: "SAFEUSDT", direction: "long", entry_price: 0.2029014, position_id: "SAFEUSDT-5m-1769000539049" },
  { timestamp: "2026-01-21T13:15:40.305Z", symbol: "XVSUSDT", direction: "long", entry_price: 5.4145059, position_id: "XVSUSDT-5m-1769001340100" },
  { timestamp: "2026-01-21T14:04:19.926Z", symbol: "HEIUSDT", direction: "long", entry_price: 0.13986990000000002, position_id: "HEIUSDT-15m-1769004258368" },
  { timestamp: "2026-01-21T14:11:24.105Z", symbol: "CVXUSDT", direction: "short", entry_price: 2.082958, position_id: "CVXUSDT-5m-1769004682844" },
  { timestamp: "2026-01-21T14:24:46.432Z", symbol: "AEROUSDT", direction: "short", entry_price: 0.46886545, position_id: "AEROUSDT-15m-1769005486127" },
  { timestamp: "2026-01-21T14:37:42.629Z", symbol: "SAGAUSDT", direction: "short", entry_price: 0.055242365, position_id: "SAGAUSDT-15m-1769006262385" },
  { timestamp: "2026-01-21T14:55:20.628Z", symbol: "XNYUSDT", direction: "long", entry_price: 0.0039989985, position_id: "XNYUSDT-15m-1769007320259" },
  { timestamp: "2026-01-21T15:00:41.830Z", symbol: "DRIFTUSDT", direction: "short", entry_price: 0.15522234999999998, position_id: "DRIFTUSDT-15m-1769007641629" },
  { timestamp: "2026-01-21T15:06:49.640Z", symbol: "REZUSDT", direction: "long", entry_price: 0.0047573775, position_id: "REZUSDT-5m-1769008008083" },
  { timestamp: "2026-01-21T15:10:39.058Z", symbol: "PROMUSDT", direction: "short", entry_price: 2.6336825, position_id: "PROMUSDT-5m-1769008238430" },
  { timestamp: "2026-01-21T15:53:25.456Z", symbol: "PIVXUSDT", direction: "long", entry_price: 0.1782891, position_id: "PIVXUSDT-5m-1769010805268" },
  { timestamp: "2026-01-21T15:53:30.731Z", symbol: "PROMUSDT", direction: "short", entry_price: 2.6496744999999997, position_id: "PROMUSDT-15m-1769010373801" },
  { timestamp: "2026-01-21T16:19:12.091Z", symbol: "TWTUSDT", direction: "long", entry_price: 0.8697346499999999, position_id: "TWTUSDT-15m-1769012351872" },
  { timestamp: "2026-01-21T16:25:05.597Z", symbol: "DOGUSDT", direction: "long", entry_price: 0.001352676, position_id: "DOGUSDT-15m-1769012705423" },
  { timestamp: "2026-01-21T17:19:47.355Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.030914535, position_id: "GUNUSDT-4h-1769015986909" },
  { timestamp: "2026-01-21T17:23:56.196Z", symbol: "NFPUSDT", direction: "long", entry_price: 0.024802394999999998, position_id: "NFPUSDT-15m-1769016235908" },
  { timestamp: "2026-01-21T17:24:18.612Z", symbol: "LITUSDT", direction: "long", entry_price: 1.6758375, position_id: "LITUSDT-15m-1769016258208" },
  { timestamp: "2026-01-21T17:24:32.004Z", symbol: "RENDERUSDT", direction: "long", entry_price: 1.982991, position_id: "RENDERUSDT-15m-1769016270706" },
  { timestamp: "2026-01-21T17:25:17.608Z", symbol: "WCTUSDT", direction: "long", entry_price: 0.072406185, position_id: "WCTUSDT-15m-1769016317207" },
  { timestamp: "2026-01-21T17:35:17.607Z", symbol: "GIGAUSDT", direction: "long", entry_price: 0.003679839, position_id: "GIGAUSDT-5m-1769016917181" },
  { timestamp: "2026-01-21T17:36:30.054Z", symbol: "ZROUSDT", direction: "long", entry_price: 1.8839415, position_id: "ZROUSDT-5m-1769016989491" },
  { timestamp: "2026-01-21T17:55:37.027Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.03112443, position_id: "GUNUSDT-4h-1769018136538" },
  { timestamp: "2026-01-21T17:56:13.136Z", symbol: "RAREUSDT", direction: "long", entry_price: 0.027303644999999998, position_id: "RAREUSDT-5m-1769018171667" },
  { timestamp: "2026-01-21T18:00:50.941Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.081650805, position_id: "MINAUSDT-15m-1769018450638" },
  { timestamp: "2026-01-21T18:01:04.944Z", symbol: "BOMEUSDT", direction: "long", entry_price: 0.0005836917, position_id: "BOMEUSDT-15m-1769018464736" },
  { timestamp: "2026-01-21T18:26:08.822Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.0816408, position_id: "MINAUSDT-15m-1769019968415" },
  { timestamp: "2026-01-21T18:30:17.094Z", symbol: "ANIMEUSDT", direction: "long", entry_price: 0.006306151499999999, position_id: "ANIMEUSDT-15m-1769020216757" },
  { timestamp: "2026-01-21T18:34:36.838Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.030874555, position_id: "GUNUSDT-4h-1769020476578" },
  { timestamp: "2026-01-21T19:28:01.615Z", symbol: "VETUSDT", direction: "short", entry_price: 0.01033483, position_id: "VETUSDT-5m-1769023681191" },
  { timestamp: "2026-01-21T19:28:14.505Z", symbol: "SPXUSDT", direction: "short", entry_price: 0.44667655, position_id: "SPXUSDT-5m-1769023693939" },
  { timestamp: "2026-01-21T19:28:29.709Z", symbol: "RSRUSDT", direction: "short", entry_price: 0.0023518235, position_id: "RSRUSDT-5m-1769023708995" },
  { timestamp: "2026-01-21T19:28:37.821Z", symbol: "WOOUSDT", direction: "short", entry_price: 0.025217385, position_id: "WOOUSDT-15m-1769023717656" },
  { timestamp: "2026-01-21T19:29:09.383Z", symbol: "DOTUSDT", direction: "short", entry_price: 1.9510239999999999, position_id: "DOTUSDT-5m-1769023749207" },
  { timestamp: "2026-01-21T19:29:10.737Z", symbol: "BIOUSDT", direction: "short", entry_price: 0.04801598, position_id: "BIOUSDT-5m-1769023750560" },
  { timestamp: "2026-01-21T19:29:12.760Z", symbol: "DEEPUSDT", direction: "short", entry_price: 0.0397571115, position_id: "DEEPUSDT-5m-1769023752559" },
  { timestamp: "2026-01-21T19:29:13.501Z", symbol: "0GUSDT", direction: "short", entry_price: 0.7548224, position_id: "0GUSDT-5m-1769023753303" },
  { timestamp: "2026-01-21T19:41:37.756Z", symbol: "FETUSDT", direction: "short", entry_price: 0.24197895, position_id: "FETUSDT-5m-1769024270826" },
  { timestamp: "2026-01-21T19:45:51.010Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.03208395, position_id: "GUNUSDT-4h-1769024750117" },
  { timestamp: "2026-01-21T19:47:59.213Z", symbol: "CHZUSDT", direction: "short", entry_price: 0.05175411, position_id: "CHZUSDT-5m-1769024878843" },
];

// Raw data from Turso - closes (outcomes)
const closes = [
  { timestamp: "2026-01-21T13:16:53.465Z", symbol: "XVSUSDT", direction: "long", entry_price: 5.4145059, exit_price: 5.43728, exit_reason: "trailing_stop", position_id: "XVSUSDT-5m-1769001340100" },
  { timestamp: "2026-01-21T13:47:12.922Z", symbol: "SAFEUSDT", direction: "long", entry_price: 0.2029014, exit_price: 0.19760114999999998, exit_reason: "stop_loss", position_id: "SAFEUSDT-5m-1769000539049" },
  { timestamp: "2026-01-21T14:07:49.032Z", symbol: "HEIUSDT", direction: "long", entry_price: 0.13986990000000002, exit_price: 0.14122935, exit_reason: "trailing_stop", position_id: "HEIUSDT-15m-1769004258368" },
  { timestamp: "2026-01-21T14:12:39.291Z", symbol: "CVXUSDT", direction: "short", entry_price: 2.082958, exit_price: 2.077038, exit_reason: "trailing_stop", position_id: "CVXUSDT-5m-1769004682844" },
  { timestamp: "2026-01-21T15:02:12.030Z", symbol: "XNYUSDT", direction: "long", entry_price: 0.0039989985, exit_price: 0.0040169905, exit_reason: "trailing_stop", position_id: "XNYUSDT-15m-1769007320259" },
  { timestamp: "2026-01-21T15:17:52.946Z", symbol: "REZUSDT", direction: "long", entry_price: 0.0047573775, exit_price: 0.004775611, exit_reason: "trailing_stop", position_id: "REZUSDT-5m-1769008008083" },
  { timestamp: "2026-01-21T15:36:02.819Z", symbol: "PROMUSDT", direction: "short", entry_price: 2.6336825, exit_price: 2.625312, exit_reason: "trailing_stop", position_id: "PROMUSDT-5m-1769008238430" },
  { timestamp: "2026-01-21T15:36:32.953Z", symbol: "DRIFTUSDT", direction: "short", entry_price: 0.15522234999999998, exit_price: 0.15457725, exit_reason: "trailing_stop", position_id: "DRIFTUSDT-15m-1769007641629" },
  { timestamp: "2026-01-21T16:02:04.571Z", symbol: "PIVXUSDT", direction: "long", entry_price: 0.1782891, exit_price: 0.17901045000000002, exit_reason: "trailing_stop", position_id: "PIVXUSDT-5m-1769010805268" },
  { timestamp: "2026-01-21T16:22:05.759Z", symbol: "PROMUSDT", direction: "short", entry_price: 2.6496744999999997, exit_price: 2.6263125, exit_reason: "trailing_stop", position_id: "PROMUSDT-15m-1769010373801" },
  { timestamp: "2026-01-21T16:30:15.021Z", symbol: "DOGUSDT", direction: "long", entry_price: 0.001352676, exit_price: 0.0013563215, exit_reason: "trailing_stop", position_id: "DOGUSDT-15m-1769012705423" },
  { timestamp: "2026-01-21T17:28:51.430Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.030914535, exit_price: 0.030845415, exit_reason: "trailing_stop", position_id: "GUNUSDT-4h-1769015986909" },
  { timestamp: "2026-01-21T18:02:39.054Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.03112443, exit_price: 0.0310155, exit_reason: "trailing_stop", position_id: "GUNUSDT-4h-1769018136538" },
  { timestamp: "2026-01-21T18:13:29.059Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.081650805, exit_price: 0.081959, exit_reason: "trailing_stop", position_id: "MINAUSDT-15m-1769018450638" },
  { timestamp: "2026-01-21T18:14:08.947Z", symbol: "BOMEUSDT", direction: "long", entry_price: 0.0005836917, exit_price: 0.0005869063999999999, exit_reason: "trailing_stop", position_id: "BOMEUSDT-15m-1769018464736" },
  { timestamp: "2026-01-21T18:15:09.245Z", symbol: "RAREUSDT", direction: "long", entry_price: 0.027303644999999998, exit_price: 0.027376305, exit_reason: "trailing_stop", position_id: "RAREUSDT-5m-1769018171667" },
  { timestamp: "2026-01-21T18:38:41.226Z", symbol: "GUNUSDT", direction: "short", entry_price: 0.030874555, exit_price: 0.030705345, exit_reason: "trailing_stop", position_id: "GUNUSDT-4h-1769020476578" },
  { timestamp: "2026-01-21T18:40:41.527Z", symbol: "ANIMEUSDT", direction: "long", entry_price: 0.006306151499999999, exit_price: 0.0063538215, exit_reason: "trailing_stop", position_id: "ANIMEUSDT-15m-1769020216757" },
  { timestamp: "2026-01-21T18:49:11.310Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.0816408, exit_price: 0.08245875, exit_reason: "trailing_stop", position_id: "MINAUSDT-15m-1769019968415" },
  { timestamp: "2026-01-21T19:41:11.532Z", symbol: "DEEPUSDT", direction: "short", entry_price: 0.0397571115, exit_price: 0.041010495, exit_reason: "stop_loss", position_id: "DEEPUSDT-5m-1769023752559" },
  { timestamp: "2026-01-21T19:46:19.862Z", symbol: "SPXUSDT", direction: "short", entry_price: 0.44667655, exit_price: 0.46133055, exit_reason: "stop_loss", position_id: "SPXUSDT-5m-1769023693939" },
  { timestamp: "2026-01-21T19:46:54.811Z", symbol: "WOOUSDT", direction: "short", entry_price: 0.025217385, exit_price: 0.026012999999999998, exit_reason: "stop_loss", position_id: "WOOUSDT-15m-1769023717656" },
  { timestamp: "2026-01-21T20:01:01.693Z", symbol: "VETUSDT", direction: "short", entry_price: 0.01033483, exit_price: 0.010665329999999999, exit_reason: "stop_loss", position_id: "VETUSDT-5m-1769023681191" },
];

// Build outcome map
const outcomeMap = new Map<string, typeof closes[0]>();
for (const close of closes) {
  outcomeMap.set(close.position_id, close);
}

// Filter to LONG only
const longOpens = opens.filter(o => o.direction === 'long');

// Deduplicate by symbol (take first occurrence only)
const seenSymbols = new Set<string>();
const uniqueLongOpens = longOpens.filter(o => {
  if (seenSymbols.has(o.symbol)) return false;
  seenSymbols.add(o.symbol);
  return true;
});

console.log('\n' + '='.repeat(80));
console.log('SPOT-ONLY BACKTEST - Yesterday\'s Focus Mode Signals');
console.log('='.repeat(80));
console.log(`\nTotal signals: ${opens.length}`);
console.log(`Long signals: ${longOpens.length}`);
console.log(`Unique symbols (first occurrence only): ${uniqueLongOpens.length}`);
console.log(`Short signals (SKIPPED): ${opens.length - longOpens.length}`);

// Position sizing: use 10% of available balance per trade (same as focus-aggressive)
const POSITION_SIZE_PERCENT = 10;

interface SpotTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  exitReason: string;
  positionSize: number;  // $ amount invested
  pnlPercent: number;    // Price change % (1x leverage)
  pnlDollar: number;     // $ profit/loss
}

function runBacktest(initialBalance: number): {
  trades: SpotTrade[];
  finalBalance: number;
  totalPnL: number;
  winRate: number;
  wins: number;
  losses: number;
  tradesSkipped: number;
} {
  let balance = initialBalance;
  const trades: SpotTrade[] = [];
  let tradesSkipped = 0;

  // Sort by timestamp
  const sortedOpens = [...uniqueLongOpens].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Track open positions (can only have capital in one trade at a time for simplicity)
  // Actually, let's allow multiple positions but track capital properly
  let capitalInUse = 0;
  const openPositions: Map<string, { symbol: string; entryPrice: number; entryTime: string; positionSize: number; positionId: string }> = new Map();

  // Create a timeline of all events (opens and closes)
  type Event = { type: 'open' | 'close'; timestamp: string; data: any };
  const events: Event[] = [];

  for (const open of sortedOpens) {
    events.push({ type: 'open', timestamp: open.timestamp, data: open });
  }

  for (const close of closes) {
    // Only include closes for longs we might have taken
    if (close.direction === 'long' && seenSymbols.has(close.symbol)) {
      events.push({ type: 'close', timestamp: close.timestamp, data: close });
    }
  }

  // Sort by timestamp
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Process events
  for (const event of events) {
    if (event.type === 'close') {
      const close = event.data;
      const position = openPositions.get(close.position_id);

      if (position) {
        // Calculate spot PnL (1x leverage)
        const priceChange = (close.exit_price - position.entryPrice) / position.entryPrice;
        const pnlDollar = position.positionSize * priceChange;

        trades.push({
          symbol: position.symbol,
          entryPrice: position.entryPrice,
          exitPrice: close.exit_price,
          entryTime: position.entryTime,
          exitTime: close.timestamp,
          exitReason: close.exit_reason,
          positionSize: position.positionSize,
          pnlPercent: priceChange * 100,
          pnlDollar,
        });

        // Return capital + PnL to balance
        balance += position.positionSize + pnlDollar;
        capitalInUse -= position.positionSize;
        openPositions.delete(close.position_id);
      }
    } else {
      // Open event
      const open = event.data;
      const outcome = outcomeMap.get(open.position_id);

      // Skip if no outcome data (position still open or no match)
      if (!outcome) {
        tradesSkipped++;
        continue;
      }

      // Calculate position size (10% of available balance)
      const availableBalance = balance - capitalInUse;
      const positionSize = availableBalance * (POSITION_SIZE_PERCENT / 100);

      // Skip if insufficient balance
      if (positionSize < 1) {
        tradesSkipped++;
        continue;
      }

      // Open the position
      openPositions.set(open.position_id, {
        symbol: open.symbol,
        entryPrice: open.entry_price,
        entryTime: open.timestamp,
        positionSize,
        positionId: open.position_id,
      });

      capitalInUse += positionSize;
      balance -= positionSize;
    }
  }

  // Close any remaining open positions at their known exit price
  for (const [posId, position] of openPositions) {
    const outcome = outcomeMap.get(posId);
    if (outcome) {
      const priceChange = (outcome.exit_price - position.entryPrice) / position.entryPrice;
      const pnlDollar = position.positionSize * priceChange;

      trades.push({
        symbol: position.symbol,
        entryPrice: position.entryPrice,
        exitPrice: outcome.exit_price,
        entryTime: position.entryTime,
        exitTime: outcome.timestamp,
        exitReason: outcome.exit_reason,
        positionSize: position.positionSize,
        pnlPercent: priceChange * 100,
        pnlDollar,
      });

      balance += position.positionSize + pnlDollar;
    }
  }

  const wins = trades.filter(t => t.pnlDollar > 0).length;
  const losses = trades.filter(t => t.pnlDollar <= 0).length;
  const totalPnL = trades.reduce((sum, t) => sum + t.pnlDollar, 0);

  return {
    trades,
    finalBalance: balance,
    totalPnL,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    wins,
    losses,
    tradesSkipped,
  };
}

// Run backtests for different account sizes
const accountSizes = [100, 500, 1000, 2000];

console.log('\n' + '='.repeat(80));
console.log('RESULTS BY ACCOUNT SIZE (10% position sizing, 1x leverage spot)');
console.log('='.repeat(80));

for (const size of accountSizes) {
  const result = runBacktest(size);

  console.log(`\n$${size} ACCOUNT:`);
  console.log('-'.repeat(40));
  console.log(`  Trades Taken: ${result.trades.length}`);
  console.log(`  Trades Skipped: ${result.tradesSkipped}`);
  console.log(`  Wins: ${result.wins} | Losses: ${result.losses}`);
  console.log(`  Win Rate: ${result.winRate.toFixed(1)}%`);
  console.log(`  Total PnL: $${result.totalPnL.toFixed(2)} (${((result.totalPnL / size) * 100).toFixed(2)}%)`);
  console.log(`  Final Balance: $${result.finalBalance.toFixed(2)}`);

  if (result.trades.length > 0) {
    const avgWin = result.trades.filter(t => t.pnlDollar > 0).reduce((sum, t) => sum + t.pnlDollar, 0) / Math.max(result.wins, 1);
    const avgLoss = Math.abs(result.trades.filter(t => t.pnlDollar <= 0).reduce((sum, t) => sum + t.pnlDollar, 0)) / Math.max(result.losses, 1);
    console.log(`  Avg Win: $${avgWin.toFixed(2)} | Avg Loss: $${avgLoss.toFixed(2)}`);
    console.log(`  Profit Factor: ${avgLoss > 0 ? (avgWin * result.wins / (avgLoss * result.losses)).toFixed(2) : 'N/A'}`);
  }
}

// Detailed trade log for $2000 account
console.log('\n' + '='.repeat(80));
console.log('DETAILED TRADE LOG ($2000 account)');
console.log('='.repeat(80));

const detailedResult = runBacktest(2000);
console.log('\n#  | Symbol       | Entry      | Exit       | Size    | PnL %   | PnL $   | Exit Reason');
console.log('-'.repeat(100));

detailedResult.trades.forEach((trade, i) => {
  const pnlSign = trade.pnlDollar >= 0 ? '+' : '';
  console.log(
    `${String(i + 1).padStart(2)} | ${trade.symbol.padEnd(12)} | ${trade.entryPrice.toPrecision(6).padStart(10)} | ${trade.exitPrice.toPrecision(6).padStart(10)} | $${trade.positionSize.toFixed(2).padStart(6)} | ${pnlSign}${trade.pnlPercent.toFixed(2).padStart(5)}% | ${pnlSign}$${trade.pnlDollar.toFixed(2).padStart(5)} | ${trade.exitReason}`
  );
});

// Summary comparison: Leveraged vs Spot
console.log('\n' + '='.repeat(80));
console.log('LEVERAGE COMPARISON (same trades, $2000 account)');
console.log('='.repeat(80));

const spotResult = runBacktest(2000);
const spotPnL = spotResult.totalPnL;

// Calculate what leveraged would have been (22.5x was used)
const leveragedPnL = spotResult.trades.reduce((sum, t) => {
  // At 22.5x, the PnL would be 22.5x the spot PnL
  return sum + (t.pnlDollar * 22.5);
}, 0);

console.log(`\nSpot (1x):      $${spotPnL.toFixed(2)} (${((spotPnL / 2000) * 100).toFixed(2)}% return)`);
console.log(`Futures (22.5x): $${leveragedPnL.toFixed(2)} (${((leveragedPnL / 2000) * 100).toFixed(2)}% return)`);
console.log(`\nNote: Leveraged returns assume same position sizing and no liquidations.`);
console.log(`      In reality, several positions would have been liquidated at 22.5x.`);
