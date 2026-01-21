#!/usr/bin/env node
/**
 * SKIP BEARISH Markets Strategy
 *
 * Core insight: If spot-only CANNOT be profitable in bearish markets,
 * then DON'T TRADE during bearish periods.
 *
 * This backtest simulates:
 * 1. Detecting market regime (bullish/bearish)
 * 2. Only trading during bullish periods
 * 3. Sitting in cash during bearish periods
 *
 * If over the past 7 days the market was 70% bearish, then we would have
 * only traded 30% of the time - and potentially been profitable in that 30%.
 */

import * as fs from 'fs';
import * as path from 'path';

interface LocalSignal {
  timestamp: string;
  eventType: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: string;
  state: string;
  rsi: number;
  price: number;
  entryPrice?: number;
}

interface Trade {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  realizedPnL: number;
  timeframe: string;
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
      } catch (e) {
        // Skip
      }
    }
    current.setDate(current.getDate() + 1);
  }

  signals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Dedupe
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
  const filePath = path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-spot.json`);
  if (!fs.existsSync(filePath)) {
    const futuresPath = path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-futures.json`);
    if (!fs.existsSync(futuresPath)) return null;
    try {
      const data: CandleFile = JSON.parse(fs.readFileSync(futuresPath, 'utf-8'));
      return data.candles;
    } catch {
      return null;
    }
  }
  try {
    const data: CandleFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.candles;
  } catch {
    return null;
  }
}

// ============= Market Regime Detection =============

interface MarketRegime {
  timestamp: number;
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number;  // 0-1
  longSignalRatio: number;
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
    let confidence = 0;
    let longRatio = 0.5;

    if (total >= 3) {
      longRatio = longs / total;

      // Stricter thresholds for regime
      if (longRatio > 0.65) {
        regime = 'bullish';
        confidence = (longRatio - 0.5) * 2;  // 0.65 → 0.3, 0.8 → 0.6, 1.0 → 1.0
      } else if (longRatio < 0.35) {
        regime = 'bearish';
        confidence = (0.5 - longRatio) * 2;
      } else {
        regime = 'neutral';
        confidence = 1 - Math.abs(longRatio - 0.5) * 2;
      }
    }

    regimeMap.set(ts, {
      timestamp: ts,
      regime,
      confidence,
      longSignalRatio: longRatio,
    });
  }

  return regimeMap;
}

// ============= Simple Backtest =============

interface BacktestResult {
  trades: Trade[];
  totalPnL: number;
  winRate: number;
  tradeCount: number;
  avgPnL: number;
}

function runSimpleBacktest(
  signals: LocalSignal[],
  filter: (signal: LocalSignal, regime: MarketRegime | undefined) => boolean,
  regimeMap: Map<number, MarketRegime>,
  config: { positionSize: number; stopLoss: number; trailTrigger: number; trailStep: number }
): BacktestResult {
  const trades: Trade[] = [];
  const positions = new Map<string, { signal: LocalSignal; highestPrice: number; stopLoss: number; trailActivated: boolean }>();

  // Only process long signals
  const longSignals = signals.filter(s => s.direction === 'long');

  for (const signal of longSignals) {
    const ts = new Date(signal.timestamp).getTime();
    const regime = regimeMap.get(ts);

    // Apply filter
    if (!filter(signal, regime)) continue;

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (positions.has(posKey)) continue;

    const entryPrice = signal.entryPrice || signal.price;
    const initialStop = entryPrice * (1 - config.stopLoss / 100);

    positions.set(posKey, {
      signal,
      highestPrice: entryPrice,
      stopLoss: initialStop,
      trailActivated: false,
    });

    // Simulate price movement
    const candles = loadCandleFile(signal.symbol, signal.timeframe);
    if (!candles) {
      positions.delete(posKey);
      continue;
    }

    let exitPrice = entryPrice;
    let exitTime = ts;
    let closed = false;

    for (const candle of candles) {
      if (candle.timestamp <= ts) continue;

      const pos = positions.get(posKey)!;

      // Update highest price
      if (candle.high > pos.highestPrice) {
        pos.highestPrice = candle.high;
      }

      // Check for trail activation
      const pnlPercent = ((candle.high - entryPrice) / entryPrice) * 100;
      if (!pos.trailActivated && pnlPercent >= config.trailTrigger) {
        pos.trailActivated = true;
        pos.stopLoss = entryPrice * 1.001;  // Lock breakeven
      }

      // Update trailing stop
      if (pos.trailActivated) {
        const trailStop = pos.highestPrice * (1 - config.trailStep / 100);
        if (trailStop > pos.stopLoss) {
          pos.stopLoss = trailStop;
        }
      }

      // Check stop hit
      if (candle.low <= pos.stopLoss) {
        exitPrice = pos.stopLoss;
        exitTime = candle.timestamp;
        closed = true;
        break;
      }
    }

    if (!closed) {
      // Use last candle close
      const lastCandle = candles[candles.length - 1];
      if (lastCandle) {
        exitPrice = lastCandle.close;
        exitTime = lastCandle.timestamp;
      }
    }

    positions.delete(posKey);

    const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    const realizedPnL = config.positionSize * (pnlPercent / 100) - config.positionSize * 0.002;  // 0.2% fees

    trades.push({
      symbol: signal.symbol,
      entryPrice,
      entryTime: ts,
      exitPrice,
      exitTime,
      realizedPnL,
      timeframe: signal.timeframe,
      marketRegime: regime?.regime || 'unknown',
    });
  }

  const wins = trades.filter(t => t.realizedPnL > 0);
  const totalPnL = trades.reduce((sum, t) => sum + t.realizedPnL, 0);

  return {
    trades,
    totalPnL,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    tradeCount: trades.length,
    avgPnL: trades.length > 0 ? totalPnL / trades.length : 0,
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
  console.log(`MARKET REGIME FILTERING (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Strategy: Only trade during BULLISH market regime, skip bearish periods.');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);

  // Load signals
  console.log('\nLoading signals...');
  const signals = loadSignalsFromFiles(startStr, endStr);
  console.log(`Found ${signals.length} triggered signals`);

  const longSignals = signals.filter(s => s.direction === 'long');
  const shortSignals = signals.filter(s => s.direction === 'short');
  console.log(`  Long: ${longSignals.length}, Short: ${shortSignals.length}`);

  // Detect market regime
  console.log('\nDetecting market regime...');
  const regimeMap = detectMarketRegime(signals, 4);

  // Count regime distribution
  let bullishCount = 0, bearishCount = 0, neutralCount = 0;
  for (const regime of regimeMap.values()) {
    if (regime.regime === 'bullish') bullishCount++;
    else if (regime.regime === 'bearish') bearishCount++;
    else neutralCount++;
  }
  const totalRegime = bullishCount + bearishCount + neutralCount;

  console.log(`  Bullish periods: ${bullishCount} (${(bullishCount / totalRegime * 100).toFixed(1)}%)`);
  console.log(`  Bearish periods: ${bearishCount} (${(bearishCount / totalRegime * 100).toFixed(1)}%)`);
  console.log(`  Neutral periods: ${neutralCount} (${(neutralCount / totalRegime * 100).toFixed(1)}%)`);

  const config = {
    positionSize: 100,
    stopLoss: 15,
    trailTrigger: 10,
    trailStep: 5,
  };

  console.log('\nRunning backtests...');

  // Strategy 1: Trade all longs (baseline)
  const allLongs = runSimpleBacktest(
    signals,
    () => true,  // No filter
    regimeMap,
    config
  );

  // Strategy 2: Only trade in bullish regime
  const bullishOnly = runSimpleBacktest(
    signals,
    (_, regime) => regime?.regime === 'bullish',
    regimeMap,
    config
  );

  // Strategy 3: Trade in bullish + neutral (skip bearish)
  const skipBearish = runSimpleBacktest(
    signals,
    (_, regime) => regime?.regime !== 'bearish',
    regimeMap,
    config
  );

  // Strategy 4: Only high-confidence bullish
  const highConfBullish = runSimpleBacktest(
    signals,
    (_, regime) => regime?.regime === 'bullish' && regime.confidence > 0.3,
    regimeMap,
    config
  );

  // Results
  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(30) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'Avg P&L'.padStart(10) + 'Total P&L'.padStart(12);
  console.log(header);
  console.log('-'.repeat(70));

  const strategies = [
    { name: 'All Longs (baseline)', result: allLongs },
    { name: 'Bullish Only', result: bullishOnly },
    { name: 'Skip Bearish (bull+neutral)', result: skipBearish },
    { name: 'High-Conf Bullish Only', result: highConfBullish },
  ];

  for (const s of strategies) {
    const profit = s.result.totalPnL >= 0 ? '✅' : '❌';
    const row = `${profit} ${s.name.padEnd(28)}` +
      s.result.tradeCount.toString().padStart(8) +
      `${s.result.winRate.toFixed(1)}%`.padStart(8) +
      `$${s.result.avgPnL.toFixed(2)}`.padStart(10) +
      `$${s.result.totalPnL.toFixed(2)}`.padStart(12);
    console.log(row);
  }

  console.log('-'.repeat(70));

  // Analysis
  console.log('');
  console.log('='.repeat(80));
  console.log('ANALYSIS');
  console.log('='.repeat(80));

  const improvement = bullishOnly.totalPnL - allLongs.totalPnL;
  console.log(`\nBaseline (all longs): $${allLongs.totalPnL.toFixed(2)} over ${allLongs.tradeCount} trades`);
  console.log(`Bullish only:         $${bullishOnly.totalPnL.toFixed(2)} over ${bullishOnly.tradeCount} trades`);
  console.log(`Improvement:          $${improvement.toFixed(2)}`);

  // Per-regime analysis
  console.log('\n📊 Trade Performance by Regime:');
  console.log('-'.repeat(50));

  const byRegime: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const trade of allLongs.trades) {
    const regime = trade.marketRegime;
    if (!byRegime[regime]) byRegime[regime] = { trades: 0, pnl: 0, wins: 0 };
    byRegime[regime].trades++;
    byRegime[regime].pnl += trade.realizedPnL;
    if (trade.realizedPnL > 0) byRegime[regime].wins++;
  }

  for (const [regime, data] of Object.entries(byRegime)) {
    const winRate = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0';
    const avgPnL = data.trades > 0 ? (data.pnl / data.trades).toFixed(2) : '0';
    const profit = data.pnl >= 0 ? '✅' : '❌';
    console.log(`  ${profit} ${regime.padEnd(10)} ${data.trades.toString().padStart(4)} trades, ${winRate}% win, avg $${avgPnL}, total $${data.pnl.toFixed(2)}`);
  }

  // Recommendation
  console.log('');
  console.log('='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  const bullishData = byRegime['bullish'];
  const bearishData = byRegime['bearish'];

  if (bullishData && bearishData) {
    if (bullishData.pnl > 0 && bearishData.pnl < 0) {
      console.log('\n✅ REGIME FILTERING WORKS!');
      console.log('   - Bullish regime trades were PROFITABLE');
      console.log('   - Bearish regime trades LOST money');
      console.log('   - Only trading in bullish periods would have been profitable!');
    } else if (bullishData.pnl > bearishData.pnl) {
      console.log('\n⚠️ Regime filtering HELPS but not perfect');
      console.log(`   - Bullish trades: $${bullishData.pnl.toFixed(2)}`);
      console.log(`   - Bearish trades: $${bearishData.pnl.toFixed(2)}`);
    } else {
      console.log('\n❌ Even bullish regime trades lost money');
      console.log('   This was an exceptionally bearish period');
      console.log('   Consider: sitting out entirely until conditions improve');
    }
  }

  console.log('\n💡 For live spot trading:');
  console.log('   1. Implement regime detection (long/short signal ratio)');
  console.log('   2. Only take long trades when ratio > 65% longs');
  console.log('   3. Sit in cash when market is bearish');
  console.log('   4. This may mean NOT trading for days during bear markets');
}

main().catch(console.error);
