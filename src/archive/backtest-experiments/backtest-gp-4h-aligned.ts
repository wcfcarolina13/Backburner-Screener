#!/usr/bin/env node
/**
 * GP Zone 4H Backtest with Market Alignment
 *
 * Combines:
 * 1. GP Zone strategy on 4H timeframe
 * 2. Market alignment filter (only longs when bullish)
 *
 * This should be the best of both worlds!
 */

import * as fs from 'fs';
import * as path from 'path';
import { Candle } from './types.js';

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
  marketBias?: string;
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

// ============= Market Bias =============

interface MarketBias {
  timestamp: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  rsi: number;
}

function buildMarketBiasFromSignals(signals: Signal[], windowHours: number = 8): Map<number, MarketBias> {
  const biasMap = new Map<number, MarketBias>();
  const windowMs = windowHours * 60 * 60 * 1000;

  const sorted = [...signals].sort((a, b) => a.timestamp - b.timestamp);

  for (const signal of sorted) {
    const ts = signal.timestamp;
    const windowStart = ts - windowMs;

    const windowSignals = sorted.filter(s => s.timestamp >= windowStart && s.timestamp < ts);

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (total >= 2) {
      const longRatio = longs / total;
      if (longRatio > 0.6) bias = 'bullish';
      else if (longRatio < 0.4) bias = 'bearish';
    }

    biasMap.set(ts, {
      timestamp: ts,
      bias,
      rsi: signal.rsi,
    });
  }

  return biasMap;
}

// ============= Signal Detection =============

function detectGPSignals(candles: Candle[], symbol: string, timeframe: string): Signal[] {
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

class AlignedGPBacktester {
  private config: BacktestConfig;
  private balance: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private skippedDueToAlignment: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
  }

  openPosition(signal: Signal, marketBias: MarketBias | null, requireAlignment: boolean): Position | null {
    if (this.config.longOnly && signal.direction === 'short') {
      return null;
    }

    // Check market alignment
    if (requireAlignment && marketBias) {
      if (signal.direction === 'long' && marketBias.bias !== 'bullish') {
        this.skippedDueToAlignment++;
        return null;
      }
      if (signal.direction === 'short' && marketBias.bias !== 'bearish') {
        this.skippedDueToAlignment++;
        return null;
      }
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

    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = entryPrice * 1.001;
    }

    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    if (position.trailActivated) {
      if (direction === 'long') {
        const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
        if (trailStop > position.stopLoss) position.stopLoss = trailStop;
      } else {
        const trailStop = position.lowestPrice * (1 + this.config.trailStepPercent / 100);
        if (trailStop < position.stopLoss) position.stopLoss = trailStop;
      }
    }

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

  getSkippedCount(): number {
    return this.skippedDueToAlignment;
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
      skippedDueToAlignment: this.skippedDueToAlignment,
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
  console.log(`GP 4H + MARKET ALIGNMENT BACKTEST (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Compares:');
  console.log('  1. GP 4H Spot (All longs)     - takes every GP long signal');
  console.log('  2. GP 4H Spot (Aligned)       - only longs when market is bullish');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];
  const startTs = startDate.getTime();
  const endTs = endDate.getTime();

  console.log(`Date range: ${startStr} to ${endStr}`);

  const timeframe = '4h';
  console.log(`\nLoading ${timeframe} candle data...`);
  const symbols = getSymbolsWithTimeframe(timeframe);
  console.log(`Found ${symbols.length} symbols with ${timeframe} data`);

  if (symbols.length === 0) {
    console.log('No 4h data available.');
    return;
  }

  // Collect all GP signals for market bias calculation
  console.log('\nGenerating GP signals for market bias...');
  const allSignals: Signal[] = [];
  const symbolCandles = new Map<string, Candle[]>();

  for (const symbol of symbols) {
    const candles = loadCandleFile(symbol, timeframe);
    if (!candles || candles.length < 20) continue;

    const filtered = candles.filter(c => c.timestamp >= startTs && c.timestamp <= endTs);
    if (filtered.length < 15) continue;

    symbolCandles.set(symbol, filtered);
    const signals = detectGPSignals(filtered, symbol, timeframe);
    allSignals.push(...signals);
  }

  console.log(`  Total GP signals: ${allSignals.length}`);
  const longSignals = allSignals.filter(s => s.direction === 'long');
  const shortSignals = allSignals.filter(s => s.direction === 'short');
  console.log(`  Long: ${longSignals.length}, Short: ${shortSignals.length}`);

  // Build market bias map
  const biasMap = buildMarketBiasFromSignals(allSignals, 8);
  console.log(`  Market bias entries: ${biasMap.size}`);

  // Count bias distribution
  let bullish = 0, bearish = 0, neutral = 0;
  for (const b of biasMap.values()) {
    if (b.bias === 'bullish') bullish++;
    else if (b.bias === 'bearish') bearish++;
    else neutral++;
  }
  const totalBias = bullish + bearish + neutral;
  if (totalBias > 0) {
    console.log(`  Bias distribution: ${(bullish/totalBias*100).toFixed(1)}% bullish, ${(bearish/totalBias*100).toFixed(1)}% bearish`);
  }

  const baseConfig = {
    positionSizeDollars: 100,
    initialStopLossPercent: 15,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    level1LockPercent: 2,
    initialBalance: 2000,
    longOnly: true,
    leverage: 1,
  };

  // Run both strategies
  console.log('\nRunning GP 4H Spot (All Longs)...');
  const allLongsBacktester = new AlignedGPBacktester(baseConfig);

  console.log('Running GP 4H Spot (Aligned)...');
  const alignedBacktester = new AlignedGPBacktester(baseConfig);

  // Process each signal
  for (const signal of longSignals) {
    const bias = biasMap.get(signal.timestamp) || null;
    const candles = symbolCandles.get(signal.symbol);
    if (!candles) continue;

    const posKey = `${signal.symbol}-${signal.timeframe}`;

    // All longs
    const pos1 = allLongsBacktester.openPosition(signal, null, false);

    // Aligned
    const pos2 = alignedBacktester.openPosition(signal, bias, true);

    // Simulate price updates
    for (const candle of candles) {
      if (candle.timestamp <= signal.timestamp) continue;

      if (allLongsBacktester.getPositions().has(posKey)) {
        allLongsBacktester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        allLongsBacktester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        allLongsBacktester.updatePositionPrice(posKey, candle.close, candle.timestamp);
      }

      if (alignedBacktester.getPositions().has(posKey)) {
        alignedBacktester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        alignedBacktester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        alignedBacktester.updatePositionPrice(posKey, candle.close, candle.timestamp);
      }

      if (!allLongsBacktester.getPositions().has(posKey) && !alignedBacktester.getPositions().has(posKey)) {
        break;
      }
    }
  }

  // Close remaining positions
  const lastPrices = new Map<string, number>();
  for (const [symbol, candles] of symbolCandles) {
    if (candles.length > 0) {
      lastPrices.set(symbol, candles[candles.length - 1].close);
    }
  }
  allLongsBacktester.closeAllPositions(Date.now(), lastPrices);
  alignedBacktester.closeAllPositions(Date.now(), lastPrices);

  // Results
  const allStats = allLongsBacktester.getStats();
  const alignedStats = alignedBacktester.getStats();

  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Strategy'.padEnd(30) +
    'Trades'.padStart(8) +
    'Skipped'.padStart(10) +
    'Win%'.padStart(8) +
    'PF'.padStart(8) +
    'P&L'.padStart(12);

  console.log(header);
  console.log('-'.repeat(80));

  console.log(
    'GP 4H Spot (All Longs)'.padEnd(30) +
    allStats.totalTrades.toString().padStart(8) +
    '0'.padStart(10) +
    `${allStats.winRate}%`.padStart(8) +
    allStats.profitFactor.padStart(8) +
    `$${allStats.totalPnL}`.padStart(12)
  );

  console.log(
    'GP 4H Spot (Aligned)'.padEnd(30) +
    alignedStats.totalTrades.toString().padStart(8) +
    alignedStats.skippedDueToAlignment.toString().padStart(10) +
    `${alignedStats.winRate}%`.padStart(8) +
    alignedStats.profitFactor.padStart(8) +
    `$${alignedStats.totalPnL}`.padStart(12)
  );

  console.log('-'.repeat(80));

  // Key insight
  console.log('\n' + '='.repeat(80));
  console.log('KEY INSIGHT');
  console.log('='.repeat(80));

  const allPnL = parseFloat(allStats.totalPnL);
  const alignedPnL = parseFloat(alignedStats.totalPnL);
  const improvement = alignedPnL - allPnL;

  console.log(`\nGP 4H All Longs P&L: $${allPnL.toFixed(2)}`);
  console.log(`GP 4H Aligned P&L:   $${alignedPnL.toFixed(2)}`);
  console.log(`Improvement:         $${improvement.toFixed(2)} (${improvement > 0 ? '+' : ''}${allPnL !== 0 ? (improvement / Math.abs(allPnL) * 100).toFixed(1) : '0'}%)`);

  console.log(`\nTrades skipped due to bearish market: ${alignedStats.skippedDueToAlignment}`);

  if (alignedPnL > allPnL) {
    console.log('\n✅ MARKET ALIGNMENT IMPROVES GP 4H PERFORMANCE!');
  } else if (alignedPnL === allPnL) {
    console.log('\n➖ Market alignment had no impact on GP 4H.');
  } else {
    console.log('\n⚠️ Market alignment reduced GP 4H performance.');
    console.log('   Some skipped trades would have been profitable.');
  }

  // Final recommendation
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION FOR SPOT TRADING');
  console.log('='.repeat(80));

  if (alignedPnL > 0) {
    console.log('\n✅ GP 4H + Market Alignment is PROFITABLE!');
    console.log(`   Expected P&L: $${alignedPnL.toFixed(2)} over ${days} days`);
    console.log(`   Monthly projection: $${(alignedPnL / days * 30).toFixed(2)}`);
  } else if (alignedPnL > -50) {
    console.log('\n⚠️ GP 4H + Market Alignment had small losses.');
    console.log('   Strategy is viable, market conditions were tough.');
  } else {
    console.log('\n❌ GP 4H + Market Alignment had significant losses.');
    console.log('   Consider waiting for better market conditions.');
  }
}

main().catch(console.error);
