#!/usr/bin/env node

import { BackburnerScreener } from './screener.js';
import {
  createHeader,
  createSetupsTable,
  createSummary,
  createSetupNotification,
  createProgressBar,
  clearScreen,
  moveCursorToTop,
} from './display.js';
import { DEFAULT_CONFIG } from './config.js';
import type { BackburnerSetup, Timeframe } from './types.js';

// Parse command line arguments
function parseArgs(): {
  timeframes: Timeframe[];
  minVolume: number;
  updateInterval: number;
  minImpulse: number;
} {
  const args = process.argv.slice(2);
  const result = {
    timeframes: DEFAULT_CONFIG.timeframes,
    minVolume: DEFAULT_CONFIG.minVolume24h,
    updateInterval: DEFAULT_CONFIG.updateIntervalMs,
    minImpulse: DEFAULT_CONFIG.minImpulsePercent,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--timeframes' || arg === '-t') {
      const tfArg = args[++i];
      if (tfArg) {
        result.timeframes = tfArg.split(',') as Timeframe[];
      }
    } else if (arg === '--min-volume' || arg === '-v') {
      result.minVolume = parseFloat(args[++i]) || result.minVolume;
    } else if (arg === '--interval' || arg === '-i') {
      result.updateInterval = parseInt(args[++i]) * 1000 || result.updateInterval;
    } else if (arg === '--min-impulse' || arg === '-m') {
      result.minImpulse = parseFloat(args[++i]) || result.minImpulse;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backburner Screener - TCG Strategy Scanner for MEXC

Usage: npm run dev [options]

Options:
  -t, --timeframes <list>   Comma-separated timeframes (default: 5m,15m,1h)
  -v, --min-volume <num>    Minimum 24h volume in USDT (default: 100000)
  -i, --interval <sec>      Update interval in seconds (default: 10)
  -m, --min-impulse <pct>   Minimum impulse move percentage (default: 3)
  -h, --help                Show this help message

Examples:
  npm run dev                           # Use default settings
  npm run dev -- -t 15m,1h              # Only scan 15m and 1h
  npm run dev -- -v 500000 -m 5         # Higher volume, bigger moves
`);
      process.exit(0);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  clearScreen();
  console.log(createHeader());
  console.log('  Starting Backburner Screener...\n');

  // Track notifications and status
  const notifications: string[] = [];
  let lastDisplayTime = 0;
  let currentStatus = '';
  const displayThrottleMs = 1000; // Update display at most once per second

  const screener = new BackburnerScreener(
    {
      timeframes: args.timeframes,
      minVolume24h: args.minVolume,
      updateIntervalMs: args.updateInterval,
      minImpulsePercent: args.minImpulse,
    },
    {
      onNewSetup: (setup: BackburnerSetup) => {
        notifications.push(createSetupNotification(setup, 'new'));
        updateDisplay();
      },
      onSetupUpdated: (setup: BackburnerSetup) => {
        notifications.push(createSetupNotification(setup, 'updated'));
        updateDisplay();
      },
      onSetupRemoved: (setup: BackburnerSetup) => {
        notifications.push(createSetupNotification(setup, 'removed'));
        updateDisplay();
      },
      onScanProgress: (completed: number, total: number, phase: string) => {
        // Show progress during initial scan
        currentStatus = phase;
        if (completed < total) {
          moveCursorToTop();
          console.log(createHeader());
          console.log(createProgressBar(completed, total, phase));
        }
      },
      onScanStatus: (status: string) => {
        currentStatus = status;
        updateDisplay();
      },
      onError: (error: Error, symbol?: string) => {
        // Log errors to stderr without disrupting display
        // console.error(`Error${symbol ? ` (${symbol})` : ''}: ${error.message}`);
      },
    }
  );

  function updateDisplay() {
    const now = Date.now();
    if (now - lastDisplayTime < displayThrottleMs) {
      return;
    }
    lastDisplayTime = now;

    moveCursorToTop();
    console.log(createHeader());
    // Get all setups including played-out ones for display
    const allSetups = screener.getAllSetups();
    const activeSetups = screener.getActiveSetups();

    console.log(createSummary(
      allSetups,
      screener.getEligibleSymbolCount(),
      screener.isActive(),
      currentStatus
    ));

    // Show recent notifications (last 5)
    const recentNotifications = notifications.slice(-5);
    if (recentNotifications.length > 0) {
      console.log(recentNotifications.join(''));
    }

    console.log(createSetupsTable(allSetups));
    console.log('\n  Press Ctrl+C to exit\n');
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n  Shutting down...\n');
    screener.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    screener.stop();
    process.exit(0);
  });

  try {
    await screener.start();

    // Initial display after scan completes
    updateDisplay();

    // Periodic display refresh
    setInterval(updateDisplay, 5000);
  } catch (error) {
    console.error('Failed to start screener:', error);
    process.exit(1);
  }
}

main();
