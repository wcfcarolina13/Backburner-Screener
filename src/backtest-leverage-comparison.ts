/**
 * Backtest: Leverage Comparison Analysis
 *
 * Purpose: Analyze how different leverage levels would have performed
 * over the past 48 hours of choppy market conditions.
 *
 * Key insight: Lower leverage means:
 * - Stops take longer to hit (more room for recovery)
 * - Take profits take longer to hit (trades run longer)
 * - But reduced liquidation risk in choppy conditions
 *
 * This script recalculates PnL at different leverage levels using historical trade data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExecutionCostsCalculator, determineVolatility } from './execution-costs.js';

// Types
interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  botType?: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe?: string;
  entryPrice: number;
  exitPrice?: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  metadata?: {
    stopType?: string;
    callbackPercent?: number;
    positionSizePercent?: number;
  };
}

interface LeverageSimResult {
  originalLeverage: number;
  simulatedLeverage: number;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  // Original results
  originalPnL: number;
  originalPnLPercent: number;
  originalNotional: number;
  // Simulated results at new leverage
  simNotional: number;
  simPnL: number;
  simPnLPercent: number;
  // Would the outcome be different?
  originalHitSL: boolean;
  simWouldHitSL: boolean;  // With wider effective stop
  simWouldHitTP: boolean;  // With further effective TP
}

interface LeverageComparisonReport {
  dataStart: string;
  dataEnd: string;
  botCategory: string;
  totalTrades: number;
  leverageLevels: {
    leverage: number;
    totalPnL: number;
    winRate: number;
    avgPnLPerTrade: number;
    tradesHittingSL: number;
    tradesHittingTP: number;
  }[];
  tradeDetails: LeverageSimResult[];
}

// Friction calculator instance (using defaults from execution-costs.ts)
const costsCalculator = new ExecutionCostsCalculator();

/**
 * Load trade events from JSON files
 */
function loadTradeEvents(dataDir: string, dates: string[]): TradeEvent[] {
  const tradesDir = path.join(dataDir, 'trades');
  const events: TradeEvent[] = [];

  if (!fs.existsSync(tradesDir)) {
    console.error(`Trades directory not found: ${tradesDir}`);
    return events;
  }

  const files = fs.readdirSync(tradesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    if (!dates.includes(date)) continue;

    const filePath = path.join(tradesDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const trades = JSON.parse(content) as TradeEvent[];
      events.push(...trades);
    } catch (e) {
      console.error(`Failed to load ${file}:`, e);
    }
  }

  // De-duplicate by position ID and event type
  const seen = new Set<string>();
  const deduped: TradeEvent[] = [];
  for (const event of events) {
    const key = `${event.positionId}-${event.eventType}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(event);
    }
  }

  return deduped;
}

/**
 * Calculate PnL at different leverage level
 *
 * Key math:
 * - Same margin, different leverage = different notional
 * - PnL = (exitPrice - entryPrice) / entryPrice * notional (for longs)
 * - ROI% = PnL / margin * 100
 */
function simulateLeveragePnL(
  openEvent: TradeEvent,
  closeEvent: TradeEvent,
  newLeverage: number
): LeverageSimResult {
  const originalLeverage = openEvent.leverage;
  const margin = openEvent.marginUsed;
  const entryPrice = openEvent.entryPrice;
  const exitPrice = closeEvent.exitPrice || entryPrice;

  // Original notional and PnL
  const originalNotional = openEvent.notionalSize;
  const priceChange = closeEvent.direction === 'long'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  const originalPnL = priceChange * originalNotional;
  const originalPnLPercent = (originalPnL / margin) * 100;

  // Simulated notional at new leverage
  const simNotional = margin * newLeverage;
  const simPnL = priceChange * simNotional;
  const simPnLPercent = (simPnL / margin) * 100;

  // Determine if this was a stop-loss exit
  const exitReason = closeEvent.exitReason || 'unknown';
  const originalHitSL = exitReason.toLowerCase().includes('stop') ||
                        exitReason.toLowerCase().includes('sl') ||
                        originalPnL < 0;

  // With lower leverage, the same price move = smaller ROI%
  // A trade that hit -20% ROI at 10x would only be -10% ROI at 5x
  // This means the stop might not have been triggered yet
  const simWouldHitSL = simPnLPercent <= -20;  // Assuming 20% SL threshold
  const simWouldHitTP = simPnLPercent >= 20;   // Assuming 20% TP threshold

  return {
    originalLeverage,
    simulatedLeverage: newLeverage,
    positionId: openEvent.positionId,
    symbol: openEvent.symbol,
    direction: closeEvent.direction || 'long',
    entryPrice,
    exitPrice,
    exitReason,
    originalPnL,
    originalPnLPercent,
    originalNotional,
    simNotional,
    simPnL,
    simPnLPercent,
    originalHitSL,
    simWouldHitSL,
    simWouldHitTP,
  };
}

/**
 * Apply friction to simulated PnL
 */
function applyFriction(pnL: number, notional: number, direction: 'long' | 'short'): number {
  // Use determineVolatility with undefined to get 'normal' state
  const volatility = determineVolatility(undefined, undefined);
  const entryCosts = costsCalculator.calculateEntryCosts(
    100, notional, direction, volatility
  );
  const exitCosts = costsCalculator.calculateExitCosts(
    100, notional, direction, volatility
  );
  return pnL - entryCosts.entryCosts - exitCosts.exitCosts;
}

/**
 * Run leverage comparison backtest
 */
export function runLeverageComparison(
  dataDir: string,
  dates: string[],
  botFilter: string[],
  leverageLevels: number[] = [3, 5, 10, 20]
): LeverageComparisonReport {
  const events = loadTradeEvents(dataDir, dates);

  // Group events by position ID
  const positions = new Map<string, { open?: TradeEvent; close?: TradeEvent }>();

  for (const event of events) {
    // Filter by bot ID pattern
    const matchesFilter = botFilter.some(pattern =>
      event.botId.toLowerCase().includes(pattern.toLowerCase())
    );
    if (!matchesFilter) continue;

    const pos = positions.get(event.positionId) || {};
    if (event.eventType === 'open') {
      pos.open = event;
    } else if (event.eventType === 'close') {
      pos.close = event;
    }
    positions.set(event.positionId, pos);
  }

  // Process complete trades
  const tradeDetails: LeverageSimResult[] = [];
  const leverageResults: Map<number, { pnL: number; wins: number; losses: number; slHits: number; tpHits: number }> = new Map();

  // Initialize results for each leverage level
  for (const lev of leverageLevels) {
    leverageResults.set(lev, { pnL: 0, wins: 0, losses: 0, slHits: 0, tpHits: 0 });
  }

  for (const [posId, pos] of positions) {
    if (!pos.open || !pos.close) continue;

    // Skip if no realized PnL (trade might still be open)
    if (pos.close.realizedPnL === undefined) continue;

    for (const newLeverage of leverageLevels) {
      const simResult = simulateLeveragePnL(pos.open, pos.close, newLeverage);

      // Apply friction
      const simPnLWithFriction = applyFriction(
        simResult.simPnL,
        simResult.simNotional,
        simResult.direction
      );

      // Update aggregate results
      const results = leverageResults.get(newLeverage)!;
      results.pnL += simPnLWithFriction;
      if (simPnLWithFriction > 0) {
        results.wins++;
      } else {
        results.losses++;
      }
      if (simResult.simWouldHitSL) results.slHits++;
      if (simResult.simWouldHitTP) results.tpHits++;

      // Store detail for the originally used leverage for reference
      if (newLeverage === pos.open.leverage) {
        tradeDetails.push(simResult);
      }
    }
  }

  // Calculate leverage comparison stats
  const leverageLevelStats = leverageLevels.map(lev => {
    const results = leverageResults.get(lev)!;
    const totalTrades = results.wins + results.losses;
    return {
      leverage: lev,
      totalPnL: results.pnL,
      winRate: totalTrades > 0 ? (results.wins / totalTrades) * 100 : 0,
      avgPnLPerTrade: totalTrades > 0 ? results.pnL / totalTrades : 0,
      tradesHittingSL: results.slHits,
      tradesHittingTP: results.tpHits,
    };
  });

  // Get date range
  const timestamps = events.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  const dataStart = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : 'N/A';
  const dataEnd = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : 'N/A';

  return {
    dataStart,
    dataEnd,
    botCategory: botFilter.join(', '),
    totalTrades: tradeDetails.length,
    leverageLevels: leverageLevelStats,
    tradeDetails,
  };
}

/**
 * Format report as string
 */
export function formatLeverageReport(report: LeverageComparisonReport): string {
  let output = `
╔════════════════════════════════════════════════════════════════════╗
║           LEVERAGE COMPARISON BACKTEST REPORT                       ║
╠════════════════════════════════════════════════════════════════════╣
║ Data Period:    ${report.dataStart.split('T')[0]} to ${report.dataEnd.split('T')[0].padEnd(35)}║
║ Bot Category:   ${report.botCategory.padEnd(49)}║
║ Total Trades:   ${String(report.totalTrades).padEnd(49)}║
╚════════════════════════════════════════════════════════════════════╝

LEVERAGE COMPARISON:
────────────────────────────────────────────────────────────────────

`;

  // Sort by leverage for consistent display
  const sorted = [...report.leverageLevels].sort((a, b) => a.leverage - b.leverage);

  for (const lev of sorted) {
    const pnLColor = lev.totalPnL >= 0 ? '✅' : '❌';
    output += `┌─ ${lev.leverage}x Leverage ────────────────────────────────────────┐
│  Total PnL:        ${pnLColor} $${lev.totalPnL.toFixed(2).padEnd(35)}│
│  Win Rate:         ${lev.winRate.toFixed(1)}%${' '.repeat(40)}│
│  Avg PnL/Trade:    $${lev.avgPnLPerTrade.toFixed(2).padEnd(35)}│
│  SL Hits:          ${lev.tradesHittingSL}/${report.totalTrades}${' '.repeat(42)}│
│  TP Hits:          ${lev.tradesHittingTP}/${report.totalTrades}${' '.repeat(42)}│
└──────────────────────────────────────────────────────────────┘
`;
  }

  // Key insight
  output += `
────────────────────────────────────────────────────────────────────
KEY INSIGHTS:
────────────────────────────────────────────────────────────────────

Lower leverage means:
  1. Same $ margin controls less notional (lower profits AND losses)
  2. Same price move = smaller ROI% change
  3. Stops/TPs take longer to hit → trades run longer
  4. In choppy markets: may avoid premature stop-outs

At 5x vs 20x leverage with $200 margin:
  - 5x:  $1,000 notional, 1% price move = $10 = 5% ROI
  - 20x: $4,000 notional, 1% price move = $40 = 20% ROI

If 20% SL triggers at 20x, same move at 5x = only 5% drawdown (no stop).
`;

  return output;
}

/**
 * CLI entry point
 */
async function main() {
  const dataDir = process.argv[2] || './data';

  // Default to last 2 days
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  const dates = [
    twoDaysAgo.toISOString().split('T')[0],
    yesterday.toISOString().split('T')[0],
    today.toISOString().split('T')[0],
  ];

  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║      RUNNING LEVERAGE COMPARISON BACKTEST                          ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`\nData directory: ${dataDir}`);
  console.log(`Date range: ${dates.join(', ')}\n`);

  // 1. Best performing bots (trailing) with different leverage
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 1: TRAILING BOTS (Best Performers)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const trailingReport = runLeverageComparison(
    dataDir,
    dates,
    ['trailing', '1pct', '10pct'],
    [3, 5, 10, 20]
  );
  console.log(formatLeverageReport(trailingReport));

  // 2. GP bots with different leverage
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 2: GOLDEN POCKET BOTS');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const gpReport = runLeverageComparison(
    dataDir,
    dates,
    ['gp-', 'gp2-'],
    [3, 5, 10, 15, 20]
  );
  console.log(formatLeverageReport(gpReport));

  // 3. BTC Bias bots (known losers - for comparison)
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSIS 3: BTC BIAS BOTS (For Comparison)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const btcBiasReport = runLeverageComparison(
    dataDir,
    dates,
    ['btc-bias'],
    [5, 10, 20, 50]
  );
  console.log(formatLeverageReport(btcBiasReport));

  // Save reports
  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const reportData = {
    timestamp: new Date().toISOString(),
    trailing: trailingReport,
    goldenPocket: gpReport,
    btcBias: btcBiasReport,
  };

  const reportPath = path.join(reportsDir, `leverage-comparison-${today.toISOString().split('T')[0]}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`\n✅ Full report saved to: ${reportPath}`);
}

// Run if called directly
main().catch(console.error);
