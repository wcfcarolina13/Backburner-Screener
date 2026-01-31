#!/usr/bin/env npx ts-node
/**
 * Analyze Bug Impact Over Last 72 Hours
 * ======================================
 *
 * Determines how much of the losses were potentially caused by the race condition bug
 * that marked positions as "closed" prematurely (within 2-10 seconds of execution).
 *
 * The bug caused:
 * 1. Positions to be removed from tracking too early
 * 2. Trailing stop management to not run
 * 3. Profit-tiered trailing to not activate
 * 4. Turso persistence to not happen
 *
 * Key commit: c287832 on Jan 30, 2026 at 3:51 PM (~23:51 UTC)
 */

interface MexcPosition {
  positionId: number;
  symbol: string;
  positionType: number; // 1 = long, 2 = short
  openAvgPrice: number;
  closeAvgPrice: number;
  realised: number;
  profitRatio: number;
  leverage: number;
  createTime: number;
  updateTime: number;
}

const BACKBURNER_URL = process.env.BACKBURNER_URL || 'https://backburner.onrender.com';

async function fetchAllPages(maxPages: number = 10): Promise<MexcPosition[]> {
  const allPositions: MexcPosition[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BACKBURNER_URL}/api/mexc/position-history?page=${page}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.positionHistory?.data || data.positionHistory.data.length === 0) {
      break;
    }

    allPositions.push(...data.positionHistory.data);

    if (data.positionHistory.data.length < 100) {
      break; // Last page
    }

    await new Promise(r => setTimeout(r, 200)); // Rate limit
  }

  return allPositions;
}

function formatPnL(pnl: number): string {
  return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

async function main() {
  console.log('=== MEXC Bug Impact Analysis ===\n');
  console.log('Fetching position history...\n');

  const positions = await fetchAllPages(10);
  console.log(`Total positions fetched: ${positions.length}\n`);

  // Define time boundaries
  const now = Date.now();
  const commitTime = new Date('2026-01-30T23:51:00Z').getTime(); // c287832 commit
  const h24Ago = now - (24 * 60 * 60 * 1000);
  const h48Ago = now - (48 * 60 * 60 * 1000);
  const h72Ago = now - (72 * 60 * 60 * 1000);

  console.log('Time boundaries:');
  console.log(`  Now:          ${new Date(now).toISOString()}`);
  console.log(`  Commit c287832: ${new Date(commitTime).toISOString()}`);
  console.log(`  24h ago:      ${new Date(h24Ago).toISOString()}`);
  console.log(`  48h ago:      ${new Date(h48Ago).toISOString()}`);
  console.log(`  72h ago:      ${new Date(h72Ago).toISOString()}`);
  console.log();

  // Filter to 72h window
  const recent = positions.filter(p => p.updateTime >= h72Ago);
  console.log(`Positions in 72h window: ${recent.length}\n`);

  // Categorize by time period
  const periods = [
    { name: 'Since commit (last ~18h)', start: commitTime, end: now },
    { name: 'Commit to 24h ago', start: h24Ago, end: commitTime },
    { name: '24-48h ago', start: h48Ago, end: h24Ago },
    { name: '48-72h ago', start: h72Ago, end: h48Ago },
  ];

  // Bug impact analysis
  // The bug caused positions to be marked "closed" within 2-10 seconds
  // If a position duration is very short (< 60 seconds) but had movement (PnL != ~0),
  // it was likely NOT managed properly by our system

  // Actually, the bug meant:
  // - Positions that SHOULD have been managed by trailing weren't
  // - We can identify potentially affected trades by looking at:
  //   1. Short duration trades that lost money (could have been saved by trailing)
  //   2. Trades that ran for hours unmanaged (like METIS/ETHFI/KAIA winners)
  //   3. Any trade that hit SL quickly after opening

  console.log('=== Period Analysis ===\n');

  for (const period of periods) {
    const periodTrades = recent.filter(p =>
      p.updateTime >= period.start && p.updateTime < period.end
    );

    if (periodTrades.length === 0) {
      console.log(`${period.name}: No trades\n`);
      continue;
    }

    const totalPnL = periodTrades.reduce((sum, p) => sum + p.realised, 0);
    const winners = periodTrades.filter(p => p.realised > 0);
    const losers = periodTrades.filter(p => p.realised < 0);

    console.log(`${period.name}:`);
    console.log(`  Trades: ${periodTrades.length}`);
    console.log(`  Total PnL: ${formatPnL(totalPnL)}`);
    console.log(`  Winners: ${winners.length} (${formatPnL(winners.reduce((s, p) => s + p.realised, 0))})`);
    console.log(`  Losers: ${losers.length} (${formatPnL(losers.reduce((s, p) => s + p.realised, 0))})`);

    // Analyze trade durations
    const durations = periodTrades.map(p => p.updateTime - p.createTime);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

    // Identify potentially bug-affected trades
    const quickLosses = losers.filter(p => {
      const duration = p.updateTime - p.createTime;
      return duration < 5 * 60 * 1000; // Less than 5 minutes
    });

    const quickLossPnL = quickLosses.reduce((sum, p) => sum + p.realised, 0);

    console.log(`  Avg duration: ${formatDuration(avgDuration)}`);
    console.log(`  Quick losses (<5min): ${quickLosses.length} trades, ${formatPnL(quickLossPnL)}`);

    // Long-running trades (could have been helped by trailing, or ran unmanaged)
    const longRunners = periodTrades.filter(p => {
      const duration = p.updateTime - p.createTime;
      return duration > 4 * 60 * 60 * 1000; // More than 4 hours
    });

    if (longRunners.length > 0) {
      const longRunnerPnL = longRunners.reduce((sum, p) => sum + p.realised, 0);
      console.log(`  Long runners (>4h): ${longRunners.length} trades, ${formatPnL(longRunnerPnL)}`);

      // These long runners likely ran "unmanaged" due to the bug
      console.log('    Unmanaged long runners:');
      for (const trade of longRunners.slice(0, 5)) {
        const duration = trade.updateTime - trade.createTime;
        const direction = trade.positionType === 1 ? 'LONG' : 'SHORT';
        const roePct = (trade.profitRatio * 100).toFixed(1);
        console.log(`      ${trade.symbol.replace('_USDT', '')} ${direction}: ${formatPnL(trade.realised)} (${roePct}% ROE, ${formatDuration(duration)})`);
      }
    }

    console.log();
  }

  // Overall bug impact estimate
  console.log('=== Bug Impact Estimate ===\n');

  // The bug primarily affected:
  // 1. Quick SL hits that could have been avoided with proper trailing
  // 2. Trades that ran unmanaged and may have performed better/worse with management

  const allQuickLosses = recent.filter(p => {
    const duration = p.updateTime - p.createTime;
    return p.realised < 0 && duration < 5 * 60 * 1000;
  });

  const allLongRunners = recent.filter(p => {
    const duration = p.updateTime - p.createTime;
    return duration > 4 * 60 * 60 * 1000;
  });

  console.log('Quick losses (<5min) - potentially affected by missing trailing:');
  console.log(`  Count: ${allQuickLosses.length}`);
  console.log(`  Total loss: ${formatPnL(allQuickLosses.reduce((s, p) => s + p.realised, 0))}`);
  console.log();

  console.log('Long runners (>4h) - likely ran unmanaged:');
  console.log(`  Count: ${allLongRunners.length}`);
  console.log(`  Total PnL: ${formatPnL(allLongRunners.reduce((s, p) => s + p.realised, 0))}`);

  const unmanagedWinners = allLongRunners.filter(p => p.realised > 0);
  const unmanagedLosers = allLongRunners.filter(p => p.realised < 0);
  console.log(`  Winners: ${unmanagedWinners.length} (${formatPnL(unmanagedWinners.reduce((s, p) => s + p.realised, 0))})`);
  console.log(`  Losers: ${unmanagedLosers.length} (${formatPnL(unmanagedLosers.reduce((s, p) => s + p.realised, 0))})`);
  console.log();

  // Worst 10 losses
  console.log('Top 10 Losses (all time periods):');
  const sortedLosses = recent.filter(p => p.realised < 0).sort((a, b) => a.realised - b.realised);
  for (const trade of sortedLosses.slice(0, 10)) {
    const duration = trade.updateTime - trade.createTime;
    const direction = trade.positionType === 1 ? 'LONG' : 'SHORT';
    const time = new Date(trade.updateTime).toISOString().slice(0, 16).replace('T', ' ');
    const roePct = (trade.profitRatio * 100).toFixed(1);
    const bugImpact = duration < 5 * 60 * 1000 ? '⚠️ QUICK' : duration > 4 * 60 * 60 * 1000 ? '🔄 UNMANAGED' : '';
    console.log(`  ${trade.symbol.replace('_USDT', '').padEnd(10)} ${direction.padEnd(5)} ${formatPnL(trade.realised).padStart(8)} (${roePct}% ROE, ${formatDuration(duration).padStart(8)}) ${bugImpact}`);
  }
  console.log();

  // Top 10 wins
  console.log('Top 10 Wins (all time periods):');
  const sortedWins = recent.filter(p => p.realised > 0).sort((a, b) => b.realised - a.realised);
  for (const trade of sortedWins.slice(0, 10)) {
    const duration = trade.updateTime - trade.createTime;
    const direction = trade.positionType === 1 ? 'LONG' : 'SHORT';
    const time = new Date(trade.updateTime).toISOString().slice(0, 16).replace('T', ' ');
    const roePct = (trade.profitRatio * 100).toFixed(1);
    const bugImpact = duration > 4 * 60 * 60 * 1000 ? '🔄 UNMANAGED' : '';
    console.log(`  ${trade.symbol.replace('_USDT', '').padEnd(10)} ${direction.padEnd(5)} ${formatPnL(trade.realised).padStart(8)} (${roePct}% ROE, ${formatDuration(duration).padStart(8)}) ${bugImpact}`);
  }
  console.log();

  // Summary
  const totalPnL = recent.reduce((sum, p) => sum + p.realised, 0);
  console.log('=== Summary ===');
  console.log(`Total 72h PnL: ${formatPnL(totalPnL)}`);
  console.log(`Quick loss impact: ${formatPnL(allQuickLosses.reduce((s, p) => s + p.realised, 0))}`);
  console.log(`Unmanaged runner impact: ${formatPnL(allLongRunners.reduce((s, p) => s + p.realised, 0))}`);
  console.log();
  console.log('Note: "Quick losses" could have potentially been saved by proper trailing.');
  console.log('      "Unmanaged" trades ran without trailing stop management due to the bug.');
  console.log('      The big winners (METIS, ETHFI, KAIA) likely won BECAUSE they were unmanaged');
  console.log('      and allowed to run longer than our trailing rules would normally allow.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
