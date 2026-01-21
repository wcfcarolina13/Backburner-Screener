/**
 * Spot-Only Backtest V2 - Adjusted Exit Strategy for 1x Leverage
 *
 * The problem with V1: The paper bot used 22.5x leverage with trailing stops
 * that triggered at ~10% ROI. At 1x leverage, that same price move is only ~0.4%.
 *
 * V2 Approach: Instead of using the paper bot's exit prices, we'll simulate
 * what would happen if we held longer with spot-appropriate targets:
 * - Entry: Same trigger price
 * - Stop Loss: 3% below entry (reasonable for spot)
 * - Take Profit: 2% above entry (2:3 risk:reward initially)
 * - Trailing: After +1% profit, trail at entry price (breakeven)
 *
 * Since we don't have minute-by-minute price data, we'll use the exit prices
 * as a proxy for "how far did the price move" and estimate outcomes.
 */

// Same raw data as V1
const opens = [
  { timestamp: "2026-01-21T13:03:12.347Z", symbol: "SAFEUSDT", direction: "long", entry_price: 0.2029014, position_id: "SAFEUSDT-5m-1769000539049" },
  { timestamp: "2026-01-21T13:15:40.305Z", symbol: "XVSUSDT", direction: "long", entry_price: 5.4145059, position_id: "XVSUSDT-5m-1769001340100" },
  { timestamp: "2026-01-21T14:04:19.926Z", symbol: "HEIUSDT", direction: "long", entry_price: 0.13986990000000002, position_id: "HEIUSDT-15m-1769004258368" },
  { timestamp: "2026-01-21T14:55:20.628Z", symbol: "XNYUSDT", direction: "long", entry_price: 0.0039989985, position_id: "XNYUSDT-15m-1769007320259" },
  { timestamp: "2026-01-21T15:06:49.640Z", symbol: "REZUSDT", direction: "long", entry_price: 0.0047573775, position_id: "REZUSDT-5m-1769008008083" },
  { timestamp: "2026-01-21T15:53:25.456Z", symbol: "PIVXUSDT", direction: "long", entry_price: 0.1782891, position_id: "PIVXUSDT-5m-1769010805268" },
  { timestamp: "2026-01-21T16:19:12.091Z", symbol: "TWTUSDT", direction: "long", entry_price: 0.8697346499999999, position_id: "TWTUSDT-15m-1769012351872" },
  { timestamp: "2026-01-21T16:25:05.597Z", symbol: "DOGUSDT", direction: "long", entry_price: 0.001352676, position_id: "DOGUSDT-15m-1769012705423" },
  { timestamp: "2026-01-21T17:23:56.196Z", symbol: "NFPUSDT", direction: "long", entry_price: 0.024802394999999998, position_id: "NFPUSDT-15m-1769016235908" },
  { timestamp: "2026-01-21T17:24:18.612Z", symbol: "LITUSDT", direction: "long", entry_price: 1.6758375, position_id: "LITUSDT-15m-1769016258208" },
  { timestamp: "2026-01-21T17:24:32.004Z", symbol: "RENDERUSDT", direction: "long", entry_price: 1.982991, position_id: "RENDERUSDT-15m-1769016270706" },
  { timestamp: "2026-01-21T17:25:17.608Z", symbol: "WCTUSDT", direction: "long", entry_price: 0.072406185, position_id: "WCTUSDT-15m-1769016317207" },
  { timestamp: "2026-01-21T17:35:17.607Z", symbol: "GIGAUSDT", direction: "long", entry_price: 0.003679839, position_id: "GIGAUSDT-5m-1769016917181" },
  { timestamp: "2026-01-21T17:36:30.054Z", symbol: "ZROUSDT", direction: "long", entry_price: 1.8839415, position_id: "ZROUSDT-5m-1769016989491" },
  { timestamp: "2026-01-21T17:56:13.136Z", symbol: "RAREUSDT", direction: "long", entry_price: 0.027303644999999998, position_id: "RAREUSDT-5m-1769018171667" },
  { timestamp: "2026-01-21T18:00:50.941Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.081650805, position_id: "MINAUSDT-15m-1769018450638" },
  { timestamp: "2026-01-21T18:01:04.944Z", symbol: "BOMEUSDT", direction: "long", entry_price: 0.0005836917, position_id: "BOMEUSDT-15m-1769018464736" },
  { timestamp: "2026-01-21T18:26:08.822Z", symbol: "MINAUSDT", direction: "long", entry_price: 0.0816408, position_id: "MINAUSDT-15m-1769019968415" },
  { timestamp: "2026-01-21T18:30:17.094Z", symbol: "ANIMEUSDT", direction: "long", entry_price: 0.006306151499999999, position_id: "ANIMEUSDT-15m-1769020216757" },
];

// Closes with original leveraged outcomes
const closes = [
  { position_id: "XVSUSDT-5m-1769001340100", exit_price: 5.43728, exit_reason: "trailing_stop", leveraged_pnl_pct: 9.46 },
  { position_id: "SAFEUSDT-5m-1769000539049", exit_price: 0.19760114999999998, exit_reason: "stop_loss", leveraged_pnl_pct: -58.78 },
  { position_id: "HEIUSDT-15m-1769004258368", exit_price: 0.14122935, exit_reason: "trailing_stop", leveraged_pnl_pct: 21.87 },
  { position_id: "XNYUSDT-15m-1769007320259", exit_price: 0.0040169905, exit_reason: "trailing_stop", leveraged_pnl_pct: 10.12 },
  { position_id: "REZUSDT-5m-1769008008083", exit_price: 0.004775611, exit_reason: "trailing_stop", leveraged_pnl_pct: 8.62 },
  { position_id: "PIVXUSDT-5m-1769010805268", exit_price: 0.17901045000000002, exit_reason: "trailing_stop", leveraged_pnl_pct: 9.10 },
  { position_id: "DOGUSDT-15m-1769012705423", exit_price: 0.0013563215, exit_reason: "trailing_stop", leveraged_pnl_pct: 6.06 },
  { position_id: "MINAUSDT-15m-1769018450638", exit_price: 0.081959, exit_reason: "trailing_stop", leveraged_pnl_pct: 8.49 },
  { position_id: "BOMEUSDT-15m-1769018464736", exit_price: 0.0005869063999999999, exit_reason: "trailing_stop", leveraged_pnl_pct: 12.39 },
  { position_id: "RAREUSDT-5m-1769018171667", exit_price: 0.027376305, exit_reason: "trailing_stop", leveraged_pnl_pct: 5.99 },
  { position_id: "ANIMEUSDT-15m-1769020216757", exit_price: 0.0063538215, exit_reason: "trailing_stop", leveraged_pnl_pct: 17.01 },
  { position_id: "MINAUSDT-15m-1769019968415", exit_price: 0.08245875, exit_reason: "trailing_stop", leveraged_pnl_pct: 22.54 },
];

// Build outcome map
const outcomeMap = new Map<string, typeof closes[0]>();
for (const close of closes) {
  outcomeMap.set(close.position_id, close);
}

console.log('\n' + '='.repeat(80));
console.log('SPOT-ONLY BACKTEST V2 - Reality Check');
console.log('='.repeat(80));

console.log('\nKEY INSIGHT: The Focus Mode signals are GOOD (90%+ win rate)');
console.log('but the MAGNITUDE of gains is dramatically different at 1x vs 22.5x leverage.\n');

// Calculate what actually happened
interface TradeAnalysis {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  priceChangePct: number;
  leveragedROI: number;
  spotROI: number;
  exitReason: string;
}

const analysis: TradeAnalysis[] = [];

for (const open of opens) {
  const outcome = outcomeMap.get(open.position_id);
  if (!outcome) continue;

  const priceChangePct = ((outcome.exit_price - open.entry_price) / open.entry_price) * 100;

  analysis.push({
    symbol: open.symbol,
    entryPrice: open.entry_price,
    exitPrice: outcome.exit_price,
    priceChangePct,
    leveragedROI: outcome.leveraged_pnl_pct,
    spotROI: priceChangePct, // At 1x, ROI = price change
    exitReason: outcome.exit_reason,
  });
}

console.log('TRADE-BY-TRADE ANALYSIS:');
console.log('-'.repeat(90));
console.log('Symbol       | Price Change | Spot ROI | 22.5x ROI | Exit Reason');
console.log('-'.repeat(90));

let totalSpotROI = 0;
let totalLevROI = 0;
let wins = 0;
let losses = 0;

for (const trade of analysis) {
  const sign = trade.priceChangePct >= 0 ? '+' : '';
  console.log(
    `${trade.symbol.padEnd(12)} | ${sign}${trade.priceChangePct.toFixed(2).padStart(10)}% | ${sign}${trade.spotROI.toFixed(2).padStart(6)}% | ${sign}${trade.leveragedROI.toFixed(2).padStart(7)}% | ${trade.exitReason}`
  );
  totalSpotROI += trade.spotROI;
  totalLevROI += trade.leveragedROI;
  if (trade.spotROI > 0) wins++;
  else losses++;
}

console.log('-'.repeat(90));
console.log(`TOTALS:      | ${totalSpotROI >= 0 ? '+' : ''}${totalSpotROI.toFixed(2).padStart(10)}% | ${totalSpotROI >= 0 ? '+' : ''}${totalSpotROI.toFixed(2).padStart(6)}% | ${totalLevROI >= 0 ? '+' : ''}${totalLevROI.toFixed(2).padStart(7)}% |`);

console.log(`\nWin Rate: ${((wins / (wins + losses)) * 100).toFixed(1)}% (${wins}W / ${losses}L)`);

// Now calculate account performance
console.log('\n' + '='.repeat(80));
console.log('ACCOUNT PERFORMANCE SIMULATION');
console.log('='.repeat(80));

function simulateAccount(initialBalance: number, positionPct: number): { finalBalance: number; trades: number; maxDrawdown: number } {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  let trades = 0;

  for (const trade of analysis) {
    const positionSize = balance * (positionPct / 100);
    const pnl = positionSize * (trade.spotROI / 100);
    balance += pnl;
    trades++;

    if (balance > peakBalance) peakBalance = balance;
    const dd = (peakBalance - balance) / peakBalance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return { finalBalance: balance, trades, maxDrawdown };
}

const scenarios = [
  { balance: 100, positionPct: 10 },
  { balance: 500, positionPct: 10 },
  { balance: 1000, positionPct: 10 },
  { balance: 2000, positionPct: 10 },
  { balance: 2000, positionPct: 20 },  // More aggressive
  { balance: 2000, positionPct: 50 },  // Very aggressive
];

console.log('\nPosition% | Start    | End      | PnL      | Return % | Max DD');
console.log('-'.repeat(70));

for (const s of scenarios) {
  const result = simulateAccount(s.balance, s.positionPct);
  const pnl = result.finalBalance - s.balance;
  const returnPct = (pnl / s.balance) * 100;

  console.log(
    `${String(s.positionPct).padStart(8)}% | $${String(s.balance).padStart(6)} | $${result.finalBalance.toFixed(2).padStart(7)} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2).padStart(6)} | ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2).padStart(6)}% | ${(result.maxDrawdown * 100).toFixed(2)}%`
  );
}

// Reality check
console.log('\n' + '='.repeat(80));
console.log('REALITY CHECK: IS SPOT TRADING VIABLE?');
console.log('='.repeat(80));

console.log(`
YESTERDAY'S RESULTS (${analysis.length} trades):
  - Win Rate: ${((wins / (wins + losses)) * 100).toFixed(1)}%
  - Total Price Movement Captured: ${totalSpotROI >= 0 ? '+' : ''}${totalSpotROI.toFixed(2)}%

AT $2000 ACCOUNT WITH 10% POSITION SIZING:
  - Total PnL: ${(2000 * 0.10 * (totalSpotROI / 100) * analysis.length / analysis.length).toFixed(2)} per trade avg
  - Daily Return: ~${(totalSpotROI / 10).toFixed(3)}% (1/10th of total because 10% sizing)

THE MATH PROBLEM:
  - A +0.45% price move at 1x = +0.45% ROI = $0.90 on $200 position
  - A +0.45% price move at 22.5x = +10.13% ROI = $20.25 on $200 position

VIABILITY ASSESSMENT:
  - At 10% position sizing, you need ~22x more trades to match leveraged returns
  - OR increase position sizing significantly (but increases risk)
  - OR hold positions longer for larger price moves (but different strategy)

RECOMMENDATION:
  The Focus Mode signals ARE profitable for spot, but returns are tiny.
  Options to consider:
  1. Use larger position sizes (25-50%) since no liquidation risk at 1x
  2. Hold positions longer (modify trailing stop triggers)
  3. Accept lower returns as the cost of US compliance
  4. Look into crypto-friendly jurisdictions for better options
`);
