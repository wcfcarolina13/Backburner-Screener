#!/usr/bin/env node
/**
 * Combined Strategy Backtest
 *
 * Tests the hypothesis: Use 4H normal to establish trend, then use 5m fade
 * to time entries in the direction of the 4H trend.
 *
 * Logic:
 * - 4H LONG signal → establishes bullish bias
 * - Wait for 5m SHORT signal → FADE it (go LONG) - aligned with 4H!
 * - 4H SHORT signal → establishes bearish bias
 * - Wait for 5m LONG signal → FADE it (go SHORT) - aligned with 4H!
 *
 * This filters for confluence between higher timeframe direction and
 * lower timeframe entry timing.
 */

import fs from 'fs';
import path from 'path';
import { Candle, Timeframe, MarketType } from './types.js';
import { getCandles, getCandlesFromEntry, timeframeToMs } from './candle-store.js';
import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();

// ============= Types =============

interface Signal {
  timestamp: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: MarketType;
  rsi: number;
  price: number;
  state: string;
}

interface CombinedTrade {
  symbol: string;
  direction: 'long' | 'short';

  // 4H signal that established the bias
  htfSignalTime: number;
  htfSignalDirection: 'long' | 'short';

  // 5m signal that triggered entry (we fade this)
  ltfSignalTime: number;
  ltfSignalDirection: 'long' | 'short';  // Original 5m signal (we go opposite)

  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: string;

  realizedPnL: number;
  realizedPnLPercent: number;
}

interface BacktestConfig {
  leverage: number;
  positionSizePercent: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;

  // How long is a 4H signal valid for 5m entries? (in ms)
  htfSignalValidityMs: number;
}

const DEFAULT_CONFIG: BacktestConfig = {
  leverage: 10,
  positionSizePercent: 5,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  htfSignalValidityMs: 8 * 60 * 60 * 1000,  // 8 hours (2 x 4H candles)
};

// ============= Signal Loading =============

function loadGeneratedSignals(timeframe: string, startDate: string, endDate: string): Signal[] {
  const signalsDir = path.join(process.cwd(), 'data', 'generated-signals', timeframe);
  if (!fs.existsSync(signalsDir)) {
    console.log(`[Combined] No generated signals directory found for ${timeframe}`);
    return [];
  }

  const signals: Signal[] = [];
  const files = fs.readdirSync(signalsDir)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const date = f.replace('.json', '');
      return date >= startDate && date <= endDate;
    })
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(signalsDir, file), 'utf-8'));
      signals.push(...data);
    } catch (e) {
      // Skip bad files
    }
  }

  return signals;
}

// ============= Position Simulation =============

interface Position {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  effectiveEntryPrice: number;
  entryTime: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  initialStopPrice: number;
  currentStopPrice: number;
  highWaterMark: number;
  trailLevel: number;

  entryCosts: number;

  // Signal info
  htfSignalTime: number;
  htfSignalDirection: 'long' | 'short';
  ltfSignalTime: number;
  ltfSignalDirection: 'long' | 'short';
}

function calculateStopPrice(
  entryPrice: number,
  direction: 'long' | 'short',
  stopLossPercent: number
): number {
  if (direction === 'long') {
    return entryPrice * (1 - stopLossPercent / 100);
  } else {
    return entryPrice * (1 + stopLossPercent / 100);
  }
}

function calculateROI(position: Position, currentPrice: number): number {
  const priceChange = position.direction === 'long'
    ? (currentPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
    : (position.effectiveEntryPrice - currentPrice) / position.effectiveEntryPrice;
  return priceChange * position.leverage * 100;
}

function updateTrailingStop(
  position: Position,
  currentPrice: number,
  config: BacktestConfig
): boolean {
  const roi = calculateROI(position, currentPrice);
  if (roi > position.highWaterMark) {
    position.highWaterMark = roi;
  }

  // Level 0: Not yet triggered
  if (position.trailLevel === 0) {
    if (roi >= config.trailTriggerPercent) {
      position.trailLevel = 1;
      const lockPrice = position.direction === 'long'
        ? position.effectiveEntryPrice * (1 + config.level1LockPercent / 100)
        : position.effectiveEntryPrice * (1 - config.level1LockPercent / 100);
      position.currentStopPrice = lockPrice;
      return true;
    }
    return false;
  }

  // Higher levels
  const nextLevelTrigger = config.trailTriggerPercent + (position.trailLevel * config.trailStepPercent);
  if (roi >= nextLevelTrigger) {
    position.trailLevel++;
    const lockPercent = config.level1LockPercent + ((position.trailLevel - 1) * config.trailStepPercent);
    const lockPrice = position.direction === 'long'
      ? position.effectiveEntryPrice * (1 + lockPercent / 100)
      : position.effectiveEntryPrice * (1 - lockPercent / 100);
    position.currentStopPrice = lockPrice;
    return true;
  }

  return false;
}

function checkStopHit(
  position: Position,
  candle: Candle
): { exitPrice: number; reason: string } | null {
  if (position.direction === 'long') {
    if (candle.low <= position.currentStopPrice) {
      return {
        exitPrice: position.currentStopPrice,
        reason: position.trailLevel > 0 ? `trail_L${position.trailLevel}` : 'initial_stop'
      };
    }
  } else {
    if (candle.high >= position.currentStopPrice) {
      return {
        exitPrice: position.currentStopPrice,
        reason: position.trailLevel > 0 ? `trail_L${position.trailLevel}` : 'initial_stop'
      };
    }
  }
  return null;
}

async function simulateTrade(
  htfSignal: Signal,
  ltfSignal: Signal,
  config: BacktestConfig,
  initialBalance: number
): Promise<CombinedTrade | null> {
  // Direction is the FADE of the 5m signal (but aligned with 4H)
  const direction = ltfSignal.direction === 'long' ? 'short' : 'long';

  const entryTime = new Date(ltfSignal.timestamp).getTime();
  const candles = await getCandlesFromEntry(
    ltfSignal.symbol,
    '5m' as Timeframe,  // Use 5m candles for simulation
    ltfSignal.marketType,
    entryTime,
    7 * 24 * 60 * 60 * 1000  // 7 days
  );

  if (candles.length < 2) {
    return null;
  }

  const entryCandle = candles.find(c => c.timestamp >= entryTime);
  if (!entryCandle) return null;

  // Position sizing
  const margin = initialBalance * (config.positionSizePercent / 100);
  const notional = margin * config.leverage;

  // Entry with slippage
  const volatility = determineVolatility(ltfSignal.rsi);
  const entryCosts = costsCalculator.calculateEntryCosts(
    entryCandle.close,
    notional,
    direction,
    volatility
  );

  const stopPrice = calculateStopPrice(
    entryCosts.effectiveEntryPrice,
    direction,
    config.initialStopLossPercent
  );

  const position: Position = {
    symbol: ltfSignal.symbol,
    direction,
    entryPrice: entryCandle.close,
    effectiveEntryPrice: entryCosts.effectiveEntryPrice,
    entryTime,
    marginUsed: margin,
    notionalSize: notional,
    leverage: config.leverage,
    initialStopPrice: stopPrice,
    currentStopPrice: stopPrice,
    highWaterMark: 0,
    trailLevel: 0,
    entryCosts: entryCosts.entryCosts,
    htfSignalTime: new Date(htfSignal.timestamp).getTime(),
    htfSignalDirection: htfSignal.direction,
    ltfSignalTime: entryTime,
    ltfSignalDirection: ltfSignal.direction,
  };

  // Simulate through candles
  let exitPrice: number | null = null;
  let exitTime: number = 0;
  let exitReason: string = 'end_of_data';

  const startIndex = candles.indexOf(entryCandle) + 1;
  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];

    // Update trailing stop
    const bestPrice = direction === 'long' ? candle.high : candle.low;
    updateTrailingStop(position, bestPrice, config);

    // Check stop hit
    const stopHit = checkStopHit(position, candle);
    if (stopHit) {
      exitPrice = stopHit.exitPrice;
      exitTime = candle.timestamp;
      exitReason = stopHit.reason;
      break;
    }
  }

  // If no exit, use last candle close
  if (exitPrice === null) {
    const lastCandle = candles[candles.length - 1];
    exitPrice = lastCandle.close;
    exitTime = lastCandle.timestamp;
    exitReason = 'end_of_data';
  }

  // Calculate P&L
  const exitCosts = costsCalculator.calculateExitCosts(
    exitPrice,
    notional,
    direction,
    'normal'
  );

  const priceChange = direction === 'long'
    ? (exitCosts.effectiveExitPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
    : (position.effectiveEntryPrice - exitCosts.effectiveExitPrice) / position.effectiveEntryPrice;

  const rawPnL = priceChange * notional;
  const totalCosts = position.entryCosts + exitCosts.exitCosts;
  const realizedPnL = rawPnL - totalCosts;
  const realizedPnLPercent = (realizedPnL / margin) * 100;

  return {
    symbol: ltfSignal.symbol,
    direction,
    htfSignalTime: position.htfSignalTime,
    htfSignalDirection: position.htfSignalDirection,
    ltfSignalTime: position.ltfSignalTime,
    ltfSignalDirection: position.ltfSignalDirection,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    exitPrice,
    exitTime,
    exitReason,
    realizedPnL,
    realizedPnLPercent,
  };
}

// ============= Main Backtest Logic =============

async function runCombinedBacktest(
  startDate: string,
  endDate: string,
  config: BacktestConfig = DEFAULT_CONFIG,
  initialBalance: number = 2000
): Promise<{ trades: CombinedTrade[], summary: any }> {
  console.log(`\n📊 Combined Strategy Backtest (4H Normal + 5m Fade)\n`);
  console.log(`Date Range: ${startDate} to ${endDate}`);
  console.log(`Config: ${config.leverage}x leverage, ${config.initialStopLossPercent}% SL`);
  console.log(`HTF Signal Validity: ${config.htfSignalValidityMs / (60 * 60 * 1000)}h\n`);

  // Load signals
  const htfSignals = loadGeneratedSignals('4h', startDate, endDate);
  const ltfSignals = loadGeneratedSignals('5m', startDate, endDate);

  console.log(`Loaded ${htfSignals.length} 4H signals`);
  console.log(`Loaded ${ltfSignals.length} 5m signals`);

  if (htfSignals.length === 0 || ltfSignals.length === 0) {
    console.log('\n❌ Need both 4H and 5m signals to run combined backtest');
    console.log('Run: npm run generate-signals -- --timeframe 5m --days 30');
    return { trades: [], summary: null };
  }

  // Sort signals by time
  htfSignals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  ltfSignals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Track active 4H biases per symbol
  const activeBias: Map<string, { direction: 'long' | 'short'; signal: Signal; validUntil: number }> = new Map();

  // Process 4H signals to establish biases
  for (const htfSignal of htfSignals) {
    const signalTime = new Date(htfSignal.timestamp).getTime();
    activeBias.set(htfSignal.symbol, {
      direction: htfSignal.direction,
      signal: htfSignal,
      validUntil: signalTime + config.htfSignalValidityMs
    });
  }

  // Find 5m signals that align with 4H bias (via fade)
  const alignedSignals: Array<{ htf: Signal; ltf: Signal }> = [];

  for (const ltfSignal of ltfSignals) {
    const ltfTime = new Date(ltfSignal.timestamp).getTime();

    // Find valid 4H bias for this symbol at this time
    const bias = activeBias.get(ltfSignal.symbol);
    if (!bias) continue;

    const htfTime = new Date(bias.signal.timestamp).getTime();

    // Check if 4H signal is still valid (not expired)
    if (ltfTime > bias.validUntil) continue;

    // Check if 5m signal came AFTER the 4H signal
    if (ltfTime <= htfTime) continue;

    // Check alignment: 4H direction should match the FADED 5m direction
    // 4H LONG + 5m SHORT (faded to LONG) = ✅ Aligned
    // 4H SHORT + 5m LONG (faded to SHORT) = ✅ Aligned
    const fadedDirection = ltfSignal.direction === 'long' ? 'short' : 'long';

    if (bias.direction === fadedDirection) {
      alignedSignals.push({ htf: bias.signal, ltf: ltfSignal });
    }
  }

  console.log(`\nFound ${alignedSignals.length} aligned signals (4H bias + 5m fade entry)\n`);

  if (alignedSignals.length === 0) {
    console.log('No aligned signals found. This could mean:');
    console.log('1. Time periods don\'t overlap');
    console.log('2. No symbols had both 4H and 5m signals');
    console.log('3. Signals didn\'t align (4H long + 5m short OR 4H short + 5m long)');
    return { trades: [], summary: null };
  }

  // Simulate trades
  const trades: CombinedTrade[] = [];
  let processed = 0;

  for (const { htf, ltf } of alignedSignals) {
    processed++;
    process.stdout.write(`\r[${processed}/${alignedSignals.length}] Simulating ${ltf.symbol}...`);

    const trade = await simulateTrade(htf, ltf, config, initialBalance);
    if (trade) {
      trades.push(trade);
    }
  }

  console.log('\n');

  // Calculate summary
  const wins = trades.filter(t => t.realizedPnL > 0);
  const losses = trades.filter(t => t.realizedPnL <= 0);
  const totalPnL = trades.reduce((sum, t) => sum + t.realizedPnL, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnL, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnL, 0));

  const summary = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnL,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    byExitReason: {} as Record<string, { count: number; pnl: number }>,
  };

  // Group by exit reason
  for (const trade of trades) {
    if (!summary.byExitReason[trade.exitReason]) {
      summary.byExitReason[trade.exitReason] = { count: 0, pnl: 0 };
    }
    summary.byExitReason[trade.exitReason].count++;
    summary.byExitReason[trade.exitReason].pnl += trade.realizedPnL;
  }

  return { trades, summary };
}

// ============= Print Results =============

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

  // Show some example trades
  if (trades.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('Sample Trades:');
    console.log('─'.repeat(70));

    const samples = trades.slice(0, 5);
    for (const t of samples) {
      const emoji = t.realizedPnL >= 0 ? '✅' : '❌';
      console.log(`${emoji} ${t.symbol} ${t.direction.toUpperCase()}`);
      console.log(`   4H ${t.htfSignalDirection.toUpperCase()} → 5m ${t.ltfSignalDirection.toUpperCase()} (faded) → Entry ${t.direction.toUpperCase()}`);
      console.log(`   Entry: $${t.entryPrice.toFixed(4)} → Exit: $${t.exitPrice.toFixed(4)} | PnL: $${t.realizedPnL.toFixed(2)} (${t.exitReason})`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ============= CLI =============

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse args
  let startDate = '';
  let endDate = '';
  let htfValidityHours = 8;

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
Combined Strategy Backtest (4H Normal + 5m Fade)

Usage: npm run backtest-combined -- [options]

Options:
  --start, -s <date>     Start date (YYYY-MM-DD)
  --end, -e <date>       End date (YYYY-MM-DD)
  --validity, -v <hrs>   How long 4H signal is valid for 5m entries (default: 8)
  --help, -h             Show this help

Example:
  npm run backtest-combined -- --start 2026-01-14 --end 2026-01-19
`);
      return;
    }
  }

  // Defaults
  if (!startDate || !endDate) {
    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    startDate = startDate || start;
    endDate = endDate || end;
  }

  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    htfSignalValidityMs: htfValidityHours * 60 * 60 * 1000,
  };

  const { trades, summary } = await runCombinedBacktest(startDate, endDate, config);

  if (summary) {
    printResults(trades, summary);
  }
}

main().catch(console.error);
