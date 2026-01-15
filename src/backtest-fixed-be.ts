/**
 * Backtest: Fixed BE (Breakeven Lock) Strategy
 *
 * Strategy: Fixed 20% TP / 20% SL with breakeven lock at +10% ROI
 * - Enter on triggered/deep_extreme signals
 * - Move SL to entry price when +10% ROI is reached
 * - Fixed 20% take profit target
 * - Exit at TP, SL, or breakeven stop
 *
 * This backtest includes friction modeling (fees + slippage) for realistic results.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

// Types
interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: string;
  entryPrice: number;
  exitPrice?: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  signalRsi?: number;
  signalState?: string;
  impulsePercent?: number;
}

interface BacktestPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  entryPrice: number;
  entryTime: Date;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  initialStopLossPrice: number;
  breakevenLocked: boolean;
  signalRsi?: number;
}

interface BacktestResult {
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  holdingTimeMs: number;
  breakevenLocked: boolean;
  exitReason: string;
  // Raw PnL (before friction)
  rawPnL: number;
  rawPnLPercent: number;
  // Friction costs
  entryCosts: number;
  exitCosts: number;
  totalCosts: number;
  // Net PnL (after friction)
  netPnL: number;
  netPnLPercent: number;
}

interface BacktestSummary {
  strategy: string;
  dataStart: string;
  dataEnd: string;
  totalTrades: number;
  // Raw results
  rawWins: number;
  rawLosses: number;
  rawWinRate: number;
  rawTotalPnL: number;
  // Friction-adjusted results
  netWins: number;
  netLosses: number;
  netWinRate: number;
  netTotalPnL: number;
  // Cost analysis
  totalFrictionCosts: number;
  avgCostPerTrade: number;
  costAsPercentOfVolume: number;
  ghostTrades: number;  // Trades that were profitable raw but unprofitable after friction
  // Strategy-specific
  breakevenLockTriggers: number;
  breakevenExits: number;
  tpExits: number;
  slExits: number;
  // Averages
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
}

// Fixed BE Strategy config
const STRATEGY_CONFIG = {
  positionSizePercent: 1,  // 1% of balance per trade
  leverage: 10,            // 10x leverage
  takeProfitPercent: 20,   // 20% TP
  stopLossPercent: 20,     // 20% SL
  breakevenTriggerPercent: 10,  // Move SL to BE at +10%
  initialBalance: 2000,
  maxOpenPositions: 10,
};

/**
 * Load trade events from JSON files
 */
function loadTradeEvents(dataDir: string, dates?: string[]): TradeEvent[] {
  const tradesDir = path.join(dataDir, 'trades');
  const events: TradeEvent[] = [];

  if (!fs.existsSync(tradesDir)) {
    console.error(`Trades directory not found: ${tradesDir}`);
    return events;
  }

  // Get all JSON files
  const files = fs.readdirSync(tradesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    // Extract date from filename
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    if (dates && !dates.includes(date)) continue;

    // Skip "-all" files, use the main files
    if (file.includes('-all')) continue;

    const filePath = path.join(tradesDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const trades = JSON.parse(content) as TradeEvent[];
      events.push(...trades);
    } catch (e) {
      console.error(`Failed to load ${file}:`, e);
    }
  }

  // Sort by timestamp
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return events;
}

/**
 * Simulate Fixed BE strategy on historical signals
 */
function simulateFixedBE(
  events: TradeEvent[],
  costsCalculator: ExecutionCostsCalculator
): BacktestResult[] {
  const results: BacktestResult[] = [];
  const openPositions = new Map<string, BacktestPosition>();

  // Group events by position ID
  const positionEvents = new Map<string, { open?: TradeEvent; close?: TradeEvent }>();

  for (const event of events) {
    // Only use 'fixed' bot trades as they have the same entry logic
    // We'll re-simulate exits with our BE logic
    if (event.botId !== 'fixed') continue;

    const pos = positionEvents.get(event.positionId) || {};
    if (event.eventType === 'open') {
      pos.open = event;
    } else if (event.eventType === 'close') {
      pos.close = event;
    }
    positionEvents.set(event.positionId, pos);
  }

  // Process complete trades
  for (const [posId, pos] of positionEvents) {
    if (!pos.open || !pos.close) continue;

    const openEvent = pos.open;
    const closeEvent = pos.close;

    // Calculate our TP/SL based on Fixed BE strategy
    const entryPrice = openEvent.entryPrice;
    const tpPercent = STRATEGY_CONFIG.takeProfitPercent / 100;
    const slPercent = STRATEGY_CONFIG.stopLossPercent / 100;

    const takeProfitPrice = openEvent.direction === 'long'
      ? entryPrice * (1 + tpPercent)
      : entryPrice * (1 - tpPercent);

    const stopLossPrice = openEvent.direction === 'long'
      ? entryPrice * (1 - slPercent)
      : entryPrice * (1 + slPercent);

    const exitPrice = closeEvent.exitPrice || entryPrice;

    // Simulate the trade with breakeven logic
    // Calculate what exit would have been achieved
    const priceChange = openEvent.direction === 'long'
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;
    const roiPercent = priceChange * 100;

    // Check if breakeven would have been locked
    let breakevenLocked = false;
    let finalExitReason = closeEvent.exitReason || 'Unknown';
    let simulatedExitPrice = exitPrice;

    // If the trade ever reached +10% ROI, breakeven would lock
    // We check if the actual exit was a loss and the trade hit BE threshold
    if (roiPercent >= STRATEGY_CONFIG.breakevenTriggerPercent) {
      breakevenLocked = true;
    }

    // Determine exit scenario with BE logic
    if (closeEvent.exitReason === 'Take Profit Hit') {
      finalExitReason = 'Take Profit Hit';
    } else if (closeEvent.exitReason === 'Stop Loss Hit') {
      if (breakevenLocked) {
        // If BE was locked and we hit stop, it's a breakeven exit
        finalExitReason = 'Breakeven Stop Hit';
        simulatedExitPrice = entryPrice;  // Exit at entry price
      } else {
        finalExitReason = 'Stop Loss Hit';
      }
    } else if (closeEvent.exitReason === 'Setup Played Out') {
      // Check if BE was active
      if (breakevenLocked && roiPercent < 0) {
        finalExitReason = 'Breakeven Stop Hit';
        simulatedExitPrice = entryPrice;
      } else {
        finalExitReason = 'Setup Played Out';
      }
    }

    // Calculate holding time
    const entryTime = new Date(openEvent.timestamp);
    const exitTime = new Date(closeEvent.timestamp);
    const holdingTimeMs = exitTime.getTime() - entryTime.getTime();

    // Calculate raw PnL
    const finalPriceChange = openEvent.direction === 'long'
      ? (simulatedExitPrice - entryPrice) / entryPrice
      : (entryPrice - simulatedExitPrice) / entryPrice;
    const rawPnL = openEvent.notionalSize * finalPriceChange;
    const rawPnLPercent = finalPriceChange * 100;

    // Calculate friction costs
    const volatility = determineVolatility(openEvent.signalRsi);

    const { entryCosts } = costsCalculator.calculateEntryCosts(
      entryPrice,
      openEvent.notionalSize,
      openEvent.direction,
      volatility
    );

    const { exitCosts } = costsCalculator.calculateExitCosts(
      simulatedExitPrice,
      openEvent.notionalSize,
      openEvent.direction,
      volatility
    );

    const totalCosts = entryCosts + exitCosts;
    const netPnL = rawPnL - totalCosts;
    const netPnLPercent = (netPnL / openEvent.marginUsed) * 100;

    results.push({
      positionId: posId,
      symbol: openEvent.symbol,
      direction: openEvent.direction,
      timeframe: openEvent.timeframe,
      entryPrice,
      exitPrice: simulatedExitPrice,
      entryTime: openEvent.timestamp,
      exitTime: closeEvent.timestamp,
      holdingTimeMs,
      breakevenLocked,
      exitReason: finalExitReason,
      rawPnL,
      rawPnLPercent,
      entryCosts,
      exitCosts,
      totalCosts,
      netPnL,
      netPnLPercent,
    });
  }

  return results;
}

/**
 * Analyze trades that would have been different with BE lock
 * Uses ALL trades (not just 'fixed' bot) to see full potential
 */
function analyzeAllSignals(
  events: TradeEvent[],
  costsCalculator: ExecutionCostsCalculator
): BacktestResult[] {
  const results: BacktestResult[] = [];

  // Group events by position ID
  const positionEvents = new Map<string, { open?: TradeEvent; close?: TradeEvent }>();

  for (const event of events) {
    // Skip the high-leverage bots that caused massive losses
    if (event.botId.includes('100x') || event.botId.includes('50')) continue;

    const pos = positionEvents.get(event.positionId) || {};
    if (event.eventType === 'open') {
      pos.open = event;
    } else if (event.eventType === 'close') {
      pos.close = event;
    }
    positionEvents.set(event.positionId, pos);
  }

  // For unique symbol/timeframe/direction combinations, simulate as Fixed BE
  const uniqueTrades = new Map<string, { open: TradeEvent; close: TradeEvent }>();

  for (const [posId, pos] of positionEvents) {
    if (!pos.open || !pos.close) continue;

    // Use first signal for each symbol/timeframe/direction combo
    const key = `${pos.open.symbol}-${pos.open.timeframe}-${pos.open.direction}`;
    if (!uniqueTrades.has(key)) {
      uniqueTrades.set(key, { open: pos.open, close: pos.close });
    }
  }

  // Process unique trades with Fixed BE parameters
  for (const [key, trade] of uniqueTrades) {
    const openEvent = trade.open;
    const closeEvent = trade.close;

    // Recalculate with Fixed BE parameters
    const marginUsed = STRATEGY_CONFIG.initialBalance * (STRATEGY_CONFIG.positionSizePercent / 100);
    const notionalSize = marginUsed * STRATEGY_CONFIG.leverage;

    const entryPrice = openEvent.entryPrice;
    const exitPrice = closeEvent.exitPrice || entryPrice;

    const tpPercent = STRATEGY_CONFIG.takeProfitPercent / 100;
    const slPercent = STRATEGY_CONFIG.stopLossPercent / 100;

    const takeProfitPrice = openEvent.direction === 'long'
      ? entryPrice * (1 + tpPercent)
      : entryPrice * (1 - tpPercent);

    const stopLossPrice = openEvent.direction === 'long'
      ? entryPrice * (1 - slPercent)
      : entryPrice * (1 + slPercent);

    // Calculate max favorable excursion to see if BE would have locked
    const priceChange = openEvent.direction === 'long'
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;
    const roiPercent = priceChange * 100;

    // Check if BE would lock (simplified - assumes if final exit showed >10% at some point)
    // In reality we'd need tick-by-tick data
    let breakevenLocked = roiPercent >= STRATEGY_CONFIG.breakevenTriggerPercent;
    let finalExitReason = 'Unknown';
    let simulatedExitPrice = exitPrice;

    // Determine exit based on price levels
    if (openEvent.direction === 'long') {
      if (exitPrice >= takeProfitPrice) {
        finalExitReason = 'Take Profit Hit';
        simulatedExitPrice = takeProfitPrice;
      } else if (exitPrice <= stopLossPrice && !breakevenLocked) {
        finalExitReason = 'Stop Loss Hit';
        simulatedExitPrice = stopLossPrice;
      } else if (breakevenLocked && exitPrice <= entryPrice) {
        finalExitReason = 'Breakeven Stop Hit';
        simulatedExitPrice = entryPrice;
      } else {
        finalExitReason = 'Setup Played Out';
      }
    } else {
      if (exitPrice <= takeProfitPrice) {
        finalExitReason = 'Take Profit Hit';
        simulatedExitPrice = takeProfitPrice;
      } else if (exitPrice >= stopLossPrice && !breakevenLocked) {
        finalExitReason = 'Stop Loss Hit';
        simulatedExitPrice = stopLossPrice;
      } else if (breakevenLocked && exitPrice >= entryPrice) {
        finalExitReason = 'Breakeven Stop Hit';
        simulatedExitPrice = entryPrice;
      } else {
        finalExitReason = 'Setup Played Out';
      }
    }

    // Calculate holding time
    const entryTime = new Date(openEvent.timestamp);
    const exitTime = new Date(closeEvent.timestamp);
    const holdingTimeMs = exitTime.getTime() - entryTime.getTime();

    // Calculate raw PnL with our standardized position size
    const finalPriceChange = openEvent.direction === 'long'
      ? (simulatedExitPrice - entryPrice) / entryPrice
      : (entryPrice - simulatedExitPrice) / entryPrice;
    const rawPnL = notionalSize * finalPriceChange;
    const rawPnLPercent = finalPriceChange * 100;

    // Calculate friction costs
    const volatility = determineVolatility(openEvent.signalRsi);

    const { entryCosts } = costsCalculator.calculateEntryCosts(
      entryPrice,
      notionalSize,
      openEvent.direction,
      volatility
    );

    const { exitCosts } = costsCalculator.calculateExitCosts(
      simulatedExitPrice,
      notionalSize,
      openEvent.direction,
      volatility
    );

    const totalCosts = entryCosts + exitCosts;
    const netPnL = rawPnL - totalCosts;
    const netPnLPercent = (netPnL / marginUsed) * 100;

    results.push({
      positionId: key,
      symbol: openEvent.symbol,
      direction: openEvent.direction,
      timeframe: openEvent.timeframe,
      entryPrice,
      exitPrice: simulatedExitPrice,
      entryTime: openEvent.timestamp,
      exitTime: closeEvent.timestamp,
      holdingTimeMs,
      breakevenLocked,
      exitReason: finalExitReason,
      rawPnL,
      rawPnLPercent,
      entryCosts,
      exitCosts,
      totalCosts,
      netPnL,
      netPnLPercent,
    });
  }

  return results;
}

/**
 * Generate summary report
 */
function generateSummary(results: BacktestResult[], mode: 'fixed-only' | 'all-signals'): BacktestSummary {
  if (results.length === 0) {
    return {
      strategy: 'Fixed BE (20% TP / 20% SL / 10% BE Lock)',
      dataStart: 'N/A',
      dataEnd: 'N/A',
      totalTrades: 0,
      rawWins: 0,
      rawLosses: 0,
      rawWinRate: 0,
      rawTotalPnL: 0,
      netWins: 0,
      netLosses: 0,
      netWinRate: 0,
      netTotalPnL: 0,
      totalFrictionCosts: 0,
      avgCostPerTrade: 0,
      costAsPercentOfVolume: 0,
      ghostTrades: 0,
      breakevenLockTriggers: 0,
      breakevenExits: 0,
      tpExits: 0,
      slExits: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
    };
  }

  // Sort by time
  results.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());

  const rawWins = results.filter(r => r.rawPnL > 0);
  const rawLosses = results.filter(r => r.rawPnL <= 0);
  const netWins = results.filter(r => r.netPnL > 0);
  const netLosses = results.filter(r => r.netPnL <= 0);
  const ghostTrades = results.filter(r => r.rawPnL > 0 && r.netPnL <= 0);

  const totalFrictionCosts = results.reduce((sum, r) => sum + r.totalCosts, 0);
  const totalVolume = results.reduce((sum, r) => sum + (r.entryPrice * STRATEGY_CONFIG.initialBalance * STRATEGY_CONFIG.positionSizePercent / 100 * STRATEGY_CONFIG.leverage), 0);

  const breakevenLockTriggers = results.filter(r => r.breakevenLocked).length;
  const breakevenExits = results.filter(r => r.exitReason === 'Breakeven Stop Hit').length;
  const tpExits = results.filter(r => r.exitReason === 'Take Profit Hit').length;
  const slExits = results.filter(r => r.exitReason === 'Stop Loss Hit').length;

  // Calculate drawdown
  let balance = STRATEGY_CONFIG.initialBalance;
  let peak = balance;
  let maxDrawdown = 0;

  for (const result of results) {
    balance += result.netPnL;
    if (balance > peak) peak = balance;
    const drawdown = peak - balance;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const netWinAmounts = netWins.map(r => r.netPnL);
  const netLossAmounts = netLosses.map(r => Math.abs(r.netPnL));

  const avgWin = netWinAmounts.length > 0
    ? netWinAmounts.reduce((a, b) => a + b, 0) / netWinAmounts.length
    : 0;
  const avgLoss = netLossAmounts.length > 0
    ? netLossAmounts.reduce((a, b) => a + b, 0) / netLossAmounts.length
    : 0;

  const grossProfit = netWinAmounts.reduce((a, b) => a + b, 0);
  const grossLoss = netLossAmounts.reduce((a, b) => a + b, 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    strategy: `Fixed BE (20% TP / 20% SL / 10% BE Lock) - ${mode}`,
    dataStart: results[0].entryTime,
    dataEnd: results[results.length - 1].exitTime,
    totalTrades: results.length,
    rawWins: rawWins.length,
    rawLosses: rawLosses.length,
    rawWinRate: (rawWins.length / results.length) * 100,
    rawTotalPnL: results.reduce((sum, r) => sum + r.rawPnL, 0),
    netWins: netWins.length,
    netLosses: netLosses.length,
    netWinRate: (netWins.length / results.length) * 100,
    netTotalPnL: results.reduce((sum, r) => sum + r.netPnL, 0),
    totalFrictionCosts,
    avgCostPerTrade: totalFrictionCosts / results.length,
    costAsPercentOfVolume: (totalFrictionCosts / totalVolume) * 100,
    ghostTrades: ghostTrades.length,
    breakevenLockTriggers,
    breakevenExits,
    tpExits,
    slExits,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown,
    maxDrawdownPercent: (maxDrawdown / STRATEGY_CONFIG.initialBalance) * 100,
  };
}

/**
 * Format report for console
 */
function formatReport(summary: BacktestSummary, results: BacktestResult[]): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('                    FIXED BE STRATEGY BACKTEST RESULTS');
  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Strategy: ${summary.strategy}`);
  lines.push(`Period: ${summary.dataStart.split('T')[0]} to ${summary.dataEnd.split('T')[0]}`);
  lines.push(`Total Trades: ${summary.totalTrades}`);
  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('                              PNL SUMMARY');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('                    RAW (Paper)          NET (With Friction)');
  lines.push(`  Total PnL:        $${summary.rawTotalPnL.toFixed(2).padStart(10)}         $${summary.netTotalPnL.toFixed(2).padStart(10)}`);
  lines.push(`  Win Rate:         ${summary.rawWinRate.toFixed(1).padStart(10)}%         ${summary.netWinRate.toFixed(1).padStart(10)}%`);
  lines.push(`  Wins/Losses:      ${summary.rawWins}/${summary.rawLosses}                     ${summary.netWins}/${summary.netLosses}`);
  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('                           FRICTION ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Total Friction Costs:     $${summary.totalFrictionCosts.toFixed(2)}`);
  lines.push(`  Avg Cost Per Trade:       $${summary.avgCostPerTrade.toFixed(2)}`);
  lines.push(`  Cost as % of Volume:      ${summary.costAsPercentOfVolume.toFixed(3)}%`);
  lines.push(`  Ghost Trades:             ${summary.ghostTrades} (profitable raw, unprofitable net)`);
  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('                         BREAKEVEN LOCK ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  BE Lock Triggers:         ${summary.breakevenLockTriggers} (${((summary.breakevenLockTriggers / summary.totalTrades) * 100).toFixed(1)}% of trades)`);
  lines.push(`  BE Stop Exits:            ${summary.breakevenExits}`);
  lines.push(`  Take Profit Exits:        ${summary.tpExits}`);
  lines.push(`  Stop Loss Exits:          ${summary.slExits}`);
  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('                            RISK METRICS');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Avg Win:                  $${summary.avgWin.toFixed(2)}`);
  lines.push(`  Avg Loss:                 $${summary.avgLoss.toFixed(2)}`);
  lines.push(`  Profit Factor:            ${summary.profitFactor === Infinity ? '∞' : summary.profitFactor.toFixed(2)}`);
  lines.push(`  Max Drawdown:             $${summary.maxDrawdown.toFixed(2)} (${summary.maxDrawdownPercent.toFixed(1)}%)`);
  lines.push('');

  // Show individual trades
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('                           TRADE DETAILS');
  lines.push('─────────────────────────────────────────────────────────────────────────────────');
  lines.push('');

  for (const r of results.slice(0, 30)) {
    const beTag = r.breakevenLocked ? '[BE]' : '    ';
    const pnlColor = r.netPnL >= 0 ? '+' : '';
    lines.push(`  ${r.symbol.padEnd(12)} ${r.direction.padEnd(5)} ${r.timeframe.padEnd(3)} ${beTag} ${r.exitReason.padEnd(20)} Raw: $${(r.rawPnL >= 0 ? '+' : '') + r.rawPnL.toFixed(2).padStart(7)} Net: $${pnlColor}${r.netPnL.toFixed(2).padStart(7)}`);
  }

  if (results.length > 30) {
    lines.push(`  ... and ${results.length - 30} more trades`);
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

/**
 * Main entry point
 */
async function main() {
  const dataDir = process.argv[2] || './data';
  const dates = process.argv[3]?.split(',');

  console.log('Running Fixed BE Backtest...');
  console.log(`Data directory: ${dataDir}`);
  console.log(`Position Size: ${STRATEGY_CONFIG.positionSizePercent}% ($${STRATEGY_CONFIG.initialBalance * STRATEGY_CONFIG.positionSizePercent / 100})`);
  console.log(`Leverage: ${STRATEGY_CONFIG.leverage}x`);
  console.log(`Take Profit: ${STRATEGY_CONFIG.takeProfitPercent}%`);
  console.log(`Stop Loss: ${STRATEGY_CONFIG.stopLossPercent}%`);
  console.log(`Breakeven Lock: at +${STRATEGY_CONFIG.breakevenTriggerPercent}% ROI`);
  console.log('');

  // Load events
  const events = loadTradeEvents(dataDir, dates);
  console.log(`Loaded ${events.length} trade events`);

  // Initialize costs calculator
  const costsCalculator = new ExecutionCostsCalculator();
  console.log(`Friction modeling: ENABLED`);
  console.log(`  - Base slippage: ${costsCalculator.getConfig().slippage.baseSlippageBps}bps`);
  console.log(`  - Taker fee: ${costsCalculator.getConfig().fees.takerFee * 100}%`);
  console.log('');

  // Run simulation on fixed bot trades (more accurate since same entry logic)
  console.log('=== Simulation 1: Fixed Bot Trades Only ===');
  const fixedResults = simulateFixedBE(events, costsCalculator);
  const fixedSummary = generateSummary(fixedResults, 'fixed-only');
  console.log(formatReport(fixedSummary, fixedResults));

  // Run simulation on all signals (broader view)
  console.log('\n\n=== Simulation 2: All Unique Signals ===');
  const allResults = analyzeAllSignals(events, costsCalculator);
  const allSummary = generateSummary(allResults, 'all-signals');
  console.log(formatReport(allSummary, allResults));

  // Save results
  const reportDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, `fixed-be-backtest-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: STRATEGY_CONFIG,
    frictionConfig: costsCalculator.getConfig(),
    fixedBotResults: {
      summary: fixedSummary,
      trades: fixedResults,
    },
    allSignalsResults: {
      summary: allSummary,
      trades: allResults,
    },
  }, null, 2));

  console.log(`\nFull report saved to: ${reportPath}`);
}

// Run if called directly
main().catch(console.error);
