#!/usr/bin/env node
/**
 * Combined Strategy Backtest - Uses Candle Data Directly
 *
 * This backtest generates 4H and 5m signals directly from candle files,
 * ensuring we test on the same symbols for both timeframes.
 *
 * Strategy:
 * - 4H LONG signal → establishes bullish bias
 * - Wait for 5m SHORT signal → FADE it (go LONG) - aligned with 4H!
 * - 4H SHORT signal → establishes bearish bias
 * - Wait for 5m LONG signal → FADE it (go SHORT) - aligned with 4H!
 */

import fs from 'fs';
import path from 'path';
import { Candle, Timeframe, MarketType } from './types.js';
import { timeframeToMs } from './candle-store.js';
import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();

// ============= RSI Calculation =============

function calculateRSI(candles: Candle[], period: number = 14): number[] {
  const rsiValues: number[] = [];

  if (candles.length < period + 1) {
    return rsiValues;
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  // Initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  const firstRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiValues.push(100 - (100 / (1 + firstRS)));

  // Subsequent values using smoothed averages
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

// Golden Pocket RSI thresholds
const GP_LONG_UPPER = 38.2;  // RSI below this for long
const GP_LONG_LOWER = 23.6;
const GP_SHORT_LOWER = 61.8;  // RSI above this for short
const GP_SHORT_UPPER = 76.4;

function detectSignals(candles: Candle[], symbol: string, timeframe: Timeframe): Signal[] {
  const signals: Signal[] = [];
  const rsiValues = calculateRSI(candles);

  // RSI values start at candle index (period), so offset = period
  const period = 14;

  for (let i = 0; i < rsiValues.length; i++) {
    const candleIndex = i + period;
    const candle = candles[candleIndex];
    const rsi = rsiValues[i];

    // Check for golden pocket zones
    if (rsi >= GP_LONG_LOWER && rsi <= GP_LONG_UPPER) {
      signals.push({
        timestamp: candle.timestamp,
        symbol,
        direction: 'long',
        timeframe,
        rsi,
        price: candle.close,
      });
    } else if (rsi >= GP_SHORT_LOWER && rsi <= GP_SHORT_UPPER) {
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

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data: CandleFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.candles;
  } catch {
    return null;
  }
}

function getSymbolsWithBothTimeframes(): string[] {
  const candlesDir = path.join(process.cwd(), 'data', 'candles');
  const symbols: string[] = [];

  const dirs = fs.readdirSync(candlesDir).filter(d => {
    const stat = fs.statSync(path.join(candlesDir, d));
    return stat.isDirectory() && !d.startsWith('.');
  });

  for (const symbol of dirs) {
    const has4h = fs.existsSync(path.join(candlesDir, symbol, '4h-spot.json'));
    const has5m = fs.existsSync(path.join(candlesDir, symbol, '5m-spot.json'));

    if (has4h && has5m) {
      symbols.push(symbol);
    }
  }

  return symbols;
}

// ============= Trade Simulation =============

interface HtfBias {
  direction: 'long' | 'short';
  timestamp: number;
  rsi: number;
  price: number;
}

interface Position {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;

  // Stop loss tracking
  stopLoss: number;
  highestPrice: number;
  lowestPrice: number;
  trailActivated: boolean;
  level1Locked: boolean;

  // Signal info
  htfSignalTime: number;
  htfDirection: 'long' | 'short';
  ltfSignalTime: number;
  ltfDirection: 'long' | 'short';
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
  htfDirection: 'long' | 'short';
  ltfDirection: 'long' | 'short';
}

interface BacktestConfig {
  leverage: number;
  positionSizePercent: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  htfSignalValidityMs: number;
  initialBalance: number;
}

const DEFAULT_CONFIG: BacktestConfig = {
  leverage: 10,
  positionSizePercent: 5,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  htfSignalValidityMs: 12 * 60 * 60 * 1000,  // 12 hours
  initialBalance: 2000,
};

class CombinedBacktest {
  private config: BacktestConfig;
  private balance: number;
  private htfBiases: Map<string, HtfBias> = new Map();
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];

  constructor(config: Partial<BacktestConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
  }

  process4hSignal(signal: Signal): void {
    // 4H signals just establish/update bias - no position opened
    this.htfBiases.set(signal.symbol, {
      direction: signal.direction,
      timestamp: signal.timestamp,
      rsi: signal.rsi,
      price: signal.price,
    });
  }

  process5mSignal(signal: Signal): Position | null {
    // Check if we have an active 4H bias for this symbol
    const bias = this.htfBiases.get(signal.symbol);
    if (!bias) return null;

    // Check if 4H bias is still valid
    const biasAge = signal.timestamp - bias.timestamp;
    if (biasAge > this.config.htfSignalValidityMs) {
      // Bias expired
      this.htfBiases.delete(signal.symbol);
      return null;
    }

    // FADE the 5m signal
    const fadedDirection = signal.direction === 'long' ? 'short' : 'long';

    // Check alignment: faded 5m must match 4H bias
    if (fadedDirection !== bias.direction) {
      return null;
    }

    // Already have a position for this symbol?
    if (this.positions.has(signal.symbol)) {
      return null;
    }

    // Open position
    const positionSize = (this.balance * this.config.positionSizePercent / 100) * this.config.leverage;
    const stopLossDistance = signal.price * this.config.initialStopLossPercent / 100;
    const stopLoss = fadedDirection === 'long'
      ? signal.price - stopLossDistance
      : signal.price + stopLossDistance;

    const position: Position = {
      symbol: signal.symbol,
      direction: fadedDirection,
      entryPrice: signal.price,
      entryTime: signal.timestamp,
      positionSize,
      stopLoss,
      highestPrice: signal.price,
      lowestPrice: signal.price,
      trailActivated: false,
      level1Locked: false,
      htfSignalTime: bias.timestamp,
      htfDirection: bias.direction,
      ltfSignalTime: signal.timestamp,
      ltfDirection: signal.direction,
    };

    this.positions.set(signal.symbol, position);
    return position;
  }

  updatePositionPrice(symbol: string, price: number, timestamp: number): Trade | null {
    const position = this.positions.get(symbol);
    if (!position) return null;

    // Update high/low
    if (price > position.highestPrice) position.highestPrice = price;
    if (price < position.lowestPrice) position.lowestPrice = price;

    const direction = position.direction;
    const entryPrice = position.entryPrice;

    // Calculate current P&L percent
    const pnlPercent = direction === 'long'
      ? ((price - entryPrice) / entryPrice) * 100 * this.config.leverage
      : ((entryPrice - price) / entryPrice) * 100 * this.config.leverage;

    // Check for Level 1 lock (breakeven)
    if (!position.level1Locked && pnlPercent >= this.config.level1LockPercent) {
      position.level1Locked = true;
      position.stopLoss = entryPrice;  // Move to breakeven
    }

    // Check for trail activation
    if (!position.trailActivated && pnlPercent >= this.config.trailTriggerPercent) {
      position.trailActivated = true;
    }

    // Update trailing stop if active
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

    // Check stop loss hit
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
    const realizedPnL = (position.positionSize / this.config.leverage) * (leveragedPnLPercent / 100);

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
      realizedPnLPercent: (netPnL / (position.positionSize / this.config.leverage)) * 100,
      htfDirection: position.htfDirection,
      ltfDirection: position.ltfDirection,
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

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0',
      totalPnL: totalPnL.toFixed(2),
      avgWin: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0',
      avgLoss: losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0',
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf',
      finalBalance: this.balance.toFixed(2),
    };
  }
}

// ============= Main Backtest =============

async function main() {
  console.log('='.repeat(70));
  console.log('COMBINED STRATEGY BACKTEST: 4H Normal + 5m Fade');
  console.log('='.repeat(70));
  console.log('');
  console.log('Strategy: Use 4H to establish trend direction, 5m fade for entry timing');
  console.log('- 4H LONG + 5m SHORT (faded to LONG) = Aligned LONG entry');
  console.log('- 4H SHORT + 5m LONG (faded to SHORT) = Aligned SHORT entry');
  console.log('');

  // Get symbols that have both 4H and 5m data
  const symbols = getSymbolsWithBothTimeframes();
  console.log(`Found ${symbols.length} symbols with both 4H and 5m candle data`);

  if (symbols.length === 0) {
    console.log('No symbols found with both timeframes. Run prefetch-candles first.');
    return;
  }

  // Collect all signals across all symbols
  const all4hSignals: Signal[] = [];
  const all5mSignals: Signal[] = [];

  let symbolsProcessed = 0;
  for (const symbol of symbols) {
    const candles4h = loadCandleFile(symbol, '4h');
    const candles5m = loadCandleFile(symbol, '5m');

    if (!candles4h || !candles5m) continue;

    const signals4h = detectSignals(candles4h, symbol, '4h');
    const signals5m = detectSignals(candles5m, symbol, '5m');

    all4hSignals.push(...signals4h);
    all5mSignals.push(...signals5m);
    symbolsProcessed++;
  }

  console.log(`Processed ${symbolsProcessed} symbols`);
  console.log(`Generated ${all4hSignals.length} 4H signals`);
  console.log(`Generated ${all5mSignals.length} 5m signals`);
  console.log('');

  // Merge and sort all events chronologically
  interface Event {
    type: '4h' | '5m' | 'price';
    timestamp: number;
    signal?: Signal;
    symbol?: string;
    price?: number;
  }

  const events: Event[] = [];

  // Add 4H signals as events
  for (const signal of all4hSignals) {
    events.push({ type: '4h', timestamp: signal.timestamp, signal });
  }

  // Add 5m signals as events
  for (const signal of all5mSignals) {
    events.push({ type: '5m', timestamp: signal.timestamp, signal });
  }

  // Add price updates from 5m candles for position management
  // We'll process each symbol's 5m candles as price updates
  const priceUpdates: Map<string, Candle[]> = new Map();
  for (const symbol of symbols) {
    const candles5m = loadCandleFile(symbol, '5m');
    if (candles5m) {
      priceUpdates.set(symbol, candles5m);
      for (const candle of candles5m) {
        events.push({
          type: 'price',
          timestamp: candle.timestamp,
          symbol,
          price: candle.close
        });
      }
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`Total events to process: ${events.length}`);
  console.log('');

  // Run backtest
  const backtest = new CombinedBacktest({
    htfSignalValidityMs: 12 * 60 * 60 * 1000,  // 12 hours
  });

  let positionsOpened = 0;
  let signalsChecked = 0;

  for (const event of events) {
    if (event.type === '4h' && event.signal) {
      backtest.process4hSignal(event.signal);
    } else if (event.type === '5m' && event.signal) {
      signalsChecked++;
      const position = backtest.process5mSignal(event.signal);
      if (position) {
        positionsOpened++;
      }
    } else if (event.type === 'price' && event.symbol && event.price) {
      backtest.updatePositionPrice(event.symbol, event.price, event.timestamp);
    }
  }

  // Close any remaining open positions at last price
  const openPositions = backtest.getOpenPositions();
  for (const pos of openPositions) {
    const candles = priceUpdates.get(pos.symbol);
    if (candles && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      backtest.closePosition(pos.symbol, lastCandle.close, lastCandle.timestamp, 'end_of_backtest');
    }
  }

  // Print results
  console.log('='.repeat(70));
  console.log('RESULTS');
  console.log('='.repeat(70));
  console.log('');

  const stats = backtest.getStats();
  console.log(`5m signals checked for alignment: ${signalsChecked}`);
  console.log(`Positions opened (aligned): ${positionsOpened}`);
  console.log(`Alignment rate: ${signalsChecked > 0 ? (positionsOpened / signalsChecked * 100).toFixed(1) : 0}%`);
  console.log('');
  console.log(`Total Trades: ${stats.totalTrades}`);
  console.log(`Wins: ${stats.wins} | Losses: ${stats.losses}`);
  console.log(`Win Rate: ${stats.winRate}%`);
  console.log(`Profit Factor: ${stats.profitFactor}`);
  console.log(`Total P&L: $${stats.totalPnL}`);
  console.log(`Avg Win: $${stats.avgWin} | Avg Loss: $${stats.avgLoss}`);
  console.log(`Final Balance: $${stats.finalBalance} (started: $${DEFAULT_CONFIG.initialBalance})`);
  console.log('');

  // Show sample trades
  const trades = backtest.getTrades();
  if (trades.length > 0) {
    console.log('Sample trades (first 10):');
    console.log('-'.repeat(70));
    for (const trade of trades.slice(0, 10)) {
      const date = new Date(trade.entryTime).toISOString().split('T')[0];
      const pnlSign = trade.realizedPnL >= 0 ? '+' : '';
      console.log(`  ${date} ${trade.symbol.padEnd(12)} ${trade.direction.toUpperCase().padEnd(5)} ` +
        `4H:${trade.htfDirection.toUpperCase()} 5m:${trade.ltfDirection.toUpperCase()} → ` +
        `${pnlSign}$${trade.realizedPnL.toFixed(2)} (${trade.exitReason})`);
    }
  }

  // Compare with standalone strategies
  console.log('');
  console.log('='.repeat(70));
  console.log('COMPARISON: Combined vs Standalone Strategies');
  console.log('='.repeat(70));
  console.log('');

  // Run 4H normal standalone
  const backtest4hNormal = new CombinedBacktest();
  for (const signal of all4hSignals.sort((a, b) => a.timestamp - b.timestamp)) {
    // Treat 4H signals as direct entries (normal direction)
    if (!backtest4hNormal.getOpenPositions().find(p => p.symbol === signal.symbol)) {
      const fakePosition: Position = {
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: signal.price,
        entryTime: signal.timestamp,
        positionSize: (2000 * 5 / 100) * 10,
        stopLoss: signal.direction === 'long'
          ? signal.price * 0.85
          : signal.price * 1.15,
        highestPrice: signal.price,
        lowestPrice: signal.price,
        trailActivated: false,
        level1Locked: false,
        htfSignalTime: signal.timestamp,
        htfDirection: signal.direction,
        ltfSignalTime: signal.timestamp,
        ltfDirection: signal.direction,
      };
      (backtest4hNormal as any).positions.set(signal.symbol, fakePosition);
    }
  }
  // Update 4H positions with price data
  for (const event of events.filter(e => e.type === 'price').sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.symbol && event.price) {
      backtest4hNormal.updatePositionPrice(event.symbol, event.price, event.timestamp);
    }
  }
  // Close remaining
  for (const pos of backtest4hNormal.getOpenPositions()) {
    const candles = priceUpdates.get(pos.symbol);
    if (candles && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      backtest4hNormal.closePosition(pos.symbol, lastCandle.close, lastCandle.timestamp, 'end_of_backtest');
    }
  }

  // Run 5m fade standalone
  const backtest5mFade = new CombinedBacktest();
  for (const signal of all5mSignals.sort((a, b) => a.timestamp - b.timestamp)) {
    const fadedDirection = signal.direction === 'long' ? 'short' : 'long';
    if (!backtest5mFade.getOpenPositions().find(p => p.symbol === signal.symbol)) {
      const fakePosition: Position = {
        symbol: signal.symbol,
        direction: fadedDirection,
        entryPrice: signal.price,
        entryTime: signal.timestamp,
        positionSize: (2000 * 5 / 100) * 10,
        stopLoss: fadedDirection === 'long'
          ? signal.price * 0.85
          : signal.price * 1.15,
        highestPrice: signal.price,
        lowestPrice: signal.price,
        trailActivated: false,
        level1Locked: false,
        htfSignalTime: signal.timestamp,
        htfDirection: fadedDirection,
        ltfSignalTime: signal.timestamp,
        ltfDirection: signal.direction,
      };
      (backtest5mFade as any).positions.set(signal.symbol, fakePosition);
    }
  }
  for (const event of events.filter(e => e.type === 'price').sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.symbol && event.price) {
      backtest5mFade.updatePositionPrice(event.symbol, event.price, event.timestamp);
    }
  }
  for (const pos of backtest5mFade.getOpenPositions()) {
    const candles = priceUpdates.get(pos.symbol);
    if (candles && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      backtest5mFade.closePosition(pos.symbol, lastCandle.close, lastCandle.timestamp, 'end_of_backtest');
    }
  }

  const stats4h = backtest4hNormal.getStats();
  const stats5m = backtest5mFade.getStats();

  console.log('Strategy Comparison:');
  console.log('-'.repeat(70));
  console.log(`${'Strategy'.padEnd(25)} ${'Trades'.padStart(8)} ${'Win%'.padStart(8)} ${'PF'.padStart(8)} ${'P&L'.padStart(12)}`);
  console.log('-'.repeat(70));
  console.log(`${'4H Normal (standalone)'.padEnd(25)} ${stats4h.totalTrades.toString().padStart(8)} ${(stats4h.winRate + '%').padStart(8)} ${stats4h.profitFactor.padStart(8)} ${('$' + stats4h.totalPnL).padStart(12)}`);
  console.log(`${'5m Fade (standalone)'.padEnd(25)} ${stats5m.totalTrades.toString().padStart(8)} ${(stats5m.winRate + '%').padStart(8)} ${stats5m.profitFactor.padStart(8)} ${('$' + stats5m.totalPnL).padStart(12)}`);
  console.log(`${'Combined (4H+5m aligned)'.padEnd(25)} ${stats.totalTrades.toString().padStart(8)} ${(stats.winRate + '%').padStart(8)} ${stats.profitFactor.padStart(8)} ${('$' + stats.totalPnL).padStart(12)}`);
  console.log('-'.repeat(70));
  console.log('');
  console.log('Note: Combined strategy filters for confluence, so fewer trades but potentially higher quality.');
}

main().catch(console.error);
