/**
 * BACKTEST: exp-bb-sysB with Corrected Stop Loss Logic
 *
 * THE BUG: The ExperimentalShadowBot set stop loss as a raw PRICE percentage (8%),
 * but at 20x leverage, 8% price = 160% ROI loss. Liquidation would happen at ~5%
 * price move (100%/20). No liquidation check existed, so positions that should
 * have been liquidated could bounce back and appear profitable.
 *
 * APPROACH: Fetch candle data for each trade and replay with corrected exits.
 * Since Turso timestamps are ISO strings and entry_time/duration_ms are mostly null,
 * we match opens to closes by symbol and sequence.
 */

import { createClient } from '@libsql/client';

const TURSO_URL = 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io';
const BOT_ID = 'exp-bb-sysB';
const LEVERAGE = 20;
const SL_PERCENT = 8; // Config: 8% of PRICE (the bug)
const TRAIL_TRIGGER_PERCENT = 10; // ROI% to activate trailing
const TRAIL_STEP_PERCENT = 5; // ROI% trail step
const FEE_PERCENT = 0.04;
const SLIPPAGE_PERCENT = 0.05;
const POSITION_SIZE_PERCENT = 10;
const INITIAL_BALANCE = 2000;

const MEXC_BASE = 'https://contract.mexc.com';

interface TradeRecord {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  originalPnl: number;
  exitReason: string;
  openTime: Date;
  closeTime: Date;
  durationMs: number;
}

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SimResult {
  trade: TradeRecord;
  originalPnl: number;
  originalExitReason: string;
  // Scenario 1: Corrected SL (8% ROI = 0.4% price)
  correctedSL_pnl: number;
  correctedSL_exitReason: string;
  // Scenario 2: Original SL but with liquidation check
  liqEnforced_pnl: number;
  liqEnforced_exitReason: string;
  hasCandleData: boolean;
}

async function fetchFuturesKlines(symbol: string, startMs: number, endMs: number): Promise<CandleData[]> {
  const futuresSymbol = symbol.replace('USDT', '_USDT');
  try {
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const url = `${MEXC_BASE}/api/v1/contract/kline/${futuresSymbol}?interval=Min5&start=${startSec}&end=${endSec}`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const data = await response.json();
    if (!data.success || !data.data || !data.data.time) return [];

    const candles: CandleData[] = [];
    for (let i = 0; i < data.data.time.length; i++) {
      candles.push({
        time: data.data.time[i] * 1000,
        open: data.data.open[i],
        high: data.data.high[i],
        low: data.data.low[i],
        close: data.data.close[i],
      });
    }
    return candles;
  } catch (e) {
    return [];
  }
}

function simulateWithCandles(
  trade: TradeRecord,
  candles: CandleData[],
  positionSize: number,
): { sc1Pnl: number; sc1Reason: string; sc2Pnl: number; sc2Reason: string } {
  const entry = trade.entryPrice;
  const dir = trade.direction;

  // Scenario 1: Corrected SL — 8% ROI = 0.4% price distance
  const correctedSLDist = entry * (SL_PERCENT / 100 / LEVERAGE);
  let sc1_sl = dir === 'long' ? entry - correctedSLDist : entry + correctedSLDist;
  let sc1_exited = false;
  let sc1_exitPrice = 0;
  let sc1_reason = '';
  let sc1_hwm = 0;
  let sc1_trailing = false;

  // Scenario 2: Original SL (8% price) + liquidation
  const originalSLDist = entry * (SL_PERCENT / 100);
  let sc2_sl = dir === 'long' ? entry - originalSLDist : entry + originalSLDist;
  const liqDist = entry * (0.95 / LEVERAGE); // ~4.75%
  const liqPrice = dir === 'long' ? entry - liqDist : entry + liqDist;
  let sc2_exited = false;
  let sc2_exitPrice = 0;
  let sc2_reason = '';
  let sc2_hwm = 0;
  let sc2_trailing = false;

  for (const candle of candles) {
    if (sc1_exited && sc2_exited) break;

    // Determine extreme prices this candle
    const adverse = dir === 'long' ? candle.low : candle.high;
    const favorable = dir === 'long' ? candle.high : candle.low;

    // --- SC1: Corrected SL ---
    if (!sc1_exited) {
      if ((dir === 'long' && adverse <= sc1_sl) || (dir === 'short' && adverse >= sc1_sl)) {
        sc1_exitPrice = sc1_sl;
        sc1_reason = sc1_trailing ? 'trailing_stop' : 'stop_loss_corrected';
        sc1_exited = true;
      } else {
        const bestMove = dir === 'long'
          ? (favorable - entry) / entry
          : (entry - favorable) / entry;
        const bestRoi = bestMove * 100 * LEVERAGE;
        if (bestRoi > sc1_hwm) sc1_hwm = bestRoi;

        if (!sc1_trailing && sc1_hwm >= TRAIL_TRIGGER_PERCENT) {
          sc1_trailing = true;
          const beDist = entry * ((TRAIL_TRIGGER_PERCENT - TRAIL_STEP_PERCENT) / 100 / LEVERAGE);
          sc1_sl = dir === 'long' ? entry + beDist : entry - beDist;
        }
        if (sc1_trailing) {
          const trailPnl = sc1_hwm - TRAIL_STEP_PERCENT;
          if (trailPnl > 0) {
            const trailDist = entry * (trailPnl / 100 / LEVERAGE);
            const newStop = dir === 'long' ? entry + trailDist : entry - trailDist;
            if (dir === 'long' && newStop > sc1_sl) sc1_sl = newStop;
            else if (dir === 'short' && newStop < sc1_sl) sc1_sl = newStop;
          }
        }
      }
    }

    // --- SC2: Original SL + Liquidation ---
    if (!sc2_exited) {
      // Check liquidation first
      if ((dir === 'long' && adverse <= liqPrice) || (dir === 'short' && adverse >= liqPrice)) {
        sc2_exitPrice = liqPrice;
        sc2_reason = 'liquidated';
        sc2_exited = true;
      } else if ((dir === 'long' && adverse <= sc2_sl) || (dir === 'short' && adverse >= sc2_sl)) {
        sc2_exitPrice = sc2_sl;
        sc2_reason = sc2_trailing ? 'trailing_stop' : 'stop_loss';
        sc2_exited = true;
      } else {
        const bestMove = dir === 'long'
          ? (favorable - entry) / entry
          : (entry - favorable) / entry;
        const bestRoi = bestMove * 100 * LEVERAGE;
        if (bestRoi > sc2_hwm) sc2_hwm = bestRoi;

        if (!sc2_trailing && sc2_hwm >= TRAIL_TRIGGER_PERCENT) {
          sc2_trailing = true;
          const beDist = entry * ((TRAIL_TRIGGER_PERCENT - TRAIL_STEP_PERCENT) / 100 / LEVERAGE);
          sc2_sl = dir === 'long' ? entry + beDist : entry - beDist;
        }
        if (sc2_trailing) {
          const trailPnl = sc2_hwm - TRAIL_STEP_PERCENT;
          if (trailPnl > 0) {
            const trailDist = entry * (trailPnl / 100 / LEVERAGE);
            const newStop = dir === 'long' ? entry + trailDist : entry - trailDist;
            if (dir === 'long' && newStop > sc2_sl) sc2_sl = newStop;
            else if (dir === 'short' && newStop < sc2_sl) sc2_sl = newStop;
          }
        }
      }
    }
  }

  // If not exited, use original exit price
  if (!sc1_exited) { sc1_exitPrice = trade.exitPrice; sc1_reason = 'original_' + trade.exitReason; }
  if (!sc2_exited) { sc2_exitPrice = trade.exitPrice; sc2_reason = 'original_' + trade.exitReason; }

  return {
    sc1Pnl: calcPnl(entry, sc1_exitPrice, dir, positionSize),
    sc1Reason: sc1_reason,
    sc2Pnl: calcPnl(entry, sc2_exitPrice, dir, positionSize),
    sc2Reason: sc2_reason,
  };
}

function calcPnl(entry: number, exit: number, dir: 'long' | 'short', size: number): number {
  const diff = dir === 'long' ? exit - entry : entry - exit;
  const grossPnlPct = (diff / entry) * 100 * LEVERAGE;
  const grossPnl = size * (grossPnlPct / 100);
  const fees = size * (FEE_PERCENT / 100) * 2;
  return grossPnl - fees;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!authToken) { console.error('TURSO_AUTH_TOKEN not set'); process.exit(1); }

  const client = createClient({ url: TURSO_URL, authToken });

  console.log('=================================================');
  console.log('BACKTEST: exp-bb-sysB with Corrected Stop Loss');
  console.log('=================================================\n');
  console.log('THE BUG:');
  console.log('  SL set at 8% of PRICE, but at 20x leverage:');
  console.log('  - 8% price move = 160% ROI loss');
  console.log('  - Liquidation happens at ~5% price (100% margin loss)');
  console.log('  - No liquidation check → zombie positions bounce back\n');
  console.log('CORRECTION SCENARIOS:');
  console.log('  SC1: 8% ROI SL (= 0.4% price @ 20x) — what it should have been');
  console.log('  SC2: Keep 8% price SL but enforce liquidation at ~4.75%\n');

  // Step 1: Get all opens and closes, then match them
  const opens = await client.execute({
    sql: `SELECT symbol, direction, entry_price, timestamp, timeframe
    FROM trade_events
    WHERE bot_id = ? AND event_type = 'open' AND date >= date('now', '-7 days')
    ORDER BY timestamp ASC`,
    args: [BOT_ID],
  });

  const closes = await client.execute({
    sql: `SELECT symbol, direction, exit_price, realized_pnl, exit_reason, timestamp,
      trail_activated, highest_pnl_percent
    FROM trade_events
    WHERE bot_id = ? AND event_type = 'close' AND date >= date('now', '-7 days')
    ORDER BY timestamp ASC`,
    args: [BOT_ID],
  });

  console.log(`Raw events: ${opens.rows.length} opens, ${closes.rows.length} closes\n`);

  // Match opens to closes by symbol+direction sequence
  const trades: TradeRecord[] = [];
  const usedOpens = new Set<number>();
  const usedCloses = new Set<number>();

  for (let ci = 0; ci < closes.rows.length; ci++) {
    if (usedCloses.has(ci)) continue;
    const close = closes.rows[ci];

    // Skip duplicate closes (same symbol+direction+timestamp)
    if (ci > 0) {
      const prev = closes.rows[ci - 1];
      if (prev.symbol === close.symbol && prev.direction === close.direction &&
          prev.timestamp === close.timestamp) {
        usedCloses.add(ci);
        continue;
      }
    }

    // Find matching open
    for (let oi = 0; oi < opens.rows.length; oi++) {
      if (usedOpens.has(oi)) continue;
      const open = opens.rows[oi];
      if (open.symbol === close.symbol && open.direction === close.direction &&
          String(open.timestamp) <= String(close.timestamp)) {
        usedOpens.add(oi);
        usedCloses.add(ci);

        const openTime = new Date(String(open.timestamp));
        const closeTime = new Date(String(close.timestamp));

        trades.push({
          symbol: String(close.symbol),
          direction: String(close.direction) as 'long' | 'short',
          entryPrice: Number(open.entry_price),
          exitPrice: Number(close.exit_price),
          originalPnl: Number(close.realized_pnl),
          exitReason: String(close.exit_reason),
          openTime,
          closeTime,
          durationMs: closeTime.getTime() - openTime.getTime(),
        });
        break;
      }
    }
  }

  console.log(`Matched ${trades.length} open→close pairs`);
  console.log(`Duration stats:`);
  const durations = trades.map(t => t.durationMs);
  durations.sort((a, b) => a - b);
  console.log(`  Min: ${(durations[0] / 60000).toFixed(1)}min`);
  console.log(`  Median: ${(durations[Math.floor(durations.length / 2)] / 60000).toFixed(1)}min`);
  console.log(`  Max: ${(durations[durations.length - 1] / 60000).toFixed(1)}min`);
  console.log(`  Avg: ${(durations.reduce((a, b) => a + b, 0) / durations.length / 60000).toFixed(1)}min\n`);

  // Step 2: Fetch candles and simulate
  console.log('Fetching candle data from MEXC...\n');

  const results: SimResult[] = [];
  let candleHits = 0;
  let candleMisses = 0;

  // Group by symbol to batch
  const bySymbol = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  let symbolIdx = 0;
  const positionSize = INITIAL_BALANCE * (POSITION_SIZE_PERCENT / 100);

  for (const [symbol, symTrades] of bySymbol) {
    symbolIdx++;
    if (symbolIdx % 25 === 0) {
      console.log(`  Progress: ${symbolIdx}/${bySymbol.size} symbols...`);
    }

    for (const trade of symTrades) {
      const startMs = trade.openTime.getTime() - 60000; // 1min buffer
      const endMs = trade.closeTime.getTime() + 60000;

      const candles = await fetchFuturesKlines(trade.symbol, startMs, endMs);
      const hasCandleData = candles.length > 0;

      if (hasCandleData) {
        candleHits++;
        const sim = simulateWithCandles(trade, candles, positionSize);
        results.push({
          trade,
          originalPnl: trade.originalPnl,
          originalExitReason: trade.exitReason,
          correctedSL_pnl: sim.sc1Pnl,
          correctedSL_exitReason: sim.sc1Reason,
          liqEnforced_pnl: sim.sc2Pnl,
          liqEnforced_exitReason: sim.sc2Reason,
          hasCandleData: true,
        });
      } else {
        candleMisses++;
        // Analytical fallback
        const entry = trade.entryPrice;
        const dir = trade.direction;

        if (trade.exitReason === 'stop_loss') {
          // Original SL at 8% price = 160% ROI loss
          // SC1: corrected SL at 0.4% price = 8% ROI loss
          const sc1Exit = dir === 'long'
            ? entry * (1 - SL_PERCENT / 100 / LEVERAGE)
            : entry * (1 + SL_PERCENT / 100 / LEVERAGE);
          // SC2: liquidated at ~4.75% price
          const sc2Exit = dir === 'long'
            ? entry * (1 - 0.95 / LEVERAGE)
            : entry * (1 + 0.95 / LEVERAGE);

          results.push({
            trade,
            originalPnl: trade.originalPnl,
            originalExitReason: trade.exitReason,
            correctedSL_pnl: calcPnl(entry, sc1Exit, dir, positionSize),
            correctedSL_exitReason: 'stop_loss_corrected',
            liqEnforced_pnl: calcPnl(entry, sc2Exit, dir, positionSize),
            liqEnforced_exitReason: 'liquidated',
            hasCandleData: false,
          });
        } else {
          // trailing_stop — keep original but flag as uncertain
          results.push({
            trade,
            originalPnl: trade.originalPnl,
            originalExitReason: trade.exitReason,
            correctedSL_pnl: trade.originalPnl,
            correctedSL_exitReason: 'trailing_stop_assumed_same',
            liqEnforced_pnl: trade.originalPnl,
            liqEnforced_exitReason: 'trailing_stop_assumed_same',
            hasCandleData: false,
          });
        }
      }

      await sleep(350); // Rate limiting
    }
  }

  console.log(`\nCandle fetch: ${candleHits} hits, ${candleMisses} misses\n`);

  // ====== RESULTS ======
  printResults(results);

  client.close();
}

function printResults(results: SimResult[]) {
  console.log('=================================================');
  console.log('RESULTS');
  console.log('=================================================\n');

  const N = results.length;

  // Original
  const origPnl = results.reduce((s, r) => s + r.originalPnl, 0);
  const origWins = results.filter(r => r.originalPnl > 0).length;
  const origSL = results.filter(r => r.originalExitReason === 'stop_loss').length;
  const origTrail = results.filter(r => r.originalExitReason === 'trailing_stop').length;

  console.log('ORIGINAL (Buggy):');
  console.log(`  Trades: ${N} | Wins: ${origWins} | Losses: ${N - origWins} | WR: ${((origWins / N) * 100).toFixed(1)}%`);
  console.log(`  PnL: $${origPnl.toFixed(2)} | Avg: $${(origPnl / N).toFixed(2)}`);
  console.log(`  Exits: trailing_stop=${origTrail}, stop_loss=${origSL}`);

  // Win/loss by exit type
  const trailWins = results.filter(r => r.originalExitReason === 'trailing_stop' && r.originalPnl > 0);
  const trailLosses = results.filter(r => r.originalExitReason === 'trailing_stop' && r.originalPnl <= 0);
  const slWins = results.filter(r => r.originalExitReason === 'stop_loss' && r.originalPnl > 0);
  const slLosses = results.filter(r => r.originalExitReason === 'stop_loss' && r.originalPnl <= 0);

  console.log(`  Trailing: ${trailWins.length}W/${trailLosses.length}L, PnL: $${results.filter(r => r.originalExitReason === 'trailing_stop').reduce((s, r) => s + r.originalPnl, 0).toFixed(2)}`);
  console.log(`  StopLoss: ${slWins.length}W/${slLosses.length}L, PnL: $${results.filter(r => r.originalExitReason === 'stop_loss').reduce((s, r) => s + r.originalPnl, 0).toFixed(2)}`);

  const origAvgSL = slLosses.length > 0
    ? slLosses.reduce((s, r) => s + r.originalPnl, 0) / slLosses.length
    : 0;
  console.log(`  Avg SL loss: $${origAvgSL.toFixed(2)} per trade`);
  console.log('');

  // SC1: Corrected SL
  const sc1Pnl = results.reduce((s, r) => s + r.correctedSL_pnl, 0);
  const sc1Wins = results.filter(r => r.correctedSL_pnl > 0).length;
  const reasons1: Record<string, number> = {};
  results.forEach(r => { reasons1[r.correctedSL_exitReason] = (reasons1[r.correctedSL_exitReason] || 0) + 1; });

  console.log('SCENARIO 1: Corrected SL (8% ROI = 0.4% price distance):');
  console.log(`  Trades: ${N} | Wins: ${sc1Wins} | Losses: ${N - sc1Wins} | WR: ${((sc1Wins / N) * 100).toFixed(1)}%`);
  console.log(`  PnL: $${sc1Pnl.toFixed(2)} | Avg: $${(sc1Pnl / N).toFixed(2)}`);
  console.log(`  Diff from original: $${(sc1Pnl - origPnl).toFixed(2)}`);
  console.log('  Exit reasons:');
  for (const [r, c] of Object.entries(reasons1).sort((a, b) => b[1] - a[1])) {
    const pnl = results.filter(x => x.correctedSL_exitReason === r).reduce((s, x) => s + x.correctedSL_pnl, 0);
    console.log(`    ${r}: ${c} trades, $${pnl.toFixed(2)}`);
  }
  console.log('');

  // SC2: Liquidation enforced
  const sc2Pnl = results.reduce((s, r) => s + r.liqEnforced_pnl, 0);
  const sc2Wins = results.filter(r => r.liqEnforced_pnl > 0).length;
  const sc2Liqs = results.filter(r => r.liqEnforced_exitReason === 'liquidated').length;
  const reasons2: Record<string, number> = {};
  results.forEach(r => { reasons2[r.liqEnforced_exitReason] = (reasons2[r.liqEnforced_exitReason] || 0) + 1; });

  console.log('SCENARIO 2: Original SL + Liquidation Enforcement:');
  console.log(`  Trades: ${N} | Wins: ${sc2Wins} | Losses: ${N - sc2Wins} | WR: ${((sc2Wins / N) * 100).toFixed(1)}%`);
  console.log(`  PnL: $${sc2Pnl.toFixed(2)} | Avg: $${(sc2Pnl / N).toFixed(2)}`);
  console.log(`  Liquidated: ${sc2Liqs} trades (${((sc2Liqs / N) * 100).toFixed(1)}%)`);
  console.log(`  Diff from original: $${(sc2Pnl - origPnl).toFixed(2)}`);
  console.log('  Exit reasons:');
  for (const [r, c] of Object.entries(reasons2).sort((a, b) => b[1] - a[1])) {
    const pnl = results.filter(x => x.liqEnforced_exitReason === r).reduce((s, x) => s + x.liqEnforced_pnl, 0);
    console.log(`    ${r}: ${c} trades, $${pnl.toFixed(2)}`);
  }
  console.log('');

  // Phantom wins analysis
  const phantomSc1 = results.filter(r => r.originalPnl > 0 && r.correctedSL_pnl <= 0);
  const phantomSc2 = results.filter(r => r.originalPnl > 0 && r.liqEnforced_pnl <= 0);
  console.log('PHANTOM WIN ANALYSIS:');
  console.log(`  SC1: ${phantomSc1.length} trades were originally profitable but would LOSE with corrected SL`);
  console.log(`  SC2: ${phantomSc2.length} trades were originally profitable but would be LIQUIDATED`);
  if (phantomSc1.length > 0) {
    const phantomPnl = phantomSc1.reduce((s, r) => s + r.originalPnl, 0);
    console.log(`  Phantom SC1 total inflated profit: $${phantomPnl.toFixed(2)}`);
  }
  if (phantomSc2.length > 0) {
    const phantomPnl = phantomSc2.reduce((s, r) => s + r.originalPnl, 0);
    console.log(`  Phantom SC2 total inflated profit: $${phantomPnl.toFixed(2)}`);
  }
  console.log('');

  // Data quality
  const withCandles = results.filter(r => r.hasCandleData).length;
  console.log('DATA QUALITY:');
  console.log(`  With candle data: ${withCandles} (${((withCandles / N) * 100).toFixed(1)}%)`);
  console.log(`  Analytical fallback: ${N - withCandles}`);
  console.log('');

  // Win/Loss profile for SC1
  const sc1WinAmts = results.filter(r => r.correctedSL_pnl > 0).map(r => r.correctedSL_pnl);
  const sc1LossAmts = results.filter(r => r.correctedSL_pnl <= 0).map(r => r.correctedSL_pnl);
  const sc1AvgWin = sc1WinAmts.length > 0 ? sc1WinAmts.reduce((a, b) => a + b, 0) / sc1WinAmts.length : 0;
  const sc1AvgLoss = sc1LossAmts.length > 0 ? sc1LossAmts.reduce((a, b) => a + b, 0) / sc1LossAmts.length : 0;

  console.log('SC1 WIN/LOSS PROFILE:');
  console.log(`  Avg win: $${sc1AvgWin.toFixed(2)}`);
  console.log(`  Avg loss: $${sc1AvgLoss.toFixed(2)}`);
  console.log(`  R:R: ${sc1AvgLoss !== 0 ? (sc1AvgWin / Math.abs(sc1AvgLoss)).toFixed(2) : 'N/A'}`);
  console.log(`  EV per trade: $${(sc1AvgWin * (sc1Wins / N) + sc1AvgLoss * ((N - sc1Wins) / N)).toFixed(2)}`);
  console.log('');

  // Big movers
  const bigChanges = results
    .map(r => ({ ...r, diff: r.correctedSL_pnl - r.originalPnl }))
    .filter(r => Math.abs(r.diff) > 1)
    .sort((a, b) => a.diff - b.diff);

  if (bigChanges.length > 0) {
    console.log(`TOP PNL CHANGES (SC1 vs Original, ${Math.min(15, bigChanges.length)} shown):`);
    for (const r of bigChanges.slice(0, 15)) {
      const dur = (r.trade.durationMs / 60000).toFixed(0);
      console.log(`  ${r.trade.symbol} ${r.trade.direction} ${dur}min: $${r.originalPnl.toFixed(2)} → $${r.correctedSL_pnl.toFixed(2)} (${r.diff > 0 ? '+' : ''}$${r.diff.toFixed(2)}) [${r.originalExitReason} → ${r.correctedSL_exitReason}]`);
    }
    console.log('');
  }

  // Conclusion
  console.log('=================================================');
  console.log('CONCLUSION');
  console.log('=================================================\n');
  const reduction = origPnl - sc1Pnl;
  console.log(`Original reported PnL: $${origPnl.toFixed(2)}`);
  console.log(`Corrected SC1 PnL:     $${sc1Pnl.toFixed(2)} (${sc1Pnl >= 0 ? 'PROFITABLE' : 'UNPROFITABLE'})`);
  console.log(`Corrected SC2 PnL:     $${sc2Pnl.toFixed(2)} (${sc2Pnl >= 0 ? 'PROFITABLE' : 'UNPROFITABLE'})`);
  console.log(`Bug inflation:         $${reduction.toFixed(2)} (${origPnl !== 0 ? ((reduction / Math.abs(origPnl)) * 100).toFixed(1) : 0}% of reported)`);
  console.log('');
  if (sc1Pnl > 0) {
    console.log('The bot IS still profitable with corrected stop losses.');
    console.log(`Real win rate: ${((sc1Wins / N) * 100).toFixed(1)}% (was ${((origWins / N) * 100).toFixed(1)}%)`);
    console.log(`Real PnL: $${sc1Pnl.toFixed(2)} (was $${origPnl.toFixed(2)})`);
  } else {
    console.log('The bot is NOT profitable with corrected stop losses.');
    console.log('The entire reported profit was due to the SL bug.');
  }
}

main().catch(console.error);
