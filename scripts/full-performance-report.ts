/**
 * Full Performance Report - Turso Database Analysis
 *
 * Run with: npx tsx scripts/full-performance-report.ts
 *
 * Requires TURSO_AUTH_TOKEN environment variable or will create one via CLI
 */

import { createClient } from '@libsql/client';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';

async function runReport() {
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    console.log('\nRun with: export TURSO_AUTH_TOKEN=$(turso db tokens create backburner) && npx tsx scripts/full-performance-report.ts');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('═'.repeat(60));
  console.log('  BACKBURNER PERFORMANCE REPORT');
  console.log('  Generated: ' + new Date().toISOString());
  console.log('═'.repeat(60));

  // ============================================
  // Section 1: Last 24h Bot Performance
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  LAST 24H BOT PERFORMANCE                               │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const last24h = await client.execute(`
    SELECT
      bot_id,
      SUM(CASE WHEN event_type = 'open' THEN 1 ELSE 0 END) as opens,
      SUM(CASE WHEN event_type = 'close' THEN 1 ELSE 0 END) as closes,
      SUM(CASE WHEN event_type = 'close' AND realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN event_type = 'close' THEN realized_pnl ELSE 0 END), 2) as total_pnl,
      ROUND(AVG(CASE WHEN event_type = 'close' THEN realized_pnl END), 2) as avg_pnl
    FROM trade_events
    WHERE date >= date('now', '-1 day')
    GROUP BY bot_id
    ORDER BY total_pnl DESC
  `);

  console.log('Bot'.padEnd(28) + 'Opens'.padStart(6) + 'Closes'.padStart(8) + 'Wins'.padStart(6) + 'WR%'.padStart(7) + 'Total PnL'.padStart(12) + 'Avg'.padStart(10));
  console.log('─'.repeat(77));

  for (const row of last24h.rows) {
    const closes = Number(row.closes) || 0;
    const wins = Number(row.wins) || 0;
    const winRate = closes > 0 ? ((wins / closes) * 100).toFixed(0) + '%' : 'N/A';
    const pnlColor = Number(row.total_pnl) >= 0 ? '' : '';

    console.log(
      String(row.bot_id).padEnd(28) +
      String(row.opens).padStart(6) +
      String(row.closes).padStart(8) +
      String(row.wins).padStart(6) +
      winRate.padStart(7) +
      ('$' + row.total_pnl).padStart(12) +
      ('$' + (row.avg_pnl || 0)).padStart(10)
    );
  }

  // ============================================
  // Section 2: Focus Mode Shadow Bots
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  FOCUS MODE SHADOW BOTS (Regime Quadrant Testing)       │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const focusBots = await client.execute(`
    SELECT
      bot_id,
      COUNT(*) as trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(realized_pnl), 2) as total_pnl,
      ROUND(AVG(realized_pnl), 2) as avg_pnl,
      MIN(date) as first_trade,
      MAX(date) as last_trade
    FROM trade_events
    WHERE bot_id LIKE 'focus-%' AND event_type = 'close'
    GROUP BY bot_id
    ORDER BY total_pnl DESC
  `);

  console.log('Bot'.padEnd(30) + 'Trades'.padStart(8) + 'WR%'.padStart(8) + 'Total PnL'.padStart(12) + 'First'.padStart(13) + 'Last'.padStart(13));
  console.log('─'.repeat(84));

  for (const row of focusBots.rows) {
    const trades = Number(row.trades) || 0;
    const wins = Number(row.wins) || 0;
    const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : 'N/A';

    console.log(
      String(row.bot_id).padEnd(30) +
      String(row.trades).padStart(8) +
      winRate.padStart(8) +
      ('$' + row.total_pnl).padStart(12) +
      String(row.first_trade).padStart(13) +
      String(row.last_trade).padStart(13)
    );
  }

  // ============================================
  // Section 3: Quadrant Performance Analysis
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  QUADRANT PERFORMANCE ANALYSIS                          │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const quadrantData = await client.execute(`
    SELECT
      entry_quadrant,
      COUNT(*) as trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(realized_pnl), 2) as total_pnl,
      ROUND(AVG(realized_pnl), 2) as avg_pnl
    FROM trade_events
    WHERE event_type = 'close' AND entry_quadrant IS NOT NULL
    GROUP BY entry_quadrant
    ORDER BY total_pnl DESC
  `);

  if (quadrantData.rows.length === 0) {
    console.log('⚠️  NO QUADRANT DATA - entry_quadrant column is empty!');
    console.log('   Regime data is NOT being logged to Turso.');
  } else {
    console.log('Quadrant'.padEnd(15) + 'Trades'.padStart(8) + 'Wins'.padStart(6) + 'WR%'.padStart(8) + 'Total PnL'.padStart(12) + 'Avg PnL'.padStart(10));
    console.log('─'.repeat(59));

    for (const row of quadrantData.rows) {
      const trades = Number(row.trades) || 0;
      const wins = Number(row.wins) || 0;
      const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : 'N/A';

      console.log(
        String(row.entry_quadrant || 'NULL').padEnd(15) +
        String(row.trades).padStart(8) +
        String(row.wins).padStart(6) +
        winRate.padStart(8) +
        ('$' + row.total_pnl).padStart(12) +
        ('$' + (row.avg_pnl || 0)).padStart(10)
      );
    }
  }

  // ============================================
  // Section 4: Top Performer Deep Dive
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  TOP PERFORMER: exp-bb-sysB (System B Bias Filter)      │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const sysBDaily = await client.execute(`
    SELECT
      date,
      COUNT(*) as trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(realized_pnl), 2) as pnl,
      ROUND(AVG(realized_pnl), 2) as avg_pnl
    FROM trade_events
    WHERE bot_id = 'exp-bb-sysB' AND event_type = 'close'
    GROUP BY date
    ORDER BY date DESC
    LIMIT 7
  `);

  console.log('Date'.padEnd(15) + 'Trades'.padStart(8) + 'Wins'.padStart(6) + 'WR%'.padStart(8) + 'Day PnL'.padStart(12) + 'Avg'.padStart(10));
  console.log('─'.repeat(59));

  for (const row of sysBDaily.rows) {
    const trades = Number(row.trades) || 0;
    const wins = Number(row.wins) || 0;
    const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(0) + '%' : 'N/A';

    console.log(
      String(row.date).padEnd(15) +
      String(row.trades).padStart(8) +
      String(row.wins).padStart(6) +
      winRate.padStart(8) +
      ('$' + row.pnl).padStart(12) +
      ('$' + (row.avg_pnl || 0)).padStart(10)
    );
  }

  // ============================================
  // Section 5: Data Collection Health
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  DATA COLLECTION HEALTH CHECK                           │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const marketCount = await client.execute(`
    SELECT
      date,
      COUNT(*) as snapshots,
      MIN(timestamp) as first_snapshot,
      MAX(timestamp) as last_snapshot,
      ROUND(AVG(btc_price), 2) as avg_btc
    FROM market_snapshots
    WHERE date >= date('now', '-3 days')
    GROUP BY date
    ORDER BY date DESC
  `);

  console.log('Date'.padEnd(15) + 'Snapshots'.padStart(10) + 'First'.padStart(12) + 'Last'.padStart(12) + 'Avg BTC'.padStart(12));
  console.log('─'.repeat(61));

  for (const row of marketCount.rows) {
    const first = String(row.first_snapshot).split('T')[1]?.substring(0, 8) || 'N/A';
    const last = String(row.last_snapshot).split('T')[1]?.substring(0, 8) || 'N/A';

    console.log(
      String(row.date).padEnd(15) +
      String(row.snapshots).padStart(10) +
      first.padStart(12) +
      last.padStart(12) +
      ('$' + row.avg_btc).padStart(12)
    );
  }

  const signalCount = await client.execute(`
    SELECT
      date,
      COUNT(*) as total,
      SUM(CASE WHEN state = 'triggered' THEN 1 ELSE 0 END) as triggered
    FROM signal_events
    WHERE date >= date('now', '-3 days')
    GROUP BY date
    ORDER BY date DESC
  `);

  console.log('\nSignal Events:');
  console.log('Date'.padEnd(15) + 'Total'.padStart(10) + 'Triggered'.padStart(12));
  console.log('─'.repeat(37));

  for (const row of signalCount.rows) {
    console.log(
      String(row.date).padEnd(15) +
      String(row.total).padStart(10) +
      String(row.triggered).padStart(12)
    );
  }

  // ============================================
  // Section 6: Recent Trades
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  MOST RECENT TRADES                                     │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const recentTrades = await client.execute(`
    SELECT timestamp, bot_id, symbol, direction, realized_pnl, exit_reason
    FROM trade_events
    WHERE event_type = 'close'
    ORDER BY timestamp DESC
    LIMIT 15
  `);

  console.log('Time'.padEnd(20) + 'Bot'.padEnd(22) + 'Symbol'.padEnd(14) + 'Dir'.padEnd(6) + 'PnL'.padStart(10) + 'Reason'.padStart(16));
  console.log('─'.repeat(88));

  for (const row of recentTrades.rows) {
    const time = String(row.timestamp).replace('T', ' ').substring(0, 19);
    const pnl = Number(row.realized_pnl).toFixed(2);

    console.log(
      time.padEnd(20) +
      String(row.bot_id).substring(0, 21).padEnd(22) +
      String(row.symbol).padEnd(14) +
      String(row.direction).padEnd(6) +
      ('$' + pnl).padStart(10) +
      String(row.exit_reason || '').padStart(16)
    );
  }

  // ============================================
  // Section 7: Summary
  // ============================================
  console.log('\n\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  SUMMARY                                                │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const summary = await client.execute(`
    SELECT
      COUNT(DISTINCT bot_id) as active_bots,
      COUNT(*) as total_trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(realized_pnl), 2) as total_pnl
    FROM trade_events
    WHERE event_type = 'close' AND date >= date('now', '-1 day')
  `);

  const s = summary.rows[0];
  const totalTrades = Number(s.total_trades) || 0;
  const wins = Number(s.wins) || 0;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 'N/A';

  console.log('Last 24 Hours:');
  console.log('  Active Bots:     ' + s.active_bots);
  console.log('  Total Trades:    ' + s.total_trades);
  console.log('  Win Rate:        ' + winRate + '%');
  console.log('  Total PnL:       $' + s.total_pnl);

  // Highlights
  const topBot = last24h.rows[0];
  const bottomBot = last24h.rows[last24h.rows.length - 1];

  console.log('\n🏆 Top Performer:    ' + topBot?.bot_id + ' ($' + topBot?.total_pnl + ')');
  console.log('⚠️  Worst Performer:  ' + bottomBot?.bot_id + ' ($' + bottomBot?.total_pnl + ')');

  console.log('\n' + '═'.repeat(60));
  console.log('  Report Complete');
  console.log('═'.repeat(60));

  client.close();
}

runReport().catch(console.error);
