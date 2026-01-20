#!/usr/bin/env node
/**
 * MACRO-AWARE Contrarian Strategy
 *
 * Key insight: We need TWO levels of regime detection:
 * 1. MACRO regime (4H/Daily) - are we in a bull or bear market overall?
 * 2. MICRO regime (recent signal ratio) - is the short-term sentiment bearish?
 *
 * Hypothesis:
 * - In MACRO BEAR + MICRO BEARISH: contrarian longs work (oversold bounces)
 * - In MACRO BULL + MICRO BULLISH: traditional longs work (trend following)
 * - In MACRO BULL + MICRO BEARISH: might be pullback = good entry
 * - In MACRO BEAR + MICRO BULLISH: bull trap = avoid
 *
 * This tests per-bot performance with the contrarian strategy.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============= Types =============

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

interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  entryPrice?: number;
  exitPrice?: number;
  leverage: number;
  realizedPnL?: number;
  signalRsi?: number;
}

interface TradePair {
  open: TradeEvent;
  close: TradeEvent | null;
}

interface MicroRegime {
  regime: 'bullish' | 'bearish' | 'neutral';
  shortRatio: number;
  longRatio: number;
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
      } catch { /* skip */ }
    }
    current.setDate(current.getDate() + 1);
  }

  return trades;
}

function matchOpenClose(trades: TradeEvent[]): TradePair[] {
  const pairs: TradePair[] = [];
  const openTrades = new Map<string, TradeEvent>();

  for (const trade of trades) {
    const key = `${trade.botId}-${trade.positionId}`;
    if (trade.eventType === 'open') {
      openTrades.set(key, trade);
    } else if (trade.eventType === 'close') {
      const open = openTrades.get(key);
      if (open) {
        pairs.push({ open, close: trade });
        openTrades.delete(key);
      }
    }
  }

  return pairs;
}

// ============= Regime Detection =============

function buildMicroRegimeMap(signals: LocalSignal[], windowHours: number = 4): Map<number, MicroRegime> {
  const regimeMap = new Map<number, MicroRegime>();
  const windowMs = windowHours * 60 * 60 * 1000;

  for (const signal of signals) {
    const ts = new Date(signal.timestamp).getTime();
    const windowStart = ts - windowMs;

    const windowSignals = signals.filter(s => {
      const sTs = new Date(s.timestamp).getTime();
      return sTs >= windowStart && sTs < ts;
    });

    const longs = windowSignals.filter(s => s.direction === 'long').length;
    const shorts = windowSignals.filter(s => s.direction === 'short').length;
    const total = longs + shorts;

    let regime: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    const longRatio = total > 0 ? longs / total : 0.5;
    const shortRatio = total > 0 ? shorts / total : 0.5;

    if (total >= 3) {
      if (shortRatio > 0.65) regime = 'bearish';
      else if (longRatio > 0.65) regime = 'bullish';
    }

    regimeMap.set(ts, { regime, shortRatio, longRatio });
  }

  return regimeMap;
}

// Macro regime: look at longer-term signal ratio (24h)
function getMacroRegime(signals: LocalSignal[], endTime: number, windowHours: number = 24): 'bull' | 'bear' | 'neutral' {
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = endTime - windowMs;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= windowStart && ts <= endTime;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < 10) return 'neutral';  // Not enough data

  const longRatio = longs / total;
  if (longRatio > 0.55) return 'bull';
  if (longRatio < 0.45) return 'bear';
  return 'neutral';
}

// ============= Bot Analysis =============

interface BotResult {
  botId: string;

  // All long trades (baseline)
  allLongTrades: number;
  allLongWins: number;
  allLongPnL: number;

  // Contrarian: only longs when micro-bearish
  contrarianTrades: number;
  contrarianWins: number;
  contrarianPnL: number;

  // High conviction: only when short ratio > 70%
  highConvTrades: number;
  highConvWins: number;
  highConvPnL: number;
}

function analyzeBot(
  pairs: TradePair[],
  botId: string,
  signals: LocalSignal[],
  microRegimeMap: Map<number, MicroRegime>
): BotResult {
  const botPairs = pairs.filter(p => p.open.botId === botId && p.close !== null);
  const longPairs = botPairs.filter(p => p.open.direction === 'long');

  // All longs (baseline)
  const allLongWins = longPairs.filter(p => (p.close?.realizedPnL || 0) > 0);
  let allLongPnL = 0;
  for (const pair of longPairs) {
    const actualPnL = pair.close?.realizedPnL || 0;
    const leverage = pair.open.leverage || 10;
    allLongPnL += actualPnL / leverage;  // Adjust to 1x
  }

  // Contrarian: only when micro regime was bearish at entry time
  const contrarianPairs = longPairs.filter(p => {
    const entryTime = new Date(p.open.timestamp).getTime();
    // Find closest regime
    let closestRegime: MicroRegime | null = null;
    let closestDiff = Infinity;
    for (const [ts, regime] of microRegimeMap) {
      const diff = Math.abs(ts - entryTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestRegime = regime;
      }
    }
    return closestRegime?.regime === 'bearish';
  });

  const contrarianWins = contrarianPairs.filter(p => (p.close?.realizedPnL || 0) > 0);
  let contrarianPnL = 0;
  for (const pair of contrarianPairs) {
    const actualPnL = pair.close?.realizedPnL || 0;
    const leverage = pair.open.leverage || 10;
    contrarianPnL += actualPnL / leverage;
  }

  // High conviction: only when short ratio > 70%
  const highConvPairs = longPairs.filter(p => {
    const entryTime = new Date(p.open.timestamp).getTime();
    let closestRegime: MicroRegime | null = null;
    let closestDiff = Infinity;
    for (const [ts, regime] of microRegimeMap) {
      const diff = Math.abs(ts - entryTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestRegime = regime;
      }
    }
    return (closestRegime?.shortRatio || 0) > 0.70;
  });

  const highConvWins = highConvPairs.filter(p => (p.close?.realizedPnL || 0) > 0);
  let highConvPnL = 0;
  for (const pair of highConvPairs) {
    const actualPnL = pair.close?.realizedPnL || 0;
    const leverage = pair.open.leverage || 10;
    highConvPnL += actualPnL / leverage;
  }

  return {
    botId,
    allLongTrades: longPairs.length,
    allLongWins: allLongWins.length,
    allLongPnL,
    contrarianTrades: contrarianPairs.length,
    contrarianWins: contrarianWins.length,
    contrarianPnL,
    highConvTrades: highConvPairs.length,
    highConvWins: highConvWins.length,
    highConvPnL,
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
  console.log(`MACRO-AWARE CONTRARIAN ANALYSIS (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log('');
  console.log('Comparing per-bot performance:');
  console.log('  1. All Longs (baseline)');
  console.log('  2. Contrarian (only longs when micro-regime is bearish)');
  console.log('  3. High Conviction (only when short ratio > 70%)');
  console.log('');
  console.log('All P&L adjusted to 1x leverage for spot comparison.');
  console.log('');

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`Date range: ${startStr} to ${endStr}`);

  // Load data
  console.log('\nLoading signals...');
  const signals = loadSignalsFromFiles(startStr, endStr);
  console.log(`  Found ${signals.length} triggered signals`);

  console.log('Loading trades...');
  const trades = loadTradesFromFiles(startStr, endStr);
  const pairs = matchOpenClose(trades);
  console.log(`  Found ${pairs.length} completed trade pairs`);

  // Determine macro regime
  const macroRegime = getMacroRegime(signals, endDate.getTime(), 24 * days);
  console.log(`\n📊 MACRO REGIME (${days}-day): ${macroRegime.toUpperCase()}`);

  // Build micro regime map
  const microRegimeMap = buildMicroRegimeMap(signals, 4);

  // Count micro regime distribution
  let microBullish = 0, microBearish = 0, microNeutral = 0;
  for (const r of microRegimeMap.values()) {
    if (r.regime === 'bullish') microBullish++;
    else if (r.regime === 'bearish') microBearish++;
    else microNeutral++;
  }
  const totalMicro = microBullish + microBearish + microNeutral;
  console.log(`\n📊 MICRO REGIME distribution:`);
  console.log(`   Bullish: ${microBullish} (${(microBullish/totalMicro*100).toFixed(1)}%)`);
  console.log(`   Bearish: ${microBearish} (${(microBearish/totalMicro*100).toFixed(1)}%)`);
  console.log(`   Neutral: ${microNeutral} (${(microNeutral/totalMicro*100).toFixed(1)}%)`);

  // Get unique bot IDs
  const botIds = [...new Set(trades.map(t => t.botId))].sort();

  // Analyze each bot
  const results: BotResult[] = [];
  for (const botId of botIds) {
    results.push(analyzeBot(pairs, botId, signals, microRegimeMap));
  }

  // Filter to bots with at least 3 long trades
  const validResults = results.filter(r => r.allLongTrades >= 3);

  // ============= BASELINE: All Longs =============
  console.log('\n' + '='.repeat(80));
  console.log('BASELINE: ALL LONG TRADES (Spot 1x)');
  console.log('='.repeat(80));
  console.log('');

  const header1 = 'Bot'.padEnd(20) + 'Trades'.padStart(8) + 'Wins'.padStart(6) + 'Win%'.padStart(8) + 'P&L'.padStart(12);
  console.log(header1);
  console.log('-'.repeat(60));

  const sortedBaseline = [...validResults].sort((a, b) => b.allLongPnL - a.allLongPnL);
  for (const r of sortedBaseline) {
    const winRate = r.allLongTrades > 0 ? (r.allLongWins / r.allLongTrades * 100).toFixed(1) : '0';
    const profit = r.allLongPnL >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${r.botId.padEnd(18)}` +
      r.allLongTrades.toString().padStart(8) +
      r.allLongWins.toString().padStart(6) +
      `${winRate}%`.padStart(8) +
      `$${r.allLongPnL.toFixed(2)}`.padStart(12)
    );
  }

  // ============= CONTRARIAN: Bearish Micro Only =============
  console.log('\n' + '='.repeat(80));
  console.log('CONTRARIAN: LONG ONLY WHEN MICRO-BEARISH');
  console.log('='.repeat(80));
  console.log('');

  console.log(header1);
  console.log('-'.repeat(60));

  const sortedContrarian = [...validResults]
    .filter(r => r.contrarianTrades > 0)
    .sort((a, b) => b.contrarianPnL - a.contrarianPnL);

  for (const r of sortedContrarian) {
    const winRate = r.contrarianTrades > 0 ? (r.contrarianWins / r.contrarianTrades * 100).toFixed(1) : '0';
    const profit = r.contrarianPnL >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${r.botId.padEnd(18)}` +
      r.contrarianTrades.toString().padStart(8) +
      r.contrarianWins.toString().padStart(6) +
      `${winRate}%`.padStart(8) +
      `$${r.contrarianPnL.toFixed(2)}`.padStart(12)
    );
  }

  // ============= HIGH CONVICTION: Short Ratio > 70% =============
  console.log('\n' + '='.repeat(80));
  console.log('HIGH CONVICTION: LONG ONLY WHEN SHORT RATIO > 70%');
  console.log('='.repeat(80));
  console.log('');

  console.log(header1);
  console.log('-'.repeat(60));

  const sortedHighConv = [...validResults]
    .filter(r => r.highConvTrades > 0)
    .sort((a, b) => b.highConvPnL - a.highConvPnL);

  for (const r of sortedHighConv) {
    const winRate = r.highConvTrades > 0 ? (r.highConvWins / r.highConvTrades * 100).toFixed(1) : '0';
    const profit = r.highConvPnL >= 0 ? '✅' : '❌';
    console.log(
      `${profit} ${r.botId.padEnd(18)}` +
      r.highConvTrades.toString().padStart(8) +
      r.highConvWins.toString().padStart(6) +
      `${winRate}%`.padStart(8) +
      `$${r.highConvPnL.toFixed(2)}`.padStart(12)
    );
  }

  // ============= Summary =============
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY: PROFITABLE BOTS BY STRATEGY');
  console.log('='.repeat(80));

  const profitableBaseline = validResults.filter(r => r.allLongPnL > 0);
  const profitableContrarian = validResults.filter(r => r.contrarianPnL > 0 && r.contrarianTrades > 0);
  const profitableHighConv = validResults.filter(r => r.highConvPnL > 0 && r.highConvTrades > 0);

  console.log(`\n  Baseline (all longs):     ${profitableBaseline.length} profitable bots`);
  console.log(`  Contrarian (micro-bear):  ${profitableContrarian.length} profitable bots`);
  console.log(`  High Conviction (>70%):   ${profitableHighConv.length} profitable bots`);

  // Best bots for each strategy
  if (profitableContrarian.length > 0) {
    console.log('\n✅ TOP CONTRARIAN BOTS:');
    for (const r of profitableContrarian.slice(0, 5)) {
      const winRate = (r.contrarianWins / r.contrarianTrades * 100).toFixed(1);
      console.log(`   ${r.botId}: $${r.contrarianPnL.toFixed(2)} (${r.contrarianTrades} trades, ${winRate}% win)`);
    }
  }

  if (profitableHighConv.length > 0) {
    console.log('\n✅ TOP HIGH-CONVICTION BOTS:');
    for (const r of profitableHighConv.slice(0, 5)) {
      const winRate = (r.highConvWins / r.highConvTrades * 100).toFixed(1);
      console.log(`   ${r.botId}: $${r.highConvPnL.toFixed(2)} (${r.highConvTrades} trades, ${winRate}% win)`);
    }
  }

  // ============= Recommendation =============
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  console.log(`\n📊 Current market: MACRO ${macroRegime.toUpperCase()}`);

  if (macroRegime === 'bear') {
    console.log('\n💡 In a MACRO BEAR market:');
    console.log('   - Traditional long strategies WILL lose money');
    console.log('   - CONTRARIAN approach is recommended');
    console.log('   - Only take longs when micro-regime is very bearish (>70% shorts)');
    console.log('   - These are high-conviction oversold bounces');
    console.log('   - Expect FEWER trades but HIGHER win rate');
  } else if (macroRegime === 'bull') {
    console.log('\n💡 In a MACRO BULL market:');
    console.log('   - Traditional long strategies should work');
    console.log('   - But contrarian can still add value during pullbacks');
    console.log('   - Consider BOTH approaches');
  } else {
    console.log('\n💡 In a NEUTRAL market:');
    console.log('   - Be selective with entries');
    console.log('   - Contrarian still offers edge for oversold bounces');
  }

  // Final recommendation
  const bestContrarian = profitableContrarian[0];
  const bestHighConv = profitableHighConv[0];

  if (bestHighConv) {
    console.log(`\n🎯 BEST BOT FOR SPOT: ${bestHighConv.botId}`);
    console.log(`   Strategy: High-conviction contrarian (>70% shorts)`);
    console.log(`   Expected: ${bestHighConv.highConvTrades} trades over ${days} days`);
    console.log(`   Win rate: ${(bestHighConv.highConvWins/bestHighConv.highConvTrades*100).toFixed(1)}%`);
    console.log(`   P&L: $${bestHighConv.highConvPnL.toFixed(2)}`);
  } else if (bestContrarian) {
    console.log(`\n🎯 BEST BOT FOR SPOT: ${bestContrarian.botId}`);
    console.log(`   Strategy: Contrarian (micro-bearish)`);
    console.log(`   Expected: ${bestContrarian.contrarianTrades} trades over ${days} days`);
    console.log(`   Win rate: ${(bestContrarian.contrarianWins/bestContrarian.contrarianTrades*100).toFixed(1)}%`);
    console.log(`   P&L: $${bestContrarian.contrarianPnL.toFixed(2)}`);
  } else {
    console.log('\n⚠️ No profitable strategy found for this period.');
    console.log('   Consider sitting out spot trading until conditions improve.');
  }
}

main().catch(console.error);
