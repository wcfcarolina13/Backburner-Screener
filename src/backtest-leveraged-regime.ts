#!/usr/bin/env node
/**
 * LEVERAGED Regime Backtest
 *
 * Tests if the regime filtering strategy works BETTER with:
 * - Shorts allowed (can profit in bearish micro-regimes directly)
 * - Leverage (5x, 10x, 20x)
 *
 * This is for MANUAL trading consideration - if the signals are golden
 * with leverage, it might be worth the manual effort while collecting data.
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
  timeframe: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPercent: number;
  pnlDollars: number;
  quadrant: string;
  exitReason: string;
}

type MacroRegime = 'bull' | 'bear' | 'neutral';
type MicroRegime = 'bullish' | 'bearish' | 'neutral';

// ============= Data Loading =============

function loadSignals(days: number): LocalSignal[] {
  const allSignals: LocalSignal[] = [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Load from signals directory (date-based files)
  if (fs.existsSync(SIGNALS_DIR)) {
    const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, file), 'utf-8'));
        for (const sig of data) {
          // Only include triggered signals with entry prices
          const isTriggered = (sig.state === 'triggered' || sig.state === 'deep_extreme') &&
                              sig.eventType === 'triggered' &&
                              sig.entryPrice;
          if (isTriggered && new Date(sig.timestamp) >= cutoffDate) {
            allSignals.push(sig);
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  return allSignals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function loadCandles(symbol: string, timeframe: string): Candle[] | null {
  // Path: candles/{SYMBOL}/{timeframe}-spot.json
  const symbolDir = path.join(CANDLES_DIR, symbol);
  const spotPath = path.join(symbolDir, `${timeframe}-spot.json`);
  const futuresPath = path.join(symbolDir, `${timeframe}-futures.json`);

  // Try spot first, then futures
  for (const filepath of [spotPath, futuresPath]) {
    if (fs.existsSync(filepath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        // Handle wrapped format: { candles: [...] }
        const candles = data.candles || data;
        return candles.map((c: any) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ============= Regime Detection =============

function getMacroRegime(signals: LocalSignal[], timestamp: number, windowHours: number = 24): MacroRegime {
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = timestamp - windowMs;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= windowStart && ts < timestamp;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < 10) return 'neutral';

  const longRatio = longs / total;
  if (longRatio > 0.55) return 'bull';
  if (longRatio < 0.45) return 'bear';
  return 'neutral';
}

function getMicroRegime(signals: LocalSignal[], timestamp: number, windowHours: number = 4): { regime: MicroRegime; shortRatio: number } {
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = timestamp - windowMs;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= windowStart && ts < timestamp;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < 3) return { regime: 'neutral', shortRatio: 0.5 };

  const shortRatio = shorts / total;
  const longRatio = longs / total;

  let regime: MicroRegime = 'neutral';
  if (shortRatio > 0.65) regime = 'bearish';
  else if (longRatio > 0.65) regime = 'bullish';

  return { regime, shortRatio };
}

function getQuadrant(macro: MacroRegime, micro: MicroRegime): string {
  const macroShort = macro === 'bull' ? 'BULL' : macro === 'bear' ? 'BEAR' : 'NEU';
  const microShort = micro === 'bullish' ? 'BULL' : micro === 'bearish' ? 'BEAR' : 'NEU';
  return `${macroShort}+${microShort}`;
}

// ============= Leveraged Strategy Rules =============

interface StrategyConfig {
  name: string;
  leverage: number;
  allowShorts: boolean;
  positionSizeDollars: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  // Quadrant rules - which quadrants to trade and in which direction
  rules: Record<string, 'long' | 'short' | 'skip'>;
}

// Define the strategies based on our regime matrix findings
const STRATEGIES: StrategyConfig[] = [
  // Spot baseline (for comparison)
  {
    name: 'spot-1x-longs-only',
    leverage: 1,
    allowShorts: false,
    positionSizeDollars: 100,
    stopLossPercent: 15,
    takeProfitPercent: 30,
    rules: {
      'NEU+BEAR': 'long',   // Contrarian long
      'NEU+BULL': 'long',   // Trend follow
      'BEAR+BEAR': 'long',  // Deep contrarian
      'BEAR+BULL': 'skip',  // Bull trap - NEVER
      'BULL+BULL': 'skip',
      'BULL+NEU': 'skip',
      'BULL+BEAR': 'skip',
      'BEAR+NEU': 'skip',
      'NEU+NEU': 'skip',
    },
  },
  // Leveraged longs only
  {
    name: 'futures-5x-longs-only',
    leverage: 5,
    allowShorts: false,
    positionSizeDollars: 100,
    stopLossPercent: 10,  // Tighter stop with leverage
    takeProfitPercent: 20,
    rules: {
      'NEU+BEAR': 'long',
      'NEU+BULL': 'long',
      'BEAR+BEAR': 'long',
      'BEAR+BULL': 'skip',
      'BULL+BULL': 'skip',
      'BULL+NEU': 'skip',
      'BULL+BEAR': 'skip',
      'BEAR+NEU': 'skip',
      'NEU+NEU': 'skip',
    },
  },
  // Leveraged with shorts - bi-directional regime trading
  {
    name: 'futures-5x-bidirectional',
    leverage: 5,
    allowShorts: true,
    positionSizeDollars: 100,
    stopLossPercent: 10,
    takeProfitPercent: 20,
    rules: {
      // Contrarian quadrants - trade OPPOSITE of micro regime
      'NEU+BEAR': 'long',   // Micro bearish → go long (contrarian)
      'NEU+BULL': 'short',  // Micro bullish → go short (contrarian)
      'BEAR+BEAR': 'long',  // Deep bearish → contrarian long
      'BEAR+BULL': 'skip',  // Bull trap - NEVER trade
      // Trend following in macro bull
      'BULL+BULL': 'long',  // Macro + micro bullish → trend follow long
      'BULL+BEAR': 'short', // Macro bull but micro bear → short the dip
      'BULL+NEU': 'skip',
      'BEAR+NEU': 'skip',
      'NEU+NEU': 'skip',
    },
  },
  // Pure contrarian with shorts
  {
    name: 'futures-5x-pure-contrarian',
    leverage: 5,
    allowShorts: true,
    positionSizeDollars: 100,
    stopLossPercent: 10,
    takeProfitPercent: 20,
    rules: {
      // ALWAYS trade opposite of micro regime
      'NEU+BEAR': 'long',
      'NEU+BULL': 'short',
      'BEAR+BEAR': 'long',
      'BEAR+BULL': 'skip',  // Still skip bull traps
      'BULL+BULL': 'short', // Contrarian short at euphoria
      'BULL+BEAR': 'long',  // Contrarian long during bull macro dip
      'BULL+NEU': 'skip',
      'BEAR+NEU': 'skip',
      'NEU+NEU': 'skip',
    },
  },
  // Higher leverage test
  {
    name: 'futures-10x-contrarian',
    leverage: 10,
    allowShorts: true,
    positionSizeDollars: 100,
    stopLossPercent: 5,  // Much tighter with 10x
    takeProfitPercent: 15,
    rules: {
      'NEU+BEAR': 'long',
      'NEU+BULL': 'short',
      'BEAR+BEAR': 'long',
      'BEAR+BULL': 'skip',
      'BULL+BULL': 'short',
      'BULL+BEAR': 'long',
      'BULL+NEU': 'skip',
      'BEAR+NEU': 'skip',
      'NEU+NEU': 'skip',
    },
  },
];

// ============= Backtest Engine =============

function simulateTrade(
  signal: LocalSignal,
  direction: 'long' | 'short',
  config: StrategyConfig,
  candles: Candle[],
  quadrant: string
): Trade | null {
  const entryTime = new Date(signal.timestamp).getTime();
  const entryPrice = signal.entryPrice || signal.price;

  // Find candles after entry
  const futureCandles = candles.filter(c => c.timestamp > entryTime);
  if (futureCandles.length === 0) return null;

  // Calculate stop and TP based on leverage-adjusted percentages
  const stopDistance = entryPrice * (config.stopLossPercent / 100);
  const tpDistance = entryPrice * (config.takeProfitPercent / 100);

  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'long') {
    stopLoss = entryPrice - stopDistance;
    takeProfit = entryPrice + tpDistance;
  } else {
    stopLoss = entryPrice + stopDistance;
    takeProfit = entryPrice - tpDistance;
  }

  // Simulate through candles
  let exitPrice = entryPrice;
  let exitTime = entryTime;
  let exitReason = 'timeout';
  let highestPnl = 0;
  let trailStop = stopLoss;
  let trailActivated = false;

  for (const candle of futureCandles) {
    // Check for stop/TP hits within candle
    if (direction === 'long') {
      // Check stop loss
      if (candle.low <= trailStop) {
        exitPrice = trailStop;
        exitTime = candle.timestamp;
        exitReason = trailActivated ? 'trail_stop' : 'stop_loss';
        break;
      }
      // Check take profit
      if (candle.high >= takeProfit) {
        exitPrice = takeProfit;
        exitTime = candle.timestamp;
        exitReason = 'take_profit';
        break;
      }
      // Update trailing stop
      const currentPnl = ((candle.high - entryPrice) / entryPrice) * 100;
      if (currentPnl > highestPnl) {
        highestPnl = currentPnl;
        if (currentPnl > 5) {  // Activate trail after 5% gain
          trailActivated = true;
          const newTrail = candle.high * 0.97;  // 3% trail
          if (newTrail > trailStop) trailStop = newTrail;
        }
      }
    } else {
      // Short position
      if (candle.high >= trailStop) {
        exitPrice = trailStop;
        exitTime = candle.timestamp;
        exitReason = trailActivated ? 'trail_stop' : 'stop_loss';
        break;
      }
      if (candle.low <= takeProfit) {
        exitPrice = takeProfit;
        exitTime = candle.timestamp;
        exitReason = 'take_profit';
        break;
      }
      const currentPnl = ((entryPrice - candle.low) / entryPrice) * 100;
      if (currentPnl > highestPnl) {
        highestPnl = currentPnl;
        if (currentPnl > 5) {
          trailActivated = true;
          const newTrail = candle.low * 1.03;
          if (newTrail < trailStop) trailStop = newTrail;
        }
      }
    }

    // Exit after 48 hours max
    if (candle.timestamp - entryTime > 48 * 60 * 60 * 1000) {
      exitPrice = candle.close;
      exitTime = candle.timestamp;
      exitReason = 'timeout';
      break;
    }
  }

  // Calculate P&L
  let pnlPercent: number;
  if (direction === 'long') {
    pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  // Apply leverage
  const leveragedPnlPercent = pnlPercent * config.leverage;

  // Apply fees (0.1% entry + 0.1% exit = 0.2% round trip, multiplied by leverage effect)
  const feePercent = 0.2;
  const netPnlPercent = leveragedPnlPercent - feePercent;

  // Calculate dollar P&L
  const pnlDollars = config.positionSizeDollars * (netPnlPercent / 100);

  return {
    symbol: signal.symbol,
    direction,
    timeframe: signal.timeframe,
    entryPrice,
    exitPrice,
    entryTime,
    exitTime,
    pnlPercent: netPnlPercent,
    pnlDollars,
    quadrant,
    exitReason,
  };
}

function runStrategy(signals: LocalSignal[], config: StrategyConfig): { trades: Trade[]; byQuadrant: Record<string, Trade[]> } {
  const trades: Trade[] = [];
  const byQuadrant: Record<string, Trade[]> = {};

  for (const signal of signals) {
    const ts = new Date(signal.timestamp).getTime();
    const macro = getMacroRegime(signals, ts);
    const { regime: micro } = getMicroRegime(signals, ts);
    const quadrant = getQuadrant(macro, micro);

    const action = config.rules[quadrant] || 'skip';
    if (action === 'skip') continue;

    // For longs-only strategies, skip short signals
    if (!config.allowShorts && action === 'short') continue;

    // Only process signals that match the desired direction
    // For bidirectional: we determine direction from quadrant rules, not signal
    // For longs-only: only process long signals
    if (!config.allowShorts && signal.direction !== 'long') continue;

    const candles = loadCandles(signal.symbol, signal.timeframe);
    if (!candles) continue;

    const trade = simulateTrade(signal, action, config, candles, quadrant);
    if (trade) {
      trades.push(trade);
      if (!byQuadrant[quadrant]) byQuadrant[quadrant] = [];
      byQuadrant[quadrant].push(trade);
    }
  }

  return { trades, byQuadrant };
}

// ============= Main =============

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1]) : 7;

console.log('='.repeat(80));
console.log('LEVERAGED REGIME BACKTEST');
console.log('='.repeat(80));
console.log('');
console.log('Comparing spot vs leveraged strategies with regime filtering');
console.log(`Period: Last ${days} days`);
console.log('');

const signals = loadSignals(days);
console.log(`Loaded ${signals.length} triggered signals`);
console.log(`  Longs: ${signals.filter(s => s.direction === 'long').length}`);
console.log(`  Shorts: ${signals.filter(s => s.direction === 'short').length}`);
console.log('');

console.log('='.repeat(80));
console.log('RESULTS BY STRATEGY');
console.log('='.repeat(80));
console.log('');

interface StrategyResult {
  name: string;
  leverage: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  maxDrawdown: number;
  byQuadrant: Record<string, { trades: number; wins: number; pnl: number }>;
}

const results: StrategyResult[] = [];

for (const strategy of STRATEGIES) {
  const { trades, byQuadrant } = runStrategy(signals, strategy);

  const wins = trades.filter(t => t.pnlDollars > 0).length;
  const totalPnL = trades.reduce((sum, t) => sum + t.pnlDollars, 0);

  // Calculate max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let equity = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
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
    name: strategy.name,
    leverage: strategy.leverage,
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnL,
    avgPnL: trades.length > 0 ? totalPnL / trades.length : 0,
    maxDrawdown,
    byQuadrant: quadrantStats,
  });

  // Print strategy details
  const status = totalPnL > 0 ? '✅' : '❌';
  console.log(`${status} ${strategy.name} (${strategy.leverage}x)`);
  console.log(`   Trades: ${trades.length} | Win Rate: ${(trades.length > 0 ? (wins / trades.length) * 100 : 0).toFixed(1)}%`);
  console.log(`   Total P&L: $${totalPnL.toFixed(2)} | Avg: $${(trades.length > 0 ? totalPnL / trades.length : 0).toFixed(2)}`);
  console.log(`   Max Drawdown: $${maxDrawdown.toFixed(2)}`);

  if (Object.keys(quadrantStats).length > 0) {
    console.log('   By Quadrant:');
    for (const [q, stats] of Object.entries(quadrantStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const qStatus = stats.pnl > 0 ? '✅' : '❌';
      console.log(`      ${qStatus} ${q}: ${stats.trades} trades, ${((stats.wins / stats.trades) * 100).toFixed(0)}% win, $${stats.pnl.toFixed(2)}`);
    }
  }
  console.log('');
}

// ============= Summary Comparison =============

console.log('='.repeat(80));
console.log('SUMMARY COMPARISON');
console.log('='.repeat(80));
console.log('');

console.log('Strategy                          Lev   Trades  Win%     P&L      Avg    MaxDD');
console.log('-'.repeat(80));

for (const r of results.sort((a, b) => b.totalPnL - a.totalPnL)) {
  const status = r.totalPnL > 0 ? '✅' : '❌';
  console.log(
    `${status} ${r.name.padEnd(28)} ${r.leverage.toString().padStart(3)}x ` +
    `${r.trades.toString().padStart(6)}  ${r.winRate.toFixed(1).padStart(5)}%  ` +
    `$${r.totalPnL.toFixed(2).padStart(7)}  $${r.avgPnL.toFixed(2).padStart(6)}  $${r.maxDrawdown.toFixed(2).padStart(6)}`
  );
}

// ============= Recommendation =============

console.log('');
console.log('='.repeat(80));
console.log('RECOMMENDATION');
console.log('='.repeat(80));
console.log('');

const bestStrategy = results.sort((a, b) => b.totalPnL - a.totalPnL)[0];
const spotBaseline = results.find(r => r.name === 'spot-1x-longs-only');

if (bestStrategy && spotBaseline) {
  const improvement = bestStrategy.totalPnL - spotBaseline.totalPnL;
  const improvementPct = spotBaseline.totalPnL !== 0
    ? ((improvement / Math.abs(spotBaseline.totalPnL)) * 100)
    : 0;

  console.log(`🏆 BEST STRATEGY: ${bestStrategy.name}`);
  console.log(`   Total P&L: $${bestStrategy.totalPnL.toFixed(2)}`);
  console.log(`   vs Spot Baseline: ${improvement >= 0 ? '+' : ''}$${improvement.toFixed(2)} (${improvementPct >= 0 ? '+' : ''}${improvementPct.toFixed(0)}%)`);
  console.log('');

  if (bestStrategy.leverage > 1) {
    console.log('💡 LEVERAGE FINDINGS:');
    if (improvement > 0) {
      console.log('   ✅ Leverage IMPROVES returns with regime filtering');
      console.log('   ✅ Consider manual futures trading during Focus Mode');
    } else {
      console.log('   ❌ Leverage does NOT improve returns');
      console.log('   ❌ Stick with spot-only strategy');
    }
  }

  if (bestStrategy.name.includes('bidirectional') || bestStrategy.name.includes('contrarian')) {
    console.log('');
    console.log('💡 SHORTING FINDINGS:');
    const longsOnly = results.find(r => r.name === 'futures-5x-longs-only');
    if (longsOnly && bestStrategy.totalPnL > longsOnly.totalPnL) {
      console.log('   ✅ Shorts ADD value - contrarian shorts in bullish micro work');
    } else {
      console.log('   ❌ Shorts do NOT add value - stick with longs only');
    }
  }
}

console.log('');
console.log('='.repeat(80));
console.log('FOCUS MODE RECOMMENDATION');
console.log('='.repeat(80));
console.log('');

// Check if any leveraged strategy significantly outperforms
const leveragedResults = results.filter(r => r.leverage > 1 && r.totalPnL > 0);
if (leveragedResults.length > 0) {
  const best = leveragedResults[0];
  console.log('📊 For MANUAL trading during Focus Mode:');
  console.log(`   Strategy: ${best.name}`);
  console.log(`   Leverage: ${best.leverage}x`);
  console.log('');
  console.log('   Quadrant Rules:');
  const strategyConfig = STRATEGIES.find(s => s.name === best.name);
  if (strategyConfig) {
    for (const [q, action] of Object.entries(strategyConfig.rules)) {
      if (action !== 'skip') {
        const emoji = action === 'long' ? '🟢' : '🔴';
        console.log(`      ${emoji} ${q}: ${action.toUpperCase()}`);
      }
    }
  }
  console.log('');
  console.log('   ⚠️ Remember: This requires MANUAL execution on MEXC');
} else {
  console.log('❌ No leveraged strategy outperforms spot.');
  console.log('   Stick with the automated spot bot.');
}
