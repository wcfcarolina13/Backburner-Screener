/**
 * Analyze exp-bb-sysB performance during BTC selloffs and recovery periods
 */

import { createClient } from '@libsql/client';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';

async function analyze() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  // Get last 6 hours of exp-bb-sysB trades
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const trades = await client.execute({
    sql: `
      SELECT
        timestamp,
        symbol,
        direction,
        event_type,
        exit_reason,
        realized_pnl_percent,
        highest_pnl_percent
      FROM trade_events
      WHERE bot_id = 'exp-bb-sysB'
        AND timestamp >= ?
      ORDER BY timestamp DESC
    `,
    args: [sixHoursAgo]
  });

  console.log('=== LAST 6 HOURS: exp-bb-sysB ===\n');

  // Group by hour
  const byHour: Record<string, { opens: number; wins: number; losses: number; pnl: number }> = {};

  for (const row of trades.rows) {
    const hour = new Date(row.timestamp as string).toISOString().slice(0, 13) + ':00';
    if (!byHour[hour]) byHour[hour] = { opens: 0, wins: 0, losses: 0, pnl: 0 };

    if (row.event_type === 'open') {
      byHour[hour].opens++;
    } else if (row.event_type === 'close') {
      const pnl = Number(row.realized_pnl_percent) || 0;
      byHour[hour].pnl += pnl;
      if (row.exit_reason === 'stop_loss') {
        byHour[hour].losses++;
      } else {
        byHour[hour].wins++;
      }
    }
  }

  console.log('Hour (UTC)        | Opens | Wins | Losses | Net ROE%');
  console.log('------------------|-------|------|--------|----------');
  for (const [hour, data] of Object.entries(byHour).sort()) {
    const winRate = data.wins + data.losses > 0 ? (data.wins / (data.wins + data.losses) * 100).toFixed(0) : '-';
    console.log(
      `${hour} | ${String(data.opens).padStart(5)} | ${String(data.wins).padStart(4)} | ${String(data.losses).padStart(6)} | ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}% (${winRate}% WR)`
    );
  }

  // Recent closes detail
  const recentCloses = trades.rows.filter(r => r.event_type === 'close').slice(0, 20);
  console.log('\n=== RECENT CLOSES (last 20) ===\n');
  console.log('Time (UTC)  | Symbol       | Dir   | Exit Reason     | ROE%    | Peak%');
  console.log('------------|--------------|-------|-----------------|---------|-------');
  for (const row of recentCloses) {
    const time = new Date(row.timestamp as string).toISOString().slice(11, 19);
    const pnl = Number(row.realized_pnl_percent) || 0;
    const peak = row.highest_pnl_percent ? Number(row.highest_pnl_percent).toFixed(1) : '-';
    console.log(
      `${time} | ${String(row.symbol).padEnd(12)} | ${String(row.direction).padEnd(5)} | ${String(row.exit_reason).padEnd(15)} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1).padStart(5)}% | ${peak}%`
    );
  }

  // Historical: Look for similar BTC selloff periods and recovery
  console.log('\n=== HISTORICAL SELLOFF RECOVERY PATTERNS ===\n');

  // Get all data grouped by day
  const dailyStats = await client.execute({
    sql: `
      SELECT
        date,
        COUNT(CASE WHEN event_type = 'close' AND exit_reason = 'trailing_stop' THEN 1 END) as wins,
        COUNT(CASE WHEN event_type = 'close' AND exit_reason = 'stop_loss' THEN 1 END) as losses,
        SUM(CASE WHEN event_type = 'close' THEN realized_pnl_percent ELSE 0 END) as total_roe
      FROM trade_events
      WHERE bot_id = 'exp-bb-sysB'
      GROUP BY date
      ORDER BY date DESC
      LIMIT 14
    `,
    args: []
  });

  console.log('Date       | Wins | Losses | Win Rate | Net ROE%');
  console.log('-----------|------|--------|----------|----------');
  for (const row of dailyStats.rows) {
    const wins = Number(row.wins) || 0;
    const losses = Number(row.losses) || 0;
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(0) : '-';
    const roe = Number(row.total_roe) || 0;
    console.log(
      `${row.date} | ${String(wins).padStart(4)} | ${String(losses).padStart(6)} | ${String(winRate).padStart(7)}% | ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%`
    );
  }

  // Cumulative stats
  const cumulative = await client.execute({
    sql: `
      SELECT
        COUNT(CASE WHEN event_type = 'close' AND exit_reason = 'trailing_stop' THEN 1 END) as total_wins,
        COUNT(CASE WHEN event_type = 'close' AND exit_reason = 'stop_loss' THEN 1 END) as total_losses,
        AVG(CASE WHEN event_type = 'close' AND exit_reason = 'trailing_stop' THEN realized_pnl_percent END) as avg_win,
        AVG(CASE WHEN event_type = 'close' AND exit_reason = 'stop_loss' THEN realized_pnl_percent END) as avg_loss
      FROM trade_events
      WHERE bot_id = 'exp-bb-sysB'
    `,
    args: []
  });

  const stats = cumulative.rows[0];
  const totalWins = Number(stats.total_wins) || 0;
  const totalLosses = Number(stats.total_losses) || 0;
  const avgWin = Number(stats.avg_win) || 0;
  const avgLoss = Number(stats.avg_loss) || 0;

  console.log('\n=== OVERALL STATISTICS ===\n');
  console.log(`Total Wins:  ${totalWins} (avg +${avgWin.toFixed(1)}% ROE)`);
  console.log(`Total Losses: ${totalLosses} (avg ${avgLoss.toFixed(1)}% ROE)`);
  console.log(`Win Rate:    ${((totalWins / (totalWins + totalLosses)) * 100).toFixed(1)}%`);
  console.log(`Expectancy:  ${((totalWins * avgWin + totalLosses * avgLoss) / (totalWins + totalLosses)).toFixed(2)}% ROE per trade`);

  client.close();
}

analyze().catch(console.error);

// Additional analysis: Insurance/scaling-in opportunity using highest_pnl_percent
async function checkScalingOpportunity() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) return;

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('\n=== INSURANCE/SCALING OPPORTUNITY ANALYSIS ===\n');

  // Get closed trades with peak data
  const closedTrades = await client.execute(`
    SELECT
      highest_pnl_percent,
      exit_reason,
      realized_pnl_percent,
      symbol,
      direction,
      leverage,
      margin_used
    FROM trade_events
    WHERE bot_id = 'exp-bb-sysB'
      AND event_type = 'close'
      AND timestamp >= datetime('now', '-7 days')
  `);

  const withPeak = closedTrades.rows.filter(r => r.highest_pnl_percent != null);
  const slTrades = withPeak.filter(r => r.exit_reason === 'stop_loss');
  const winTrades = withPeak.filter(r => r.exit_reason === 'trailing_stop');

  console.log(`Total closed trades (7d): ${closedTrades.rows.length}`);
  console.log(`With highest_pnl_percent: ${withPeak.length}`);
  console.log(`  - Stop losses: ${slTrades.length}`);
  console.log(`  - Trailing wins: ${winTrades.length}`);

  // KEY QUESTION: How many SL trades were UP before failing?
  console.log('\n--- SL TRADES THAT WERE UP BEFORE STOPPING OUT ---\n');

  const thresholds = [1, 2, 3, 5, 8];
  for (const thresh of thresholds) {
    const wasUp = slTrades.filter(r => Number(r.highest_pnl_percent) >= thresh);
    const pct = slTrades.length > 0 ? (wasUp.length / slTrades.length * 100).toFixed(0) : '0';

    if (wasUp.length > 0) {
      const avgPeak = wasUp.reduce((s, r) => s + Number(r.highest_pnl_percent), 0) / wasUp.length;
      const avgFinal = wasUp.reduce((s, r) => s + Number(r.realized_pnl_percent), 0) / wasUp.length;
      console.log(`  Reached ${thresh}%+ ROE: ${wasUp.length}/${slTrades.length} (${pct}%) - avg peak: +${avgPeak.toFixed(1)}%, final: ${avgFinal.toFixed(1)}%`);
    } else {
      console.log(`  Reached ${thresh}%+ ROE: 0/${slTrades.length}`);
    }
  }

  // SIMULATION: What if we sold half at various thresholds?
  console.log('\n--- INSURANCE STRATEGY SIMULATION ---');
  console.log('Strategy: Sell 50% at X% ROE, move SL to breakeven for remainder\n');

  const marginPerTrade = 10; // Assume $10 margin

  for (const insuranceThresh of [2, 3, 5]) {
    let currentPnl = 0;
    let insurancePnl = 0;
    let tradesTriggered = 0;
    let savedFromFullLoss = 0;

    for (const t of withPeak) {
      const finalRoe = Number(t.realized_pnl_percent);
      const peakRoe = Number(t.highest_pnl_percent);

      // Current strategy: full ride
      currentPnl += (finalRoe / 100) * marginPerTrade;

      // Insurance strategy
      if (peakRoe >= insuranceThresh) {
        tradesTriggered++;
        // Half A: Locked at insurance threshold
        const halfA = (insuranceThresh / 100) * (marginPerTrade / 2);
        // Half B: BE if came back negative, else final ROE
        const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (marginPerTrade / 2);
        if (finalRoe < 0) savedFromFullLoss++;
        insurancePnl += halfA + halfB;
      } else {
        // Never hit threshold - same as current
        insurancePnl += (finalRoe / 100) * marginPerTrade;
      }
    }

    const improvement = insurancePnl - currentPnl;
    console.log(`  ${insuranceThresh}% threshold:`);
    console.log(`    Current PnL: $${currentPnl.toFixed(2)}`);
    console.log(`    Insurance PnL: $${insurancePnl.toFixed(2)}`);
    console.log(`    Improvement: $${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}`);
    console.log(`    Trades triggered: ${tradesTriggered}/${withPeak.length}`);
    console.log(`    Saved from full loss: ${savedFromFullLoss}`);
    console.log();
  }

  client.close();
}

checkScalingOpportunity().catch(console.error);
