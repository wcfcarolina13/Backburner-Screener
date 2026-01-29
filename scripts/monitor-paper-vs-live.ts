#!/usr/bin/env npx tsx
/**
 * Monitor Paper Bot vs Live MEXC Positions
 *
 * Compares exp-bb-sysB paper positions with actual MEXC positions
 * to identify any discrepancies in real-time.
 *
 * Usage: npx tsx scripts/monitor-paper-vs-live.ts [--interval 5]
 */

import { MexcFuturesClient } from '../src/mexc-futures-client.js';

const SERVER_URL = process.env.SERVER_URL || 'https://backburner.onrender.com';
const REFRESH_INTERVAL = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '5') * 1000;

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function formatPnl(pnl: number): string {
  const formatted = pnl.toFixed(2);
  if (pnl > 0) return `${colors.green}+$${formatted}${colors.reset}`;
  if (pnl < 0) return `${colors.red}-$${Math.abs(pnl).toFixed(2)}${colors.reset}`;
  return `$${formatted}`;
}

function formatPercent(pct: number): string {
  const formatted = pct.toFixed(2);
  if (pct > 0) return `${colors.green}+${formatted}%${colors.reset}`;
  if (pct < 0) return `${colors.red}${formatted}%${colors.reset}`;
  return `${formatted}%`;
}

interface PaperPosition {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  stopLoss?: number;
  trailActivated?: boolean;
  highestPnlPercent?: number;
}

interface MexcPosition {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  leverage: number;
  holdVol: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  currentStopPrice?: number;
  trailActivated?: boolean;
  highestRoePct?: number;
  managed?: boolean;
  currentPrice?: number;
}

async function fetchPaperState(): Promise<{ positions: PaperPosition[]; balance: number; pnl: number; unrealizedPnl: number } | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/state`);
    if (!res.ok) return null;

    const state = await res.json();
    const expBots = state.experimentalBots || {};
    const sysB = expBots['exp-bb-sysB'];

    if (!sysB) return null;

    // Paper bot uses 'openPositions' array, not 'positions' object
    const rawPositions = sysB.openPositions || [];
    const positions: PaperPosition[] = rawPositions.map((p: any) => ({
      symbol: p.symbol,
      direction: p.direction,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl || 0,
      unrealizedPnlPercent: p.unrealizedPnlPercent || 0,
      leverage: p.leverage || 20,
      stopLoss: p.stopLoss,
      trailActivated: p.trailActivated,
      highestPnlPercent: p.highestPnlPercent,
    }));

    // Calculate stats from closedPositions for PnL
    const stats = sysB.stats || {};
    const totalPnL = (stats.wins || 0) * (stats.avgWin || 0) - (stats.losses || 0) * Math.abs(stats.avgLoss || 0);

    return {
      positions,
      balance: sysB.balance || 0,
      pnl: totalPnL,
      unrealizedPnl: sysB.unrealizedPnl || 0,
    };
  } catch (error) {
    console.error('Failed to fetch paper state:', error);
    return null;
  }
}

async function fetchMexcState(): Promise<{ positions: MexcPosition[]; balance: number; available: number; unrealized: number } | null> {
  try {
    // Fetch positions
    const posRes = await fetch(`${SERVER_URL}/api/mexc/positions`);
    if (!posRes.ok) return null;
    const posData = await posRes.json();

    // Fetch balance
    const balRes = await fetch(`${SERVER_URL}/api/mexc/balance`);
    if (!balRes.ok) return null;
    const balData = await balRes.json();

    if (!posData.success) return null;

    // Fetch current prices for calculating ROE
    const priceRes = await fetch(`${SERVER_URL}/api/state`);
    const priceState = priceRes.ok ? await priceRes.json() : null;

    const positions: MexcPosition[] = (posData.positions || []).map((p: any) => {
      // Get current price from paper state if available
      const paperPositions = priceState?.experimentalBots?.['exp-bb-sysB']?.openPositions || [];
      const matchingPaper = paperPositions.find((pp: any) =>
        pp.symbol.replace('USDT', '') === p.symbol.replace('_USDT', '').replace('USDT', '')
      );
      const currentPrice = matchingPaper?.currentPrice || p.entryPrice;

      // Calculate ROE% properly: (currentPrice - entryPrice) / entryPrice * leverage * 100
      const priceDelta = p.side === 'long'
        ? (currentPrice - p.entryPrice) / p.entryPrice
        : (p.entryPrice - currentPrice) / p.entryPrice;
      const unrealizedPnlPercent = priceDelta * (p.leverage || 10) * 100;

      // Calculate unrealized PnL in dollars
      const notionalValue = p.size * p.entryPrice;
      const margin = notionalValue / (p.leverage || 10);
      const unrealizedPnl = p.unrealized !== undefined ? p.unrealized : (margin * unrealizedPnlPercent / 100);

      return {
        symbol: p.symbol?.replace('_', '') || p.symbol,
        direction: p.side || (p.positionType === 1 ? 'long' : 'short'),
        entryPrice: p.entryPrice || p.holdAvgPrice || p.openAvgPrice,
        leverage: p.leverage || 10,
        holdVol: p.size || p.holdVol,
        unrealizedPnl: unrealizedPnl,
        unrealizedPnlPercent: unrealizedPnlPercent,
        currentStopPrice: p.currentStopPrice,
        trailActivated: p.trailActivated,
        highestRoePct: p.highestRoePct,
        managed: p.managed,
        currentPrice: currentPrice,
      };
    });

    return {
      positions,
      balance: balData.equity || balData.balance || 0,
      available: balData.available || 0,
      unrealized: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  } catch (error) {
    console.error('Failed to fetch MEXC state:', error);
    return null;
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace('_', '').replace('USDT', '').toUpperCase();
}

function comparePositions(paper: PaperPosition[], mexc: MexcPosition[]): {
  matched: { paper: PaperPosition; mexc: MexcPosition }[];
  paperOnly: PaperPosition[];
  mexcOnly: MexcPosition[];
} {
  const paperMap = new Map<string, PaperPosition>();
  const mexcMap = new Map<string, MexcPosition>();

  for (const p of paper) {
    const key = `${normalizeSymbol(p.symbol)}-${p.direction}`;
    paperMap.set(key, p);
  }

  for (const m of mexc) {
    const key = `${normalizeSymbol(m.symbol)}-${m.direction}`;
    mexcMap.set(key, m);
  }

  const matched: { paper: PaperPosition; mexc: MexcPosition }[] = [];
  const paperOnly: PaperPosition[] = [];
  const mexcOnly: MexcPosition[] = [];

  for (const [key, p] of paperMap) {
    const m = mexcMap.get(key);
    if (m) {
      matched.push({ paper: p, mexc: m });
      mexcMap.delete(key);
    } else {
      paperOnly.push(p);
    }
  }

  for (const m of mexcMap.values()) {
    mexcOnly.push(m);
  }

  return { matched, paperOnly, mexcOnly };
}

async function displayComparison() {
  const [paper, mexc] = await Promise.all([
    fetchPaperState(),
    fetchMexcState(),
  ]);

  clearScreen();

  const now = new Date().toLocaleTimeString();
  console.log(`${colors.bright}═══════════════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}  PAPER vs LIVE MEXC POSITION MONITOR${colors.reset}  │  ${colors.dim}${now}${colors.reset}  │  ${colors.dim}Refresh: ${REFRESH_INTERVAL/1000}s${colors.reset}`);
  console.log(`${colors.bright}═══════════════════════════════════════════════════════════════════════════════${colors.reset}\n`);

  // Summary boxes
  console.log(`${colors.cyan}┌─────────────────────────────────┬─────────────────────────────────┐${colors.reset}`);
  console.log(`${colors.cyan}│${colors.reset}  ${colors.bright}PAPER (exp-bb-sysB)${colors.reset}             ${colors.cyan}│${colors.reset}  ${colors.bright}LIVE MEXC${colors.reset}                       ${colors.cyan}│${colors.reset}`);
  console.log(`${colors.cyan}├─────────────────────────────────┼─────────────────────────────────┤${colors.reset}`);

  if (paper) {
    console.log(`${colors.cyan}│${colors.reset}  Balance: $${paper.balance.toFixed(2).padEnd(18)} ${colors.cyan}│${colors.reset}  Balance: $${(mexc?.balance || 0).toFixed(2).padEnd(18)} ${colors.cyan}│${colors.reset}`);
    console.log(`${colors.cyan}│${colors.reset}  PnL: ${formatPnl(paper.pnl).padEnd(24)} ${colors.cyan}│${colors.reset}  Available: $${(mexc?.available || 0).toFixed(2).padEnd(16)} ${colors.cyan}│${colors.reset}`);
    console.log(`${colors.cyan}│${colors.reset}  Unrealized: ${formatPnl(paper.unrealizedPnl).padEnd(17)} ${colors.cyan}│${colors.reset}  Unrealized: ${formatPnl(mexc?.unrealized || 0).padEnd(17)} ${colors.cyan}│${colors.reset}`);
    console.log(`${colors.cyan}│${colors.reset}  Positions: ${paper.positions.length.toString().padEnd(18)} ${colors.cyan}│${colors.reset}  Positions: ${(mexc?.positions.length || 0).toString().padEnd(18)} ${colors.cyan}│${colors.reset}`);
  } else {
    console.log(`${colors.cyan}│${colors.reset}  ${colors.red}Failed to fetch paper state${colors.reset}     ${colors.cyan}│${colors.reset}  ${mexc ? `Balance: $${mexc.balance.toFixed(2)}` : colors.red + 'Failed to fetch MEXC' + colors.reset}${colors.reset}`.padEnd(70) + `${colors.cyan}│${colors.reset}`);
  }

  console.log(`${colors.cyan}└─────────────────────────────────┴─────────────────────────────────┘${colors.reset}\n`);

  if (!paper || !mexc) {
    console.log(`${colors.yellow}Waiting for data...${colors.reset}`);
    return;
  }

  const { matched, paperOnly, mexcOnly } = comparePositions(paper.positions, mexc.positions);

  // Matched positions comparison
  if (matched.length > 0) {
    console.log(`${colors.bright}MATCHED POSITIONS (${matched.length})${colors.reset}`);
    console.log(`${'Symbol'.padEnd(12)} ${'Dir'.padEnd(6)} ${'P.Lev'.padEnd(6)} ${'M.Lev'.padEnd(6)} ${'Paper Entry'.padEnd(12)} ${'MEXC Entry'.padEnd(12)} ${'Entry Δ'.padEnd(10)} ${'Paper ROE%'.padEnd(12)} ${'MEXC ROE%'.padEnd(12)}`);
    console.log(`${colors.dim}${'─'.repeat(105)}${colors.reset}`);

    for (const { paper: p, mexc: m } of matched.sort((a, b) => normalizeSymbol(a.paper.symbol).localeCompare(normalizeSymbol(b.paper.symbol)))) {
      const entryDiff = ((m.entryPrice - p.entryPrice) / p.entryPrice * 100);
      const entryDiffStr = Math.abs(entryDiff) < 0.01 ? colors.green + '≈' + colors.reset :
                          (entryDiff > 0 ? colors.yellow + '+' : colors.yellow) + entryDiff.toFixed(2) + '%' + colors.reset;

      // Highlight leverage mismatch
      const paperLev = `${p.leverage}x`;
      const mexcLev = `${m.leverage}x`;
      const levMatch = p.leverage === m.leverage;
      const paperLevStr = levMatch ? paperLev : colors.yellow + paperLev + colors.reset;
      const mexcLevStr = levMatch ? mexcLev : colors.yellow + mexcLev + colors.reset;

      console.log(
        `${normalizeSymbol(p.symbol).padEnd(12)} ` +
        `${p.direction.padEnd(6)} ` +
        `${paperLevStr.padEnd(levMatch ? 6 : 15)} ` +
        `${mexcLevStr.padEnd(levMatch ? 6 : 15)} ` +
        `${p.entryPrice.toFixed(6).padEnd(12)} ` +
        `${m.entryPrice.toFixed(6).padEnd(12)} ` +
        `${entryDiffStr.padEnd(19)} ` +
        `${formatPercent(p.unrealizedPnlPercent).padEnd(21)} ` +
        `${formatPercent(m.unrealizedPnlPercent)}`
      );
    }
    console.log('');
  }

  // Discrepancies
  if (paperOnly.length > 0 || mexcOnly.length > 0) {
    console.log(`${colors.bgYellow}${colors.bright} ⚠️  DISCREPANCIES DETECTED ${colors.reset}\n`);

    if (paperOnly.length > 0) {
      console.log(`${colors.yellow}Paper positions NOT on MEXC (${paperOnly.length}):${colors.reset}`);
      for (const p of paperOnly) {
        console.log(`  ${colors.yellow}▸${colors.reset} ${normalizeSymbol(p.symbol)} ${p.direction} @ ${p.entryPrice.toFixed(6)} (${formatPercent(p.unrealizedPnlPercent)})`);
      }
      console.log('');
    }

    if (mexcOnly.length > 0) {
      console.log(`${colors.magenta}MEXC positions NOT in paper (${mexcOnly.length}):${colors.reset}`);
      for (const m of mexcOnly) {
        const entryStr = m.entryPrice ? m.entryPrice.toFixed(6) : 'N/A';
        const pnlStr = typeof m.unrealizedPnlPercent === 'number' ? formatPercent(m.unrealizedPnlPercent) : 'N/A';
        const stopStr = m.currentStopPrice ? `SL: ${m.currentStopPrice.toFixed(6)}` : '';
        const trailStr = m.trailActivated ? `${colors.green}TRAIL${colors.reset}` : '';
        console.log(`  ${colors.magenta}▸${colors.reset} ${normalizeSymbol(m.symbol)} ${m.direction} @ ${entryStr} (${pnlStr}) ${stopStr} ${trailStr}`);
      }
      console.log('');
    }
  } else if (matched.length > 0) {
    console.log(`${colors.bgGreen}${colors.bright} ✓ ALL POSITIONS MATCHED ${colors.reset}\n`);
  }

  // Footer
  console.log(`${colors.dim}Press Ctrl+C to exit${colors.reset}`);
}

async function main() {
  console.log('Starting Paper vs MEXC monitor...');
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Refresh interval: ${REFRESH_INTERVAL/1000}s\n`);

  // Initial display
  await displayComparison();

  // Refresh loop
  setInterval(async () => {
    await displayComparison();
  }, REFRESH_INTERVAL);
}

main().catch(console.error);
