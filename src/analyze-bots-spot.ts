#!/usr/bin/env node
/**
 * Per-Bot Spot Analysis
 *
 * Analyzes each bot INDIVIDUALLY to find which ones would be profitable
 * with spot-only (long-only, 1x leverage) trading.
 *
 * Key question: Which specific bot should we run for spot trading?
 */

import * as fs from 'fs';
import * as path from 'path';

interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: string;
  entryPrice?: number;
  exitPrice?: number;
  leverage: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  signalRsi?: number;
}

interface TradePair {
  open: TradeEvent;
  close: TradeEvent | null;
}

interface BotAnalysis {
  botId: string;
  botType: 'backburner' | 'gp' | 'gp2' | 'shadow' | 'unknown';

  // Full strategy (as bot ran)
  fullTrades: number;
  fullLongs: number;
  fullShorts: number;
  fullWins: number;
  fullWinRate: number;
  fullPnL: number;

  // Spot-only (long trades only, simulated at 1x)
  spotTrades: number;
  spotWins: number;
  spotWinRate: number;
  spotPnL: number;  // Adjusted for 1x leverage

  // By timeframe
  byTimeframe: Record<string, {
    trades: number;
    wins: number;
    pnl: number;
  }>;

  // Sample trades
  sampleTrades: Array<{
    symbol: string;
    timeframe: string;
    pnlPercent: number;
    exitReason: string;
  }>;
}

function loadTradesFromFiles(startDate: string, endDate: string): TradeEvent[] {
  const tradesDir = path.join(process.cwd(), 'data', 'trades');
  const trades: TradeEvent[] = [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const filePath = path.join(tradesDir, `${dateStr}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const dayTrades: TradeEvent[] = JSON.parse(content);
        trades.push(...dayTrades);
      } catch (e) {
        // Skip
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return trades;
}

function matchOpenClose(trades: TradeEvent[]): TradePair[] {
  const pairs: TradePair[] = [];
  const openTrades = new Map<string, TradeEvent>();

  for (const trade of trades) {
    if (trade.eventType === 'open') {
      const key = `${trade.botId}-${trade.positionId}`;
      openTrades.set(key, trade);
    } else if (trade.eventType === 'close') {
      const key = `${trade.botId}-${trade.positionId}`;
      const open = openTrades.get(key);
      if (open) {
        pairs.push({ open, close: trade });
        openTrades.delete(key);
      }
    }
  }

  return pairs;
}

function getBotType(botId: string): 'backburner' | 'gp' | 'gp2' | 'shadow' | 'unknown' {
  if (botId.startsWith('gp2-')) return 'gp2';
  if (botId.startsWith('gp-')) return 'gp';
  if (botId.startsWith('shadow-')) return 'shadow';
  if (['aggressive', 'aggressive-2cb', 'standard', 'standard-05cb', 'wide', 'wide-2cb',
       'fixed', 'fixed-be', '1pct', '10pct10x', '10pct20x', 'confluence'].includes(botId)) {
    return 'backburner';
  }
  return 'unknown';
}

function analyzeBot(pairs: TradePair[], botId: string): BotAnalysis {
  const botPairs = pairs.filter(p => p.open.botId === botId);
  const completed = botPairs.filter(p => p.close !== null);

  const botType = getBotType(botId);

  // Full strategy analysis
  const fullLongs = completed.filter(p => p.open.direction === 'long');
  const fullShorts = completed.filter(p => p.open.direction === 'short');
  const fullWins = completed.filter(p => (p.close?.realizedPnL || 0) > 0);
  const fullPnL = completed.reduce((sum, p) => sum + (p.close?.realizedPnL || 0), 0);

  // Spot-only analysis (long trades only, adjusted to 1x leverage)
  const longTrades = completed.filter(p => p.open.direction === 'long');
  const spotWins = longTrades.filter(p => (p.close?.realizedPnL || 0) > 0);

  // Adjust P&L from actual leverage to 1x
  // If bot ran at 10x and made $10, at 1x it would have made $1
  let spotPnL = 0;
  for (const pair of longTrades) {
    const actualPnL = pair.close?.realizedPnL || 0;
    const leverage = pair.open.leverage || 10;
    const pnlAt1x = actualPnL / leverage;
    spotPnL += pnlAt1x;
  }

  // By timeframe
  const byTimeframe: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const pair of longTrades) {
    const tf = pair.open.timeframe;
    if (!byTimeframe[tf]) {
      byTimeframe[tf] = { trades: 0, wins: 0, pnl: 0 };
    }
    byTimeframe[tf].trades++;
    const actualPnL = pair.close?.realizedPnL || 0;
    const leverage = pair.open.leverage || 10;
    const pnlAt1x = actualPnL / leverage;
    byTimeframe[tf].pnl += pnlAt1x;
    if (actualPnL > 0) byTimeframe[tf].wins++;
  }

  // Sample trades
  const sampleTrades = longTrades.slice(0, 5).map(p => ({
    symbol: p.open.symbol,
    timeframe: p.open.timeframe,
    pnlPercent: p.close?.realizedPnLPercent || 0,
    exitReason: p.close?.exitReason || 'unknown',
  }));

  return {
    botId,
    botType,
    fullTrades: completed.length,
    fullLongs: fullLongs.length,
    fullShorts: fullShorts.length,
    fullWins: fullWins.length,
    fullWinRate: completed.length > 0 ? (fullWins.length / completed.length) * 100 : 0,
    fullPnL,
    spotTrades: longTrades.length,
    spotWins: spotWins.length,
    spotWinRate: longTrades.length > 0 ? (spotWins.length / longTrades.length) * 100 : 0,
    spotPnL,
    byTimeframe,
    sampleTrades,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let days = 7;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }

  console.log('='.repeat(80));
  console.log(`PER-BOT SPOT ANALYSIS (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Analyzing which individual bot performs best for SPOT (long-only, 1x)');
  console.log('P&L adjusted from actual leverage to 1x equivalent');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Load trades
  const trades = loadTradesFromFiles(startStr, endStr);
  console.log(`Loaded ${trades.length} trade events`);

  const pairs = matchOpenClose(trades);
  const completedCount = pairs.filter(p => p.close).length;
  console.log(`Matched ${completedCount} completed trades`);
  console.log('');

  // Get unique bot IDs
  const botIds = [...new Set(trades.map(t => t.botId))].sort();

  // Analyze each bot
  const analyses: BotAnalysis[] = [];
  for (const botId of botIds) {
    analyses.push(analyzeBot(pairs, botId));
  }

  // Sort by spot P&L (best first)
  analyses.sort((a, b) => b.spotPnL - a.spotPnL);

  // ============= BACKBURNER BOTS =============
  console.log('='.repeat(80));
  console.log('BACKBURNER BOTS - Spot Performance (Long-only, 1x)');
  console.log('='.repeat(80));
  console.log('');

  const backburnerBots = analyses.filter(a => a.botType === 'backburner');

  const header = 'Bot'.padEnd(18) +
    'Trades'.padStart(8) +
    'Wins'.padStart(6) +
    'Win%'.padStart(8) +
    'Spot P&L'.padStart(12) +
    'Full P&L'.padStart(12);

  console.log(header);
  console.log('-'.repeat(70));

  for (const bot of backburnerBots) {
    if (bot.spotTrades === 0) continue;
    const row = bot.botId.padEnd(18) +
      bot.spotTrades.toString().padStart(8) +
      bot.spotWins.toString().padStart(6) +
      `${bot.spotWinRate.toFixed(1)}%`.padStart(8) +
      `$${bot.spotPnL.toFixed(2)}`.padStart(12) +
      `$${bot.fullPnL.toFixed(2)}`.padStart(12);
    console.log(row);
  }

  // Best Backburner for spot
  const bestBackburner = backburnerBots.filter(b => b.spotTrades > 0)[0];
  if (bestBackburner) {
    console.log('');
    console.log(`📊 Best Backburner for Spot: ${bestBackburner.botId}`);
    console.log(`   Spot P&L: $${bestBackburner.spotPnL.toFixed(2)} | Win Rate: ${bestBackburner.spotWinRate.toFixed(1)}%`);
  }

  // ============= GP BOTS =============
  console.log('');
  console.log('='.repeat(80));
  console.log('GP BOTS - Spot Performance (Long-only, 1x)');
  console.log('='.repeat(80));
  console.log('');

  const gpBots = analyses.filter(a => a.botType === 'gp' || a.botType === 'gp2');

  console.log(header);
  console.log('-'.repeat(70));

  for (const bot of gpBots) {
    if (bot.spotTrades === 0) continue;
    const row = bot.botId.padEnd(18) +
      bot.spotTrades.toString().padStart(8) +
      bot.spotWins.toString().padStart(6) +
      `${bot.spotWinRate.toFixed(1)}%`.padStart(8) +
      `$${bot.spotPnL.toFixed(2)}`.padStart(12) +
      `$${bot.fullPnL.toFixed(2)}`.padStart(12);
    console.log(row);
  }

  // Best GP for spot
  const bestGP = gpBots.filter(b => b.spotTrades > 0)[0];
  if (bestGP) {
    console.log('');
    console.log(`📊 Best GP for Spot: ${bestGP.botId}`);
    console.log(`   Spot P&L: $${bestGP.spotPnL.toFixed(2)} | Win Rate: ${bestGP.spotWinRate.toFixed(1)}%`);
  }

  // ============= SHADOW BOTS =============
  console.log('');
  console.log('='.repeat(80));
  console.log('SHADOW BOTS - Spot Performance (Long-only, 1x)');
  console.log('='.repeat(80));
  console.log('');

  const shadowBots = analyses.filter(a => a.botType === 'shadow');

  console.log(header);
  console.log('-'.repeat(70));

  for (const bot of shadowBots) {
    if (bot.spotTrades === 0) continue;
    const row = bot.botId.padEnd(18) +
      bot.spotTrades.toString().padStart(8) +
      bot.spotWins.toString().padStart(6) +
      `${bot.spotWinRate.toFixed(1)}%`.padStart(8) +
      `$${bot.spotPnL.toFixed(2)}`.padStart(12) +
      `$${bot.fullPnL.toFixed(2)}`.padStart(12);
    console.log(row);
  }

  // ============= OVERALL RANKINGS =============
  console.log('');
  console.log('='.repeat(80));
  console.log('OVERALL SPOT RANKINGS (All Bots)');
  console.log('='.repeat(80));
  console.log('');

  // Filter to bots with at least 5 long trades
  const rankedBots = analyses
    .filter(a => a.spotTrades >= 5)
    .sort((a, b) => b.spotPnL - a.spotPnL);

  console.log('Rank  Bot'.padEnd(24) + 'Type'.padStart(12) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'Spot P&L'.padStart(12));
  console.log('-'.repeat(70));

  rankedBots.forEach((bot, idx) => {
    const profit = bot.spotPnL >= 0 ? '✅' : '❌';
    console.log(
      `${(idx + 1).toString().padStart(2)}.  ${profit} ${bot.botId.padEnd(18)}` +
      bot.botType.padStart(12) +
      bot.spotTrades.toString().padStart(8) +
      `${bot.spotWinRate.toFixed(1)}%`.padStart(8) +
      `$${bot.spotPnL.toFixed(2)}`.padStart(12)
    );
  });

  // ============= PROFITABLE BOTS =============
  const profitableBots = rankedBots.filter(b => b.spotPnL > 0);

  console.log('');
  console.log('='.repeat(80));
  console.log('PROFITABLE SPOT BOTS');
  console.log('='.repeat(80));

  if (profitableBots.length === 0) {
    console.log('\n❌ NO BOTS were profitable with spot-only (long-only, 1x) in this period.');
    console.log('   The market was bearish - all long positions lost money.');
  } else {
    console.log(`\n✅ ${profitableBots.length} bot(s) were profitable with spot-only:`);
    for (const bot of profitableBots) {
      console.log(`   ${bot.botId}: $${bot.spotPnL.toFixed(2)} (${bot.spotWinRate.toFixed(1)}% win rate)`);
    }
  }

  // ============= TIMEFRAME ANALYSIS =============
  console.log('');
  console.log('='.repeat(80));
  console.log('TIMEFRAME ANALYSIS (Aggregated across all bots)');
  console.log('='.repeat(80));
  console.log('');

  const tfAgg: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const bot of analyses) {
    for (const [tf, data] of Object.entries(bot.byTimeframe)) {
      if (!tfAgg[tf]) tfAgg[tf] = { trades: 0, wins: 0, pnl: 0 };
      tfAgg[tf].trades += data.trades;
      tfAgg[tf].wins += data.wins;
      tfAgg[tf].pnl += data.pnl;
    }
  }

  console.log('Timeframe'.padEnd(10) + 'Trades'.padStart(8) + 'Wins'.padStart(8) + 'Win%'.padStart(8) + 'Spot P&L'.padStart(12));
  console.log('-'.repeat(50));

  for (const [tf, data] of Object.entries(tfAgg).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const winRate = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0';
    const profit = data.pnl >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${tf.padEnd(8)}` +
      data.trades.toString().padStart(8) +
      data.wins.toString().padStart(8) +
      `${winRate}%`.padStart(8) +
      `$${data.pnl.toFixed(2)}`.padStart(12)
    );
  }

  // ============= RECOMMENDATIONS =============
  console.log('');
  console.log('='.repeat(80));
  console.log('RECOMMENDATIONS');
  console.log('='.repeat(80));

  // Find best performing timeframe
  const bestTf = Object.entries(tfAgg).sort((a, b) => b[1].pnl - a[1].pnl)[0];

  console.log('\n📊 Analysis Summary:');
  console.log(`   Total bots analyzed: ${analyses.length}`);
  console.log(`   Bots with 5+ long trades: ${rankedBots.length}`);
  console.log(`   Profitable bots (spot): ${profitableBots.length}`);

  if (bestTf) {
    console.log(`\n📈 Best Timeframe: ${bestTf[0]}`);
    console.log(`   P&L: $${bestTf[1].pnl.toFixed(2)} | ${bestTf[1].trades} trades | ${(bestTf[1].wins/bestTf[1].trades*100).toFixed(1)}% win rate`);
  }

  // Top 3 recommendations
  console.log('\n🎯 Top 3 Bots for Spot Trading:');
  for (let i = 0; i < Math.min(3, rankedBots.length); i++) {
    const bot = rankedBots[i];
    const status = bot.spotPnL >= 0 ? '✅' : '⚠️';
    console.log(`   ${i + 1}. ${status} ${bot.botId} (${bot.botType})`);
    console.log(`      P&L: $${bot.spotPnL.toFixed(2)} | ${bot.spotTrades} trades | ${bot.spotWinRate.toFixed(1)}% win`);
  }
}

main().catch(console.error);
