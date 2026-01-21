/**
 * Query Turso database for bot performance
 */

import { initTurso, isTursoConfigured } from './turso-db.js';

async function main() {
  if (!isTursoConfigured()) {
    console.error('Turso not configured - set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  const db = initTurso();
  if (!db) {
    console.error('Failed to connect to Turso');
    process.exit(1);
  }

  // Today's trades by bot
  console.log('\n=== TODAY\'S BOT PERFORMANCE ===\n');
  const todayTrades = await db.execute(`
    SELECT
      bot_id,
      COUNT(*) as trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(realized_pnl), 2) as total_pnl,
      ROUND(AVG(realized_pnl), 2) as avg_pnl
    FROM trade_events
    WHERE event_type = 'close'
      AND DATE(timestamp) = DATE('now')
    GROUP BY bot_id
    ORDER BY total_pnl DESC
  `);

  if (todayTrades.rows.length === 0) {
    console.log('No closed trades today yet.\n');
  } else {
    console.log('Bot ID                  | Trades | Wins | Total PnL | Avg PnL');
    console.log('------------------------|--------|------|-----------|--------');
    for (const row of todayTrades.rows) {
      const botId = String(row.bot_id).padEnd(23);
      const trades = String(row.trades).padStart(6);
      const wins = String(row.wins).padStart(4);
      const totalPnl = String(row.total_pnl).padStart(9);
      const avgPnl = String(row.avg_pnl).padStart(7);
      console.log(`${botId} | ${trades} | ${wins} | ${totalPnl} | ${avgPnl}`);
    }
  }

  // Open positions
  console.log('\n=== OPEN POSITIONS (from trade_events) ===\n');
  const openTrades = await db.execute(`
    SELECT bot_id, COUNT(*) as count
    FROM trade_events
    WHERE event_type = 'open'
      AND position_id NOT IN (
        SELECT position_id FROM trade_events WHERE event_type = 'close'
      )
    GROUP BY bot_id
    ORDER BY count DESC
  `);

  if (openTrades.rows.length === 0) {
    console.log('No open positions tracked.\n');
  } else {
    for (const row of openTrades.rows) {
      console.log(`${row.bot_id}: ${row.count} open`);
    }
  }

  // Recent trade activity
  console.log('\n=== LAST 10 TRADE CLOSES ===\n');
  const recentTrades = await db.execute(`
    SELECT
      timestamp,
      bot_id,
      symbol,
      direction,
      ROUND(realized_pnl, 2) as pnl,
      exit_reason
    FROM trade_events
    WHERE event_type = 'close'
    ORDER BY timestamp DESC
    LIMIT 10
  `);

  for (const row of recentTrades.rows) {
    const ts = String(row.timestamp).substring(11, 19);
    const pnl = Number(row.pnl) >= 0 ? `+$${row.pnl}` : `-$${Math.abs(Number(row.pnl))}`;
    console.log(`${ts} | ${row.bot_id} | ${row.symbol} ${row.direction} | ${pnl} | ${row.exit_reason}`);
  }

  // Check for shadow bots specifically
  console.log('\n=== SHADOW BOT ACTIVITY (last 24h) ===\n');
  const shadowBots = await db.execute(`
    SELECT
      bot_id,
      COUNT(*) as events,
      MIN(timestamp) as first_event,
      MAX(timestamp) as last_event
    FROM trade_events
    WHERE (bot_id LIKE '%shadow%' OR bot_id LIKE '%focus%')
      AND timestamp > datetime('now', '-24 hours')
    GROUP BY bot_id
    ORDER BY last_event DESC
  `);

  if (shadowBots.rows.length === 0) {
    console.log('No shadow bot activity in last 24h.\n');
  } else {
    for (const row of shadowBots.rows) {
      console.log(`${row.bot_id}: ${row.events} events (${row.first_event} - ${row.last_event})`);
    }
  }
}

main().catch(console.error);
