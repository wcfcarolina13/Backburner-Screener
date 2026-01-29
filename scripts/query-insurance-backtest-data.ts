/**
 * Query exp-bb-sysB trade data for insurance sale backtest
 * Gets matched open/close pairs with all needed fields for candle replay
 */

import { createClient } from '@libsql/client';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';

async function queryBacktestData() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) {
    console.error('ERROR: TURSO_AUTH_TOKEN not set');
    process.exit(1);
  }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('========================================');
  console.log('EXP-BB-SYSB TRADE DATA FOR INSURANCE BACKTEST');
  console.log('========================================\n');

  try {
    // Get exp-bb-sysB trade stats for last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    console.log(`Cutoff time: ${cutoff}\n`);

    // Query for closed trades with highest_pnl_percent (key for insurance sim)
    const trades = await client.execute({
      sql: `
        SELECT
          symbol,
          direction,
          event_type,
          entry_price,
          exit_price,
          realized_pnl,
          realized_pnl_percent,
          exit_reason,
          leverage,
          margin_used,
          notional_size,
          timestamp,
          highest_pnl_percent,
          trail_activated,
          duration_ms,
          execution_mode
        FROM trade_events
        WHERE bot_id = 'exp-bb-sysB'
          AND timestamp >= ?
        ORDER BY timestamp ASC
      `,
      args: [cutoff]
    });

    console.log(`Found ${trades.rows.length} trade events in last 48h\n`);

    // Group by open/close pairs
    const openTrades: Map<string, any> = new Map();
    const completedTrades: any[] = [];

    for (const row of trades.rows) {
      const key = `${row.symbol}-${row.direction}`;

      if (row.event_type === 'open') {
        openTrades.set(key, row);
      } else if (row.event_type === 'close') {
        const openTrade = openTrades.get(key);
        if (openTrade) {
          const leverage = Number(openTrade.leverage) || 20;
          const entryPrice = Number(openTrade.entry_price);
          const exitPrice = Number(row.exit_price);
          const direction = row.direction as string;

          // Calculate ROE% manually
          const priceChange = direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;
          const calculatedRoe = priceChange * leverage * 100;

          completedTrades.push({
            symbol: row.symbol,
            direction: direction,
            leverage: leverage,
            entryPrice: entryPrice,
            exitPrice: exitPrice,
            entryTime: openTrade.timestamp,
            exitTime: row.timestamp,
            realizedPnlPercent: row.realized_pnl_percent ? Number(row.realized_pnl_percent) : calculatedRoe,
            calculatedRoe: calculatedRoe,
            exitReason: row.exit_reason,
            highestPnlPercent: row.highest_pnl_percent ? Number(row.highest_pnl_percent) : null,
            trailActivated: row.trail_activated === 1,
            marginUsed: Number(openTrade.margin_used) || 10,
            notionalSize: Number(openTrade.notional_size) || 200,
            durationMs: row.duration_ms ? Number(row.duration_ms) : null,
            executionMode: row.execution_mode
          });
          openTrades.delete(key);
        }
      }
    }

    console.log(`Matched ${completedTrades.length} complete trades\n`);

    // Stats breakdown by exit reason
    console.log('EXIT REASON BREAKDOWN:');
    console.log('─'.repeat(80));
    const byReason: Record<string, { count: number; avgRoe: number; trades: any[] }> = {};
    for (const t of completedTrades) {
      const reason = t.exitReason || 'unknown';
      if (!byReason[reason]) byReason[reason] = { count: 0, avgRoe: 0, trades: [] };
      byReason[reason].count++;
      byReason[reason].trades.push(t);
    }
    for (const [reason, data] of Object.entries(byReason)) {
      const avgRoe = data.trades.reduce((sum, t) => sum + t.calculatedRoe, 0) / data.trades.length;
      const highestPnlAvg = data.trades.filter(t => t.highestPnlPercent !== null)
        .reduce((sum, t, _, arr) => sum + t.highestPnlPercent / arr.length, 0);
      console.log(`  ${reason.padEnd(20)}: ${data.count} trades, avg ROE: ${avgRoe.toFixed(2)}%, avg peak: ${highestPnlAvg.toFixed(2)}%`);
    }

    // Key insight: How many trades reached insurance thresholds before final exit?
    console.log('\n' + '─'.repeat(80));
    console.log('INSURANCE THRESHOLD ANALYSIS (based on highest_pnl_percent):');
    console.log('─'.repeat(80));

    const thresholds = [1, 2, 3, 5, 10];
    for (const thresh of thresholds) {
      const tradesWithPeak = completedTrades.filter(t => t.highestPnlPercent !== null);
      const reachedThreshold = tradesWithPeak.filter(t => t.highestPnlPercent >= thresh);
      const slTrades = completedTrades.filter(t => t.exitReason === 'stop_loss');
      const slReachedThreshold = slTrades.filter(t => t.highestPnlPercent !== null && t.highestPnlPercent >= thresh);

      console.log(`\n  ${thresh}% ROE threshold:`);
      console.log(`    All trades: ${reachedThreshold.length}/${tradesWithPeak.length} (${(100*reachedThreshold.length/tradesWithPeak.length).toFixed(1)}%) reached ${thresh}%+ before exit`);
      console.log(`    SL trades:  ${slReachedThreshold.length}/${slTrades.length} (${slTrades.length > 0 ? (100*slReachedThreshold.length/slTrades.length).toFixed(1) : 0}%) had been up ${thresh}%+ before stopping out`);
    }

    // Simulate insurance strategy at different thresholds
    console.log('\n' + '─'.repeat(80));
    console.log('INSURANCE STRATEGY SIMULATION:');
    console.log('─'.repeat(80));
    console.log('Comparing: Current (full ride) vs TCG Insurance (sell 50% at X%, move SL to BE)');

    // Assume $10 margin per trade (from settings)
    const marginPerTrade = 10;

    for (const insuranceThresh of [1, 2, 3]) {
      console.log(`\n  === ${insuranceThresh}% ROE Insurance Threshold ===`);

      let currentStrategyPnl = 0;
      let insuranceStrategyPnl = 0;
      let insuranceTradesTriggered = 0;
      let insuranceSavedFromLoss = 0;

      for (const trade of completedTrades) {
        const finalRoe = trade.calculatedRoe;
        const peakRoe = trade.highestPnlPercent;

        // Current strategy: full ride to exit
        const currentPnl = (finalRoe / 100) * marginPerTrade;
        currentStrategyPnl += currentPnl;

        // Insurance strategy simulation
        if (peakRoe !== null && peakRoe >= insuranceThresh) {
          // Trade reached insurance threshold
          insuranceTradesTriggered++;

          // Half A: Locked in at insurance threshold
          const halfA_pnl = (insuranceThresh / 100) * (marginPerTrade / 2);

          // Half B: Either BE exit (if price came back) or trail exit
          let halfB_pnl: number;
          if (finalRoe < 0) {
            // Price came back below entry after hitting insurance → BE exit
            halfB_pnl = 0;
            insuranceSavedFromLoss++;
          } else {
            // Price stayed positive → let it ride to same exit as current
            halfB_pnl = (finalRoe / 100) * (marginPerTrade / 2);
          }

          insuranceStrategyPnl += halfA_pnl + halfB_pnl;
        } else {
          // Never reached insurance threshold → same as current (likely SL)
          insuranceStrategyPnl += currentPnl;
        }
      }

      const improvement = insuranceStrategyPnl - currentStrategyPnl;
      const pctImprovement = currentStrategyPnl !== 0 ? (improvement / Math.abs(currentStrategyPnl) * 100) : 0;

      console.log(`    Current Strategy PnL:   $${currentStrategyPnl.toFixed(2)}`);
      console.log(`    Insurance Strategy PnL: $${insuranceStrategyPnl.toFixed(2)}`);
      console.log(`    Difference:             $${improvement.toFixed(2)} (${improvement >= 0 ? '+' : ''}${pctImprovement.toFixed(1)}%)`);
      console.log(`    Trades triggering insurance: ${insuranceTradesTriggered}/${completedTrades.length}`);
      console.log(`    Times saved from full loss:  ${insuranceSavedFromLoss}`);
    }

    // Show trades where insurance would have helped most
    console.log('\n' + '─'.repeat(80));
    console.log('TRADES WHERE INSURANCE WOULD HAVE HELPED (was up 2%+, ended in SL):');
    console.log('─'.repeat(80));

    const couldHaveSaved = completedTrades
      .filter(t => t.exitReason === 'stop_loss' && t.highestPnlPercent !== null && t.highestPnlPercent >= 2)
      .sort((a, b) => b.highestPnlPercent - a.highestPnlPercent);

    couldHaveSaved.slice(0, 15).forEach(t => {
      console.log(
        `  ${t.symbol.padEnd(12)} ${t.direction.padEnd(6)} | ` +
        `Peak: +${t.highestPnlPercent.toFixed(1)}% ROE → Final: ${t.calculatedRoe.toFixed(1)}% | ` +
        `Lost opportunity: ~$${((t.highestPnlPercent / 100) * marginPerTrade / 2).toFixed(2)} on half`
      );
    });

    // JSON output for further analysis
    console.log('\n' + '─'.repeat(80));
    console.log(`Total completed trades: ${completedTrades.length}`);
    console.log(`With highest_pnl_percent data: ${completedTrades.filter(t => t.highestPnlPercent !== null).length}`);

  } catch (error) {
    console.error('Error:', error);
  }

  client.close();
}

queryBacktestData();
