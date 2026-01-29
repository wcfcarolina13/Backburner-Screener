/**
 * Backtest 1: Regime-Conditional Insurance Strategy
 *
 * Hypothesis: Insurance (sell 50% at first bounce, move SL to BE) hurts during
 * bull markets but might help during selloffs/stress periods.
 *
 * Approach:
 * 1. Identify "stress" hours (win rate < 50% in rolling 2h window)
 * 2. Apply insurance ONLY during stress periods
 * 3. Compare: full ride always vs insurance always vs conditional insurance
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
  losses: number;
  winRate: number;
  totalRoe: number;
  isStress: boolean;  // Win rate < threshold
}

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('REGIME-CONDITIONAL INSURANCE BACKTEST');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const STRESS_WIN_RATE_THRESHOLD = 50;  // Consider <50% WR as stress
  const INSURANCE_THRESHOLDS = [2, 3, 5];  // Test multiple thresholds
  const MARGIN_PER_TRADE = 10;

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Get all closed trades directly (no need to match - close events have all data)
    console.log(`Loading trades since ${cutoff}...\n`);

    const closeEvents = await client.execute({
      sql: `
        SELECT
          symbol, direction, timestamp as exit_time, entry_price, exit_price,
          exit_reason, realized_pnl_percent, highest_pnl_percent, leverage, margin_used
        FROM trade_events
        WHERE bot_id = 'exp-bb-sysB'
          AND event_type = 'close'
          AND timestamp >= ?
        ORDER BY timestamp ASC
      `,
      args: [cutoff]
    });

    const trades: TradeRecord[] = closeEvents.rows.map(row => ({
      symbol: row.symbol as string,
      direction: row.direction as string,
      entryTime: row.exit_time as string,  // Using exit time since we don't have entry
      exitTime: row.exit_time as string,
      entryPrice: Number(row.entry_price) || 0,
      exitPrice: Number(row.exit_price) || 0,
      leverage: Number(row.leverage) || 20,
      marginUsed: Number(row.margin_used) || MARGIN_PER_TRADE,
      exitReason: row.exit_reason as string,
      realizedPnlPercent: Number(row.realized_pnl_percent) || 0,
      highestPnlPercent: row.highest_pnl_percent != null ? Number(row.highest_pnl_percent) : null
    }));

    console.log(`Loaded ${trades.length} closed trades\n`);

    // 2. Calculate hourly win rates to identify stress periods
    const hourlyStats = new Map<string, HourlyStats>();

    for (const t of trades) {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      if (!hourlyStats.has(hour)) {
        hourlyStats.set(hour, {
          hour,
          trades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalRoe: 0,
          isStress: false
        });
      }

      const stats = hourlyStats.get(hour)!;
      stats.trades++;
      stats.totalRoe += t.realizedPnlPercent;

      if (t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0) {
        stats.wins++;
      } else {
        stats.losses++;
      }
    }

    // Calculate win rates and mark stress periods
    for (const stats of hourlyStats.values()) {
      stats.winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
      stats.isStress = stats.winRate < STRESS_WIN_RATE_THRESHOLD;
    }

    // 3. Show hourly breakdown
    console.log('─'.repeat(80));
    console.log('HOURLY WIN RATE ANALYSIS');
    console.log('─'.repeat(80));
    console.log('Hour (UTC)           | Trades | Wins | WR%   | ROE%    | Stress?');
    console.log('---------------------|--------|------|-------|---------|--------');

    const sortedHours = Array.from(hourlyStats.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    let stressHours = 0;
    let normalHours = 0;

    for (const stats of sortedHours.slice(-24)) {  // Last 24 hours
      const stressMarker = stats.isStress ? '  YES' : '  no';
      console.log(
        `${stats.hour} | ${String(stats.trades).padStart(6)} | ${String(stats.wins).padStart(4)} | ` +
        `${stats.winRate.toFixed(0).padStart(4)}% | ${(stats.totalRoe >= 0 ? '+' : '') + stats.totalRoe.toFixed(1).padStart(6)}% | ${stressMarker}`
      );
      if (stats.isStress) stressHours++;
      else normalHours++;
    }

    console.log(`\nStress hours (WR < ${STRESS_WIN_RATE_THRESHOLD}%): ${stressHours}/${stressHours + normalHours}`);

    // 4. Create a lookup for trade → stress status
    const tradeStressStatus = new Map<string, boolean>();
    for (const t of trades) {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      const stats = hourlyStats.get(hour);
      tradeStressStatus.set(`${t.symbol}-${t.direction}-${t.exitTime}`, stats?.isStress || false);
    }

    // 5. Simulate strategies at multiple thresholds
    console.log('\n' + '─'.repeat(80));
    console.log('STRATEGY COMPARISON (Multiple Thresholds)');
    console.log('─'.repeat(80));

    const tradesWithPeak = trades.filter(t => t.highestPnlPercent !== null);
    console.log(`\nTrades with peak data: ${tradesWithPeak.length}/${trades.length}`);

    // Strategy A: Current (full ride) - baseline
    let strategyA_pnl = 0;
    for (const t of tradesWithPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      strategyA_pnl += (t.realizedPnlPercent / 100) * margin;
    }
    console.log(`\nBaseline (Full Ride): $${strategyA_pnl.toFixed(2)}\n`);

    console.log('Thresh | Always Ins. PnL | Δ vs Full | Conditional PnL | Δ vs Full | Stress Trades');
    console.log('-------|-----------------|-----------|-----------------|-----------|-------------');

    for (const INSURANCE_THRESHOLD of INSURANCE_THRESHOLDS) {
      // Strategy B: Always insurance
      let strategyB_pnl = 0;
      let strategyB_triggered = 0;
      let strategyB_saved = 0;

      // Strategy C: Conditional insurance (only during stress)
      let strategyC_pnl = 0;
      let strategyC_triggered = 0;
      let strategyC_saved = 0;
      let strategyC_stress_trades = 0;

      for (const t of tradesWithPeak) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;
        const hour = t.exitTime.slice(0, 13) + ':00:00';
        const isStress = hourlyStats.get(hour)?.isStress || false;

        const fullRidePnl = (finalRoe / 100) * margin;

        // Strategy B: Always insurance
        if (peakRoe >= INSURANCE_THRESHOLD) {
          strategyB_triggered++;
          const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          if (finalRoe < 0) strategyB_saved++;
          strategyB_pnl += halfA + halfB;
        } else {
          strategyB_pnl += fullRidePnl;
        }

        // Strategy C: Conditional insurance (only during stress)
        if (isStress) {
          strategyC_stress_trades++;
          if (peakRoe >= INSURANCE_THRESHOLD) {
            strategyC_triggered++;
            const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
            const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
            if (finalRoe < 0) strategyC_saved++;
            strategyC_pnl += halfA + halfB;
          } else {
            strategyC_pnl += fullRidePnl;
          }
        } else {
          // Normal period - full ride
          strategyC_pnl += fullRidePnl;
        }
      }

      const bVsA = strategyB_pnl - strategyA_pnl;
      const cVsA = strategyC_pnl - strategyA_pnl;

      console.log(
        `${String(INSURANCE_THRESHOLD).padStart(5)}% | $${strategyB_pnl.toFixed(2).padStart(14)} | ` +
        `${(bVsA >= 0 ? '+' : '') + bVsA.toFixed(2).padStart(8)} | ` +
        `$${strategyC_pnl.toFixed(2).padStart(14)} | ` +
        `${(cVsA >= 0 ? '+' : '') + cVsA.toFixed(2).padStart(8)} | ` +
        `${strategyC_stress_trades}/${tradesWithPeak.length}`
      );
    }

    // Find best threshold
    let bestThreshold = INSURANCE_THRESHOLDS[0];
    let bestPnl = -Infinity;
    for (const thresh of INSURANCE_THRESHOLDS) {
      let pnl = 0;
      for (const t of tradesWithPeak) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent!;
        const hour = t.exitTime.slice(0, 13) + ':00:00';
        const isStress = hourlyStats.get(hour)?.isStress || false;

        if (isStress && peakRoe >= thresh) {
          const halfA = (thresh / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          pnl += halfA + halfB;
        } else {
          pnl += (finalRoe / 100) * margin;
        }
      }
      if (pnl > bestPnl) {
        bestPnl = pnl;
        bestThreshold = thresh;
      }
    }

    console.log(`\nBest conditional insurance threshold: ${bestThreshold}% (PnL: $${bestPnl.toFixed(2)})`);
    console.log(`Improvement over full ride: ${(bestPnl - strategyA_pnl >= 0 ? '+' : '')}$${(bestPnl - strategyA_pnl).toFixed(2)}`);

    // 6. Deeper analysis - show stress period performance
    console.log('\n' + '─'.repeat(80));
    console.log('STRESS vs NORMAL PERIOD BREAKDOWN');
    console.log('─'.repeat(80));

    const stressTrades = tradesWithPeak.filter(t => {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      return hourlyStats.get(hour)?.isStress || false;
    });

    const normalTrades = tradesWithPeak.filter(t => {
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      return !(hourlyStats.get(hour)?.isStress || false);
    });

    function analyzeSubset(label: string, subset: TradeRecord[], insuranceThresh: number) {
      if (subset.length === 0) {
        console.log(`\n${label}: No trades`);
        return;
      }
      const wins = subset.filter(t => t.exitReason === 'trailing_stop' || t.realizedPnlPercent > 0);
      const winRate = (wins.length / subset.length * 100).toFixed(0);
      const totalRoe = subset.reduce((s, t) => s + t.realizedPnlPercent, 0);
      const avgPeak = subset.reduce((s, t) => s + (t.highestPnlPercent || 0), 0) / subset.length;

      // Insurance simulation for this subset
      let fullRidePnl = 0;
      let insurancePnl = 0;

      for (const t of subset) {
        const margin = t.marginUsed || MARGIN_PER_TRADE;
        const finalRoe = t.realizedPnlPercent;
        const peakRoe = t.highestPnlPercent || 0;

        fullRidePnl += (finalRoe / 100) * margin;

        if (peakRoe >= insuranceThresh) {
          const halfA = (insuranceThresh / 100) * (margin / 2);
          const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
          insurancePnl += halfA + halfB;
        } else {
          insurancePnl += (finalRoe / 100) * margin;
        }
      }

      const diff = insurancePnl - fullRidePnl;

      console.log(`\n${label}:`);
      console.log(`  Trades: ${subset.length} | Win Rate: ${winRate}% | Total ROE: ${totalRoe >= 0 ? '+' : ''}${totalRoe.toFixed(1)}%`);
      console.log(`  Avg Peak ROE: +${avgPeak.toFixed(1)}%`);
      console.log(`  Full Ride PnL: $${fullRidePnl.toFixed(2)} | Insurance @${insuranceThresh}% PnL: $${insurancePnl.toFixed(2)}`);
      console.log(`  Insurance ${diff >= 0 ? 'HELPS' : 'HURTS'}: ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)}`);
    }

    analyzeSubset('STRESS Periods (WR < 50%)', stressTrades, bestThreshold);
    analyzeSubset('NORMAL Periods (WR >= 50%)', normalTrades, bestThreshold);

    // 7. Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('CONCLUSION');
    console.log('═'.repeat(80));

    const improvementVsFullRide = bestPnl - strategyA_pnl;

    if (improvementVsFullRide > 0) {
      console.log(`\n✅ CONDITIONAL INSURANCE is BETTER than full ride by $${improvementVsFullRide.toFixed(2)}`);
      console.log(`   Best threshold: ${bestThreshold}% ROE`);
      console.log(`   Applying insurance only during stress periods (WR < ${STRESS_WIN_RATE_THRESHOLD}%) outperforms.`);
    } else {
      console.log(`\n❌ CONDITIONAL INSURANCE doesn't help`);
      console.log(`   Best strategy: Full Ride (current approach)`);
    }

    console.log(`\nKey insight: Insurance ${improvementVsFullRide > 0 ? 'CAN help during stress periods' : 'HURTS overall'} in this dataset.`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
