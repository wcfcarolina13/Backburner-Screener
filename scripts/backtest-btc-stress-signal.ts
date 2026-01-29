/**
 * Backtest 5: BTC Price Action as Stress Signal
 *
 * From Backtest 3, we found:
 * - BTC -2% to -1%: 100% WR, +19% avg ROE (GREAT entries during dips)
 * - BTC +1% to +2%: 18% WR, -2.4% avg ROE (BAD entries during pumps)
 *
 * Hypothesis: Use BTC PUMP (not dip!) as stress signal for insurance.
 * When BTC is up 1%+ in last hour, apply insurance since entries underperform.
 *
 * This is more responsive than lagging hourly WR because it uses live data.
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

// Cache BTC candles
let btcCandles: Candle[] = [];

async function fetchBtcCandles(): Promise<Candle[]> {
  if (btcCandles.length > 0) return btcCandles;
  console.log('Fetching BTC 1h candles from MEXC...');
  const candles = await getFuturesKlines('BTC_USDT', '1h', 168);
  btcCandles = candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${btcCandles.length} BTC 1h candles`);
  return btcCandles;
}

function getBtcChange(timestamp: string, lookbackHours: number): number | null {
  const ts = new Date(timestamp).getTime();
  const currentCandle = btcCandles.find(c => c.timestamp <= ts && c.timestamp + 3600000 > ts);
  if (!currentCandle) return null;
  const lookbackTs = ts - (lookbackHours * 3600000);
  const pastCandle = btcCandles.find(c => c.timestamp <= lookbackTs && c.timestamp + 3600000 > lookbackTs);
  if (!pastCandle) return null;
  return ((currentCandle.close - pastCandle.close) / pastCandle.close) * 100;
}

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('BTC PRICE ACTION AS STRESS SIGNAL');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const INSURANCE_THRESHOLD = 2;
  const MARGIN_PER_TRADE = 10;

  // Test different BTC thresholds for "stress" (pump = bad for entries)
  const BTC_STRESS_THRESHOLDS = [0.5, 1.0, 1.5, 2.0];

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    await fetchBtcCandles();

    // Load trades
    console.log(`Loading trades since ${cutoff}...`);

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

    console.log(`Loaded ${trades.length} trades`);

    // Annotate trades with BTC state
    interface AnnotatedTrade extends TradeRecord {
      btc1hChange: number | null;
    }

    const annotatedTrades: AnnotatedTrade[] = trades.map(t => ({
      ...t,
      btc1hChange: getBtcChange(t.entryTime, 1)
    }));

    const tradesWithBtcAndPeak = annotatedTrades.filter(t =>
      t.btc1hChange !== null && t.highestPnlPercent !== null
    );
    console.log(`Trades with BTC + peak data: ${tradesWithBtcAndPeak.length}/${trades.length}\n`);

    // Baseline
    let baselinePnl = 0;
    for (const t of tradesWithBtcAndPeak) {
      baselinePnl += (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE);
    }

    // Also calculate hourly WR stress for comparison
    const hourlyStats = new Map<string, { trades: number; wins: number }>();
    for (const t of trades) {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      if (!hourlyStats.has(hour)) {
        hourlyStats.set(hour, { trades: 0, wins: 0 });
      }
      const stats = hourlyStats.get(hour)!;
      stats.trades++;
      if (t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0) {
        stats.wins++;
      }
    }

    // Hourly WR stress baseline (current implementation)
    let hourlyWrStressPnl = 0;
    let hourlyWrTriggered = 0;
    for (const t of tradesWithBtcAndPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      const finalRoe = t.realizedPnlPercent;
      const peakRoe = t.highestPnlPercent!;
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      const stats = hourlyStats.get(hour);
      const isStress = stats && stats.trades > 0 && (stats.wins / stats.trades * 100) < 50;

      if (isStress && peakRoe >= INSURANCE_THRESHOLD) {
        hourlyWrTriggered++;
        const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
        const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
        hourlyWrStressPnl += halfA + halfB;
      } else {
        hourlyWrStressPnl += (finalRoe / 100) * margin;
      }
    }

    console.log('─'.repeat(80));
    console.log('STRESS SIGNAL COMPARISON');
    console.log('─'.repeat(80));
    console.log(`\nBaseline (full ride): $${baselinePnl.toFixed(2)}`);
    console.log(`Hourly WR <50% stress (current): $${hourlyWrStressPnl.toFixed(2)} (Δ: ${(hourlyWrStressPnl - baselinePnl >= 0 ? '+' : '')}$${(hourlyWrStressPnl - baselinePnl).toFixed(2)}, ${hourlyWrTriggered} triggers)\n`);

    console.log('BTC Pump Threshold | Insurance PnL | Δ vs Baseline | Triggers | % Trades');
    console.log('-------------------|---------------|---------------|----------|----------');

    for (const btcThresh of BTC_STRESS_THRESHOLDS) {
      let btcStressPnl = 0;
      let triggered = 0;

      for (const t of tradesWithBtcAndPeak) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;

        // Stress = BTC UP more than threshold (pumps are bad for contrarian entries)
        const isStress = t.btc1hChange! >= btcThresh;

        if (isStress && peakRoe >= INSURANCE_THRESHOLD) {
          triggered++;
          const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          btcStressPnl += halfA + halfB;
        } else {
          btcStressPnl += (finalRoe / 100) * margin;
        }
      }

      const delta = btcStressPnl - baselinePnl;
      const stressTrades = tradesWithBtcAndPeak.filter(t => t.btc1hChange! >= btcThresh).length;
      const pctTrades = (stressTrades / tradesWithBtcAndPeak.length * 100).toFixed(0);

      console.log(
        `BTC >= +${btcThresh.toFixed(1).padStart(4)}%   | ` +
        `$${btcStressPnl.toFixed(2).padStart(12)} | ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(12)} | ` +
        `${String(triggered).padStart(8)} | ` +
        `${pctTrades.padStart(7)}%`
      );
    }

    // Also test BTC DIP as "anti-stress" (skip insurance when BTC down)
    console.log('\n' + '─'.repeat(80));
    console.log('ALTERNATIVE: BTC DIP = GOOD (skip insurance during dips)');
    console.log('─'.repeat(80));
    console.log('\nHypothesis: Only apply insurance when BTC is NOT in a dip\n');

    console.log('Skip Insurance When | Insurance PnL | Δ vs Baseline | Triggers');
    console.log('--------------------|---------------|---------------|----------');

    for (const dipThresh of [-0.5, -1.0, -1.5, -2.0]) {
      let pnl = 0;
      let triggered = 0;

      for (const t of tradesWithBtcAndPeak) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;

        // Skip insurance if BTC is dipping (good for entries)
        const btcDipping = t.btc1hChange! <= dipThresh;

        if (!btcDipping && peakRoe >= INSURANCE_THRESHOLD) {
          triggered++;
          const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          pnl += halfA + halfB;
        } else {
          pnl += (finalRoe / 100) * margin;
        }
      }

      const delta = pnl - baselinePnl;
      console.log(
        `BTC <= ${dipThresh.toFixed(1).padStart(5)}%    | ` +
        `$${pnl.toFixed(2).padStart(12)} | ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(12)} | ` +
        `${String(triggered).padStart(8)}`
      );
    }

    // Combined: Apply insurance when BTC UP, skip when BTC DOWN
    console.log('\n' + '─'.repeat(80));
    console.log('COMBINED: Insurance ONLY when BTC >= +1% (stress), SKIP when BTC <= -1% (opportunity)');
    console.log('─'.repeat(80));

    let combinedPnl = 0;
    let combinedTriggered = 0;
    for (const t of tradesWithBtcAndPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      const finalRoe = t.realizedPnlPercent;
      const peakRoe = t.highestPnlPercent!;
      const btcUp = t.btc1hChange! >= 1.0;

      if (btcUp && peakRoe >= INSURANCE_THRESHOLD) {
        combinedTriggered++;
        const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
        const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
        combinedPnl += halfA + halfB;
      } else {
        combinedPnl += (finalRoe / 100) * margin;
      }
    }

    console.log(`\nBTC-based stress: $${combinedPnl.toFixed(2)} (Δ: ${(combinedPnl - baselinePnl >= 0 ? '+' : '')}$${(combinedPnl - baselinePnl).toFixed(2)}, ${combinedTriggered} triggers)`);
    console.log(`vs Hourly WR stress: $${hourlyWrStressPnl.toFixed(2)} (Δ: ${(hourlyWrStressPnl - baselinePnl >= 0 ? '+' : '')}$${(hourlyWrStressPnl - baselinePnl).toFixed(2)}, ${hourlyWrTriggered} triggers)`);

    const btcBetter = combinedPnl > hourlyWrStressPnl;

    // Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('CONCLUSION');
    console.log('═'.repeat(80));

    if (btcBetter) {
      const improvement = combinedPnl - hourlyWrStressPnl;
      console.log(`\n✅ BTC-based stress signal is BETTER by $${improvement.toFixed(2)}`);
      console.log(`   Recommendation: Use BTC 1h change >= +1% as stress signal instead of hourly WR`);
    } else {
      const worse = hourlyWrStressPnl - combinedPnl;
      console.log(`\n❌ BTC-based stress signal is WORSE by $${worse.toFixed(2)}`);
      console.log(`   Keep using hourly WR < 50% as stress signal`);
    }

    console.log(`\nKey insight: For contrarian RSI oversold strategy, BTC pumps = BAD entries`);
    console.log(`Using live BTC data is more responsive than lagging hourly WR.`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
