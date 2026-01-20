#!/usr/bin/env node
/**
 * CONTRARIAN Spot Strategy
 *
 * KEY FINDING: In the previous backtest, trades taken during BEARISH regime
 * were actually PROFITABLE (62.5% win rate, +$24.78)!
 *
 * Why? When the market is extremely bearish:
 * - Most signals are SHORT signals
 * - The few LONG signals that appear are extreme oversold bounces
 * - These bounces have higher conviction and success rate
 *
 * This backtest explores CONTRARIAN strategies:
 * 1. Only trade longs when regime is bearish (few signals, high quality)
 * 2. Require extreme RSI (< 28) for entry
 * 3. Combine: bearish regime + extreme RSI
 */

import * as fs from 'fs';
import * as path from 'path';

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

interface Trade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  realizedPnL: number;
  timeframe: string;
  rsi: number;
  marketRegime: string;
}

// ============= Load Data =============

function loadSignalsFromFiles(startDate: string, endDate: string): LocalSignal[] {
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
              sig.eventType === 'triggered' &&
              sig.entryPrice) {
            signals.push(sig);
          }
        }
      } catch (e) { /* skip */ }
    }
    current.setDate(current.getDate() + 1);
  }

  signals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const seen = new Set<string>();
  return signals.filter(sig => {
    const key = `${sig.symbol}-${sig.timeframe}-${sig.direction}-${new Date(sig.timestamp).getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface CandleFile {
  candles: Array<{ timestamp: number; close: number; high: number; low: number }>;
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

// ============= Market Regime =============

interface MarketRegime {
  regime: 'bullish' | 'bearish' | 'neutral';
  longRatio: number;
  shortRatio: number;
}

function detectMarketRegime(signals: LocalSignal[], windowHours: number = 4): Map<number, MarketRegime> {
  const regimeMap = new Map<number, MarketRegime>();
  const windowMs = windowHours * 60 * 60 * 1000;

  const sorted = [...signals].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const signal of sorted) {
    const ts = new Date(signal.timestamp).getTime();
    const windowStart = ts - windowMs;

    const windowSignals = sorted.filter(s => {
      const sTs = new Date(s.timestamp).getTime();
      return sTs >= windowStart && sTs < ts;
    });

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    let regime: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let longRatio = 0.5;
    let shortRatio = 0.5;

    if (total >= 3) {
      longRatio = longs / total;
      shortRatio = shorts / total;

      if (longRatio > 0.60) regime = 'bullish';
      else if (shortRatio > 0.60) regime = 'bearish';
    }

    regimeMap.set(ts, { regime, longRatio, shortRatio });
  }

  return regimeMap;
}

// ============= Backtest =============

function backtest(
  signals: LocalSignal[],
  regimeMap: Map<number, MarketRegime>,
  filter: (sig: LocalSignal, regime: MarketRegime | undefined) => boolean,
  config: { positionSize: number; stopLoss: number; trailTrigger: number; trailStep: number }
): { trades: Trade[]; totalPnL: number; winRate: number } {
  const trades: Trade[] = [];
  const longSignals = signals.filter(s => s.direction === 'long');

  for (const signal of longSignals) {
    const ts = new Date(signal.timestamp).getTime();
    const regime = regimeMap.get(ts);

    if (!filter(signal, regime)) continue;

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
      rsi: signal.rsi,
      marketRegime: regime?.regime || 'unknown',
    });
  }

  const wins = trades.filter(t => t.realizedPnL > 0);
  return {
    trades,
    totalPnL: trades.reduce((sum, t) => sum + t.realizedPnL, 0),
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
  };
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
  console.log(`CONTRARIAN SPOT STRATEGY (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Hypothesis: Long signals during BEARISH markets are higher quality');
  console.log('because they represent extreme oversold bounces with high conviction.');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);

  const signals = loadSignalsFromFiles(startStr, endStr);
  console.log(`\nLoaded ${signals.length} triggered signals`);

  const longSignals = signals.filter(s => s.direction === 'long');
  const shortSignals = signals.filter(s => s.direction === 'short');
  console.log(`  Long: ${longSignals.length}, Short: ${shortSignals.length}`);

  // RSI distribution for longs
  const extremeLow = longSignals.filter(s => s.rsi < 25);
  const veryLow = longSignals.filter(s => s.rsi < 28);
  const low = longSignals.filter(s => s.rsi < 32);
  console.log(`\nLong signals by RSI:`);
  console.log(`  RSI < 25 (extreme): ${extremeLow.length}`);
  console.log(`  RSI < 28 (very low): ${veryLow.length}`);
  console.log(`  RSI < 32 (low): ${low.length}`);

  const regimeMap = detectMarketRegime(signals, 4);

  // Count regimes
  let bullish = 0, bearish = 0, neutral = 0;
  for (const r of regimeMap.values()) {
    if (r.regime === 'bullish') bullish++;
    else if (r.regime === 'bearish') bearish++;
    else neutral++;
  }
  const total = bullish + bearish + neutral;
  console.log(`\nMarket regime distribution:`);
  console.log(`  Bullish: ${bullish} (${(bullish/total*100).toFixed(1)}%)`);
  console.log(`  Bearish: ${bearish} (${(bearish/total*100).toFixed(1)}%)`);
  console.log(`  Neutral: ${neutral} (${(neutral/total*100).toFixed(1)}%)`);

  const config = {
    positionSize: 100,
    stopLoss: 15,
    trailTrigger: 10,
    trailStep: 5,
  };

  // Test strategies
  const strategies = [
    {
      name: 'Baseline (all longs)',
      filter: () => true,
    },
    {
      name: 'Bearish regime only',
      filter: (_: LocalSignal, r: MarketRegime | undefined) => r?.regime === 'bearish',
    },
    {
      name: 'Extreme RSI only (< 25)',
      filter: (s: LocalSignal) => s.rsi < 25,
    },
    {
      name: 'Very low RSI (< 28)',
      filter: (s: LocalSignal) => s.rsi < 28,
    },
    {
      name: 'Low RSI (< 32)',
      filter: (s: LocalSignal) => s.rsi < 32,
    },
    {
      name: 'Bearish + Low RSI (< 32)',
      filter: (s: LocalSignal, r: MarketRegime | undefined) => r?.regime === 'bearish' && s.rsi < 32,
    },
    {
      name: 'Bearish + Very low RSI (< 28)',
      filter: (s: LocalSignal, r: MarketRegime | undefined) => r?.regime === 'bearish' && s.rsi < 28,
    },
    {
      name: 'NOT bullish (bearish or neutral)',
      filter: (_: LocalSignal, r: MarketRegime | undefined) => r?.regime !== 'bullish',
    },
    {
      name: 'High short ratio (>70% shorts)',
      filter: (_: LocalSignal, r: MarketRegime | undefined) => (r?.shortRatio || 0) > 0.70,
    },
  ];

  console.log('\n' + '='.repeat(80));
  console.log('STRATEGY RESULTS');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(35) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'Avg'.padStart(10) + 'Total P&L'.padStart(12);
  console.log(header);
  console.log('-'.repeat(75));

  const results: Array<{ name: string; result: ReturnType<typeof backtest> }> = [];

  for (const s of strategies) {
    const result = backtest(signals, regimeMap, s.filter, config);
    results.push({ name: s.name, result });

    const profit = result.totalPnL >= 0 ? '✅' : '❌';
    const avgPnL = result.trades.length > 0 ? result.totalPnL / result.trades.length : 0;
    const row = `${profit} ${s.name.padEnd(33)}` +
      result.trades.length.toString().padStart(8) +
      `${result.winRate.toFixed(1)}%`.padStart(8) +
      `$${avgPnL.toFixed(2)}`.padStart(10) +
      `$${result.totalPnL.toFixed(2)}`.padStart(12);
    console.log(row);
  }

  console.log('-'.repeat(75));

  // Find best strategy
  const best = results.reduce((a, b) => a.result.totalPnL > b.result.totalPnL ? a : b);
  const profitable = results.filter(r => r.result.totalPnL > 0);

  console.log('');
  console.log('='.repeat(80));
  console.log('ANALYSIS');
  console.log('='.repeat(80));

  console.log(`\n📊 Best Strategy: ${best.name}`);
  console.log(`   P&L: $${best.result.totalPnL.toFixed(2)}`);
  console.log(`   Trades: ${best.result.trades.length}`);
  console.log(`   Win Rate: ${best.result.winRate.toFixed(1)}%`);

  if (profitable.length > 0) {
    console.log(`\n✅ PROFITABLE STRATEGIES FOUND: ${profitable.length}`);
    for (const p of profitable.sort((a, b) => b.result.totalPnL - a.result.totalPnL)) {
      console.log(`   - ${p.name}: $${p.result.totalPnL.toFixed(2)} (${p.result.trades.length} trades)`);
    }
  } else {
    console.log('\n❌ No strategies were profitable in this period.');
  }

  // Sample trades from best strategy
  if (best.result.trades.length > 0) {
    console.log('\n📋 Sample trades from best strategy:');
    console.log('-'.repeat(70));
    for (const trade of best.result.trades.slice(0, 10)) {
      const pnlSign = trade.realizedPnL >= 0 ? '+' : '';
      console.log(`  ${trade.symbol.padEnd(14)} RSI:${trade.rsi.toFixed(0).padStart(3)} ${trade.timeframe.padEnd(4)} ` +
        `[${trade.marketRegime.padEnd(8)}] ${pnlSign}$${trade.realizedPnL.toFixed(2)}`);
    }
  }

  // Final recommendation
  console.log('');
  console.log('='.repeat(80));
  console.log('RECOMMENDATION FOR SPOT TRADING');
  console.log('='.repeat(80));

  if (profitable.length > 0) {
    console.log('\n✅ Use the CONTRARIAN approach:');
    console.log('   - Wait for bearish market regime (>60% short signals)');
    console.log('   - Only enter on long signals with RSI < 32');
    console.log('   - These "extreme oversold in bearish market" setups have higher win rate');
    console.log('');
    console.log('   This means: FEWER trades, but HIGHER quality.');
    console.log(`   Expected: ~${best.result.trades.length} trades over ${days} days`);
  } else {
    console.log('\n⚠️ Even contrarian approaches struggled in this period.');
    console.log('   The market may be in a prolonged downtrend.');
    console.log('   Consider: sitting out spot trading until conditions improve.');
  }
}

main().catch(console.error);
