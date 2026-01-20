#!/usr/bin/env node
/**
 * Counter-Trend / Mean Reversion Strategy for Spot
 *
 * The problem: In bearish markets, traditional long signals lose money.
 *
 * The solution: Instead of buying when RSI is oversold (traditional),
 * BUY when RSI bounces FROM oversold (confirmation of reversal).
 *
 * Strategies tested:
 * 1. Traditional: Buy when RSI enters oversold zone (23.6-38.2)
 * 2. Bounce: Buy when RSI EXITS oversold zone (crosses above 38.2)
 * 3. Extreme Bounce: Buy when RSI exits deep oversold (<25) and crosses above 30
 * 4. Fade Shorts: When we get a SHORT signal, that's actually a good time to BUY
 *    (catching the bounce after overbought conditions)
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

interface Position {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  highestPrice: number;
  trailActivated: boolean;
  level1Locked: boolean;
  timeframe: string;
  rsi: number;
  strategy: string;
}

interface Trade {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnL: number;
  realizedPnLPercent: number;
  timeframe: string;
  strategy: string;
}

interface BacktestConfig {
  positionSizeDollars: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  initialBalance: number;
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
  const deduped: LocalSignal[] = [];
  for (const sig of signals) {
    const key = `${sig.symbol}-${sig.timeframe}-${sig.direction}-${new Date(sig.timestamp).getTime()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(sig);
    }
  }

  return deduped;
}

interface CandleFile {
  symbol: string;
  timeframe: string;
  marketType: string;
  candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
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

// ============= Backtest Engine =============

class StrategyBacktester {
  private config: BacktestConfig;
  private balance: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
  }

  openPosition(signal: LocalSignal, strategy: string): Position | null {
    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (this.positions.has(posKey)) return null;

    const entryPrice = signal.entryPrice || signal.price;
    const stopDistance = entryPrice * (this.config.initialStopLossPercent / 100);
    const stopLoss = entryPrice - stopDistance;  // Always long

    const position: Position = {
      symbol: signal.symbol,
      entryPrice,
      entryTime: new Date(signal.timestamp).getTime(),
      stopLoss,
      highestPrice: entryPrice,
      trailActivated: false,
      level1Locked: false,
      timeframe: signal.timeframe,
      rsi: signal.rsi,
      strategy,
    };

    this.positions.set(posKey, position);
    return position;
  }

  updatePositionPrice(posKey: string, price: number, timestamp: number): Trade | null {
    const position = this.positions.get(posKey);
    if (!position) return null;

    if (price > position.highestPrice) position.highestPrice = price;

    const pnlPercent = ((price - position.entryPrice) / position.entryPrice) * 100;

    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = position.entryPrice * 1.001;
    }

    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    if (position.trailActivated) {
      const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
      if (trailStop > position.stopLoss) position.stopLoss = trailStop;
    }

    if (price <= position.stopLoss) {
      const exitReason = position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
      return this.closePosition(posKey, price, timestamp, exitReason);
    }

    return null;
  }

  closePosition(posKey: string, exitPrice: number, exitTime: number, reason: string): Trade | null {
    const position = this.positions.get(posKey);
    if (!position) return null;

    this.positions.delete(posKey);

    const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const realizedPnL = this.config.positionSizeDollars * (pnlPercent / 100);

    const feePercent = 0.2;
    const fees = this.config.positionSizeDollars * (feePercent / 100);
    const netPnL = realizedPnL - fees;

    this.balance += netPnL;

    const trade: Trade = {
      symbol: position.symbol,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      exitPrice,
      exitTime,
      exitReason: reason,
      realizedPnL: netPnL,
      realizedPnLPercent: (netPnL / this.config.positionSizeDollars) * 100,
      timeframe: position.timeframe,
      strategy: position.strategy,
    };

    this.trades.push(trade);
    return trade;
  }

  closeAllPositions(timestamp: number, lastPrices: Map<string, number>): void {
    for (const [posKey, position] of this.positions) {
      const price = lastPrices.get(position.symbol) || position.entryPrice;
      this.closePosition(posKey, price, timestamp, 'end_of_backtest');
    }
  }

  getPositions(): Map<string, Position> {
    return this.positions;
  }

  getTrades(): Trade[] {
    return this.trades;
  }

  getStats() {
    const trades = this.trades;
    const wins = trades.filter(t => t.realizedPnL > 0);
    const losses = trades.filter(t => t.realizedPnL <= 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.realizedPnL, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnL, 0));

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
      totalPnL: totalPnL.toFixed(2),
      avgWin: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0',
      avgLoss: losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0',
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Inf' : '0'),
      finalBalance: this.balance.toFixed(2),
    };
  }
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
  console.log(`ALTERNATIVE SPOT STRATEGIES (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Testing different entry logic for BEARISH market conditions:');
  console.log('');
  console.log('1. Traditional:   Buy on LONG signals (RSI oversold)');
  console.log('2. Fade Shorts:   Buy on SHORT signals (mean reversion after overbought)');
  console.log('3. Deep Only:     Buy only on LONG signals with RSI < 25 (extreme oversold)');
  console.log('4. Conservative:  Buy on LONG signals only in 15m/1h timeframes');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Load signals
  console.log('Loading signals...');
  const allSignals = loadSignalsFromFiles(startStr, endStr);
  console.log(`Found ${allSignals.length} triggered signals`);

  const longSignals = allSignals.filter(s => s.direction === 'long');
  const shortSignals = allSignals.filter(s => s.direction === 'short');
  console.log(`  Long: ${longSignals.length}, Short: ${shortSignals.length}`);

  // Further categorize
  const deepOversold = longSignals.filter(s => s.rsi < 25);
  const conservativeLong = longSignals.filter(s => s.timeframe === '15m' || s.timeframe === '1h' || s.timeframe === '4h');

  console.log(`  Deep oversold (RSI<25): ${deepOversold.length}`);
  console.log(`  Conservative (15m/1h/4h): ${conservativeLong.length}`);
  console.log('');

  const baseConfig = {
    positionSizeDollars: 100,
    initialStopLossPercent: 15,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    level1LockPercent: 2,
    initialBalance: 2000,
  };

  // Define strategies
  const strategies = [
    { name: 'Traditional (Buy Longs)', signals: longSignals, label: 'traditional' },
    { name: 'Fade Shorts (Buy on Short signals)', signals: shortSignals, label: 'fade_shorts' },
    { name: 'Deep Only (RSI < 25)', signals: deepOversold, label: 'deep_only' },
    { name: 'Conservative (15m/1h/4h)', signals: conservativeLong, label: 'conservative' },
  ];

  const results: Array<{
    name: string;
    stats: ReturnType<StrategyBacktester['getStats']>;
    trades: Trade[];
    signalCount: number;
  }> = [];

  for (const strategy of strategies) {
    console.log(`Running ${strategy.name}...`);

    const backtester = new StrategyBacktester(baseConfig);
    let processed = 0;

    for (const signal of strategy.signals) {
      const position = backtester.openPosition(signal, strategy.label);
      if (!position) continue;
      processed++;

      const candles = loadCandleFile(signal.symbol, signal.timeframe);
      if (!candles) continue;

      const posKey = `${signal.symbol}-${signal.timeframe}`;
      const entryTime = new Date(signal.timestamp).getTime();

      for (const candle of candles) {
        if (candle.timestamp <= entryTime) continue;

        backtester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;

        backtester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;

        backtester.updatePositionPrice(posKey, candle.close, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;
      }
    }

    // Close remaining
    const lastPrices = new Map<string, number>();
    for (const sig of strategy.signals) {
      lastPrices.set(sig.symbol, sig.price);
    }
    backtester.closeAllPositions(Date.now(), lastPrices);

    console.log(`  Processed ${processed} positions`);

    results.push({
      name: strategy.name,
      stats: backtester.getStats(),
      trades: backtester.getTrades(),
      signalCount: strategy.signals.length,
    });
  }

  // Print comparison
  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(35) + 'Signals'.padStart(10) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'PF'.padStart(8) + 'P&L'.padStart(12);
  console.log(header);
  console.log('-'.repeat(85));

  for (const result of results) {
    const s = result.stats;
    const profit = parseFloat(s.totalPnL) >= 0 ? '✅' : '❌';
    const row = `${profit} ${result.name.padEnd(33)}` +
      result.signalCount.toString().padStart(10) +
      s.totalTrades.toString().padStart(8) +
      `${s.winRate}%`.padStart(8) +
      s.profitFactor.padStart(8) +
      `$${s.totalPnL}`.padStart(12);
    console.log(row);
  }
  console.log('-'.repeat(85));

  // Best strategy
  const bestResult = results.reduce((best, r) =>
    parseFloat(r.stats.totalPnL) > parseFloat(best.stats.totalPnL) ? r : best
  );

  console.log('');
  console.log('='.repeat(80));
  console.log('KEY INSIGHT');
  console.log('='.repeat(80));

  const bestPnL = parseFloat(bestResult.stats.totalPnL);
  console.log(`\n📊 Best Strategy: ${bestResult.name}`);
  console.log(`   P&L: $${bestPnL.toFixed(2)} | Win Rate: ${bestResult.stats.winRate}%`);

  if (bestPnL > 0) {
    console.log('\n✅ FOUND A PROFITABLE STRATEGY!');
  } else {
    console.log('\n⚠️ No strategy was profitable, but some lost less than others.');
  }

  // Sample trades from best strategy
  if (bestResult.trades.length > 0) {
    console.log('\n📋 Sample trades:');
    console.log('-'.repeat(80));
    for (const trade of bestResult.trades.slice(0, 10)) {
      const date = new Date(trade.entryTime).toISOString().split('T')[0];
      const pnlSign = trade.realizedPnL >= 0 ? '+' : '';
      console.log(`  ${date} ${trade.symbol.padEnd(14)} ${trade.timeframe.padEnd(4)} ` +
        `${pnlSign}$${trade.realizedPnL.toFixed(2).padStart(8)} (${trade.exitReason})`);
    }
  }

  // Recommendation
  console.log('');
  console.log('='.repeat(80));
  console.log('RECOMMENDATIONS FOR BEARISH MARKETS');
  console.log('='.repeat(80));

  const fadeResult = results.find(r => r.name.includes('Fade'));
  const traditionalResult = results.find(r => r.name.includes('Traditional'));

  if (fadeResult && traditionalResult) {
    const fadePnL = parseFloat(fadeResult.stats.totalPnL);
    const tradPnL = parseFloat(traditionalResult.stats.totalPnL);

    if (fadePnL > tradPnL) {
      console.log('\n🔄 FADE SHORTS OUTPERFORMED TRADITIONAL');
      console.log('   In bearish markets, buying after overbought (SHORT signals)');
      console.log('   works better than buying on oversold (LONG signals).');
      console.log('');
      console.log('   Why? When market is trending down:');
      console.log('   - Oversold bounces are weak and fail');
      console.log('   - Overbought conditions lead to bigger corrections = better entries');
    }
  }

  console.log('\n💡 ADDITIONAL IDEAS TO EXPLORE:');
  console.log('   1. Wait for RSI to EXIT extreme zones (confirmation)');
  console.log('   2. Add volume filter (only trade when volume spikes)');
  console.log('   3. Use wider stops in bearish markets (15% → 20%)');
  console.log('   4. Scale in: enter 50% now, 50% if it drops 5% more');
  console.log('   5. Consider inverse ETFs or stablecoins during bear markets');
}

main().catch(console.error);
