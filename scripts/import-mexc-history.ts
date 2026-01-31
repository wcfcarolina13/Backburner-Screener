/**
 * Import MEXC position history to Turso
 *
 * Usage: npx ts-node scripts/import-mexc-history.ts [hours]
 *
 * Fetches position history from the live server and imports to Turso.
 */

import { createClient } from '@libsql/client';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const BACKBURNER_URL = process.env.BACKBURNER_URL || 'https://backburner.onrender.com';

async function main() {
  if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables');
    process.exit(1);
  }

  const db = createClient({
    url: TURSO_DATABASE_URL,
    authToken: TURSO_AUTH_TOKEN,
  });

  const hoursBack = parseInt(process.argv[2]) || 48;
  const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);

  console.log(`Importing MEXC trades from last ${hoursBack} hours...`);
  console.log(`Cutoff time: ${new Date(cutoffTime).toISOString()}`);

  // Fetch position history from live server
  const response = await fetch(`${BACKBURNER_URL}/api/mexc/position-history`);
  const data = await response.json();

  if (!data.positionHistory?.data) {
    console.error('Failed to fetch position history:', data);
    process.exit(1);
  }

  const positions = data.positionHistory.data;
  console.log(`Fetched ${positions.length} positions`);

  // Get existing position IDs to avoid duplicates
  const existingResult = await db.execute(
    `SELECT position_id FROM trade_events WHERE bot_id = 'mexc-live' AND position_id IS NOT NULL`
  );
  const existingIds = new Set<string>();
  for (const row of existingResult.rows) {
    existingIds.add(String(row.position_id));
  }
  console.log(`Found ${existingIds.size} existing mexc-live trades`);

  let imported = 0;
  let skipped = 0;
  let tooOld = 0;

  for (const pos of positions) {
    const positionId = String(pos.positionId);

    // Skip if older than cutoff
    if (pos.updateTime < cutoffTime) {
      tooOld++;
      continue;
    }

    // Skip if already exists
    if (existingIds.has(positionId)) {
      skipped++;
      continue;
    }

    const direction = pos.positionType === 1 ? 'long' : 'short';
    const entryPrice = pos.openAvgPrice;
    const exitPrice = pos.closeAvgPrice;
    const leverage = pos.leverage || 10;
    const roePct = (pos.profitRatio || 0) * 100;
    const marginUsed = Math.abs(pos.realised) / (Math.abs(roePct / 100)) || 5;
    const durationMs = pos.updateTime - pos.createTime;
    const symbol = pos.symbol.replace('_USDT', 'USDT');

    const timestamp = new Date(pos.updateTime).toISOString();
    const date = timestamp.split('T')[0];

    const dataJson = JSON.stringify({
      timestamp,
      eventType: 'close',
      botId: 'mexc-live',
      positionId,
      symbol,
      direction,
      entryPrice,
      exitPrice,
      marginUsed,
      notionalSize: marginUsed * leverage,
      leverage,
      realizedPnL: pos.realised,
      realizedPnLPercent: roePct,
      exitReason: 'historical',
      executionMode: 'mexc-live',
    });

    try {
      await db.execute({
        sql: `INSERT INTO trade_events (
          timestamp, date, event_type, bot_id, position_id, symbol, direction,
          timeframe, market_type, entry_price, exit_price, margin_used,
          notional_size, leverage, realized_pnl, realized_pnl_percent,
          exit_reason, duration_ms, execution_mode, data_json
        ) VALUES (?, ?, 'close', 'mexc-live', ?, ?, ?, '5m', 'futures', ?, ?, ?, ?, ?, ?, ?, 'historical', ?, 'mexc-live', ?)`,
        args: [
          timestamp,
          date,
          positionId,
          symbol,
          direction,
          entryPrice,
          exitPrice,
          marginUsed,
          marginUsed * leverage,
          leverage,
          pos.realised,
          roePct,
          durationMs,
          dataJson,
        ],
      });
      imported++;
      console.log(`✓ Imported ${symbol} ${direction} PnL=$${pos.realised.toFixed(4)}`);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        skipped++;
      } else {
        console.error(`✗ Error importing ${symbol}:`, err.message);
      }
    }
  }

  console.log(`\nImport complete:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  console.log(`  Too old: ${tooOld}`);

  // Verify totals
  const countResult = await db.execute(
    `SELECT COUNT(*) as count FROM trade_events WHERE bot_id = 'mexc-live'`
  );
  console.log(`  Total mexc-live trades in Turso: ${countResult.rows[0].count}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
