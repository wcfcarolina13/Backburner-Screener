import chalk from 'chalk';
import Table from 'cli-table3';
import type { BackburnerSetup, Timeframe, SetupState, QualityTier, MarketType, LiquidityRisk } from './types.js';

/**
 * Format time ago from timestamp
 */
function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format percentage with color
 */
function formatPercent(value: number, inverse = false): string {
  const formatted = `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (inverse) {
    return value >= 0 ? chalk.red(formatted) : chalk.green(formatted);
  }
  return value >= 0 ? chalk.green(formatted) : chalk.red(formatted);
}

/**
 * Format RSI with color coding
 */
function formatRSI(rsi: number): string {
  const formatted = rsi.toFixed(1);
  if (rsi < 20) return chalk.bgRed.white.bold(` ${formatted} `);
  if (rsi < 30) return chalk.red.bold(formatted);
  if (rsi < 40) return chalk.yellow(formatted);
  if (rsi > 70) return chalk.green.bold(formatted);
  return formatted;
}

/**
 * Format setup state with color and emoji
 */
function formatState(state: SetupState): string {
  switch (state) {
    case 'triggered':
      return chalk.bgGreen.black.bold(' TRIGGERED ');
    case 'deep_extreme':
      return chalk.bgRed.white.bold(' DEEP EXTREME ');
    case 'reversing':
      return chalk.bgYellow.black(' REVERSING ');
    case 'watching':
      return chalk.gray('watching');
    case 'played_out':
      return chalk.strikethrough.gray('played out');
    default:
      return state;
  }
}

/**
 * Format direction (LONG/SHORT)
 */
function formatDirection(direction: 'long' | 'short'): string {
  if (direction === 'long') {
    return chalk.bgGreen.black.bold(' LONG ');
  }
  return chalk.bgRed.white.bold(' SHORT ');
}

/**
 * Format quality tier with clear warnings
 */
function formatQualityTier(tier: QualityTier | undefined): string {
  switch (tier) {
    case 'bluechip':
      return chalk.green('★');
    case 'midcap':
      return chalk.yellow('●');
    case 'shitcoin':
      return chalk.bgRed.white.bold(' SHITCOIN ');
    default:
      return chalk.gray('?');
  }
}

/**
 * Format symbol with full name
 */
function formatSymbol(symbol: string, coinName: string | undefined, tier: QualityTier | undefined): string {
  const ticker = symbol.replace('USDT', '');
  const name = coinName || ticker;
  // Truncate long names (wider column now)
  const displayName = name.length > 16 ? name.slice(0, 14) + '..' : name;

  if (tier === 'shitcoin') {
    return chalk.red.bold(displayName);
  }
  return chalk.white.bold(displayName);
}

/**
 * Format market cap for display
 */
function formatMarketCap(marketCap: number | undefined): string {
  if (!marketCap) return chalk.gray('N/A');

  if (marketCap >= 1_000_000_000) {
    return chalk.green(`$${(marketCap / 1_000_000_000).toFixed(1)}B`);
  } else if (marketCap >= 100_000_000) {
    return chalk.yellow(`$${(marketCap / 1_000_000).toFixed(0)}M`);
  } else if (marketCap >= 1_000_000) {
    return chalk.red(`$${(marketCap / 1_000_000).toFixed(1)}M`);
  }
  return chalk.red(`$${(marketCap / 1_000).toFixed(0)}K`);
}

/**
 * Format timeframe badge
 */
function formatTimeframe(tf: Timeframe): string {
  const colors: Record<Timeframe, (s: string) => string> = {
    '1m': chalk.gray,
    '5m': chalk.cyan,
    '15m': chalk.blue,
    '1h': chalk.magenta,
    '4h': chalk.yellow,
    '1d': chalk.red,
  };
  return colors[tf]?.(tf) || tf;
}

/**
 * Format market type (Spot/Futures)
 */
function formatMarketType(marketType: MarketType): string {
  if (marketType === 'futures') {
    return chalk.bgMagenta.white.bold(' F ');
  }
  return chalk.bgBlue.white(' S ');
}

/**
 * Format liquidity risk
 */
function formatLiquidityRisk(risk: LiquidityRisk): string {
  switch (risk) {
    case 'low':
      return chalk.green('●'); // Safe
    case 'medium':
      return chalk.yellow('◐'); // Moderate
    case 'high':
      return chalk.bgRed.white.bold(' ! '); // Danger
    default:
      return chalk.gray('?');
  }
}

/**
 * Create the main display table for setups
 */
export function createSetupsTable(setups: BackburnerSetup[]): string {
  if (setups.length === 0) {
    return chalk.gray('\n  No active Backburner setups detected.\n');
  }

  // Sort by state priority and RSI
  const sorted = [...setups].sort((a, b) => {
    const statePriority: Record<SetupState, number> = {
      deep_extreme: 0,
      triggered: 1,
      reversing: 2,
      watching: 3,
      played_out: 4,
    };
    if (statePriority[a.state] !== statePriority[b.state]) {
      return statePriority[a.state] - statePriority[b.state];
    }
    // For longs, lower RSI is more interesting; for shorts, higher RSI
    if (a.direction === 'long' && b.direction === 'long') {
      return a.currentRSI - b.currentRSI;
    }
    if (a.direction === 'short' && b.direction === 'short') {
      return b.currentRSI - a.currentRSI;
    }
    // Group longs before shorts
    return a.direction === 'long' ? -1 : 1;
  });

  const table = new Table({
    head: [
      chalk.white.bold('Mkt'),
      chalk.white.bold('Ticker'),
      chalk.white.bold('Name'),
      chalk.white.bold('Dir'),
      chalk.white.bold('MCap'),
      chalk.white.bold('Liq'),
      chalk.white.bold('TF'),
      chalk.white.bold('State'),
      chalk.white.bold('RSI'),
      chalk.white.bold('Impulse'),
      chalk.white.bold('Ago'),
    ],
    style: {
      head: [],
      border: ['gray'],
    },
    colWidths: [5, 10, 18, 9, 9, 5, 5, 16, 7, 9, 8],
  });

  for (const setup of sorted) {
    const ticker = setup.symbol.replace('USDT', '');
    table.push([
      formatMarketType(setup.marketType),
      chalk.cyan.bold(ticker),
      formatSymbol(setup.symbol, setup.coinName, setup.qualityTier),
      formatDirection(setup.direction),
      formatMarketCap(setup.marketCap),
      formatLiquidityRisk(setup.liquidityRisk),
      formatTimeframe(setup.timeframe),
      formatState(setup.state),
      formatRSI(setup.currentRSI),
      formatPercent(setup.impulsePercentMove),
      timeAgo(setup.detectedAt),
    ]);
  }

  return table.toString();
}

/**
 * Create a summary line
 */
export function createSummary(
  setups: BackburnerSetup[],
  eligibleSymbols: number,
  isScanning: boolean,
  statusMessage?: string
): string {
  const byState = {
    triggered: setups.filter(s => s.state === 'triggered').length,
    deep_extreme: setups.filter(s => s.state === 'deep_extreme').length,
    reversing: setups.filter(s => s.state === 'reversing').length,
  };

  const byDirection = {
    long: setups.filter(s => s.direction === 'long').length,
    short: setups.filter(s => s.direction === 'short').length,
  };

  const byTimeframe = {
    '5m': setups.filter(s => s.timeframe === '5m').length,
    '15m': setups.filter(s => s.timeframe === '15m').length,
    '1h': setups.filter(s => s.timeframe === '1h').length,
  };

  const byMarket = {
    spot: setups.filter(s => s.marketType === 'spot').length,
    futures: setups.filter(s => s.marketType === 'futures').length,
  };

  const statusIcon = isScanning ? chalk.green('●') : chalk.red('○');
  const timestamp = new Date().toLocaleTimeString();

  const lines = [
    '',
    `${statusIcon} ${chalk.bold('Backburner Screener')} | ${eligibleSymbols} symbols | ${setups.length} active setups`,
    chalk.gray(`  Last update: ${timestamp}${statusMessage ? ` | ${statusMessage}` : ''}`),
    '',
    chalk.gray(`  ${chalk.green('LONG')}: ${byDirection.long} | ${chalk.red('SHORT')}: ${byDirection.short} | ${chalk.blue('Spot')}: ${byMarket.spot} | ${chalk.magenta('Futures')}: ${byMarket.futures}`),
    chalk.gray(`  Triggered: ${byState.triggered} | Deep Extreme: ${byState.deep_extreme} | Reversing: ${byState.reversing}`),
    chalk.gray(`  5m: ${byTimeframe['5m']} | 15m: ${byTimeframe['15m']} | 1h: ${byTimeframe['1h']}`),
    '',
  ];

  return lines.join('\n');
}

/**
 * Create a notification for a new setup
 */
export function createSetupNotification(setup: BackburnerSetup, type: 'new' | 'updated' | 'removed'): string {
  const symbol = chalk.bold(setup.symbol.replace('USDT', ''));
  const tf = formatTimeframe(setup.timeframe);
  const rsi = formatRSI(setup.currentRSI);
  const dir = formatDirection(setup.direction);
  const mkt = formatMarketType(setup.marketType);
  const mcap = formatMarketCap(setup.marketCap);
  const liq = formatLiquidityRisk(setup.liquidityRisk);

  switch (type) {
    case 'new':
      return chalk.green(`\n✦ NEW: ${mkt} ${symbol} ${dir} ${tf} - RSI ${rsi} - MCap ${mcap} ${liq} - ${formatState(setup.state)}\n`);
    case 'updated':
      return chalk.yellow(`\n⟳ UPDATE: ${mkt} ${symbol} ${dir} ${tf} - RSI ${rsi} - ${formatState(setup.state)}\n`);
    case 'removed':
      return chalk.gray(`\n✗ REMOVED: ${mkt} ${symbol} ${dir} ${tf} - Setup played out\n`);
    default:
      return '';
  }
}

/**
 * Create the header banner
 */
export function createHeader(): string {
  return `
${chalk.cyan.bold('╔══════════════════════════════════════════════════════════════════════════╗')}
${chalk.cyan.bold('║')}  ${chalk.white.bold('BACKBURNER SCREENER')} - ${chalk.gray('TCG Strategy | MEXC Spot + Futures')}            ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╠══════════════════════════════════════════════════════════════════════════╣')}
${chalk.cyan.bold('║')}  ${chalk.green('LONG')}: ${chalk.gray('Impulse UP → RSI < 30 = Buy bounce')}                              ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.red('SHORT')}: ${chalk.gray('Impulse DOWN → RSI > 70 = Short fade')}                           ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.blue('[S]')}${chalk.gray('pot')} ${chalk.magenta('[F]')}${chalk.gray('utures | Liq:')} ${chalk.green('●')}${chalk.gray('safe')} ${chalk.yellow('◐')}${chalk.gray('mod')} ${chalk.red('!')}${chalk.gray('risk | TF: 5m 15m 1h')}             ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════════════════════════════════════════╝')}
`;
}

/**
 * Create progress bar for scanning
 */
export function createProgressBar(completed: number, total: number, phase: string): string {
  const percent = Math.floor((completed / total) * 100);
  const barLength = 40;
  const filled = Math.floor(barLength * (completed / total));
  const empty = barLength - filled;

  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

  return `\n  ${bar} ${percent}% | ${phase}\n`;
}

/**
 * Enter alternate screen buffer (like vim/htop - prevents scroll history spam)
 */
export function enterAltScreen(): void {
  process.stdout.write('\x1B[?1049h\x1B[H');
}

/**
 * Exit alternate screen buffer (restores previous terminal content)
 */
export function exitAltScreen(): void {
  process.stdout.write('\x1B[?1049l');
}

/**
 * Clear the terminal
 */
export function clearScreen(): void {
  // Clear screen and move to home position
  process.stdout.write('\x1B[2J\x1B[H');
}

/**
 * Move cursor to top of terminal and clear screen
 */
export function moveCursorToTop(): void {
  // Hide cursor, move to home, clear from cursor to end of screen
  process.stdout.write('\x1B[?25l\x1B[H\x1B[J');
}

/**
 * Show cursor (call on exit)
 */
export function showCursor(): void {
  process.stdout.write('\x1B[?25h');
}
