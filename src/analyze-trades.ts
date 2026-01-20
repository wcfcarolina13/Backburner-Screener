#!/usr/bin/env node
/**
 * Analyze Actual Trade Data - Spot vs Futures Comparison
 *
 * Uses the actual trade logs from shadow bots to compare:
 * 1. Real futures performance (what bots actually did)
 * 2. Hypothetical spot-only performance (filtering for long-only)
 *
 * This gives us ground truth data, not simulations.
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
  entryTime?: string;
  exitPrice?: number;
  exitTime?: string;
  marginUsed?: number;
  notionalSize?: number;
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

interface AnalysisResult {
  totalTrades: number;
  completedTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: string;
  byTimeframe: Record<string, { trades: number; pnl: number; wins: number }>;
  byDirection: Record<string, { trades: number; pnl: number; wins: number }>;
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
        console.log(`Warning: Could not parse ${filePath}`);
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

  // Add unclosed trades
  for (const open of openTrades.values()) {
    pairs.push({ open, close: null });
  }

  return pairs;
}

function analyzeBot(pairs: TradePair[], botId: string, longOnly: boolean = false): AnalysisResult {
  const botPairs = pairs.filter(p => p.open.botId === botId);
  const completedPairs = botPairs.filter(p => p.close !== null);

  // Filter for long-only if requested
  const relevantPairs = longOnly
    ? completedPairs.filter(p => p.open.direction === 'long')
    : completedPairs;

  const wins = relevantPairs.filter(p => (p.close?.realizedPnL || 0) > 0);
  const losses = relevantPairs.filter(p => (p.close?.realizedPnL || 0) <= 0);

  const totalPnL = relevantPairs.reduce((sum, p) => sum + (p.close?.realizedPnL || 0), 0);
  const grossProfit = wins.reduce((sum, p) => sum + (p.close?.realizedPnL || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.close?.realizedPnL || 0), 0));

  // By timeframe
  const byTimeframe: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const pair of relevantPairs) {
    const tf = pair.open.timeframe;
    if (!byTimeframe[tf]) {
      byTimeframe[tf] = { trades: 0, pnl: 0, wins: 0 };
    }
    byTimeframe[tf].trades++;
    byTimeframe[tf].pnl += pair.close?.realizedPnL || 0;
    if ((pair.close?.realizedPnL || 0) > 0) {
      byTimeframe[tf].wins++;
    }
  }

  // By direction
  const byDirection: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const pair of completedPairs) {  // Use all completed pairs for direction analysis
    const dir = pair.open.direction;
    if (!byDirection[dir]) {
      byDirection[dir] = { trades: 0, pnl: 0, wins: 0 };
    }
    byDirection[dir].trades++;
    byDirection[dir].pnl += pair.close?.realizedPnL || 0;
    if ((pair.close?.realizedPnL || 0) > 0) {
      byDirection[dir].wins++;
    }
  }

  return {
    totalTrades: botPairs.length,
    completedTrades: relevantPairs.length,
    longTrades: relevantPairs.filter(p => p.open.direction === 'long').length,
    shortTrades: relevantPairs.filter(p => p.open.direction === 'short').length,
    wins: wins.length,
    losses: losses.length,
    winRate: relevantPairs.length > 0 ? (wins.length / relevantPairs.length * 100).toFixed(1) : '0',
    totalPnL,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 'Inf' : '0'),
    byTimeframe,
    byDirection,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let days = 4;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }

  console.log('='.repeat(80));
  console.log(`ACTUAL TRADE ANALYSIS - Last ${days} days`);
  console.log('='.repeat(80));
  console.log('');

  // Calculate date range
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log('');

  // Load trades
  console.log('Loading trades from local files...');
  const trades = loadTradesFromFiles(startStr, endStr);
  console.log(`Loaded ${trades.length} trade events`);

  if (trades.length === 0) {
    console.log('No trades found.');
    return;
  }

  // Get unique bot IDs
  const botIds = [...new Set(trades.map(t => t.botId))].sort();
  console.log(`Found ${botIds.length} bots: ${botIds.join(', ')}`);
  console.log('');

  // Match open/close pairs
  const pairs = matchOpenClose(trades);
  const completedCount = pairs.filter(p => p.close).length;
  console.log(`Matched ${completedCount} completed trades`);
  console.log('');

  // Analyze each bot
  console.log('='.repeat(80));
  console.log('BOT PERFORMANCE (FULL STRATEGY - Long + Short)');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Bot'.padEnd(20) +
    'Trades'.padStart(8) +
    'L/S'.padStart(10) +
    'Win%'.padStart(8) +
    'PF'.padStart(8) +
    'P&L'.padStart(14);
  console.log(header);
  console.log('-'.repeat(80));

  const results: Array<{ botId: string; analysis: AnalysisResult }> = [];

  for (const botId of botIds) {
    const analysis = analyzeBot(pairs, botId, false);
    results.push({ botId, analysis });

    const row = botId.padEnd(20) +
      analysis.completedTrades.toString().padStart(8) +
      `${analysis.longTrades}/${analysis.shortTrades}`.padStart(10) +
      `${analysis.winRate}%`.padStart(8) +
      analysis.profitFactor.padStart(8) +
      `$${analysis.totalPnL.toFixed(2)}`.padStart(14);
    console.log(row);
  }
  console.log('-'.repeat(80));

  // Hypothetical spot-only (long-only) analysis
  console.log('');
  console.log('='.repeat(80));
  console.log('HYPOTHETICAL SPOT-ONLY (Long trades only)');
  console.log('='.repeat(80));
  console.log('');

  console.log(header);
  console.log('-'.repeat(80));

  for (const botId of botIds) {
    const analysis = analyzeBot(pairs, botId, true);

    const row = botId.padEnd(20) +
      analysis.completedTrades.toString().padStart(8) +
      `${analysis.longTrades}/${analysis.shortTrades}`.padStart(10) +
      `${analysis.winRate}%`.padStart(8) +
      analysis.profitFactor.padStart(8) +
      `$${analysis.totalPnL.toFixed(2)}`.padStart(14);
    console.log(row);
  }
  console.log('-'.repeat(80));

  // Breakdown by direction (for full strategy)
  console.log('');
  console.log('='.repeat(80));
  console.log('P&L BY DIRECTION (All bots combined)');
  console.log('='.repeat(80));

  // Aggregate all bots
  let totalLongPnL = 0, totalShortPnL = 0;
  let totalLongTrades = 0, totalShortTrades = 0;
  let totalLongWins = 0, totalShortWins = 0;

  for (const { analysis } of results) {
    if (analysis.byDirection['long']) {
      totalLongPnL += analysis.byDirection['long'].pnl;
      totalLongTrades += analysis.byDirection['long'].trades;
      totalLongWins += analysis.byDirection['long'].wins;
    }
    if (analysis.byDirection['short']) {
      totalShortPnL += analysis.byDirection['short'].pnl;
      totalShortTrades += analysis.byDirection['short'].trades;
      totalShortWins += analysis.byDirection['short'].wins;
    }
  }

  console.log(`\nLONG trades:  ${totalLongTrades} trades, ${totalLongWins} wins (${(totalLongWins/totalLongTrades*100).toFixed(1)}%), P&L: $${totalLongPnL.toFixed(2)}`);
  console.log(`SHORT trades: ${totalShortTrades} trades, ${totalShortWins} wins (${(totalShortWins/totalShortTrades*100).toFixed(1)}%), P&L: $${totalShortPnL.toFixed(2)}`);

  // Key insight
  console.log('');
  console.log('='.repeat(80));
  console.log('KEY INSIGHT FOR SPOT-ONLY TRADING');
  console.log('='.repeat(80));

  const fullP = totalLongPnL + totalShortPnL;
  const spotP = totalLongPnL;

  console.log(`\nFull strategy (Long+Short): $${fullP.toFixed(2)}`);
  console.log(`Spot-only (Long only):      $${spotP.toFixed(2)}`);

  if (fullP !== 0) {
    const ratio = (spotP / fullP * 100).toFixed(1);
    console.log(`\n→ Spot captures ${ratio}% of full strategy P&L`);
  }

  if (totalLongPnL > 0 && totalShortPnL < 0) {
    console.log('→ LONG trades are profitable, SHORT trades are losing');
    console.log('→ Spot-only would OUTPERFORM the full strategy!');
  } else if (totalLongPnL < 0 && totalShortPnL > 0) {
    console.log('→ LONG trades are losing, SHORT trades are profitable');
    console.log('→ Spot-only would UNDERPERFORM the full strategy significantly');
  } else if (totalLongPnL > 0 && totalShortPnL > 0) {
    console.log('→ Both directions are profitable');
    console.log('→ Spot-only would capture a portion of the gains');
  } else {
    console.log('→ Both directions are losing');
    console.log('→ Strategy needs review before live trading');
  }

  // Best bot for spot-only
  console.log('');
  const spotResults = botIds.map(botId => ({
    botId,
    analysis: analyzeBot(pairs, botId, true)
  }));
  const bestSpotBot = spotResults.reduce((best, curr) =>
    curr.analysis.totalPnL > best.analysis.totalPnL ? curr : best
  );

  console.log(`📊 Best bot for spot-only: ${bestSpotBot.botId}`);
  console.log(`   P&L: $${bestSpotBot.analysis.totalPnL.toFixed(2)}`);
  console.log(`   Win Rate: ${bestSpotBot.analysis.winRate}%`);
  console.log(`   Trades: ${bestSpotBot.analysis.completedTrades}`);
}

main().catch(console.error);
