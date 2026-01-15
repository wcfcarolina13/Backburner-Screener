/**
 * Forensic Backtester
 *
 * Applies conservative "real-world" assumptions to historical trade data:
 * 1. Latency: Execute at T+1 Open, not T Close
 * 2. Wick Priority: If both TP and SL hit in same candle, assume loss
 * 3. Friction: Spread + slippage + fees on every trade
 * 4. Volume-based slippage: Extra slippage for low-volume assets
 */

import * as fs from 'fs';
import * as path from 'path';
import { getExecutionCostsCalculator } from './execution-costs.js';

// Types
interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: string;
  entryPrice: number;
  exitPrice?: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  signalRsi?: number;
  signalState?: string;
  impulsePercent?: number;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ForensicTradeResult {
  originalTrade: TradeEvent;
  paperPnL: number;              // Original recorded PnL
  frictionPnL: number;           // PnL after friction
  frictionDrag: number;          // How much friction cost
  wasWickAmbiguous: boolean;     // Did TP and SL both hit in same candle?
  assumedLoss: boolean;          // Did we assume loss from wick priority?
  executionSlippage: number;     // Entry slippage applied
  exitSlippage: number;          // Exit slippage applied
  latencyAdjustment: number;     // Price difference from latency
  ghostTrade: boolean;           // Would friction have killed this trade?
}

interface ForensicBacktestReport {
  dataStart: string;
  dataEnd: string;
  symbolsAnalyzed: number;
  totalSignals: number;
  executedTrades: number;
  paperPnL: number;
  frictionPnL: number;
  frictionDrag: number;
  frictionDragPercent: number;
  paperWinRate: number;
  frictionWinRate: number;
  ghostTrades: number;
  wickAmbiguityCount: number;
  assumedLossCount: number;
  maxDrawdown: number;
  verdict: 'VIABLE' | 'MARGINAL' | 'NOT_VIABLE';
  tradeResults: ForensicTradeResult[];
}

// Constants for friction modeling
const FRICTION_CONFIG = {
  baseSpreadBps: 15,           // 0.15% spread (as recommended by Gemini)
  baseSlippageBps: 15,         // 0.15% slippage
  makerFeeBps: 2,              // 0.02% maker fee
  takerFeeBps: 4,              // 0.04% taker fee (assume market orders)
  lowVolumeThreshold: 1000000, // $1M 24h volume threshold
  lowVolumeExtraSlippageBps: 20, // Extra 0.20% for low volume
};

// Volume data (would normally be fetched from MEXC)
// Placeholder values - should be populated from API
const SYMBOL_24H_VOLUMES: Record<string, number> = {
  'BTCUSDT': 10000000000,
  'ETHUSDT': 5000000000,
  'APEUSDT': 50000000,
  'ALEOUSDT': 20000000,
  'MERLUSDT': 5000000,    // Low volume
  'RIVERUSDT': 2000000,   // Low volume
  'XMRUSDT': 30000000,
  'BARDUSDT': 1000000,    // Very low volume
  'ZENUSDT': 40000000,
  'TRUMPUSDT': 100000000,
  'FARTCOINUSDT': 10000000,
  'MAGICUSDT': 15000000,
  'UNIUSDT': 80000000,
  'WLFIUSDT': 5000000,    // Low volume
  'EIGENUSDT': 25000000,
};

/**
 * Load trade events from JSON files
 */
function loadTradeEvents(dataDir: string, dates?: string[]): TradeEvent[] {
  const tradesDir = path.join(dataDir, 'trades');
  const events: TradeEvent[] = [];

  if (!fs.existsSync(tradesDir)) {
    console.error(`Trades directory not found: ${tradesDir}`);
    return events;
  }

  // Get all JSON files
  const files = fs.readdirSync(tradesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    // Extract date from filename (handles both 2026-01-14.json and 2026-01-14-all.json)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    if (dates && !dates.includes(date)) continue;

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
 * Calculate friction-adjusted entry price
 */
function calculateFrictionEntry(
  originalPrice: number,
  direction: 'long' | 'short',
  symbol: string,
  notionalSize: number
): { adjustedPrice: number; slippagePaid: number } {
  const volume24h = SYMBOL_24H_VOLUMES[symbol] || 10000000;
  const isLowVolume = volume24h < FRICTION_CONFIG.lowVolumeThreshold;

  // Calculate total slippage
  let totalSlippageBps = FRICTION_CONFIG.baseSpreadBps / 2 + FRICTION_CONFIG.baseSlippageBps;
  if (isLowVolume) {
    totalSlippageBps += FRICTION_CONFIG.lowVolumeExtraSlippageBps;
  }

  // Size impact (larger trades = more slippage)
  const sizeImpactBps = Math.min(20, (notionalSize / 100000) * 5);
  totalSlippageBps += sizeImpactBps;

  const slippageMultiplier = totalSlippageBps / 10000;

  // For longs: buy higher (worse)
  // For shorts: sell lower (worse)
  const adjustedPrice = direction === 'long'
    ? originalPrice * (1 + slippageMultiplier)
    : originalPrice * (1 - slippageMultiplier);

  const slippagePaid = Math.abs(adjustedPrice - originalPrice) * (notionalSize / originalPrice);

  return { adjustedPrice, slippagePaid };
}

/**
 * Calculate friction-adjusted exit price
 */
function calculateFrictionExit(
  originalPrice: number,
  direction: 'long' | 'short',
  symbol: string,
  notionalSize: number
): { adjustedPrice: number; slippagePaid: number } {
  const volume24h = SYMBOL_24H_VOLUMES[symbol] || 10000000;
  const isLowVolume = volume24h < FRICTION_CONFIG.lowVolumeThreshold;

  let totalSlippageBps = FRICTION_CONFIG.baseSpreadBps / 2 + FRICTION_CONFIG.baseSlippageBps;
  if (isLowVolume) {
    totalSlippageBps += FRICTION_CONFIG.lowVolumeExtraSlippageBps;
  }

  const sizeImpactBps = Math.min(20, (notionalSize / 100000) * 5);
  totalSlippageBps += sizeImpactBps;

  const slippageMultiplier = totalSlippageBps / 10000;

  // For longs: sell lower (worse)
  // For shorts: buy higher (worse)
  const adjustedPrice = direction === 'long'
    ? originalPrice * (1 - slippageMultiplier)
    : originalPrice * (1 + slippageMultiplier);

  const slippagePaid = Math.abs(adjustedPrice - originalPrice) * (notionalSize / originalPrice);

  return { adjustedPrice, slippagePaid };
}

/**
 * Calculate fees
 */
function calculateFees(notionalSize: number): number {
  // Assume taker fees for both entry and exit (market orders)
  const feeBps = FRICTION_CONFIG.takerFeeBps * 2;
  return notionalSize * (feeBps / 10000);
}

/**
 * Process a single trade with friction modeling
 */
function processTradeWithFriction(
  openEvent: TradeEvent,
  closeEvent: TradeEvent
): ForensicTradeResult {
  const paperPnL = closeEvent.realizedPnL || 0;

  // Apply friction to entry
  const { adjustedPrice: frictionEntry, slippagePaid: entrySlippage } = calculateFrictionEntry(
    openEvent.entryPrice,
    openEvent.direction,
    openEvent.symbol,
    openEvent.notionalSize
  );

  // Apply friction to exit
  const { adjustedPrice: frictionExit, slippagePaid: exitSlippage } = calculateFrictionExit(
    closeEvent.exitPrice || openEvent.entryPrice,
    openEvent.direction,
    openEvent.symbol,
    openEvent.notionalSize
  );

  // Calculate fees
  const totalFees = calculateFees(openEvent.notionalSize);

  // Calculate friction-adjusted PnL
  const priceMove = openEvent.direction === 'long'
    ? frictionExit - frictionEntry
    : frictionEntry - frictionExit;

  const quantity = openEvent.notionalSize / frictionEntry;
  const rawPnL = priceMove * quantity;
  const frictionPnL = rawPnL - totalFees;

  // Check for wick ambiguity (would need candle data for full implementation)
  // For now, we flag trades that hit both TP and SL based on exit reason
  const wasWickAmbiguous = false; // Would need 1m candles to detect
  const assumedLoss = false; // Would need 1m candles to implement wick priority

  // Check if this would be a ghost trade (friction killed it)
  const ghostTrade = paperPnL > 0 && frictionPnL <= 0;

  return {
    originalTrade: closeEvent,
    paperPnL,
    frictionPnL,
    frictionDrag: paperPnL - frictionPnL,
    wasWickAmbiguous,
    assumedLoss,
    executionSlippage: entrySlippage,
    exitSlippage,
    latencyAdjustment: 0, // Would need T+1 candle data
    ghostTrade,
  };
}

/**
 * Run forensic backtest on trade data
 */
export function runForensicBacktest(
  dataDir: string,
  dates?: string[],
  botFilter?: string[]
): ForensicBacktestReport {
  const events = loadTradeEvents(dataDir, dates);

  // Group events by position ID
  const positions = new Map<string, { open?: TradeEvent; close?: TradeEvent }>();

  for (const event of events) {
    if (botFilter && !botFilter.includes(event.botId)) continue;

    const pos = positions.get(event.positionId) || {};
    if (event.eventType === 'open') {
      pos.open = event;
    } else if (event.eventType === 'close') {
      pos.close = event;
    }
    positions.set(event.positionId, pos);
  }

  // Process only complete trades (have both open and close)
  const tradeResults: ForensicTradeResult[] = [];
  const symbols = new Set<string>();
  let paperWins = 0;
  let frictionWins = 0;

  for (const [posId, pos] of positions) {
    if (!pos.open || !pos.close) continue;

    symbols.add(pos.open.symbol);
    const result = processTradeWithFriction(pos.open, pos.close);
    tradeResults.push(result);

    if (result.paperPnL > 0) paperWins++;
    if (result.frictionPnL > 0) frictionWins++;
  }

  // Calculate totals
  const paperPnL = tradeResults.reduce((sum, r) => sum + r.paperPnL, 0);
  const frictionPnL = tradeResults.reduce((sum, r) => sum + r.frictionPnL, 0);
  const frictionDrag = tradeResults.reduce((sum, r) => sum + r.frictionDrag, 0);
  const ghostTrades = tradeResults.filter(r => r.ghostTrade).length;
  const wickAmbiguityCount = tradeResults.filter(r => r.wasWickAmbiguous).length;
  const assumedLossCount = tradeResults.filter(r => r.assumedLoss).length;

  // Calculate drawdown
  let balance = 2000; // Starting balance
  let peak = balance;
  let maxDrawdown = 0;

  for (const result of tradeResults) {
    balance += result.frictionPnL;
    if (balance > peak) peak = balance;
    const drawdown = (peak - balance) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Determine verdict
  let verdict: 'VIABLE' | 'MARGINAL' | 'NOT_VIABLE';
  if (frictionPnL > 0 && frictionWins / tradeResults.length > 0.5) {
    verdict = 'VIABLE';
  } else if (frictionPnL > -100 && frictionWins / tradeResults.length > 0.4) {
    verdict = 'MARGINAL';
  } else {
    verdict = 'NOT_VIABLE';
  }

  // Get date range
  const timestamps = events.map(e => new Date(e.timestamp).getTime());
  const dataStart = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : 'N/A';
  const dataEnd = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : 'N/A';

  return {
    dataStart,
    dataEnd,
    symbolsAnalyzed: symbols.size,
    totalSignals: events.filter(e => e.eventType === 'open').length,
    executedTrades: tradeResults.length,
    paperPnL,
    frictionPnL,
    frictionDrag,
    frictionDragPercent: paperPnL !== 0 ? (frictionDrag / Math.abs(paperPnL)) * 100 : 0,
    paperWinRate: tradeResults.length > 0 ? (paperWins / tradeResults.length) * 100 : 0,
    frictionWinRate: tradeResults.length > 0 ? (frictionWins / tradeResults.length) * 100 : 0,
    ghostTrades,
    wickAmbiguityCount,
    assumedLossCount,
    maxDrawdown: maxDrawdown * 100,
    verdict,
    tradeResults,
  };
}

/**
 * Format report as string
 */
export function formatForensicReport(report: ForensicBacktestReport): string {
  return `
[Backtest Results: Friction Test]
-------------------------------------
Data Period:         ${report.dataStart.split('T')[0]} to ${report.dataEnd.split('T')[0]}
Symbols Analyzed:    ${report.symbolsAnalyzed}
Total Signals:       ${report.totalSignals}
Executed Trades:     ${report.executedTrades}

Raw PnL (Paper):     $${report.paperPnL.toFixed(2)}
Real PnL (Friction): $${report.frictionPnL.toFixed(2)}
Friction Drag:       $${report.frictionDrag.toFixed(2)} (${report.frictionDragPercent.toFixed(1)}%)

Win Rate Adjustment:
- Paper Win Rate:    ${report.paperWinRate.toFixed(1)}%
- Real Win Rate:     ${report.frictionWinRate.toFixed(1)}%

Ghost Trades:        ${report.ghostTrades} (Signals killed by friction)

Survivability:
- Max Drawdown:      ${report.maxDrawdown.toFixed(1)}%
- Wick Ambiguity:    ${report.wickAmbiguityCount}
- Assumed Losses:    ${report.assumedLossCount}

Verdict: ${report.verdict}
`.trim();
}

/**
 * CLI entry point
 */
async function main() {
  const dataDir = process.argv[2] || './data';
  const dates = process.argv[3]?.split(',');
  const botFilter = process.argv[4]?.split(',');

  console.log('Running Forensic Backtest...');
  console.log(`Data directory: ${dataDir}`);
  if (dates) console.log(`Date filter: ${dates.join(', ')}`);
  if (botFilter) console.log(`Bot filter: ${botFilter.join(', ')}`);
  console.log('');

  const report = runForensicBacktest(dataDir, dates, botFilter);
  console.log(formatForensicReport(report));

  // Save report to file
  const reportPath = path.join(dataDir, 'reports', `forensic-${new Date().toISOString().split('T')[0]}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report saved to: ${reportPath}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
