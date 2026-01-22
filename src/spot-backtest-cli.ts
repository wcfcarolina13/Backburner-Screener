#!/usr/bin/env node
/**
 * SPOT BACKTEST CLI - Test Focus Mode signals for spot-only trading
 *
 * A simple CLI tool to backtest spot trading strategies without code changes.
 * Pulls historical trades from Turso and simulates spot execution.
 *
 * Usage:
 *   npm run spot-backtest -- --help
 *   npm run spot-backtest -- --days 7 --balance 2000 --position-pct 25
 *   npm run spot-backtest -- --compare
 *
 * This removes bias by:
 * 1. Using actual historical data (no cherry-picking)
 * 2. Applying realistic fees and slippage
 * 3. Running multiple configurations for comparison
 * 4. Generating objective reports
 */

import { executeReadQuery, isTursoConfigured, initTurso } from './turso-db.js';

// ============= Types =============

interface SpotBacktestConfig {
  initialBalance: number;
  positionSizePercent: number;
  maxConcurrentPositions: number;
  daysBack: number;
  makerFeePercent: number;
  takerFeePercent: number;
  slippagePercent: number;
  minQualityScore: number;
  botFilter: string;  // e.g., 'focus-aggressive', 'focus-%', etc.
}

interface HistoricalTrade {
  id: string;
  botId: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPercent: number;
  leverage: number;
  exitReason: string;
  quadrant?: string;
  qualityScore?: number;
}

interface SpotTrade {
  original: HistoricalTrade;
  positionSize: number;
  entryPriceWithSlippage: number;
  exitPriceWithSlippage: number;
  spotPnlPercent: number;
  spotPnlDollars: number;
  fees: number;
  netPnl: number;
  balanceAfter: number;
}

interface SpotBacktestResult {
  config: SpotBacktestConfig;
  dateRange: { start: string; end: string };
  signalsLoaded: number;
  signalsFiltered: number;
  tradesExecuted: number;

  startBalance: number;
  endBalance: number;
  totalPnl: number;
  totalReturnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;

  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  totalFees: number;

  byQuadrant: Record<string, { count: number; pnl: number; winRate: number }>;
  bySymbol: Record<string, { count: number; pnl: number }>;
  dailyReturns: { date: string; pnl: number; trades: number }[];

  trades: SpotTrade[];
}

// ============= Data Loading =============

async function loadTradesFromTurso(config: SpotBacktestConfig): Promise<HistoricalTrade[]> {
  if (!isTursoConfigured()) {
    throw new Error('Turso not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN environment variables.');
  }

  // Calculate cutoff date as ISO string (timestamp column is TEXT)
  const cutoffDate = new Date(Date.now() - (config.daysBack * 24 * 60 * 60 * 1000)).toISOString();

  const query = `
    SELECT
      id, bot_id, symbol, direction,
      entry_price, exit_price, timestamp,
      realized_pnl_percent, leverage, exit_reason, data_json
    FROM trade_events
    WHERE event_type = 'close'
      AND timestamp > ?
      AND bot_id LIKE ?
      AND direction = 'long'
    ORDER BY timestamp ASC
  `;

  const result = await executeReadQuery(query, [cutoffDate, config.botFilter]);

  if (!result.success) {
    console.error('Query failed:', result.error);
    return [];
  }

  if (!result.rows) return [];

  return result.rows.map((row: any) => {
    let quadrant: string | undefined;
    let qualityScore: number | undefined;

    if (row.data_json) {
      try {
        const data = JSON.parse(row.data_json);
        quadrant = data.entryQuadrant;
        qualityScore = data.qualityScore || data.quality_score;
      } catch { }
    }

    // Parse timestamp (ISO string) to milliseconds
    const timestampMs = new Date(row.timestamp).getTime();

    return {
      id: row.id,
      botId: row.bot_id,
      symbol: row.symbol,
      direction: row.direction as 'long' | 'short',
      entryPrice: row.entry_price,
      exitPrice: row.exit_price,
      entryTime: timestampMs,
      exitTime: timestampMs, // Close event only has one timestamp
      pnlPercent: row.realized_pnl_percent,
      leverage: row.leverage || 22.5,
      exitReason: row.exit_reason || 'unknown',
      quadrant,
      qualityScore,
    };
  });
}

// ============= Backtest Logic =============

function runSpotBacktest(trades: HistoricalTrade[], config: SpotBacktestConfig): SpotBacktestResult {
  let balance = config.initialBalance;
  let peakBalance = config.initialBalance;
  let maxDrawdown = 0;

  const executedTrades: SpotTrade[] = [];
  const seenSymbols = new Map<string, number>(); // symbol -> last trade time

  // Filter and dedupe
  const filteredTrades = trades.filter(t => {
    // Quality filter
    if (t.qualityScore !== undefined && t.qualityScore < config.minQualityScore) {
      return false;
    }

    // Dedupe: skip if we traded this symbol within last hour
    const lastTradeTime = seenSymbols.get(t.symbol);
    if (lastTradeTime && (t.entryTime - lastTradeTime) < 60 * 60 * 1000) {
      return false;
    }

    seenSymbols.set(t.symbol, t.entryTime);
    return true;
  });

  for (const trade of filteredTrades) {
    // Calculate position size
    const positionSize = balance * (config.positionSizePercent / 100);
    if (positionSize < 10) continue; // Min $10 position

    // Apply slippage
    const slippage = trade.entryPrice * (config.slippagePercent / 100);
    const entryWithSlippage = trade.entryPrice + slippage; // Worse entry for longs

    // Convert leveraged PnL to spot PnL
    // At 22.5x, a +10% ROI = +0.444% price move
    // At 1x, that same price move = +0.444% ROI
    const priceChangePercent = trade.pnlPercent / trade.leverage;
    const exitPriceFromChange = entryWithSlippage * (1 + priceChangePercent / 100);
    const exitWithSlippage = exitPriceFromChange - slippage; // Worse exit

    // Calculate spot P&L
    const priceDiff = exitWithSlippage - entryWithSlippage;
    const spotPnlPercent = (priceDiff / entryWithSlippage) * 100;
    const grossPnl = (priceDiff / entryWithSlippage) * positionSize;

    // Fees
    const fees = positionSize * (config.takerFeePercent / 100) * 2; // Entry + exit
    const netPnl = grossPnl - fees;

    balance += netPnl;

    // Track drawdown
    if (balance > peakBalance) {
      peakBalance = balance;
    }
    const drawdown = peakBalance - balance;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    executedTrades.push({
      original: trade,
      positionSize,
      entryPriceWithSlippage: entryWithSlippage,
      exitPriceWithSlippage: exitWithSlippage,
      spotPnlPercent,
      spotPnlDollars: grossPnl,
      fees,
      netPnl,
      balanceAfter: balance,
    });
  }

  // Calculate stats
  const wins = executedTrades.filter(t => t.netPnl > 0);
  const losses = executedTrades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  // By quadrant
  const byQuadrant: Record<string, { count: number; pnl: number; winRate: number }> = {};
  for (const t of executedTrades) {
    const q = t.original.quadrant || 'unknown';
    if (!byQuadrant[q]) byQuadrant[q] = { count: 0, pnl: 0, winRate: 0 };
    byQuadrant[q].count++;
    byQuadrant[q].pnl += t.netPnl;
  }
  for (const q of Object.keys(byQuadrant)) {
    const qTrades = executedTrades.filter(t => (t.original.quadrant || 'unknown') === q);
    const qWins = qTrades.filter(t => t.netPnl > 0).length;
    byQuadrant[q].winRate = qTrades.length > 0 ? (qWins / qTrades.length) * 100 : 0;
  }

  // By symbol (top performers)
  const bySymbol: Record<string, { count: number; pnl: number }> = {};
  for (const t of executedTrades) {
    if (!bySymbol[t.original.symbol]) bySymbol[t.original.symbol] = { count: 0, pnl: 0 };
    bySymbol[t.original.symbol].count++;
    bySymbol[t.original.symbol].pnl += t.netPnl;
  }

  // Daily returns
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of executedTrades) {
    const date = new Date(t.original.entryTime).toISOString().split('T')[0];
    if (!dailyMap.has(date)) dailyMap.set(date, { pnl: 0, trades: 0 });
    const day = dailyMap.get(date)!;
    day.pnl += t.netPnl;
    day.trades++;
  }
  const dailyReturns = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Date range
  const times = executedTrades.map(t => t.original.entryTime);
  const startDate = times.length > 0 ? new Date(Math.min(...times)).toISOString().split('T')[0] : 'N/A';
  const endDate = times.length > 0 ? new Date(Math.max(...times)).toISOString().split('T')[0] : 'N/A';

  return {
    config,
    dateRange: { start: startDate, end: endDate },
    signalsLoaded: trades.length,
    signalsFiltered: filteredTrades.length,
    tradesExecuted: executedTrades.length,

    startBalance: config.initialBalance,
    endBalance: balance,
    totalPnl: balance - config.initialBalance,
    totalReturnPct: ((balance - config.initialBalance) / config.initialBalance) * 100,
    maxDrawdown,
    maxDrawdownPct: peakBalance > 0 ? (maxDrawdown / peakBalance) * 100 : 0,

    wins: wins.length,
    losses: losses.length,
    winRate: executedTrades.length > 0 ? (wins.length / executedTrades.length) * 100 : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    totalFees: executedTrades.reduce((s, t) => s + t.fees, 0),

    byQuadrant,
    bySymbol,
    dailyReturns,
    trades: executedTrades,
  };
}

// ============= Report Generation =============

function printReport(result: SpotBacktestResult): void {
  const c = result.config;

  console.log('\n' + '═'.repeat(80));
  console.log('SPOT BACKTEST REPORT');
  console.log('═'.repeat(80));

  console.log('\nCONFIGURATION:');
  console.log(`  Initial Balance:    $${c.initialBalance.toLocaleString()}`);
  console.log(`  Position Size:      ${c.positionSizePercent}% per trade`);
  console.log(`  Days Analyzed:      ${c.daysBack}`);
  console.log(`  Bot Filter:         ${c.botFilter}`);
  console.log(`  Date Range:         ${result.dateRange.start} to ${result.dateRange.end}`);

  console.log('\n' + '─'.repeat(80));
  console.log('PERFORMANCE SUMMARY');
  console.log('─'.repeat(80));
  console.log(`  Signals Loaded:     ${result.signalsLoaded}`);
  console.log(`  After Filters:      ${result.signalsFiltered}`);
  console.log(`  Trades Executed:    ${result.tradesExecuted}`);
  console.log('');
  console.log(`  Start Balance:      $${result.startBalance.toLocaleString()}`);
  console.log(`  End Balance:        $${result.endBalance.toFixed(2)}`);
  console.log(`  Total P&L:          ${result.totalPnl >= 0 ? '+' : ''}$${result.totalPnl.toFixed(2)}`);
  console.log(`  Total Return:       ${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%`);
  console.log(`  Max Drawdown:       $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPct.toFixed(2)}%)`);

  console.log('\n' + '─'.repeat(80));
  console.log('TRADE STATISTICS');
  console.log('─'.repeat(80));
  console.log(`  Wins:               ${result.wins}`);
  console.log(`  Losses:             ${result.losses}`);
  console.log(`  Win Rate:           ${result.winRate.toFixed(1)}%`);
  console.log(`  Avg Win:            $${result.avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:           $${result.avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor:      ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
  console.log(`  Total Fees:         $${result.totalFees.toFixed(2)}`);

  // Quadrant breakdown
  if (Object.keys(result.byQuadrant).length > 1) {
    console.log('\n' + '─'.repeat(80));
    console.log('BY QUADRANT');
    console.log('─'.repeat(80));
    console.log('  Quadrant      | Trades |   P&L     | Win Rate');
    console.log('  ' + '-'.repeat(50));
    const sorted = Object.entries(result.byQuadrant).sort((a, b) => b[1].pnl - a[1].pnl);
    for (const [q, data] of sorted) {
      const pnlStr = `${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`;
      console.log(`  ${q.padEnd(13)} | ${String(data.count).padStart(6)} | ${pnlStr.padStart(9)} | ${data.winRate.toFixed(1)}%`);
    }
  }

  // Daily returns
  if (result.dailyReturns.length > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log('DAILY RETURNS');
    console.log('─'.repeat(80));
    console.log('  Date       | Trades |   P&L');
    console.log('  ' + '-'.repeat(35));
    for (const day of result.dailyReturns) {
      const pnlStr = `${day.pnl >= 0 ? '+' : ''}$${day.pnl.toFixed(2)}`;
      console.log(`  ${day.date} | ${String(day.trades).padStart(6)} | ${pnlStr}`);
    }
  }

  // Top symbols
  const topSymbols = Object.entries(result.bySymbol)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 5);
  if (topSymbols.length > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log('TOP 5 SYMBOLS');
    console.log('─'.repeat(80));
    for (const [sym, data] of topSymbols) {
      const pnlStr = `${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`;
      console.log(`  ${sym.padEnd(12)} | ${String(data.count).padStart(3)} trades | ${pnlStr}`);
    }
  }

  console.log('\n' + '═'.repeat(80));
}

function printComparison(results: { name: string; result: SpotBacktestResult }[]): void {
  console.log('\n' + '═'.repeat(100));
  console.log('CONFIGURATION COMPARISON');
  console.log('═'.repeat(100));
  console.log('');
  console.log('Config Name              | End Balance | Return   | Win Rate | Trades | Max DD  | Profit Factor');
  console.log('-'.repeat(100));

  for (const { name, result } of results) {
    const returnStr = `${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%`;
    const pfStr = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);
    console.log(
      `${name.padEnd(24)} | ` +
      `$${result.endBalance.toFixed(0).padStart(9)} | ` +
      `${returnStr.padStart(8)} | ` +
      `${result.winRate.toFixed(1).padStart(7)}% | ` +
      `${String(result.tradesExecuted).padStart(6)} | ` +
      `${result.maxDrawdownPct.toFixed(1).padStart(6)}% | ` +
      `${pfStr}`
    );
  }

  console.log('\n' + '═'.repeat(100));
}

// ============= CLI =============

function printHelp(): void {
  console.log(`
SPOT BACKTEST CLI - Test Focus Mode signals for spot-only trading

Usage:
  npm run spot-backtest -- [options]

Options:
  --days N            Days of historical data to analyze (default: 7)
  --balance N         Initial balance in USD (default: 2000)
  --position-pct N    Position size as % of balance (default: 25)
  --min-quality N     Minimum quality score 0-100 (default: 0)
  --bot-filter STR    Filter by bot ID pattern (default: 'focus-%')
  --fee-pct N         Trading fee % per side (default: 0.1)
  --slippage-pct N    Slippage % (default: 0.05)
  --compare           Run comparison of position sizes
  --verbose           Show individual trades
  --help              Show this help

Examples:
  npm run spot-backtest -- --days 7 --balance 2000
  npm run spot-backtest -- --position-pct 50 --compare
  npm run spot-backtest -- --bot-filter 'focus-aggressive'
  npm run spot-backtest -- --days 14 --balance 5000 --verbose
`);
}

async function main(): Promise<void> {
  // Initialize Turso connection
  initTurso();

  const args = process.argv.slice(2);

  // Default config
  const config: SpotBacktestConfig = {
    initialBalance: 2000,
    positionSizePercent: 25,
    maxConcurrentPositions: 5,
    daysBack: 7,
    makerFeePercent: 0.1,
    takerFeePercent: 0.1,
    slippagePercent: 0.05,
    minQualityScore: 0,
    botFilter: 'focus-%',  // Focus Mode bots by default (best performers)
  };

  let compare = false;
  let verbose = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        return;
      case '--days':
        config.daysBack = parseInt(args[++i]);
        break;
      case '--balance':
        config.initialBalance = parseFloat(args[++i]);
        break;
      case '--position-pct':
        config.positionSizePercent = parseFloat(args[++i]);
        break;
      case '--min-quality':
        config.minQualityScore = parseFloat(args[++i]);
        break;
      case '--bot-filter':
        config.botFilter = args[++i];
        break;
      case '--fee-pct':
        config.takerFeePercent = parseFloat(args[++i]);
        config.makerFeePercent = parseFloat(args[i]);
        break;
      case '--slippage-pct':
        config.slippagePercent = parseFloat(args[++i]);
        break;
      case '--compare':
        compare = true;
        break;
      case '--verbose':
        verbose = true;
        break;
    }
  }

  console.log('Loading trades from Turso...');

  try {
    const trades = await loadTradesFromTurso(config);
    console.log(`Loaded ${trades.length} LONG trades from last ${config.daysBack} days\n`);

    if (trades.length === 0) {
      console.log('No trades found. Check your bot filter or date range.');
      return;
    }

    if (compare) {
      // Run multiple position size configurations
      const configs = [
        { name: '10% Position Size', positionSizePercent: 10 },
        { name: '25% Position Size', positionSizePercent: 25 },
        { name: '50% Position Size', positionSizePercent: 50 },
        { name: '75% Position Size', positionSizePercent: 75 },
      ];

      const results: { name: string; result: SpotBacktestResult }[] = [];
      for (const c of configs) {
        const testConfig = { ...config, ...c };
        const result = runSpotBacktest(trades, testConfig);
        results.push({ name: c.name, result });
      }

      printComparison(results);

      // Print detailed report for best performer
      const best = results.reduce((a, b) =>
        a.result.totalReturnPct > b.result.totalReturnPct ? a : b
      );
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`DETAILED REPORT FOR BEST CONFIG: ${best.name}`);
      printReport(best.result);

    } else {
      // Single run
      const result = runSpotBacktest(trades, config);
      printReport(result);

      if (verbose && result.trades.length > 0) {
        console.log('\n' + '─'.repeat(80));
        console.log('INDIVIDUAL TRADES');
        console.log('─'.repeat(80));
        console.log('Symbol       | Entry     | Exit      | Size    | P&L      | Balance');
        console.log('-'.repeat(80));
        for (const t of result.trades) {
          const pnlStr = `${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(2)}`;
          console.log(
            `${t.original.symbol.padEnd(12)} | ` +
            `$${t.entryPriceWithSlippage.toPrecision(5).padStart(8)} | ` +
            `$${t.exitPriceWithSlippage.toPrecision(5).padStart(8)} | ` +
            `$${t.positionSize.toFixed(0).padStart(5)} | ` +
            `${pnlStr.padStart(8)} | ` +
            `$${t.balanceAfter.toFixed(2)}`
          );
        }
      }
    }

  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

main();
