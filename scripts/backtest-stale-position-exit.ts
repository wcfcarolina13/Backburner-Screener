/**
 * Backtest: Stale Position Exit
 *
 * Tests closing positions after a certain duration, even if still profitable.
 *
 * Hypothesis: Based on data analysis:
 * - Trades 2-4 hrs have -$35 total (negative!)
 * - Trades 4+ hrs have -$4 total (also negative!)
 * - Best performance is 5-15 min range ($2,445 profit)
 *
 * This backtest tests:
 * 1. Force close at 1 hour if profitable
 * 2. Force close at 2 hours if profitable
 * 3. Force close at 30 minutes if 15%+ profit (take the win)
 * 4. Tighten SL to breakeven after 1 hour
 */

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

interface TradeRecord {
  symbol: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  realized_pnl_percent: number;
  exit_reason: string;
  highest_pnl_percent: number;
  duration_ms: number;
  margin_used: number;
}

interface StaleStrategy {
  name: string;
  // Returns simulated exit PnL% for this trade
  simulate: (trade: TradeRecord) => number;
}

const strategies: StaleStrategy[] = [
  {
    name: 'Baseline (no time limit)',
    simulate: (trade) => trade.realized_pnl_percent,
  },
  {
    name: 'Force close at 1hr if profitable',
    simulate: (trade) => {
      const oneHour = 60 * 60 * 1000;
      if (trade.duration_ms > oneHour && trade.highest_pnl_percent > 5) {
        // Assume we'd exit at ~50% of peak at 1hr mark
        // (conservative estimate - price is somewhere between entry and peak)
        return Math.max(5, trade.highest_pnl_percent * 0.5);
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Force close at 2hr if profitable',
    simulate: (trade) => {
      const twoHours = 2 * 60 * 60 * 1000;
      if (trade.duration_ms > twoHours && trade.highest_pnl_percent > 5) {
        // Exit at ~40% of peak at 2hr mark (price likely lower)
        return Math.max(5, trade.highest_pnl_percent * 0.4);
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Exit at 30min if 20%+ profit',
    simulate: (trade) => {
      const thirtyMin = 30 * 60 * 1000;
      // If peak was 20%+ and trade lasted over 30min, we would've exited earlier
      if (trade.highest_pnl_percent >= 20 && trade.duration_ms > thirtyMin) {
        // Exit at 20% (the trigger)
        return 20;
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Exit at 30min if 25%+ profit',
    simulate: (trade) => {
      const thirtyMin = 30 * 60 * 1000;
      if (trade.highest_pnl_percent >= 25 && trade.duration_ms > thirtyMin) {
        return 25;
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Exit at 15min if 30%+ profit',
    simulate: (trade) => {
      const fifteenMin = 15 * 60 * 1000;
      if (trade.highest_pnl_percent >= 30 && trade.duration_ms > fifteenMin) {
        return 30;
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Move SL to breakeven after 1hr',
    simulate: (trade) => {
      const oneHour = 60 * 60 * 1000;
      if (trade.duration_ms > oneHour) {
        // After 1hr, SL is at breakeven. If final was negative, we'd exit at 0
        if (trade.realized_pnl_percent < 0) {
          return 0; // Breakeven exit
        }
      }
      return trade.realized_pnl_percent;
    },
  },
  {
    name: 'Hybrid: 30%+ exit early OR breakeven after 1hr',
    simulate: (trade) => {
      const fifteenMin = 15 * 60 * 1000;
      const oneHour = 60 * 60 * 1000;

      // Exit at 30%+ after 15min
      if (trade.highest_pnl_percent >= 30 && trade.duration_ms > fifteenMin) {
        return 30;
      }
      // Breakeven protection after 1hr
      if (trade.duration_ms > oneHour && trade.realized_pnl_percent < 0) {
        return 0;
      }
      return trade.realized_pnl_percent;
    },
  },
];

async function runBacktest() {
  console.log('='.repeat(80));
  console.log('STALE POSITION EXIT BACKTEST');
  console.log('='.repeat(80));
  console.log();

  // Fetch trades with duration and peak data
  const result = await db.execute(`
    SELECT
      symbol, direction, entry_price, exit_price,
      realized_pnl, realized_pnl_percent, exit_reason,
      highest_pnl_percent, duration_ms, margin_used
    FROM trade_events
    WHERE event_type = 'close'
      AND bot_id = 'exp-bb-sysB'
      AND duration_ms IS NOT NULL
      AND highest_pnl_percent IS NOT NULL
      AND margin_used > 0
    ORDER BY timestamp DESC
  `);

  const trades = result.rows as unknown as TradeRecord[];
  console.log(`Loaded ${trades.length} trades with duration and peak data\n`);

  // Show duration distribution first
  console.log('DURATION DISTRIBUTION:');
  const durationBuckets = [
    { name: '0-5 min', min: 0, max: 5 * 60 * 1000 },
    { name: '5-15 min', min: 5 * 60 * 1000, max: 15 * 60 * 1000 },
    { name: '15-30 min', min: 15 * 60 * 1000, max: 30 * 60 * 1000 },
    { name: '30-60 min', min: 30 * 60 * 1000, max: 60 * 60 * 1000 },
    { name: '1-2 hrs', min: 60 * 60 * 1000, max: 2 * 60 * 60 * 1000 },
    { name: '2-4 hrs', min: 2 * 60 * 60 * 1000, max: 4 * 60 * 60 * 1000 },
    { name: '4+ hrs', min: 4 * 60 * 60 * 1000, max: Infinity },
  ];

  for (const bucket of durationBuckets) {
    const bucketTrades = trades.filter(
      t => t.duration_ms >= bucket.min && t.duration_ms < bucket.max
    );
    if (bucketTrades.length === 0) continue;

    const totalPnl = bucketTrades.reduce((sum, t) => sum + t.realized_pnl, 0);
    const avgPnl = totalPnl / bucketTrades.length;
    console.log(
      `  ${bucket.name.padEnd(10)}: ${bucketTrades.length.toString().padStart(4)} trades, ` +
      `Total: $${totalPnl.toFixed(0).padStart(7)}, Avg: $${avgPnl.toFixed(2)}`
    );
  }
  console.log();

  // Analyze by strategy
  console.log('STRATEGY COMPARISON:');
  console.log('-'.repeat(80));
  console.log(
    'Strategy'.padEnd(45) +
    'Total PnL'.padStart(12) +
    'Win Rate'.padStart(10) +
    'vs Baseline'.padStart(12)
  );
  console.log('-'.repeat(80));

  const results: Array<{
    name: string;
    totalPnl: number;
    winRate: number;
  }> = [];

  for (const strategy of strategies) {
    let totalPnl = 0;
    let wins = 0;

    for (const trade of trades) {
      const simulatedPnlPct = strategy.simulate(trade);
      const pnlDollar = trade.margin_used * (simulatedPnlPct / 100);
      totalPnl += pnlDollar;
      if (simulatedPnlPct > 0) wins++;
    }

    results.push({
      name: strategy.name,
      totalPnl,
      winRate: (wins / trades.length) * 100,
    });
  }

  // Sort by total PnL
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  const baseline = results.find(r => r.name.includes('Baseline'))!;

  for (const r of results) {
    const diff = r.totalPnl - baseline.totalPnl;
    const diffStr = diff >= 0 ? `+$${diff.toFixed(0)}` : `-$${Math.abs(diff).toFixed(0)}`;

    console.log(
      r.name.substring(0, 44).padEnd(45) +
      `$${r.totalPnl.toFixed(0)}`.padStart(12) +
      `${r.winRate.toFixed(1)}%`.padStart(10) +
      (r.name.includes('Baseline') ? 'N/A'.padStart(12) : diffStr.padStart(12))
    );
  }

  console.log();

  // Show which trades would be affected by best strategy
  const bestStrategy = strategies.find(s => s.name === results[0].name)!;
  if (bestStrategy.name !== 'Baseline (no time limit)') {
    console.log(`\nTRADES AFFECTED BY BEST STRATEGY (${bestStrategy.name}):`);
    console.log('-'.repeat(80));

    let improved = 0;
    let degraded = 0;
    let unchanged = 0;

    for (const trade of trades) {
      const simPnl = bestStrategy.simulate(trade);
      if (simPnl > trade.realized_pnl_percent + 0.5) improved++;
      else if (simPnl < trade.realized_pnl_percent - 0.5) degraded++;
      else unchanged++;
    }

    console.log(`  Improved: ${improved} trades`);
    console.log(`  Degraded: ${degraded} trades`);
    console.log(`  Unchanged: ${unchanged} trades`);
  }

  console.log();
  console.log('='.repeat(80));
}

runBacktest().catch(console.error);
