#!/usr/bin/env npx ts-node
/**
 * Import MEXC Position History to Turso
 * =====================================
 *
 * This script fetches closed MEXC positions from the live Backburner server
 * and imports them to Turso database for historical analysis.
 *
 * USAGE:
 *   # Using the server endpoint (recommended - handles pagination internally):
 *   curl -X POST "https://backburner.onrender.com/api/mexc/import-history?hours=48"
 *
 *   # Or run locally with Turso credentials:
 *   TURSO_DATABASE_URL=libsql://xxx TURSO_AUTH_TOKEN=xxx npx ts-node scripts/import-mexc-history.ts [hours] [pages]
 *
 * ARGUMENTS:
 *   hours  - How many hours back to import (default: 48)
 *   pages  - Maximum pages to fetch, 100 trades per page (default: 10)
 *
 * ENVIRONMENT VARIABLES:
 *   TURSO_DATABASE_URL  - Turso database URL (required)
 *   TURSO_AUTH_TOKEN    - Turso auth token (required)
 *   BACKBURNER_URL      - Server URL (default: https://backburner.onrender.com)
 *
 * DEDUPLICATION:
 *   - Uses MEXC's positionId to avoid duplicate inserts
 *   - Queries existing position_id values before inserting
 *   - Safe to run multiple times
 *
 * OUTPUT:
 *   - Logs each imported trade with symbol, direction, PnL
 *   - Summary: imported, skipped (duplicates), too old, total in Turso
 *
 * SEE ALSO:
 *   - POST /api/mexc/import-history - Server endpoint for bulk import
 *   - GET /api/mexc/position-history?page=N&limit=100 - Raw position data
 */

import { createClient } from '@libsql/client';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const BACKBURNER_URL = process.env.BACKBURNER_URL || 'https://backburner.onrender.com';

interface MexcPosition {
  positionId: number;
  symbol: string;
  positionType: number; // 1 = long, 2 = short
  openAvgPrice: number;
  closeAvgPrice: number;
  realised: number;
  profitRatio: number;
  leverage: number;
  createTime: number;
  updateTime: number;
}

async function fetchPositionPage(page: number, limit: number): Promise<MexcPosition[]> {
  const url = `${BACKBURNER_URL}/api/mexc/position-history?page=${page}&limit=${limit}`;
  console.log(`Fetching page ${page}...`);

  const response = await fetch(url);
  const data = await response.json();

  if (!data.positionHistory?.data) {
    console.warn(`Page ${page}: No data returned`);
    return [];
  }

  return data.positionHistory.data;
}

async function main() {
  // Check environment
  if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    console.error(`
ERROR: Missing Turso credentials

Set these environment variables:
  TURSO_DATABASE_URL=libsql://your-database.turso.io
  TURSO_AUTH_TOKEN=your-auth-token

Or use the server endpoint instead:
  curl -X POST "${BACKBURNER_URL}/api/mexc/import-history?hours=48"
`);
    process.exit(1);
  }

  // Parse arguments
  const hoursBack = parseInt(process.argv[2]) || 48;
  const maxPages = parseInt(process.argv[3]) || 10;
  const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
  const pageSize = 100;

  console.log(`
=== MEXC History Import ===
Hours back: ${hoursBack}
Max pages: ${maxPages} (${maxPages * pageSize} trades max)
Cutoff: ${new Date(cutoffTime).toISOString()}
Server: ${BACKBURNER_URL}
`);

  // Connect to Turso
  const db = createClient({
    url: TURSO_DATABASE_URL,
    authToken: TURSO_AUTH_TOKEN,
  });

  // Get existing position IDs to avoid duplicates
  console.log('Checking existing trades in Turso...');
  const existingResult = await db.execute(
    `SELECT position_id FROM trade_events WHERE bot_id = 'mexc-live' AND position_id IS NOT NULL`
  );
  const existingIds = new Set<string>();
  for (const row of existingResult.rows) {
    existingIds.add(String(row.position_id));
  }
  console.log(`Found ${existingIds.size} existing mexc-live trades\n`);

  // Fetch all pages
  let allPositions: MexcPosition[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const positions = await fetchPositionPage(page, pageSize);

    if (positions.length === 0) {
      console.log(`Page ${page}: Empty - stopping pagination`);
      break;
    }

    // Check if oldest position is before cutoff
    const oldestInPage = positions[positions.length - 1];
    if (oldestInPage && oldestInPage.updateTime < cutoffTime) {
      // Filter this page and stop
      const recentPositions = positions.filter(p => p.updateTime >= cutoffTime);
      allPositions = allPositions.concat(recentPositions);
      console.log(`Page ${page}: ${positions.length} trades, ${recentPositions.length} within cutoff - stopping`);
      break;
    }

    allPositions = allPositions.concat(positions);
    console.log(`Page ${page}: ${positions.length} trades fetched`);

    if (positions.length < pageSize) {
      console.log(`Page ${page}: Partial page - stopping pagination`);
      break;
    }

    // Rate limit between pages
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nTotal fetched: ${allPositions.length} positions\n`);

  // Import to Turso
  let imported = 0;
  let skipped = 0;
  let tooOld = 0;
  let errors = 0;

  for (const pos of allPositions) {
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
      existingIds.add(positionId); // Track to avoid duplicates in same batch
      console.log(`✓ ${symbol} ${direction.padEnd(5)} PnL=$${pos.realised >= 0 ? '+' : ''}${pos.realised.toFixed(4)}`);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        skipped++;
      } else {
        console.error(`✗ Error importing ${symbol}:`, err.message);
        errors++;
      }
    }
  }

  // Summary
  console.log(`
=== Import Complete ===
  Imported:    ${imported}
  Skipped:     ${skipped} (already in Turso)
  Too old:     ${tooOld} (before cutoff)
  Errors:      ${errors}
`);

  // Verify totals
  const countResult = await db.execute(
    `SELECT COUNT(*) as count FROM trade_events WHERE bot_id = 'mexc-live'`
  );
  console.log(`Total mexc-live trades in Turso: ${countResult.rows[0].count}`);

  // Show PnL summary
  const pnlResult = await db.execute(
    `SELECT SUM(realized_pnl) as total_pnl FROM trade_events WHERE bot_id = 'mexc-live'`
  );
  const totalPnl = pnlResult.rows[0].total_pnl as number || 0;
  console.log(`Total mexc-live PnL: $${totalPnl.toFixed(2)}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
