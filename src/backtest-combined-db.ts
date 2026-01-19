#!/usr/bin/env node
/**
 * Combined Strategy Backtest using Turso Database
 *
 * Fetches actual signals from the production database to backtest
 * the combined 4H Normal + 5m Fade strategy.
 */

import { createClient } from '@libsql/client';
import { Timeframe, MarketType } from './types.js';
import { getCandlesFromEntry } from './candle-store.js';
import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();

// Database connection
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Njg0NTExMzAsImlkIjoiZTRhMmMyMGItZDVjZS00NDUyLWFhZGQtZjY0ZGJjNjUyMTFjIiwicmlkIjoiYzFlYzAyYjUtYmE3YS00MmE4LThlMjAtNmQ1NjQ2MzljOTcyIn0.xLheUanYaU7fck4flKcnMeOG-WjEoS2_y0PZHQryObSd1LX_31eswUlLwYstriyGqiXAh1PA4TeOk2o7b2yHCQ',
});

// ============= Types =============

interface DbSignal {
  id: number;
  timestamp: string;
  date: string;
  event_type: string;
  symbol: string;
  direction: string;
  timeframe: string;
  market_type: string;
  state: string;
  rsi: number;
  price: number;
  entry_price: number;
}

interface BacktestConfig {
  leverage: number;
  positionSizePercent: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  htfBiasValidityMs: number;
  initialBalance: number;
}

interface CombinedTrade {
  symbol: string;
  direction: 'long' | 'short';
  htfSignalTime: number;
  htfDirection: 'long' | 'short';
  ltfSignalTime: number;
  ltfDirection: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  realizedPnL: number;
  realizedPnLPercent: number;
}

const DEFAULT_CONFIG: BacktestConfig = {
  leverage: 10,
  positionSizePercent: 5,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  htfBiasValidityMs: 12 * 60 * 60 * 1000,  // 12 hours
  initialBalance: 2000,
};

// ============= Database Queries =============

async function getTriggeredSignals(startDate: string, endDate: string, timeframe: string): Promise<DbSignal[]> {
  const result = await db.execute({
    sql: `
      SELECT * FROM signal_events
      WHERE date >= ? AND date <= ?
      AND timeframe = ?
      AND (state = 'triggered' OR state = 'deep_extreme')
      AND market_type = 'futures'
      ORDER BY timestamp
    `,
    args: [startDate, endDate, timeframe],
  });

  return result.rows as unknown as DbSignal[];
}

async function exploreDatabase(): Promise<void> {
  console.log('\n📊 Exploring Turso Database...\n');

  const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  console.log('Tables found:');
  for (const row of tables.rows) {
    console.log(`  - ${row.name}`);
    try {
      const count = await db.execute(`SELECT COUNT(*) as cnt FROM "${row.name}"`);
      console.log(`    Rows: ${count.rows[0].cnt}`);
      const schema = await db.execute(`PRAGMA table_info("${row.name}")`);
      console.log(`    Columns: ${schema.rows.map(r => r.name).join(', ')}`);
      const sample = await db.execute(`SELECT * FROM "${row.name}" LIMIT 1`);
      if (sample.rows.length > 0) {
        console.log(`    Sample: ${JSON.stringify(sample.rows[0]).substring(0, 200)}...`);
      }
    } catch (e) {
      console.log(`    Error: ${e}`);
    }
    console.log('');
  }
}

// ============= Position Simulation =============

interface Position {
  direction: 'long' | 'short';
  entryPrice: number;
  effectiveEntryPrice: number;
  marginUsed: number;
  notionalSize: number;
  initialStopPrice: number;
  currentStopPrice: number;
  highWaterMark: number;
  trailLevel: number;
  entryCosts: number;
}

function simulateTradeWithCandles(
  entryPrice: number,
  direction: 'long' | 'short',
  rsi: number,
  candles: Array<{ high: number; low: number; close: number; timestamp: number }>,
  config: BacktestConfig
): { exitPrice: number; exitReason: string; realizedPnL: number; realizedPnLPercent: number } | null {
  if (candles.length < 2) return null;

  const margin = config.initialBalance * (config.positionSizePercent / 100);
  const notional = margin * config.leverage;

  const volatility = determineVolatility(rsi);
  const entryCosts = costsCalculator.calculateEntryCosts(entryPrice, notional, direction, volatility);
  const effectiveEntry = entryCosts.effectiveEntryPrice;

  const stopMultiplier = direction === 'long'
    ? (1 - config.initialStopLossPercent / 100)
    : (1 + config.initialStopLossPercent / 100);
  let currentStop = effectiveEntry * stopMultiplier;
  let highWaterMark = 0;
  let trailLevel = 0;

  // Simulate through candles
  for (const candle of candles.slice(1)) {
    // Calculate current ROI
    const bestPrice = direction === 'long' ? candle.high : candle.low;
    const priceChange = direction === 'long'
      ? (bestPrice - effectiveEntry) / effectiveEntry
      : (effectiveEntry - bestPrice) / effectiveEntry;
    const roi = priceChange * config.leverage * 100;

    if (roi > highWaterMark) highWaterMark = roi;

    // Check trailing stop activation
    if (trailLevel === 0 && roi >= config.trailTriggerPercent) {
      trailLevel = 1;
      const lockPrice = direction === 'long'
        ? effectiveEntry * (1 + config.level1LockPercent / 100)
        : effectiveEntry * (1 - config.level1LockPercent / 100);
      currentStop = lockPrice;
    } else if (trailLevel > 0) {
      const nextTrigger = config.trailTriggerPercent + (trailLevel * config.trailStepPercent);
      if (roi >= nextTrigger) {
        trailLevel++;
        const lockPercent = config.level1LockPercent + ((trailLevel - 1) * config.trailStepPercent);
        const lockPrice = direction === 'long'
          ? effectiveEntry * (1 + lockPercent / 100)
          : effectiveEntry * (1 - lockPercent / 100);
        currentStop = lockPrice;
      }
    }

    // Check stop hit
    const worstPrice = direction === 'long' ? candle.low : candle.high;
    const stopHit = direction === 'long'
      ? worstPrice <= currentStop
      : worstPrice >= currentStop;

    if (stopHit) {
      const exitCosts = costsCalculator.calculateExitCosts(currentStop, notional, direction, 'normal');
      const exitPriceChange = direction === 'long'
        ? (exitCosts.effectiveExitPrice - effectiveEntry) / effectiveEntry
        : (effectiveEntry - exitCosts.effectiveExitPrice) / effectiveEntry;
      const grossPnL = exitPriceChange * notional;
      const realizedPnL = grossPnL - entryCosts.entryCosts - exitCosts.exitCosts;

      return {
        exitPrice: currentStop,
        exitReason: trailLevel > 0 ? `trail_L${trailLevel}` : 'initial_stop',
        realizedPnL,
        realizedPnLPercent: (realizedPnL / margin) * 100,
      };
    }
  }

  // End of data - close at last candle
  const lastCandle = candles[candles.length - 1];
  const exitCosts = costsCalculator.calculateExitCosts(lastCandle.close, notional, direction, 'normal');
  const exitPriceChange = direction === 'long'
    ? (exitCosts.effectiveExitPrice - effectiveEntry) / effectiveEntry
    : (effectiveEntry - exitCosts.effectiveExitPrice) / effectiveEntry;
  const grossPnL = exitPriceChange * notional;
  const realizedPnL = grossPnL - entryCosts.entryCosts - exitCosts.exitCosts;

  return {
    exitPrice: lastCandle.close,
    exitReason: 'end_of_data',
    realizedPnL,
    realizedPnLPercent: (realizedPnL / margin) * 100,
  };
}

// ============= Main Backtest Logic =============

async function runCombinedBacktest(
  startDate: string,
  endDate: string,
  config: BacktestConfig
): Promise<{ trades: CombinedTrade[], summary: any }> {
  console.log(`\n📊 Combined Strategy Backtest (4H Normal + 5m Fade)\n`);
  console.log(`Date Range: ${startDate} to ${endDate}`);
  console.log(`Config: ${config.leverage}x leverage, ${config.initialStopLossPercent}% SL`);
  console.log(`HTF Bias Validity: ${config.htfBiasValidityMs / (60 * 60 * 1000)}h\n`);

  // Load signals from database
  console.log('Loading signals from database...');
  const htfSignals = await getTriggeredSignals(startDate, endDate, '4h');
  const ltfSignals = await getTriggeredSignals(startDate, endDate, '5m');

  console.log(`Loaded ${htfSignals.length} 4H triggered signals`);
  console.log(`Loaded ${ltfSignals.length} 5m triggered signals`);

  // Get unique symbols
  const htfSymbols = new Set(htfSignals.map(s => s.symbol));
  const ltfSymbols = new Set(ltfSignals.map(s => s.symbol));
  const commonSymbols = [...htfSymbols].filter(s => ltfSymbols.has(s));

  console.log(`\n4H symbols: ${htfSymbols.size} (${[...htfSymbols].slice(0, 5).join(', ')}...)`);
  console.log(`5m symbols: ${ltfSymbols.size} (${[...ltfSymbols].slice(0, 5).join(', ')}...)`);
  console.log(`Common symbols: ${commonSymbols.length}`);

  if (commonSymbols.length > 0) {
    console.log(`  ${commonSymbols.join(', ')}`);
  }

  // Direction breakdown
  const htfLongs = htfSignals.filter(s => s.direction === 'long').length;
  const htfShorts = htfSignals.filter(s => s.direction === 'short').length;
  const ltfLongs = ltfSignals.filter(s => s.direction === 'long').length;
  const ltfShorts = ltfSignals.filter(s => s.direction === 'short').length;

  console.log(`\n4H directions: ${htfLongs} LONG, ${htfShorts} SHORT`);
  console.log(`5m directions: ${ltfLongs} LONG, ${ltfShorts} SHORT`);

  // Find aligned signals
  const alignedPairs: Array<{ htf: DbSignal; ltf: DbSignal }> = [];

  for (const ltf of ltfSignals) {
    const ltfTime = new Date(ltf.timestamp).getTime();

    // Find most recent valid 4H signal for this symbol
    const validHtf = htfSignals
      .filter(h => {
        if (h.symbol !== ltf.symbol) return false;
        const htfTime = new Date(h.timestamp).getTime();
        // 5m must come after 4H
        if (ltfTime <= htfTime) return false;
        // 4H must still be valid
        if (ltfTime > htfTime + config.htfBiasValidityMs) return false;
        return true;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    if (!validHtf) continue;

    // Check alignment: 4H direction should match FADED 5m direction
    const fadedLtfDirection = ltf.direction === 'long' ? 'short' : 'long';
    if (validHtf.direction !== fadedLtfDirection) continue;

    alignedPairs.push({ htf: validHtf, ltf });
  }

  console.log(`\n✅ Found ${alignedPairs.length} aligned signal pairs`);

  if (alignedPairs.length === 0) {
    console.log('\nNo aligned signals found.');
    return { trades: [], summary: null };
  }

  // Show some examples
  console.log('\nSample aligned pairs:');
  for (const { htf, ltf } of alignedPairs.slice(0, 3)) {
    const fadedDir = ltf.direction === 'long' ? 'SHORT' : 'LONG';
    console.log(`  ${ltf.symbol}: 4H ${htf.direction.toUpperCase()} @ ${htf.timestamp}`);
    console.log(`           → 5m ${ltf.direction.toUpperCase()} (fade to ${fadedDir}) @ ${ltf.timestamp}`);
  }

  // Simulate trades
  console.log('\nSimulating trades...');
  const trades: CombinedTrade[] = [];
  let processed = 0;

  for (const { htf, ltf } of alignedPairs) {
    processed++;
    process.stdout.write(`\r[${processed}/${alignedPairs.length}] ${ltf.symbol}...        `);

    // Direction is the FADE of the 5m signal
    const direction = ltf.direction === 'long' ? 'short' : 'long';
    const entryTime = new Date(ltf.timestamp).getTime();
    const entryPrice = ltf.price || ltf.entry_price;

    if (!entryPrice) continue;

    // Get candles for simulation
    const candles = await getCandlesFromEntry(
      ltf.symbol,
      '5m' as Timeframe,
      ltf.market_type as MarketType,
      entryTime,
      7 * 24 * 60 * 60 * 1000
    );

    if (candles.length < 10) continue;

    const result = simulateTradeWithCandles(
      entryPrice,
      direction as 'long' | 'short',
      ltf.rsi || 50,
      candles,
      config
    );

    if (result) {
      trades.push({
        symbol: ltf.symbol,
        direction: direction as 'long' | 'short',
        htfSignalTime: new Date(htf.timestamp).getTime(),
        htfDirection: htf.direction as 'long' | 'short',
        ltfSignalTime: entryTime,
        ltfDirection: ltf.direction as 'long' | 'short',
        entryPrice,
        exitPrice: result.exitPrice,
        exitReason: result.exitReason,
        realizedPnL: result.realizedPnL,
        realizedPnLPercent: result.realizedPnLPercent,
      });
    }
  }

  console.log('\n');

  // Calculate summary
  const wins = trades.filter(t => t.realizedPnL > 0);
  const losses = trades.filter(t => t.realizedPnL <= 0);
  const totalPnL = trades.reduce((sum, t) => sum + t.realizedPnL, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnL, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnL, 0));

  const byExitReason: Record<string, { count: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { count: 0, pnl: 0 };
    byExitReason[t.exitReason].count++;
    byExitReason[t.exitReason].pnl += t.realizedPnL;
  }

  const summary = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnL,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    byExitReason,
  };

  return { trades, summary };
}

function printResults(trades: CombinedTrade[], summary: any): void {
  console.log('='.repeat(70));
  console.log('COMBINED STRATEGY RESULTS (4H Normal + 5m Fade)');
  console.log('='.repeat(70));

  console.log(`\nPerformance:`);
  console.log(`  Total Trades:    ${summary.totalTrades}`);
  console.log(`  Win Rate:        ${summary.winRate.toFixed(1)}% (${summary.wins}W / ${summary.losses}L)`);
  console.log(`  Total P&L:       $${summary.totalPnL.toFixed(2)}`);
  console.log(`  Profit Factor:   ${summary.profitFactor === Infinity ? '∞' : summary.profitFactor.toFixed(2)}`);

  console.log(`\nRisk:`);
  console.log(`  Avg Win:         $${summary.avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:        $${summary.avgLoss.toFixed(2)}`);

  console.log(`\nBy Exit Reason:`);
  for (const [reason, stats] of Object.entries(summary.byExitReason)) {
    const s = stats as { count: number; pnl: number };
    console.log(`  ${reason.padEnd(20)} | ${String(s.count).padStart(4)} trades | $${s.pnl.toFixed(2).padStart(10)}`);
  }

  if (trades.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('Sample Trades:');
    console.log('─'.repeat(70));

    for (const t of trades.slice(0, 5)) {
      const emoji = t.realizedPnL >= 0 ? '✅' : '❌';
      console.log(`${emoji} ${t.symbol} ${t.direction.toUpperCase()}`);
      console.log(`   4H ${t.htfDirection.toUpperCase()} → 5m ${t.ltfDirection.toUpperCase()} (faded) → ${t.direction.toUpperCase()}`);
      console.log(`   Entry: $${t.entryPrice.toFixed(4)} → Exit: $${t.exitPrice.toFixed(4)} | PnL: $${t.realizedPnL.toFixed(2)} (${t.exitReason})`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ============= CLI =============

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--explore')) {
    await exploreDatabase();
    return;
  }

  let startDate = '';
  let endDate = '';
  let htfValidityHours = 12;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--start' || arg === '-s') {
      startDate = next;
      i++;
    } else if (arg === '--end' || arg === '-e') {
      endDate = next;
      i++;
    } else if (arg === '--validity' || arg === '-v') {
      htfValidityHours = parseInt(next, 10);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Combined Strategy Backtest (Database)

Usage: npm run backtest-combined-db -- [options]

Options:
  --explore          Explore database structure
  --start, -s <date> Start date (YYYY-MM-DD)
  --end, -e <date>   End date (YYYY-MM-DD)
  --validity, -v <h> 4H bias validity in hours (default: 12)
  --help, -h         Show this help

Examples:
  npm run backtest-combined-db -- --explore
  npm run backtest-combined-db -- --start 2026-01-14 --end 2026-01-19
  npm run backtest-combined-db -- --validity 24
`);
      return;
    }
  }

  // Default dates
  if (!startDate || !endDate) {
    const now = new Date();
    endDate = now.toISOString().split('T')[0];
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  }

  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    htfBiasValidityMs: htfValidityHours * 60 * 60 * 1000,
  };

  const { trades, summary } = await runCombinedBacktest(startDate, endDate, config);

  if (summary) {
    printResults(trades, summary);
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
