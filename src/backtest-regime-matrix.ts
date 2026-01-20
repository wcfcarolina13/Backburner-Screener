#!/usr/bin/env node
/**
 * REGIME MATRIX Strategy
 *
 * Your question: "Should we be always contrarian or conditionally contrarian?"
 *
 * This creates a 2x2 matrix:
 *
 *                    MICRO BULLISH          MICRO BEARISH
 * MACRO BULL    │ Traditional longs    │ Buy the dip         │
 * MACRO BEAR    │ AVOID (bull trap)    │ CONTRARIAN bounces  │
 *
 * We'll test what happens in each quadrant.
 *
 * For MACRO detection without BTC data, we use:
 * - 24-48 hour rolling signal ratio
 * - If >55% longs over 24h = macro bull
 * - If >55% shorts over 24h = macro bear
 */

import * as fs from 'fs';
import * as path from 'path';

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

interface CandleFile {
  candles: Array<{ timestamp: number; close: number; high: number; low: number }>;
}

interface Trade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  realizedPnL: number;
  timeframe: string;
  macroRegime: string;
  microRegime: string;
  quadrant: string;
}

// ============= Load Data =============

function loadSignals(startDate: string, endDate: string): LocalSignal[] {
  const signalsDir = path.join(process.cwd(), 'data', 'signals');
  const signals: LocalSignal[] = [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const filePath = path.join(signalsDir, `${dateStr}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const daySignals: LocalSignal[] = JSON.parse(content);
        for (const sig of daySignals) {
          if ((sig.state === 'triggered' || sig.state === 'deep_extreme') &&
              sig.eventType === 'triggered' && sig.entryPrice) {
            signals.push(sig);
          }
        }
      } catch { /* skip */ }
    }
    current.setDate(current.getDate() + 1);
  }

  return signals.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

function loadCandleFile(symbol: string, timeframe: string): Array<{ timestamp: number; close: number; high: number; low: number }> | null {
  const paths = [
    path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-spot.json`),
    path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-futures.json`),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const data: CandleFile = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return data.candles;
      } catch { /* continue */ }
    }
  }
  return null;
}

// ============= Regime Detection =============

type MacroRegime = 'bull' | 'bear' | 'neutral';
type MicroRegime = 'bullish' | 'bearish' | 'neutral';

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
  if (macro === 'bull' && micro === 'bullish') return 'BULL+BULL';
  if (macro === 'bull' && micro === 'bearish') return 'BULL+BEAR';
  if (macro === 'bull' && micro === 'neutral') return 'BULL+NEU';
  if (macro === 'bear' && micro === 'bullish') return 'BEAR+BULL';
  if (macro === 'bear' && micro === 'bearish') return 'BEAR+BEAR';
  if (macro === 'bear' && micro === 'neutral') return 'BEAR+NEU';
  if (macro === 'neutral' && micro === 'bullish') return 'NEU+BULL';
  if (macro === 'neutral' && micro === 'bearish') return 'NEU+BEAR';
  return 'NEU+NEU';
}

// ============= Backtest =============

function backtest(
  signals: LocalSignal[],
  filter: (macro: MacroRegime, micro: MicroRegime, shortRatio: number) => boolean,
  config: { positionSize: number; stopLoss: number; trailTrigger: number; trailStep: number }
): Trade[] {
  const trades: Trade[] = [];
  const longSignals = signals.filter(s => s.direction === 'long');

  for (const signal of longSignals) {
    const ts = new Date(signal.timestamp).getTime();
    const macro = getMacroRegime(signals, ts, 24);
    const { regime: micro, shortRatio } = getMicroRegime(signals, ts, 4);

    if (!filter(macro, micro, shortRatio)) continue;

    const candles = loadCandleFile(signal.symbol, signal.timeframe);
    if (!candles) continue;

    const entryPrice = signal.entryPrice || signal.price;
    let stopLoss = entryPrice * (1 - config.stopLoss / 100);
    let highestPrice = entryPrice;
    let trailActivated = false;
    let exitPrice = entryPrice;

    for (const candle of candles) {
      if (candle.timestamp <= ts) continue;

      if (candle.high > highestPrice) highestPrice = candle.high;

      const pnlPercent = ((candle.high - entryPrice) / entryPrice) * 100;
      if (!trailActivated && pnlPercent >= config.trailTrigger) {
        trailActivated = true;
        stopLoss = entryPrice * 1.001;
      }

      if (trailActivated) {
        const trailStop = highestPrice * (1 - config.trailStep / 100);
        if (trailStop > stopLoss) stopLoss = trailStop;
      }

      if (candle.low <= stopLoss) {
        exitPrice = stopLoss;
        break;
      }

      exitPrice = candle.close;
    }

    const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    const realizedPnL = config.positionSize * (pnlPercent / 100) - config.positionSize * 0.002;

    trades.push({
      symbol: signal.symbol,
      entryPrice,
      exitPrice,
      realizedPnL,
      timeframe: signal.timeframe,
      macroRegime: macro,
      microRegime: micro,
      quadrant: getQuadrant(macro, micro),
    });
  }

  return trades;
}

// ============= Main =============

async function main() {
  const args = process.argv.slice(2);
  let days = 7;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }

  console.log('='.repeat(80));
  console.log(`REGIME MATRIX ANALYSIS (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Testing spot long performance in each quadrant:');
  console.log('');
  console.log('                    MICRO BULLISH    MICRO NEUTRAL    MICRO BEARISH');
  console.log('  MACRO BULL    │   Trend-follow  │   Cautious     │   Buy the dip   │');
  console.log('  MACRO BEAR    │   AVOID (trap)  │   Cautious     │   CONTRARIAN    │');
  console.log('  MACRO NEUTRAL │   Trend-follow  │   Cautious     │   Contrarian    │');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);

  const signals = loadSignals(startStr, endStr);
  console.log(`\nLoaded ${signals.length} triggered signals`);

  const config = {
    positionSize: 100,
    stopLoss: 15,
    trailTrigger: 10,
    trailStep: 5,
  };

  // Baseline: all longs
  const allTrades = backtest(signals, () => true, config);
  console.log(`Total long trades simulated: ${allTrades.length}`);

  // Count by quadrant
  const quadrantStats: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const trade of allTrades) {
    if (!quadrantStats[trade.quadrant]) {
      quadrantStats[trade.quadrant] = { trades: 0, wins: 0, pnl: 0 };
    }
    quadrantStats[trade.quadrant].trades++;
    quadrantStats[trade.quadrant].pnl += trade.realizedPnL;
    if (trade.realizedPnL > 0) quadrantStats[trade.quadrant].wins++;
  }

  // Print quadrant results
  console.log('\n' + '='.repeat(80));
  console.log('PERFORMANCE BY QUADRANT');
  console.log('='.repeat(80));
  console.log('');

  console.log('Quadrant'.padEnd(15) + 'Trades'.padStart(8) + 'Wins'.padStart(6) + 'Win%'.padStart(8) + 'Avg P&L'.padStart(10) + 'Total P&L'.padStart(12));
  console.log('-'.repeat(65));

  const sortedQuadrants = Object.entries(quadrantStats).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [quadrant, stats] of sortedQuadrants) {
    const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0';
    const avgPnL = stats.trades > 0 ? stats.pnl / stats.trades : 0;
    const profit = stats.pnl >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${quadrant.padEnd(13)}` +
      stats.trades.toString().padStart(8) +
      stats.wins.toString().padStart(6) +
      `${winRate}%`.padStart(8) +
      `$${avgPnL.toFixed(2)}`.padStart(10) +
      `$${stats.pnl.toFixed(2)}`.padStart(12)
    );
  }

  // ============= Strategy Recommendations =============
  console.log('\n' + '='.repeat(80));
  console.log('STRATEGY ANALYSIS');
  console.log('='.repeat(80));

  // Find the best quadrants
  const profitableQuadrants = sortedQuadrants.filter(([_, s]) => s.pnl > 0);
  const unprofitableQuadrants = sortedQuadrants.filter(([_, s]) => s.pnl <= 0);

  if (profitableQuadrants.length > 0) {
    console.log('\n✅ PROFITABLE QUADRANTS (should trade):');
    for (const [quadrant, stats] of profitableQuadrants) {
      const winRate = (stats.wins / stats.trades * 100).toFixed(1);
      console.log(`   ${quadrant}: $${stats.pnl.toFixed(2)} (${stats.trades} trades, ${winRate}% win)`);
    }
  }

  if (unprofitableQuadrants.length > 0) {
    console.log('\n❌ UNPROFITABLE QUADRANTS (should skip):');
    for (const [quadrant, stats] of unprofitableQuadrants) {
      const winRate = (stats.wins / stats.trades * 100).toFixed(1);
      console.log(`   ${quadrant}: $${stats.pnl.toFixed(2)} (${stats.trades} trades, ${winRate}% win)`);
    }
  }

  // ============= Simulate optimal strategy =============
  console.log('\n' + '='.repeat(80));
  console.log('OPTIMAL STRATEGY SIMULATION');
  console.log('='.repeat(80));

  // Strategy 1: Only profitable quadrants
  const profitableQuadrantNames = profitableQuadrants.map(([q]) => q);
  const optimalTrades = allTrades.filter(t => profitableQuadrantNames.includes(t.quadrant));
  const optimalPnL = optimalTrades.reduce((sum, t) => sum + t.realizedPnL, 0);
  const optimalWins = optimalTrades.filter(t => t.realizedPnL > 0).length;
  const optimalWinRate = optimalTrades.length > 0 ? (optimalWins / optimalTrades.length * 100).toFixed(1) : '0';

  console.log('\n📊 OPTIMAL (only profitable quadrants):');
  console.log(`   Trades: ${optimalTrades.length} (vs ${allTrades.length} baseline)`);
  console.log(`   Win Rate: ${optimalWinRate}%`);
  console.log(`   P&L: $${optimalPnL.toFixed(2)}`);

  // Strategy 2: Pure contrarian (BEAR+BEAR and NEU+BEAR)
  const contrarianTrades = allTrades.filter(t =>
    t.quadrant === 'BEAR+BEAR' || t.quadrant === 'NEU+BEAR'
  );
  const contrarianPnL = contrarianTrades.reduce((sum, t) => sum + t.realizedPnL, 0);
  const contrarianWins = contrarianTrades.filter(t => t.realizedPnL > 0).length;
  const contrarianWinRate = contrarianTrades.length > 0 ? (contrarianWins / contrarianTrades.length * 100).toFixed(1) : '0';

  console.log('\n📊 PURE CONTRARIAN (BEAR+BEAR, NEU+BEAR):');
  console.log(`   Trades: ${contrarianTrades.length}`);
  console.log(`   Win Rate: ${contrarianWinRate}%`);
  console.log(`   P&L: $${contrarianPnL.toFixed(2)}`);

  // Strategy 3: Avoid bull traps (skip BEAR+BULL)
  const avoidTrapsTrades = allTrades.filter(t => t.quadrant !== 'BEAR+BULL');
  const avoidTrapsPnL = avoidTrapsTrades.reduce((sum, t) => sum + t.realizedPnL, 0);

  console.log('\n📊 AVOID BULL TRAPS (skip BEAR+BULL):');
  console.log(`   Trades: ${avoidTrapsTrades.length}`);
  console.log(`   P&L: $${avoidTrapsPnL.toFixed(2)}`);

  // ============= Final Recommendation =============
  console.log('\n' + '='.repeat(80));
  console.log('FINAL RECOMMENDATION');
  console.log('='.repeat(80));

  // Determine best strategy
  const strategies = [
    { name: 'Baseline (all longs)', trades: allTrades.length, pnl: allTrades.reduce((s, t) => s + t.realizedPnL, 0) },
    { name: 'Optimal quadrants', trades: optimalTrades.length, pnl: optimalPnL },
    { name: 'Pure contrarian', trades: contrarianTrades.length, pnl: contrarianPnL },
    { name: 'Avoid bull traps', trades: avoidTrapsTrades.length, pnl: avoidTrapsPnL },
  ];

  const bestStrategy = strategies.reduce((a, b) => a.pnl > b.pnl ? a : b);

  console.log(`\n🎯 BEST STRATEGY: ${bestStrategy.name}`);
  console.log(`   Expected: ${bestStrategy.trades} trades over ${days} days`);
  console.log(`   P&L: $${bestStrategy.pnl.toFixed(2)}`);

  // Answer the question: always contrarian or conditionally?
  const bearBearStats = quadrantStats['BEAR+BEAR'];
  const bullBearStats = quadrantStats['BULL+BEAR'];
  const neuBearStats = quadrantStats['NEU+BEAR'];

  console.log('\n💡 SHOULD YOU BE ALWAYS CONTRARIAN?');

  if (bearBearStats && bearBearStats.pnl > 0 && bullBearStats && bullBearStats.pnl > 0) {
    console.log('   YES - Contrarian works in BOTH macro bull and macro bear');
    console.log('   → When micro-bearish (>65% shorts), buy longs regardless of macro');
  } else if (bearBearStats && bearBearStats.pnl > 0 && bullBearStats && bullBearStats.pnl <= 0) {
    console.log('   CONDITIONAL - Contrarian only works in macro bear/neutral');
    console.log('   → Skip contrarian during macro bull (those are real pullbacks, not bounces)');
  } else if (bearBearStats && bearBearStats.pnl <= 0) {
    console.log('   NO - Contrarian did not work in this period');
    console.log('   → Consider sitting out spot trading');
  }

  console.log('\n📝 Implementation rules:');
  console.log('   1. Calculate 24h signal ratio for MACRO regime');
  console.log('   2. Calculate 4h signal ratio for MICRO regime');
  console.log('   3. Only trade in profitable quadrants');
  if (profitableQuadrants.length > 0) {
    console.log(`   4. Your profitable quadrants: ${profitableQuadrantNames.join(', ')}`);
  }
}

main().catch(console.error);
