/**
 * Backtest 2: Two-Tranche Scaling-In Entry Strategy
 *
 * Hypothesis: During selloffs, entering in two tranches (50% at first trigger,
 * 50% at additional drop) gives better average entry price.
 *
 * Approach:
 * 1. Get trades with entry timestamps
 * 2. For stress-period trades, simulate two-tranche entry
 * 3. Compare PnL of full entry vs scaled entry
 *
 * Note: This is a simplified simulation without candle replay.
 * We estimate the second entry opportunity from the trade's eventual outcome.
 */

import { createClient } from '@libsql/client';

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

interface HourlyStats {
  hour: string;
  trades: number;
  wins: number;
  winRate: number;
  isStress: boolean;
}

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('TWO-TRANCHE SCALING-IN BACKTEST');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const STRESS_WIN_RATE_THRESHOLD = 50;
  const MARGIN_PER_TRADE = 10;
  const SECOND_ENTRY_DROP_THRESHOLDS = [0.5, 1, 1.5, 2, 3];  // Additional % drop for second entry

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Load closed trades
    console.log(`Loading trades since ${cutoff}...\n`);

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

    console.log(`Loaded ${trades.length} closed trades`);

    // 2. Calculate hourly win rates
    const hourlyStats = new Map<string, HourlyStats>();
    for (const t of trades) {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      if (!hourlyStats.has(hour)) {
        hourlyStats.set(hour, { hour, trades: 0, wins: 0, winRate: 0, isStress: false });
      }
      const stats = hourlyStats.get(hour)!;
      stats.trades++;
      if (t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0) {
        stats.wins++;
      }
    }

    for (const stats of hourlyStats.values()) {
      stats.winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
      stats.isStress = stats.winRate < STRESS_WIN_RATE_THRESHOLD;
    }

    // 3. Identify stress vs normal periods
    const stressTrades = trades.filter(t => {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      return hourlyStats.get(hour)?.isStress || false;
    });

    const normalTrades = trades.filter(t => {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      return !(hourlyStats.get(hour)?.isStress || false);
    });

    console.log(`\nStress period trades: ${stressTrades.length}`);
    console.log(`Normal period trades: ${normalTrades.length}`);

    // 4. For SL trades in stress periods, analyze how much lower they went
    console.log('\n' + '─'.repeat(80));
    console.log('ANALYZING STRESS-PERIOD SL TRADES');
    console.log('─'.repeat(80));

    const stressSLTrades = stressTrades.filter(t => t.exitReason === 'stop_loss');
    console.log(`\nSL trades in stress periods: ${stressSLTrades.length}`);

    // Since we have entry_price and exit_price (which for SL is the SL price),
    // we know the trade dropped at least to SL level.
    // For longs: SL hit means price dropped (exitPrice < entryPrice)
    // We can estimate that if second entry was at midpoint, we'd have better avg

    console.log('\n' + '─'.repeat(80));
    console.log('TWO-TRANCHE ENTRY SIMULATION');
    console.log('─'.repeat(80));
    console.log('\nScenario: Enter 50% at signal, wait for X% additional drop for second 50%');
    console.log('If price never drops X% more, only use 50% position.\n');

    // Calculate improvement potential
    // For each SL trade, if we had entered at a better avg price, the loss would be smaller
    // For each winning trade, the gain would be larger if price dipped before running

    console.log('Drop % | Stress PnL (scaled) | Δ vs Full Entry | Normal PnL (scaled) | Δ vs Full Entry');
    console.log('-------|---------------------|-----------------|---------------------|----------------');

    // Baseline: full entry at signal price
    const stressFullEntryPnl = stressTrades.reduce((sum, t) =>
      sum + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);
    const normalFullEntryPnl = normalTrades.reduce((sum, t) =>
      sum + (t.realizedPnlPercent / 100) * (t.marginUsed || MARGIN_PER_TRADE), 0);

    console.log(`  Full | $${stressFullEntryPnl.toFixed(2).padStart(18)} |     (baseline)  | $${normalFullEntryPnl.toFixed(2).padStart(18)} |    (baseline)`);

    for (const dropThreshold of SECOND_ENTRY_DROP_THRESHOLDS) {
      let stressScaledPnl = 0;
      let normalScaledPnl = 0;

      for (const t of stressTrades) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const leverage = t.leverage || 20;

        // Estimate if price dropped enough for second entry
        // For SL trades: they definitely dropped (that's why they stopped out)
        // For winning trades: use highest_pnl_percent to infer path

        // ROE formula: ROE% = priceChange% * leverage
        // So priceChange% = ROE% / leverage

        // SL price change: (entry - exit) / entry * 100 = (exitReason=SL means price went against us)
        const priceChange = t.direction === 'long'
          ? (t.entryPrice - t.exitPrice) / t.entryPrice * 100
          : (t.exitPrice - t.entryPrice) / t.entryPrice * 100;

        // If this is an SL trade, the price definitely dropped by priceChange%
        // If priceChange > dropThreshold, second entry would have triggered

        if (t.exitReason === 'stop_loss') {
          // Trade ended in SL
          if (priceChange >= dropThreshold) {
            // Second entry would have triggered at entry - dropThreshold%
            // New avg entry = (entry + entry*(1-dropThreshold/100)) / 2
            // = entry * (2 - dropThreshold/100) / 2
            // = entry * (1 - dropThreshold/200)
            const avgEntryImprovement = dropThreshold / 200; // Half position at dropThreshold lower
            // This improves our ROE by avgEntryImprovement * leverage
            const improvedRoe = t.realizedPnlPercent + (avgEntryImprovement * leverage * 100);
            stressScaledPnl += (improvedRoe / 100) * margin;
          } else {
            // Price didn't drop enough - only 50% position
            stressScaledPnl += (t.realizedPnlPercent / 100) * (margin / 2);
          }
        } else {
          // Winning trade - assume price dipped slightly before running
          // Use highest_pnl_percent to estimate: if peak was high, price probably ran immediately
          // If peak was modest, there may have been a dip
          // This is an approximation - real backtest would need candle data
          const peakRoe = t.highestPnlPercent || t.realizedPnlPercent;

          // Heuristic: if peak ROE > 15%, price probably ran without much dip
          // If peak ROE < 15%, there might have been entry opportunity
          if (peakRoe < 15) {
            // Assume partial benefit from scaling in
            const benefit = Math.min(dropThreshold / 200, 0.005) * leverage * 100;
            stressScaledPnl += ((t.realizedPnlPercent + benefit) / 100) * margin;
          } else {
            // Full entry was fine
            stressScaledPnl += (t.realizedPnlPercent / 100) * margin;
          }
        }
      }

      // For normal trades, apply same logic
      for (const t of normalTrades) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const leverage = t.leverage || 20;

        const priceChange = t.direction === 'long'
          ? (t.entryPrice - t.exitPrice) / t.entryPrice * 100
          : (t.exitPrice - t.entryPrice) / t.entryPrice * 100;

        if (t.exitReason === 'stop_loss') {
          if (priceChange >= dropThreshold) {
            const avgEntryImprovement = dropThreshold / 200;
            const improvedRoe = t.realizedPnlPercent + (avgEntryImprovement * leverage * 100);
            normalScaledPnl += (improvedRoe / 100) * margin;
          } else {
            normalScaledPnl += (t.realizedPnlPercent / 100) * (margin / 2);
          }
        } else {
          normalScaledPnl += (t.realizedPnlPercent / 100) * margin;
        }
      }

      const stressDelta = stressScaledPnl - stressFullEntryPnl;
      const normalDelta = normalScaledPnl - normalFullEntryPnl;

      console.log(
        `${String(dropThreshold).padStart(5)}% | $${stressScaledPnl.toFixed(2).padStart(18)} | ` +
        `${(stressDelta >= 0 ? '+' : '') + stressDelta.toFixed(2).padStart(14)} | ` +
        `$${normalScaledPnl.toFixed(2).padStart(18)} | ` +
        `${(normalDelta >= 0 ? '+' : '') + normalDelta.toFixed(2).padStart(13)}`
      );
    }

    // 5. Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('ANALYSIS NOTES');
    console.log('═'.repeat(80));
    console.log(`
This simulation estimates two-tranche entry benefits using heuristics:
- For SL trades: We know price dropped at least to SL level
- For winning trades: We estimate based on peak ROE (high peak = immediate run)

Limitations:
- Without candle replay, we can't know exact second entry points
- RSI re-trigger logic not simulated (would need indicator recalc)

For accurate results, implement candle-based backtest with:
1. Fetch 1m candles from entry time
2. Simulate RSI calculation at each candle
3. Trigger second entry when RSI < 25 OR price drops X%
4. Calculate true average entry price

Next step: Implement proper candle replay backtest if this shows promise.
`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
