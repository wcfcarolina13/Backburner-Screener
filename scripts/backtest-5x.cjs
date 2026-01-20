const fs = require('fs');

// Load yesterday's trades
const trades = JSON.parse(fs.readFileSync('data/trades/2026-01-18.json', 'utf-8'));

// Group trades by position ID to pair opens with closes
const positions = new Map();

for (const trade of trades) {
  const key = trade.positionId + '-' + trade.botId;

  if (trade.eventType === 'open') {
    positions.set(key, {
      open: trade,
      close: null
    });
  } else if (trade.eventType === 'close') {
    if (positions.has(key)) {
      positions.get(key).close = trade;
    }
  }
}

// Calculate stats for original leverage vs 5x leverage
let originalPnL = 0;
let normalizedPnL = 0;
let tradeCount = 0;
let winCount = 0;
let lossCount = 0;

const botStats = {};

for (const [key, pos] of positions) {
  if (!pos.open || !pos.close) continue;

  const { open, close } = pos;
  const originalLeverage = open.leverage || 10;
  const originalMargin = open.marginUsed;
  const pnl = close.realizedPnL || 0;

  // Calculate what margin would have been at 5x
  const notional = open.notionalSize;
  const newMargin = notional / 5; // 5x leverage

  // Calculate price move percentage
  const priceMove = open.direction === 'long'
    ? (close.exitPrice - open.entryPrice) / open.entryPrice
    : (open.entryPrice - close.exitPrice) / open.entryPrice;

  // PnL at 5x = priceMove * notional (notional stays same, just margin changes)
  // But we need to scale down the position size too if we want same risk
  // Let's calculate two scenarios:

  // Scenario 1: Same notional (5x leverage = more margin required)
  const pnlSameNotional = priceMove * notional;

  // Scenario 2: Same margin (5x leverage = smaller notional = smaller PnL)
  const newNotional = originalMargin * 5; // Same margin, 5x leverage
  const pnlSameMargin = priceMove * newNotional;

  // We'll use Scenario 2 (same margin, reduced notional)
  // This represents what would happen if you just changed leverage but kept same position size %
  const scaleFactor = 5 / originalLeverage;
  const normalizedPnlForTrade = pnl * scaleFactor;

  originalPnL += pnl;
  normalizedPnL += normalizedPnlForTrade;
  tradeCount++;

  if (pnl > 0) winCount++;
  else lossCount++;

  // Track by bot
  const botId = open.botId;
  if (!botStats[botId]) {
    botStats[botId] = { originalPnL: 0, normalizedPnL: 0, trades: 0, wins: 0, leverage: originalLeverage };
  }
  botStats[botId].originalPnL += pnl;
  botStats[botId].normalizedPnL += normalizedPnlForTrade;
  botStats[botId].trades++;
  if (pnl > 0) botStats[botId].wins++;
}

console.log('='.repeat(70));
console.log('BACKTEST: Jan 18 2026 Trades with 5x Leverage Normalization');
console.log('='.repeat(70));
console.log('');
console.log('Overall Stats:');
console.log('  Closed Trades:', tradeCount);
console.log('  Win Rate:', ((winCount / tradeCount) * 100).toFixed(1) + '%');
console.log('');
console.log('  Original PnL (actual leverage):   $' + originalPnL.toFixed(2));
console.log('  Normalized PnL (all at 5x):       $' + normalizedPnL.toFixed(2));
console.log('  Difference:                       $' + (normalizedPnL - originalPnL).toFixed(2));
console.log('');
console.log('-'.repeat(70));
console.log('By Bot:');
console.log('-'.repeat(70));

const sortedBots = Object.entries(botStats).sort((a, b) => b[1].originalPnL - a[1].originalPnL);
for (const [botId, stats] of sortedBots) {
  const scaleFactor = (5 / stats.leverage).toFixed(2);
  console.log(`  ${botId.padEnd(20)} | ${stats.leverage}x -> 5x (scale: ${scaleFactor}x)`);
  console.log(`    Original: $${stats.originalPnL.toFixed(2).padStart(10)} | Normalized: $${stats.normalizedPnL.toFixed(2).padStart(10)} | Trades: ${stats.trades} | WR: ${((stats.wins/stats.trades)*100).toFixed(0)}%`);
}

// Now show what the FADE strategy would have done
console.log('');
console.log('='.repeat(70));
console.log('FADE BACKTEST: What if we took OPPOSITE direction?');
console.log('='.repeat(70));

let fadePnL = 0;
let fadeWins = 0;
let fadeLosses = 0;
let fadeCount = 0;

for (const [key, pos] of positions) {
  if (!pos.open || !pos.close) continue;

  const { open, close } = pos;
  const pnl = close.realizedPnL || 0;

  // FADE = opposite direction, so flip the PnL sign
  // (This is a simplification - in reality stop levels would be different)
  const fadePnlForTrade = -pnl;

  // Scale to 5x leverage
  const originalLeverage = open.leverage || 10;
  const scaleFactor = 5 / originalLeverage;
  const fadePnlNormalized = fadePnlForTrade * scaleFactor;

  fadePnL += fadePnlNormalized;
  fadeCount++;
  if (fadePnlNormalized > 0) fadeWins++;
  else fadeLosses++;
}

console.log('');
console.log('Fade Strategy (opposite direction, 5x leverage):');
console.log('  Total Trades:', fadeCount);
console.log('  Win Rate:', ((fadeWins / fadeCount) * 100).toFixed(1) + '%');
console.log('  Total PnL: $' + fadePnL.toFixed(2));
console.log('');
console.log('Comparison:');
console.log('  Original (5x normalized): $' + normalizedPnL.toFixed(2));
console.log('  Fade (5x):                $' + fadePnL.toFixed(2));
console.log('  Fade Advantage:           $' + (fadePnL - normalizedPnL).toFixed(2));
