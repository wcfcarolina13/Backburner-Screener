#!/usr/bin/env node
/**
 * Pre-fetch Candles - Download and cache historical candle data for backtesting
 *
 * Scans your trade history to find all symbols traded, then fetches
 * candle data for each symbol/timeframe combination.
 *
 * Usage:
 *   npm run prefetch                    # Fetch for all traded symbols (last 7 days)
 *   npm run prefetch -- --days 30       # Fetch 30 days of history
 *   npm run prefetch -- --symbols BTCUSDT,ETHUSDT  # Specific symbols only
 */

import fs from 'fs';
import path from 'path';
import { Timeframe } from './types.js';
import { getKlines, getFuturesKlines } from './mexc-api.js';
import { storeCandles, getStoredCandles } from './candle-store.js';

const TRADES_DIR = path.join(process.cwd(), 'data', 'trades');
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h'];

// ============= CLI Argument Parsing =============

function parseArgs(): {
  days: number;
  symbols?: string[];
  marketType?: 'spot' | 'futures' | 'both';
  force: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    days: 7,
    symbols: undefined as string[] | undefined,
    marketType: 'both' as 'spot' | 'futures' | 'both',
    force: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--days':
      case '-d':
        result.days = parseInt(nextArg, 10);
        i++;
        break;
      case '--symbols':
      case '-s':
        result.symbols = nextArg.split(',');
        i++;
        break;
      case '--market':
      case '-m':
        result.marketType = nextArg as 'spot' | 'futures' | 'both';
        i++;
        break;
      case '--force':
      case '-f':
        result.force = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Pre-fetch Candles for Backtesting

Usage: npm run prefetch -- [options]

Options:
  --days, -d <num>        Days of history to fetch (default: 7)
  --symbols, -s <list>    Comma-separated symbols (default: all traded)
  --market, -m <type>     Market type: spot, futures, or both (default: both)
  --force, -f             Re-fetch even if data exists
  --help, -h              Show this help

Examples:
  npm run prefetch                           # All traded symbols, 7 days
  npm run prefetch -- --days 30              # 30 days of history
  npm run prefetch -- --symbols BTCUSDT      # Single symbol
  npm run prefetch -- --market futures       # Futures only
`);
}

// ============= Symbol Discovery =============

interface TradedSymbol {
  symbol: string;
  marketType: 'spot' | 'futures';
  timeframes: Set<string>;
  tradeCount: number;
}

function discoverTradedSymbols(): Map<string, TradedSymbol> {
  const symbols = new Map<string, TradedSymbol>();

  if (!fs.existsSync(TRADES_DIR)) {
    console.log('No trades directory found');
    return symbols;
  }

  const files = fs.readdirSync(TRADES_DIR)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, file), 'utf-8'));

      for (const trade of data) {
        if (trade.eventType !== 'open') continue;

        const key = `${trade.symbol}-${trade.marketType || 'futures'}`;

        if (!symbols.has(key)) {
          symbols.set(key, {
            symbol: trade.symbol,
            marketType: trade.marketType || 'futures',
            timeframes: new Set(),
            tradeCount: 0
          });
        }

        const entry = symbols.get(key)!;
        entry.timeframes.add(trade.timeframe);
        entry.tradeCount++;
      }
    } catch (e) {
      console.error(`Error reading ${file}:`, e);
    }
  }

  return symbols;
}

// ============= Candle Fetching =============

async function fetchAndStoreCandles(
  symbol: string,
  timeframe: Timeframe,
  marketType: 'spot' | 'futures',
  days: number,
  force: boolean
): Promise<{ success: boolean; cached: boolean; count: number; actualMarket?: string }> {

  // Check if we already have recent data
  if (!force) {
    const now = Date.now();
    const startTime = now - (days * 24 * 60 * 60 * 1000);
    const existing = getStoredCandles(symbol, timeframe, marketType, startTime, now);

    // If we have at least 80% of expected candles, skip
    const expectedCandles = days * (timeframe === '5m' ? 288 : timeframe === '15m' ? 96 : 24);
    if (existing.length > expectedCandles * 0.8) {
      return { success: true, cached: true, count: existing.length };
    }
  }

  // Try futures first if requested, fall back to spot
  if (marketType === 'futures') {
    try {
      const candles = await getFuturesKlines(symbol, timeframe, 500);
      if (candles.length > 0) {
        storeCandles(symbol, timeframe, 'futures', candles);
        return { success: true, cached: false, count: candles.length, actualMarket: 'futures' };
      }
    } catch (error) {
      // Futures failed, try spot as fallback
    }

    // Fallback to spot
    try {
      const candles = await getKlines(symbol, timeframe, 500);
      if (candles.length > 0) {
        // Store as spot since that's what we got
        storeCandles(symbol, timeframe, 'spot', candles);
        return { success: true, cached: false, count: candles.length, actualMarket: 'spot (fallback)' };
      }
    } catch (error) {
      return { success: false, cached: false, count: 0 };
    }
  }

  // Spot market
  try {
    const candles = await getKlines(symbol, timeframe, 500);
    if (candles.length === 0) {
      return { success: false, cached: false, count: 0 };
    }
    storeCandles(symbol, timeframe, 'spot', candles);
    return { success: true, cached: false, count: candles.length, actualMarket: 'spot' };
  } catch (error) {
    return { success: false, cached: false, count: 0 };
  }
}

// ============= Progress Display =============

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;

  let size = 0;
  const items = fs.readdirSync(dirPath);

  for (const item of items) {
    const itemPath = path.join(dirPath, item);
    const stat = fs.statSync(itemPath);

    if (stat.isDirectory()) {
      size += getDirectorySize(itemPath);
    } else {
      size += stat.size;
    }
  }

  return size;
}

// ============= Main =============

async function main(): Promise<void> {
  console.log('\n📊 Candle Pre-fetcher for Backtesting\n');

  const args = parseArgs();

  // Discover symbols from trade history
  console.log('Scanning trade history...');
  const allSymbols = discoverTradedSymbols();

  if (allSymbols.size === 0) {
    console.log('No traded symbols found in trade history.');
    return;
  }

  // Filter symbols if specified
  let symbolsToFetch = Array.from(allSymbols.values());

  if (args.symbols) {
    symbolsToFetch = symbolsToFetch.filter(s =>
      args.symbols!.includes(s.symbol)
    );
  }

  if (args.marketType !== 'both') {
    symbolsToFetch = symbolsToFetch.filter(s => s.marketType === args.marketType);
  }

  // Sort by trade count (most traded first)
  symbolsToFetch.sort((a, b) => b.tradeCount - a.tradeCount);

  console.log(`Found ${allSymbols.size} unique symbol/market combinations`);
  console.log(`Will fetch ${symbolsToFetch.length} symbols, ${args.days} days of history\n`);

  // Calculate expected storage
  const candlesDir = path.join(process.cwd(), 'data', 'candles');
  const sizeBefore = getDirectorySize(candlesDir);

  // Fetch candles
  let completed = 0;
  let fetched = 0;
  let cached = 0;
  let failed = 0;
  const total = symbolsToFetch.length * TIMEFRAMES.length;

  console.log('Fetching candles...\n');

  for (const symbolInfo of symbolsToFetch) {
    const { symbol, marketType } = symbolInfo;

    for (const timeframe of TIMEFRAMES) {
      completed++;
      const progress = ((completed / total) * 100).toFixed(1);
      process.stdout.write(`\r[${progress}%] ${symbol} ${timeframe} ${marketType}...`.padEnd(60));

      const result = await fetchAndStoreCandles(
        symbol,
        timeframe,
        marketType,
        args.days,
        args.force
      );

      if (result.cached) {
        cached++;
      } else if (result.success) {
        fetched++;
      } else {
        failed++;
      }

      // Small delay to avoid rate limits
      if (!result.cached) {
        await new Promise(r => setTimeout(r, marketType === 'futures' ? 350 : 50));
      }
    }
  }

  // Final stats
  const sizeAfter = getDirectorySize(candlesDir);
  const sizeAdded = sizeAfter - sizeBefore;

  console.log('\n\n' + '='.repeat(50));
  console.log('Pre-fetch Complete');
  console.log('='.repeat(50));
  console.log(`\nResults:`);
  console.log(`  Symbols processed: ${symbolsToFetch.length}`);
  console.log(`  Total requests:    ${total}`);
  console.log(`  Already cached:    ${cached}`);
  console.log(`  Newly fetched:     ${fetched}`);
  console.log(`  Failed:            ${failed}`);
  console.log(`\nStorage:`);
  console.log(`  Before:    ${formatBytes(sizeBefore)}`);
  console.log(`  After:     ${formatBytes(sizeAfter)}`);
  console.log(`  Added:     ${formatBytes(sizeAdded)}`);
  console.log(`\nCache location: ${candlesDir}`);
  console.log('\n✅ Ready for backtesting!\n');
}

main().catch(error => {
  console.error('\nPre-fetch failed:', error);
  process.exit(1);
});
