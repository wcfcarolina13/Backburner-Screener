#!/usr/bin/env node
/**
 * Analyze trade excursions to find optimal SL/TP targets
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = './data';
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const CANDLES_DIR = path.join(DATA_DIR, 'candles');

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function loadCandles(symbol: string, timeframe: string): Candle[] | null {
  const symbolDir = path.join(CANDLES_DIR, symbol);
  const spotPath = path.join(symbolDir, `${timeframe}-spot.json`);

  if (fs.existsSync(spotPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(spotPath, 'utf-8'));
      return data.candles || data;
    } catch { return null; }
  }
  return null;
}

function loadSignals(days: number) {
  const allSignals: any[] = [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  if (fs.existsSync(SIGNALS_DIR)) {
    const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, file), 'utf-8'));
        for (const sig of data) {
          const isTriggered = (sig.state === 'triggered' || sig.state === 'deep_extreme') &&
                              sig.eventType === 'triggered' && sig.entryPrice;
          if (isTriggered && new Date(sig.timestamp) >= cutoffDate) {
            allSignals.push(sig);
          }
        }
      } catch { }
    }
  }
  return allSignals;
}

// Simulate a single trade and track max favorable/adverse excursion
function analyzeTradeExcursion(signal: any, candles: Candle[]) {
  const entryTime = new Date(signal.timestamp).getTime();
  const entryPrice = signal.entryPrice;
  const direction = signal.direction;

  // Find candles after entry for 4 hours
  const relevantCandles = candles.filter(c =>
    c.timestamp >= entryTime && c.timestamp <= entryTime + 4 * 60 * 60 * 1000
  );

  if (relevantCandles.length === 0) return null;

  let maxFavorable = 0;
  let maxAdverse = 0;

  for (const candle of relevantCandles) {
    if (direction === 'long') {
      const favorable = ((candle.high - entryPrice) / entryPrice) * 100;
      const adverse = ((entryPrice - candle.low) / entryPrice) * 100;
      maxFavorable = Math.max(maxFavorable, favorable);
      maxAdverse = Math.max(maxAdverse, adverse);
    } else {
      const favorable = ((entryPrice - candle.low) / entryPrice) * 100;
      const adverse = ((candle.high - entryPrice) / entryPrice) * 100;
      maxFavorable = Math.max(maxFavorable, favorable);
      maxAdverse = Math.max(maxAdverse, adverse);
    }
  }

  return { maxFavorable, maxAdverse, symbol: signal.symbol, direction };
}

// Main
const signals = loadSignals(7);
console.log(`Analyzing ${signals.length} signals...\n`);

const excursions: any[] = [];

for (const sig of signals) {
  const candles = loadCandles(sig.symbol, sig.timeframe);
  if (!candles) continue;

  const result = analyzeTradeExcursion(sig, candles);
  if (result) excursions.push(result);
}

if (excursions.length === 0) {
  console.log('No trades with candle data found');
  process.exit(0);
}

// Group by favorable excursion ranges
const ranges: Record<string, number> = {
  'hit 1%+': 0,
  'hit 2%+': 0,
  'hit 3%+': 0,
  'hit 5%+': 0,
  'hit 10%+': 0,
  'hit 15%+': 0,
};

for (const e of excursions) {
  if (e.maxFavorable >= 1) ranges['hit 1%+']++;
  if (e.maxFavorable >= 2) ranges['hit 2%+']++;
  if (e.maxFavorable >= 3) ranges['hit 3%+']++;
  if (e.maxFavorable >= 5) ranges['hit 5%+']++;
  if (e.maxFavorable >= 10) ranges['hit 10%+']++;
  if (e.maxFavorable >= 15) ranges['hit 15%+']++;
}

console.log('=== MAX FAVORABLE EXCURSION (within 4h) ===');
console.log(`Total trades analyzed: ${excursions.length}`);
for (const [range, count] of Object.entries(ranges)) {
  const pct = ((count / excursions.length) * 100).toFixed(1);
  console.log(`${range}: ${count} trades (${pct}%)`);
}

// Show average
const avgFavorable = excursions.reduce((s, e) => s + e.maxFavorable, 0) / excursions.length;
const avgAdverse = excursions.reduce((s, e) => s + e.maxAdverse, 0) / excursions.length;
console.log(`\nAverage max favorable: ${avgFavorable.toFixed(2)}%`);
console.log(`Average max adverse: ${avgAdverse.toFixed(2)}%`);

// What TP would capture most wins?
console.log(`\n=== RECOMMENDED TARGETS (at 10x leverage) ===`);
console.log(`  2% price = 20% ROE: ${ranges['hit 2%+']} trades would hit TP (${((ranges['hit 2%+'] / excursions.length) * 100).toFixed(0)}%)`);
console.log(`  3% price = 30% ROE: ${ranges['hit 3%+']} trades would hit TP (${((ranges['hit 3%+'] / excursions.length) * 100).toFixed(0)}%)`);
console.log(`  5% price = 50% ROE: ${ranges['hit 5%+']} trades would hit TP (${((ranges['hit 5%+'] / excursions.length) * 100).toFixed(0)}%)`);
