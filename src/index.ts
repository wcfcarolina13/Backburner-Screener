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
  showCursor,
  enterAltScreen,
  exitAltScreen,
} from './display.js';
import { NotificationManager } from './notifications.js';
import { PaperTradingEngine } from './paper-trading.js';
import { getDataPersistence } from './data-persistence.js';
import { getCurrentPrice } from './mexc-api.js';
import { DEFAULT_CONFIG } from './config.js';
import chalk from 'chalk';
import type { BackburnerSetup, Timeframe } from './types.js';

// Parse command line arguments
function parseArgs(): {
  timeframes: Timeframe[];
  minVolume: number;
  updateInterval: number;
  minImpulse: number;
  notifications: boolean;
  sound: string;
  paperTrading: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    timeframes: DEFAULT_CONFIG.timeframes,
    minVolume: DEFAULT_CONFIG.minVolume24h,
    updateInterval: DEFAULT_CONFIG.updateIntervalMs,
    minImpulse: DEFAULT_CONFIG.minImpulsePercent,
    notifications: true,
    sound: 'Glass',
    paperTrading: true,
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
    } else if (arg === '--no-notify') {
      result.notifications = false;
    } else if (arg === '--no-paper') {
      result.paperTrading = false;
    } else if (arg === '--sound' || arg === '-s') {
      result.sound = args[++i] || result.sound;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backburner Screener - TCG Strategy Scanner for MEXC

Usage: npm start [options]

Options:
  -t, --timeframes <list>   Comma-separated timeframes (default: 5m,15m,1h)
  -v, --min-volume <num>    Minimum 24h volume in USDT (default: 250000)
  -i, --interval <sec>      Update interval in seconds (default: 10)
  -m, --min-impulse <pct>   Minimum impulse move percentage (default: 5)
  -s, --sound <name>        Notification sound (default: Glass)
                            Options: Glass, Ping, Pop, Purr, Submarine, Blow, Bottle,
                                     Frog, Funk, Hero, Morse, Sosumi, Tink
  --no-notify               Disable push notifications
  --no-paper                Disable paper trading simulation

Examples:
  npm start                           # Use default settings
  npm start -- -t 15m,1h              # Only scan 15m and 1h
  npm start -- -v 500000 -m 5         # Higher volume, bigger moves
  npm start -- --sound Ping           # Use Ping sound for notifications
  npm start -- --no-notify            # Disable notifications
`);
      process.exit(0);
    }
  }

  return result;
}

// Format currency
function formatCurrency(value: number): string {
  const sign = value >= 0 ? '' : '-';
  return sign + '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Create paper trading display
function createPaperTradingDisplay(paperTrader: PaperTradingEngine): string {
  const stats = paperTrader.getStats();
  const openPositions = paperTrader.getOpenPositions();
  const recentTrades = paperTrader.getClosedPositions(5);

  const balanceColor = stats.totalPnL >= 0 ? chalk.green : chalk.red;
  const pnlColor = stats.totalPnL >= 0 ? chalk.green : chalk.red;

  const lines = [
    chalk.cyan.bold('┌─────────────────────────────────────────────────────────────────────────┐'),
    chalk.cyan.bold('│') + '  ' + chalk.white.bold('📊 PAPER TRADING') + ' ' + chalk.gray('($2000 | 1% position | 10x leverage | 20% TP/SL)') + '  ' + chalk.cyan.bold('│'),
    chalk.cyan.bold('├─────────────────────────────────────────────────────────────────────────┤'),
    chalk.cyan.bold('│') + `  Balance: ${balanceColor.bold(formatCurrency(stats.currentBalance))}  |  ` +
      `P&L: ${pnlColor.bold(formatCurrency(stats.totalPnL))} (${pnlColor(stats.totalPnLPercent.toFixed(1) + '%')})  |  ` +
      `Win Rate: ${chalk.yellow(stats.winRate.toFixed(0) + '%')} (${stats.winningTrades}/${stats.totalTrades})` +
      '  ' + chalk.cyan.bold('│'),
  ];

  // Open positions
  if (openPositions.length > 0) {
    lines.push(chalk.cyan.bold('├─────────────────────────────────────────────────────────────────────────┤'));
    lines.push(chalk.cyan.bold('│') + '  ' + chalk.white.bold('Open Positions:') + ' '.repeat(56) + chalk.cyan.bold('│'));

    for (const pos of openPositions.slice(0, 3)) {
      const ticker = pos.symbol.replace('USDT', '');
      const dir = pos.direction === 'long' ? chalk.green('LONG') : chalk.red('SHORT');
      const pnl = pos.unrealizedPnL >= 0 ? chalk.green : chalk.red;
      const pnlStr = pnl(`${formatCurrency(pos.unrealizedPnL)} (${pos.unrealizedPnLPercent >= 0 ? '+' : ''}${pos.unrealizedPnLPercent.toFixed(1)}%)`);

      const line = `  ${chalk.cyan(ticker.padEnd(8))} ${dir} @ ${pos.entryPrice.toPrecision(5)} → ${pnlStr}`;
      lines.push(chalk.cyan.bold('│') + line.padEnd(82) + chalk.cyan.bold('│'));
    }

    if (openPositions.length > 3) {
      lines.push(chalk.cyan.bold('│') + chalk.gray(`  ... and ${openPositions.length - 3} more positions`).padEnd(73) + chalk.cyan.bold('│'));
    }
  }

  // Recent trades
  if (recentTrades.length > 0) {
    lines.push(chalk.cyan.bold('├─────────────────────────────────────────────────────────────────────────┤'));
    lines.push(chalk.cyan.bold('│') + '  ' + chalk.white.bold('Recent Trades:') + ' '.repeat(57) + chalk.cyan.bold('│'));

    for (const trade of recentTrades.slice(0, 3)) {
      const ticker = trade.symbol.replace('USDT', '');
      const dir = trade.direction === 'long' ? chalk.green('L') : chalk.red('S');
      const pnl = (trade.realizedPnL || 0) >= 0 ? chalk.green : chalk.red;
      const pnlStr = pnl(`${formatCurrency(trade.realizedPnL || 0)}`);
      const reason = trade.exitReason === 'Take Profit Hit' ? chalk.green('TP') :
                     trade.exitReason === 'Stop Loss Hit' ? chalk.red('SL') : chalk.gray('PO');

      const line = `  ${chalk.cyan(ticker.padEnd(8))} ${dir} ${pnlStr.padEnd(20)} ${reason} ${chalk.gray(trade.exitReason || '')}`;
      lines.push(chalk.cyan.bold('│') + line.padEnd(82) + chalk.cyan.bold('│'));
    }
  }

  lines.push(chalk.cyan.bold('└─────────────────────────────────────────────────────────────────────────┘'));

  return lines.join('\n');
}

async function main() {
  const args = parseArgs();

  // Use alternate screen buffer to prevent scroll history spam
  enterAltScreen();
  clearScreen();
  console.log(createHeader());
  console.log('  Starting Backburner Screener...\n');

  // Initialize notification manager
  const notifier = new NotificationManager({
    enabled: args.notifications,
    sound: true,
    soundName: args.sound,
    onlyTriggered: true,
  });

  // Initialize paper trading engine
  const paperTrader = args.paperTrading ? new PaperTradingEngine({
    initialBalance: 2000,
    positionSizePercent: 1,
    leverage: 10,
    takeProfitPercent: 20,
    stopLossPercent: 20,
    maxOpenPositions: 10,
  }) : null;

  // Initialize data persistence
  const dataPersistence = getDataPersistence();

  // Track notifications and status
  const notifications: string[] = [];
  let lastDisplayTime = 0;
  let currentStatus = '';
  const displayThrottleMs = 1000; // Update display at most once per second
  let isDisplaying = false; // Prevent concurrent display updates

  // Track previous states for state change notifications
  const previousStates: Map<string, string> = new Map();

  const screener = new BackburnerScreener(
    {
      timeframes: args.timeframes,
      minVolume24h: args.minVolume,
      updateIntervalMs: args.updateInterval,
      minImpulsePercent: args.minImpulse,
    },
    {
      onNewSetup: async (setup: BackburnerSetup) => {
        // Log signal to persistence
        dataPersistence.logSignal(setup, 'new');
        if (setup.state === 'triggered') {
          dataPersistence.logSignal(setup, 'triggered');
        } else if (setup.state === 'deep_extreme') {
          dataPersistence.logSignal(setup, 'deep_extreme');
        }

        notifications.push(createSetupNotification(setup, 'new'));

        // Paper trading: try to open position on triggered/deep_extreme
        if (paperTrader) {
          // Check if state is tradeable
          if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
            const position = paperTrader.openPosition(setup);
            if (position) {
              notifications.push(chalk.blue(`  💼 Paper trade OPENED: ${setup.symbol.replace('USDT', '')} ${setup.direction.toUpperCase()} @ ${position.entryPrice.toPrecision(5)}\n`));
            } else {
              // Explain why no position was opened
              const existingPositions = paperTrader.getOpenPositions();
              const hasExisting = existingPositions.some(p =>
                p.symbol === setup.symbol &&
                p.direction === setup.direction &&
                p.marketType === setup.marketType
              );
              if (hasExisting) {
                notifications.push(chalk.gray(`  💼 Already have ${setup.symbol.replace('USDT', '')} ${setup.direction} position\n`));
              } else if (existingPositions.length >= 10) {
                notifications.push(chalk.gray(`  💼 Max positions reached (10)\n`));
              }
            }
          }
        }

        updateDisplay();

        // Send push notification for new triggered/deep_extreme setups
        await notifier.notifyNewSetup(setup);

        // Track state
        const key = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
        previousStates.set(key, setup.state);
      },
      onSetupUpdated: async (setup: BackburnerSetup) => {
        const key = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
        const previousState = previousStates.get(key);

        // Log state changes to persistence
        if (previousState !== setup.state) {
          dataPersistence.logSignal(setup, 'updated');
          if (setup.state === 'triggered') {
            dataPersistence.logSignal(setup, 'triggered');
          } else if (setup.state === 'deep_extreme') {
            dataPersistence.logSignal(setup, 'deep_extreme');
          } else if (setup.state === 'played_out') {
            dataPersistence.logSignal(setup, 'played_out');
          }
        }

        // Paper trading: update position and check for exits
        if (paperTrader) {
          const position = paperTrader.updatePosition(setup);
          if (position && position.status !== 'open') {
            const pnlColor = (position.realizedPnL || 0) >= 0 ? chalk.green : chalk.red;
            notifications.push(chalk.blue(`  💼 Paper trade CLOSED: ${setup.symbol.replace('USDT', '')} ${pnlColor(formatCurrency(position.realizedPnL || 0))} - ${position.exitReason}\n`));
          }
        }

        notifications.push(createSetupNotification(setup, 'updated'));
        updateDisplay();

        // Notify on state changes
        if (previousState && previousState !== setup.state) {
          // Notify when transitioning TO triggered/deep_extreme
          await notifier.notifyStateChange(setup, previousState);

          // Notify when transitioning TO played_out (take profit signal)
          if (setup.state === 'played_out') {
            await notifier.notifyPlayedOut(setup);
          }
        }

        previousStates.set(key, setup.state);
      },
      onSetupRemoved: (setup: BackburnerSetup) => {
        // Log removal to persistence
        dataPersistence.logSignal(setup, 'removed');

        // Paper trading: close position if setup is removed
        if (paperTrader) {
          paperTrader.handleSetupRemoved(setup);
        }

        notifications.push(createSetupNotification(setup, 'removed'));
        updateDisplay();

        // Clear from tracking
        const key = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
        previousStates.delete(key);
        notifier.clearSetup(setup.symbol, setup.timeframe, setup.direction, setup.marketType);
      },
      onScanProgress: (completed: number, total: number, phase: string) => {
        // Show progress during scan - include setups table so it persists
        currentStatus = phase;
        if (completed < total) {
          // Skip if another display update is in progress
          if (isDisplaying) return;
          isDisplaying = true;
          try {
            const allSetups = screener.getAllSetups();
            const notifyStatus = args.notifications ? `🔔 ${args.sound}` : '🔕 Off';
            const paperStatus = args.paperTrading ? '📊 Paper Trading ON' : '';
            const output = [
              createHeader(),
              createProgressBar(completed, total, phase),
              '\n' + createSetupsTable(allSetups),
              paperTrader ? '\n' + createPaperTradingDisplay(paperTrader) : '',
              `\n  ${notifyStatus} | ${paperStatus} | Press Ctrl+C to exit\n`,
            ].join('');
            moveCursorToTop();
            process.stdout.write(output);
          } finally {
            isDisplaying = false;
          }
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
    // Prevent concurrent display updates (race condition protection)
    if (isDisplaying) {
      return;
    }
    isDisplaying = true;
    lastDisplayTime = now;

    try {
      // Build entire output as a single string to avoid interleaving
      const allSetups = screener.getAllSetups();
      const recentNotifications = notifications.slice(-5);
      const notifyStatus = args.notifications ? `🔔 ${args.sound}` : '🔕 Off';
      const paperStatus = args.paperTrading ? '📊 Paper Trading ON' : '';

      const output = [
        createHeader(),
        createSummary(
          allSetups,
          screener.getEligibleSymbolCount(),
          screener.isActive(),
          currentStatus
        ),
        recentNotifications.length > 0 ? recentNotifications.join('') : '',
        createSetupsTable(allSetups),
        paperTrader ? '\n' + createPaperTradingDisplay(paperTrader) : '',
        `\n  ${notifyStatus} | ${paperStatus} | Press Ctrl+C to exit\n`,
      ].join('');

      // Clear and write in one go
      moveCursorToTop();
      process.stdout.write(output);
    } finally {
      isDisplaying = false;
    }
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    // Exit alternate screen first, then show results in normal terminal
    exitAltScreen();
    showCursor();
    console.log('\n  Shutting down Backburner Screener...\n');

    // Flush and generate daily summary
    try {
      const botConfigs: Record<string, Record<string, unknown>> = {};
      const botStats: Record<string, import('./paper-trading.js').TradingStats> = {};

      if (paperTrader) {
        const botId = paperTrader.getBotId();
        botConfigs[botId] = paperTrader.getConfig() as unknown as Record<string, unknown>;
        botStats[botId] = paperTrader.getStats();

        const stats = paperTrader.getStats();
        console.log(chalk.cyan.bold('  Final Paper Trading Results:'));
        console.log(`  Balance: ${formatCurrency(stats.currentBalance)} | P&L: ${formatCurrency(stats.totalPnL)} (${stats.totalPnLPercent.toFixed(1)}%)`);
        console.log(`  Trades: ${stats.totalTrades} | Win Rate: ${stats.winRate.toFixed(0)}%\n`);
      }

      // Generate and save daily summary
      dataPersistence.generateDailySummary(undefined, botConfigs, botStats);
      dataPersistence.stop();
      console.log(chalk.gray('  Data saved to ./data/\n'));
    } catch (e) {
      console.error('  Error saving data:', e);
    }

    screener.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    exitAltScreen();
    showCursor();
    dataPersistence.stop();
    screener.stop();
    process.exit(0);
  });

  try {
    await screener.start();

    // Initial display after scan completes
    updateDisplay();

    // Periodic display refresh
    setInterval(updateDisplay, 5000);

    // Periodic orphaned position price updates (every 30 seconds)
    if (paperTrader) {
      setInterval(async () => {
        await paperTrader.updateOrphanedPositions(getCurrentPrice);
      }, 30000);
    }
  } catch (error) {
    console.error('Failed to start screener:', error);
    process.exit(1);
  }
}

main();
