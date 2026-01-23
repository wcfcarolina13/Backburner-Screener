/**
 * Turso Database Client for Backburner
 *
 * Stores trades, signals, and market data in Turso (SQLite edge database)
 * for persistent storage across Render deployments.
 */

import { createClient, Client } from '@libsql/client';

// Database client singleton
let db: Client | null = null;

// Check if Turso is configured
export function isTursoConfigured(): boolean {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

// Initialize database connection
export function initTurso(): Client | null {
  if (!isTursoConfigured()) {
    console.log('[TURSO] Not configured - using local file storage only');
    return null;
  }

  if (db) return db;

  try {
    db = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
    console.log('[TURSO] Connected to database');
    return db;
  } catch (error) {
    console.error('[TURSO] Failed to connect:', error);
    return null;
  }
}

// Get database client
export function getTurso(): Client | null {
  return db;
}

// Initialize database schema
export async function initSchema(): Promise<void> {
  const client = initTurso();
  if (!client) return;

  try {
    // Trade events table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS trade_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        event_type TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        position_id TEXT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        timeframe TEXT,
        market_type TEXT,
        entry_price REAL,
        exit_price REAL,
        margin_used REAL,
        notional_size REAL,
        leverage INTEGER,
        realized_pnl REAL,
        realized_pnl_percent REAL,
        exit_reason TEXT,
        signal_rsi REAL,
        signal_state TEXT,
        impulse_percent REAL,
        data_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns for regime analysis (will silently fail if already exist)
    const newColumns = [
      'entry_quadrant TEXT',
      'entry_quality TEXT',
      'entry_bias TEXT',
      'trail_activated INTEGER',
      'highest_pnl_percent REAL',
      'entry_time TEXT',
      'duration_ms INTEGER',
    ];
    for (const col of newColumns) {
      try {
        await client.execute(`ALTER TABLE trade_events ADD COLUMN ${col}`);
      } catch {
        // Column already exists, ignore
      }
    }

    // Signal events table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS signal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        event_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        market_type TEXT,
        state TEXT,
        rsi REAL,
        price REAL,
        entry_price REAL,
        impulse_percent REAL,
        data_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Market snapshots table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        btc_price REAL,
        btc_bias TEXT,
        btc_rsi_5m REAL,
        btc_rsi_15m REAL,
        btc_rsi_1h REAL,
        active_setups INTEGER,
        total_symbols INTEGER,
        data_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Daily summaries table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        total_signals INTEGER,
        total_trades INTEGER,
        total_pnl REAL,
        win_rate REAL,
        bot_stats_json TEXT,
        summary_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bot state table (for recovery)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS bot_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL UNIQUE,
        balance REAL,
        peak_balance REAL,
        open_positions_json TEXT,
        closed_positions_json TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for common queries
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_trade_events_date ON trade_events(date)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_trade_events_bot ON trade_events(bot_id, date)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_trade_events_symbol ON trade_events(symbol, date)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_signal_events_date ON signal_events(date)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_signal_events_symbol ON signal_events(symbol, date)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_market_snapshots_date ON market_snapshots(date)`);

    console.log('[TURSO] Schema initialized');
  } catch (error) {
    console.error('[TURSO] Failed to initialize schema:', error);
  }
}

// Insert trade event
export async function insertTradeEvent(event: {
  timestamp: string;
  eventType: string;
  botId: string;
  positionId?: string;
  symbol: string;
  direction: string;
  timeframe?: string;
  marketType?: string;
  entryPrice?: number;
  exitPrice?: number;
  marginUsed?: number;
  notionalSize?: number;
  leverage?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  signalRsi?: number;
  signalState?: string;
  impulsePercent?: number;
  // New regime analysis fields
  entryQuadrant?: string;
  entryQuality?: string;
  entryBias?: string;
  trailActivated?: boolean;
  highestPnlPercent?: number;
  entryTime?: string;
  durationMs?: number;
  [key: string]: unknown;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  const date = event.timestamp.split('T')[0];

  try {
    await client.execute({
      sql: `INSERT INTO trade_events (
        timestamp, date, event_type, bot_id, position_id, symbol, direction,
        timeframe, market_type, entry_price, exit_price, margin_used,
        notional_size, leverage, realized_pnl, realized_pnl_percent,
        exit_reason, signal_rsi, signal_state, impulse_percent,
        entry_quadrant, entry_quality, entry_bias, trail_activated,
        highest_pnl_percent, entry_time, duration_ms, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        event.timestamp,
        date,
        event.eventType,
        event.botId,
        event.positionId || null,
        event.symbol,
        event.direction,
        event.timeframe || null,
        event.marketType || null,
        event.entryPrice || null,
        event.exitPrice || null,
        event.marginUsed || null,
        event.notionalSize || null,
        event.leverage || null,
        event.realizedPnL || null,
        event.realizedPnLPercent || null,
        event.exitReason || null,
        event.signalRsi || null,
        event.signalState || null,
        event.impulsePercent || null,
        event.entryQuadrant || null,
        event.entryQuality || null,
        event.entryBias || null,
        event.trailActivated ? 1 : 0,
        event.highestPnlPercent || null,
        event.entryTime || null,
        event.durationMs || null,
        JSON.stringify(event),
      ],
    });
  } catch (error) {
    console.error('[TURSO] Failed to insert trade event:', error);
  }
}

// Insert signal event
export async function insertSignalEvent(event: {
  timestamp: string;
  eventType: string;
  symbol: string;
  direction: string;
  timeframe: string;
  marketType?: string;
  state?: string;
  rsi?: number;
  price?: number;
  entryPrice?: number;
  impulsePercent?: number;
  [key: string]: unknown;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  const date = event.timestamp.split('T')[0];

  try {
    await client.execute({
      sql: `INSERT INTO signal_events (
        timestamp, date, event_type, symbol, direction, timeframe,
        market_type, state, rsi, price, entry_price, impulse_percent, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        event.timestamp,
        date,
        event.eventType,
        event.symbol,
        event.direction,
        event.timeframe,
        event.marketType || null,
        event.state || null,
        event.rsi || null,
        event.price || null,
        event.entryPrice || null,
        event.impulsePercent || null,
        JSON.stringify(event),
      ],
    });
  } catch (error) {
    console.error('[TURSO] Failed to insert signal event:', error);
  }
}

// Insert market snapshot
export async function insertMarketSnapshot(snapshot: {
  timestamp: string;
  btcPrice?: number;
  btcBias?: string;
  btcRsi5m?: number;
  btcRsi15m?: number;
  btcRsi1h?: number;
  activeSetups?: number;
  totalSymbols?: number;
  [key: string]: unknown;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  const date = snapshot.timestamp.split('T')[0];

  try {
    await client.execute({
      sql: `INSERT INTO market_snapshots (
        timestamp, date, btc_price, btc_bias, btc_rsi_5m, btc_rsi_15m,
        btc_rsi_1h, active_setups, total_symbols, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        snapshot.timestamp,
        date,
        snapshot.btcPrice || null,
        snapshot.btcBias || null,
        snapshot.btcRsi5m || null,
        snapshot.btcRsi15m || null,
        snapshot.btcRsi1h || null,
        snapshot.activeSetups || null,
        snapshot.totalSymbols || null,
        JSON.stringify(snapshot),
      ],
    });
  } catch (error) {
    console.error('[TURSO] Failed to insert market snapshot:', error);
  }
}

// Upsert daily summary
export async function upsertDailySummary(summary: {
  date: string;
  totalSignals?: number;
  totalTrades?: number;
  totalPnL?: number;
  winRate?: number;
  botStats?: Record<string, unknown>;
  [key: string]: unknown;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  try {
    await client.execute({
      sql: `INSERT INTO daily_summaries (
        date, total_signals, total_trades, total_pnl, win_rate,
        bot_stats_json, summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_signals = excluded.total_signals,
        total_trades = excluded.total_trades,
        total_pnl = excluded.total_pnl,
        win_rate = excluded.win_rate,
        bot_stats_json = excluded.bot_stats_json,
        summary_json = excluded.summary_json`,
      args: [
        summary.date,
        summary.totalSignals || 0,
        summary.totalTrades || 0,
        summary.totalPnL || 0,
        summary.winRate || 0,
        summary.botStats ? JSON.stringify(summary.botStats) : null,
        JSON.stringify(summary),
      ],
    });
  } catch (error) {
    console.error('[TURSO] Failed to upsert daily summary:', error);
  }
}

// Save bot state for recovery
export async function saveBotState(
  botId: string,
  balance: number,
  peakBalance: number,
  openPositions: unknown[],
  closedPositions: unknown[]
): Promise<void> {
  const client = getTurso();
  if (!client) return;

  try {
    await client.execute({
      sql: `INSERT INTO bot_state (
        bot_id, balance, peak_balance, open_positions_json, closed_positions_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(bot_id) DO UPDATE SET
        balance = excluded.balance,
        peak_balance = excluded.peak_balance,
        open_positions_json = excluded.open_positions_json,
        closed_positions_json = excluded.closed_positions_json,
        updated_at = CURRENT_TIMESTAMP`,
      args: [
        botId,
        balance,
        peakBalance,
        JSON.stringify(openPositions),
        JSON.stringify(closedPositions.slice(-50)), // Keep last 50 closed positions
      ],
    });
  } catch (error) {
    console.error('[TURSO] Failed to save bot state:', error);
  }
}

// Load bot state for recovery
export async function loadBotState(botId: string): Promise<{
  balance: number;
  peakBalance: number;
  openPositions: unknown[];
  closedPositions: unknown[];
} | null> {
  const client = getTurso();
  if (!client) return null;

  try {
    const result = await client.execute({
      sql: `SELECT balance, peak_balance, open_positions_json, closed_positions_json
            FROM bot_state WHERE bot_id = ?`,
      args: [botId],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      balance: row.balance as number,
      peakBalance: row.peak_balance as number,
      openPositions: JSON.parse(row.open_positions_json as string || '[]'),
      closedPositions: JSON.parse(row.closed_positions_json as string || '[]'),
    };
  } catch (error) {
    console.error('[TURSO] Failed to load bot state:', error);
    return null;
  }
}

// Query helpers for backtesting/analysis
export async function getTradesByDate(date: string): Promise<unknown[]> {
  const client = getTurso();
  if (!client) return [];

  try {
    const result = await client.execute({
      sql: `SELECT * FROM trade_events WHERE date = ? ORDER BY timestamp`,
      args: [date],
    });
    return result.rows;
  } catch (error) {
    console.error('[TURSO] Failed to get trades:', error);
    return [];
  }
}

export async function getTradesByBot(botId: string, startDate?: string, endDate?: string): Promise<unknown[]> {
  const client = getTurso();
  if (!client) return [];

  try {
    let sql = `SELECT * FROM trade_events WHERE bot_id = ?`;
    const args: (string | number)[] = [botId];

    if (startDate) {
      sql += ` AND date >= ?`;
      args.push(startDate);
    }
    if (endDate) {
      sql += ` AND date <= ?`;
      args.push(endDate);
    }

    sql += ` ORDER BY timestamp`;

    const result = await client.execute({ sql, args });
    return result.rows;
  } catch (error) {
    console.error('[TURSO] Failed to get trades by bot:', error);
    return [];
  }
}

export async function getDailySummaries(startDate?: string, endDate?: string): Promise<unknown[]> {
  const client = getTurso();
  if (!client) return [];

  try {
    let sql = `SELECT * FROM daily_summaries WHERE 1=1`;
    const args: string[] = [];

    if (startDate) {
      sql += ` AND date >= ?`;
      args.push(startDate);
    }
    if (endDate) {
      sql += ` AND date <= ?`;
      args.push(endDate);
    }

    sql += ` ORDER BY date`;

    const result = await client.execute({ sql, args });
    return result.rows;
  } catch (error) {
    console.error('[TURSO] Failed to get daily summaries:', error);
    return [];
  }
}

/**
 * Execute a read-only SQL query (for API access)
 * Only allows SELECT statements for security
 */
export async function executeReadQuery(sql: string, args: (string | number)[] = []): Promise<{
  success: boolean;
  rows?: unknown[];
  columns?: string[];
  error?: string;
  rowCount?: number;
}> {
  const client = getTurso();
  if (!client) {
    return { success: false, error: 'Turso not configured' };
  }

  // Security: Only allow SELECT statements
  const trimmedSql = sql.trim().toUpperCase();
  if (!trimmedSql.startsWith('SELECT')) {
    return { success: false, error: 'Only SELECT queries are allowed' };
  }

  // Block dangerous keywords
  const dangerous = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', '--', ';'];
  for (const keyword of dangerous) {
    if (trimmedSql.includes(keyword) && keyword !== '--') {
      return { success: false, error: `Query contains disallowed keyword: ${keyword}` };
    }
  }

  try {
    const result = await client.execute({ sql, args });
    return {
      success: true,
      rows: result.rows as unknown[],
      columns: result.columns,
      rowCount: result.rows.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TURSO] Query failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Get database statistics (table names and row counts)
 */
export async function getDatabaseStats(): Promise<{
  success: boolean;
  tables?: Array<{ name: string; rowCount: number }>;
  error?: string;
}> {
  const client = getTurso();
  if (!client) {
    return { success: false, error: 'Turso not configured' };
  }

  try {
    // Get table names
    const tablesResult = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );

    const tables: Array<{ name: string; rowCount: number }> = [];

    for (const row of tablesResult.rows) {
      const tableName = row.name as string;
      const countResult = await client.execute(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      tables.push({
        name: tableName,
        rowCount: countResult.rows[0].cnt as number,
      });
    }

    return { success: true, tables };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TURSO] Stats query failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}
