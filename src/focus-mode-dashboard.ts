#!/usr/bin/env node
/**
 * FOCUS MODE DASHBOARD
 *
 * Real-time trading assistant for manual leveraged trading.
 * Shows current regime, actionable signals, and one-click trade links.
 *
 * Can be run standalone: node dist/focus-mode-dashboard.js
 * Or imported: import { getFocusModeHtml } from './focus-mode-dashboard.js'
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const CANDLES_DIR_BASE = path.join(DATA_DIR, 'candles');

// ============= Types =============

interface Signal {
  timestamp: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  rsi: number;
  price: number;
  entryPrice?: number;
  state: string;
  eventType: string;
  coinName?: string;
}

type MacroRegime = 'BULL' | 'BEAR' | 'NEU';
type MicroRegime = 'BULL' | 'BEAR' | 'NEU';
type Quadrant = `${MacroRegime}+${MicroRegime}`;

interface QuadrantRule {
  action: 'LONG' | 'SHORT' | 'SKIP';
  emoji: string;
  description: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// Contrarian rules from backtesting
const QUADRANT_RULES: Record<Quadrant, QuadrantRule> = {
  'NEU+BEAR': { action: 'LONG', emoji: '🟢', description: 'Contrarian long - buy the dip', confidence: 'HIGH' },
  'NEU+BULL': { action: 'SHORT', emoji: '🔴', description: 'Fade the rally', confidence: 'MEDIUM' },
  'BEAR+BEAR': { action: 'LONG', emoji: '🟢', description: 'Deep contrarian long', confidence: 'MEDIUM' },
  'BEAR+BULL': { action: 'SKIP', emoji: '⛔', description: 'BULL TRAP - never trade', confidence: 'HIGH' },
  'BULL+BULL': { action: 'SHORT', emoji: '🔴', description: 'Fade euphoria - HIGH WIN RATE', confidence: 'HIGH' },
  'BULL+BEAR': { action: 'LONG', emoji: '🟢', description: 'Buy macro-bull dip', confidence: 'MEDIUM' },
  'BULL+NEU': { action: 'SKIP', emoji: '⏸️', description: 'Wait for clearer signal', confidence: 'LOW' },
  'BEAR+NEU': { action: 'SKIP', emoji: '⏸️', description: 'Wait for clearer signal', confidence: 'LOW' },
  'NEU+NEU': { action: 'SKIP', emoji: '⏸️', description: 'No clear regime', confidence: 'LOW' },
};

// ============= Regime Detection =============

function loadRecentSignals(hours: number = 24): Signal[] {
  const signals: Signal[] = [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  if (!fs.existsSync(SIGNALS_DIR)) return signals;

  const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files.slice(-3)) { // Last 3 days max
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, file), 'utf-8'));
      for (const sig of data) {
        if (new Date(sig.timestamp).getTime() >= cutoff) {
          signals.push(sig);
        }
      }
    } catch { /* skip */ }
  }

  return signals.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

// WINDOW CONFIGURATIONS - Based on backtesting results
interface WindowConfig {
  name: string;
  macroHours: number;
  microHours: number;
  macroThreshold: number;
  microThreshold: number;
  macroMinSignals: number;
  microMinSignals: number;
  pnl: string;  // Backtest result for display
}

const WINDOW_CONFIGS: Record<string, WindowConfig> = {
  '12h/2h': {
    name: '12h/2h (Best: $2,071)',
    macroHours: 12,
    microHours: 2,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 8,
    microMinSignals: 3,
    pnl: '$2,071',
  },
  '4h/1h': {
    name: '4h/1h ($1,937)',
    macroHours: 4,
    microHours: 1,
    macroThreshold: 60,
    microThreshold: 65,
    macroMinSignals: 5,
    microMinSignals: 2,
    pnl: '$1,937',
  },
  '24h/4h': {
    name: '24h/4h (Original: $1,787)',
    macroHours: 24,
    microHours: 4,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 10,
    microMinSignals: 3,
    pnl: '$1,787',
  },
  '24h/1h': {
    name: '24h/1h ($1,464)',
    macroHours: 24,
    microHours: 1,
    macroThreshold: 55,
    microThreshold: 65,
    macroMinSignals: 10,
    microMinSignals: 2,
    pnl: '$1,464',
  },
};

const DEFAULT_CONFIG = '12h/2h';

function getMacroRegime(signals: Signal[], config: WindowConfig): { regime: MacroRegime; longPct: number; shortPct: number; count: number } {
  const now = Date.now();
  const windowMs = config.macroHours * 60 * 60 * 1000;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= now - windowMs;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < config.macroMinSignals) return { regime: 'NEU', longPct: 50, shortPct: 50, count: total };

  const longPct = Math.round((longs / total) * 100);
  const shortPct = 100 - longPct;

  let regime: MacroRegime = 'NEU';
  if (longPct >= config.macroThreshold) regime = 'BULL';
  else if (shortPct >= config.macroThreshold) regime = 'BEAR';

  return { regime, longPct, shortPct, count: total };
}

function getMicroRegime(signals: Signal[], config: WindowConfig): { regime: MicroRegime; longPct: number; shortPct: number; count: number } {
  const now = Date.now();
  const windowMs = config.microHours * 60 * 60 * 1000;

  const windowSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= now - windowMs;
  });

  const longs = windowSignals.filter(s => s.direction === 'long').length;
  const shorts = windowSignals.filter(s => s.direction === 'short').length;
  const total = longs + shorts;

  if (total < config.microMinSignals) return { regime: 'NEU', longPct: 50, shortPct: 50, count: total };

  const longPct = Math.round((longs / total) * 100);
  const shortPct = 100 - longPct;

  let regime: MicroRegime = 'NEU';
  if (longPct >= config.microThreshold) regime = 'BULL';
  else if (shortPct >= config.microThreshold) regime = 'BEAR';

  return { regime, longPct, shortPct, count: total };
}

interface CombinedSignal extends Signal {
  timeframes: string[];  // All timeframes that triggered
  signalCount: number;   // Number of signals combined
  oldestTimestamp: string;
  newestTimestamp: string;
}

function getActionableSignals(signals: Signal[], quadrant: Quadrant): CombinedSignal[] {
  const rule = QUADRANT_RULES[quadrant];
  if (rule.action === 'SKIP') return [];

  // Get triggered signals from last hour
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  const recentSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    const isRecent = ts >= hourAgo;
    const isTriggered = (s.state === 'triggered' || s.state === 'deep_extreme') &&
                        s.eventType === 'triggered' &&
                        s.entryPrice;
    return isRecent && isTriggered;
  });

  // Group by symbol and direction
  const grouped = new Map<string, Signal[]>();
  for (const s of recentSignals) {
    const key = `${s.symbol}_${s.direction}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  // Combine signals for each symbol
  const combined: CombinedSignal[] = [];
  for (const [_, signals] of grouped) {
    // Sort by timestamp, newest first
    signals.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const newest = signals[0];
    const oldest = signals[signals.length - 1];
    const timeframes = [...new Set(signals.map(s => s.timeframe))].sort();

    combined.push({
      ...newest,
      timeframes,
      signalCount: signals.length,
      oldestTimestamp: oldest.timestamp,
      newestTimestamp: newest.timestamp,
    });
  }

  // Sort by signal count (stronger signals first), then by time
  combined.sort((a, b) => {
    if (b.signalCount !== a.signalCount) return b.signalCount - a.signalCount;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return combined.slice(0, 10); // Top 10
}

// ============= MEXC URL Generator =============

function getMexcTradeUrl(symbol: string, direction: 'LONG' | 'SHORT'): string {
  // MEXC futures trading URL format
  const pair = symbol.replace('USDT', '_USDT');
  return `https://futures.mexc.com/exchange/${pair}?type=linear`;
}

// ============= Multi-Config Alignment =============

interface ConfigAlignment {
  configKey: string;
  configName: string;
  quadrant: string;
  action: 'LONG' | 'SHORT' | 'SKIP';
  macro: { regime: MacroRegime; longPct: number; shortPct: number; count: number };
  micro: { regime: MicroRegime; longPct: number; shortPct: number; count: number };
}

function getAllConfigAlignments(signals: Signal[]): ConfigAlignment[] {
  const alignments: ConfigAlignment[] = [];

  for (const [key, config] of Object.entries(WINDOW_CONFIGS)) {
    const macro = getMacroRegime(signals, config);
    const micro = getMicroRegime(signals, config);
    const quadrant: Quadrant = `${macro.regime}+${micro.regime}`;
    const rule = QUADRANT_RULES[quadrant];

    alignments.push({
      configKey: key,
      configName: config.name,
      quadrant,
      action: rule.action,
      macro,
      micro,
    });
  }

  return alignments;
}

function getAlignmentSummary(alignments: ConfigAlignment[]): {
  aligned: boolean;
  direction: 'LONG' | 'SHORT' | 'MIXED' | 'SKIP';
  agreementCount: number;
  totalConfigs: number;
} {
  const actions = alignments.map(a => a.action);
  const nonSkipActions = actions.filter(a => a !== 'SKIP');

  if (nonSkipActions.length === 0) {
    return { aligned: false, direction: 'SKIP', agreementCount: 0, totalConfigs: alignments.length };
  }

  const longCount = nonSkipActions.filter(a => a === 'LONG').length;
  const shortCount = nonSkipActions.filter(a => a === 'SHORT').length;

  if (longCount > 0 && shortCount > 0) {
    return { aligned: false, direction: 'MIXED', agreementCount: Math.max(longCount, shortCount), totalConfigs: alignments.length };
  }

  const direction = longCount > 0 ? 'LONG' : 'SHORT';
  return {
    aligned: nonSkipActions.length === alignments.length,
    direction,
    agreementCount: nonSkipActions.length,
    totalConfigs: alignments.length
  };
}

// ============= Candle Data & Support/Resistance =============

const CANDLES_DIR = path.join(DATA_DIR, 'candles');

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number; // 1-3 based on touches/timeframe
  timeframe: string;
}

interface SmartTradeSetup {
  entryPrice: number;
  direction: 'LONG' | 'SHORT';
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  riskRewardRatio: number;
  suggestedLeverage: number;
  suggestedPositionPct: number; // % of balance to use
  nearestSupport: number;
  nearestResistance: number;
  srLevels: SRLevel[];
}

function loadCandles(symbol: string, timeframe: string): Candle[] | null {
  const symbolDir = path.join(CANDLES_DIR, symbol);
  const spotPath = path.join(symbolDir, `${timeframe}-spot.json`);
  const futuresPath = path.join(symbolDir, `${timeframe}-futures.json`);

  for (const filepath of [spotPath, futuresPath]) {
    if (fs.existsSync(filepath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        return data.candles || data;
      } catch { return null; }
    }
  }
  return null;
}

function findSwingHighsLows(candles: Candle[], lookback: number = 5): { highs: number[], lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= current.high) isSwingHigh = false;
      if (candles[j].low <= current.low) isSwingLow = false;
    }

    if (isSwingHigh) highs.push(current.high);
    if (isSwingLow) lows.push(current.low);
  }

  return { highs, lows };
}

function clusterLevels(prices: number[], tolerance: number = 0.005): number[] {
  // Cluster nearby prices together (within tolerance %)
  if (prices.length === 0) return [];

  const sorted = [...prices].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const lastPrice = lastCluster[lastCluster.length - 1];

    if ((sorted[i] - lastPrice) / lastPrice <= tolerance) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  // Return average of each cluster, weighted by size
  return clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);
}

function getSupportResistanceLevels(symbol: string): SRLevel[] {
  const levels: SRLevel[] = [];

  // Check multiple timeframes for stronger S/R
  const timeframes = [
    { tf: '4h', weight: 3 },
    { tf: '1h', weight: 2 },
    { tf: '15m', weight: 1 },
  ];

  for (const { tf, weight } of timeframes) {
    const candles = loadCandles(symbol, tf);
    if (!candles || candles.length < 50) continue;

    // Use last 100 candles for S/R
    const recentCandles = candles.slice(-100);
    const { highs, lows } = findSwingHighsLows(recentCandles, tf === '4h' ? 3 : 5);

    // Cluster the levels
    const resistanceLevels = clusterLevels(highs);
    const supportLevels = clusterLevels(lows);

    for (const price of resistanceLevels) {
      levels.push({ price, type: 'resistance', strength: weight, timeframe: tf });
    }
    for (const price of supportLevels) {
      levels.push({ price, type: 'support', strength: weight, timeframe: tf });
    }
  }

  // Sort by price
  return levels.sort((a, b) => a.price - b.price);
}

function calculateSmartTradeSetup(
  entryPrice: number,
  direction: 'LONG' | 'SHORT',
  symbol: string,
  accountBalance: number = 1000 // Default $1000 account
): SmartTradeSetup {
  const srLevels = getSupportResistanceLevels(symbol);

  // Minimum distance thresholds (percentage from entry)
  const MIN_SL_PCT = 1.5;  // At least 1.5% stop loss
  const MIN_TP_PCT = 2.0;  // At least 2% take profit
  const MIN_SR_DISTANCE = 0.01; // S/R must be at least 1% away to be meaningful

  // Find nearest support and resistance relative to entry
  // Filter out levels that are too close (noise)
  const supports = srLevels.filter(l =>
    l.type === 'support' &&
    l.price < entryPrice &&
    (entryPrice - l.price) / entryPrice >= MIN_SR_DISTANCE
  );
  const resistances = srLevels.filter(l =>
    l.type === 'resistance' &&
    l.price > entryPrice &&
    (l.price - entryPrice) / entryPrice >= MIN_SR_DISTANCE
  );

  // Get the closest meaningful levels, or use fallback
  let nearestSupport = supports.length > 0
    ? supports.sort((a, b) => b.price - a.price)[0].price  // Highest support below entry
    : entryPrice * (1 - MIN_SL_PCT / 100 - 0.005); // Fallback

  let nearestResistance = resistances.length > 0
    ? resistances.sort((a, b) => a.price - b.price)[0].price // Lowest resistance above entry
    : entryPrice * (1 + MIN_TP_PCT / 100 + 0.005); // Fallback

  let stopLossPrice: number;
  let takeProfitPrice: number;

  if (direction === 'LONG') {
    // SL below nearest support, TP at nearest resistance
    stopLossPrice = nearestSupport * 0.995; // Slightly below support
    takeProfitPrice = nearestResistance * 0.998; // Slightly below resistance
  } else {
    // SL above nearest resistance, TP at nearest support
    stopLossPrice = nearestResistance * 1.005; // Slightly above resistance
    takeProfitPrice = nearestSupport * 1.002; // Slightly above support
  }

  // Calculate percentages
  let stopLossPct = Math.abs((stopLossPrice - entryPrice) / entryPrice) * 100;
  let takeProfitPct = Math.abs((takeProfitPrice - entryPrice) / entryPrice) * 100;

  // Enforce minimum distances - if S/R is too close, use percentage-based
  if (stopLossPct < MIN_SL_PCT) {
    stopLossPct = MIN_SL_PCT;
    stopLossPrice = direction === 'LONG'
      ? entryPrice * (1 - MIN_SL_PCT / 100)
      : entryPrice * (1 + MIN_SL_PCT / 100);
    // Also update the displayed support/resistance to match
    if (direction === 'LONG') {
      nearestSupport = stopLossPrice / 0.995;
    } else {
      nearestResistance = stopLossPrice / 1.005;
    }
  }

  if (takeProfitPct < MIN_TP_PCT) {
    takeProfitPct = MIN_TP_PCT;
    takeProfitPrice = direction === 'LONG'
      ? entryPrice * (1 + MIN_TP_PCT / 100)
      : entryPrice * (1 - MIN_TP_PCT / 100);
    // Also update the displayed support/resistance to match
    if (direction === 'LONG') {
      nearestResistance = takeProfitPrice / 0.998;
    } else {
      nearestSupport = takeProfitPrice / 1.002;
    }
  }

  const riskRewardRatio = takeProfitPct / stopLossPct;

  // Suggest leverage based on SL distance
  // Rule: Don't risk more than 50% ROE on stop loss
  // If SL is 2%, max leverage = 50/2 = 25x
  // If SL is 5%, max leverage = 50/5 = 10x
  const maxLeverageForRisk = Math.floor(50 / stopLossPct);
  const suggestedLeverage = Math.min(Math.max(maxLeverageForRisk, 3), 15); // Clamp 3-15x (safer max)

  // Position sizing: Risk 2% of account per trade
  // At suggested leverage, what position size risks 2%?
  // If SL = 2% and leverage = 10x, ROE loss = 20%
  // To risk only 2% of account: position = 2% / 20% = 10% of balance
  const riskPerTrade = 0.02; // 2% account risk
  const roeLoss = stopLossPct * suggestedLeverage / 100; // e.g., 2% * 10x = 20% = 0.2
  const positionPct = (riskPerTrade / roeLoss) * 100;
  const suggestedPositionPct = Math.min(Math.max(positionPct, 5), 50); // Clamp 5-50%

  return {
    entryPrice,
    direction,
    stopLossPrice,
    takeProfitPrice,
    stopLossPct,
    takeProfitPct,
    riskRewardRatio,
    suggestedLeverage,
    suggestedPositionPct,
    nearestSupport,
    nearestResistance,
    srLevels,
  };
}

// ============= Trade Calculations (Percentage-based fallback) =============

interface TradeParams {
  entryPrice: number;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  riskRewardRatio: number;
}

function calculateTradeParams(entryPrice: number, direction: 'LONG' | 'SHORT', leverage: number = 10): TradeParams {
  // Based on excursion analysis: avg favorable 2.58%, avg adverse 3.62%
  // Only 38% of trades reach 2% favorable, only 1% reach 15%!
  // Use realistic targets that actually get hit
  const stopLossPct = leverage >= 10 ? 3 : 5;   // 30% ROE at 10x
  const takeProfitPct = leverage >= 10 ? 2 : 4; // 20% ROE at 10x

  let stopLossPrice: number;
  let takeProfitPrice: number;

  if (direction === 'LONG') {
    stopLossPrice = entryPrice * (1 - stopLossPct / 100);
    takeProfitPrice = entryPrice * (1 + takeProfitPct / 100);
  } else {
    stopLossPrice = entryPrice * (1 + stopLossPct / 100);
    takeProfitPrice = entryPrice * (1 - takeProfitPct / 100);
  }

  const riskRewardRatio = takeProfitPct / stopLossPct;

  return {
    entryPrice,
    direction,
    leverage,
    stopLossPrice,
    takeProfitPrice,
    stopLossPct,
    takeProfitPct,
    riskRewardRatio,
  };
}

// ============= Exported HTML Generator =============

/**
 * Generate Focus Mode dashboard HTML
 * Can be used by web-server.ts or standalone
 */
export function getFocusModeHtml(configKeyParam?: string): string {
  const configKey = configKeyParam || DEFAULT_CONFIG;
  const config = WINDOW_CONFIGS[configKey] || WINDOW_CONFIGS[DEFAULT_CONFIG];

  const signals = loadRecentSignals(Math.max(config.macroHours, 24)); // Load enough signals
  const macro = getMacroRegime(signals, config);
  const micro = getMicroRegime(signals, config);
  const quadrant: Quadrant = `${macro.regime}+${micro.regime}`;
  const rule = QUADRANT_RULES[quadrant];
  const actionableSignals = getActionableSignals(signals, quadrant);

  // Get alignment across all configs
  const allAlignments = getAllConfigAlignments(signals);
  const alignmentSummary = getAlignmentSummary(allAlignments);

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Focus Mode - Trading Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }

    /* Navigation Tabs */
    .nav-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      background: #161b22;
      border-radius: 8px;
      padding: 4px;
      border: 1px solid #30363d;
    }
    .nav-tab {
      flex: 1;
      padding: 12px 24px;
      text-align: center;
      text-decoration: none;
      color: #8b949e;
      font-weight: 500;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .nav-tab:hover { color: #c9d1d9; background: #21262d; }
    .nav-tab.active {
      background: #238636;
      color: white;
    }
    .nav-tab .tab-icon { margin-right: 8px; }

    h1 { color: #58a6ff; margin-bottom: 20px; }
    h2 { color: #8b949e; margin: 20px 0 10px; font-size: 14px; text-transform: uppercase; }

    .regime-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 2fr;
      gap: 20px;
      margin-bottom: 30px;
    }

    .regime-box {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
    }

    .regime-box.macro { border-left: 4px solid #58a6ff; }
    .regime-box.micro { border-left: 4px solid #f0883e; }
    .regime-box.action { border-left: 4px solid #238636; }

    .regime-label { font-size: 12px; color: #8b949e; margin-bottom: 5px; }
    .regime-value { font-size: 32px; font-weight: bold; }
    .regime-value.BULL { color: #3fb950; }
    .regime-value.BEAR { color: #f85149; }
    .regime-value.NEU { color: #8b949e; }

    .regime-stats { font-size: 12px; color: #8b949e; margin-top: 10px; }
    .stat-bar {
      height: 8px;
      background: #21262d;
      border-radius: 4px;
      margin-top: 5px;
      overflow: hidden;
    }
    .stat-bar-fill {
      height: 100%;
      transition: width 0.3s;
    }
    .stat-bar-fill.long { background: #3fb950; }
    .stat-bar-fill.short { background: #f85149; }

    .quadrant {
      font-size: 48px;
      font-weight: bold;
      text-align: center;
      padding: 20px;
    }

    .action-box {
      text-align: center;
      padding: 30px;
    }
    .action-emoji { font-size: 64px; }
    .action-text { font-size: 24px; font-weight: bold; margin: 10px 0; }
    .action-text.LONG { color: #3fb950; }
    .action-text.SHORT { color: #f85149; }
    .action-text.SKIP { color: #8b949e; }
    .action-desc { color: #8b949e; }
    .confidence {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      margin-top: 10px;
    }
    .confidence.HIGH { background: #238636; color: white; }
    .confidence.MEDIUM { background: #9e6a03; color: white; }
    .confidence.LOW { background: #6e7681; color: white; }

    .signals-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .signals-table th {
      text-align: left;
      padding: 12px;
      background: #21262d;
      border-bottom: 1px solid #30363d;
      font-size: 12px;
      color: #8b949e;
    }
    .signals-table td {
      padding: 12px;
      border-bottom: 1px solid #21262d;
    }
    .signals-table tr:hover { background: #161b22; }

    .trade-btn {
      display: inline-block;
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
    .trade-btn.long { background: #238636; color: white; }
    .trade-btn.short { background: #da3633; color: white; }
    .trade-btn:hover { opacity: 0.9; }

    .symbol { font-weight: bold; color: #58a6ff; }
    .price { font-family: monospace; }
    .time { color: #8b949e; font-size: 12px; }

    /* Trade params styling */
    .entry-price { color: #c9d1d9; font-weight: bold; }
    .stop-loss { color: #f85149; }
    .stop-loss .sl-price { display: block; font-weight: bold; }
    .stop-loss .sl-roe { display: block; font-size: 13px; font-weight: bold; color: #f85149; }
    .stop-loss .sl-pct { font-size: 10px; color: #f8514980; }
    .take-profit { color: #3fb950; }
    .take-profit .tp-price { display: block; font-weight: bold; }
    .take-profit .tp-roe { display: block; font-size: 13px; font-weight: bold; color: #3fb950; }
    .take-profit .tp-pct { font-size: 10px; color: #3fb95080; }
    .rr-ratio {
      font-weight: bold;
      color: #a371f7;
      text-align: center;
    }

    /* Trade Cards */
    .trade-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .trade-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      overflow: hidden;
    }
    .trade-card.long { border-left: 4px solid #238636; }
    .trade-card.short { border-left: 4px solid #da3633; }

    .trade-card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 15px;
      background: #21262d;
      border-bottom: 1px solid #30363d;
    }
    .trade-symbol {
      font-size: 18px;
      font-weight: bold;
      color: #58a6ff;
    }
    .trade-action {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .trade-action.long { background: #238636; color: white; }
    .trade-action.short { background: #da3633; color: white; }
    .trade-time {
      margin-left: auto;
      color: #8b949e;
      font-size: 12px;
    }

    .trade-card-body {
      padding: 15px;
    }

    .price-levels {
      background: #0d1117;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 15px;
    }
    .level-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
    }
    .level-row:last-child { border-bottom: none; }
    .level-label { color: #8b949e; font-size: 13px; }
    .level-price { font-family: monospace; font-weight: bold; }
    .level-row.resistance .level-price { color: #f85149; }
    .level-row.entry .level-price { color: #58a6ff; }
    .level-row.support .level-price { color: #3fb950; }

    .trade-setup {
      margin-bottom: 15px;
    }
    .setup-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
    }
    .setup-row:last-child { border-bottom: none; }
    .setup-label { color: #8b949e; font-size: 13px; min-width: 100px; }
    .setup-value { font-family: monospace; font-weight: bold; }
    .setup-value.tp { color: #3fb950; }
    .setup-value.sl { color: #f85149; }
    .setup-value.rr { font-size: 16px; }
    .setup-pct { color: #6e7681; font-size: 12px; margin-left: auto; }

    /* Trade Quality Badge */
    .trade-quality {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
    }
    .trade-quality.excellent { background: #238636; color: white; }
    .trade-quality.good { background: #2ea043; color: white; }
    .trade-quality.ok { background: #9e6a03; color: white; }
    .trade-quality.poor { background: #bd561d; color: white; }
    .trade-quality.bad { background: #da3633; color: white; }

    /* Signal Strength Styles */
    .signal-strength {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      animation: pulse 2s infinite;
    }
    .signal-strength.strong {
      background: linear-gradient(135deg, #ff6b35, #f7931e);
      color: white;
      box-shadow: 0 0 10px rgba(255, 107, 53, 0.5);
    }
    .signal-strength.multi {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      color: white;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }

    /* Multi-TF card highlight */
    .trade-card.signal-strong {
      border: 2px solid #ff6b35 !important;
      box-shadow: 0 0 15px rgba(255, 107, 53, 0.3);
    }
    .trade-card.signal-multi {
      border: 2px solid #a855f7 !important;
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.2);
    }

    /* Timeframes row */
    .timeframes-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      flex-wrap: wrap;
    }
    .tf-label {
      color: #8b949e;
      font-size: 11px;
    }
    .tf-badge {
      background: #30363d;
      color: #58a6ff;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .signal-count {
      color: #8b949e;
      font-size: 11px;
      margin-left: auto;
    }

    /* R:R Highlight Row */
    .rr-highlight {
      background: #21262d;
      border-radius: 6px;
      padding: 10px !important;
      margin-top: 8px;
    }
    .rr-highlight.excellent { border-left: 3px solid #238636; }
    .rr-highlight.good { border-left: 3px solid #2ea043; }
    .rr-highlight.ok { border-left: 3px solid #9e6a03; }
    .rr-highlight.poor { border-left: 3px solid #bd561d; }
    .rr-highlight.bad { border-left: 3px solid #da3633; }

    .rr-highlight.excellent .setup-value.rr { color: #3fb950; }
    .rr-highlight.good .setup-value.rr { color: #56d364; }
    .rr-highlight.ok .setup-value.rr { color: #d29922; }
    .rr-highlight.poor .setup-value.rr { color: #db6d28; }
    .rr-highlight.bad .setup-value.rr { color: #f85149; }

    /* R:R Progress Bar */
    .rr-bar {
      flex: 1;
      height: 6px;
      background: #30363d;
      border-radius: 3px;
      overflow: hidden;
      margin-left: 10px;
    }
    .rr-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .rr-highlight.excellent .rr-fill { background: linear-gradient(90deg, #238636, #3fb950); }
    .rr-highlight.good .rr-fill { background: linear-gradient(90deg, #2ea043, #56d364); }
    .rr-highlight.ok .rr-fill { background: linear-gradient(90deg, #9e6a03, #d29922); }
    .rr-highlight.poor .rr-fill { background: linear-gradient(90deg, #bd561d, #db6d28); }
    .rr-highlight.bad .rr-fill { background: linear-gradient(90deg, #da3633, #f85149); }

    /* Card border glow based on R:R quality */
    .trade-card.rr-excellent { box-shadow: 0 0 15px rgba(35, 134, 54, 0.4); border-color: #238636; }
    .trade-card.rr-good { box-shadow: 0 0 10px rgba(46, 160, 67, 0.3); border-color: #2ea043; }
    .trade-card.rr-ok { border-color: #9e6a03; }
    .trade-card.rr-poor { border-color: #bd561d; }
    .trade-card.rr-bad { border-color: #da3633; box-shadow: inset 0 0 0 1px rgba(218, 54, 51, 0.3); }

    .position-sizing {
      display: flex;
      gap: 15px;
      background: #0d1117;
      border-radius: 8px;
      padding: 12px;
    }
    .sizing-item {
      flex: 1;
      text-align: center;
    }
    .sizing-label {
      display: block;
      color: #8b949e;
      font-size: 11px;
      margin-bottom: 5px;
    }
    .sizing-value {
      font-size: 18px;
      font-weight: bold;
    }
    .sizing-value.leverage { color: #a371f7; }
    .sizing-value.position { color: #58a6ff; }

    .trade-card-footer {
      padding: 15px;
      background: #21262d;
      border-top: 1px solid #30363d;
    }
    .trade-card-footer .trade-btn {
      display: block;
      width: 100%;
      text-align: center;
      padding: 12px;
      font-size: 16px;
    }

    .leverage-selector {
      margin: 20px 0;
      padding: 15px;
      background: #21262d;
      border-radius: 8px;
    }
    .leverage-btn {
      padding: 8px 16px;
      margin-right: 10px;
      border: 1px solid #30363d;
      background: #161b22;
      color: #c9d1d9;
      border-radius: 6px;
      cursor: pointer;
    }
    .leverage-btn.active { background: #238636; border-color: #238636; }

    .alert-controls {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .alert-btn {
      padding: 10px 20px;
      border: 1px solid #30363d;
      background: #161b22;
      color: #c9d1d9;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .alert-btn:hover { background: #21262d; }
    .alert-btn.active { background: #238636; border-color: #238636; }

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #238636;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.3s ease;
      z-index: 1000;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    @keyframes flash {
      0%, 100% { background: #0d1117; }
      50% { background: #1a3a1a; }
    }
    .alert-flash {
      animation: flash 0.5s ease 2;
    }

    .status-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 15px;
      background: #161b22;
      border-radius: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #3fb950;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .config-selector {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .config-selector label {
      font-size: 12px;
      color: #8b949e;
    }
    .config-selector select {
      padding: 8px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 14px;
      cursor: pointer;
    }
    .config-selector select:hover {
      border-color: #58a6ff;
    }

    .rules-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 20px;
    }
    .rule-box {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 12px;
      font-size: 13px;
    }
    .rule-box.active { border-color: #58a6ff; background: #1f2937; }
    .rule-quadrant { font-weight: bold; margin-bottom: 5px; }
    .rule-action { color: #8b949e; }

    .no-signals {
      text-align: center;
      padding: 40px;
      color: #8b949e;
    }

    .refresh-note {
      text-align: center;
      color: #6e7681;
      font-size: 12px;
      margin-top: 20px;
    }

    /* Alignment Section */
    .alignment-section {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
    }
    .alignment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .alignment-title {
      font-size: 14px;
      font-weight: bold;
      color: #8b949e;
      text-transform: uppercase;
    }
    .alignment-badge {
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
    }
    .alignment-badge.aligned { background: #238636; color: white; }
    .alignment-badge.partial { background: #9e6a03; color: white; }
    .alignment-badge.mixed { background: #da3633; color: white; }
    .alignment-badge.skip { background: #6e7681; color: white; }

    .alignment-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }
    .alignment-item {
      background: #21262d;
      border-radius: 6px;
      padding: 10px;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 2px solid transparent;
    }
    .alignment-item:hover {
      background: #30363d;
      transform: translateY(-2px);
    }
    .alignment-item.active { border: 2px solid #58a6ff; pointer-events: none; }
    .alignment-config-name {
      font-size: 11px;
      color: #8b949e;
      margin-bottom: 5px;
    }
    .alignment-action {
      font-size: 16px;
      font-weight: bold;
    }
    .alignment-action.LONG { color: #3fb950; }
    .alignment-action.SHORT { color: #f85149; }
    .alignment-action.SKIP { color: #6e7681; }
    .alignment-quadrant {
      font-size: 10px;
      color: #6e7681;
      margin-top: 3px;
    }

    /* Trade Params */
    .trade-params {
      background: #1a2332;
      border: 2px solid #238636;
      border-radius: 8px;
      padding: 15px;
      margin: 10px 0;
    }
    .trade-params.short-trade {
      border-color: #da3633;
    }
    .trade-params-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .trade-direction {
      font-size: 18px;
      font-weight: bold;
    }
    .trade-direction.LONG { color: #3fb950; }
    .trade-direction.SHORT { color: #f85149; }
    .trade-rr {
      background: #21262d;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
    }
    .trade-prices {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      text-align: center;
    }
    .price-box {
      padding: 10px;
      border-radius: 6px;
    }
    .price-box.entry { background: #21262d; }
    .price-box.stop { background: rgba(248, 81, 73, 0.2); }
    .price-box.target { background: rgba(63, 185, 80, 0.2); }
    .price-label {
      font-size: 10px;
      color: #8b949e;
      text-transform: uppercase;
      margin-bottom: 5px;
    }
    .price-value {
      font-size: 16px;
      font-weight: bold;
      font-family: monospace;
    }
    .price-pct {
      font-size: 11px;
      color: #8b949e;
      margin-top: 3px;
    }
    .price-pct.loss { color: #f85149; }
    .price-pct.profit { color: #3fb950; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Navigation Tabs -->
    <nav class="nav-tabs">
      <a href="/" class="nav-tab">
        <span class="tab-icon">📊</span>Screener
      </a>
      <a href="/focus" class="nav-tab active">
        <span class="tab-icon">🎯</span>Focus Mode
      </a>
    </nav>

    <h1>🎯 Focus Mode - Contrarian Trading</h1>

    <div class="status-bar">
      <div class="status-indicator">
        <div class="status-dot"></div>
        <span>Live • Updates every 10s</span>
      </div>
      <div class="config-selector">
        <label>Window Config:</label>
        <select id="config-select" onchange="changeConfig(this.value)">
          ${Object.entries(WINDOW_CONFIGS).map(([key, cfg]) =>
            `<option value="${key}" ${key === configKey ? 'selected' : ''}>${cfg.name}</option>`
          ).join('')}
        </select>
      </div>
      <div class="alert-controls">
        <button id="notif-btn" class="alert-btn" onclick="enableNotifications()">🔕 Enable Notifications</button>
        <button id="audio-btn" class="alert-btn active" onclick="toggleAudio()">🔊 Audio ON</button>
        <button class="alert-btn" onclick="playAlert('LONG')">🔊 Test Sound</button>
      </div>
    </div>

    <div class="regime-grid">
      <div class="regime-box macro">
        <div class="regime-label">MACRO REGIME (${config.macroHours}h)</div>
        <div class="regime-value ${macro.regime}">${macro.regime}</div>
        <div class="regime-stats">
          <div>Longs: ${macro.longPct}% | Shorts: ${macro.shortPct}%</div>
          <div class="stat-bar">
            <div class="stat-bar-fill long" style="width: ${macro.longPct}%"></div>
          </div>
          <div style="margin-top: 5px">${macro.count} signals</div>
        </div>
      </div>

      <div class="regime-box micro">
        <div class="regime-label">MICRO REGIME (${config.microHours}h)</div>
        <div class="regime-value ${micro.regime}">${micro.regime}</div>
        <div class="regime-stats">
          <div>Longs: ${micro.longPct}% | Shorts: ${micro.shortPct}%</div>
          <div class="stat-bar">
            <div class="stat-bar-fill long" style="width: ${micro.longPct}%"></div>
          </div>
          <div style="margin-top: 5px">${micro.count} signals</div>
        </div>
      </div>

      <div class="regime-box action">
        <div class="action-box">
          <div class="action-emoji">${rule.emoji}</div>
          <div class="quadrant">${quadrant}</div>
          <div class="action-text ${rule.action}">${rule.action}</div>
          <div class="action-desc">${rule.description}</div>
          <div class="confidence ${rule.confidence}">${rule.confidence} CONFIDENCE</div>
        </div>
      </div>
    </div>

    <!-- Multi-Config Alignment -->
    <div class="alignment-section">
      <div class="alignment-header">
        <span class="alignment-title">🔄 Multi-Config Alignment</span>
        <span class="alignment-badge ${
          alignmentSummary.aligned ? 'aligned' :
          alignmentSummary.direction === 'SKIP' ? 'skip' :
          alignmentSummary.direction === 'MIXED' ? 'mixed' : 'partial'
        }">
          ${alignmentSummary.aligned ? `✓ ALL ${alignmentSummary.direction}` :
            alignmentSummary.direction === 'SKIP' ? 'ALL SKIP' :
            alignmentSummary.direction === 'MIXED' ? 'CONFLICTING' :
            `${alignmentSummary.agreementCount}/${alignmentSummary.totalConfigs} ${alignmentSummary.direction}`}
        </span>
      </div>
      <div class="alignment-grid">
        ${allAlignments.map(a => `
          <div class="alignment-item ${a.configKey === configKey ? 'active' : ''}" onclick="changeConfig('${a.configKey}')">
            <div class="alignment-config-name">${a.configKey}</div>
            <div class="alignment-action ${a.action}">${a.action === 'SKIP' ? '⏸️' : a.action === 'LONG' ? '🟢' : '🔴'} ${a.action}</div>
            <div class="alignment-quadrant">${a.quadrant}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <h2>📋 Quick Reference - All Quadrant Rules</h2>
    <div class="rules-grid">
      ${Object.entries(QUADRANT_RULES).map(([q, r]) => `
        <div class="rule-box ${q === quadrant ? 'active' : ''}">
          <div class="rule-quadrant">${r.emoji} ${q}</div>
          <div class="rule-action">${r.action} - ${r.description}</div>
        </div>
      `).join('')}
    </div>

    <h2>🔥 Actionable Signals (Last Hour)</h2>
    ${actionableSignals.length > 0 ? `
      <div class="trade-cards">
        ${actionableSignals.map(s => {
          const action = rule.action as 'LONG' | 'SHORT';
          const tradeUrl = getMexcTradeUrl(s.symbol, action);
          const timeAgo = Math.round((Date.now() - new Date(s.timestamp).getTime()) / 60000);
          const entryPrice = s.entryPrice || s.price;

          // Get smart setup based on S/R levels
          const smart = calculateSmartTradeSetup(entryPrice, action, s.symbol);
          const formatPrice = (p: number) => p >= 1 ? p.toFixed(4) : p.toFixed(6);

          // Calculate ROE at suggested leverage
          const slROE = (smart.stopLossPct * smart.suggestedLeverage).toFixed(0);
          const tpROE = (smart.takeProfitPct * smart.suggestedLeverage).toFixed(0);

          // Determine trade quality based on R:R
          const rrClass = smart.riskRewardRatio >= 2 ? 'excellent' :
                          smart.riskRewardRatio >= 1.5 ? 'good' :
                          smart.riskRewardRatio >= 1 ? 'ok' :
                          smart.riskRewardRatio >= 0.7 ? 'poor' : 'bad';
          const rrLabel = smart.riskRewardRatio >= 2 ? '🔥 EXCELLENT' :
                          smart.riskRewardRatio >= 1.5 ? '✅ GOOD' :
                          smart.riskRewardRatio >= 1 ? '⚠️ FAIR' :
                          smart.riskRewardRatio >= 0.7 ? '⚠️ POOR' : '❌ UNFAVORABLE';

          // Signal strength indicator
          const signalCount = (s as any).signalCount || 1;
          const timeframes = (s as any).timeframes || [s.timeframe];
          const strengthLabel = signalCount >= 3 ? '🔥🔥🔥 STRONG' :
                                signalCount >= 2 ? '🔥🔥 MULTI-TF' : '';
          const strengthClass = signalCount >= 3 ? 'strong' : signalCount >= 2 ? 'multi' : 'single';

          return `
            <div class="trade-card ${action.toLowerCase()} rr-${rrClass} signal-${strengthClass}">
              <div class="trade-card-header">
                <span class="trade-symbol">${s.symbol}</span>
                <span class="trade-action ${action.toLowerCase()}">${action}</span>
                ${signalCount > 1 ? `<span class="signal-strength ${strengthClass}">${strengthLabel}</span>` : ''}
                <span class="trade-quality ${rrClass}">${rrLabel}</span>
                <span class="trade-time">${timeAgo}m ago</span>
              </div>
              ${signalCount > 1 ? `
              <div class="timeframes-row">
                <span class="tf-label">Timeframes:</span>
                ${timeframes.map((tf: string) => `<span class="tf-badge">${tf}</span>`).join('')}
                <span class="signal-count">(${signalCount} signals)</span>
              </div>
              ` : ''}

              <div class="trade-card-body">
                <div class="price-levels">
                  <div class="level-row resistance">
                    <span class="level-label">📈 Resistance</span>
                    <span class="level-price">$${formatPrice(smart.nearestResistance)}</span>
                  </div>
                  <div class="level-row entry">
                    <span class="level-label">➡️ Entry</span>
                    <span class="level-price">$${formatPrice(entryPrice)}</span>
                  </div>
                  <div class="level-row support">
                    <span class="level-label">📉 Support</span>
                    <span class="level-price">$${formatPrice(smart.nearestSupport)}</span>
                  </div>
                </div>

                <div class="trade-setup">
                  <div class="setup-row">
                    <span class="setup-label">🎯 Take Profit</span>
                    <span class="setup-value tp">$${formatPrice(smart.takeProfitPrice)}</span>
                    <span class="setup-pct">(+${smart.takeProfitPct.toFixed(1)}% / +${tpROE}% ROE)</span>
                  </div>
                  <div class="setup-row">
                    <span class="setup-label">🛑 Stop Loss</span>
                    <span class="setup-value sl">$${formatPrice(smart.stopLossPrice)}</span>
                    <span class="setup-pct">(-${smart.stopLossPct.toFixed(1)}% / -${slROE}% ROE)</span>
                  </div>
                  <div class="setup-row rr-highlight ${rrClass}">
                    <span class="setup-label">⚖️ Risk/Reward</span>
                    <span class="setup-value rr">${smart.riskRewardRatio.toFixed(2)}:1</span>
                    <span class="rr-bar"><span class="rr-fill" style="width: ${Math.min(smart.riskRewardRatio / 2 * 100, 100)}%"></span></span>
                  </div>
                </div>

                <div class="position-sizing">
                  <div class="sizing-item">
                    <span class="sizing-label">Suggested Leverage</span>
                    <span class="sizing-value leverage">${smart.suggestedLeverage}x</span>
                  </div>
                  <div class="sizing-item">
                    <span class="sizing-label">Position Size</span>
                    <span class="sizing-value position">${smart.suggestedPositionPct.toFixed(0)}% of balance</span>
                  </div>
                </div>
              </div>

              <div class="trade-card-footer">
                <a href="#" onclick="openMexcTrade('${s.symbol}'); return false;" class="trade-btn ${action.toLowerCase()}">
                  Open ${action} on MEXC →
                </a>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    ` : `
      <div class="no-signals">
        ${rule.action === 'SKIP'
          ? '⏸️ Current regime suggests waiting - no trades recommended'
          : '⏳ No triggered signals in the last hour. Waiting for opportunities...'}
      </div>
    `}

    <div class="refresh-note">
      Polling every 10s, full refresh every 60s | Last update: <span id="last-update">${new Date().toLocaleTimeString()}</span>
    </div>
  </div>

  <!-- Audio elements for alerts -->
  <audio id="alert-long" preload="auto">
    <source src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2LkZaWj4Z9dW5paW55hZGZnZyXkIiCfHh2eH6GjpWYmJSNhoF8d3Z4fYWOlZmZlY6Gg3x3dXh9hY6VmZmVjoaDfHd1eH2FjpWZmZWOhoN8d3V4fYWOlZmZlY6Gg3x3dXh9hY6VmZmVjoaDfA==" type="audio/wav">
  </audio>
  <audio id="alert-short" preload="auto">
    <source src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAAB9d3V4fYWOlZmZlY6Gg3x3dXh9hY6VmZmVjoaDfHd1eH2FjpWZmZWOhoN8d3V4fYWOlZmZlY6Gg3x3dXh9hY6VmZmVjoaDfHd1eH2FjpWZmZWOhoN8d3V4fYWOlZmZlY6GgYqFbF1fdA==" type="audio/wav">
  </audio>

  <script>
    let currentLeverage = 10;
    let lastQuadrant = '${quadrant}';
    let lastActionableCount = ${actionableSignals.length};
    let notificationsEnabled = false;
    let audioEnabled = true;
    let audioContext = null;

    // Get link destination setting from shared localStorage (same as Screener)
    function getLinkDestination() {
      try {
        const settings = localStorage.getItem('backburner_appSettings');
        if (settings) {
          const parsed = JSON.parse(settings);
          return parsed.linkDestination || 'futures';
        }
      } catch (e) {}
      return 'futures';  // default to futures for Focus Mode
    }

    // Open MEXC trade URL based on shared settings
    function openMexcTrade(symbol) {
      const base = symbol.replace('USDT', '');
      const dest = getLinkDestination();
      let url;
      if (dest === 'bots') {
        url = 'https://www.mexc.com/futures/trading-bots/grid/' + base + '_USDT';
      } else {
        url = 'https://www.mexc.com/futures/' + base + '_USDT';
      }
      window.open(url, '_blank');
    }

    function setLeverage(lev) {
      currentLeverage = lev;
      document.querySelectorAll('.leverage-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      updateTradeParams();
    }

    function updateTradeParams() {
      const rows = document.querySelectorAll('.signal-row');
      // Realistic targets based on excursion analysis
      const slPct = currentLeverage >= 10 ? 3 : 5;
      const tpPct = currentLeverage >= 10 ? 2 : 4;
      const rr = (tpPct / slPct).toFixed(1);
      // ROE = price % × leverage (what MEXC displays)
      const slROE = slPct * currentLeverage;
      const tpROE = tpPct * currentLeverage;

      rows.forEach(row => {
        const entry = parseFloat(row.dataset.entry);
        const direction = row.dataset.direction;
        const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);

        let slPrice, tpPrice;
        if (direction === 'LONG') {
          slPrice = entry * (1 - slPct / 100);
          tpPrice = entry * (1 + tpPct / 100);
        } else {
          slPrice = entry * (1 + slPct / 100);
          tpPrice = entry * (1 - tpPct / 100);
        }

        row.querySelector('.sl-price').textContent = '$' + formatPrice(slPrice);
        row.querySelector('.sl-roe').textContent = '-' + slROE + '% ROE';
        row.querySelector('.sl-pct').textContent = '(' + slPct + '% price)';
        row.querySelector('.tp-price').textContent = '$' + formatPrice(tpPrice);
        row.querySelector('.tp-roe').textContent = '+' + tpROE + '% ROE';
        row.querySelector('.tp-pct').textContent = '(' + tpPct + '% price)';
        row.querySelector('.rr-ratio').textContent = rr + ':1';
      });
    }

    function changeConfig(configKey) {
      // Navigate to same page with new config (preserve current path)
      window.location.href = window.location.pathname + '?config=' + encodeURIComponent(configKey);
    }

    // Request notification permission
    async function enableNotifications() {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        notificationsEnabled = permission === 'granted';
        updateNotificationButton();
        if (notificationsEnabled) {
          showToast('🔔 Notifications enabled!');
        }
      }
    }

    function updateNotificationButton() {
      const btn = document.getElementById('notif-btn');
      if (btn) {
        btn.textContent = notificationsEnabled ? '🔔 Notifications ON' : '🔕 Enable Notifications';
        btn.classList.toggle('active', notificationsEnabled);
      }
    }

    function toggleAudio() {
      audioEnabled = !audioEnabled;
      const btn = document.getElementById('audio-btn');
      if (btn) {
        btn.textContent = audioEnabled ? '🔊 Audio ON' : '🔇 Audio OFF';
        btn.classList.toggle('active', audioEnabled);
      }
      showToast(audioEnabled ? '🔊 Audio alerts enabled' : '🔇 Audio alerts muted');
    }

    // Play alert sound using Web Audio API
    function playAlert(type) {
      if (!audioEnabled) return;

      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        if (type === 'LONG') {
          // Rising tone for LONG
          oscillator.frequency.setValueAtTime(400, audioContext.currentTime);
          oscillator.frequency.linearRampToValueAtTime(800, audioContext.currentTime + 0.2);
          oscillator.frequency.linearRampToValueAtTime(600, audioContext.currentTime + 0.4);
        } else if (type === 'SHORT') {
          // Falling tone for SHORT
          oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
          oscillator.frequency.linearRampToValueAtTime(400, audioContext.currentTime + 0.2);
          oscillator.frequency.linearRampToValueAtTime(500, audioContext.currentTime + 0.4);
        } else {
          // Neutral beep
          oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
        }

        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
      } catch (e) {
        console.log('Audio not available:', e);
      }
    }

    // Show toast notification
    function showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    // Send browser notification
    function sendNotification(title, body, action) {
      if (!notificationsEnabled) return;

      try {
        const notif = new Notification(title, {
          body: body,
          icon: action === 'LONG' ? '🟢' : action === 'SHORT' ? '🔴' : '⏸️',
          tag: 'focus-mode',
          requireInteraction: true
        });

        notif.onclick = () => {
          window.focus();
          notif.close();
        };
      } catch (e) {
        console.log('Notification error:', e);
      }
    }

    // Poll for updates
    async function checkForUpdates() {
      try {
        const currentConfig = document.getElementById('config-select')?.value || '${configKey}';
        const response = await fetch('/api/status?config=' + encodeURIComponent(currentConfig));
        const data = await response.json();

        const newQuadrant = data.quadrant;
        const newAction = data.rule.action;
        const newActionableCount = data.actionableSignals.length;

        // Check if regime changed to actionable
        if (newAction !== 'SKIP' && (newQuadrant !== lastQuadrant || newActionableCount > lastActionableCount)) {
          // Play sound
          playAlert(newAction);

          // Send notification
          const signalText = newActionableCount > 0
            ? \`\${newActionableCount} signal(s) available!\`
            : 'Regime is now actionable';
          sendNotification(
            \`🎯 \${newAction} Signal!\`,
            \`\${newQuadrant}: \${data.rule.description}\\n\${signalText}\`,
            newAction
          );

          // Flash the page
          document.body.classList.add('alert-flash');
          setTimeout(() => document.body.classList.remove('alert-flash'), 1000);
        }

        // Check if new signals appeared in an already-actionable regime
        if (newAction !== 'SKIP' && newActionableCount > lastActionableCount && newQuadrant === lastQuadrant) {
          playAlert(newAction);
          sendNotification(
            '🔥 New Signal!',
            \`\${data.actionableSignals[0]?.symbol || 'New'} - \${newAction}\`,
            newAction
          );
        }

        lastQuadrant = newQuadrant;
        lastActionableCount = newActionableCount;

        // Update timestamp
        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();

      } catch (e) {
        console.log('Update check failed:', e);
      }
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      // Check notification permission status
      if ('Notification' in window && Notification.permission === 'granted') {
        notificationsEnabled = true;
      }
      updateNotificationButton();

      // Start polling every 10 seconds
      setInterval(checkForUpdates, 10000);

      // Refresh full page every 60 seconds to get new signals list
      setTimeout(() => location.reload(), 60000);
    });

    // Wake up audio context on first interaction
    document.addEventListener('click', () => {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }
    }, { once: true });
  </script>
</body>
</html>
  `;
}

// Export API data generator for use by web-server.ts
export function getFocusModeApiData(configKeyParam?: string) {
  const configKey = configKeyParam || DEFAULT_CONFIG;
  const config = WINDOW_CONFIGS[configKey] || WINDOW_CONFIGS[DEFAULT_CONFIG];

  const signals = loadRecentSignals(Math.max(config.macroHours, 24));
  const macro = getMacroRegime(signals, config);
  const micro = getMicroRegime(signals, config);
  const quadrant: Quadrant = `${macro.regime}+${micro.regime}`;
  const rule = QUADRANT_RULES[quadrant];
  const actionableSignals = getActionableSignals(signals, quadrant);

  return {
    timestamp: new Date().toISOString(),
    config: configKey,
    configDetails: config,
    macro,
    micro,
    quadrant,
    rule,
    actionableSignals: actionableSignals.map(s => ({
      symbol: s.symbol,
      direction: s.direction,
      entryPrice: s.entryPrice || s.price,
      rsi: s.rsi,
      timestamp: s.timestamp,
      mexcUrl: getMexcTradeUrl(s.symbol, rule.action as 'LONG' | 'SHORT'),
    })),
  };
}

// ============= Standalone Express Server =============
// Only starts if this file is run directly (not imported)

const app = express();
const PORT = 3847;

app.get('/', (req, res) => {
  const configKey = req.query.config as string;
  res.send(getFocusModeHtml(configKey));
});

app.get('/api/status', (req, res) => {
  const configKey = req.query.config as string;
  res.json(getFocusModeApiData(configKey));
});

// Start server only if run directly (not imported)
// Check if this module is the main entry point
const isMainModule = process.argv[1]?.includes('focus-mode-dashboard');

if (isMainModule) {
  app.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('🎯 FOCUS MODE DASHBOARD (Standalone)');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`API:       http://localhost:${PORT}/api/status`);
    console.log('');
    console.log('The dashboard shows:');
    console.log('  • Current macro (24h) and micro (4h) regime');
    console.log('  • Recommended action based on contrarian strategy');
    console.log('  • One-click links to MEXC for each signal');
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');
  });
}
