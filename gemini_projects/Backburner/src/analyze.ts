#!/usr/bin/env node

/**
 * Daily Analysis Tool
 *
 * Analyzes trading data collected by the Backburner screener.
 * Run with: npx tsx src/analyze.ts [date]
 *
 * If no date provided, analyzes today's data.
 *
 * ============================================================================
 * KNOWN DATA ISSUES - READ BEFORE ANALYSIS
 * ============================================================================
 *
 * BUG FIX: Entry Cost Double-Counting (Fixed 2026-01-09)
 * -------------------------------------------------------
 * Prior to 2026-01-09, there was a bug in paper-trading-trailing.ts and
 * triple-light-bot.ts where entry costs were double-counted:
 *
 *   1. Entry costs deducted from balance at position OPEN
 *   2. Entry costs ALSO included in totalCosts and subtracted from realizedPnL at CLOSE
 *   3. Then realizedPnL (with entry costs already subtracted) added back to balance
 *
 * This caused the reported P&L (totalPnL in stats) to appear worse than actual
 * performance. The balance was correct, but the P&L metric was wrong.
 *
 * For data collected before this fix:
 *   - `currentBalance` is CORRECT and reflects true performance
 *   - `totalPnL` is UNDERSTATED (shows worse than reality)
 *   - True P&L = currentBalance - initialBalance (usually $2,000)
 *
 * Affected bots: All trailing stop bots (Trail Light, Trail Standard,
 * Trail Aggressive, Trail Wide, Triple Light)
 *
 * Non-affected bots: Fixed TP/SL, BTC Extreme, BTC Momentum, BTC Trend,
 * Confluence, Trend Override, Trend Flip (these don't model execution costs)
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getDataPersistence } from './data-persistence.js';
import type { SignalEvent, TradeEvent, DailySummary, MarketSnapshot, BotConfigSnapshot } from './data-persistence.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const MARKET_DIR = path.join(DATA_DIR, 'market');

function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

function loadSignals(date: string): SignalEvent[] {
  const file = path.join(SIGNALS_DIR, `${date}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return [];
}

function loadTrades(date: string): TradeEvent[] {
  const file = path.join(TRADES_DIR, `${date}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return [];
}

function loadMarketSnapshots(date: string): MarketSnapshot[] {
  const file = path.join(MARKET_DIR, `${date}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return [];
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return sign + '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function printHeader(title: string): void {
  console.log('\n' + chalk.cyan.bold('═'.repeat(70)));
  console.log(chalk.cyan.bold(`  ${title}`));
  console.log(chalk.cyan.bold('═'.repeat(70)));
}

function printSubHeader(title: string): void {
  console.log('\n' + chalk.white.bold(`▸ ${title}`));
  console.log(chalk.gray('─'.repeat(50)));
}

function analyzeSignals(signals: SignalEvent[]): void {
  printHeader('SIGNAL ANALYSIS');

  if (signals.length === 0) {
    console.log(chalk.yellow('  No signals recorded today.'));
    return;
  }

  // Basic counts
  const triggered = signals.filter(s => s.eventType === 'triggered');
  const deepExtreme = signals.filter(s => s.eventType === 'deep_extreme');
  const playedOut = signals.filter(s => s.eventType === 'played_out');

  printSubHeader('Signal Summary');
  console.log(`  Total events: ${chalk.white.bold(signals.length)}`);
  console.log(`  Triggered signals: ${chalk.green.bold(triggered.length)}`);
  console.log(`  Deep extreme signals: ${chalk.yellow.bold(deepExtreme.length)}`);
  console.log(`  Played out signals: ${chalk.blue.bold(playedOut.length)}`);

  // By direction
  printSubHeader('By Direction');
  const longs = triggered.filter(s => s.direction === 'long');
  const shorts = triggered.filter(s => s.direction === 'short');
  console.log(`  Long setups: ${chalk.green(longs.length)} (${((longs.length / triggered.length) * 100 || 0).toFixed(0)}%)`);
  console.log(`  Short setups: ${chalk.red(shorts.length)} (${((shorts.length / triggered.length) * 100 || 0).toFixed(0)}%)`);

  // By timeframe
  printSubHeader('By Timeframe');
  const byTf: Record<string, number> = {};
  for (const s of triggered) {
    byTf[s.timeframe] = (byTf[s.timeframe] || 0) + 1;
  }
  for (const [tf, count] of Object.entries(byTf).sort((a, b) => b[1] - a[1])) {
    const bar = '█'.repeat(Math.min(count, 30));
    console.log(`  ${tf.padEnd(4)} ${chalk.cyan(bar)} ${count}`);
  }

  // By quality tier
  printSubHeader('By Quality Tier');
  const byTier: Record<string, number> = {};
  for (const s of triggered) {
    const tier = s.qualityTier || 'unknown';
    byTier[tier] = (byTier[tier] || 0) + 1;
  }
  for (const [tier, count] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
    const color = tier === 'bluechip' ? chalk.blue : tier === 'midcap' ? chalk.yellow : chalk.red;
    console.log(`  ${color(tier.padEnd(12))} ${count}`);
  }

  // Unique symbols
  printSubHeader('Most Active Symbols');
  const bySymbol: Record<string, number> = {};
  for (const s of triggered) {
    bySymbol[s.symbol] = (bySymbol[s.symbol] || 0) + 1;
  }
  const topSymbols = Object.entries(bySymbol).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [symbol, count] of topSymbols) {
    console.log(`  ${symbol.replace('USDT', '').padEnd(10)} ${count} signals`);
  }

  // RSI distribution at trigger
  printSubHeader('RSI at Trigger');
  const rsiValues = triggered.map(s => s.rsi);
  if (rsiValues.length > 0) {
    const avgRsi = rsiValues.reduce((a, b) => a + b, 0) / rsiValues.length;
    const minRsi = Math.min(...rsiValues);
    const maxRsi = Math.max(...rsiValues);
    console.log(`  Average: ${avgRsi.toFixed(1)}`);
    console.log(`  Range: ${minRsi.toFixed(1)} - ${maxRsi.toFixed(1)}`);

    // Histogram
    const buckets = [0, 0, 0, 0, 0]; // <20, 20-30, 30-70, 70-80, >80
    for (const rsi of rsiValues) {
      if (rsi < 20) buckets[0]++;
      else if (rsi < 30) buckets[1]++;
      else if (rsi < 70) buckets[2]++;
      else if (rsi < 80) buckets[3]++;
      else buckets[4]++;
    }
    console.log(`  <20 (deep oversold): ${buckets[0]}`);
    console.log(`  20-30 (oversold): ${buckets[1]}`);
    console.log(`  30-70 (neutral): ${buckets[2]}`);
    console.log(`  70-80 (overbought): ${buckets[3]}`);
    console.log(`  >80 (deep overbought): ${buckets[4]}`);
  }
}

function analyzeTrades(trades: TradeEvent[]): void {
  printHeader('TRADE ANALYSIS');

  const closeTrades = trades.filter(t => t.eventType === 'close');

  if (closeTrades.length === 0) {
    console.log(chalk.yellow('  No completed trades today.'));
    return;
  }

  // Performance overview
  printSubHeader('Performance Overview');
  const totalPnL = closeTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const wins = closeTrades.filter(t => (t.realizedPnL || 0) > 0);
  const losses = closeTrades.filter(t => (t.realizedPnL || 0) < 0);
  const winRate = (wins.length / closeTrades.length) * 100;

  const pnlColor = totalPnL >= 0 ? chalk.green : chalk.red;
  console.log(`  Net P&L: ${pnlColor.bold(formatCurrency(totalPnL))}`);
  console.log(`  Trades: ${closeTrades.length} (${chalk.green(wins.length + ' wins')} / ${chalk.red(losses.length + ' losses')})`);
  console.log(`  Win Rate: ${winRate >= 50 ? chalk.green(winRate.toFixed(1) + '%') : chalk.red(winRate.toFixed(1) + '%')}`);

  if (wins.length > 0) {
    const totalWins = wins.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const avgWin = totalWins / wins.length;
    const maxWin = Math.max(...wins.map(t => t.realizedPnL || 0));
    console.log(`  Avg Win: ${chalk.green(formatCurrency(avgWin))} | Max: ${chalk.green(formatCurrency(maxWin))}`);
  }

  if (losses.length > 0) {
    const totalLosses = Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));
    const avgLoss = totalLosses / losses.length;
    const maxLoss = Math.min(...losses.map(t => t.realizedPnL || 0));
    console.log(`  Avg Loss: ${chalk.red(formatCurrency(-avgLoss))} | Max: ${chalk.red(formatCurrency(maxLoss))}`);
  }

  // Profit factor
  const grossProfit = wins.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  console.log(`  Profit Factor: ${profitFactor >= 1 ? chalk.green(profitFactor.toFixed(2)) : chalk.red(profitFactor.toFixed(2))}`);

  // By exit reason
  printSubHeader('Exit Logic Comparison');
  const byExit: Record<string, { count: number; pnl: number }> = {};
  for (const t of closeTrades) {
    const reason = t.exitReason || 'Unknown';
    if (!byExit[reason]) byExit[reason] = { count: 0, pnl: 0 };
    byExit[reason].count++;
    byExit[reason].pnl += t.realizedPnL || 0;
  }
  for (const [reason, data] of Object.entries(byExit).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const avgPnl = data.pnl / data.count;
    const winRateForReason = closeTrades.filter(t => t.exitReason === reason && (t.realizedPnL || 0) > 0).length / data.count * 100;
    console.log(`  ${reason.padEnd(20)} ${data.count} trades | P&L: ${formatCurrency(data.pnl).padStart(10)} | Avg: ${formatCurrency(avgPnl).padStart(8)} | WR: ${winRateForReason.toFixed(0)}%`);
  }

  // By direction
  printSubHeader('Directional Performance');
  const longTrades = closeTrades.filter(t => t.direction === 'long');
  const shortTrades = closeTrades.filter(t => t.direction === 'short');

  const longPnL = longTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const shortPnL = shortTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const longWinRate = longTrades.length > 0 ? longTrades.filter(t => (t.realizedPnL || 0) > 0).length / longTrades.length * 100 : 0;
  const shortWinRate = shortTrades.length > 0 ? shortTrades.filter(t => (t.realizedPnL || 0) > 0).length / shortTrades.length * 100 : 0;

  console.log(`  LONG:  ${longTrades.length} trades | P&L: ${formatCurrency(longPnL).padStart(10)} | WR: ${longWinRate.toFixed(0)}%`);
  console.log(`  SHORT: ${shortTrades.length} trades | P&L: ${formatCurrency(shortPnL).padStart(10)} | WR: ${shortWinRate.toFixed(0)}%`);

  // By timeframe
  printSubHeader('Timeframe Performance');
  const byTf: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of closeTrades) {
    if (!byTf[t.timeframe]) byTf[t.timeframe] = { count: 0, pnl: 0, wins: 0 };
    byTf[t.timeframe].count++;
    byTf[t.timeframe].pnl += t.realizedPnL || 0;
    if ((t.realizedPnL || 0) > 0) byTf[t.timeframe].wins++;
  }
  for (const [tf, data] of Object.entries(byTf).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const winRate = (data.wins / data.count) * 100;
    const pnlColor = data.pnl >= 0 ? chalk.green : chalk.red;
    console.log(`  ${tf.padEnd(4)} ${data.count} trades | P&L: ${pnlColor(formatCurrency(data.pnl).padStart(10))} | WR: ${winRate.toFixed(0)}%`);
  }

  // Trade duration analysis
  printSubHeader('Trade Duration');
  const durations = closeTrades.map(t => t.durationMs || 0).filter(d => d > 0);
  if (durations.length > 0) {
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    console.log(`  Average: ${formatDuration(avgDuration)}`);
    console.log(`  Shortest: ${formatDuration(minDuration)}`);
    console.log(`  Longest: ${formatDuration(maxDuration)}`);

    // Duration vs outcome
    const shortDurationTrades = closeTrades.filter(t => (t.durationMs || 0) < 30 * 60 * 1000); // <30min
    const longDurationTrades = closeTrades.filter(t => (t.durationMs || 0) >= 30 * 60 * 1000);

    if (shortDurationTrades.length > 0 && longDurationTrades.length > 0) {
      const shortPnL = shortDurationTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
      const longPnL = longDurationTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
      console.log(`  Quick trades (<30m): ${shortDurationTrades.length} | P&L: ${formatCurrency(shortPnL)}`);
      console.log(`  Long trades (≥30m): ${longDurationTrades.length} | P&L: ${formatCurrency(longPnL)}`);
    }
  }

  // Individual trade log
  printSubHeader('Trade Log (Most Recent)');
  const recentTrades = closeTrades.slice(-10).reverse();
  for (const t of recentTrades) {
    const dir = t.direction === 'long' ? chalk.green('L') : chalk.red('S');
    const pnlColor = (t.realizedPnL || 0) >= 0 ? chalk.green : chalk.red;
    const symbol = t.symbol.replace('USDT', '').padEnd(8);
    const tf = t.timeframe.padEnd(3);
    const pnl = pnlColor(formatCurrency(t.realizedPnL || 0).padStart(10));
    const reason = (t.exitReason || '').substring(0, 15).padEnd(15);
    const duration = formatDuration(t.durationMs || 0).padStart(6);
    console.log(`  ${symbol} ${dir} ${tf} ${pnl} ${reason} ${duration}`);
  }
}

function generateInsights(signals: SignalEvent[], trades: TradeEvent[]): void {
  printHeader('ACTIONABLE INSIGHTS');

  const closeTrades = trades.filter(t => t.eventType === 'close');
  const triggered = signals.filter(s => s.eventType === 'triggered');

  if (closeTrades.length === 0) {
    console.log(chalk.yellow('  Not enough data for insights.'));
    return;
  }

  const insights: string[] = [];

  // Check direction bias
  const longTrades = closeTrades.filter(t => t.direction === 'long');
  const shortTrades = closeTrades.filter(t => t.direction === 'short');
  const longPnL = longTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const shortPnL = shortTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);

  if (longPnL > shortPnL * 2 && longTrades.length > 3) {
    insights.push(`${chalk.green('↑')} LONG setups outperforming (${formatCurrency(longPnL)} vs ${formatCurrency(shortPnL)}). Consider increasing long exposure.`);
  } else if (shortPnL > longPnL * 2 && shortTrades.length > 3) {
    insights.push(`${chalk.red('↓')} SHORT setups outperforming (${formatCurrency(shortPnL)} vs ${formatCurrency(longPnL)}). Consider increasing short exposure.`);
  }

  // Check timeframe performance
  const byTf: Record<string, { count: number; pnl: number }> = {};
  for (const t of closeTrades) {
    if (!byTf[t.timeframe]) byTf[t.timeframe] = { count: 0, pnl: 0 };
    byTf[t.timeframe].count++;
    byTf[t.timeframe].pnl += t.realizedPnL || 0;
  }

  const sortedTfs = Object.entries(byTf).sort((a, b) => b[1].pnl - a[1].pnl);
  if (sortedTfs.length > 1) {
    const best = sortedTfs[0];
    const worst = sortedTfs[sortedTfs.length - 1];
    if (best[1].pnl > 0 && worst[1].pnl < 0) {
      insights.push(`${chalk.cyan('⏱')}  ${best[0]} timeframe profitable (${formatCurrency(best[1].pnl)}), ${worst[0]} unprofitable (${formatCurrency(worst[1].pnl)}). Consider focusing on ${best[0]}.`);
    }
  }

  // Check exit effectiveness
  const byExit: Record<string, { count: number; pnl: number }> = {};
  for (const t of closeTrades) {
    const reason = t.exitReason || 'Unknown';
    if (!byExit[reason]) byExit[reason] = { count: 0, pnl: 0 };
    byExit[reason].count++;
    byExit[reason].pnl += t.realizedPnL || 0;
  }

  const tpExits = byExit['Take Profit Hit'];
  const slExits = byExit['Stop Loss Hit'];
  const playedOutExits = byExit['Setup Played Out'];

  if (tpExits && slExits) {
    if (slExits.count > tpExits.count * 2) {
      insights.push(`${chalk.red('⚠')}  High stop-loss ratio (${slExits.count} SL vs ${tpExits.count} TP). Consider widening stops or tightening entry criteria.`);
    }
    if (tpExits.count > slExits.count * 2) {
      insights.push(`${chalk.green('✓')} Take-profit exits dominating. Current risk/reward settings working well.`);
    }
  }

  if (playedOutExits && playedOutExits.pnl < 0) {
    insights.push(`${chalk.yellow('!')} "Played Out" exits are negative (${formatCurrency(playedOutExits.pnl)}). Consider using trailing stops instead.`);
  }

  // Check win rate
  const wins = closeTrades.filter(t => (t.realizedPnL || 0) > 0);
  const winRate = (wins.length / closeTrades.length) * 100;
  if (winRate < 40) {
    insights.push(`${chalk.red('⚠')}  Low win rate (${winRate.toFixed(0)}%). Consider stricter entry filters or review signal quality.`);
  } else if (winRate > 60) {
    insights.push(`${chalk.green('✓')} Strong win rate (${winRate.toFixed(0)}%). Strategy performing well.`);
  }

  // Check signal quality correlation
  const triggerToTrade = closeTrades.length / Math.max(triggered.length, 1);
  if (triggerToTrade < 0.5 && triggered.length > 10) {
    insights.push(`${chalk.cyan('📊')} Only ${(triggerToTrade * 100).toFixed(0)}% of triggered signals converted to trades. Consider increasing position limits.`);
  }

  // Print insights
  printSubHeader('Recommendations');
  if (insights.length === 0) {
    console.log(chalk.gray('  No specific recommendations based on today\'s data.'));
  } else {
    for (const insight of insights) {
      console.log(`  ${insight}`);
    }
  }

  // Suggested experiments
  printSubHeader('Experiments to Consider');
  console.log(chalk.gray('  1. Test different TP/SL ratios (current: 20%/20%)'));
  console.log(chalk.gray('  2. Compare RSI thresholds (25/75 vs 30/70)'));
  console.log(chalk.gray('  3. Add market cap tier filtering (bluechip only vs all)'));
  console.log(chalk.gray('  4. Test multi-timeframe confirmation (require 2+ TF alignment)'));
}

function analyzeMarketConditions(snapshots: MarketSnapshot[]): void {
  printHeader('MARKET CONDITIONS');

  if (snapshots.length === 0) {
    console.log(chalk.yellow('  No market snapshots recorded today.'));
    return;
  }

  printSubHeader('BTC Price Movement');
  const prices = snapshots.map(s => s.btcPrice);
  const priceHigh = Math.max(...prices);
  const priceLow = Math.min(...prices);
  const priceOpen = prices[0];
  const priceClose = prices[prices.length - 1];
  const priceChange = ((priceClose - priceOpen) / priceOpen) * 100;
  const volatility = ((priceHigh - priceLow) / ((priceHigh + priceLow) / 2)) * 100;

  const changeColor = priceChange >= 0 ? chalk.green : chalk.red;
  console.log(`  Open/Close: $${priceOpen.toFixed(0)} → $${priceClose.toFixed(0)} (${changeColor(priceChange.toFixed(2) + '%')})`);
  console.log(`  Range: $${priceLow.toFixed(0)} - $${priceHigh.toFixed(0)}`);
  console.log(`  Volatility: ${volatility.toFixed(2)}%`);

  printSubHeader('Market Bias Distribution');
  const biasDistribution: Record<string, number> = {};
  for (const snap of snapshots) {
    biasDistribution[snap.marketBias] = (biasDistribution[snap.marketBias] || 0) + 1;
  }
  const totalSnapshots = snapshots.length;
  for (const [bias, count] of Object.entries(biasDistribution).sort((a, b) => b[1] - a[1])) {
    const pct = (count / totalSnapshots * 100).toFixed(0);
    const bar = '█'.repeat(Math.floor(count / totalSnapshots * 30));
    const biasColor = bias.includes('long') ? chalk.green : bias.includes('short') ? chalk.red : chalk.gray;
    console.log(`  ${biasColor(bias.padEnd(12))} ${bar} ${pct}% (${count})`);
  }

  // Average bias score
  const avgBiasScore = snapshots.reduce((sum, s) => sum + s.biasScore, 0) / snapshots.length;
  const biasColor = avgBiasScore > 25 ? chalk.green : avgBiasScore < -25 ? chalk.red : chalk.gray;
  console.log(`  Average Bias Score: ${biasColor(avgBiasScore.toFixed(1))}`);

  printSubHeader('BTC RSI Summary');
  const rsi4hValues = snapshots.map(s => s.btcRsi.rsi4h);
  const rsi1hValues = snapshots.map(s => s.btcRsi.rsi1h);
  const avg4h = rsi4hValues.reduce((a, b) => a + b, 0) / rsi4hValues.length;
  const avg1h = rsi1hValues.reduce((a, b) => a + b, 0) / rsi1hValues.length;
  console.log(`  4H RSI: avg ${avg4h.toFixed(1)}, range ${Math.min(...rsi4hValues).toFixed(0)}-${Math.max(...rsi4hValues).toFixed(0)}`);
  console.log(`  1H RSI: avg ${avg1h.toFixed(1)}, range ${Math.min(...rsi1hValues).toFixed(0)}-${Math.max(...rsi1hValues).toFixed(0)}`);

  printSubHeader('Setup Activity Correlation');
  // Check if more setups appear during certain bias states
  const setupsByBias: Record<string, { total: number; triggered: number }> = {};
  for (const snap of snapshots) {
    if (!setupsByBias[snap.marketBias]) {
      setupsByBias[snap.marketBias] = { total: 0, triggered: 0 };
    }
    setupsByBias[snap.marketBias].total += snap.activeSetups.total;
    setupsByBias[snap.marketBias].triggered += snap.activeSetups.triggered;
  }
  for (const [bias, data] of Object.entries(setupsByBias)) {
    const avgSetups = (data.total / (biasDistribution[bias] || 1)).toFixed(1);
    const avgTriggered = (data.triggered / (biasDistribution[bias] || 1)).toFixed(1);
    console.log(`  ${bias.padEnd(12)}: avg ${avgSetups} setups, ${avgTriggered} triggered per snapshot`);
  }
}

function printLLMPrompt(date: string): void {
  const persistence = getDataPersistence();
  const prompt = persistence.generateAnalysisPrompt(date);
  console.log('\n' + chalk.cyan.bold('═'.repeat(70)));
  console.log(chalk.cyan.bold('  LLM ANALYSIS PROMPT'));
  console.log(chalk.cyan.bold('═'.repeat(70)));
  console.log(chalk.gray('\nCopy the following prompt to query an LLM for insights:\n'));
  console.log(prompt);
  console.log('\n' + chalk.gray('─'.repeat(70)));
}

function printUsage(): void {
  console.log(`
${chalk.bold('Usage:')} npx tsx src/analyze.ts [options] [date]

${chalk.bold('Options:')}
  --llm           Generate LLM-friendly analysis prompt
  --summary       Generate/regenerate daily summary
  --list          List available dates with data

${chalk.bold('Examples:')}
  npx tsx src/analyze.ts                  # Analyze today's data
  npx tsx src/analyze.ts 2025-01-08       # Analyze specific date
  npx tsx src/analyze.ts --llm            # Generate LLM prompt for today
  npx tsx src/analyze.ts --llm 2025-01-08 # Generate LLM prompt for date
  npx tsx src/analyze.ts --list           # Show available dates
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Handle --list option
  if (args.includes('--list')) {
    console.log(chalk.bold('\n  Available dates with data:\n'));
    const persistence = getDataPersistence();
    const dates = persistence.listAvailableDates();
    if (dates.length === 0) {
      console.log(chalk.yellow('  No data available.'));
    } else {
      for (const d of dates) {
        const summary = persistence.loadDailySummary(d);
        const trades = persistence.loadTrades(d).filter(t => t.eventType === 'close');
        const totalPnL = trades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        const pnlColor = totalPnL >= 0 ? chalk.green : chalk.red;
        console.log(`  ${d}  ${trades.length} trades  ${pnlColor(formatCurrency(totalPnL))}`);
      }
    }
    process.exit(0);
  }

  // Handle --help option
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Parse date (first non-flag argument)
  const date = args.find(a => !a.startsWith('--')) || getDateString();

  // Handle --llm option
  if (args.includes('--llm')) {
    printLLMPrompt(date);
    process.exit(0);
  }

  // Handle --summary option
  if (args.includes('--summary')) {
    const persistence = getDataPersistence();
    const summary = persistence.generateDailySummary(date);
    console.log(chalk.green(`\n  Daily summary generated for ${date}`));
    console.log(chalk.gray(`  Saved to: data/daily/${date}.json\n`));
    process.exit(0);
  }

  console.log(chalk.bold(`\n  BACKBURNER DAILY ANALYSIS - ${date}\n`));

  // Check if data exists
  if (!fs.existsSync(DATA_DIR)) {
    console.log(chalk.red('  No data directory found. Run the screener first to collect data.'));
    console.log(chalk.gray(`  Expected: ${DATA_DIR}`));
    process.exit(1);
  }

  const signals = loadSignals(date);
  const trades = loadTrades(date);
  const marketSnapshots = loadMarketSnapshots(date);

  if (signals.length === 0 && trades.length === 0 && marketSnapshots.length === 0) {
    console.log(chalk.yellow(`  No data found for ${date}.`));
    console.log(chalk.gray('  Available dates:'));

    // List available dates
    const dates = new Set<string>();
    if (fs.existsSync(SIGNALS_DIR)) {
      for (const file of fs.readdirSync(SIGNALS_DIR)) {
        if (file.endsWith('.json')) {
          dates.add(file.replace('.json', ''));
        }
      }
    }
    for (const d of [...dates].sort().reverse().slice(0, 5)) {
      console.log(chalk.gray(`    - ${d}`));
    }
    process.exit(1);
  }

  // Run analyses
  if (marketSnapshots.length > 0) {
    analyzeMarketConditions(marketSnapshots);
  }
  analyzeSignals(signals);
  analyzeTrades(trades);
  generateInsights(signals, trades);

  // Suggest LLM analysis
  console.log(chalk.gray('\n  Tip: Run with --llm to generate a prompt for LLM analysis'));
  console.log('\n');
}

main().catch(console.error);
