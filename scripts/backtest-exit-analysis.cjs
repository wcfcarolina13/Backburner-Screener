const fs = require('fs');
const path = require('path');

// Get files from last few days
const tradesDir = 'data/trades';
const files = fs.readdirSync(tradesDir)
  .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
  .sort()
  .slice(-5);

console.log('='.repeat(80));
console.log('EXIT REASON ANALYSIS: Where are we losing money?');
console.log('='.repeat(80));
console.log('');

const exitReasons = {};

for (const file of files) {
  const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file), 'utf-8'));

  for (const trade of trades) {
    if (trade.eventType !== 'close') continue;

    const reason = trade.closeReason || trade.exitReason || 'unknown';
    const pnl = trade.realizedPnL || 0;
    const leverage = trade.leverage || 10;

    // Normalize to 5x
    const normalizedPnl = pnl * (5 / leverage);

    if (!exitReasons[reason]) {
      exitReasons[reason] = { count: 0, pnl: 0, normalizedPnl: 0, wins: 0 };
    }
    exitReasons[reason].count++;
    exitReasons[reason].pnl += pnl;
    exitReasons[reason].normalizedPnl += normalizedPnl;
    if (pnl > 0) exitReasons[reason].wins++;
  }
}

console.log('Exit Reason                        | Trades | Win%  | Original PnL | 5x Normalized');
console.log('-'.repeat(80));

const sorted = Object.entries(exitReasons).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [reason, stats] of sorted) {
  const winRate = ((stats.wins / stats.count) * 100).toFixed(1);
  console.log(
    `${reason.padEnd(34)} |   ${String(stats.count).padStart(4)} | ${winRate.padStart(5)}% | ` +
    `$${stats.pnl.toFixed(2).padStart(11)} | $${stats.normalizedPnl.toFixed(2).padStart(12)}`
  );
}

console.log('');
console.log('='.repeat(80));
console.log('KEY PATTERNS:');
console.log('='.repeat(80));
console.log('');

// Analyze trailing vs initial stops
let trailingStopPnl = 0;
let trailingStopCount = 0;
let initialStopPnl = 0;
let initialStopCount = 0;
let otherPnl = 0;
let otherCount = 0;

for (const [reason, stats] of Object.entries(exitReasons)) {
  const lowerReason = reason.toLowerCase();
  if (lowerReason.includes('trailing') || lowerReason.includes('trail')) {
    trailingStopPnl += stats.normalizedPnl;
    trailingStopCount += stats.count;
  } else if (lowerReason.includes('initial') || lowerReason.includes('stop_loss') || lowerReason === 'stop_hit') {
    initialStopPnl += stats.normalizedPnl;
    initialStopCount += stats.count;
  } else {
    otherPnl += stats.normalizedPnl;
    otherCount += stats.count;
  }
}

console.log('Trailing Stops (5x):');
console.log('  Trades:', trailingStopCount);
console.log('  PnL:   $' + trailingStopPnl.toFixed(2));
console.log('  Avg:   $' + (trailingStopPnl / (trailingStopCount || 1)).toFixed(2) + '/trade');
console.log('');
console.log('Initial Stops (5x):');
console.log('  Trades:', initialStopCount);
console.log('  PnL:   $' + initialStopPnl.toFixed(2));
console.log('  Avg:   $' + (initialStopPnl / (initialStopCount || 1)).toFixed(2) + '/trade');
console.log('');
console.log('Other Exits (5x):');
console.log('  Trades:', otherCount);
console.log('  PnL:   $' + otherPnl.toFixed(2));
console.log('');

const totalNormalized = trailingStopPnl + initialStopPnl + otherPnl;
console.log('Total Normalized (5x): $' + totalNormalized.toFixed(2));
console.log('');
console.log('INSIGHT: Initial stops account for $' + (-initialStopPnl).toFixed(2) + ' of losses');
console.log('         If we FADED on initial stop trades, we would make that instead of lose it.');
