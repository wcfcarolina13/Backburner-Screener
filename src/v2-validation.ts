/**
 * V2 Validation Script
 *
 * This script validates the mathematical improvements in V2 by:
 * 1. Analyzing V1 historical data to get baseline metrics
 * 2. Projecting how V2 parameters would have performed
 * 3. Outputting expected improvements
 *
 * NOTE: This is a theoretical projection, not a true backtest.
 * True backtesting requires replaying historical price data through
 * the new V2 parameters, which would require storing candle data.
 */

import * as fs from 'fs';
import * as path from 'path';

// V1 Parameters (old)
const V1_CONFIG = {
  takeProfitPercent: 20,
  stopLossPercent: 20,
  rewardRiskRatio: 1.0,  // 20/20 = 1:1
};

// V2 Parameters (new)
const V2_CONFIG = {
  takeProfitPercent: 35,
  stopLossPercent: 12,
  rewardRiskRatio: 2.92,  // 35/12 = 2.92:1
};

// V1 Historical Performance (from Turso query)
const V1_PERFORMANCE = {
  winRate: 0.318,         // 31.8% from 5m timeframe
  avgWin: 33.41,          // $33.41 average winning trade
  avgLoss: -37.35,        // $37.35 average losing trade
  totalTrades: 285,       // Total trades analyzed
};

/**
 * Calculate expected value per trade
 */
function calculateExpectedValue(winRate: number, avgWin: number, avgLoss: number): number {
  return (winRate * avgWin) + ((1 - winRate) * avgLoss);
}

/**
 * Calculate required win rate for breakeven given R:R ratio
 */
function calculateRequiredWinRate(rewardRiskRatio: number): number {
  // At breakeven: WR * R = (1-WR) * 1
  // WR * R = 1 - WR
  // WR * (R + 1) = 1
  // WR = 1 / (R + 1)
  return 1 / (rewardRiskRatio + 1);
}

/**
 * Project V2 performance based on V1 data
 *
 * Key assumptions:
 * 1. Win rate stays approximately the same (31.8%) - entries are unchanged
 * 2. Tighter stops (12% vs 20%) will reduce avg loss proportionally
 * 3. Wider targets (35% vs 20%) will increase avg win proportionally
 * 4. Some trades that would have won at 20% TP won't reach 35% - estimated 15% reduction in win rate
 */
function projectV2Performance() {
  // Assumption: Tighter stop reduces loss size proportionally
  // Old: 20% stop = $37.35 avg loss
  // New: 12% stop = $37.35 * (12/20) = $22.41 projected loss
  const v2ProjectedAvgLoss = V1_PERFORMANCE.avgLoss * (V2_CONFIG.stopLossPercent / V1_CONFIG.stopLossPercent);

  // Assumption: Wider TP increases win size BUT reduces win rate
  // Some 20% winners won't make it to 35%
  // Conservative estimate: 75% of original winners would reach 35% target
  const targetReachRate = 0.75;
  const v2AdjustedWinRate = V1_PERFORMANCE.winRate * targetReachRate;

  // Avg win increases proportionally for trades that DO reach target
  const v2ProjectedAvgWin = V1_PERFORMANCE.avgWin * (V2_CONFIG.takeProfitPercent / V1_CONFIG.takeProfitPercent);

  return {
    winRate: v2AdjustedWinRate,
    avgWin: v2ProjectedAvgWin,
    avgLoss: v2ProjectedAvgLoss,
  };
}

function runValidation() {
  console.log('========================================');
  console.log('V2 VALIDATION REPORT');
  console.log('========================================\n');

  // V1 Analysis
  console.log('--- V1 HISTORICAL PERFORMANCE ---');
  console.log(`Win Rate: ${(V1_PERFORMANCE.winRate * 100).toFixed(1)}%`);
  console.log(`Avg Win: $${V1_PERFORMANCE.avgWin.toFixed(2)}`);
  console.log(`Avg Loss: $${V1_PERFORMANCE.avgLoss.toFixed(2)}`);
  console.log(`R:R Ratio: ${V1_CONFIG.rewardRiskRatio.toFixed(2)}:1`);

  const v1ExpectedValue = calculateExpectedValue(
    V1_PERFORMANCE.winRate,
    V1_PERFORMANCE.avgWin,
    V1_PERFORMANCE.avgLoss
  );
  console.log(`Expected Value/Trade: $${v1ExpectedValue.toFixed(2)}`);
  console.log(`Per 100 trades: $${(v1ExpectedValue * 100).toFixed(2)}`);

  const v1RequiredWR = calculateRequiredWinRate(V1_CONFIG.rewardRiskRatio);
  console.log(`Required WR for breakeven: ${(v1RequiredWR * 100).toFixed(1)}%`);
  console.log(`Actual WR vs Required: ${V1_PERFORMANCE.winRate > v1RequiredWR ? '✅ PROFITABLE' : '❌ LOSING'}\n`);

  // V2 Projections
  console.log('--- V2 PROJECTED PERFORMANCE ---');
  const v2Projection = projectV2Performance();

  console.log(`Projected Win Rate: ${(v2Projection.winRate * 100).toFixed(1)}% (conservative)`);
  console.log(`Projected Avg Win: $${v2Projection.avgWin.toFixed(2)}`);
  console.log(`Projected Avg Loss: $${v2Projection.avgLoss.toFixed(2)}`);
  console.log(`R:R Ratio: ${V2_CONFIG.rewardRiskRatio.toFixed(2)}:1`);

  const v2ExpectedValue = calculateExpectedValue(
    v2Projection.winRate,
    v2Projection.avgWin,
    v2Projection.avgLoss
  );
  console.log(`Expected Value/Trade: $${v2ExpectedValue.toFixed(2)}`);
  console.log(`Per 100 trades: $${(v2ExpectedValue * 100).toFixed(2)}`);

  const v2RequiredWR = calculateRequiredWinRate(V2_CONFIG.rewardRiskRatio);
  console.log(`Required WR for breakeven: ${(v2RequiredWR * 100).toFixed(1)}%`);
  console.log(`Projected WR vs Required: ${v2Projection.winRate > v2RequiredWR ? '✅ PROFITABLE' : '❌ LOSING'}\n`);

  // Comparison
  console.log('--- V1 vs V2 COMPARISON ---');
  console.log(`Expected Value Improvement: $${(v2ExpectedValue - v1ExpectedValue).toFixed(2)} per trade`);
  console.log(`Improvement %: ${(((v2ExpectedValue - v1ExpectedValue) / Math.abs(v1ExpectedValue)) * 100).toFixed(1)}%`);
  console.log(`Per 100 trades: $${((v2ExpectedValue - v1ExpectedValue) * 100).toFixed(2)} better\n`);

  // Sensitivity Analysis
  console.log('--- SENSITIVITY ANALYSIS ---');
  console.log('What if win rate changes with V2 parameters?\n');

  const winRates = [0.20, 0.25, 0.30, 0.35, 0.40];
  console.log('Win Rate | V2 Expected Value | Profitable?');
  console.log('-'.repeat(45));

  for (const wr of winRates) {
    const ev = calculateExpectedValue(wr, v2Projection.avgWin, v2Projection.avgLoss);
    const profitable = wr > v2RequiredWR;
    console.log(`  ${(wr * 100).toFixed(0)}%    |     $${ev.toFixed(2).padStart(7)}      |    ${profitable ? '✅' : '❌'}`);
  }

  console.log('\n--- RECOMMENDATIONS ---');
  console.log('1. Monitor actual win rate over next 3-5 days');
  console.log('2. Track which shadow bot (8%, 10%, 15%, 18% stop) performs best');
  console.log('3. If win rate drops below 25%, consider reverting to V1');
  console.log('4. If win rate stays above 30%, V2 should be profitable');
  console.log('\n========================================\n');
}

// Run validation
runValidation();
