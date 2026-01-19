#!/usr/bin/env node
/**
 * Backtest CLI - Run backtests from command line
 *
 * Usage:
 *   npm run backtest -- --start 2026-01-15 --end 2026-01-19
 *   npm run backtest -- --start 2026-01-15 --end 2026-01-19 --leverage 5,10,20
 *   npm run backtest -- --start 2026-01-15 --end 2026-01-19 --compare-fade
 *   npm run backtest -- --preset leverage-comparison
 */

import {
  runBacktest,
  printResults,
  compareStrategies,
  StrategyConfig,
  BacktestResult
} from './backtest-engine.js';

// ============= CLI Argument Parsing =============

function parseArgs(): {
  startDate: string;
  endDate: string;
  preset?: string;
  leverage?: number[];
  stopLoss?: number[];
  compareFade?: boolean;
  maxSignals?: number;
  symbols?: string[];
  outputFile?: string;
  generated?: boolean;
  timeframe?: string;
} {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {
    startDate: '',
    endDate: ''
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--start':
      case '-s':
        result.startDate = nextArg;
        i++;
        break;
      case '--end':
      case '-e':
        result.endDate = nextArg;
        i++;
        break;
      case '--preset':
      case '-p':
        result.preset = nextArg;
        i++;
        break;
      case '--leverage':
      case '-l':
        result.leverage = nextArg.split(',').map(Number);
        i++;
        break;
      case '--stop':
      case '--sl':
        result.stopLoss = nextArg.split(',').map(Number);
        i++;
        break;
      case '--compare-fade':
      case '--fade':
        result.compareFade = true;
        break;
      case '--max':
      case '-m':
        result.maxSignals = parseInt(nextArg, 10);
        i++;
        break;
      case '--symbols':
        result.symbols = nextArg.split(',');
        i++;
        break;
      case '--output':
      case '-o':
        result.outputFile = nextArg;
        i++;
        break;
      case '--generated':
      case '-g':
        result.generated = true;
        break;
      case '--timeframe':
      case '-t':
        result.timeframe = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  // Default to last 5 days if not specified
  if (!result.startDate || !result.endDate) {
    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    result.startDate = result.startDate || start;
    result.endDate = result.endDate || end;
  }

  return result;
}

function printHelp(): void {
  console.log(`
Backburner Backtester

Usage: npm run backtest -- [options]

Options:
  --start, -s <date>      Start date (YYYY-MM-DD). Default: 5 days ago
  --end, -e <date>        End date (YYYY-MM-DD). Default: today
  --preset, -p <name>     Use a preset configuration
  --leverage, -l <list>   Comma-separated leverage values to test (e.g., 5,10,20)
  --stop, --sl <list>     Comma-separated stop loss %s to test (e.g., 10,15,20)
  --compare-fade          Compare normal vs fade (opposite direction)
  --max, -m <num>         Max signals to test (for quick tests)
  --symbols <list>        Only test specific symbols (e.g., BTCUSDT,ETHUSDT)
  --output, -o <file>     Save results to JSON file
  --generated, -g         Use generated signals (from generate-signals script)
  --timeframe, -t <tf>    Timeframe to test (required with --generated)
  --help, -h              Show this help

Presets:
  leverage-comparison     Test 5x, 10x, 20x leverage
  fade-comparison         Compare normal vs fade strategy
  stop-comparison         Test 10%, 15%, 20% stop losses
  full-analysis           All combinations (slow)

Examples:
  npm run backtest -- --start 2026-01-15 --end 2026-01-19
  npm run backtest -- --preset leverage-comparison
  npm run backtest -- --leverage 5,10 --compare-fade
  npm run backtest -- --max 50 --symbols BTCUSDT,ETHUSDT
  npm run backtest -- --generated --timeframe 4h --preset fade-comparison
`);
}

// ============= Strategy Presets =============

function getBaseStrategy(): StrategyConfig {
  return {
    name: 'base',
    leverage: 10,
    positionSizePercent: 5,
    initialStopLossPercent: 15,
    enableTrailing: true,
    trailTriggerPercent: 10,
    trailStepPercent: 5,
    level1LockPercent: 2,
    fadeSignals: false,
    takeProfitPercent: undefined  // Let trailing stops manage exits
  };
}

function getLeverageComparisonStrategies(): StrategyConfig[] {
  const base = getBaseStrategy();
  return [
    { ...base, name: '5x Leverage', leverage: 5 },
    { ...base, name: '10x Leverage', leverage: 10 },
    { ...base, name: '20x Leverage', leverage: 20 }
  ];
}

function getFadeComparisonStrategies(): StrategyConfig[] {
  const base = getBaseStrategy();
  return [
    { ...base, name: 'Normal (Follow Signal)', fadeSignals: false },
    { ...base, name: 'Fade (Opposite Direction)', fadeSignals: true }
  ];
}

function getStopComparisonStrategies(): StrategyConfig[] {
  const base = getBaseStrategy();
  return [
    { ...base, name: '10% Stop', initialStopLossPercent: 10 },
    { ...base, name: '15% Stop', initialStopLossPercent: 15 },
    { ...base, name: '20% Stop', initialStopLossPercent: 20 }
  ];
}

function getFullAnalysisStrategies(): StrategyConfig[] {
  const strategies: StrategyConfig[] = [];
  const base = getBaseStrategy();

  for (const leverage of [5, 10, 20]) {
    for (const stop of [10, 15, 20]) {
      for (const fade of [false, true]) {
        strategies.push({
          ...base,
          name: `${leverage}x/${stop}%SL/${fade ? 'Fade' : 'Normal'}`,
          leverage,
          initialStopLossPercent: stop,
          fadeSignals: fade
        });
      }
    }
  }

  return strategies;
}

function getStrategiesFromArgs(args: ReturnType<typeof parseArgs>): StrategyConfig[] {
  const base = getBaseStrategy();

  // Handle presets
  if (args.preset) {
    switch (args.preset) {
      case 'leverage-comparison':
        return getLeverageComparisonStrategies();
      case 'fade-comparison':
        return getFadeComparisonStrategies();
      case 'stop-comparison':
        return getStopComparisonStrategies();
      case 'full-analysis':
        return getFullAnalysisStrategies();
      default:
        console.error(`Unknown preset: ${args.preset}`);
        process.exit(1);
    }
  }

  // Build strategies from individual args
  const strategies: StrategyConfig[] = [];

  const leverages = args.leverage || [10];
  const stops = args.stopLoss || [15];
  const fades = args.compareFade ? [false, true] : [false];

  for (const leverage of leverages) {
    for (const stop of stops) {
      for (const fade of fades) {
        strategies.push({
          ...base,
          name: `${leverage}x/${stop}%SL${fade ? '/Fade' : ''}`,
          leverage,
          initialStopLossPercent: stop,
          fadeSignals: fade
        });
      }
    }
  }

  return strategies;
}

// ============= Main =============

async function main(): Promise<void> {
  console.log('\n🔬 Backburner Backtester\n');

  const args = parseArgs();
  const strategies = getStrategiesFromArgs(args);

  console.log(`Date Range: ${args.startDate} to ${args.endDate}`);
  console.log(`Strategies: ${strategies.length}`);
  if (args.maxSignals) {
    console.log(`Max Signals: ${args.maxSignals}`);
  }
  if (args.symbols) {
    console.log(`Symbols: ${args.symbols.join(', ')}`);
  }
  if (args.generated) {
    console.log(`Signal Source: Generated signals`);
    console.log(`Timeframe: ${args.timeframe || '(not specified)'}`);
  } else {
    console.log(`Signal Source: Trade logs`);
  }

  console.log('\nStrategies to test:');
  for (const s of strategies) {
    console.log(`  - ${s.name}`);
  }

  console.log('\n');

  // Run backtest
  const results = await runBacktest(
    args.startDate,
    args.endDate,
    strategies,
    {
      initialBalance: 2000,
      useTradeSignals: !args.generated,
      useGeneratedSignals: args.generated,
      generatedTimeframe: args.timeframe,
      maxSignals: args.maxSignals,
      symbolFilter: args.symbols,
      timeframeFilter: args.timeframe
    }
  );

  // Print results
  printResults(results);

  // If comparing, show side-by-side
  if (results.length >= 2) {
    compareStrategies(results);
  }

  // Save to file if requested
  if (args.outputFile) {
    const fs = await import('fs');
    fs.writeFileSync(args.outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${args.outputFile}`);
  }

  console.log('\n✅ Backtest complete\n');
}

main().catch(error => {
  console.error('Backtest failed:', error);
  process.exit(1);
});
