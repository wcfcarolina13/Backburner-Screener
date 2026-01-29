/**
 * Backtest 4: Combined Insurance + Two-Tranche Scaling-In
 *
 * Hypothesis: Stacking both improvements compounds gains.
 *
 * Strategy:
 * 1. Two-tranche entry: 50% at signal, 50% at additional drop
 * 2. Conditional insurance on BOTH tranches during stress
 *
 * Expected improvement: +$706 (insurance) + ~$1,463 (scaling) = ~$2,169
 * But may not be additive - let's test.
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

interface HourlyStats {
  hour: string;
  trades: number;
  wins: number;
  winRate: number;
  isStress: boolean;
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

function getBtcChange(entryTime: string, lookbackHours: number): number | null {
  const entryTs = new Date(entryTime).getTime();
  const currentCandle = btcCandles.find(c => c.timestamp <= entryTs && c.timestamp + 3600000 > entryTs);
  if (!currentCandle) return null;
  const lookbackTs = entryTs - (lookbackHours * 3600000);
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
  console.log('COMBINED STRATEGIES BACKTEST');
  console.log('========================================\n');

  // Configuration
  const LOOKBACK_DAYS = 7;
  const STRESS_WIN_RATE_THRESHOLD = 50;
  const INSURANCE_THRESHOLD = 2;
  const SCALING_DROP_THRESHOLD = 1; // % additional drop for second entry
  const MARGIN_PER_TRADE = 10;

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Fetch BTC candles
    await fetchBtcCandles();

    // 2. Load trades
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

    console.log(`Loaded ${trades.length} trades\n`);

    // 3. Calculate hourly win rates
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

    // Filter trades with peak data
    const tradesWithPeak = trades.filter(t => t.highestPnlPercent !== null);
    console.log(`Trades with peak data: ${tradesWithPeak.length}/${trades.length}`);

    // 4. Simulate strategies
    console.log('\n' + '─'.repeat(80));
    console.log('STRATEGY COMPARISON');
    console.log('─'.repeat(80));

    // Strategy A: Baseline (full ride, no modifications)
    let strategyA_pnl = 0;
    for (const t of tradesWithPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      strategyA_pnl += (t.realizedPnlPercent / 100) * margin;
    }

    // Strategy B: Insurance only (from Backtest 1)
    let strategyB_pnl = 0;
    for (const t of tradesWithPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      const finalRoe = t.realizedPnlPercent;
      const peakRoe = t.highestPnlPercent!;
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      const isStress = hourlyStats.get(hour)?.isStress || false;

      if (isStress && peakRoe >= INSURANCE_THRESHOLD) {
        const halfA = (INSURANCE_THRESHOLD / 100) * (margin / 2);
        const halfB = finalRoe < 0 ? 0 : (finalRoe / 100) * (margin / 2);
        strategyB_pnl += halfA + halfB;
      } else {
        strategyB_pnl += (finalRoe / 100) * margin;
      }
    }

    // Strategy C: Scaling only (from Backtest 2 - heuristic)
    let strategyC_pnl = 0;
    for (const t of tradesWithPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      const leverage = t.leverage || 20;
      const finalRoe = t.realizedPnlPercent;

      // For SL trades, scaling would have improved avg entry
      if (t.exitReason === 'stop_loss') {
        const priceChange = t.direction === 'long'
          ? (t.entryPrice - t.exitPrice) / t.entryPrice * 100
          : (t.exitPrice - t.entryPrice) / t.entryPrice * 100;

        if (priceChange >= SCALING_DROP_THRESHOLD) {
          // Second entry triggered - better avg entry
          const avgEntryImprovement = SCALING_DROP_THRESHOLD / 200;
          const improvedRoe = finalRoe + (avgEntryImprovement * leverage * 100);
          strategyC_pnl += (improvedRoe / 100) * margin;
        } else {
          // Only half position (second entry never triggered)
          strategyC_pnl += (finalRoe / 100) * (margin / 2);
        }
      } else {
        // Winners - full ride
        strategyC_pnl += (finalRoe / 100) * margin;
      }
    }

    // Strategy D: COMBINED (Insurance + Scaling)
    let strategyD_pnl = 0;
    let combined_insurance_triggered = 0;
    let combined_scaling_triggered = 0;
    let combined_both_triggered = 0;

    for (const t of tradesWithPeak) {
      const margin = t.marginUsed || MARGIN_PER_TRADE;
      const leverage = t.leverage || 20;
      const finalRoe = t.realizedPnlPercent;
      const peakRoe = t.highestPnlPercent!;
      const hour = t.exitTime.slice(0, 13) + ':00:00';
      const isStress = hourlyStats.get(hour)?.isStress || false;

      // Determine if scaling would trigger
      let scalingTriggered = false;
      let effectiveMargin = margin;
      let adjustedRoe = finalRoe;

      if (t.exitReason === 'stop_loss') {
        const priceChange = t.direction === 'long'
          ? (t.entryPrice - t.exitPrice) / t.entryPrice * 100
          : (t.exitPrice - t.entryPrice) / t.entryPrice * 100;

        if (priceChange >= SCALING_DROP_THRESHOLD) {
          scalingTriggered = true;
          combined_scaling_triggered++;
          const avgEntryImprovement = SCALING_DROP_THRESHOLD / 200;
          adjustedRoe = finalRoe + (avgEntryImprovement * leverage * 100);
        } else {
          // Only half position
          effectiveMargin = margin / 2;
        }
      }

      // Apply insurance on top (if stress + peak reached)
      if (isStress && peakRoe >= INSURANCE_THRESHOLD) {
        combined_insurance_triggered++;
        if (scalingTriggered) combined_both_triggered++;

        const halfA = (INSURANCE_THRESHOLD / 100) * (effectiveMargin / 2);
        const halfB = adjustedRoe < 0 ? 0 : (adjustedRoe / 100) * (effectiveMargin / 2);
        strategyD_pnl += halfA + halfB;
      } else {
        strategyD_pnl += (adjustedRoe / 100) * effectiveMargin;
      }
    }

    // Results
    console.log('\n');
    console.log('Strategy                          | Total PnL  | Δ vs Baseline');
    console.log('----------------------------------|------------|-------------');
    console.log(`A: Baseline (full ride)           | $${strategyA_pnl.toFixed(2).padStart(9)} | (baseline)`);
    console.log(`B: Conditional Insurance @${INSURANCE_THRESHOLD}%      | $${strategyB_pnl.toFixed(2).padStart(9)} | ${(strategyB_pnl - strategyA_pnl >= 0 ? '+' : '')}$${(strategyB_pnl - strategyA_pnl).toFixed(2)}`);
    console.log(`C: Scaling-In @${SCALING_DROP_THRESHOLD}% drop            | $${strategyC_pnl.toFixed(2).padStart(9)} | ${(strategyC_pnl - strategyA_pnl >= 0 ? '+' : '')}$${(strategyC_pnl - strategyA_pnl).toFixed(2)}`);
    console.log(`D: COMBINED (Insurance + Scaling) | $${strategyD_pnl.toFixed(2).padStart(9)} | ${(strategyD_pnl - strategyA_pnl >= 0 ? '+' : '')}$${(strategyD_pnl - strategyA_pnl).toFixed(2)}`);

    const expectedAdditive = (strategyB_pnl - strategyA_pnl) + (strategyC_pnl - strategyA_pnl);
    const actualCombined = strategyD_pnl - strategyA_pnl;
    const synergy = actualCombined - expectedAdditive;

    console.log('\n' + '─'.repeat(80));
    console.log('SYNERGY ANALYSIS');
    console.log('─'.repeat(80));
    console.log(`\nInsurance improvement:  +$${(strategyB_pnl - strategyA_pnl).toFixed(2)}`);
    console.log(`Scaling improvement:    +$${(strategyC_pnl - strategyA_pnl).toFixed(2)}`);
    console.log(`Expected if additive:   +$${expectedAdditive.toFixed(2)}`);
    console.log(`Actual combined:        +$${actualCombined.toFixed(2)}`);
    console.log(`Synergy (or overlap):   ${synergy >= 0 ? '+' : ''}$${synergy.toFixed(2)}`);

    console.log(`\nTrigger stats:`);
    console.log(`  Insurance triggered: ${combined_insurance_triggered} trades`);
    console.log(`  Scaling triggered:   ${combined_scaling_triggered} trades`);
    console.log(`  Both triggered:      ${combined_both_triggered} trades`);

    // 5. Conclusion
    console.log('\n' + '═'.repeat(80));
    console.log('CONCLUSION');
    console.log('═'.repeat(80));

    const bestStrategy = [
      { name: 'Baseline', pnl: strategyA_pnl },
      { name: 'Insurance Only', pnl: strategyB_pnl },
      { name: 'Scaling Only', pnl: strategyC_pnl },
      { name: 'Combined', pnl: strategyD_pnl },
    ].sort((a, b) => b.pnl - a.pnl)[0];

    console.log(`\n✅ Best strategy: ${bestStrategy.name} ($${bestStrategy.pnl.toFixed(2)})`);

    if (synergy > 0) {
      console.log(`\n📈 Positive synergy: Combined is BETTER than sum of parts by $${synergy.toFixed(2)}`);
    } else if (synergy < -50) {
      console.log(`\n⚠️ Overlap/diminishing returns: Combined is WORSE than sum by $${Math.abs(synergy).toFixed(2)}`);
      console.log(`   This happens when both strategies protect the same trades.`);
    } else {
      console.log(`\n≈ Roughly additive: Combined is close to sum of individual improvements`);
    }

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

main();
