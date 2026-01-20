const fs = require('fs');
const path = require('path');

// Get files from last few days
const tradesDir = 'data/trades';
const files = fs.readdirSync(tradesDir)
  .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))  // Only main files, not -all
  .sort()
  .slice(-5);  // Last 5 days

console.log('='.repeat(80));
console.log('MULTI-DAY BACKTEST: 5x Leverage Normalization + Fade Analysis');
console.log('='.repeat(80));
console.log('');
console.log('Files analyzed:', files.join(', '));
console.log('');

let totalOriginal = 0;
let totalNormalized = 0;
let totalFade = 0;
let totalTrades = 0;
let totalWins = 0;

const dailyStats = [];

for (const file of files) {
  const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file), 'utf-8'));

  // Group trades by position ID to pair opens with closes
  const positions = new Map();

  for (const trade of trades) {
    const key = trade.positionId + '-' + trade.botId;

    if (trade.eventType === 'open') {
      positions.set(key, { open: trade, close: null });
    } else if (trade.eventType === 'close') {
      if (positions.has(key)) {
        positions.get(key).close = trade;
      }
    }
  }

  let dayOriginal = 0;
  let dayNormalized = 0;
  let dayFade = 0;
  let dayTrades = 0;
  let dayWins = 0;

  for (const [key, pos] of positions) {
    if (!pos.open || !pos.close) continue;

    const { open, close } = pos;
    const originalLeverage = open.leverage || 10;
    const pnl = close.realizedPnL || 0;

    const scaleFactor = 5 / originalLeverage;
    const normalizedPnl = pnl * scaleFactor;
    const fadePnl = -normalizedPnl;  // Opposite direction

    dayOriginal += pnl;
    dayNormalized += normalizedPnl;
    dayFade += fadePnl;
    dayTrades++;
    if (pnl > 0) dayWins++;
  }

  totalOriginal += dayOriginal;
  totalNormalized += dayNormalized;
  totalFade += dayFade;
  totalTrades += dayTrades;
  totalWins += dayWins;

  dailyStats.push({
    date: file.replace('.json', ''),
    trades: dayTrades,
    winRate: dayTrades > 0 ? ((dayWins / dayTrades) * 100).toFixed(1) : '0.0',
    original: dayOriginal,
    normalized: dayNormalized,
    fade: dayFade
  });
}

// Print daily breakdown
console.log('-'.repeat(80));
console.log('Daily Breakdown:');
console.log('-'.repeat(80));
console.log('Date        | Trades | Win%  | Original PnL | 5x Normalized | Fade (5x)');
console.log('-'.repeat(80));

for (const day of dailyStats) {
  console.log(
    `${day.date} |   ${String(day.trades).padStart(4)} | ${day.winRate.padStart(5)}% | ` +
    `$${day.original.toFixed(2).padStart(11)} | $${day.normalized.toFixed(2).padStart(12)} | $${day.fade.toFixed(2).padStart(10)}`
  );
}

console.log('-'.repeat(80));
console.log(
  `TOTAL       |   ${String(totalTrades).padStart(4)} | ${((totalWins/totalTrades)*100).toFixed(1).padStart(5)}% | ` +
  `$${totalOriginal.toFixed(2).padStart(11)} | $${totalNormalized.toFixed(2).padStart(12)} | $${totalFade.toFixed(2).padStart(10)}`
);
console.log('');

console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log('');
console.log('  Total Trades:              ', totalTrades);
console.log('  Overall Win Rate:          ', ((totalWins/totalTrades)*100).toFixed(1) + '%');
console.log('');
console.log('  Original PnL (mixed lev):  $' + totalOriginal.toFixed(2));
console.log('  Normalized PnL (5x):       $' + totalNormalized.toFixed(2));
console.log('  Fade Strategy PnL (5x):    $' + totalFade.toFixed(2));
console.log('');
console.log('  5x Leverage Saved:         $' + (totalNormalized - totalOriginal).toFixed(2) + ' (smaller losses)');
console.log('  Fade Advantage:            $' + (totalFade - totalNormalized).toFixed(2));
console.log('');

// Calculate what would happen with BOTH changes (5x leverage + fade)
console.log('KEY INSIGHT:');
console.log('  If we had used 5x leverage + fade strategy:');
console.log('  Instead of losing $' + (-totalOriginal).toFixed(2) + ', we would have made $' + totalFade.toFixed(2));
console.log('  Total swing: $' + (totalFade - totalOriginal).toFixed(2));
