#!/usr/bin/env node
/**
 * ALIGNED Spot-Only Backtest
 *
 * Only takes trades that ALIGN with the overall market bias:
 * - Long trades only when BTC is bullish (trending up)
 * - Skip longs when BTC is bearish
 *
 * Market bias determined by:
 * 1. BTC price vs 20-period EMA (above = bullish, below = bearish)
 * 2. BTC RSI > 50 = bullish, < 50 = bearish
 * 3. BTC higher highs/higher lows over last N candles
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
  positionSize: number;
  dollarValue: number;
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
  marketBias: string;
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
  alignWithMarket: boolean;
}

// ============= Market Bias Detection =============

interface MarketBias {
  timestamp: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  btcPrice: number;
  ema20: number;
  rsi: number;
  trend: string;
}

function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
    sum += prices[i];
  }
  ema.push(sum / Math.min(period, prices.length));

  // Calculate rest of EMA
  for (let i = period; i < prices.length; i++) {
    const value = (prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
    ema.push(value);
  }

  return ema;
}

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

function detectTrend(candles: Candle[], lookback: number = 10): 'up' | 'down' | 'sideways' {
  if (candles.length < lookback) return 'sideways';

  const recent = candles.slice(-lookback);
  let higherHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high > recent[i - 1].high) higherHighs++;
    if (recent[i].low < recent[i - 1].low) lowerLows++;
  }

  const hhRatio = higherHighs / (lookback - 1);
  const llRatio = lowerLows / (lookback - 1);

  if (hhRatio > 0.6 && llRatio < 0.4) return 'up';
  if (llRatio > 0.6 && hhRatio < 0.4) return 'down';
  return 'sideways';
}

function buildMarketBiasMap(btcCandles: Candle[]): Map<number, MarketBias> {
  const biasMap = new Map<number, MarketBias>();

  const closes = btcCandles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const rsiValues = calculateRSI(closes, 14);

  // Align indices (EMA starts at index 19, RSI at index 14)
  const emaOffset = 19;
  const rsiOffset = 14;
  const startIndex = Math.max(emaOffset, rsiOffset);

  for (let i = startIndex; i < btcCandles.length; i++) {
    const candle = btcCandles[i];
    const emaIdx = i - emaOffset;
    const rsiIdx = i - rsiOffset;

    if (emaIdx < 0 || emaIdx >= ema20.length) continue;
    if (rsiIdx < 0 || rsiIdx >= rsiValues.length) continue;

    const currentEma = ema20[emaIdx];
    const currentRsi = rsiValues[rsiIdx];
    const trend = detectTrend(btcCandles.slice(0, i + 1), 10);

    // Determine bias
    let bullishSignals = 0;
    let bearishSignals = 0;

    // Price vs EMA
    if (candle.close > currentEma) bullishSignals++;
    else bearishSignals++;

    // RSI
    if (currentRsi > 55) bullishSignals++;
    else if (currentRsi < 45) bearishSignals++;

    // Trend
    if (trend === 'up') bullishSignals++;
    else if (trend === 'down') bearishSignals++;

    let bias: 'bullish' | 'bearish' | 'neutral';
    if (bullishSignals >= 2) bias = 'bullish';
    else if (bearishSignals >= 2) bias = 'bearish';
    else bias = 'neutral';

    biasMap.set(candle.timestamp, {
      timestamp: candle.timestamp,
      bias,
      btcPrice: candle.close,
      ema20: currentEma,
      rsi: currentRsi,
      trend,
    });
  }

  return biasMap;
}

function getMarketBiasAtTime(biasMap: Map<number, MarketBias>, timestamp: number): MarketBias | null {
  // Find the closest bias entry at or before the timestamp
  let closestBias: MarketBias | null = null;
  let closestDiff = Infinity;

  for (const [ts, bias] of biasMap) {
    if (ts <= timestamp) {
      const diff = timestamp - ts;
      if (diff < closestDiff) {
        closestDiff = diff;
        closestBias = bias;
      }
    }
  }

  return closestBias;
}

// Signal-based market bias: look at ratio of long vs short signals in a rolling window
function buildSignalBasedBiasMap(signals: LocalSignal[], windowHours: number = 4): Map<number, MarketBias> {
  const biasMap = new Map<number, MarketBias>();
  const windowMs = windowHours * 60 * 60 * 1000;

  // Sort signals by timestamp
  const sorted = [...signals].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const signal of sorted) {
    const ts = new Date(signal.timestamp).getTime();
    const windowStart = ts - windowMs;

    // Count signals in the rolling window
    const windowSignals = sorted.filter(s => {
      const sTs = new Date(s.timestamp).getTime();
      return sTs >= windowStart && sTs < ts;
    });

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (total >= 3) {  // Need at least 3 signals to determine bias
      const longRatio = longs / total;
      if (longRatio > 0.6) bias = 'bullish';
      else if (longRatio < 0.4) bias = 'bearish';
    }

    biasMap.set(ts, {
      timestamp: ts,
      bias,
      btcPrice: signal.price,
      ema20: 0,
      rsi: signal.rsi,
      trend: bias === 'bullish' ? 'up' : bias === 'bearish' ? 'down' : 'sideways',
    });
  }

  return biasMap;
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
        console.log(`Warning: Could not parse ${filePath}`);
      }
    }

    current.setDate(current.getDate() + 1);
  }

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

class AlignedBacktester {
  private config: BacktestConfig;
  private balance: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private initialBalance: number;
  private skippedDueToAlignment: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.initialBalance = config.initialBalance;
  }

  openPosition(signal: LocalSignal, marketBias: MarketBias | null): Position | null {
    if (this.config.longOnly && signal.direction === 'short') {
      return null;
    }

    // Check market alignment
    if (this.config.alignWithMarket && marketBias) {
      // For long trades, only enter if market is bullish
      if (signal.direction === 'long' && marketBias.bias !== 'bullish') {
        this.skippedDueToAlignment++;
        return null;
      }
      // For short trades, only enter if market is bearish
      if (signal.direction === 'short' && marketBias.bias !== 'bearish') {
        this.skippedDueToAlignment++;
        return null;
      }
    }

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    if (this.positions.has(posKey)) {
      return null;
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

    if (position.trailActivated && direction === 'long') {
      const trailStop = position.highestPrice * (1 - this.config.trailStepPercent / 100);
      if (trailStop > position.stopLoss) {
        position.stopLoss = trailStop;
      }
    }

    let exitReason: string | null = null;
    if (direction === 'long' && price <= position.stopLoss) {
      exitReason = position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
    } else if (direction === 'short' && price >= position.stopLoss) {
      exitReason = position.trailActivated ? 'trailing_stop' : (position.level1Locked ? 'breakeven_stop' : 'initial_stop');
    }

    if (exitReason) {
      return this.closePosition(posKey, price, timestamp, exitReason, '');
    }

    return null;
  }

  closePosition(posKey: string, exitPrice: number, exitTime: number, reason: string, marketBias: string): Trade | null {
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
      marketBias,
    };

    this.trades.push(trade);
    return trade;
  }

  closeAllPositions(timestamp: number, lastPrices: Map<string, number>): void {
    for (const [posKey, position] of this.positions) {
      const price = lastPrices.get(position.symbol) || position.entryPrice;
      this.closePosition(posKey, price, timestamp, 'end_of_backtest', '');
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
      skippedDueToAlignment: this.skippedDueToAlignment,
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
  console.log(`MARKET-ALIGNED SPOT BACKTEST (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Compares:');
  console.log('  1. Spot 1x (All longs) - takes every long signal');
  console.log('  2. Spot 1x (Aligned)   - only longs when BTC is bullish');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Load market proxy candles for market bias (try BTC, then SOL, then use signal-based bias)
  console.log('Loading market proxy candles for bias detection...');
  let btcCandles1h = loadCandleFile('BTCUSDT', '1h');
  let btcCandles15m = loadCandleFile('BTCUSDT', '15m');
  let btcCandles5m = loadCandleFile('BTCUSDT', '5m');

  // Fallback to SOL if no BTC
  if (!btcCandles1h && !btcCandles15m && !btcCandles5m) {
    console.log('  No BTC data, trying SOLUSDT...');
    btcCandles1h = loadCandleFile('SOLUSDT', '1h');
    btcCandles15m = loadCandleFile('SOLUSDT', '15m');
    btcCandles5m = loadCandleFile('SOLUSDT', '5m');
  }

  // Fallback to any available major coin
  if (!btcCandles1h && !btcCandles15m && !btcCandles5m) {
    console.log('  No SOL data, trying first available coin...');
    const candlesDir = path.join(process.cwd(), 'data', 'candles');
    const dirs = fs.readdirSync(candlesDir).filter(d => {
      const stat = fs.statSync(path.join(candlesDir, d));
      return stat.isDirectory();
    });
    for (const symbol of dirs) {
      btcCandles1h = loadCandleFile(symbol, '1h');
      btcCandles15m = loadCandleFile(symbol, '15m');
      btcCandles5m = loadCandleFile(symbol, '5m');
      if (btcCandles1h || btcCandles15m || btcCandles5m) {
        console.log(`  Using ${symbol} as market proxy`);
        break;
      }
    }
  }

  // If still no data, use signal-based market bias
  const useSignalBasedBias = !btcCandles1h && !btcCandles15m && !btcCandles5m;
  if (useSignalBasedBias) {
    console.log('  No candle data available, using signal-based market bias...');
    console.log('  (Will determine bias from ratio of long vs short signals in rolling window)');
  }

  // Load signals first (needed for signal-based bias if no candles)
  console.log('\nLoading triggered signals...');
  const signals = loadSignalsFromFiles(startStr, endStr);
  console.log(`Found ${signals.length} unique triggered signals`);

  if (signals.length === 0) {
    console.log('No signals found.');
    return;
  }

  // Build market bias maps for each timeframe
  let biasMap1h: Map<number, MarketBias>;
  let biasMap15m: Map<number, MarketBias>;
  let biasMap5m: Map<number, MarketBias>;

  if (useSignalBasedBias) {
    // Use signal-based bias (ratio of long vs short signals)
    console.log('\nBuilding signal-based market bias...');
    biasMap1h = buildSignalBasedBiasMap(signals, 4);  // 4 hour window
    biasMap15m = buildSignalBasedBiasMap(signals, 2); // 2 hour window
    biasMap5m = buildSignalBasedBiasMap(signals, 1);  // 1 hour window
  } else {
    biasMap1h = btcCandles1h ? buildMarketBiasMap(btcCandles1h) : new Map();
    biasMap15m = btcCandles15m ? buildMarketBiasMap(btcCandles15m) : new Map();
    biasMap5m = btcCandles5m ? buildMarketBiasMap(btcCandles5m) : new Map();
  }

  console.log(`  1h bias entries: ${biasMap1h.size}`);
  console.log(`  15m bias entries: ${biasMap15m.size}`);
  console.log(`  5m bias entries: ${biasMap5m.size}`);

  // Show market bias distribution
  const countBias = (map: Map<number, MarketBias>) => {
    let bullish = 0, bearish = 0, neutral = 0;
    for (const b of map.values()) {
      if (b.bias === 'bullish') bullish++;
      else if (b.bias === 'bearish') bearish++;
      else neutral++;
    }
    return { bullish, bearish, neutral };
  };

  const bias1h = countBias(biasMap1h);
  console.log(`\n  1h Market Bias: ${bias1h.bullish} bullish, ${bias1h.bearish} bearish, ${bias1h.neutral} neutral`);
  const totalBias = bias1h.bullish + bias1h.bearish + bias1h.neutral;
  if (totalBias > 0) {
    console.log(`     Bullish: ${(bias1h.bullish / totalBias * 100).toFixed(1)}%, Bearish: ${(bias1h.bearish / totalBias * 100).toFixed(1)}%`);
  }

  const longSignals = signals.filter(s => s.direction === 'long');
  console.log(`  Long signals: ${longSignals.length}`);

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

  // Strategy 1: All longs (no alignment)
  console.log('\nRunning Spot 1x (All Longs)...');
  const allLongsBacktester = new AlignedBacktester({
    ...baseConfig,
    alignWithMarket: false,
  });

  // Strategy 2: Aligned longs only
  console.log('Running Spot 1x (Aligned with BTC)...');
  const alignedBacktester = new AlignedBacktester({
    ...baseConfig,
    alignWithMarket: true,
  });

  // Process signals
  for (const signal of signals) {
    const timestamp = new Date(signal.timestamp).getTime();

    // Get appropriate bias map for signal timeframe
    let biasMap: Map<number, MarketBias>;
    if (signal.timeframe === '1h' || signal.timeframe === '4h') {
      biasMap = biasMap1h;
    } else if (signal.timeframe === '15m') {
      biasMap = biasMap15m.size > 0 ? biasMap15m : biasMap1h;
    } else {
      biasMap = biasMap5m.size > 0 ? biasMap5m : biasMap15m.size > 0 ? biasMap15m : biasMap1h;
    }

    const marketBias = getMarketBiasAtTime(biasMap, timestamp);

    // All longs strategy
    const pos1 = allLongsBacktester.openPosition(signal, null);

    // Aligned strategy
    const pos2 = alignedBacktester.openPosition(signal, marketBias);

    // Simulate price updates for both
    const candles = loadCandleFile(signal.symbol, signal.timeframe);
    if (!candles) continue;

    const posKey = `${signal.symbol}-${signal.timeframe}`;
    const entryTime = timestamp;

    for (const candle of candles) {
      if (candle.timestamp <= entryTime) continue;

      // Update all longs
      if (allLongsBacktester.getPositions().has(posKey)) {
        allLongsBacktester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        allLongsBacktester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        allLongsBacktester.updatePositionPrice(posKey, candle.close, candle.timestamp);
      }

      // Update aligned
      if (alignedBacktester.getPositions().has(posKey)) {
        alignedBacktester.updatePositionPrice(posKey, candle.high, candle.timestamp);
        alignedBacktester.updatePositionPrice(posKey, candle.low, candle.timestamp);
        alignedBacktester.updatePositionPrice(posKey, candle.close, candle.timestamp);
      }

      // Break if both positions closed
      if (!allLongsBacktester.getPositions().has(posKey) &&
          !alignedBacktester.getPositions().has(posKey)) {
        break;
      }
    }
  }

  // Close remaining positions
  const lastPrices = new Map<string, number>();
  for (const signal of signals) {
    lastPrices.set(signal.symbol, signal.price);
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
    'Spot 1x (All Longs)'.padEnd(30) +
    allStats.totalTrades.toString().padStart(8) +
    '0'.padStart(10) +
    `${allStats.winRate}%`.padStart(8) +
    allStats.profitFactor.padStart(8) +
    `$${allStats.totalPnL}`.padStart(12)
  );

  console.log(
    'Spot 1x (Aligned w/ BTC)'.padEnd(30) +
    alignedStats.totalTrades.toString().padStart(8) +
    alignedStats.skippedDueToAlignment.toString().padStart(10) +
    `${alignedStats.winRate}%`.padStart(8) +
    alignedStats.profitFactor.padStart(8) +
    `$${alignedStats.totalPnL}`.padStart(12)
  );

  console.log('-'.repeat(80));

  // Breakdown by timeframe
  console.log('\n📊 Timeframe Breakdown:');
  console.log('-'.repeat(60));
  console.log('Timeframe'.padEnd(10) + 'All Longs'.padStart(20) + 'Aligned'.padStart(20));
  console.log('-'.repeat(60));

  const timeframes = ['5m', '15m', '1h', '4h'];
  for (const tf of timeframes) {
    const allTf = allStats.byTimeframe[tf];
    const alignedTf = alignedStats.byTimeframe[tf];

    const allStr = allTf ? `${allTf.trades} ($${allTf.pnl.toFixed(0)})` : '-';
    const alignedStr = alignedTf ? `${alignedTf.trades} ($${alignedTf.pnl.toFixed(0)})` : '-';

    console.log(tf.padEnd(10) + allStr.padStart(20) + alignedStr.padStart(20));
  }

  // Key insight
  console.log('\n' + '='.repeat(80));
  console.log('KEY INSIGHT');
  console.log('='.repeat(80));

  const allPnL = parseFloat(allStats.totalPnL);
  const alignedPnL = parseFloat(alignedStats.totalPnL);
  const improvement = alignedPnL - allPnL;

  console.log(`\nAll Longs P&L:      $${allPnL.toFixed(2)}`);
  console.log(`Aligned P&L:        $${alignedPnL.toFixed(2)}`);
  console.log(`Improvement:        $${improvement.toFixed(2)} (${improvement > 0 ? '+' : ''}${(improvement / Math.abs(allPnL) * 100).toFixed(1)}%)`);

  console.log(`\nTrades skipped due to bearish market: ${alignedStats.skippedDueToAlignment}`);

  if (alignedPnL > allPnL) {
    console.log('\n✅ MARKET ALIGNMENT IMPROVES PERFORMANCE!');
    console.log('   Waiting for bullish conditions before entering longs pays off.');
  } else if (alignedPnL < allPnL) {
    console.log('\n⚠️ Market alignment did NOT help in this period.');
    console.log('   The skipped trades would have been profitable.');
  } else {
    console.log('\n➖ Market alignment had minimal impact.');
  }

  // Show sample aligned vs skipped analysis
  const alignedTrades = alignedBacktester.getTrades();
  const allTrades = allLongsBacktester.getTrades();

  // Find trades that were in "all" but not in "aligned" (skipped due to bearish)
  const alignedSymbols = new Set(alignedTrades.map(t => `${t.symbol}-${t.entryTime}`));
  const skippedTrades = allTrades.filter(t => !alignedSymbols.has(`${t.symbol}-${t.entryTime}`));

  if (skippedTrades.length > 0) {
    const skippedWins = skippedTrades.filter(t => t.realizedPnL > 0);
    const skippedPnL = skippedTrades.reduce((sum, t) => sum + t.realizedPnL, 0);

    console.log(`\n📋 Trades Skipped (bearish market):`);
    console.log(`   Count: ${skippedTrades.length}`);
    console.log(`   Would have won: ${skippedWins.length} (${(skippedWins.length / skippedTrades.length * 100).toFixed(1)}%)`);
    console.log(`   Would have P&L: $${skippedPnL.toFixed(2)}`);

    if (skippedPnL < 0) {
      console.log('\n   ✅ Good decision to skip - they would have lost money!');
    } else {
      console.log('\n   ⚠️ Missed opportunity - they would have been profitable');
    }
  }
}

main().catch(console.error);
