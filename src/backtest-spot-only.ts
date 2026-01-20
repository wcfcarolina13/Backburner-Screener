#!/usr/bin/env node
/**
 * Spot-Only Backtest Comparison
 *
 * Compares:
 * 1. Futures (10x leverage, long+short) - Current strategy
 * 2. Spot (1x, long-only) - US-compliant alternative
 *
 * Uses the GP Zone strategy (RSI 23.6-38.2 for longs)
 */

import fs from 'fs';
import path from 'path';
import { Candle, Timeframe, MarketType } from './types.js';
import { getExecutionCostsCalculator } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();

// ============= RSI Calculation =============

function calculateRSI(candles: Candle[], period: number = 14): number[] {
  const rsiValues: number[] = [];
  if (candles.length < period + 1) return rsiValues;

  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const firstRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiValues.push(100 - (100 / (1 + firstRS)));

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  return rsiValues;
}

// ============= Signal Detection =============

interface Signal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: Timeframe;
  rsi: number;
  price: number;
}

const GP_LONG_LOWER = 23.6;
const GP_LONG_UPPER = 38.2;
const GP_SHORT_LOWER = 61.8;
const GP_SHORT_UPPER = 76.4;

function detectSignals(candles: Candle[], symbol: string, timeframe: Timeframe, longOnly: boolean = false): Signal[] {
  const signals: Signal[] = [];
  const rsiValues = calculateRSI(candles);
  const period = 14;

  for (let i = 0; i < rsiValues.length; i++) {
    const candleIndex = i + period;
    const candle = candles[candleIndex];
    const rsi = rsiValues[i];

    if (rsi >= GP_LONG_LOWER && rsi <= GP_LONG_UPPER) {
      signals.push({
        timestamp: candle.timestamp,
        symbol,
        direction: 'long',
        timeframe,
        rsi,
        price: candle.close,
      });
    } else if (!longOnly && rsi >= GP_SHORT_LOWER && rsi <= GP_SHORT_UPPER) {
      signals.push({
        timestamp: candle.timestamp,
        symbol,
        direction: 'short',
        timeframe,
        rsi,
        price: candle.close,
      });
    }
  }

  return signals;
}

// ============= Load Candle Data =============

interface CandleFile {
  symbol: string;
  timeframe: string;
  marketType: string;
  candles: Candle[];
}

function loadCandleFile(symbol: string, timeframe: Timeframe, marketType: MarketType = 'spot'): Candle[] | null {
  const filePath = path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-${marketType}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data: CandleFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.candles;
  } catch {
    return null;
  }
}

function getSymbolsWithTimeframe(timeframe: Timeframe): string[] {
  const candlesDir = path.join(process.cwd(), 'data', 'candles');
  const symbols: string[] = [];

  const dirs = fs.readdirSync(candlesDir).filter(d => {
    const stat = fs.statSync(path.join(candlesDir, d));
    return stat.isDirectory() && !d.startsWith('.');
  });

  for (const symbol of dirs) {
    const hasTimeframe = fs.existsSync(path.join(candlesDir, symbol, `${timeframe}-spot.json`));
    if (hasTimeframe) symbols.push(symbol);
  }

  return symbols;
}

// ============= Backtest Engine =============

interface Position {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;
  marginUsed: number;
  stopLoss: number;
  highestPrice: number;
  lowestPrice: number;
  trailActivated: boolean;
  level1Locked: boolean;
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
}

interface BacktestConfig {
  leverage: number;
  positionSizePercent: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  initialBalance: number;
  longOnly: boolean;
}

class Backtester {
  private config: BacktestConfig;
  private balance: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
  }

  openPosition(signal: Signal): Position | null {
    if (this.config.longOnly && signal.direction === 'short') {
      return null;
    }

    if (this.positions.has(signal.symbol)) {
      return null;
    }

    // Don't open if balance is too low
    if (this.balance < 10) {
      return null;
    }

    // Use INITIAL balance for position sizing (no compounding) for fair comparison
    const marginToUse = this.config.initialBalance * (this.config.positionSizePercent / 100);
    const positionSize = marginToUse * this.config.leverage;

    const stopDistance = signal.price * (this.config.initialStopLossPercent / 100);
    const stopLoss = signal.direction === 'long'
      ? signal.price - stopDistance
      : signal.price + stopDistance;

    const position: Position = {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.price,
      entryTime: signal.timestamp,
      positionSize,
      marginUsed: marginToUse,
      stopLoss,
      highestPrice: signal.price,
      lowestPrice: signal.price,
      trailActivated: false,
      level1Locked: false,
    };

    this.positions.set(signal.symbol, position);
    return position;
  }

  updatePositionPrice(symbol: string, price: number, timestamp: number): Trade | null {
    const position = this.positions.get(symbol);
    if (!position) return null;

    if (price > position.highestPrice) position.highestPrice = price;
    if (price < position.lowestPrice) position.lowestPrice = price;

    const direction = position.direction;
    const entryPrice = position.entryPrice;

    // Calculate current P&L percent (leveraged)
    const pnlPercent = direction === 'long'
      ? ((price - entryPrice) / entryPrice) * 100 * this.config.leverage
      : ((entryPrice - price) / entryPrice) * 100 * this.config.leverage;

    // Level 1 lock (breakeven)
    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = entryPrice;
    }

    // Trail activation
    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    // Update trailing stop
    if (position.trailActivated) {
      if (direction === 'long') {
        const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
        if (trailStop > position.stopLoss) position.stopLoss = trailStop;
      } else {
        const trailStop = position.lowestPrice * (1 + this.config.trailStepPercent / 100);
        if (trailStop < position.stopLoss) position.stopLoss = trailStop;
      }
    }

    // Check stop hit
    const stopHit = direction === 'long'
      ? price <= position.stopLoss
      : price >= position.stopLoss;

    if (stopHit) {
      return this.closePosition(symbol, position.stopLoss, timestamp,
        position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop'));
    }

    return null;
  }

  closePosition(symbol: string, exitPrice: number, exitTime: number, reason: string): Trade {
    const position = this.positions.get(symbol)!;
    this.positions.delete(symbol);

    const direction = position.direction;
    const pnlPercent = direction === 'long'
      ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;

    const leveragedPnLPercent = pnlPercent * this.config.leverage;
    const realizedPnL = position.marginUsed * (leveragedPnLPercent / 100);

    // Apply execution costs
    const entryCosts = costsCalculator.calculateEntryCosts(
      position.entryPrice,
      position.positionSize,
      position.direction
    );
    const exitCosts = costsCalculator.calculateExitCosts(
      exitPrice,
      position.positionSize,
      position.direction
    );
    const totalCosts = entryCosts.entryCosts + exitCosts.exitCosts;
    const netPnL = realizedPnL - totalCosts;

    this.balance += netPnL;

    const trade: Trade = {
      symbol,
      direction,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      exitPrice,
      exitTime,
      exitReason: reason,
      realizedPnL: netPnL,
      realizedPnLPercent: (netPnL / position.marginUsed) * 100,
    };

    this.trades.push(trade);
    return trade;
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values());
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
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf',
      finalBalance: this.balance.toFixed(2),
    };
  }
}

// ============= Run Backtest =============

async function runBacktest(config: BacktestConfig, timeframe: Timeframe, label: string) {
  const symbols = getSymbolsWithTimeframe(timeframe);

  // Collect all signals
  const allSignals: Signal[] = [];
  const priceUpdates: Map<string, Candle[]> = new Map();

  for (const symbol of symbols) {
    const candles = loadCandleFile(symbol, timeframe);
    if (!candles) continue;

    const signals = detectSignals(candles, symbol, timeframe, config.longOnly);
    allSignals.push(...signals);
    priceUpdates.set(symbol, candles);
  }

  // Create events
  interface Event {
    type: 'signal' | 'price';
    timestamp: number;
    signal?: Signal;
    symbol?: string;
    price?: number;
  }

  const events: Event[] = [];

  for (const signal of allSignals) {
    events.push({ type: 'signal', timestamp: signal.timestamp, signal });
  }

  for (const [symbol, candles] of priceUpdates) {
    for (const candle of candles) {
      events.push({ type: 'price', timestamp: candle.timestamp, symbol, price: candle.close });
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  // Run backtest
  const backtester = new Backtester(config);

  for (const event of events) {
    if (event.type === 'signal' && event.signal) {
      backtester.openPosition(event.signal);
    } else if (event.type === 'price' && event.symbol && event.price) {
      backtester.updatePositionPrice(event.symbol, event.price, event.timestamp);
    }
  }

  // Close remaining positions
  for (const pos of backtester.getOpenPositions()) {
    const candles = priceUpdates.get(pos.symbol);
    if (candles && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      backtester.closePosition(pos.symbol, lastCandle.close, lastCandle.timestamp, 'end_of_backtest');
    }
  }

  return {
    label,
    config,
    stats: backtester.getStats(),
    trades: backtester.getTrades(),
  };
}

// ============= Main =============

async function main() {
  console.log('='.repeat(80));
  console.log('SPOT vs FUTURES BACKTEST COMPARISON');
  console.log('='.repeat(80));
  console.log('');
  console.log('Comparing GP Zone Strategy (RSI 23.6-38.2 long, 61.8-76.4 short)');
  console.log('Timeframe: 4H');
  console.log('');

  const baseConfig = {
    positionSizePercent: 5,
    initialStopLossPercent: 15,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    level1LockPercent: 2,
    initialBalance: 2000,
  };

  // Run both strategies
  const results = await Promise.all([
    // Futures: 10x leverage, long+short
    runBacktest({
      ...baseConfig,
      leverage: 10,
      longOnly: false,
    }, '4h', 'Futures 10x (Long+Short)'),

    // Spot: 1x leverage, long-only
    runBacktest({
      ...baseConfig,
      leverage: 1,
      longOnly: true,
    }, '4h', 'Spot 1x (Long-Only)'),

    // Also test 3x leverage spot (some exchanges allow)
    runBacktest({
      ...baseConfig,
      leverage: 3,
      longOnly: true,
    }, '4h', 'Margin 3x (Long-Only)'),
  ]);

  // Print comparison
  console.log('='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(28) +
    'Trades'.padStart(8) +
    'L/S'.padStart(10) +
    'Win%'.padStart(8) +
    'PF'.padStart(8) +
    'P&L'.padStart(14) +
    'Final'.padStart(12);

  console.log(header);
  console.log('-'.repeat(80));

  for (const result of results) {
    const s = result.stats;
    const row = result.label.padEnd(28) +
      s.totalTrades.toString().padStart(8) +
      `${s.longTrades}/${s.shortTrades}`.padStart(10) +
      `${s.winRate}%`.padStart(8) +
      s.profitFactor.padStart(8) +
      `$${s.totalPnL}`.padStart(14) +
      `$${s.finalBalance}`.padStart(12);
    console.log(row);
  }

  console.log('-'.repeat(80));
  console.log('');

  // Detailed breakdown
  console.log('='.repeat(80));
  console.log('DETAILED BREAKDOWN');
  console.log('='.repeat(80));
  console.log('');

  for (const result of results) {
    const s = result.stats;
    console.log(`📊 ${result.label}`);
    console.log(`   Leverage: ${result.config.leverage}x | Long-only: ${result.config.longOnly}`);
    console.log(`   Total Trades: ${s.totalTrades} (${s.longTrades} long, ${s.shortTrades} short)`);
    console.log(`   Win Rate: ${s.winRate}% overall | ${s.longWinRate}% long | ${s.shortWinRate}% short`);
    console.log(`   Avg Win: $${s.avgWin} | Avg Loss: $${s.avgLoss}`);
    console.log(`   Profit Factor: ${s.profitFactor}`);
    console.log(`   Total P&L: $${s.totalPnL}`);
    console.log(`   Final Balance: $${s.finalBalance} (started: $${result.config.initialBalance})`);
    console.log(`   ROI: ${((parseFloat(s.finalBalance) - result.config.initialBalance) / result.config.initialBalance * 100).toFixed(1)}%`);
    console.log('');
  }

  // Analysis
  console.log('='.repeat(80));
  console.log('ANALYSIS');
  console.log('='.repeat(80));
  console.log('');

  const futures = results.find(r => r.label.includes('Futures'))!;
  const spot = results.find(r => r.label.includes('Spot'))!;
  const margin = results.find(r => r.label.includes('Margin'))!;

  const futuresPnL = parseFloat(futures.stats.totalPnL);
  const spotPnL = parseFloat(spot.stats.totalPnL);
  const marginPnL = parseFloat(margin.stats.totalPnL);

  console.log('Futures vs Spot Comparison:');
  console.log(`  Futures P&L:     $${futuresPnL.toFixed(2)}`);
  console.log(`  Spot P&L:        $${spotPnL.toFixed(2)}`);
  console.log(`  Difference:      $${(futuresPnL - spotPnL).toFixed(2)} (${((futuresPnL / spotPnL - 1) * 100).toFixed(0)}% more with futures)`);
  console.log('');
  console.log('Long-only impact:');
  console.log(`  Futures trades:  ${futures.stats.totalTrades} (${futures.stats.longTrades} long + ${futures.stats.shortTrades} short)`);
  console.log(`  Spot trades:     ${spot.stats.totalTrades} (long-only)`);
  console.log(`  Lost trades:     ${futures.stats.shortTrades} shorts not taken`);
  console.log('');
  console.log('If you have 3x margin available:');
  console.log(`  Margin 3x P&L:   $${marginPnL.toFixed(2)}`);
  console.log(`  vs Spot 1x:      ${((marginPnL / spotPnL - 1) * 100).toFixed(0)}% better`);
  console.log(`  vs Futures 10x:  ${((marginPnL / futuresPnL - 1) * 100).toFixed(0)}% of futures performance`);
}

main().catch(console.error);
