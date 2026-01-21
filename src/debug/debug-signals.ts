#!/usr/bin/env node
/**
 * Debug script to see what signals we have and why they're not aligning
 */

import fs from 'fs';
import path from 'path';

function loadSignals(timeframe: string): any[] {
  const signalsDir = path.join(process.cwd(), 'data', 'generated-signals', timeframe);
  if (!fs.existsSync(signalsDir)) {
    return [];
  }

  const signals: any[] = [];
  const files = fs.readdirSync(signalsDir).filter(f => f.endsWith('.json')).sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(signalsDir, file), 'utf-8'));
      signals.push(...data);
    } catch (e) {
      // Skip
    }
  }

  return signals;
}

const htfSignals = loadSignals('4h');
const ltfSignals = loadSignals('5m');

console.log('\n=== 4H SIGNALS ===');
console.log(`Total: ${htfSignals.length}`);

// Get unique symbols
const htfSymbols = new Set(htfSignals.map(s => s.symbol));
console.log(`Symbols: ${htfSymbols.size}`);
console.log('By direction:');
const htfLongs = htfSignals.filter(s => s.direction === 'long');
const htfShorts = htfSignals.filter(s => s.direction === 'short');
console.log(`  LONG: ${htfLongs.length} (symbols: ${new Set(htfLongs.map(s => s.symbol)).size})`);
console.log(`  SHORT: ${htfShorts.length} (symbols: ${new Set(htfShorts.map(s => s.symbol)).size})`);

console.log('\nSample 4H signals:');
htfSignals.slice(0, 5).forEach(s => {
  console.log(`  ${s.symbol} ${s.direction} @ ${s.timestamp}`);
});

console.log('\n=== 5M SIGNALS ===');
console.log(`Total: ${ltfSignals.length}`);

const ltfSymbols = new Set(ltfSignals.map(s => s.symbol));
console.log(`Symbols: ${ltfSymbols.size}`);
console.log('By direction:');
const ltfLongs = ltfSignals.filter(s => s.direction === 'long');
const ltfShorts = ltfSignals.filter(s => s.direction === 'short');
console.log(`  LONG: ${ltfLongs.length} (symbols: ${new Set(ltfLongs.map(s => s.symbol)).size})`);
console.log(`  SHORT: ${ltfShorts.length} (symbols: ${new Set(ltfShorts.map(s => s.symbol)).size})`);

console.log('\nSample 5m signals:');
ltfSignals.slice(0, 5).forEach(s => {
  console.log(`  ${s.symbol} ${s.direction} @ ${s.timestamp}`);
});

// Find overlapping symbols
const commonSymbols = [...htfSymbols].filter(s => ltfSymbols.has(s));
console.log('\n=== OVERLAP ===');
console.log(`Common symbols: ${commonSymbols.length}`);
if (commonSymbols.length > 0) {
  console.log(commonSymbols.join(', '));
}

// For each common symbol, check alignment potential
console.log('\n=== ALIGNMENT CHECK ===');
for (const symbol of commonSymbols) {
  const htf = htfSignals.filter(s => s.symbol === symbol);
  const ltf = ltfSignals.filter(s => s.symbol === symbol);

  console.log(`\n${symbol}:`);
  console.log(`  4H: ${htf.map(s => `${s.direction} @ ${s.timestamp}`).join(', ')}`);
  console.log(`  5m: ${ltf.map(s => `${s.direction} @ ${s.timestamp}`).join(', ')}`);

  // Check for alignment (4H direction should match FADED 5m direction)
  for (const h of htf) {
    const htfTime = new Date(h.timestamp).getTime();
    const htfValidUntil = htfTime + 24 * 60 * 60 * 1000; // 24h validity for debug

    for (const l of ltf) {
      const ltfTime = new Date(l.timestamp).getTime();

      // 5m must come after 4H
      if (ltfTime <= htfTime) continue;

      // Check if within validity window
      if (ltfTime > htfValidUntil) continue;

      // Check alignment: 4H direction should match FADED 5m
      const fadedLtf = l.direction === 'long' ? 'short' : 'long';

      console.log(`    4H ${h.direction} @ ${h.timestamp}`);
      console.log(`    5m ${l.direction} (faded: ${fadedLtf}) @ ${l.timestamp}`);
      console.log(`    Time diff: ${((ltfTime - htfTime) / (60 * 60 * 1000)).toFixed(1)}h`);
      console.log(`    Aligned: ${h.direction === fadedLtf ? '✅ YES' : '❌ NO'}`);
    }
  }
}
