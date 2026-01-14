#!/usr/bin/env npx tsx
/**
 * Daily Performance Summary Generator
 *
 * Generates a daily summary of bot performance and appends to the performance log.
 *
 * Usage:
 *   npx tsx scripts/daily-summary.ts           # Summarize today
 *   npx tsx scripts/daily-summary.ts 2026-01-14  # Summarize specific date
 *
 * Scheduling (cron):
 *   # Run at 11:59 PM daily
 *   59 23 * * * cd /path/to/Backburner && npx tsx scripts/daily-summary.ts >> logs/daily-summary.log 2>&1
 *
 *   # Or on Mac with launchd, create ~/Library/LaunchAgents/com.backburner.daily-summary.plist
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
const LOG_FILE = path.join(ANALYSIS_DIR, 'daily-performance-log.md');

interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  symbol: string;
  direction: 'long' | 'short';
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  marginUsed?: number;
  leverage?: number;
}

interface BotStats {
  botId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
}

function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

function loadTrades(date: string): TradeEvent[] {
  const tradeFile = path.join(TRADES_DIR, `${date}.json`);
  const allTradesFile = path.join(TRADES_DIR, `${date}-all.json`);

  let trades: TradeEvent[] = [];

  if (fs.existsSync(tradeFile)) {
    try {
      trades = JSON.parse(fs.readFileSync(tradeFile, 'utf-8'));
    } catch (e) {
      console.error(`Failed to load ${tradeFile}:`, e);
    }
  }

  // Also load generic trades (BTC Bias bots, etc.)
  if (fs.existsSync(allTradesFile)) {
    try {
      const allTrades = JSON.parse(fs.readFileSync(allTradesFile, 'utf-8'));
      trades = [...trades, ...allTrades];
    } catch (e) {
      console.error(`Failed to load ${allTradesFile}:`, e);
    }
  }

  return trades;
}

function calculateBotStats(trades: TradeEvent[]): BotStats[] {
  const closedTrades = trades.filter(t => t.eventType === 'close');

  // Group by bot
  const botGroups = new Map<string, TradeEvent[]>();
  for (const trade of closedTrades) {
    const existing = botGroups.get(trade.botId) || [];
    existing.push(trade);
    botGroups.set(trade.botId, existing);
  }

  const stats: BotStats[] = [];

  for (const [botId, botTrades] of botGroups) {
    const wins = botTrades.filter(t => (t.realizedPnL || 0) > 0);
    const losses = botTrades.filter(t => (t.realizedPnL || 0) <= 0);
    const totalPnL = botTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);

    // Find best and worst trades
    let bestTrade: { symbol: string; pnl: number } | null = null;
    let worstTrade: { symbol: string; pnl: number } | null = null;

    for (const trade of botTrades) {
      const pnl = trade.realizedPnL || 0;
      if (!bestTrade || pnl > bestTrade.pnl) {
        bestTrade = { symbol: trade.symbol, pnl };
      }
      if (!worstTrade || pnl < worstTrade.pnl) {
        worstTrade = { symbol: trade.symbol, pnl };
      }
    }

    stats.push({
      botId,
      trades: botTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: botTrades.length > 0 ? (wins.length / botTrades.length) * 100 : 0,
      totalPnL,
      avgPnL: botTrades.length > 0 ? totalPnL / botTrades.length : 0,
      bestTrade,
      worstTrade,
    });
  }

  // Sort by P&L descending
  return stats.sort((a, b) => b.totalPnL - a.totalPnL);
}

function getBotDisplayName(botId: string): string {
  const names: Record<string, string> = {
    'fixed': 'Fixed TP/SL',
    '1pct': 'Trail Light (1%)',
    '10pct10x': 'Trail Standard (10x)',
    '10pct20x': 'Trail Aggressive (20x)',
    'wide': 'Trail Wide',
    'confluence': 'Confluence',
    'gp-conservative': 'GP-Conservative',
    'gp-standard': 'GP-Standard',
    'gp-aggressive': 'GP-Aggressive',
    'gp-yolo': 'GP-YOLO',
  };
  return names[botId] || botId;
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function generateMarkdownSummary(date: string, stats: BotStats[], trades: TradeEvent[]): string {
  const timestamp = new Date().toISOString();
  const totalTrades = trades.filter(t => t.eventType === 'close').length;
  const totalPnL = stats.reduce((sum, s) => sum + s.totalPnL, 0);

  // Determine market context from trade directions
  const closedTrades = trades.filter(t => t.eventType === 'close');
  const longs = closedTrades.filter(t => t.direction === 'long').length;
  const shorts = closedTrades.filter(t => t.direction === 'short').length;
  const marketBias = longs > shorts * 2 ? 'Bullish (mostly longs)' :
                     shorts > longs * 2 ? 'Bearish (mostly shorts)' :
                     'Mixed';

  let md = `
---

## ${date}

**Analysis Timestamp:** ${timestamp}
**Market Context:** ${marketBias}
**Total Trades:** ${totalTrades} | **Total P&L:** ${formatCurrency(totalPnL)}

### Performance Summary

| Bot | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L |
|-----|--------|------|--------|----------|-----------|---------|
`;

  for (const bot of stats) {
    const name = getBotDisplayName(bot.botId);
    const winRate = bot.winRate.toFixed(0);
    const totalPnL = formatCurrency(bot.totalPnL);
    const avgPnL = formatCurrency(bot.avgPnL);
    md += `| ${name} | ${bot.trades} | ${bot.wins} | ${bot.losses} | ${winRate}% | ${totalPnL} | ${avgPnL} |\n`;
  }

  // Add notable trades section
  const profitableBots = stats.filter(s => s.totalPnL > 0 && s.bestTrade);
  if (profitableBots.length > 0) {
    md += `\n### Notable Winning Trades\n\n`;
    for (const bot of profitableBots.slice(0, 3)) {
      if (bot.bestTrade && bot.bestTrade.pnl > 0) {
        md += `- **${getBotDisplayName(bot.botId)}**: ${bot.bestTrade.symbol.replace('USDT', '')} ${formatCurrency(bot.bestTrade.pnl)}\n`;
      }
    }
  }

  // Add observations
  md += `\n### Observations\n\n`;

  const topBot = stats[0];
  const worstBot = stats[stats.length - 1];

  if (topBot && topBot.totalPnL > 0) {
    md += `1. **Top performer:** ${getBotDisplayName(topBot.botId)} with ${formatCurrency(topBot.totalPnL)} (${topBot.winRate.toFixed(0)}% win rate)\n`;
  }

  if (worstBot && worstBot.totalPnL < 0) {
    md += `2. **Underperformer:** ${getBotDisplayName(worstBot.botId)} with ${formatCurrency(worstBot.totalPnL)}\n`;
  }

  const avgWinRate = stats.length > 0 ? stats.reduce((sum, s) => sum + s.winRate, 0) / stats.length : 0;
  md += `3. **Average win rate across all bots:** ${avgWinRate.toFixed(1)}%\n`;

  return md;
}

function appendToLog(content: string): void {
  // Ensure analysis directory exists
  if (!fs.existsSync(ANALYSIS_DIR)) {
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  }

  // Check if log file exists, create header if not
  if (!fs.existsSync(LOG_FILE)) {
    const header = `# Daily Bot Performance Log

Tracking bot performance to inform auto-trading decision.
Auto-generated by scripts/daily-summary.ts
`;
    fs.writeFileSync(LOG_FILE, header);
  }

  // Append new content
  fs.appendFileSync(LOG_FILE, content);
  console.log(`Summary appended to ${LOG_FILE}`);
}

async function main() {
  const targetDate = process.argv[2] || getDateString();

  console.log(`\n========================================`);
  console.log(`Daily Summary Generator`);
  console.log(`Date: ${targetDate}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`========================================\n`);

  // Load trades
  const trades = loadTrades(targetDate);
  const closedCount = trades.filter(t => t.eventType === 'close').length;

  if (closedCount === 0) {
    console.log(`No closed trades found for ${targetDate}`);
    return;
  }

  console.log(`Found ${closedCount} closed trades`);

  // Calculate stats
  const stats = calculateBotStats(trades);

  // Print summary to console
  console.log(`\nBot Performance Summary:`);
  console.log(`${'Bot'.padEnd(25)} ${'Trades'.padStart(7)} ${'Win%'.padStart(6)} ${'P&L'.padStart(12)}`);
  console.log(`${'-'.repeat(52)}`);

  for (const bot of stats) {
    const name = getBotDisplayName(bot.botId).padEnd(25);
    const trades = bot.trades.toString().padStart(7);
    const winRate = `${bot.winRate.toFixed(0)}%`.padStart(6);
    const pnl = formatCurrency(bot.totalPnL).padStart(12);
    console.log(`${name} ${trades} ${winRate} ${pnl}`);
  }

  const totalPnL = stats.reduce((sum, s) => sum + s.totalPnL, 0);
  console.log(`${'-'.repeat(52)}`);
  console.log(`${'TOTAL'.padEnd(25)} ${''.padStart(7)} ${''.padStart(6)} ${formatCurrency(totalPnL).padStart(12)}`);

  // Generate and append markdown
  const markdown = generateMarkdownSummary(targetDate, stats, trades);
  appendToLog(markdown);

  console.log(`\nDone!`);
}

main().catch(console.error);
