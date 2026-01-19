#!/usr/bin/env node
/**
 * Generate Signals - Create synthetic signals from historical candles
 *
 * Runs the backburner detector on historical candle data to generate
 * signals for backtesting timeframes that don't have real paper trade data.
 *
 * Usage:
 *   npm run generate-signals -- --timeframe 4h --days 30
 *   npm run generate-signals -- --timeframe 4h --symbols BTCUSDT,ETHUSDT
 */

import fs from 'fs';
import path from 'path';
import { Timeframe, BackburnerSetup, Candle } from './types.js';
import { getStoredCandles, getStoredSymbols, getSymbolInfo } from './candle-store.js';
import { BackburnerDetector } from './backburner-detector.js';
import { SignalEvent } from './backtest-engine.js';

const SIGNALS_DIR = path.join(process.cwd(), 'data', 'generated-signals');

// Ensure directory exists
if (!fs.existsSync(SIGNALS_DIR)) {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

// ============= CLI Argument Parsing =============

function parseArgs(): {
  timeframe: Timeframe;
  days: number;
  symbols?: string[];
  marketType: 'spot' | 'futures' | 'both';
} {
  const args = process.argv.slice(2);
  const result = {
    timeframe: '4h' as Timeframe,
    days: 30,
    symbols: undefined as string[] | undefined,
    marketType: 'both' as 'spot' | 'futures' | 'both'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--timeframe':
      case '-t':
        result.timeframe = nextArg as Timeframe;
        i++;
        break;
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
Generate Synthetic Signals from Historical Candles

Usage: npm run generate-signals -- [options]

Options:
  --timeframe, -t <tf>  Timeframe to generate signals for (default: 4h)
  --days, -d <num>      Days of history to scan (default: 30)
  --symbols, -s <list>  Comma-separated symbols (default: all with data)
  --market, -m <type>   Market type: spot, futures, or both (default: both)
  --help, -h            Show this help

Examples:
  npm run generate-signals -- --timeframe 4h --days 30
  npm run generate-signals -- --timeframe 1h --symbols BTCUSDT,ETHUSDT
`);
}

// ============= Signal Generation =============

interface GeneratedSignal extends SignalEvent {
  generated: true;
  setupState: string;
}

/**
 * Generate signals by scanning historical candles with the detector
 */
function generateSignalsFromCandles(
  symbol: string,
  timeframe: Timeframe,
  marketType: 'spot' | 'futures',
  candles: Candle[],
  detector: BackburnerDetector
): GeneratedSignal[] {
  const signals: GeneratedSignal[] = [];

  if (candles.length < 100) {
    return signals;
  }

  // Track which setups we've already signaled (avoid duplicates)
  const signaled = new Set<string>();

  // Slide through candles, giving detector progressively more data
  // Start at 100 candles (minimum needed for good RSI)
  for (let i = 100; i <= candles.length; i++) {
    const windowCandles = candles.slice(0, i);
    const currentCandle = windowCandles[windowCandles.length - 1];

    // Run detector on this window
    const setups = detector.analyzeSymbol(symbol, timeframe, windowCandles);

    for (const setup of setups) {
      // Only count triggered or deep_extreme as entry signals
      if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
        continue;
      }

      // Create unique key for this signal
      const signalKey = `${symbol}-${timeframe}-${setup.direction}-${setup.state}-${currentCandle.timestamp}`;

      // Skip if we already have this signal (or within last 4h to avoid spam)
      const recentKey = `${symbol}-${timeframe}-${setup.direction}`;
      if (signaled.has(recentKey)) {
        // Check if enough time passed (at least 1 candle of the timeframe)
        const lastSignalTime = parseInt(Array.from(signaled).find(k => k.startsWith(recentKey))?.split('-').pop() || '0');
        const timeframeMs = getTimeframeMs(timeframe);
        if (currentCandle.timestamp - lastSignalTime < timeframeMs * 2) {
          continue;
        }
      }

      // Record this signal
      signaled.add(`${recentKey}-${currentCandle.timestamp}`);

      signals.push({
        timestamp: new Date(currentCandle.timestamp).toISOString(),
        eventType: setup.state,
        symbol,
        direction: setup.direction,
        timeframe,
        marketType,
        state: setup.state,
        rsi: setup.currentRSI,
        price: currentCandle.close,
        impulsePercent: setup.impulsePercentMove,
        generated: true,
        setupState: setup.state
      });
    }
  }

  return signals;
}

function getTimeframeMs(timeframe: Timeframe): number {
  const map: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000
  };
  return map[timeframe] || 4 * 60 * 60 * 1000;
}

// ============= Main =============

async function main(): Promise<void> {
  console.log('\n📊 Signal Generator for Backtesting\n');

  const args = parseArgs();
  const detector = new BackburnerDetector();

  console.log(`Timeframe: ${args.timeframe}`);
  console.log(`Days: ${args.days}`);
  console.log(`Market: ${args.marketType}`);

  // Get symbols with data
  let symbols = args.symbols || getStoredSymbols();

  if (symbols.length === 0) {
    console.log('No symbols with candle data found. Run prefetch first.');
    return;
  }

  console.log(`\nScanning ${symbols.length} symbols...\n`);

  const allSignals: GeneratedSignal[] = [];
  const now = Date.now();
  const startTime = now - (args.days * 24 * 60 * 60 * 1000);

  let processed = 0;
  let withSignals = 0;

  for (const symbol of symbols) {
    processed++;
    process.stdout.write(`\r[${processed}/${symbols.length}] ${symbol.padEnd(15)}...`);

    const marketTypes: ('spot' | 'futures')[] =
      args.marketType === 'both' ? ['futures', 'spot'] : [args.marketType];

    for (const marketType of marketTypes) {
      const candles = getStoredCandles(symbol, args.timeframe, marketType, startTime, now);

      if (candles.length < 100) {
        continue;
      }

      const signals = generateSignalsFromCandles(
        symbol,
        args.timeframe,
        marketType,
        candles,
        detector
      );

      if (signals.length > 0) {
        withSignals++;
        allSignals.push(...signals);
      }
    }
  }

  // Sort by timestamp
  allSignals.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Group by date for output files
  const byDate = new Map<string, GeneratedSignal[]>();
  for (const signal of allSignals) {
    const date = signal.timestamp.split('T')[0];
    if (!byDate.has(date)) {
      byDate.set(date, []);
    }
    byDate.get(date)!.push(signal);
  }

  // Save signals to files (one per date)
  const outputDir = path.join(SIGNALS_DIR, args.timeframe);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [date, signals] of byDate) {
    const filePath = path.join(outputDir, `${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(signals, null, 2));
  }

  // Summary
  console.log('\n\n' + '='.repeat(50));
  console.log('Signal Generation Complete');
  console.log('='.repeat(50));
  console.log(`\nResults:`);
  console.log(`  Symbols scanned:    ${symbols.length}`);
  console.log(`  Symbols with data:  ${withSignals}`);
  console.log(`  Total signals:      ${allSignals.length}`);
  console.log(`  Date range:         ${byDate.size} days`);

  // Signal breakdown
  const longSignals = allSignals.filter(s => s.direction === 'long').length;
  const shortSignals = allSignals.filter(s => s.direction === 'short').length;
  const triggeredSignals = allSignals.filter(s => s.state === 'triggered').length;
  const deepSignals = allSignals.filter(s => s.state === 'deep_extreme').length;

  console.log(`\nBreakdown:`);
  console.log(`  Long signals:       ${longSignals}`);
  console.log(`  Short signals:      ${shortSignals}`);
  console.log(`  Triggered:          ${triggeredSignals}`);
  console.log(`  Deep extreme:       ${deepSignals}`);

  console.log(`\nSaved to: ${outputDir}`);
  console.log('\n✅ Ready for backtesting!\n');
  console.log(`Next: npm run backtest -- --timeframe ${args.timeframe} --generated\n`);
}

main().catch(error => {
  console.error('\nSignal generation failed:', error);
  process.exit(1);
});
