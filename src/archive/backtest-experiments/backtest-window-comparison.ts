#!/usr/bin/env node
/**
 * WINDOW COMPARISON BACKTEST
 *
 * Tests different macro/micro window combinations to find optimal regime detection.
 * Compares: 24h/4h (original), 24h/1h, 4h/1h
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = '/sessions/nifty-inspiring-fermat/mnt/Backburner/data';
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const CANDLES_DIR = path.join(DATA_DIR, 'candles');

// ============= Types =============

interface LocalSignal {
  timestamp: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  price: number;
  entryPrice?: number;
  state: string;
  eventType: string;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Trade {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlDollars: number;
  quadrant: string;
}

type MacroRegime = 'BULL' | 'BEAR' | 'NEU';
type MicroRegime = 'BULL' | 'BEAR' | 'NEU';

interface WindowConfig {
  name: string;
  macroHours: number;
  microHours: number;
  macroThreshold: number;  // % for bull/bear classification
  microThreshold: number;
  macroMinSignals: number;
  microMinSignals: number;
}

// Window configurations to test
const WINDOW_CONFIGS: WindowConfig[] = [
  {
    name: '24h/4h (original)',
    macroHours: 24,
    microHours: 4,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 10,
    microMinSignals: 3,
  },
  {
    name: '24h/1h',
    macroHours: 24,
    microHours: 1,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 10,
    microMinSignals: 2,  // Lower min for 1h window
  },
  {
    name: '4h/1h',
    macroHours: 4,
    microHours: 1,
    macroThreshold: 60,  // Slightly higher threshold for shorter window
    microThreshold: 65,
    macroMinSignals: 5,
    microMinSignals: 2,
  },
  {
    name: '12h/2h',
    macroHours: 12,
    microHours: 2,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 8,
    microMinSignals: 3,
  },
];

// Contrarian rules
const QUADRANT_RULES: Record<string, 'LONG' | 'SHORT' | 'SKIP'> = {
  'NEU+BEAR': 'LONG',
  'NEU+BULL': 'SHORT',
  'BEAR+BEAR': 'LONG',
  'BEAR+BULL': 'SKIP',  // Bull trap
  'BULL+BULL': 'SHORT',
  'BULL+BEAR': 'LONG',
  'BULL+NEU': 'SKIP',
  'BEAR+NEU': 'SKIP',
  'NEU+NEU': 'SKIP',
};

// ============= Data Loading =============

function loadSignals(days: number): LocalSignal[] {
  const allSignals: LocalSignal[] = [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  if (fs.existsSync(SIGNALS_DIR)) {
    const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, file), 'utf-8'));
        for (const sig of data) {
          if (new Date(sig.timestamp) >= cutoffDate) {
            allSignals.push(sig);
          }
        }
      } catch { /* skip */ }
    }
  }

  return allSignals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function loadCandles(symbol: string, timeframe: string): Candle[] | null {
  const symbolDir = path.join(CANDLES_DIR, symbol);
  const spotPath = path.join(symbolDir, `${timeframe}-spot.json`);
  const futuresPath = path.join(symbolDir, `${timeframe}-futures.json`);

  for (const filepath of [spotPath, futuresPath]) {
    if (fs.existsSync(filepath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        const candles = data.candles || data;
        return candles.map((c: any) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
      } catch { continue; }
    }
  }
  return null;
}

// ============= Regime Detection =============

function getRegime(
  signals: LocalSignal[],
  timestamp: number,
  windowHours: number,
  threshold: number,
  minSignals: number
): { regime: 'BULL' | 'BEAR' | 'NEU'; longPct: number; shortPct: number; count: number } {
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = timestamp - windowMs;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= windowStart && ts < timestamp;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < minSignals) {
    return { regime: 'NEU', longPct: 50, shortPct: 50, count: total };
  }

  const longPct = Math.round((longs / total) * 100);
  const shortPct = 100 - longPct;

  let regime: 'BULL' | 'BEAR' | 'NEU' = 'NEU';
  if (longPct >= threshold) regime = 'BULL';
  else if (shortPct >= threshold) regime = 'BEAR';

  return { regime, longPct, shortPct, count: total };
}

// ============= Backtest =============

function runBacktest(
  allSignals: LocalSignal[],
  config: WindowConfig,
  leverage: number = 10
): { trades: Trade[]; byQuadrant: Record<string, Trade[]> } {
  const trades: Trade[] = [];
  const byQuadrant: Record<string, Trade[]> = {};

  // Get only triggered signals for trading
  const triggeredSignals = allSignals.filter(s =>
    (s.state === 'triggered' || s.state === 'deep_extreme') &&
    s.eventType === 'triggered' &&
    s.entryPrice
  );

  for (const signal of triggeredSignals) {
    const ts = new Date(signal.timestamp).getTime();

    // Calculate regimes using ALL signals (not just triggered)
    const macro = getRegime(allSignals, ts, config.macroHours, config.macroThreshold, config.macroMinSignals);
    const micro = getRegime(allSignals, ts, config.microHours, config.microThreshold, config.microMinSignals);
    const quadrant = `${macro.regime}+${micro.regime}`;

    const action = QUADRANT_RULES[quadrant] || 'SKIP';
    if (action === 'SKIP') continue;

    // Load candles for simulation
    const candles = loadCandles(signal.symbol, signal.timeframe);
    if (!candles) continue;

    // Simulate trade
    const trade = simulateTrade(signal, action, candles, quadrant, leverage);
    if (trade) {
      trades.push(trade);
      if (!byQuadrant[quadrant]) byQuadrant[quadrant] = [];
      byQuadrant[quadrant].push(trade);
    }
  }

  return { trades, byQuadrant };
}

function simulateTrade(
  signal: LocalSignal,
  direction: 'LONG' | 'SHORT',
  candles: Candle[],
  quadrant: string,
  leverage: number
): Trade | null {
  const entryTime = new Date(signal.timestamp).getTime();
  const entryPrice = signal.entryPrice || signal.price;

  const futureCandles = candles.filter(c => c.timestamp > entryTime);
  if (futureCandles.length === 0) return null;

  // Stop/TP based on leverage
  const stopPct = leverage >= 10 ? 5 : 10;
  const tpPct = leverage >= 10 ? 15 : 20;

  const stopDistance = entryPrice * (stopPct / 100);
  const tpDistance = entryPrice * (tpPct / 100);

  let stopLoss: number, takeProfit: number;
  if (direction === 'LONG') {
    stopLoss = entryPrice - stopDistance;
    takeProfit = entryPrice + tpDistance;
  } else {
    stopLoss = entryPrice + stopDistance;
    takeProfit = entryPrice - tpDistance;
  }

  let exitPrice = entryPrice;

  for (const candle of futureCandles) {
    if (direction === 'LONG') {
      if (candle.low <= stopLoss) { exitPrice = stopLoss; break; }
      if (candle.high >= takeProfit) { exitPrice = takeProfit; break; }
    } else {
      if (candle.high >= stopLoss) { exitPrice = stopLoss; break; }
      if (candle.low <= takeProfit) { exitPrice = takeProfit; break; }
    }

    // Timeout after 48h
    if (candle.timestamp - entryTime > 48 * 60 * 60 * 1000) {
      exitPrice = candle.close;
      break;
    }
  }

  let pnlPercent: number;
  if (direction === 'LONG') {
    pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  const leveragedPnl = pnlPercent * leverage;
  const netPnl = leveragedPnl - 0.2; // 0.2% fees
  const pnlDollars = 100 * (netPnl / 100); // $100 position

  return {
    symbol: signal.symbol,
    direction: direction === 'LONG' ? 'long' : 'short',
    entryPrice,
    exitPrice,
    pnlPercent: netPnl,
    pnlDollars,
    quadrant,
  };
}

// ============= Main =============

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1]) : 7;

console.log('='.repeat(80));
console.log('WINDOW COMPARISON BACKTEST');
console.log('='.repeat(80));
console.log(`Period: Last ${days} days | Leverage: 10x`);
console.log('');

const allSignals = loadSignals(days);
console.log(`Loaded ${allSignals.length} total signals`);

const triggeredCount = allSignals.filter(s =>
  (s.state === 'triggered' || s.state === 'deep_extreme') &&
  s.eventType === 'triggered' &&
  s.entryPrice
).length;
console.log(`Triggered signals: ${triggeredCount}`);
console.log('');

console.log('='.repeat(80));
console.log('RESULTS BY WINDOW CONFIGURATION');
console.log('='.repeat(80));
console.log('');

interface ConfigResult {
  name: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  maxDD: number;
  byQuadrant: Record<string, { trades: number; wins: number; pnl: number }>;
}

const results: ConfigResult[] = [];

for (const config of WINDOW_CONFIGS) {
  console.log(`\n📊 Testing: ${config.name}`);
  console.log(`   Macro: ${config.macroHours}h (>${config.macroThreshold}% = BULL/BEAR, min ${config.macroMinSignals} signals)`);
  console.log(`   Micro: ${config.microHours}h (>${config.microThreshold}% = BULL/BEAR, min ${config.microMinSignals} signals)`);

  const { trades, byQuadrant } = runBacktest(allSignals, config, 10);

  const wins = trades.filter(t => t.pnlDollars > 0).length;
  const totalPnL = trades.reduce((sum, t) => sum + t.pnlDollars, 0);

  // Max drawdown
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlDollars;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
  }

  const quadrantStats: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const [q, qTrades] of Object.entries(byQuadrant)) {
    quadrantStats[q] = {
      trades: qTrades.length,
      wins: qTrades.filter(t => t.pnlDollars > 0).length,
      pnl: qTrades.reduce((sum, t) => sum + t.pnlDollars, 0),
    };
  }

  results.push({
    name: config.name,
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnL,
    avgPnL: trades.length > 0 ? totalPnL / trades.length : 0,
    maxDD,
    byQuadrant: quadrantStats,
  });

  const status = totalPnL > 0 ? '✅' : '❌';
  console.log(`   ${status} Trades: ${trades.length} | Win Rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0}%`);
  console.log(`   ${status} P&L: $${totalPnL.toFixed(2)} | Avg: $${trades.length > 0 ? (totalPnL / trades.length).toFixed(2) : 0} | MaxDD: $${maxDD.toFixed(2)}`);

  if (Object.keys(quadrantStats).length > 0) {
    console.log('   By Quadrant:');
    for (const [q, stats] of Object.entries(quadrantStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const qStatus = stats.pnl > 0 ? '✅' : '❌';
      console.log(`      ${qStatus} ${q}: ${stats.trades} trades, ${((stats.wins / stats.trades) * 100).toFixed(0)}% win, $${stats.pnl.toFixed(2)}`);
    }
  }
}

// ============= Summary =============

console.log('');
console.log('='.repeat(80));
console.log('SUMMARY COMPARISON');
console.log('='.repeat(80));
console.log('');

console.log('Config                    Trades  Win%      P&L     Avg    MaxDD');
console.log('-'.repeat(70));

for (const r of results.sort((a, b) => b.totalPnL - a.totalPnL)) {
  const status = r.totalPnL > 0 ? '✅' : '❌';
  console.log(
    `${status} ${r.name.padEnd(20)} ${r.trades.toString().padStart(6)}  ` +
    `${r.winRate.toFixed(1).padStart(5)}%  $${r.totalPnL.toFixed(2).padStart(8)}  ` +
    `$${r.avgPnL.toFixed(2).padStart(6)}  $${r.maxDD.toFixed(2).padStart(6)}`
  );
}

// ============= Recommendation =============

console.log('');
console.log('='.repeat(80));
console.log('RECOMMENDATION');
console.log('='.repeat(80));
console.log('');

const best = results.sort((a, b) => b.totalPnL - a.totalPnL)[0];
if (best) {
  console.log(`🏆 BEST WINDOW CONFIG: ${best.name}`);
  console.log(`   Total P&L: $${best.totalPnL.toFixed(2)}`);
  console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);
  console.log(`   Trades: ${best.trades}`);
  console.log(`   Max Drawdown: $${best.maxDD.toFixed(2)}`);

  if (best.byQuadrant) {
    console.log('');
    console.log('   Best Quadrants:');
    const sortedQuadrants = Object.entries(best.byQuadrant)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 3);
    for (const [q, stats] of sortedQuadrants) {
      console.log(`      ${q}: $${stats.pnl.toFixed(2)} (${stats.trades} trades, ${((stats.wins / stats.trades) * 100).toFixed(0)}% win)`);
    }
  }
}
