#!/usr/bin/env node
/**
 * HISTORICAL STRATEGY BACKTEST
 *
 * Tests the Focus Mode strategy against 30+ days of historical MEXC data.
 * This gives us statistically significant sample sizes to validate the strategy.
 *
 * Usage:
 *   npm run historical-backtest -- --help
 *   npm run historical-backtest -- --days 30 --symbols 20
 *   npm run historical-backtest -- --spot-only --compare
 */

import { getKlines } from './mexc-api.js';
import { BackburnerDetector } from './backburner-detector.js';
import { calculateRSI, getCurrentRSI } from './indicators.js';
import type { Candle, Timeframe, BackburnerSetup } from './types.js';

// ============= Configuration =============

interface HistoricalBacktestConfig {
  // Data parameters
  daysBack: number;
  symbols: string[];
  timeframes: Timeframe[];

  // Trading parameters
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;  // 1 for spot, higher for futures
  longOnly: boolean;

  // Risk management
  initialStopPercent: number;
  trailTriggerPercent: number;  // ROI% to activate trailing
  trailStepPercent: number;     // Trail distance
  takeProfitPercent: number;    // 0 = disabled

  // Fees
  feePercent: number;
  slippagePercent: number;

  // Signal filtering
  minImpulsePercent: number;
  minRsiExtreme: number;  // How extreme RSI must be (30 for oversold, 70 for overbought)
}

const DEFAULT_CONFIG: HistoricalBacktestConfig = {
  daysBack: 30,
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT',
    'UNIUSDT', 'ATOMUSDT', 'LTCUSDT', 'NEARUSDT', 'APTUSDT',
    'ARBUSDT', 'OPUSDT', 'INJUSDT', 'SUIUSDT', 'SEIUSDT'
  ],
  timeframes: ['15m'] as Timeframe[],
  initialBalance: 2000,
  positionSizePercent: 25,
  leverage: 1,  // Spot by default
  longOnly: true,
  initialStopPercent: 5,
  trailTriggerPercent: 3,  // At 1x, this is 3% price move
  trailStepPercent: 1.5,
  takeProfitPercent: 0,
  feePercent: 0.1,
  slippagePercent: 0.05,
  minImpulsePercent: 3,
  minRsiExtreme: 30,
};

// ============= Types =============

interface SimulatedPosition {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  positionSize: number;
  leverage: number;
  stopLoss: number;
  trailActivated: boolean;
  highestPrice: number;
  lowestPrice: number;
}

interface ClosedTrade {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  positionSize: number;
  leverage: number;
  pnlDollars: number;
  pnlPercent: number;
  exitReason: string;
  durationMs: number;
}

interface BacktestResult {
  config: HistoricalBacktestConfig;
  totalSignals: number;
  tradesExecuted: number;
  startBalance: number;
  endBalance: number;
  totalPnl: number;
  totalReturn: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  avgHoldTime: number;
  trades: ClosedTrade[];
  bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>;
  dailyReturns: { date: string; pnl: number; trades: number }[];
}

// ============= Data Fetching =============

async function fetchHistoricalCandles(
  symbol: string,
  timeframe: Timeframe,
  daysBack: number
): Promise<Candle[]> {
  // MEXC returns max 1000 candles per request
  // For 15m candles: 1000 * 15 = 15000 minutes = ~10.4 days
  // For 30 days we need ~3 requests

  const timeframeMinutes: Record<Timeframe, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
  };

  const minutesPerCandle = timeframeMinutes[timeframe];
  const totalMinutesNeeded = daysBack * 24 * 60;
  const candlesNeeded = Math.ceil(totalMinutesNeeded / minutesPerCandle);

  // MEXC limit is 1000 candles, but let's be safe
  const candlesToFetch = Math.min(candlesNeeded, 1000);

  try {
    const candles = await getKlines(symbol, timeframe, candlesToFetch);
    return candles;
  } catch (error) {
    console.error(`Failed to fetch ${symbol}: ${(error as Error).message}`);
    return [];
  }
}

// ============= Signal Detection =============

interface DetectedSignal {
  timestamp: number;
  symbol: string;
  direction: 'long' | 'short';
  price: number;
  rsi: number;
  impulsePercent: number;
}

function detectSignals(
  symbol: string,
  candles: Candle[],
  config: HistoricalBacktestConfig
): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  if (candles.length < 50) return signals;

  const detector = new BackburnerDetector({
    rsiPeriod: 14,
    rsiOversoldThreshold: config.minRsiExtreme,
    rsiOverboughtThreshold: 100 - config.minRsiExtreme,
    minImpulsePercent: config.minImpulsePercent,
  });

  // Walk through candles and detect signals
  // We use the candle timestamp, not setup.detectedAt (which is Date.now())
  for (let i = 50; i < candles.length; i++) {
    const windowCandles = candles.slice(0, i + 1);
    const currentCandle = candles[i];
    const setups = detector.analyzeSymbol(symbol, '15m', windowCandles);

    for (const setup of setups) {
      // Only take "triggered" or "deep_extreme" states (active setups)
      if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
        // Use the candle's timestamp, not setup.detectedAt
        const signalTimestamp = currentCandle.timestamp;

        // Check if we already have this signal (within 2 candles = 30 mins for 15m)
        const recentSignal = signals.find(s =>
          s.symbol === symbol &&
          s.direction === setup.direction &&
          Math.abs(s.timestamp - signalTimestamp) < 30 * 60 * 1000  // 30 minutes
        );

        if (!recentSignal) {
          signals.push({
            timestamp: signalTimestamp,
            symbol,
            direction: setup.direction,
            price: currentCandle.close,  // Use candle close, not setup.currentPrice
            rsi: setup.currentRSI,
            impulsePercent: setup.impulsePercentMove,
          });
        }
      }
    }
  }

  return signals;
}

// ============= Trade Simulation =============

function simulateTrades(
  signals: DetectedSignal[],
  allCandles: Map<string, Candle[]>,
  config: HistoricalBacktestConfig
): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  let balance = config.initialBalance;

  // Sort signals by timestamp
  const sortedSignals = [...signals].sort((a, b) => a.timestamp - b.timestamp);

  // Track active position per symbol
  const activePositions = new Map<string, SimulatedPosition>();

  for (const signal of sortedSignals) {
    // Skip shorts if long-only mode
    if (config.longOnly && signal.direction === 'short') continue;

    // Skip if already have position in this symbol
    if (activePositions.has(signal.symbol)) continue;

    // Calculate position size
    const positionSize = balance * (config.positionSizePercent / 100);
    if (positionSize < 10) continue;

    // Apply slippage to entry
    const slippage = signal.price * (config.slippagePercent / 100);
    const entryPrice = signal.direction === 'long'
      ? signal.price + slippage
      : signal.price - slippage;

    // Calculate initial stop loss
    const stopDistance = entryPrice * (config.initialStopPercent / 100);
    const stopLoss = signal.direction === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    // Create position
    const position: SimulatedPosition = {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice,
      entryTime: signal.timestamp,
      positionSize,
      leverage: config.leverage,
      stopLoss,
      trailActivated: false,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
    };

    activePositions.set(signal.symbol, position);

    // Simulate position through subsequent candles
    const candles = allCandles.get(signal.symbol);
    if (!candles) continue;

    // Find candles after entry
    const entryIndex = candles.findIndex(c => c.timestamp >= signal.timestamp);
    if (entryIndex === -1) continue;

    let exitPrice = 0;
    let exitTime = 0;
    let exitReason = '';

    for (let i = entryIndex + 1; i < candles.length; i++) {
      const candle = candles[i];

      // Update highest/lowest
      if (candle.high > position.highestPrice) position.highestPrice = candle.high;
      if (candle.low < position.lowestPrice) position.lowestPrice = candle.low;

      // Calculate current P&L
      const currentPrice = candle.close;
      const priceDiff = position.direction === 'long'
        ? currentPrice - position.entryPrice
        : position.entryPrice - currentPrice;
      const currentPnlPercent = (priceDiff / position.entryPrice) * 100 * position.leverage;

      // Check trail activation
      if (!position.trailActivated && currentPnlPercent >= config.trailTriggerPercent) {
        position.trailActivated = true;

        // Move stop to breakeven + small profit
        const newStopPnl = config.trailTriggerPercent - config.trailStepPercent;
        const newStopDistance = position.entryPrice * (newStopPnl / 100 / position.leverage);
        position.stopLoss = position.direction === 'long'
          ? position.entryPrice + newStopDistance
          : position.entryPrice - newStopDistance;
      }

      // Update trailing stop if activated
      if (position.trailActivated) {
        const peakPrice = position.direction === 'long' ? position.highestPrice : position.lowestPrice;
        const peakPnlPercent = position.direction === 'long'
          ? ((peakPrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage
          : ((position.entryPrice - peakPrice) / position.entryPrice) * 100 * position.leverage;

        const trailStopPnl = peakPnlPercent - config.trailStepPercent;
        if (trailStopPnl > 0) {
          const trailStopDistance = position.entryPrice * (trailStopPnl / 100 / position.leverage);
          const newStop = position.direction === 'long'
            ? position.entryPrice + trailStopDistance
            : position.entryPrice - trailStopDistance;

          // Only move stop in favorable direction
          if (position.direction === 'long' && newStop > position.stopLoss) {
            position.stopLoss = newStop;
          } else if (position.direction === 'short' && newStop < position.stopLoss) {
            position.stopLoss = newStop;
          }
        }
      }

      // Check stop loss hit
      if (position.direction === 'long' && candle.low <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitTime = candle.timestamp;
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
        break;
      } else if (position.direction === 'short' && candle.high >= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitTime = candle.timestamp;
        exitReason = position.trailActivated ? 'trailing_stop' : 'stop_loss';
        break;
      }

      // Check take profit if enabled
      if (config.takeProfitPercent > 0) {
        const tpDistance = position.entryPrice * (config.takeProfitPercent / 100);
        const tpPrice = position.direction === 'long'
          ? position.entryPrice + tpDistance
          : position.entryPrice - tpDistance;

        if (position.direction === 'long' && candle.high >= tpPrice) {
          exitPrice = tpPrice;
          exitTime = candle.timestamp;
          exitReason = 'take_profit';
          break;
        } else if (position.direction === 'short' && candle.low <= tpPrice) {
          exitPrice = tpPrice;
          exitTime = candle.timestamp;
          exitReason = 'take_profit';
          break;
        }
      }
    }

    // If still open at end of data, close at last price
    if (exitPrice === 0) {
      const lastCandle = candles[candles.length - 1];
      exitPrice = lastCandle.close;
      exitTime = lastCandle.timestamp;
      exitReason = 'end_of_data';
    }

    // Apply exit slippage
    exitPrice = position.direction === 'long'
      ? exitPrice - (exitPrice * config.slippagePercent / 100)
      : exitPrice + (exitPrice * config.slippagePercent / 100);

    // Calculate P&L
    const priceDiff = position.direction === 'long'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    const grossPnl = (priceDiff / position.entryPrice) * position.positionSize * position.leverage;
    const fees = position.positionSize * (config.feePercent / 100) * 2;
    const netPnl = grossPnl - fees;
    const pnlPercent = (netPnl / position.positionSize) * 100;

    trades.push({
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice,
      entryTime: position.entryTime,
      exitTime,
      positionSize: position.positionSize,
      leverage: position.leverage,
      pnlDollars: netPnl,
      pnlPercent,
      exitReason,
      durationMs: exitTime - position.entryTime,
    });

    // Update balance
    balance += netPnl;

    // Remove position
    activePositions.delete(signal.symbol);
  }

  return trades;
}

// ============= Results Calculation =============

function calculateResults(
  trades: ClosedTrade[],
  config: HistoricalBacktestConfig,
  totalSignals: number
): BacktestResult {
  let balance = config.initialBalance;
  let peakBalance = config.initialBalance;
  let maxDrawdown = 0;

  const wins = trades.filter(t => t.pnlDollars > 0);
  const losses = trades.filter(t => t.pnlDollars <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));

  // Calculate running balance for drawdown
  for (const trade of trades) {
    balance += trade.pnlDollars;
    if (balance > peakBalance) peakBalance = balance;
    const dd = peakBalance - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Reset for final balance
  balance = config.initialBalance + trades.reduce((s, t) => s + t.pnlDollars, 0);

  // By symbol
  const bySymbol: Record<string, { trades: number; pnl: number; winRate: number }> = {};
  for (const trade of trades) {
    if (!bySymbol[trade.symbol]) {
      bySymbol[trade.symbol] = { trades: 0, pnl: 0, winRate: 0 };
    }
    bySymbol[trade.symbol].trades++;
    bySymbol[trade.symbol].pnl += trade.pnlDollars;
  }
  for (const sym of Object.keys(bySymbol)) {
    const symTrades = trades.filter(t => t.symbol === sym);
    const symWins = symTrades.filter(t => t.pnlDollars > 0).length;
    bySymbol[sym].winRate = symTrades.length > 0 ? (symWins / symTrades.length) * 100 : 0;
  }

  // Daily returns
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const trade of trades) {
    const date = new Date(trade.entryTime).toISOString().split('T')[0];
    if (!dailyMap.has(date)) dailyMap.set(date, { pnl: 0, trades: 0 });
    const day = dailyMap.get(date)!;
    day.pnl += trade.pnlDollars;
    day.trades++;
  }
  const dailyReturns = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    config,
    totalSignals,
    tradesExecuted: trades.length,
    startBalance: config.initialBalance,
    endBalance: balance,
    totalPnl: balance - config.initialBalance,
    totalReturn: ((balance - config.initialBalance) / config.initialBalance) * 100,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    maxDrawdownPercent: peakBalance > 0 ? (maxDrawdown / peakBalance) * 100 : 0,
    avgHoldTime: trades.length > 0
      ? trades.reduce((s, t) => s + t.durationMs, 0) / trades.length
      : 0,
    trades,
    bySymbol,
    dailyReturns,
  };
}

// ============= Report Generation =============

function printReport(result: BacktestResult): void {
  const c = result.config;

  console.log('\n' + '═'.repeat(80));
  console.log('HISTORICAL STRATEGY BACKTEST REPORT');
  console.log('═'.repeat(80));

  console.log('\nCONFIGURATION:');
  console.log(`  Days Analyzed:      ${c.daysBack}`);
  console.log(`  Symbols:            ${c.symbols.length}`);
  console.log(`  Timeframes:         ${c.timeframes.join(', ')}`);
  console.log(`  Initial Balance:    $${c.initialBalance.toLocaleString()}`);
  console.log(`  Position Size:      ${c.positionSizePercent}%`);
  console.log(`  Leverage:           ${c.leverage}x ${c.leverage === 1 ? '(SPOT)' : '(FUTURES)'}`);
  console.log(`  Mode:               ${c.longOnly ? 'LONG ONLY' : 'LONG + SHORT'}`);

  console.log('\n' + '─'.repeat(80));
  console.log('PERFORMANCE SUMMARY');
  console.log('─'.repeat(80));
  console.log(`  Signals Detected:   ${result.totalSignals}`);
  console.log(`  Trades Executed:    ${result.tradesExecuted}`);
  console.log('');
  console.log(`  Start Balance:      $${result.startBalance.toLocaleString()}`);
  console.log(`  End Balance:        $${result.endBalance.toFixed(2)}`);
  console.log(`  Total P&L:          ${result.totalPnl >= 0 ? '+' : ''}$${result.totalPnl.toFixed(2)}`);
  console.log(`  Total Return:       ${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn.toFixed(2)}%`);
  console.log(`  Max Drawdown:       $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPercent.toFixed(2)}%)`);

  console.log('\n' + '─'.repeat(80));
  console.log('TRADE STATISTICS');
  console.log('─'.repeat(80));
  console.log(`  Wins:               ${result.wins}`);
  console.log(`  Losses:             ${result.losses}`);
  console.log(`  Win Rate:           ${result.winRate.toFixed(1)}%`);
  console.log(`  Avg Win:            $${result.avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:           $${result.avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor:      ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
  console.log(`  Avg Hold Time:      ${formatDuration(result.avgHoldTime)}`);

  // Top symbols
  const topSymbols = Object.entries(result.bySymbol)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 10);

  if (topSymbols.length > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log('TOP SYMBOLS');
    console.log('─'.repeat(80));
    for (const [sym, data] of topSymbols) {
      const pnlStr = `${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`;
      console.log(`  ${sym.padEnd(12)} | ${String(data.trades).padStart(3)} trades | ${pnlStr.padStart(10)} | ${data.winRate.toFixed(0)}% win`);
    }
  }

  // Daily returns (last 10 days)
  if (result.dailyReturns.length > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log('DAILY RETURNS (last 10 days)');
    console.log('─'.repeat(80));
    const recentDays = result.dailyReturns.slice(-10);
    for (const day of recentDays) {
      const pnlStr = `${day.pnl >= 0 ? '+' : ''}$${day.pnl.toFixed(2)}`;
      console.log(`  ${day.date} | ${String(day.trades).padStart(3)} trades | ${pnlStr}`);
    }
  }

  console.log('\n' + '═'.repeat(80));
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ============= CLI =============

function printHelp(): void {
  console.log(`
HISTORICAL STRATEGY BACKTEST

Tests Focus Mode strategy against historical MEXC candle data.

Usage:
  npm run historical-backtest -- [options]

Options:
  --days N            Days of historical data (default: 30, max ~10 for 15m)
  --symbols N         Number of symbols to test (default: 20)
  --balance N         Initial balance (default: 2000)
  --position-pct N    Position size % (default: 25)
  --leverage N        Leverage (1=spot, default: 1)
  --long-only         Only take long positions (default)
  --both-directions   Take both long and short
  --compare           Compare spot vs leveraged
  --help              Show this help

Examples:
  npm run historical-backtest -- --days 10 --symbols 20
  npm run historical-backtest -- --leverage 10 --both-directions
  npm run historical-backtest -- --compare
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const config: HistoricalBacktestConfig = { ...DEFAULT_CONFIG };
  let compare = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help':
      case '-h':
        printHelp();
        return;
      case '--days':
        config.daysBack = parseInt(args[++i]);
        break;
      case '--symbols':
        const numSymbols = parseInt(args[++i]);
        config.symbols = DEFAULT_CONFIG.symbols.slice(0, numSymbols);
        break;
      case '--balance':
        config.initialBalance = parseFloat(args[++i]);
        break;
      case '--position-pct':
        config.positionSizePercent = parseFloat(args[++i]);
        break;
      case '--leverage':
        config.leverage = parseFloat(args[++i]);
        break;
      case '--long-only':
        config.longOnly = true;
        break;
      case '--both-directions':
        config.longOnly = false;
        break;
      case '--compare':
        compare = true;
        break;
    }
  }

  console.log('HISTORICAL STRATEGY BACKTEST');
  console.log('═'.repeat(50));
  console.log(`Fetching ${config.daysBack} days of data for ${config.symbols.length} symbols...`);
  console.log('');

  // Fetch candles for all symbols
  const allCandles = new Map<string, Candle[]>();
  let fetchedCount = 0;

  for (const symbol of config.symbols) {
    process.stdout.write(`\r  Fetching ${symbol}... (${++fetchedCount}/${config.symbols.length})`);

    for (const timeframe of config.timeframes) {
      const candles = await fetchHistoricalCandles(symbol, timeframe, config.daysBack);
      if (candles.length > 0) {
        allCandles.set(symbol, candles);
      }
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n');
  console.log(`Loaded candles for ${allCandles.size} symbols`);

  // Detect signals
  console.log('Detecting signals...');
  let allSignals: DetectedSignal[] = [];

  for (const [symbol, candles] of allCandles) {
    const signals = detectSignals(symbol, candles, config);
    allSignals = allSignals.concat(signals);
  }

  console.log(`Found ${allSignals.length} signals`);

  // Debug: print signal details
  if (allSignals.length > 0 && allSignals.length <= 20) {
    console.log('\nSignal details:');
    for (const sig of allSignals) {
      const candles = allCandles.get(sig.symbol);
      const candleCount = candles?.length || 0;
      const firstTs = candles?.[0]?.timestamp || 0;
      const lastTs = candles?.[candles!.length - 1]?.timestamp || 0;
      console.log(`  ${sig.symbol} @ ${new Date(sig.timestamp).toISOString()} price=${sig.price.toFixed(4)} rsi=${sig.rsi.toFixed(1)} dir=${sig.direction}`);
      console.log(`    Candles: ${candleCount}, range: ${new Date(firstTs).toISOString()} - ${new Date(lastTs).toISOString()}`);

      // Check if signal timestamp is within candle range
      const entryIdx = candles?.findIndex(c => c.timestamp >= sig.timestamp);
      console.log(`    Entry index: ${entryIdx}`);
    }
  }

  if (compare) {
    // Run comparison: spot vs leveraged
    console.log('\nRunning comparison: SPOT (1x) vs LEVERAGED (10x)...\n');

    // Spot config
    const spotConfig = { ...config, leverage: 1, longOnly: true };
    const spotTrades = simulateTrades(allSignals, allCandles, spotConfig);
    const spotResult = calculateResults(spotTrades, spotConfig, allSignals.length);

    // Leveraged config
    const levConfig = { ...config, leverage: 10, longOnly: false };
    const levTrades = simulateTrades(allSignals, allCandles, levConfig);
    const levResult = calculateResults(levTrades, levConfig, allSignals.length);

    console.log('═'.repeat(80));
    console.log('COMPARISON: SPOT vs LEVERAGED');
    console.log('═'.repeat(80));
    console.log('');
    console.log('                     |     SPOT (1x)    |   LEVERAGED (10x)');
    console.log('-'.repeat(60));
    console.log(`Mode                 | Long Only        | Long + Short`);
    console.log(`Trades               | ${String(spotResult.tradesExecuted).padStart(16)} | ${String(levResult.tradesExecuted).padStart(16)}`);
    console.log(`End Balance          | $${spotResult.endBalance.toFixed(0).padStart(14)} | $${levResult.endBalance.toFixed(0).padStart(14)}`);
    console.log(`Total Return         | ${(spotResult.totalReturn >= 0 ? '+' : '') + spotResult.totalReturn.toFixed(1) + '%'} | ${(levResult.totalReturn >= 0 ? '+' : '') + levResult.totalReturn.toFixed(1) + '%'}`);
    console.log(`Win Rate             | ${spotResult.winRate.toFixed(1).padStart(15)}% | ${levResult.winRate.toFixed(1).padStart(15)}%`);
    console.log(`Profit Factor        | ${(spotResult.profitFactor === Infinity ? '∞' : spotResult.profitFactor.toFixed(2)).padStart(16)} | ${(levResult.profitFactor === Infinity ? '∞' : levResult.profitFactor.toFixed(2)).padStart(16)}`);
    console.log(`Max Drawdown         | ${spotResult.maxDrawdownPercent.toFixed(1).padStart(15)}% | ${levResult.maxDrawdownPercent.toFixed(1).padStart(15)}%`);
    console.log('');
    console.log('═'.repeat(80));

  } else {
    // Single run
    const trades = simulateTrades(allSignals, allCandles, config);
    const result = calculateResults(trades, config, allSignals.length);
    printReport(result);
  }
}

main().catch(console.error);
