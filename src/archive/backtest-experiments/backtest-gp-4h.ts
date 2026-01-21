#!/usr/bin/env node
/**
 * GP Zone 4H Backtest
 *
 * Generates HYPOTHETICAL signals using the GP Zone strategy on 4H timeframe:
 * - Long when RSI enters 23.6-38.2 zone (Golden Pocket oversold)
 * - Short when RSI enters 61.8-76.4 zone (Golden Pocket overbought)
 *
 * This simulates what the new GP 4H shadow bot would have done historically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Candle, Timeframe } from './types.js';

// ============= Types =============

interface Signal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  price: number;
}

interface Position {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;
  dollarValue: number;
  stopLoss: number;
  highestPrice: number;
  lowestPrice: number;
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
  positionSizeDollars: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  initialBalance: number;
  longOnly: boolean;
}

// ============= GP Zone Constants =============

const GP_LONG_LOWER = 23.6;
const GP_LONG_UPPER = 38.2;
const GP_SHORT_LOWER = 61.8;
const GP_SHORT_UPPER = 76.4;

// ============= RSI Calculation =============

function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) return rsi;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
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
  rsi.push(100 - (100 / (1 + firstRS)));

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));
  }

  return rsi;
}

// ============= Signal Detection =============

function detectGPSignals(candles: Candle[], symbol: string, timeframe: string, longOnly: boolean): Signal[] {
  const signals: Signal[] = [];
  const closes = candles.map(c => c.close);
  const rsiValues = calculateRSI(closes, 14);

  const rsiOffset = 14;
  let wasInLongZone = false;
  let wasInShortZone = false;

  for (let i = rsiOffset; i < candles.length; i++) {
    const rsiIdx = i - rsiOffset;
    if (rsiIdx < 0 || rsiIdx >= rsiValues.length) continue;

    const candle = candles[i];
    const rsi = rsiValues[rsiIdx];

    // Detect entry into GP long zone (oversold)
    const inLongZone = rsi >= GP_LONG_LOWER && rsi <= GP_LONG_UPPER;
    if (inLongZone && !wasInLongZone) {
      signals.push({
        timestamp: candle.timestamp,
        symbol,
        direction: 'long',
        timeframe,
        rsi,
        price: candle.close,
      });
    }
    wasInLongZone = inLongZone;

    // Detect entry into GP short zone (overbought)
    if (!longOnly) {
      const inShortZone = rsi >= GP_SHORT_LOWER && rsi <= GP_SHORT_UPPER;
      if (inShortZone && !wasInShortZone) {
        signals.push({
          timestamp: candle.timestamp,
          symbol,
          direction: 'short',
          timeframe,
          rsi,
          price: candle.close,
        });
      }
      wasInShortZone = inShortZone;
    }
  }

  return signals;
}

// ============= Load Data =============

interface CandleFile {
  symbol: string;
  timeframe: string;
  marketType: string;
  candles: Candle[];
}

function loadCandleFile(symbol: string, timeframe: string): Candle[] | null {
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

function getSymbolsWithTimeframe(timeframe: string): string[] {
  const candlesDir = path.join(process.cwd(), 'data', 'candles');
  const symbols: string[] = [];

  try {
    const dirs = fs.readdirSync(candlesDir).filter(d => {
      const stat = fs.statSync(path.join(candlesDir, d));
      return stat.isDirectory() && !d.startsWith('.');
    });

    for (const symbol of dirs) {
      const hasSpot = fs.existsSync(path.join(candlesDir, symbol, `${timeframe}-spot.json`));
      const hasFutures = fs.existsSync(path.join(candlesDir, symbol, `${timeframe}-futures.json`));
      if (hasSpot || hasFutures) symbols.push(symbol);
    }
  } catch (e) {
    console.error('Error reading candles directory:', e);
  }

  return symbols;
}

// ============= Backtest Engine =============

class GP4HBacktester {
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

  openPosition(signal: Signal): Position | null {
    if (this.config.longOnly && signal.direction === 'short') {
      return null;
    }

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (this.positions.has(posKey)) {
      return null;
    }

    const entryPrice = signal.price;
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
      entryTime: signal.timestamp,
      positionSize,
      dollarValue,
      stopLoss,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
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
    if (price < position.lowestPrice) position.lowestPrice = price;

    const direction = position.direction;
    const entryPrice = position.entryPrice;

    const pnlPercent = direction === 'long'
      ? ((price - entryPrice) / entryPrice) * 100
      : ((entryPrice - price) / entryPrice) * 100;

    // Level 1 lock (breakeven)
    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = entryPrice * 1.001;
    }

    // Trail activation
    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    // Update trailing stop
    if (position.trailActivated) {
      if (direction === 'long') {
        const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
        if (trailStop > position.stopLoss) {
          position.stopLoss = trailStop;
        }
      } else {
        const trailStop = position.lowestPrice * (1 + this.config.trailStepPercent / 100);
        if (trailStop < position.stopLoss) {
          position.stopLoss = trailStop;
        }
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

    let pnlPercent: number;
    if (direction === 'long') {
      pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    } else {
      pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    }

    const leveragedPnlPercent = pnlPercent * this.config.leverage;
    const realizedPnL = this.config.positionSizeDollars * (leveragedPnlPercent / 100);

    // Apply trading fees
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
    };
  }
}

// ============= Main =============

async function main() {
  const args = process.argv.slice(2);
  let days = 7;  // Default to 7 days for 4H (need more data)

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }

  console.log('='.repeat(80));
  console.log(`GP ZONE 4H BACKTEST - Hypothetical Signals (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('GP Zone Strategy:');
  console.log(`  Long zone:  RSI ${GP_LONG_LOWER} - ${GP_LONG_UPPER} (oversold)`);
  console.log(`  Short zone: RSI ${GP_SHORT_LOWER} - ${GP_SHORT_UPPER} (overbought)`);
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Get symbols with 4H data
  const timeframe = '4h';
  console.log(`Loading ${timeframe} candle data...`);
  const symbols = getSymbolsWithTimeframe(timeframe);
  console.log(`Found ${symbols.length} symbols with ${timeframe} data`);

  if (symbols.length === 0) {
    // Try 1h as fallback
    console.log('No 4h data found, trying 1h...');
    const symbols1h = getSymbolsWithTimeframe('1h');
    if (symbols1h.length > 0) {
      console.log(`Found ${symbols1h.length} symbols with 1h data`);
      // Re-run with 1h
      // For now, exit
    }
    console.log('No candle data available for backtesting.');
    return;
  }

  // Filter candles to date range and generate signals
  const startTs = startDate.getTime();
  const endTs = endDate.getTime();

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
    { name: 'Futures 10x (L+S)', leverage: 10, longOnly: false },
    { name: 'Spot 1x (Long-only)', leverage: 1, longOnly: true },
    { name: 'Margin 3x (Long-only)', leverage: 3, longOnly: true },
  ];

  const results: Array<{
    name: string;
    stats: ReturnType<GP4HBacktester['getStats']>;
    trades: Trade[];
    signalCount: number;
  }> = [];

  for (const strategy of strategies) {
    console.log(`\nRunning ${strategy.name}...`);

    const backtester = new GP4HBacktester({
      ...baseConfig,
      leverage: strategy.leverage,
      longOnly: strategy.longOnly,
    });

    let totalSignals = 0;
    let processedSymbols = 0;

    for (const symbol of symbols) {
      const candles = loadCandleFile(symbol, timeframe);
      if (!candles || candles.length < 20) continue;

      // Filter to date range
      const filteredCandles = candles.filter(c => c.timestamp >= startTs && c.timestamp <= endTs);
      if (filteredCandles.length < 15) continue;  // Need enough for RSI

      // Generate GP signals
      const signals = detectGPSignals(filteredCandles, symbol, timeframe, strategy.longOnly);
      totalSignals += signals.length;
      processedSymbols++;

      // Process each signal
      for (const signal of signals) {
        const position = backtester.openPosition(signal);
        if (!position) continue;

        const posKey = `${signal.symbol}-${signal.timeframe}`;

        // Simulate price updates
        for (const candle of filteredCandles) {
          if (candle.timestamp <= signal.timestamp) continue;

          backtester.updatePositionPrice(posKey, candle.high, candle.timestamp);
          if (!backtester.getPositions().has(posKey)) break;

          backtester.updatePositionPrice(posKey, candle.low, candle.timestamp);
          if (!backtester.getPositions().has(posKey)) break;

          backtester.updatePositionPrice(posKey, candle.close, candle.timestamp);
          if (!backtester.getPositions().has(posKey)) break;
        }
      }
    }

    // Close remaining positions
    const lastPrices = new Map<string, number>();
    for (const symbol of symbols) {
      const candles = loadCandleFile(symbol, timeframe);
      if (candles && candles.length > 0) {
        lastPrices.set(symbol, candles[candles.length - 1].close);
      }
    }
    backtester.closeAllPositions(Date.now(), lastPrices);

    console.log(`  Processed ${processedSymbols} symbols, ${totalSignals} GP signals`);

    results.push({
      name: strategy.name,
      stats: backtester.getStats(),
      trades: backtester.getTrades(),
      signalCount: totalSignals,
    });
  }

  // Print results
  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(25) +
    'Signals'.padStart(10) +
    'Trades'.padStart(8) +
    'L/S'.padStart(10) +
    'Win%'.padStart(8) +
    'PF'.padStart(8) +
    'P&L'.padStart(12);

  console.log(header);
  console.log('-'.repeat(85));

  for (const result of results) {
    const s = result.stats;
    const row = result.name.padEnd(25) +
      result.signalCount.toString().padStart(10) +
      s.totalTrades.toString().padStart(8) +
      `${s.longTrades}/${s.shortTrades}`.padStart(10) +
      `${s.winRate}%`.padStart(8) +
      s.profitFactor.padStart(8) +
      `$${s.totalPnL}`.padStart(12);
    console.log(row);
  }
  console.log('-'.repeat(85));

  // Sample trades from spot strategy
  const spotResult = results.find(r => r.name.includes('Spot 1x'));
  if (spotResult && spotResult.trades.length > 0) {
    console.log('\n📋 Sample GP 4H Spot Trades (first 15):');
    console.log('-'.repeat(90));
    for (const trade of spotResult.trades.slice(0, 15)) {
      const date = new Date(trade.entryTime).toISOString().split('T')[0];
      const pnlSign = trade.realizedPnL >= 0 ? '+' : '';
      console.log(`  ${date} ${trade.symbol.padEnd(14)} ` +
        `$${trade.entryPrice.toPrecision(4).padStart(10)} → $${trade.exitPrice.toPrecision(4).padStart(10)} ` +
        `${pnlSign}$${trade.realizedPnL.toFixed(2).padStart(8)} (${trade.exitReason})`);
    }
  }

  // Key insight
  console.log('\n' + '='.repeat(80));
  console.log('KEY INSIGHT: GP 4H STRATEGY');
  console.log('='.repeat(80));

  const futuresResult = results.find(r => r.name.includes('Futures'));
  if (spotResult && futuresResult) {
    const futuresPnL = parseFloat(futuresResult.stats.totalPnL);
    const spotPnL = parseFloat(spotResult.stats.totalPnL);

    console.log(`\nFutures 10x (Long+Short): $${futuresPnL.toFixed(2)}`);
    console.log(`Spot 1x (Long-only):      $${spotPnL.toFixed(2)}`);

    if (spotPnL > 0) {
      console.log('\n✅ GP 4H SPOT STRATEGY IS PROFITABLE!');
      console.log(`   With $100 positions, you'd make $${spotPnL.toFixed(2)} over ${days} days`);
      console.log(`   Projected monthly: $${(spotPnL / days * 30).toFixed(2)}`);
    } else if (spotPnL > -50) {
      console.log('\n⚠️ GP 4H spot had small losses - promising strategy');
      console.log('   Consider waiting for better market conditions');
    } else {
      console.log('\n❌ GP 4H spot had significant losses');
      console.log('   Strategy may need adjustment or market is unfavorable');
    }

    // Compare win rates
    const spotWinRate = parseFloat(spotResult.stats.winRate);
    const futuresWinRate = parseFloat(futuresResult.stats.winRate);
    console.log(`\nWin Rates: Futures ${futuresWinRate}% vs Spot ${spotWinRate}%`);
  }
}

main().catch(console.error);
