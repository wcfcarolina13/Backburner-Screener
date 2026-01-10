#!/usr/bin/env node

/**
 * Quick symbol checker - analyze a specific symbol for Backburner setups
 * Usage: npx ts-node src/check-symbol.ts RENDER
 *        npm run check RENDER
 */

import { getKlines, getFuturesKlines, spotSymbolToFutures } from './mexc-api.js';
import { BackburnerDetector } from './backburner-detector.js';
import { calculateRSI, getCurrentRSI } from './indicators.js';
import { DEFAULT_CONFIG } from './config.js';
import type { Timeframe, Candle } from './types.js';
import chalk from 'chalk';

const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h'];

async function checkSymbol(input: string): Promise<void> {
  // Normalize symbol input
  let symbol = input.toUpperCase().trim();
  if (!symbol.endsWith('USDT')) {
    symbol = symbol + 'USDT';
  }
  const futuresSymbol = spotSymbolToFutures(symbol);

  console.log(chalk.cyan.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  console.log(chalk.cyan.bold(`  Backburner Analysis: ${symbol}`));
  console.log(chalk.cyan.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

  const detector = new BackburnerDetector({
    rsiPeriod: DEFAULT_CONFIG.rsiPeriod,
    rsiOversoldThreshold: DEFAULT_CONFIG.rsiOversoldThreshold,
    rsiOverboughtThreshold: DEFAULT_CONFIG.rsiOverboughtThreshold,
    minImpulsePercent: DEFAULT_CONFIG.minImpulsePercent,
  });

  // Check both spot and futures
  for (const marketType of ['spot', 'futures'] as const) {
    const marketSymbol = marketType === 'futures' ? futuresSymbol : symbol;
    console.log(chalk.yellow.bold(`  ${marketType.toUpperCase()} (${marketSymbol})`));
    console.log(chalk.gray(`  ${'─'.repeat(45)}`));

    for (const timeframe of TIMEFRAMES) {
      try {
        // Fetch candles
        const candles = marketType === 'spot'
          ? await getKlines(symbol, timeframe)
          : await getFuturesKlines(futuresSymbol, timeframe);

        if (!candles || candles.length < 50) {
          console.log(chalk.gray(`  ${timeframe.padEnd(4)} │ Insufficient data`));
          continue;
        }

        // Calculate RSI
        const currentRSI = getCurrentRSI(candles, DEFAULT_CONFIG.rsiPeriod);
        const currentPrice = candles[candles.length - 1].close;

        // Analyze for setups
        const setups = detector.analyzeSymbol(symbol, timeframe, candles);

        // Format RSI with color
        let rsiStr = currentRSI !== null ? currentRSI.toFixed(1) : 'N/A';
        if (currentRSI !== null) {
          if (currentRSI < 30) {
            rsiStr = chalk.red.bold(rsiStr + ' (Oversold)');
          } else if (currentRSI > 70) {
            rsiStr = chalk.green.bold(rsiStr + ' (Overbought)');
          } else if (currentRSI < 40) {
            rsiStr = chalk.yellow(rsiStr);
          } else if (currentRSI > 60) {
            rsiStr = chalk.cyan(rsiStr);
          } else {
            rsiStr = chalk.gray(rsiStr + ' (Neutral)');
          }
        }

        // Check for active setups
        const activeSetup = setups.find(s => s.state !== 'played_out');

        if (activeSetup) {
          const stateColors: Record<string, (s: string) => string> = {
            triggered: chalk.bgGreen.black,
            deep_extreme: chalk.bgRed.white,
            reversing: chalk.bgYellow.black,
            watching: chalk.gray,
          };
          const stateColor = stateColors[activeSetup.state] || chalk.white;
          const dirColor = activeSetup.direction === 'long' ? chalk.green : chalk.red;

          console.log(
            `  ${chalk.white.bold(timeframe.padEnd(4))} │ ` +
            `RSI: ${rsiStr.padEnd(25)} │ ` +
            `${dirColor.bold(activeSetup.direction.toUpperCase().padEnd(5))} ` +
            `${stateColor(` ${activeSetup.state.toUpperCase()} `)}`
          );

          // Show entry/target info for triggered setups
          if (activeSetup.state === 'triggered' || activeSetup.state === 'deep_extreme') {
            const entryPrice = activeSetup.entryPrice || currentPrice;
            const targetRSI = activeSetup.direction === 'long' ? '50+ (take profit)' : '50- (take profit)';
            console.log(
              chalk.gray(`         │ Entry: ${entryPrice.toPrecision(5)} │ Target RSI: ${targetRSI}`)
            );
          }
        } else {
          console.log(
            `  ${chalk.white(timeframe.padEnd(4))} │ ` +
            `RSI: ${rsiStr.padEnd(25)} │ ` +
            chalk.gray('No active setup')
          );
        }

      } catch (error) {
        console.log(chalk.gray(`  ${timeframe.padEnd(4)} │ Error: ${(error as Error).message}`));
      }
    }
    console.log('');
  }

  // Summary
  const allSetups = detector.getActiveSetups();
  if (allSetups.length > 0) {
    console.log(chalk.green.bold(`  Found ${allSetups.length} active setup(s):`));
    for (const setup of allSetups) {
      const dirColor = setup.direction === 'long' ? chalk.green : chalk.red;
      console.log(
        `    • ${setup.timeframe} ${dirColor(setup.direction.toUpperCase())} - ${setup.state}`
      );
    }
  } else {
    console.log(chalk.gray(`  No active Backburner setups for ${symbol}`));
  }

  console.log(chalk.cyan.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
}

// Main
const symbol = process.argv[2];
if (!symbol) {
  console.log(chalk.red('Usage: npm run check <SYMBOL>'));
  console.log(chalk.gray('Example: npm run check RENDER'));
  console.log(chalk.gray('         npm run check BTC'));
  process.exit(1);
}

checkSymbol(symbol).catch(err => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
