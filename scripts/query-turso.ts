/**
 * Query Turso database to see what data we have
 */

import { createClient } from '@libsql/client';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';

async function queryTurso() {
  // Check for auth token
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN environment variable not set');
    console.log('\nTo query the database, set the auth token:');
    console.log('  export TURSO_AUTH_TOKEN="your-token-here"');
    process.exit(1);
  }

  const client = createClient({
    url: TURSO_URL,
    authToken,
  });

  console.log('========================================');
  console.log('TURSO DATABASE ANALYSIS');
  console.log('========================================\n');

  try {
    // Check tables
    const tables = await client.execute(`
      SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    `);
    console.log('TABLES:');
    tables.rows.forEach(row => console.log(`  - ${row.name}`));

    // Count trade events
    const tradeCount = await client.execute(`SELECT COUNT(*) as cnt FROM trade_events`);
    console.log(`\nTRADE EVENTS: ${tradeCount.rows[0].cnt}`);

    // Get date range for trades
    const tradeDates = await client.execute(`
      SELECT MIN(date) as min_date, MAX(date) as max_date FROM trade_events
    `);
    if (tradeDates.rows[0].min_date) {
      console.log(`  Date range: ${tradeDates.rows[0].min_date} to ${tradeDates.rows[0].max_date}`);
    }

    // Trades by bot
    const tradesByBot = await client.execute(`
      SELECT bot_id, COUNT(*) as cnt,
             SUM(CASE WHEN event_type = 'close' THEN realized_pnl ELSE 0 END) as total_pnl
      FROM trade_events
      GROUP BY bot_id
      ORDER BY cnt DESC
      LIMIT 10
    `);
    console.log('\nTrades by bot (top 10):');
    tradesByBot.rows.forEach(row => {
      const pnl = row.total_pnl ? `$${Number(row.total_pnl).toFixed(2)}` : 'N/A';
      console.log(`  ${row.bot_id}: ${row.cnt} events, PnL: ${pnl}`);
    });

    // Count signal events
    const signalCount = await client.execute(`SELECT COUNT(*) as cnt FROM signal_events`);
    console.log(`\nSIGNAL EVENTS: ${signalCount.rows[0].cnt}`);

    // Signals by state
    const signalsByState = await client.execute(`
      SELECT state, COUNT(*) as cnt FROM signal_events GROUP BY state ORDER BY cnt DESC
    `);
    console.log('Signals by state:');
    signalsByState.rows.forEach(row => {
      console.log(`  ${row.state || 'null'}: ${row.cnt}`);
    });

    // Recent triggered signals
    const recentTriggered = await client.execute(`
      SELECT symbol, direction, timeframe, price, rsi, timestamp
      FROM signal_events
      WHERE state = 'triggered'
      ORDER BY timestamp DESC
      LIMIT 10
    `);
    console.log('\nRecent triggered signals:');
    recentTriggered.rows.forEach(row => {
      console.log(`  ${row.timestamp}: ${row.symbol} ${row.direction} ${row.timeframe} @ ${row.price} (RSI: ${Number(row.rsi).toFixed(1)})`);
    });

    // Bot state
    const botState = await client.execute(`SELECT bot_id, balance, peak_balance, updated_at FROM bot_state`);
    console.log('\nBOT STATE:');
    botState.rows.forEach(row => {
      console.log(`  ${row.bot_id}: $${Number(row.balance).toFixed(2)} (peak: $${Number(row.peak_balance).toFixed(2)}) - ${row.updated_at}`);
    });

    // Daily summaries
    const summaries = await client.execute(`
      SELECT date, total_signals, total_trades, total_pnl, win_rate
      FROM daily_summaries
      ORDER BY date DESC
      LIMIT 7
    `);
    console.log('\nDAILY SUMMARIES (last 7 days):');
    summaries.rows.forEach(row => {
      const pnl = row.total_pnl ? `$${Number(row.total_pnl).toFixed(2)}` : 'N/A';
      const wr = row.win_rate ? `${Number(row.win_rate).toFixed(1)}%` : 'N/A';
      console.log(`  ${row.date}: ${row.total_trades} trades, PnL: ${pnl}, WR: ${wr}`);
    });

  } catch (error) {
    console.error('Error querying database:', error);
  }

  client.close();
}

queryTurso();
