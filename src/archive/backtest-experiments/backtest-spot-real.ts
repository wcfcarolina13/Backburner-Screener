#!/usr/bin/env node
/**
 * REAL Spot-Only Backtest
 *
 * Takes the ACTUAL triggered signals from the past N days
 * and simulates how they would have performed if:
 * 1. We only took LONG positions (spot can't short)
 * 2. We used 1x leverage (spot = no leverage)
 *
 * This uses REAL candle data to simulate price movements and exits.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Candle, Timeframe } from './types.js';

// ============= Types =============

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
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;  // In base currency units
  dollarValue: number;   // Dollar value of position
  stopLoss: number;
  highestPrice: number;
  trailActivated: boolean;
  level1Locked: boolean;
  timeframe: string;
  rsi: number;
}

interface Trade {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnL: number;
  realizedPnLPercent: number;
  timeframe: string;
  leverage: number;
}

interface BacktestConfig {
  leverage: number;
  positionSizeDollars: number;  // Fixed dollar amount per trade
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  initialBalance: number;
  longOnly: boolean;
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

        // Only include triggered signals with entryPrice
        for (const sig of daySignals) {
          if ((sig.state === 'triggered' || sig.state === 'deep_extreme') &&
              sig.eventType === 'triggered' &&
              sig.entryPrice) {
            signals.push(sig);
          }
        }
      } catch (e) {
        console.log(`Warning: Could not parse ${filePath}`);
      }
    }

    current.setDate(current.getDate() + 1);
  }

  // Sort by timestamp and dedupe by symbol+timeframe+direction (keep first)
  signals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
  candles: Candle[];
}

function loadCandleFile(symbol: string, timeframe: string): Candle[] | null {
  const filePath = path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-spot.json`);
  if (!fs.existsSync(filePath)) {
    // Try futures
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

class SpotBacktester {
  private config: BacktestConfig;
  private balance: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private initialBalance: number;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.initialBalance = config.initialBalance;
  }

  openPosition(signal: LocalSignal): Position | null {
    // Skip shorts if long-only mode
    if (this.config.longOnly && signal.direction === 'short') {
      return null;
    }

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (this.positions.has(posKey)) {
      return null;  // Already have position in this symbol/timeframe
    }

    const entryPrice = signal.entryPrice || signal.price;
    const dollarValue = this.config.positionSizeDollars * this.config.leverage;
    const positionSize = dollarValue / entryPrice;

    const stopDistance = entryPrice * (this.config.initialStopLossPercent / 100);
    const stopLoss = signal.direction === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    const position: Position = {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice,
      entryTime: new Date(signal.timestamp).getTime(),
      positionSize,
      dollarValue,
      stopLoss,
      highestPrice: entryPrice,
      trailActivated: false,
      level1Locked: false,
      timeframe: signal.timeframe,
      rsi: signal.rsi,
    };

    this.positions.set(posKey, position);
    return position;
  }

  updatePositionPrice(posKey: string, price: number, timestamp: number): Trade | null {
    const position = this.positions.get(posKey);
    if (!position) return null;

    if (price > position.highestPrice) position.highestPrice = price;

    const direction = position.direction;
    const entryPrice = position.entryPrice;

    // Calculate current P&L percent
    const pnlPercent = direction === 'long'
      ? ((price - entryPrice) / entryPrice) * 100
      : ((entryPrice - price) / entryPrice) * 100;

    // Level 1 lock (breakeven) - happens after config.level1LockPercent gain
    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = entryPrice * 1.001;  // Lock at slight profit
    }

    // Trail activation
    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    // Update trailing stop
    if (position.trailActivated && direction === 'long') {
      const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
      if (trailStop > position.stopLoss) {
        position.stopLoss = trailStop;
      }
    }

    // Check stop loss
    let exitReason: string | null = null;
    if (direction === 'long' && price <= position.stopLoss) {
      exitReason = position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
    } else if (direction === 'short' && price >= position.stopLoss) {
      exitReason = position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
    }

    if (exitReason) {
      return this.closePosition(posKey, price, timestamp, exitReason);
    }

    return null;
  }

  closePosition(posKey: string, exitPrice: number, exitTime: number, reason: string): Trade | null {
    const position = this.positions.get(posKey);
    if (!position) return null;

    this.positions.delete(posKey);

    const direction = position.direction;
    const entryPrice = position.entryPrice;

    // Calculate P&L
    let pnlPercent: number;
    if (direction === 'long') {
      pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    } else {
      pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    }

    // Apply leverage to P&L
    const leveragedPnlPercent = pnlPercent * this.config.leverage;
    const realizedPnL = this.config.positionSizeDollars * (leveragedPnlPercent / 100);

    // Apply trading fees (0.1% maker + 0.1% taker = 0.2% round trip)
    const feePercent = 0.2;
    const fees = this.config.positionSizeDollars * this.config.leverage * (feePercent / 100);
    const netPnL = realizedPnL - fees;

    this.balance += netPnL;

    const trade: Trade = {
      symbol: position.symbol,
      direction,
      entryPrice,
      entryTime: position.entryTime,
      exitPrice,
      exitTime,
      exitReason: reason,
      realizedPnL: netPnL,
      realizedPnLPercent: (netPnL / this.config.positionSizeDollars) * 100,
      timeframe: position.timeframe,
      leverage: this.config.leverage,
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

  getBalance(): number {
    return this.balance;
  }

  getStats() {
    const trades = this.trades;
    const wins = trades.filter(t => t.realizedPnL > 0);
    const losses = trades.filter(t => t.realizedPnL <= 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.realizedPnL, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnL, 0));

    const longTrades = trades.filter(t => t.direction === 'long');
    const shortTrades = trades.filter(t => t.direction === 'short');
    const longWins = longTrades.filter(t => t.realizedPnL > 0);
    const shortWins = shortTrades.filter(t => t.realizedPnL > 0);

    // By timeframe
    const byTimeframe: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const trade of trades) {
      if (!byTimeframe[trade.timeframe]) {
        byTimeframe[trade.timeframe] = { trades: 0, pnl: 0, wins: 0 };
      }
      byTimeframe[trade.timeframe].trades++;
      byTimeframe[trade.timeframe].pnl += trade.realizedPnL;
      if (trade.realizedPnL > 0) byTimeframe[trade.timeframe].wins++;
    }

    return {
      totalTrades: trades.length,
      longTrades: longTrades.length,
      shortTrades: shortTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
      longWinRate: longTrades.length > 0 ? (longWins.length / longTrades.length * 100).toFixed(1) : '0',
      shortWinRate: shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100).toFixed(1) : '0',
      totalPnL: totalPnL.toFixed(2),
      avgWin: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0',
      avgLoss: losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0',
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Inf' : '0'),
      finalBalance: this.balance.toFixed(2),
      byTimeframe,
    };
  }
}

// ============= Main =============

async function main() {
  const args = process.argv.slice(2);
  let days = 4;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }

  console.log('='.repeat(80));
  console.log(`SPOT vs FUTURES BACKTEST - Real Signals (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Using ACTUAL triggered signals from the screener');
  console.log('Simulating with REAL candle data for price movements');
  console.log('');

  // Calculate date range
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Load signals
  console.log('Loading triggered signals...');
  const signals = loadSignalsFromFiles(startStr, endStr);
  console.log(`Found ${signals.length} unique triggered signals`);

  if (signals.length === 0) {
    console.log('No signals found in date range.');
    return;
  }

  // Show signal breakdown
  const longSignals = signals.filter(s => s.direction === 'long');
  const shortSignals = signals.filter(s => s.direction === 'short');
  console.log(`  Long signals: ${longSignals.length}`);
  console.log(`  Short signals: ${shortSignals.length}`);

  const byTimeframe = signals.reduce((acc, s) => {
    acc[s.timeframe] = (acc[s.timeframe] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('  By timeframe:', byTimeframe);
  console.log('');

  // Define strategies to test
  const strategies = [
    { name: 'Futures 10x (L+S)', leverage: 10, longOnly: false, positionSize: 100 },
    { name: 'Spot 1x (Long-only)', leverage: 1, longOnly: true, positionSize: 100 },
    { name: 'Margin 3x (Long-only)', leverage: 3, longOnly: true, positionSize: 100 },
  ];

  const baseConfig = {
    initialStopLossPercent: 15,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    level1LockPercent: 2,
    initialBalance: 2000,
  };

  const results: Array<{
    name: string;
    stats: ReturnType<SpotBacktester['getStats']>;
    trades: Trade[];
  }> = [];

  // Run each strategy
  for (const strategy of strategies) {
    console.log(`Running ${strategy.name}...`);

    const backtester = new SpotBacktester({
      ...baseConfig,
      leverage: strategy.leverage,
      longOnly: strategy.longOnly,
      positionSizeDollars: strategy.positionSize,
    });

    // Process signals and simulate using candle data
    let processedSignals = 0;
    let candlesUsed = 0;

    for (const signal of signals) {
      const position = backtester.openPosition(signal);
      if (!position) continue;
      processedSignals++;

      // Load candle data for this symbol/timeframe
      const candles = loadCandleFile(signal.symbol, signal.timeframe);
      if (!candles || candles.length === 0) continue;

      candlesUsed++;
      const posKey = `${signal.symbol}-${signal.timeframe}`;
      const entryTime = new Date(signal.timestamp).getTime();

      // Find candles after entry and simulate price updates
      for (const candle of candles) {
        if (candle.timestamp <= entryTime) continue;

        // Check high and low for stop hits
        backtester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;  // Position closed

        backtester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;  // Position closed

        backtester.updatePositionPrice(posKey, candle.close, candle.timestamp);
        if (!backtester.getPositions().has(posKey)) break;  // Position closed
      }
    }

    // Close remaining positions
    const lastPrices = new Map<string, number>();
    for (const signal of signals) {
      lastPrices.set(signal.symbol, signal.price);
    }
    backtester.closeAllPositions(Date.now(), lastPrices);

    console.log(`  Processed ${processedSignals} signals, ${candlesUsed} with candle data`);

    results.push({
      name: strategy.name,
      stats: backtester.getStats(),
      trades: backtester.getTrades(),
    });
  }

  // Print comparison
  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(25) +
    'Trades'.padStart(8) +
    'L/S'.padStart(10) +
    'Win%'.padStart(8) +
    'PF'.padStart(8) +
    'P&L'.padStart(12) +
    'Balance'.padStart(12);

  console.log(header);
  console.log('-'.repeat(85));

  for (const result of results) {
    const s = result.stats;
    const row = result.name.padEnd(25) +
      s.totalTrades.toString().padStart(8) +
      `${s.longTrades}/${s.shortTrades}`.padStart(10) +
      `${s.winRate}%`.padStart(8) +
      s.profitFactor.padStart(8) +
      `$${s.totalPnL}`.padStart(12) +
      `$${s.finalBalance}`.padStart(12);
    console.log(row);
  }
  console.log('-'.repeat(85));

  // Timeframe breakdown for spot strategy
  const spotResult = results.find(r => r.name.includes('Spot 1x'));
  if (spotResult && Object.keys(spotResult.stats.byTimeframe).length > 0) {
    console.log('\n📊 Spot 1x Breakdown by Timeframe:');
    console.log('-'.repeat(50));
    for (const [tf, data] of Object.entries(spotResult.stats.byTimeframe)) {
      const winRate = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0';
      console.log(`  ${tf.padEnd(6)} ${data.trades.toString().padStart(4)} trades, ${winRate}% win, $${data.pnl.toFixed(2)}`);
    }
  }

  // Sample trades
  if (spotResult && spotResult.trades.length > 0) {
    console.log('\n📋 Sample Spot Trades (first 15):');
    console.log('-'.repeat(90));
    for (const trade of spotResult.trades.slice(0, 15)) {
      const date = new Date(trade.entryTime).toISOString().split('T')[0];
      const pnlSign = trade.realizedPnL >= 0 ? '+' : '';
      console.log(`  ${date} ${trade.symbol.padEnd(14)} ${trade.timeframe.padEnd(4)} ` +
        `$${trade.entryPrice.toPrecision(4).padStart(10)} → $${trade.exitPrice.toPrecision(4).padStart(10)} ` +
        `${pnlSign}$${trade.realizedPnL.toFixed(2).padStart(8)} (${trade.exitReason})`);
    }
  }

  // Key insight
  console.log('\n' + '='.repeat(80));
  console.log('KEY INSIGHT: SPOT-ONLY TRADING');
  console.log('='.repeat(80));

  const futuresResult = results.find(r => r.name.includes('Futures'));
  if (spotResult && futuresResult) {
    const futuresPnL = parseFloat(futuresResult.stats.totalPnL);
    const spotPnL = parseFloat(spotResult.stats.totalPnL);

    console.log(`\nFutures 10x (Long+Short): $${futuresPnL.toFixed(2)}`);
    console.log(`Spot 1x (Long-only):      $${spotPnL.toFixed(2)}`);

    if (futuresPnL !== 0) {
      const ratio = Math.abs(spotPnL / futuresPnL * 100).toFixed(1);
      console.log(`\n→ Spot captures ${ratio}% of futures magnitude`);
    }

    if (spotPnL > 0) {
      console.log('\n✅ SPOT-ONLY IS PROFITABLE!');
      console.log(`   With $100 positions, you'd make $${spotPnL.toFixed(2)} over ${days} days`);
      console.log(`   Projected monthly: $${(spotPnL / days * 30).toFixed(2)}`);
    } else {
      console.log('\n⚠️ SPOT-ONLY WOULD HAVE LOST MONEY');
      console.log('   Consider waiting for better market conditions');
    }
  }
}

main().catch(console.error);
