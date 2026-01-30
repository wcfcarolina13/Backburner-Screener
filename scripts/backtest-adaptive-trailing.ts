/**
 * Backtest: Adaptive Trailing Stop
 *
 * Tests tightening the trailing stop as profits increase:
 * - At 10% profit: trail at 5% (lock in 5%)
 * - At 20% profit: trail at 5% (lock in 15%)
 * - At 30% profit: trail at 5% (lock in 25%)
 * - At 40%+ profit: trail at 3% (lock in 37%+)
 *
 * Hypothesis: Trades that reach high profits (30%+) often give back gains.
 * Tightening the trail should capture more of those peaks.
 *
 * Uses historical trade data with peak PnL tracking.
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

// Strategy configurations to test
interface TrailingConfig {
  name: string;
  thresholds: Array<{
    triggerPct: number;  // When profit reaches this %
    trailPct: number;    // Trail this % behind peak
  }>;
}

const strategies: TrailingConfig[] = [
  {
    name: 'Baseline (current: 10% trigger, 5% trail)',
    thresholds: [
      { triggerPct: 10, trailPct: 5 },
    ],
  },
  {
    name: 'Adaptive: Tighten at 30%',
    thresholds: [
      { triggerPct: 10, trailPct: 5 },
      { triggerPct: 30, trailPct: 3 },  // Tighten trail when up 30%
    ],
  },
  {
    name: 'Adaptive: Tighten at 20% and 40%',
    thresholds: [
      { triggerPct: 10, trailPct: 5 },
      { triggerPct: 20, trailPct: 4 },
      { triggerPct: 40, trailPct: 2 },
    ],
  },
  {
    name: 'Aggressive: 3% trail at 20%+',
    thresholds: [
      { triggerPct: 10, trailPct: 5 },
      { triggerPct: 20, trailPct: 3 },
    ],
  },
  {
    name: 'Conservative: 7% trail until 50%',
    thresholds: [
      { triggerPct: 10, trailPct: 7 },
      { triggerPct: 50, trailPct: 5 },
    ],
  },
  {
    name: 'Lock at 25%: Exit when reaching 25% profit',
    thresholds: [
      { triggerPct: 25, trailPct: 0 },  // 0% trail = immediate exit
    ],
  },
];

/**
 * Simulate what exit PnL would be under a given trailing config
 *
 * For each trade, we check:
 * 1. If peak never reached first trigger → use actual exit (SL or early exit)
 * 2. If peak reached a trigger → calculate exit as (peak - trail%)
 */
function simulateExit(trade: TradeRecord, config: TrailingConfig): number {
  const peak = trade.highest_pnl_percent;

  // Find highest triggered threshold
  let activeThreshold: { triggerPct: number; trailPct: number } | null = null;
  for (const thresh of config.thresholds) {
    if (peak >= thresh.triggerPct) {
      activeThreshold = thresh;
    }
  }

  if (!activeThreshold) {
    // Never triggered any trailing stop → use actual exit (was SL)
    return trade.realized_pnl_percent;
  }

  // Calculate simulated exit
  // If trailPct is 0, exit immediately at trigger
  if (activeThreshold.trailPct === 0) {
    // Exit at trigger price
    const simulatedPnl = activeThreshold.triggerPct;
    return Math.min(peak, simulatedPnl);  // Cap at peak
  }

  // Normal trailing: exit at peak - trail%
  const simulatedPnl = peak - activeThreshold.trailPct;

  // Can't do better than actual if actual was a win
  // (price may have moved faster than trailing could capture)
  if (trade.exit_reason === 'trailing_stop' && trade.realized_pnl_percent > simulatedPnl) {
    return trade.realized_pnl_percent;
  }

  return simulatedPnl;
}

async function runBacktest() {
  console.log('='.repeat(80));
  console.log('ADAPTIVE TRAILING STOP BACKTEST');
  console.log('='.repeat(80));
  console.log();

  // Fetch trades with peak data
  const result = await db.execute(`
    SELECT
      symbol, direction, entry_price, exit_price,
      realized_pnl, realized_pnl_percent, exit_reason,
      highest_pnl_percent, duration_ms, margin_used
    FROM trade_events
    WHERE event_type = 'close'
      AND bot_id = 'exp-bb-sysB'
      AND highest_pnl_percent IS NOT NULL
      AND margin_used > 0
    ORDER BY timestamp DESC
  `);

  const trades = result.rows as unknown as TradeRecord[];
  console.log(`Loaded ${trades.length} trades with peak PnL data\n`);

  // Analyze by strategy
  const results: Array<{
    name: string;
    totalPnl: number;
    avgPnl: number;
    winRate: number;
    improved: number;
    degraded: number;
  }> = [];

  for (const strategy of strategies) {
    let totalPnl = 0;
    let totalWins = 0;
    let improved = 0;
    let degraded = 0;

    for (const trade of trades) {
      const simulatedPnl = simulateExit(trade, strategy);
      const margin = trade.margin_used;
      const pnlDollar = margin * (simulatedPnl / 100);

      totalPnl += pnlDollar;
      if (simulatedPnl > 0) totalWins++;

      // Compare to actual
      if (simulatedPnl > trade.realized_pnl_percent) improved++;
      if (simulatedPnl < trade.realized_pnl_percent) degraded++;
    }

    results.push({
      name: strategy.name,
      totalPnl,
      avgPnl: totalPnl / trades.length,
      winRate: (totalWins / trades.length) * 100,
      improved,
      degraded,
    });
  }

  // Print results
  console.log('STRATEGY COMPARISON');
  console.log('-'.repeat(80));
  console.log(
    'Strategy'.padEnd(45) +
    'Total PnL'.padStart(12) +
    'Win Rate'.padStart(10) +
    'Improved'.padStart(10) +
    'Degraded'.padStart(10)
  );
  console.log('-'.repeat(80));

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
      r.improved.toString().padStart(10) +
      r.degraded.toString().padStart(10) +
      (r.name.includes('Baseline') ? '' : `  (${diffStr} vs baseline)`)
    );
  }

  console.log();
  console.log('='.repeat(80));

  // Analyze trades by peak bucket to see where improvement comes from
  console.log('\nIMPACT BY PEAK PROFIT LEVEL (Best Strategy vs Baseline)');
  console.log('-'.repeat(80));

  const bestStrategy = results[0];
  const bestConfig = strategies.find(s => s.name === bestStrategy.name)!;

  const buckets = [
    { name: '0-10%', min: 0, max: 10 },
    { name: '10-20%', min: 10, max: 20 },
    { name: '20-30%', min: 20, max: 30 },
    { name: '30-50%', min: 30, max: 50 },
    { name: '50%+', min: 50, max: 1000 },
  ];

  for (const bucket of buckets) {
    const bucketTrades = trades.filter(
      t => t.highest_pnl_percent >= bucket.min && t.highest_pnl_percent < bucket.max
    );

    if (bucketTrades.length === 0) continue;

    let baselinePnl = 0;
    let bestPnl = 0;

    for (const trade of bucketTrades) {
      const margin = trade.margin_used;

      // Baseline (current system)
      const baselineConfig = strategies[0];
      const baselineSimPnl = simulateExit(trade, baselineConfig);
      baselinePnl += margin * (baselineSimPnl / 100);

      // Best strategy
      const bestSimPnl = simulateExit(trade, bestConfig);
      bestPnl += margin * (bestSimPnl / 100);
    }

    const diff = bestPnl - baselinePnl;
    console.log(
      `Peak ${bucket.name.padEnd(8)}: ${bucketTrades.length.toString().padStart(4)} trades | ` +
      `Baseline: $${baselinePnl.toFixed(0).padStart(7)} | ` +
      `Best: $${bestPnl.toFixed(0).padStart(7)} | ` +
      `Diff: ${diff >= 0 ? '+' : ''}$${diff.toFixed(0)}`
    );
  }

  console.log();
}

runBacktest().catch(console.error);
