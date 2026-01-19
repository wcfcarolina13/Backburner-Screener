/**
 * Backtest Engine - Replay historical price data to test strategies
 *
 * Uses actual OHLC candle data to simulate position management,
 * providing accurate stop/TP hit detection based on price paths.
 */

import fs from 'fs';
import path from 'path';
import { Candle, Timeframe, MarketType } from './types.js';
import { getCandles, getCandlesFromEntry, timeframeToMs } from './candle-store.js';
import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

const costsCalculator = getExecutionCostsCalculator();

// ============= Types =============

export interface StrategyConfig {
  name: string;
  leverage: number;
  positionSizePercent: number;
  initialStopLossPercent: number;  // Stop loss as % of entry price (NOT ROI)

  // Trailing stop config
  enableTrailing: boolean;
  trailTriggerPercent?: number;   // ROI % to start trailing
  trailStepPercent?: number;      // ROI % between levels
  level1LockPercent?: number;     // Price % to lock at level 1

  // Direction
  fadeSignals: boolean;           // true = take opposite direction

  // Take profit (optional)
  takeProfitPercent?: number;     // TP as % of entry price
}

export interface SignalEvent {
  timestamp: string;
  eventType: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: MarketType;
  state: string;
  rsi: number;
  price: number;
  impulsePercent?: number;
}

export interface BacktestTrade {
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: MarketType;

  // Entry
  entryPrice: number;
  entryTime: number;
  signalRsi: number;

  // Position sizing
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Stops
  initialStopPrice: number;
  finalStopPrice: number;
  takeProfitPrice: number | null;

  // Exit
  exitPrice: number;
  exitTime: number;
  exitReason: 'initial_stop' | 'trailing_stop' | 'take_profit' | 'end_of_data';
  trailLevelAtExit: number;

  // P&L
  rawPnL: number;
  realizedPnL: number;  // After friction
  realizedPnLPercent: number;
  entryCosts: number;
  exitCosts: number;
}

export interface BacktestResult {
  strategy: StrategyConfig;
  trades: BacktestTrade[];
  summary: BacktestSummary;
}

export interface BacktestSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  totalPnL: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;

  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;

  avgHoldingTimeMs: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;

  byExitReason: Record<string, { count: number; pnl: number }>;
}

// ============= Position Simulation =============

interface SimulatedPosition {
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: MarketType;

  entryPrice: number;
  effectiveEntryPrice: number;
  entryTime: number;
  signalRsi: number;

  marginUsed: number;
  notionalSize: number;
  leverage: number;

  initialStopPrice: number;
  currentStopPrice: number;
  takeProfitPrice: number | null;

  highWaterMark: number;  // Best ROI achieved
  trailLevel: number;

  entryCosts: number;
}

/**
 * Calculate stop loss price from entry and percentage
 */
function calculateStopPrice(
  entryPrice: number,
  direction: 'long' | 'short',
  stopLossPercent: number
): number {
  if (direction === 'long') {
    return entryPrice * (1 - stopLossPercent / 100);
  } else {
    return entryPrice * (1 + stopLossPercent / 100);
  }
}

/**
 * Calculate take profit price from entry and percentage
 */
function calculateTakeProfitPrice(
  entryPrice: number,
  direction: 'long' | 'short',
  takeProfitPercent: number
): number {
  if (direction === 'long') {
    return entryPrice * (1 + takeProfitPercent / 100);
  } else {
    return entryPrice * (1 - takeProfitPercent / 100);
  }
}

/**
 * Calculate current ROI percentage
 */
function calculateROI(position: SimulatedPosition, currentPrice: number): number {
  const priceChange = position.direction === 'long'
    ? (currentPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
    : (position.effectiveEntryPrice - currentPrice) / position.effectiveEntryPrice;

  return priceChange * position.leverage * 100;
}

/**
 * Update trailing stop based on current price
 * Returns true if stop was updated
 */
function updateTrailingStop(
  position: SimulatedPosition,
  currentPrice: number,
  config: StrategyConfig
): boolean {
  if (!config.enableTrailing) return false;

  const roi = calculateROI(position, currentPrice);
  if (roi > position.highWaterMark) {
    position.highWaterMark = roi;
  }

  const triggerPercent = config.trailTriggerPercent || 10;
  const stepPercent = config.trailStepPercent || 5;
  const level1Lock = config.level1LockPercent || 2;

  // Not yet triggered
  if (position.trailLevel === 0) {
    if (roi >= triggerPercent) {
      position.trailLevel = 1;
      // Lock at level1Lock % above entry
      const lockPrice = position.direction === 'long'
        ? position.effectiveEntryPrice * (1 + level1Lock / 100)
        : position.effectiveEntryPrice * (1 - level1Lock / 100);
      position.currentStopPrice = lockPrice;
      return true;
    }
    return false;
  }

  // Check for next level
  const nextLevelTrigger = triggerPercent + (position.trailLevel * stepPercent);
  if (roi >= nextLevelTrigger) {
    position.trailLevel++;
    const lockPercent = level1Lock + ((position.trailLevel - 1) * stepPercent);
    const lockPrice = position.direction === 'long'
      ? position.effectiveEntryPrice * (1 + lockPercent / 100)
      : position.effectiveEntryPrice * (1 - lockPercent / 100);
    position.currentStopPrice = lockPrice;
    return true;
  }

  return false;
}

/**
 * Check if stop was hit during a candle
 * Returns exit info if hit, null otherwise
 */
function checkStopHit(
  position: SimulatedPosition,
  candle: Candle
): { exitPrice: number; reason: 'initial_stop' | 'trailing_stop' } | null {
  if (position.direction === 'long') {
    // For longs, check if LOW touched stop
    if (candle.low <= position.currentStopPrice) {
      return {
        exitPrice: position.currentStopPrice,
        reason: position.trailLevel > 0 ? 'trailing_stop' : 'initial_stop'
      };
    }
  } else {
    // For shorts, check if HIGH touched stop
    if (candle.high >= position.currentStopPrice) {
      return {
        exitPrice: position.currentStopPrice,
        reason: position.trailLevel > 0 ? 'trailing_stop' : 'initial_stop'
      };
    }
  }
  return null;
}

/**
 * Check if take profit was hit during a candle
 */
function checkTakeProfitHit(
  position: SimulatedPosition,
  candle: Candle
): { exitPrice: number } | null {
  if (!position.takeProfitPrice) return null;

  if (position.direction === 'long') {
    if (candle.high >= position.takeProfitPrice) {
      return { exitPrice: position.takeProfitPrice };
    }
  } else {
    if (candle.low <= position.takeProfitPrice) {
      return { exitPrice: position.takeProfitPrice };
    }
  }
  return null;
}

/**
 * Simulate a single trade through candle data
 */
async function simulateTrade(
  signal: SignalEvent,
  strategy: StrategyConfig,
  initialBalance: number
): Promise<BacktestTrade | null> {
  // Determine direction (fade reverses the signal)
  const direction = strategy.fadeSignals
    ? (signal.direction === 'long' ? 'short' : 'long')
    : signal.direction;

  // Get candles from entry time
  const entryTime = new Date(signal.timestamp).getTime();
  const candles = await getCandlesFromEntry(
    signal.symbol,
    signal.timeframe as Timeframe,
    signal.marketType,
    entryTime,
    7 * 24 * 60 * 60 * 1000  // 7 days of data
  );

  if (candles.length < 2) {
    console.log(`[Backtest] Insufficient candles for ${signal.symbol}`);
    return null;
  }

  // Find entry candle
  const entryCandle = candles.find(c => c.timestamp >= entryTime);
  if (!entryCandle) return null;

  // Position sizing
  const margin = initialBalance * (strategy.positionSizePercent / 100);
  const notional = margin * strategy.leverage;

  // Calculate entry with slippage
  const volatility = determineVolatility(signal.rsi);
  const entryCosts = costsCalculator.calculateEntryCosts(
    entryCandle.close,
    notional,
    direction,
    volatility
  );

  // Calculate stop and TP prices
  const stopPrice = calculateStopPrice(
    entryCosts.effectiveEntryPrice,
    direction,
    strategy.initialStopLossPercent
  );

  const tpPrice = strategy.takeProfitPercent
    ? calculateTakeProfitPrice(
        entryCosts.effectiveEntryPrice,
        direction,
        strategy.takeProfitPercent
      )
    : null;

  // Create position
  const position: SimulatedPosition = {
    symbol: signal.symbol,
    direction,
    timeframe: signal.timeframe,
    marketType: signal.marketType,
    entryPrice: entryCandle.close,
    effectiveEntryPrice: entryCosts.effectiveEntryPrice,
    entryTime,
    signalRsi: signal.rsi,
    marginUsed: margin,
    notionalSize: notional,
    leverage: strategy.leverage,
    initialStopPrice: stopPrice,
    currentStopPrice: stopPrice,
    takeProfitPrice: tpPrice,
    highWaterMark: 0,
    trailLevel: 0,
    entryCosts: entryCosts.entryCosts
  };

  // Simulate through candles
  let exitPrice: number | null = null;
  let exitTime: number = 0;
  let exitReason: 'initial_stop' | 'trailing_stop' | 'take_profit' | 'end_of_data' = 'end_of_data';

  const startIndex = candles.indexOf(entryCandle) + 1;
  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];

    // First update trailing stop with best price this candle
    const bestPrice = direction === 'long' ? candle.high : candle.low;
    updateTrailingStop(position, bestPrice, strategy);

    // Check stop hit (using worst price this candle)
    const stopHit = checkStopHit(position, candle);
    if (stopHit) {
      exitPrice = stopHit.exitPrice;
      exitTime = candle.timestamp;
      exitReason = stopHit.reason;
      break;
    }

    // Check take profit hit
    const tpHit = checkTakeProfitHit(position, candle);
    if (tpHit) {
      exitPrice = tpHit.exitPrice;
      exitTime = candle.timestamp;
      exitReason = 'take_profit';
      break;
    }
  }

  // If no exit, use last candle close
  if (exitPrice === null) {
    const lastCandle = candles[candles.length - 1];
    exitPrice = lastCandle.close;
    exitTime = lastCandle.timestamp;
    exitReason = 'end_of_data';
  }

  // Calculate P&L
  const exitCosts = costsCalculator.calculateExitCosts(
    exitPrice,
    notional,
    direction,
    'normal'
  );

  const priceChange = direction === 'long'
    ? (exitCosts.effectiveExitPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
    : (position.effectiveEntryPrice - exitCosts.effectiveExitPrice) / position.effectiveEntryPrice;

  const rawPnL = priceChange * notional;
  const totalCosts = position.entryCosts + exitCosts.exitCosts;
  const realizedPnL = rawPnL - totalCosts;
  const realizedPnLPercent = (realizedPnL / margin) * 100;

  return {
    symbol: signal.symbol,
    direction,
    timeframe: signal.timeframe,
    marketType: signal.marketType,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    signalRsi: signal.rsi,
    marginUsed: margin,
    notionalSize: notional,
    leverage: strategy.leverage,
    initialStopPrice: position.initialStopPrice,
    finalStopPrice: position.currentStopPrice,
    takeProfitPrice: position.takeProfitPrice,
    exitPrice,
    exitTime,
    exitReason,
    trailLevelAtExit: position.trailLevel,
    rawPnL,
    realizedPnL,
    realizedPnLPercent,
    entryCosts: position.entryCosts,
    exitCosts: exitCosts.exitCosts
  };
}

// ============= Signal Loading =============

/**
 * Load signals from signal log files
 */
function loadSignals(startDate: string, endDate: string): SignalEvent[] {
  const signalsDir = path.join(process.cwd(), 'data', 'signals');
  if (!fs.existsSync(signalsDir)) {
    console.log('[Backtest] No signals directory found');
    return [];
  }

  const signals: SignalEvent[] = [];
  const files = fs.readdirSync(signalsDir)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const date = f.replace('.json', '');
      return date >= startDate && date <= endDate;
    })
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(signalsDir, file), 'utf-8'));
      // Filter for triggered/deep_extreme signals only
      const triggered = data.filter((s: SignalEvent) =>
        s.eventType === 'triggered' || s.eventType === 'deep_extreme' ||
        s.state === 'triggered' || s.state === 'deep_extreme'
      );
      signals.push(...triggered);
    } catch (e) {
      console.error(`[Backtest] Error loading ${file}:`, e);
    }
  }

  return signals;
}

/**
 * Load generated signals for a specific timeframe
 */
function loadGeneratedSignals(startDate: string, endDate: string, timeframe: string): SignalEvent[] {
  const signalsDir = path.join(process.cwd(), 'data', 'generated-signals', timeframe);
  if (!fs.existsSync(signalsDir)) {
    console.log(`[Backtest] No generated signals directory found for ${timeframe}`);
    return [];
  }

  const signals: SignalEvent[] = [];
  const files = fs.readdirSync(signalsDir)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const date = f.replace('.json', '');
      return date >= startDate && date <= endDate;
    })
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(signalsDir, file), 'utf-8'));
      signals.push(...data);
    } catch (e) {
      console.error(`[Backtest] Error loading ${file}:`, e);
    }
  }

  console.log(`[Backtest] Loaded ${signals.length} generated ${timeframe} signals`);
  return signals;
}

/**
 * Load signals from trade log files (more reliable - these are actual trades)
 */
function loadSignalsFromTrades(startDate: string, endDate: string): SignalEvent[] {
  const tradesDir = path.join(process.cwd(), 'data', 'trades');
  if (!fs.existsSync(tradesDir)) {
    console.log('[Backtest] No trades directory found');
    return [];
  }

  const signals: SignalEvent[] = [];
  const seenKeys = new Set<string>();

  const files = fs.readdirSync(tradesDir)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))  // Main files only
    .filter(f => {
      const date = f.replace('.json', '');
      return date >= startDate && date <= endDate;
    })
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(tradesDir, file), 'utf-8'));

      for (const trade of data) {
        if (trade.eventType !== 'open') continue;

        // Deduplicate - same symbol/timeframe/direction/time should only be one signal
        const key = `${trade.symbol}-${trade.timeframe}-${trade.direction}-${trade.entryTime}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        signals.push({
          timestamp: trade.entryTime || trade.timestamp,
          eventType: 'triggered',
          symbol: trade.symbol,
          direction: trade.direction,
          timeframe: trade.timeframe,
          marketType: trade.marketType || 'futures',
          state: trade.signalState || 'triggered',
          rsi: trade.signalRsi || 50,
          price: trade.entryPrice,
          impulsePercent: trade.impulsePercent
        });
      }
    } catch (e) {
      console.error(`[Backtest] Error loading ${file}:`, e);
    }
  }

  return signals;
}

// ============= Main Backtest Function =============

/**
 * Run a backtest with multiple strategies
 */
export async function runBacktest(
  startDate: string,
  endDate: string,
  strategies: StrategyConfig[],
  options: {
    initialBalance?: number;
    useTradeSignals?: boolean;  // Use signals from trades (more accurate)
    useGeneratedSignals?: boolean;  // Use generated signals for timeframe
    generatedTimeframe?: string;    // Which timeframe's generated signals to use
    maxSignals?: number;        // Limit for testing
    symbolFilter?: string[];    // Only test these symbols
    timeframeFilter?: string;   // Only test signals from this timeframe
  } = {}
): Promise<BacktestResult[]> {
  const {
    initialBalance = 2000,
    useTradeSignals = true,
    useGeneratedSignals = false,
    generatedTimeframe,
    maxSignals,
    symbolFilter,
    timeframeFilter
  } = options;

  // Load signals
  console.log(`[Backtest] Loading signals from ${startDate} to ${endDate}...`);

  let allSignals: SignalEvent[];

  if (useGeneratedSignals && generatedTimeframe) {
    // Use generated signals for the specified timeframe
    allSignals = loadGeneratedSignals(startDate, endDate, generatedTimeframe);
  } else if (useTradeSignals) {
    allSignals = loadSignalsFromTrades(startDate, endDate);
  } else {
    allSignals = loadSignals(startDate, endDate);
  }

  let signals = allSignals;

  // Apply symbol filter
  if (symbolFilter && symbolFilter.length > 0) {
    signals = signals.filter(s => symbolFilter.includes(s.symbol));
  }

  // Apply timeframe filter
  if (timeframeFilter) {
    signals = signals.filter(s => s.timeframe === timeframeFilter);
  }

  // Apply limit
  if (maxSignals) {
    signals = signals.slice(0, maxSignals);
  }

  console.log(`[Backtest] Found ${signals.length} signals to test`);

  // Run backtest for each strategy
  const results: BacktestResult[] = [];

  for (const strategy of strategies) {
    console.log(`[Backtest] Testing strategy: ${strategy.name}`);
    const trades: BacktestTrade[] = [];

    let completed = 0;
    for (const signal of signals) {
      const trade = await simulateTrade(signal, strategy, initialBalance);
      if (trade) {
        trades.push(trade);
      }

      completed++;
      if (completed % 50 === 0) {
        console.log(`[Backtest] ${strategy.name}: ${completed}/${signals.length} signals processed`);
      }
    }

    // Calculate summary
    const summary = calculateSummary(trades, initialBalance);

    results.push({
      strategy,
      trades,
      summary
    });
  }

  return results;
}

/**
 * Calculate summary statistics for trades
 */
function calculateSummary(trades: BacktestTrade[], initialBalance: number): BacktestSummary {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      avgHoldingTimeMs: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      byExitReason: {}
    };
  }

  const wins = trades.filter(t => t.realizedPnL > 0);
  const losses = trades.filter(t => t.realizedPnL <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnL, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnL, 0));
  const totalPnL = grossProfit - grossLoss;

  // Calculate max drawdown
  let peak = initialBalance;
  let maxDrawdown = 0;
  let balance = initialBalance;

  for (const trade of trades) {
    balance += trade.realizedPnL;
    if (balance > peak) peak = balance;
    const drawdown = peak - balance;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Group by exit reason
  const byExitReason: Record<string, { count: number; pnl: number }> = {};
  for (const trade of trades) {
    if (!byExitReason[trade.exitReason]) {
      byExitReason[trade.exitReason] = { count: 0, pnl: 0 };
    }
    byExitReason[trade.exitReason].count++;
    byExitReason[trade.exitReason].pnl += trade.realizedPnL;
  }

  // Average holding time
  const avgHoldingTimeMs = trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0) / trades.length;

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: (wins.length / trades.length) * 100,
    totalPnL,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.realizedPnL)) : 0,
    largestLoss: losses.length > 0 ? Math.max(...losses.map(t => Math.abs(t.realizedPnL))) : 0,
    avgHoldingTimeMs,
    maxDrawdown,
    maxDrawdownPercent: (maxDrawdown / initialBalance) * 100,
    byExitReason
  };
}

/**
 * Print results in a readable format
 */
export function printResults(results: BacktestResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(80));

  for (const result of results) {
    const { strategy, summary } = result;

    console.log(`\n${'-'.repeat(80)}`);
    console.log(`Strategy: ${strategy.name}`);
    console.log(`  Leverage: ${strategy.leverage}x | Position: ${strategy.positionSizePercent}% | Stop: ${strategy.initialStopLossPercent}%`);
    console.log(`  Trailing: ${strategy.enableTrailing ? 'Yes' : 'No'} | Fade: ${strategy.fadeSignals ? 'Yes' : 'No'}`);
    console.log(`${'-'.repeat(80)}`);

    console.log(`\nPerformance:`);
    console.log(`  Total Trades:    ${summary.totalTrades}`);
    console.log(`  Win Rate:        ${summary.winRate.toFixed(1)}% (${summary.winningTrades}W / ${summary.losingTrades}L)`);
    console.log(`  Total P&L:       $${summary.totalPnL.toFixed(2)}`);
    console.log(`  Profit Factor:   ${summary.profitFactor.toFixed(2)}`);

    console.log(`\nRisk:`);
    console.log(`  Max Drawdown:    $${summary.maxDrawdown.toFixed(2)} (${summary.maxDrawdownPercent.toFixed(1)}%)`);
    console.log(`  Avg Win:         $${summary.avgWin.toFixed(2)}`);
    console.log(`  Avg Loss:        $${summary.avgLoss.toFixed(2)}`);
    console.log(`  Largest Win:     $${summary.largestWin.toFixed(2)}`);
    console.log(`  Largest Loss:    $${summary.largestLoss.toFixed(2)}`);

    console.log(`\nBy Exit Reason:`);
    for (const [reason, stats] of Object.entries(summary.byExitReason)) {
      console.log(`  ${reason.padEnd(20)} | ${String(stats.count).padStart(4)} trades | $${stats.pnl.toFixed(2).padStart(10)}`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

/**
 * Compare two strategies side by side
 */
export function compareStrategies(results: BacktestResult[]): void {
  if (results.length < 2) {
    console.log('Need at least 2 strategies to compare');
    return;
  }

  console.log('\n' + '='.repeat(80));
  console.log('STRATEGY COMPARISON');
  console.log('='.repeat(80));

  // Header
  const headers = ['Metric', ...results.map(r => r.strategy.name)];
  console.log(headers.map(h => h.padEnd(20)).join(' | '));
  console.log('-'.repeat(headers.length * 22));

  // Metrics to compare
  const metrics = [
    { name: 'Total Trades', key: 'totalTrades', format: (v: number) => v.toString() },
    { name: 'Win Rate', key: 'winRate', format: (v: number) => v.toFixed(1) + '%' },
    { name: 'Total P&L', key: 'totalPnL', format: (v: number) => '$' + v.toFixed(2) },
    { name: 'Profit Factor', key: 'profitFactor', format: (v: number) => v.toFixed(2) },
    { name: 'Max Drawdown', key: 'maxDrawdown', format: (v: number) => '$' + v.toFixed(2) },
    { name: 'Avg Win', key: 'avgWin', format: (v: number) => '$' + v.toFixed(2) },
    { name: 'Avg Loss', key: 'avgLoss', format: (v: number) => '$' + v.toFixed(2) },
  ];

  for (const metric of metrics) {
    const row = [
      metric.name.padEnd(20),
      ...results.map(r => metric.format((r.summary as any)[metric.key]).padEnd(20))
    ];
    console.log(row.join(' | '));
  }

  console.log('='.repeat(80));
}
