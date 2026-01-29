/**
 * Backtest 6: Volume-Based Stress Detection
 *
 * Hypothesis: Unusual volume spikes indicate regime change / increased volatility
 * which may warrant insurance protection.
 *
 * Test combinations:
 * 1. High BTC volume alone
 * 2. High volume + BTC direction
 * 3. Volume ratio vs 24h average
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

// Cache BTC candles with volume
let btcCandles: Candle[] = [];

async function fetchBtcCandles(): Promise<Candle[]> {
  if (btcCandles.length > 0) return btcCandles;
  console.log('Fetching BTC 1h candles from MEXC...');
  const candles = await getFuturesKlines('BTC_USDT', '1h', 168);
  btcCandles = candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${btcCandles.length} BTC 1h candles`);
  return btcCandles;
}

interface BtcMetrics {
  change1h: number | null;
  volume: number | null;
  volumeRatio: number | null; // Current volume / 24h avg volume
}

function getBtcMetrics(timestamp: string): BtcMetrics {
  const ts = new Date(timestamp).getTime();
  const currentCandle = btcCandles.find(c => c.timestamp <= ts && c.timestamp + 3600000 > ts);
  if (!currentCandle) return { change1h: null, volume: null, volumeRatio: null };

  // Get 1h price change
  const lookbackTs = ts - 3600000;
  const pastCandle = btcCandles.find(c => c.timestamp <= lookbackTs && c.timestamp + 3600000 > lookbackTs);
  const change1h = pastCandle
    ? ((currentCandle.close - pastCandle.close) / pastCandle.close) * 100
    : null;

  // Get 24h average volume
  const last24hCandles = btcCandles.filter(c =>
    c.timestamp >= ts - 24 * 3600000 && c.timestamp < ts
  );
  const avgVolume = last24hCandles.length > 0
    ? last24hCandles.reduce((s, c) => s + c.volume, 0) / last24hCandles.length
    : null;

  const volumeRatio = avgVolume && avgVolume > 0
    ? currentCandle.volume / avgVolume
    : null;

  return {
    change1h,
    volume: currentCandle.volume,
    volumeRatio
  };
}

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('VOLUME-BASED STRESS DETECTION');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const INSURANCE_THRESHOLD = 2;
  const MARGIN_PER_TRADE = 10;

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

    // Annotate trades with BTC metrics
    interface AnnotatedTrade extends TradeRecord {
      btcChange1h: number | null;
      btcVolume: number | null;
      btcVolumeRatio: number | null;
    }

    const annotatedTrades: AnnotatedTrade[] = trades.map(t => {
      const metrics = getBtcMetrics(t.entryTime);
      return {
        ...t,
        btcChange1h: metrics.change1h,
        btcVolume: metrics.volume,
        btcVolumeRatio: metrics.volumeRatio
      };
    });

    const tradesWithData = annotatedTrades.filter(t =>
      t.btcChange1h !== null &&
      t.btcVolumeRatio !== null &&
      t.highestPnlPercent !== null
    );
    console.log(`Trades with BTC + volume + peak data: ${tradesWithData.length}/${trades.length}\n`);

    // Baseline
    let baselinePnl = 0;
    for (const t of tradesWithData) {
      baselinePnl += (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE);
    }

    // Volume distribution
    console.log('─'.repeat(80));
    console.log('VOLUME RATIO DISTRIBUTION');
    console.log('─'.repeat(80));

    const volBins = [
      { min: 0, max: 0.5, label: 'Vol < 0.5x avg' },
      { min: 0.5, max: 1.0, label: 'Vol 0.5-1x avg' },
      { min: 1.0, max: 1.5, label: 'Vol 1-1.5x avg' },
      { min: 1.5, max: 2.0, label: 'Vol 1.5-2x avg' },
      { min: 2.0, max: 3.0, label: 'Vol 2-3x avg' },
      { min: 3.0, max: Infinity, label: 'Vol > 3x avg' },
    ];

    console.log('\nVolume Ratio | Trades | Win Rate | Avg ROE%');
    console.log('-------------|--------|----------|----------');

    for (const bin of volBins) {
      const binTrades = tradesWithData.filter(t =>
        t.btcVolumeRatio! >= bin.min && t.btcVolumeRatio! < bin.max
      );
      if (binTrades.length === 0) continue;

      const wins = binTrades.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
      const winRate = (wins.length / binTrades.length * 100).toFixed(0);
      const avgRoe = binTrades.reduce((s, t) => s + t.realizedPnlPercent, 0) / binTrades.length;

      console.log(
        `${bin.label.padEnd(12)} | ${String(binTrades.length).padStart(6)} | ` +
        `${winRate.padStart(7)}% | ${(avgRoe >= 0 ? '+' : '') + avgRoe.toFixed(1).padStart(8)}%`
      );
    }

    // Test volume-based stress signals
    console.log('\n' + '─'.repeat(80));
    console.log('VOLUME-BASED STRESS DETECTION');
    console.log('─'.repeat(80));

    const volumeThresholds = [1.5, 2.0, 2.5, 3.0];

    console.log('\nStrategy: Apply insurance when BTC volume > Xx average\n');
    console.log('Volume Thresh | Insurance PnL | Δ vs Baseline | Triggers | % Trades');
    console.log('--------------|---------------|---------------|----------|----------');

    for (const volThresh of volumeThresholds) {
      let pnl = 0;
      let triggered = 0;

      for (const t of tradesWithData) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;

        const highVolume = t.btcVolumeRatio! >= volThresh;

        if (highVolume && peakRoe >= INSURANCE_THRESHOLD) {
          triggered++;
          const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          pnl += halfA + halfB;
        } else {
          pnl += (finalRoe / 100) * margin;
        }
      }

      const delta = pnl - baselinePnl;
      const stressTrades = tradesWithData.filter(t => t.btcVolumeRatio! >= volThresh).length;
      const pctTrades = (stressTrades / tradesWithData.length * 100).toFixed(0);

      console.log(
        `Vol >= ${volThresh.toFixed(1)}x avg | ` +
        `$${pnl.toFixed(2).padStart(12)} | ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(12)} | ` +
        `${String(triggered).padStart(8)} | ` +
        `${pctTrades.padStart(7)}%`
      );
    }

    // Combined: High volume + BTC direction
    console.log('\n' + '─'.repeat(80));
    console.log('COMBINED: High Volume + BTC Direction');
    console.log('─'.repeat(80));
    console.log('\nStrategy: Apply insurance when high volume + specific BTC direction\n');

    const combos = [
      { volThresh: 1.5, btcDir: 'up', label: 'Vol >= 1.5x + BTC UP (pump)' },
      { volThresh: 1.5, btcDir: 'down', label: 'Vol >= 1.5x + BTC DOWN (dump)' },
      { volThresh: 2.0, btcDir: 'up', label: 'Vol >= 2.0x + BTC UP (pump)' },
      { volThresh: 2.0, btcDir: 'down', label: 'Vol >= 2.0x + BTC DOWN (dump)' },
    ];

    console.log('Condition               | Insurance PnL | Δ vs Baseline | Triggers');
    console.log('------------------------|---------------|---------------|----------');

    for (const combo of combos) {
      let pnl = 0;
      let triggered = 0;

      for (const t of tradesWithData) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;

        const highVolume = t.btcVolumeRatio! >= combo.volThresh;
        const btcUp = t.btcChange1h! > 0;
        const dirMatch = combo.btcDir === 'up' ? btcUp : !btcUp;

        if (highVolume && dirMatch && peakRoe >= INSURANCE_THRESHOLD) {
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
        `${combo.label.padEnd(23)} | ` +
        `$${pnl.toFixed(2).padStart(12)} | ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(12)} | ` +
        `${String(triggered).padStart(8)}`
      );
    }

    // Compare to hourly WR
    console.log('\n' + '─'.repeat(80));
    console.log('COMPARISON TO HOURLY WR STRESS');
    console.log('─'.repeat(80));

    // Calculate hourly WR baseline
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

    let hourlyWrPnl = 0;
    let hourlyWrTriggered = 0;
    for (const t of tradesWithData) {
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
        hourlyWrPnl += halfA + halfB;
      } else {
        hourlyWrPnl += (finalRoe / 100) * margin;
      }
    }

    console.log(`\nBaseline (full ride): $${baselinePnl.toFixed(2)}`);
    console.log(`Hourly WR <50% stress: $${hourlyWrPnl.toFixed(2)} (Δ: +$${(hourlyWrPnl - baselinePnl).toFixed(2)}, ${hourlyWrTriggered} triggers)`);

    // Find best volume-based strategy
    let bestVolPnl = baselinePnl;
    let bestVolStrategy = 'None';
    for (const volThresh of volumeThresholds) {
      let pnl = 0;
      for (const t of tradesWithData) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;
        if (t.btcVolumeRatio! >= volThresh && peakRoe >= INSURANCE_THRESHOLD) {
          const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          pnl += halfA + halfB;
        } else {
          pnl += (finalRoe / 100) * margin;
        }
      }
      if (pnl > bestVolPnl) {
        bestVolPnl = pnl;
        bestVolStrategy = `Vol >= ${volThresh}x`;
      }
    }

    console.log(`Best volume-based: $${bestVolPnl.toFixed(2)} (${bestVolStrategy})`);

    // Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('CONCLUSION');
    console.log('═'.repeat(80));

    if (hourlyWrPnl > bestVolPnl) {
      console.log(`\n❌ Volume-based stress detection UNDERPERFORMS hourly WR by $${(hourlyWrPnl - bestVolPnl).toFixed(2)}`);
      console.log(`   Keep using hourly WR < 50% as stress signal`);
    } else {
      console.log(`\n✅ Volume-based stress detection (${bestVolStrategy}) OUTPERFORMS by $${(bestVolPnl - hourlyWrPnl).toFixed(2)}`);
      console.log(`   Consider switching to volume-based stress signal`);
    }

    console.log(`\nKey insight: Volume spikes ${bestVolPnl > hourlyWrPnl ? 'DO' : 'do NOT'} reliably indicate regime change for this strategy.`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
