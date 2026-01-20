#!/usr/bin/env node
/**
 * REALISTIC Spot Regime Backtest
 *
 * Tests the SpotRegimeBot with:
 * - Actual execution costs (slippage, fees, bad fills)
 * - Real signal data from past N days
 * - Per-quadrant analysis
 *
 * This gives us a TRUE picture of expected P&L after all costs.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SpotRegimeBot,
  SpotRegimeBotConfig,
  Signal,
  createStandardSpotBot,
  createConservativeSpotBot,
  createAggressiveSpotBot,
  createPureContrarianSpotBot,
  DEFAULT_CONFIG,
} from './spot-regime-bot.js';

// ============= Load Data =============

interface LocalSignal {
  timestamp: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  price: number;
  entryPrice?: number;
  state: string;
  eventType: string;
}

function loadSignals(startDate: string, endDate: string): LocalSignal[] {
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
              sig.eventType === 'triggered' && sig.entryPrice) {
            signals.push(sig);
          }
        }
      } catch { /* skip */ }
    }
    current.setDate(current.getDate() + 1);
  }

  return signals.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

interface CandleFile {
  candles: Array<{ timestamp: number; close: number; high: number; low: number }>;
}

function loadCandles(symbol: string, timeframe: string): Array<{ timestamp: number; close: number; high: number; low: number }> | null {
  const paths = [
    path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-spot.json`),
    path.join(process.cwd(), 'data', 'candles', symbol, `${timeframe}-futures.json`),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const data: CandleFile = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return data.candles;
      } catch { /* continue */ }
    }
  }
  return null;
}

// ============= Backtest Runner =============

interface BacktestResult {
  botId: string;
  tradesAttempted: number;
  tradesExecuted: number;
  tradesSkipped: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  totalFees: number;
  totalSlippage: number;
  netPnL: number;
  avgTradeNetPnL: number;
  byQuadrant: Record<string, { trades: number; pnl: number; wins: number }>;
  skipReasons: Record<string, number>;
}

function runBacktest(bot: SpotRegimeBot, signals: LocalSignal[], days: number): BacktestResult {
  const skipReasons: Record<string, number> = {};
  let tradesAttempted = 0;

  // First pass: feed ALL signals to build regime history
  for (const sig of signals) {
    const signal: Signal = {
      timestamp: new Date(sig.timestamp).getTime(),
      symbol: sig.symbol,
      direction: sig.direction,
      timeframe: sig.timeframe,
      rsi: sig.rsi,
      price: sig.price,
      entryPrice: sig.entryPrice || sig.price,
    };

    // Process signal (this also adds to regime history)
    const result = bot.processSignal(signal);

    if (sig.direction === 'long') {
      tradesAttempted++;

      if (result.action === 'skip') {
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
        continue;
      }

      // Simulate price movement for opened position
      const candles = loadCandles(sig.symbol, sig.timeframe);
      if (!candles) continue;

      const entryTime = signal.timestamp;

      for (const candle of candles) {
        if (candle.timestamp <= entryTime) continue;

        // Update with high, low, close to simulate intracandle movement
        bot.updatePrice(sig.symbol, sig.timeframe, candle.high, candle.timestamp);
        if (bot.getPositions().length === 0 ||
            !bot.getPositions().find(p => p.symbol === sig.symbol)) break;

        bot.updatePrice(sig.symbol, sig.timeframe, candle.low, candle.timestamp);
        if (bot.getPositions().length === 0 ||
            !bot.getPositions().find(p => p.symbol === sig.symbol)) break;

        bot.updatePrice(sig.symbol, sig.timeframe, candle.close, candle.timestamp);
        if (bot.getPositions().length === 0 ||
            !bot.getPositions().find(p => p.symbol === sig.symbol)) break;
      }
    }
  }

  // Get final stats
  const stats = bot.getStats();
  const trades = bot.getTrades();

  const grossPnL = trades.reduce((sum, t) => sum + t.grossPnL, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
  const totalSlippage = trades.reduce((sum, t) => sum + t.slippage, 0);
  const netPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);

  return {
    botId: bot.getConfig().botId,
    tradesAttempted,
    tradesExecuted: trades.length,
    tradesSkipped: tradesAttempted - trades.length,
    wins: trades.filter(t => t.netPnL > 0).length,
    losses: trades.filter(t => t.netPnL <= 0).length,
    winRate: trades.length > 0 ? (trades.filter(t => t.netPnL > 0).length / trades.length) * 100 : 0,
    grossPnL,
    totalFees,
    totalSlippage,
    netPnL,
    avgTradeNetPnL: trades.length > 0 ? netPnL / trades.length : 0,
    byQuadrant: stats.byQuadrant,
    skipReasons,
  };
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
  console.log(`REALISTIC SPOT REGIME BACKTEST (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Testing with REAL execution costs:');
  console.log(`   Maker/Taker Fee: ${DEFAULT_CONFIG.makerFeePercent}% / ${DEFAULT_CONFIG.takerFeePercent}%`);
  console.log(`   Expected Slippage: ${DEFAULT_CONFIG.slippagePercent}%`);
  console.log(`   Bad Fill Probability: ${DEFAULT_CONFIG.badFillProbability * 100}%`);
  console.log(`   Bad Fill Extra Slippage: ${DEFAULT_CONFIG.badFillExtraSlippage}%`);
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);

  // Load signals
  console.log('\nLoading signals...');
  const signals = loadSignals(startStr, endStr);
  console.log(`Found ${signals.length} triggered signals`);

  const longSignals = signals.filter(s => s.direction === 'long');
  const shortSignals = signals.filter(s => s.direction === 'short');
  console.log(`  Long: ${longSignals.length}, Short: ${shortSignals.length}`);

  // Create bots
  const bots = [
    createStandardSpotBot(),
    createConservativeSpotBot(),
    createAggressiveSpotBot(),
    createPureContrarianSpotBot(),
  ];

  const results: BacktestResult[] = [];

  for (const bot of bots) {
    console.log(`\nRunning ${bot.getConfig().botId}...`);
    const result = runBacktest(bot, signals, days);
    results.push(result);
  }

  // Print results
  console.log('\n' + '='.repeat(80));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(80));
  console.log('');

  const header = 'Bot'.padEnd(20) +
    'Trades'.padStart(8) +
    'Win%'.padStart(8) +
    'Gross'.padStart(10) +
    'Fees'.padStart(8) +
    'Slip'.padStart(8) +
    'NET P&L'.padStart(12);

  console.log(header);
  console.log('-'.repeat(80));

  for (const r of results) {
    const profit = r.netPnL >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${r.botId.padEnd(18)}` +
      r.tradesExecuted.toString().padStart(8) +
      `${r.winRate.toFixed(1)}%`.padStart(8) +
      `$${r.grossPnL.toFixed(2)}`.padStart(10) +
      `$${r.totalFees.toFixed(2)}`.padStart(8) +
      `$${r.totalSlippage.toFixed(2)}`.padStart(8) +
      `$${r.netPnL.toFixed(2)}`.padStart(12)
    );
  }

  // Best result
  const bestResult = results.reduce((a, b) => a.netPnL > b.netPnL ? a : b);

  console.log('\n' + '='.repeat(80));
  console.log('DETAILED ANALYSIS: ' + bestResult.botId.toUpperCase());
  console.log('='.repeat(80));

  console.log('\n📊 Trade Summary:');
  console.log(`   Trades Attempted: ${bestResult.tradesAttempted}`);
  console.log(`   Trades Executed: ${bestResult.tradesExecuted}`);
  console.log(`   Trades Skipped: ${bestResult.tradesSkipped}`);
  console.log(`   Win Rate: ${bestResult.winRate.toFixed(1)}%`);

  console.log('\n💰 P&L Breakdown:');
  console.log(`   Gross P&L:   $${bestResult.grossPnL.toFixed(2)}`);
  console.log(`   Total Fees:  $${bestResult.totalFees.toFixed(2)}`);
  console.log(`   Total Slip:  $${bestResult.totalSlippage.toFixed(2)}`);
  console.log(`   NET P&L:     $${bestResult.netPnL.toFixed(2)}`);
  console.log(`   Avg Trade:   $${bestResult.avgTradeNetPnL.toFixed(2)}`);

  if (Object.keys(bestResult.byQuadrant).length > 0) {
    console.log('\n📈 Performance by Quadrant:');
    console.log('-'.repeat(50));
    for (const [quadrant, data] of Object.entries(bestResult.byQuadrant).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const winRate = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0';
      const profit = data.pnl >= 0 ? '✅' : '❌';
      console.log(`   ${profit} ${quadrant.padEnd(12)} ${data.trades.toString().padStart(3)} trades, ${winRate}% win, $${data.pnl.toFixed(2)}`);
    }
  }

  if (Object.keys(bestResult.skipReasons).length > 0) {
    console.log('\n🚫 Skip Reasons:');
    for (const [reason, count] of Object.entries(bestResult.skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${count.toString().padStart(4)}x ${reason}`);
    }
  }

  // Final recommendation
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  if (bestResult.netPnL > 0) {
    console.log(`\n✅ ${bestResult.botId} is PROFITABLE after all costs!`);
    console.log(`   Expected: ${bestResult.tradesExecuted} trades over ${days} days`);
    console.log(`   Expected: ~${(bestResult.tradesExecuted / days).toFixed(1)} trades per day`);
    console.log(`   NET P&L:  $${bestResult.netPnL.toFixed(2)} (${(bestResult.netPnL / days).toFixed(2)}/day)`);
    console.log(`   Monthly projection: $${(bestResult.netPnL / days * 30).toFixed(2)}`);
  } else {
    console.log('\n⚠️ No bot was profitable after execution costs.');
    console.log('   The strategy may need adjustment or market conditions are unfavorable.');

    // Show impact of costs
    const costImpact = bestResult.totalFees + bestResult.totalSlippage;
    console.log(`\n📉 Cost Impact:`);
    console.log(`   Gross P&L: $${bestResult.grossPnL.toFixed(2)}`);
    console.log(`   Costs:     $${costImpact.toFixed(2)}`);
    console.log(`   Net P&L:   $${bestResult.netPnL.toFixed(2)}`);

    if (bestResult.grossPnL > 0) {
      console.log('\n   Gross P&L was positive! Consider:');
      console.log('   - Using limit orders (maker fees) instead of market orders');
      console.log('   - Trading less frequently to reduce fee impact');
      console.log('   - Only trading highest-conviction setups');
    }
  }

  // Cost sensitivity analysis
  console.log('\n' + '='.repeat(80));
  console.log('COST SENSITIVITY ANALYSIS');
  console.log('='.repeat(80));

  const scenarios = [
    { name: 'Current (realistic)', feeMultiplier: 1, slipMultiplier: 1 },
    { name: 'Limit orders only', feeMultiplier: 0.5, slipMultiplier: 0.5 },
    { name: 'Zero slippage', feeMultiplier: 1, slipMultiplier: 0 },
    { name: 'Best case', feeMultiplier: 0.5, slipMultiplier: 0 },
  ];

  console.log('\nScenario'.padEnd(20) + 'Fees'.padStart(10) + 'Slip'.padStart(10) + 'Net P&L'.padStart(12));
  console.log('-'.repeat(55));

  for (const scenario of scenarios) {
    const adjustedFees = bestResult.totalFees * scenario.feeMultiplier;
    const adjustedSlip = bestResult.totalSlippage * scenario.slipMultiplier;
    const adjustedNet = bestResult.grossPnL - adjustedFees - adjustedSlip;
    const profit = adjustedNet >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${scenario.name.padEnd(18)}` +
      `$${adjustedFees.toFixed(2)}`.padStart(10) +
      `$${adjustedSlip.toFixed(2)}`.padStart(10) +
      `$${adjustedNet.toFixed(2)}`.padStart(12)
    );
  }
}

main().catch(console.error);
