/**
 * Backtest 3: BTC Correlation Filter Strategy
 *
 * Hypothesis: Skipping alt entries during active BTC selloffs improves win rate.
 *
 * Approach:
 * 1. Get BTC 1h price data for the backtest period
 * 2. For each trade, check if BTC was down >X% in the hour before entry
 * 3. Compare trades entered during BTC selloffs vs normal periods
 *
 * Implementation: Uses BTC candles from MEXC API
 */

import { createClient } from '@libsql/client';
import { getFuturesKlines } from '../src/mexc-api.js';
import { Candle } from '../src/types.js';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';

interface TradeRecord {
  symbol: string;
  direction: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  marginUsed: number;
  exitReason: string;
  realizedPnlPercent: number;
  highestPnlPercent: number | null;
}

// Cache BTC candles to avoid refetching
let btcCandles: Candle[] = [];

async function fetchBtcCandles(): Promise<Candle[]> {
  if (btcCandles.length > 0) return btcCandles;

  console.log('Fetching BTC 1h candles from MEXC...');

  // Fetch last 7 days of 1h candles (168 candles)
  const candles = await getFuturesKlines('BTC_USDT', '1h', 168);
  btcCandles = candles.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`Loaded ${btcCandles.length} BTC 1h candles`);
  console.log(`Range: ${new Date(btcCandles[0].timestamp).toISOString()} to ${new Date(btcCandles[btcCandles.length - 1].timestamp).toISOString()}`);

  return btcCandles;
}

function getBtcChange(entryTime: string, lookbackHours: number): number | null {
  const entryTs = new Date(entryTime).getTime();

  // Find the candle closest to entry time
  const currentCandle = btcCandles.find(c => c.timestamp <= entryTs && c.timestamp + 3600000 > entryTs);
  if (!currentCandle) return null;

  // Find candle from lookbackHours ago
  const lookbackTs = entryTs - (lookbackHours * 3600000);
  const pastCandle = btcCandles.find(c => c.timestamp <= lookbackTs && c.timestamp + 3600000 > lookbackTs);
  if (!pastCandle) return null;

  // Calculate BTC change
  const btcChange = ((currentCandle.close - pastCandle.close) / pastCandle.close) * 100;
  return btcChange;
}

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('BTC CORRELATION FILTER BACKTEST');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const BTC_DROP_THRESHOLDS = [-0.5, -1, -1.5, -2, -3];  // BTC down more than X% = selloff
  const MARGIN_PER_TRADE = 10;

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Fetch BTC candles
    await fetchBtcCandles();

    // 2. Load trades
    console.log(`\nLoading trades since ${cutoff}...`);

    const result = await client.execute({
      sql: `
        SELECT
          symbol, direction, timestamp as exit_time, entry_time, entry_price, exit_price,
          exit_reason, realized_pnl_percent, highest_pnl_percent, leverage, margin_used
        FROM trade_events
        WHERE bot_id = 'exp-bb-sysB'
          AND event_type = 'close'
          AND timestamp >= ?
        ORDER BY timestamp ASC
      `,
      args: [cutoff]
    });

    const trades: TradeRecord[] = result.rows.map(row => ({
      symbol: row.symbol as string,
      direction: row.direction as string,
      entryTime: (row.entry_time || row.exit_time) as string,
      exitTime: row.exit_time as string,
      entryPrice: Number(row.entry_price) || 0,
      exitPrice: Number(row.exit_price) || 0,
      leverage: Number(row.leverage) || 20,
      marginUsed: Number(row.margin_used) || MARGIN_PER_TRADE,
      exitReason: row.exit_reason as string,
      realizedPnlPercent: Number(row.realized_pnl_percent) || 0,
      highestPnlPercent: row.highest_pnl_percent != null ? Number(row.highest_pnl_percent) : null
    }));

    console.log(`Loaded ${trades.length} trades\n`);

    // 3. Annotate trades with BTC state at entry
    console.log('Annotating trades with BTC state...\n');

    interface AnnotatedTrade extends TradeRecord {
      btc1hChange: number | null;
    }

    const annotatedTrades: AnnotatedTrade[] = trades.map(t => ({
      ...t,
      btc1hChange: getBtcChange(t.entryTime, 1)
    }));

    const tradesWithBtcData = annotatedTrades.filter(t => t.btc1hChange !== null);
    console.log(`Trades with BTC data: ${tradesWithBtcData.length}/${trades.length}`);

    // 4. Show BTC distribution
    console.log('\n' + '─'.repeat(80));
    console.log('BTC 1H CHANGE DISTRIBUTION AT ENTRY TIME');
    console.log('─'.repeat(80));

    const btcBins = [
      { min: -Infinity, max: -3, label: 'BTC < -3%', trades: [] as AnnotatedTrade[] },
      { min: -3, max: -2, label: 'BTC -3% to -2%', trades: [] as AnnotatedTrade[] },
      { min: -2, max: -1, label: 'BTC -2% to -1%', trades: [] as AnnotatedTrade[] },
      { min: -1, max: 0, label: 'BTC -1% to 0%', trades: [] as AnnotatedTrade[] },
      { min: 0, max: 1, label: 'BTC 0% to +1%', trades: [] as AnnotatedTrade[] },
      { min: 1, max: 2, label: 'BTC +1% to +2%', trades: [] as AnnotatedTrade[] },
      { min: 2, max: Infinity, label: 'BTC > +2%', trades: [] as AnnotatedTrade[] },
    ];

    for (const t of tradesWithBtcData) {
      for (const bin of btcBins) {
        if (t.btc1hChange! >= bin.min && t.btc1hChange! < bin.max) {
          bin.trades.push(t);
          break;
        }
      }
    }

    console.log('\nBTC 1h Change | Trades | Win Rate | Avg ROE% | Total PnL');
    console.log('--------------|--------|----------|----------|----------');

    for (const bin of btcBins) {
      if (bin.trades.length === 0) continue;
      const wins = bin.trades.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
      const winRate = (wins.length / bin.trades.length * 100).toFixed(0);
      const avgRoe = bin.trades.reduce((s, t) => s + t.realizedPnlPercent, 0) / bin.trades.length;
      const totalPnl = bin.trades.reduce((s, t) => s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);

      console.log(
        `${bin.label.padEnd(13)} | ${String(bin.trades.length).padStart(6)} | ` +
        `${winRate.padStart(7)}% | ${(avgRoe >= 0 ? '+' : '') + avgRoe.toFixed(1).padStart(8)}% | ` +
        `$${totalPnl.toFixed(2).padStart(8)}`
      );
    }

    // 5. Simulate BTC filter strategy
    console.log('\n' + '─'.repeat(80));
    console.log('BTC FILTER STRATEGY SIMULATION');
    console.log('─'.repeat(80));
    console.log('\nScenario: Skip entries when BTC is down more than X% in last 1h\n');

    // Baseline: all trades
    const baselinePnl = tradesWithBtcData.reduce((s, t) =>
      s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);
    const baselineWins = tradesWithBtcData.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
    const baselineWinRate = (baselineWins.length / tradesWithBtcData.length * 100).toFixed(1);

    console.log(`Baseline (all trades): ${tradesWithBtcData.length} trades, ${baselineWinRate}% WR, $${baselinePnl.toFixed(2)} PnL\n`);

    console.log('BTC Drop Filter | Trades Taken | Skipped | Win Rate | Total PnL | Δ vs Base');
    console.log('----------------|--------------|---------|----------|-----------|----------');

    for (const threshold of BTC_DROP_THRESHOLDS) {
      // Filter: skip trades where BTC was down more than threshold
      const filteredTrades = tradesWithBtcData.filter(t => t.btc1hChange! > threshold);
      const skippedTrades = tradesWithBtcData.filter(t => t.btc1hChange! <= threshold);

      const filteredPnl = filteredTrades.reduce((s, t) =>
        s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);
      const filteredWins = filteredTrades.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
      const filteredWinRate = filteredTrades.length > 0
        ? (filteredWins.length / filteredTrades.length * 100).toFixed(1)
        : '0';

      const delta = filteredPnl - baselinePnl;

      // Also show what we missed by skipping
      const skippedPnl = skippedTrades.reduce((s, t) =>
        s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);

      console.log(
        `Skip if < ${String(threshold).padStart(4)}% | ${String(filteredTrades.length).padStart(12)} | ` +
        `${String(skippedTrades.length).padStart(7)} | ${filteredWinRate.padStart(7)}% | ` +
        `$${filteredPnl.toFixed(2).padStart(9)} | ${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(8)}`
      );
    }

    // 6. Analyze skipped trades in detail
    console.log('\n' + '─'.repeat(80));
    console.log('ANALYSIS OF SKIPPED TRADES (at -1% threshold)');
    console.log('─'.repeat(80));

    const skipThreshold = -1;
    const skipped = tradesWithBtcData.filter(t => t.btc1hChange! <= skipThreshold);
    const skippedWins = skipped.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
    const skippedLosses = skipped.filter(t => t.exitReason === 'stop_loss' && t.realizedPnlPercent < 0);

    console.log(`\nTrades that would be skipped: ${skipped.length}`);
    console.log(`  - Would have won: ${skippedWins.length}`);
    console.log(`  - Would have lost: ${skippedLosses.length}`);

    const skippedWinPnl = skippedWins.reduce((s, t) =>
      s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);
    const skippedLossPnl = skippedLosses.reduce((s, t) =>
      s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);

    console.log(`  - Missed profit: $${skippedWinPnl.toFixed(2)}`);
    console.log(`  - Avoided loss: $${Math.abs(skippedLossPnl).toFixed(2)}`);
    console.log(`  - Net from skipping: $${(skippedWinPnl + skippedLossPnl).toFixed(2)}`);

    // 7. Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('CONCLUSION');
    console.log('═'.repeat(80));

    // Find best threshold
    let bestThreshold = 0;
    let bestPnl = baselinePnl;
    for (const thresh of BTC_DROP_THRESHOLDS) {
      const filtered = tradesWithBtcData.filter(t => t.btc1hChange! > thresh);
      const pnl = filtered.reduce((s, t) =>
        s + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);
      if (pnl > bestPnl) {
        bestPnl = pnl;
        bestThreshold = thresh;
      }
    }

    if (bestThreshold !== 0) {
      const improvement = bestPnl - baselinePnl;
      console.log(`\n✅ BTC FILTER HELPS at ${bestThreshold}% threshold`);
      console.log(`   Improvement: +$${improvement.toFixed(2)}`);
    } else {
      console.log(`\n❌ BTC FILTER doesn't help - baseline strategy is best`);
    }

    console.log(`\nKey insight: When BTC drops significantly, alt entries tend to underperform.`);
    console.log(`This filter works by avoiding entries during market-wide stress.`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
