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
  triggeredAt?: number;
  playedOutAt?: number;
  detectedAt?: number;
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
  triggeredAtDisplay?: string;  // Formatted triggered time
  playedOutAtDisplay?: string;  // Formatted played out time
}

function formatTimestamp(ts: number | string | undefined): string {
  if (!ts) return '';
  const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeAgo(ts: number | string | undefined): string {
  if (!ts) return '';
  const time = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const mins = Math.round((Date.now() - time) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface SignalGroups {
  active: CombinedSignal[];
  archive: CombinedSignal[];
  isSkipRegime?: boolean;
}

// Time window options in hours
const TIME_WINDOW_OPTIONS = [1, 2, 4, 8, 12, 24];

function getSignalGroups(signals: Signal[], quadrant: Quadrant, activeWindowHours: number = 4): SignalGroups {
  const rule = QUADRANT_RULES[quadrant];

  const now = Date.now();
  const last24h = now - 24 * 60 * 60 * 1000;
  const activeWindowMs = now - activeWindowHours * 60 * 60 * 1000;

  // Filter to recent signals (24h for archive, user-selected window for active)
  const recentSignals = signals.filter(s => {
    const ts = new Date(s.timestamp).getTime();
    const hasEntry = s.entryPrice && (s.eventType === 'triggered' || s.state === 'triggered' || s.state === 'deep_extreme' || s.state === 'played_out');
    return ts >= last24h && hasEntry;
  });

  // Separate active vs played out/expired
  // Active signals: not played out AND within selected time window
  const activeSignals = recentSignals.filter(s =>
    s.state !== 'played_out' && new Date(s.timestamp).getTime() >= activeWindowMs
  );

  // Archive signals: either formally played_out OR older than the active window (expired)
  // This prevents signals from "disappearing" when they age out of the active window
  const playedOutSignals = recentSignals.filter(s =>
    s.state === 'played_out' || new Date(s.timestamp).getTime() < activeWindowMs
  );

  // Helper to combine signals by symbol
  const combineSignals = (sigs: Signal[]): CombinedSignal[] => {
    const grouped = new Map<string, Signal[]>();
    for (const s of sigs) {
      const key = `${s.symbol}_${s.direction}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(s);
    }

    const combined: CombinedSignal[] = [];
    for (const [_, groupSignals] of grouped) {
      groupSignals.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const newest = groupSignals[0];
      const oldest = groupSignals[groupSignals.length - 1];
      const timeframes = [...new Set(groupSignals.map(s => s.timeframe))].sort();

      combined.push({
        ...newest,
        timeframes,
        signalCount: groupSignals.length,
        oldestTimestamp: oldest.timestamp,
        newestTimestamp: newest.timestamp,
        triggeredAtDisplay: formatTimestamp(newest.triggeredAt || newest.timestamp),
        playedOutAtDisplay: newest.playedOutAt ? formatTimestamp(newest.playedOutAt) : undefined,
      });
    }

    // Sort by signal count, then time
    combined.sort((a, b) => {
      if (b.signalCount !== a.signalCount) return b.signalCount - a.signalCount;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return combined;
  };

  // Even during SKIP regime, still show active signals
  // Users may have open positions that need monitoring
  // The position monitor will warn about regime misalignment
  return {
    active: combineSignals(activeSignals), // Show ALL active signals, even during SKIP
    archive: combineSignals(playedOutSignals), // Show all played out
    isSkipRegime: rule.action === 'SKIP' // Flag so UI can show warning
  };
}

// Keep for backward compatibility
function getActionableSignals(signals: Signal[], quadrant: Quadrant): CombinedSignal[] {
  return getSignalGroups(signals, quadrant).active;
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

export interface SmartTradeSetup {
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

export function calculateSmartTradeSetup(
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
export function getFocusModeHtml(configKeyParam?: string, activeWindowHours: number = 4): string {
  const configKey = configKeyParam || DEFAULT_CONFIG;
  const config = WINDOW_CONFIGS[configKey] || WINDOW_CONFIGS[DEFAULT_CONFIG];

  const signals = loadRecentSignals(Math.max(config.macroHours, 24)); // Load enough signals
  const macro = getMacroRegime(signals, config);
  const micro = getMicroRegime(signals, config);
  const quadrant: Quadrant = `${macro.regime}+${micro.regime}`;
  const rule = QUADRANT_RULES[quadrant];
  const signalGroups = getSignalGroups(signals, quadrant, activeWindowHours);
  const actionableSignals = signalGroups.active;
  const archivedSignals = signalGroups.archive;

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

    .tracking-separator {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      color: #8b949e;
      font-size: 12px;
      font-weight: 500;
    }
    .tracking-separator::before,
    .tracking-separator::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, #30363d, #30363d, transparent);
    }
    .tracking-separator span {
      white-space: nowrap;
      padding: 4px 12px;
      background: #21262d;
      border-radius: 12px;
      border: 1px solid #30363d;
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
      color: #8b949e;
      font-size: 11px;
      flex-shrink: 0;
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

    /* Collapsible card styles */
    .trade-card-header {
      cursor: pointer;
      user-select: none;
      flex-wrap: wrap;
      row-gap: 6px;
    }
    .trade-card-header:hover {
      background: #30363d;
    }
    .header-spacer {
      flex: 1;
    }
    .collapse-icon {
      transition: transform 0.2s ease;
      color: #6e7681;
      font-size: 12px;
      flex-shrink: 0;
    }
    .trade-card.collapsed .collapse-icon {
      transform: rotate(-90deg);
    }
    .trade-card-collapsible {
      transition: max-height 0.3s ease, opacity 0.2s ease;
      overflow: hidden;
    }
    .trade-card.collapsed .trade-card-collapsible {
      max-height: 0 !important;
      opacity: 0;
      padding: 0;
    }

    /* Position status in header (visible when monitoring) */
    .header-position-status {
      display: none;
      width: 100%;
      flex-basis: 100%;
      order: 99; /* Force to end of flex container */
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid #30363d;
      font-size: 11px;
    }
    .header-position-status.active {
      display: block;
    }
    .header-pnl {
      display: inline-block;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      margin-right: 8px;
      vertical-align: middle;
    }
    .header-pnl.profit {
      background: rgba(63, 185, 80, 0.2);
      color: #3fb950;
    }
    .header-pnl.loss {
      background: rgba(248, 81, 73, 0.2);
      color: #f85149;
    }
    .header-pnl.neutral {
      background: rgba(139, 148, 158, 0.2);
      color: #8b949e;
    }
    .header-suggestion {
      display: inline;
      color: #8b949e;
      font-size: 11px;
      vertical-align: middle;
    }
    .header-suggestion.warning {
      color: #d29922;
    }
    .header-suggestion.action {
      color: #3fb950;
    }
    .header-suggestion.danger {
      color: #f85149;
      font-weight: 600;
    }
    .header-conflict-badge {
      display: none;
      padding: 2px 6px;
      background: rgba(248, 81, 73, 0.3);
      border: 1px solid #f85149;
      color: #f85149;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      margin-left: 6px;
      animation: conflict-pulse 1.5s ease-in-out infinite;
    }
    .header-conflict-badge.visible {
      display: inline-block;
    }
    @keyframes conflict-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Card update highlight effect */
    @keyframes card-highlight {
      0% { box-shadow: 0 0 0 2px #58a6ff; }
      100% { box-shadow: none; }
    }
    .trade-card.highlight {
      animation: card-highlight 2s ease-out;
    }
    .trade-card.collapsed.highlight {
      animation: card-highlight 3s ease-out;
    }

    /* Update badge for collapsed cards */
    .update-badge {
      display: none;
      background: #58a6ff;
      color: #0d1117;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
      animation: pulse-badge 1.5s ease-in-out infinite;
    }
    .update-badge.show {
      display: inline-block;
    }
    @keyframes pulse-badge {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Distance from entry badge */
    .entry-distance {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 5px;
      border-radius: 4px;
      font-family: monospace;
      flex-shrink: 0;
    }
    .entry-distance.favorable {
      background: rgba(63, 185, 80, 0.2);
      color: #3fb950;
    }
    .entry-distance.against {
      background: rgba(248, 81, 73, 0.2);
      color: #f85149;
    }
    .entry-distance.neutral {
      background: rgba(139, 148, 158, 0.2);
      color: #8b949e;
    }
    /* Stale signal indicator (moved >20% from entry) */
    .trade-card.stale {
      opacity: 0.7;
      border-style: dashed;
    }
    .trade-card.stale .trade-card-header::after {
      content: ' (Extended)';
      color: #8b949e;
      font-size: 11px;
      font-weight: normal;
    }
    /* Entry distance in expanded view */
    .entry-current-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
      color: #8b949e;
      border-bottom: 1px solid #21262d;
      margin-bottom: 6px;
    }
    .entry-current-row .current-price {
      font-family: monospace;
      font-weight: 600;
    }
    .entry-current-row .current-price.up { color: #3fb950; }
    .entry-current-row .current-price.down { color: #f85149; }
    .entry-current-row .distance-pct {
      font-family: monospace;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .entry-current-row .distance-pct.favorable {
      background: rgba(63, 185, 80, 0.15);
      color: #3fb950;
    }
    .entry-current-row .distance-pct.against {
      background: rgba(248, 81, 73, 0.15);
      color: #f85149;
    }

    /* Trailing Stop Alerts Bar */
    .trail-alerts-bar {
      background: linear-gradient(135deg, #5c2d2d 0%, #3d1f1f 100%);
      border: 1px solid #f85149;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      display: none;
    }
    .trail-alerts-bar.active {
      display: block;
      animation: pulse-alert 2s ease-in-out infinite;
    }
    @keyframes pulse-alert {
      0%, 100% { border-color: #f85149; box-shadow: 0 0 5px rgba(248, 81, 73, 0.3); }
      50% { border-color: #ff7b72; box-shadow: 0 0 15px rgba(248, 81, 73, 0.5); }
    }
    .trail-alerts-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 600;
      color: #ff7b72;
    }
    .trail-alerts-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .trail-alert-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(248, 81, 73, 0.2);
      border: 1px solid #f85149;
      border-radius: 6px;
      color: #ff7b72;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .trail-alert-item:hover {
      background: rgba(248, 81, 73, 0.3);
      transform: translateY(-1px);
    }
    .trail-alert-item .symbol {
      font-weight: 600;
      color: #fff;
    }
    .trail-alert-item .direction {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .trail-alert-item .direction.long { background: #238636; }
    .trail-alert-item .direction.short { background: #da3633; }
    .trail-alert-item .price {
      font-family: monospace;
      color: #f0883e;
    }
    .trail-alert-dismiss {
      background: none;
      border: none;
      color: #8b949e;
      cursor: pointer;
      padding: 2px;
      font-size: 14px;
      line-height: 1;
    }
    .trail-alert-dismiss:hover { color: #fff; }

    /* Signals header with collapse controls */
    .signals-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 15px;
    }
    .signals-header h2 {
      margin: 0;
    }
    .collapse-controls {
      display: flex;
      gap: 8px;
    }
    .collapse-btn {
      padding: 6px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .collapse-btn:hover {
      background: #30363d;
      color: #c9d1d9;
    }

    /* Search filter */
    .search-filter {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1;
      min-width: 200px;
      padding: 10px 15px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 14px;
    }
    .search-input:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .search-input::placeholder {
      color: #6e7681;
    }
    .search-count {
      color: #8b949e;
      font-size: 12px;
      white-space: nowrap;
    }
    .time-window-select {
      padding: 10px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 14px;
      cursor: pointer;
    }
    .time-window-select:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .time-window-label {
      color: #8b949e;
      font-size: 12px;
      white-space: nowrap;
    }

    /* Investment amount input */
    .investment-input-group {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 10px;
      padding-left: 10px;
      border-left: 1px solid #30363d;
    }
    .investment-input {
      width: 80px;
      padding: 8px 10px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 13px;
      text-align: right;
    }
    .investment-input:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .investment-save-btn {
      padding: 8px 12px;
      background: #238636;
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .investment-save-btn:hover {
      background: #2ea043;
    }
    .investment-save-btn:disabled {
      background: #21262d;
      color: #8b949e;
      cursor: not-allowed;
    }

    /* Archive section */
    .archive-section {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #30363d;
    }
    .archive-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 15px;
      cursor: pointer;
    }
    .archive-header h3 {
      margin: 0;
      color: #8b949e;
      font-size: 16px;
    }
    .archive-toggle {
      color: #6e7681;
      font-size: 12px;
    }
    .archive-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 10px;
    }
    .archive-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px;
      opacity: 0.7;
    }
    .archive-card:hover {
      opacity: 1;
    }
    .archive-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .archive-symbol {
      font-weight: bold;
      color: #c9d1d9;
    }
    .archive-timestamps {
      font-size: 11px;
      color: #6e7681;
      margin-top: 8px;
    }
    .archive-timestamps span {
      display: block;
    }
    .played-out-badge {
      background: #21262d;
      color: #6e7681;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      text-decoration: line-through;
    }
    .expired-badge {
      background: rgba(136, 87, 44, 0.3);
      color: #d29922;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
    }
    .archive-card.expired {
      border-left: 3px solid #d29922;
    }

    /* Orphaned position cards (signal expired but position still active) */
    .trade-card.orphaned {
      border-left: 4px solid #d29922;
      background: linear-gradient(135deg, #161b22 0%, #1a1f26 100%);
    }
    .trade-card.orphaned .trade-card-header {
      background: linear-gradient(90deg, rgba(210, 153, 34, 0.1) 0%, transparent 50%);
    }
    .orphaned-badge {
      background: rgba(210, 153, 34, 0.3);
      color: #d29922;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
      flex-shrink: 0;
      animation: pulse-orphan 2s ease-in-out infinite;
    }
    @keyframes pulse-orphan {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .orphaned-notice {
      background: rgba(210, 153, 34, 0.1);
      border: 1px solid rgba(210, 153, 34, 0.3);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 10px;
      font-size: 12px;
      color: #d29922;
    }
    .leverage-badge {
      background: rgba(88, 166, 255, 0.2);
      color: #58a6ff;
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
      flex-shrink: 0;
    }

    /* Position Monitor Styles */
    .position-monitor {
      margin-top: 10px;
      padding: 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
    }
    .position-monitor.active {
      border-color: #58a6ff;
      background: #0d1117;
    }
    .monitor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .monitor-title {
      font-size: 12px;
      font-weight: 600;
      color: #58a6ff;
    }
    .monitor-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }
    .monitor-badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
    }
    .monitor-badge.healthy { background: #238636; color: white; }
    .monitor-badge.warning { background: #9e6a03; color: white; }
    .monitor-badge.danger { background: #da3633; color: white; }

    .monitor-content {
      display: grid;
      gap: 8px;
    }
    .monitor-content.collapsed {
      display: none;
    }

    .health-indicator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #161b22;
      border-radius: 6px;
      font-size: 12px;
    }
    .health-label {
      color: #8b949e;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .health-value {
      font-weight: 600;
    }
    .health-value.good { color: #3fb950; }
    .health-value.warning { color: #d29922; }
    .health-value.bad { color: #f85149; }
    .health-value.neutral { color: #8b949e; }

    .monitor-suggestion {
      padding: 10px;
      background: #21262d;
      border-radius: 6px;
      border-left: 3px solid #58a6ff;
      font-size: 12px;
      color: #c9d1d9;
    }
    .monitor-suggestion.warning {
      border-left-color: #d29922;
      background: #1c1c00;
    }
    .monitor-suggestion.action {
      border-left-color: #3fb950;
      background: #0d1a0d;
    }

    /* Manual entry and trailing stop */
    .monitor-entry-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      margin-bottom: 8px;
    }
    .entry-label {
      color: #8b949e;
      font-size: 12px;
      min-width: 80px;
    }
    .entry-input {
      flex: 1;
      padding: 6px 10px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #c9d1d9;
      font-size: 13px;
      font-family: monospace;
      max-width: 120px;
    }
    .entry-input:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .entry-btn {
      padding: 6px 10px;
      background: #238636;
      border: none;
      border-radius: 4px;
      color: white;
      font-size: 11px;
      cursor: pointer;
    }
    .entry-btn:hover {
      background: #2ea043;
    }
    .current-price {
      font-family: monospace;
      font-weight: 600;
      color: #c9d1d9;
    }
    .trailing-stop-box {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 10px;
      margin-top: 8px;
    }
    .trailing-stop-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .trailing-stop-title {
      font-size: 12px;
      color: #8b949e;
    }
    .trailing-stop-value {
      font-family: monospace;
      font-weight: 600;
      font-size: 14px;
    }
    .trailing-stop-value.profit { color: #3fb950; }
    .trailing-stop-value.breakeven { color: #d29922; }
    .trailing-stop-value.loss { color: #f85149; }
    .trailing-stop-info {
      font-size: 11px;
      color: #6e7681;
      margin-top: 4px;
    }
    .pnl-display {
      font-size: 16px;
      font-weight: 600;
      text-align: center;
      padding: 8px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .pnl-display.profit { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
    .pnl-display.loss { background: rgba(248, 81, 73, 0.15); color: #f85149; }
    .pnl-display.neutral { background: rgba(139, 148, 158, 0.15); color: #8b949e; }

    .enter-trade-btn {
      width: 100%;
      padding: 10px;
      margin-top: 10px;
      background: transparent;
      border: 1px dashed #30363d;
      border-radius: 6px;
      color: #8b949e;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    .enter-trade-btn:hover {
      border-color: #58a6ff;
      color: #58a6ff;
      background: #0d1117;
    }
    .exit-trade-btn {
      padding: 6px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #8b949e;
      cursor: pointer;
      font-size: 11px;
    }
    .exit-trade-btn:hover {
      background: #da3633;
      border-color: #da3633;
      color: white;
    }
    .close-all-btn {
      padding: 6px 12px;
      background: #21262d;
      border: 1px solid #da3633;
      border-radius: 4px;
      color: #f85149;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      margin-left: 10px;
      display: none; /* Hidden until positions exist */
    }
    .close-all-btn:hover {
      background: #da3633;
      color: white;
    }
    .close-all-btn.visible {
      display: inline-block;
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

    /* Modal styles */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    .modal-content {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      width: 90%;
      max-width: 700px;
      max-height: 90vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid #30363d;
    }
    .modal-header h3 {
      margin: 0;
      color: #c9d1d9;
      font-size: 16px;
    }
    .modal-close {
      background: none;
      border: none;
      color: #8b949e;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .modal-close:hover { color: #c9d1d9; }
    .modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }
    .modal-body textarea {
      width: 100%;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      resize: vertical;
      box-sizing: border-box;
    }
    .modal-body textarea:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .modal-preview {
      margin-top: 15px;
      padding: 12px;
      background: #0d1117;
      border-radius: 6px;
      max-height: 200px;
      overflow-y: auto;
    }
    .modal-preview-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      font-size: 13px;
    }
    .modal-preview-item:last-child { border-bottom: none; }
    .modal-preview-item .symbol { color: #58a6ff; font-weight: 600; }
    .modal-preview-item .roi { font-family: monospace; }
    .modal-preview-item .roi.profit { color: #3fb950; }
    .modal-preview-item .roi.loss { color: #f85149; }
    .modal-preview-item .status { color: #8b949e; font-size: 11px; }
    .modal-preview-item .matched { color: #3fb950; }
    .modal-preview-item .unmatched { color: #6e7681; }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 20px;
      border-top: 1px solid #30363d;
    }
    .modal-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid #30363d;
    }
    .modal-btn.secondary {
      background: transparent;
      color: #c9d1d9;
    }
    .modal-btn.secondary:hover { background: #21262d; }
    .modal-btn.primary {
      background: #238636;
      border-color: #238636;
      color: white;
    }
    .modal-btn.primary:hover { background: #2ea043; }
    .modal-btn.success {
      background: #1f6feb;
      border-color: #1f6feb;
      color: white;
    }
    .modal-btn.success:hover { background: #388bfd; }
    .modal-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
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
        <button id="notif-btn" class="alert-btn" onclick="toggleNotifications()">🔕 Notifications OFF</button>
        <button id="audio-btn" class="alert-btn active" onclick="toggleAudio()">🔊 Audio ON</button>
        <button class="alert-btn" onclick="testSound()">🔊 Test Sound</button>
        <button class="alert-btn" onclick="testNotification()">🔔 Test Notif</button>
        <button id="link-btn" class="alert-btn" onclick="toggleLinkDestination()">📊 Futures</button>
        <button class="alert-btn" onclick="showBulkUpdateModal()">📋 Bulk Update</button>
      </div>

      <!-- Bulk Update Modal -->
      <div id="bulk-update-modal" class="modal-overlay" style="display: none;">
        <div class="modal-content">
          <div class="modal-header">
            <h3>📋 Bulk Update Positions from MEXC</h3>
            <button class="modal-close" onclick="closeBulkUpdateModal()">×</button>
          </div>
          <div class="modal-body">
            <p style="color: #8b949e; margin-bottom: 10px;">Paste your MEXC grid bot table data below. This will update ROI and leverage for all matching tracked positions.</p>
            <textarea id="bulk-paste-input" placeholder="Paste MEXC grid bot table here...
Example:
BERAUSDT
Short15XAI
0D 2h 37m 54s
0.8892 - 1.0772
8 (Arithmetic)
40.4756 USDT
+18.0825 USDT+44.67%
..." rows="12"></textarea>
            <div class="modal-preview" id="bulk-preview"></div>
          </div>
          <div class="modal-footer">
            <button class="modal-btn secondary" onclick="closeBulkUpdateModal()">Cancel</button>
            <button class="modal-btn primary" onclick="parseBulkUpdate()">Preview</button>
            <button class="modal-btn success" onclick="applyBulkUpdate()" id="apply-bulk-btn" disabled>Apply Updates</button>
          </div>
        </div>
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

    <div class="search-filter">
      <input type="text" id="signal-search" class="search-input" placeholder="🔍 Filter by symbol (e.g., BTC, ETH, DOGE...)" oninput="filterSignals(this.value)">
      <span class="time-window-label">Show:</span>
      <select id="time-window-select" class="time-window-select" onchange="changeTimeWindow(this.value)">
        <option value="1" ${activeWindowHours === 1 ? 'selected' : ''}>Last 1h</option>
        <option value="2" ${activeWindowHours === 2 ? 'selected' : ''}>Last 2h</option>
        <option value="4" ${activeWindowHours === 4 ? 'selected' : ''}>Last 4h</option>
        <option value="8" ${activeWindowHours === 8 ? 'selected' : ''}>Last 8h</option>
        <option value="12" ${activeWindowHours === 12 ? 'selected' : ''}>Last 12h</option>
        <option value="24" ${activeWindowHours === 24 ? 'selected' : ''}>Last 24h</option>
      </select>
      <span class="time-window-label">Sort:</span>
      <select id="sort-select" class="time-window-select" onchange="sortSignals(this.value)">
        <option value="time-desc">Newest first</option>
        <option value="time-asc">Oldest first</option>
        <option value="urgency-desc">🚨 Most urgent first</option>
        <option value="quality-desc">Best quality first</option>
        <option value="quality-asc">Worst quality first</option>
        <option value="alpha-asc">A → Z</option>
        <option value="alpha-desc">Z → A</option>
        <option value="tracking-first">Tracking first</option>
        <option value="tracking-last">Tracking last</option>
      </select>
      <span class="search-count" id="search-count">${actionableSignals.length} active</span>
      <div class="investment-input-group">
        <span class="time-window-label">💰</span>
        <span class="time-window-label">$</span>
        <input type="number" id="investment-amount-input" class="investment-input" placeholder="2000" min="1" step="100" title="Your MEXC investment amount">
        <button class="investment-save-btn" id="investment-save-btn" onclick="saveInvestmentAmount()" title="Update investment amount">Save</button>
      </div>
      <button class="close-all-btn" id="close-all-btn" onclick="closeAllPositions()" title="Stop tracking all positions">🛑 Close All</button>
    </div>

    <!-- Trailing Stop Alerts Bar -->
    <div class="trail-alerts-bar" id="trail-alerts-bar">
      <div class="trail-alerts-header">
        🛑 TRAILING STOP ALERTS - Action Required
      </div>
      <div class="trail-alerts-list" id="trail-alerts-list">
        <!-- Populated dynamically -->
      </div>
    </div>

    <div class="signals-header">
      <h2>🔥 Active Signals (Last ${activeWindowHours}h)</h2>
      ${actionableSignals.length > 0 ? `
      <div class="collapse-controls">
        <button class="collapse-btn" onclick="collapseAllCards()">▲ Collapse All</button>
        <button class="collapse-btn" onclick="expandAllCards()">▼ Expand All</button>
      </div>
      ` : ''}
    </div>
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

          // Timestamp display
          const triggeredTime = (s as any).triggeredAtDisplay || formatTimestamp(s.triggeredAt || s.timestamp);

          const signalDirection = s.direction.toUpperCase(); // Use signal's direction, not regime action
          const cardId = `card-${s.symbol}-${signalDirection}`.replace(/[^a-zA-Z0-9-]/g, '');

          return `
            <div class="trade-card ${action.toLowerCase()} rr-${rrClass} signal-${strengthClass}" id="${cardId}" data-symbol="${s.symbol}" data-timestamp="${new Date(s.timestamp).getTime()}" data-leverage="${smart.suggestedLeverage}" data-quality="${smart.riskRewardRatio.toFixed(2)}" data-signals="${signalCount}" data-signal-entry="${entryPrice}" data-direction="${action}">
              <div class="trade-card-header" onclick="toggleCard('${cardId}')">
                <span class="trade-symbol">${s.symbol.replace('USDT', '')}</span>
                <span class="trade-action ${action.toLowerCase()}">${action}</span>
                ${signalCount > 1 ? `<span class="signal-strength ${strengthClass}">${strengthLabel}</span>` : ''}
                <span class="trade-quality ${rrClass}">${rrLabel}</span>
                <span class="entry-distance neutral" id="entry-distance-${cardId}" title="Distance from signal entry">📍 --</span>
                <span class="trade-time" title="Triggered at ${triggeredTime}">${timeAgo}m ago</span>
                <span class="update-badge" id="update-badge-${cardId}">UPDATED</span>
                <span class="header-spacer"></span>
                <span class="collapse-icon">▼</span>
                <div class="header-position-status" id="header-status-${cardId}">
                  <span class="header-pnl neutral" id="header-pnl-${cardId}">--</span>
                  <span class="header-conflict-badge" id="header-conflict-${cardId}">⚠️ CONFLICT</span>
                  <span class="header-suggestion" id="header-suggestion-${cardId}">Monitoring...</span>
                </div>
              </div>

              <div class="trade-card-collapsible">
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

                <!-- Entry to Current Price Movement -->
                <div class="entry-current-row" id="entry-current-${cardId}">
                  <span class="entry-current-label">📍 Signal Entry → Current:</span>
                  <span class="entry-current-value" id="entry-current-value-${cardId}">$${formatPrice(entryPrice)} → Loading...</span>
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

                ${signalCount > 1 ? `
                <div class="timeframes-row">
                  <span class="tf-label">Timeframes:</span>
                  ${timeframes.map((tf: string) => `<span class="tf-badge">${tf}</span>`).join('')}
                  <span class="signal-count">(${signalCount} signals)</span>
                </div>
                ` : ''}

                <!-- Position Monitor Section -->
                <div class="position-monitor" id="monitor-${cardId}" data-symbol="${s.symbol}" data-direction="${action}" data-entry="${entryPrice}" data-target="${smart.takeProfitPrice}" data-stop="${smart.stopLossPrice}" data-rsi="${s.rsi || 50}" data-triggered="${s.triggeredAt || Date.now()}">
                  <button class="enter-trade-btn" id="enter-btn-${cardId}" onclick="enterTrade('${cardId}', '${s.symbol}', '${action}', ${entryPrice}, ${s.rsi || 50}, ${smart.takeProfitPrice}, ${smart.stopLossPrice})">
                    📊 I'm in this trade - Start Monitoring
                  </button>
                  <div class="monitor-active" id="monitor-active-${cardId}" style="display: none;">
                    <div class="monitor-header" onclick="toggleMonitor('${cardId}')">
                      <span class="monitor-title">📊 Position Monitor</span>
                      <div class="monitor-summary">
                        <span class="monitor-badge healthy" id="monitor-badge-${cardId}">✓ Healthy</span>
                        <button class="exit-trade-btn" onclick="event.stopPropagation(); exitTrade('${cardId}')">Exit Monitor</button>
                      </div>
                    </div>
                    <div class="monitor-content" id="monitor-content-${cardId}">
                      <!-- Manual Entry Price or ROI -->
                      <div class="monitor-entry-row">
                        <span class="entry-label">My Entry:</span>
                        <input type="text" class="entry-input" id="entry-input-${cardId}"
                               value="${entryPrice}"
                               onchange="updateManualEntry('${cardId}')"
                               onclick="event.stopPropagation()">
                        <button class="entry-btn" onclick="event.stopPropagation(); updateManualEntry('${cardId}')">Set</button>
                      </div>
                      <div class="monitor-entry-row">
                        <span class="entry-label">Or ROI%:</span>
                        <input type="text" class="entry-input" id="roi-input-${cardId}"
                               placeholder="e.g. 44.5 or -12.3"
                               onclick="event.stopPropagation()">
                        <button class="entry-btn" onclick="event.stopPropagation(); updateFromROI('${cardId}')">Calc</button>
                      </div>

                      <!-- P&L Display -->
                      <div class="pnl-display neutral" id="pnl-display-${cardId}">
                        Calculating...
                      </div>

                      <!-- Trailing Stop Suggestion -->
                      <div class="trailing-stop-box">
                        <div class="trailing-stop-header">
                          <span class="trailing-stop-title">🛡️ Suggested Stop Loss</span>
                          <span class="trailing-stop-value neutral" id="trail-stop-${cardId}">--</span>
                        </div>
                        <div class="trailing-stop-info" id="trail-info-${cardId}">
                          Enter trade to see trailing stop suggestions
                        </div>
                      </div>

                      <div class="health-indicator" style="margin-top: 10px;">
                        <span class="health-label">⏱️ Time in Trade</span>
                        <span class="health-value neutral" id="health-time-${cardId}">0m</span>
                      </div>
                      <div class="health-indicator">
                        <span class="health-label">🎯 Regime Alignment</span>
                        <span class="health-value neutral" id="health-regime-${cardId}">--</span>
                      </div>
                      <div class="monitor-suggestion" id="monitor-suggestion-${cardId}">
                        💡 Set your actual entry price above for accurate P&L tracking.
                      </div>
                    </div>
                  </div>
                </div>

                <div class="trade-card-footer">
                  <a href="#" onclick="openMexcTrade('${s.symbol}'); return false;" class="trade-btn ${action.toLowerCase()}">
                    Open ${action} on MEXC →
                  </a>
                </div>
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

    ${archivedSignals.length > 0 ? `
    <div class="archive-section" id="archive-section">
      <div class="archive-header" onclick="toggleArchive()">
        <h3>📦 Archive (Last 24h) - ${archivedSignals.length} signals</h3>
        <span class="archive-toggle" id="archive-toggle">▼ Show</span>
      </div>
      <div class="archive-cards" id="archive-cards" style="display: none;">
        ${archivedSignals.map(s => {
          const direction = s.direction.toUpperCase();
          const signalCount = s.signalCount || 1;
          const timeframes = s.timeframes || [s.timeframe];
          const strengthLabel = signalCount >= 3 ? '🔥🔥🔥' : signalCount >= 2 ? '🔥🔥' : '';
          const isPlayedOut = s.state === 'played_out';
          const badgeText = isPlayedOut ? 'played out' : 'expired';
          const badgeClass = isPlayedOut ? 'played-out-badge' : 'expired-badge';

          return `
          <div class="archive-card ${isPlayedOut ? '' : 'expired'}" data-symbol="${s.symbol}">
            <div class="archive-card-header">
              <span class="archive-symbol">${s.symbol.replace('USDT', '')}</span>
              <span class="trade-action ${direction.toLowerCase()}">${direction}</span>
              ${strengthLabel ? `<span class="signal-strength">${strengthLabel}</span>` : ''}
              <span class="${badgeClass}">${badgeText}</span>
            </div>
            <div class="archive-timestamps">
              <span>⏱️ Triggered: ${s.triggeredAtDisplay || formatTimeAgo(s.timestamp)}</span>
              <span>${isPlayedOut ? '✓ Played out:' : '⏰ Expired from window:'} ${s.playedOutAtDisplay || formatTimeAgo(s.timestamp)}</span>
              ${timeframes.length > 1 ? `<span>📊 Timeframes: ${timeframes.join(', ')}</span>` : ''}
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </div>
    ` : ''}

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
    let audioContext = null;

    // Load Focus Mode settings from localStorage (separate from Screener)
    function loadFocusModeSettings() {
      try {
        const saved = localStorage.getItem('focusMode_settings');
        if (saved) return JSON.parse(saved);
      } catch (e) {}
      return { notificationsEnabled: false, audioEnabled: true, linkDestination: 'futures', activeWindowHours: 4 };
    }

    function saveFocusModeSettings() {
      try {
        localStorage.setItem('focusMode_settings', JSON.stringify({
          notificationsEnabled,
          audioEnabled,
          linkDestination,
          activeWindowHours
        }));
      } catch (e) {}
    }

    // Initialize from saved settings
    let { notificationsEnabled, audioEnabled, linkDestination, activeWindowHours } = loadFocusModeSettings();
    activeWindowHours = activeWindowHours || 4; // Default fallback

    // Change time window and reload with new filter
    function changeTimeWindow(hours) {
      activeWindowHours = parseInt(hours);
      saveFocusModeSettings();
      // Reload page with new time window
      const currentConfig = document.getElementById('config-select')?.value || '${configKey}';
      window.location.href = '/focus?config=' + encodeURIComponent(currentConfig) + '&window=' + hours;
    }

    // Toggle link destination between bots and futures
    function toggleLinkDestination() {
      linkDestination = linkDestination === 'bots' ? 'futures' : 'bots';
      saveFocusModeSettings();
      updateLinkButton();
      showToast(linkDestination === 'bots' ? '🤖 Links open Trading Bots' : '📊 Links open Futures Trading');
    }

    function updateLinkButton() {
      const btn = document.getElementById('link-btn');
      if (btn) {
        btn.textContent = linkDestination === 'bots' ? '🤖 Bots' : '📊 Futures';
        btn.classList.toggle('active', linkDestination === 'bots');
      }
    }

    // Open MEXC trade URL based on Focus Mode settings
    function openMexcTrade(symbol) {
      const base = symbol.replace('USDT', '');
      let url;
      if (linkDestination === 'bots') {
        url = 'https://www.mexc.com/futures/trading-bots/grid/' + base + '_USDT';
      } else {
        url = 'https://www.mexc.com/futures/' + base + '_USDT';
      }
      window.open(url, '_blank');
    }

    // Update manual entry price
    function updateManualEntry(cardId) {
      const input = document.getElementById('entry-input-' + cardId);
      if (!input || !activePositions[cardId]) return;

      const newEntry = parseFloat(input.value);
      if (isNaN(newEntry) || newEntry <= 0) {
        showToast('❌ Invalid entry price');
        return;
      }

      activePositions[cardId].entryPrice = newEntry;
      activePositions[cardId].manualEntry = true;

      // Reset tracking values so trail alerts can trigger again with new entry
      // This fixes the bug where adjusting entry would stop trail notifications
      activePositions[cardId].prevPnlPct = undefined;
      activePositions[cardId].prevRoiPct = undefined;
      activePositions[cardId].prevTrailStatus = undefined;
      activePositions[cardId].prevDangers = undefined;
      activePositions[cardId].trailStopAlerted = false;
      activePositions[cardId].trailStopAlertedAt = null;

      saveActivePositions();
      updatePositionHealth(cardId);
      showToast('✅ Entry updated to $' + newEntry.toFixed(6));
    }

    // Calculate entry price from current ROI%
    // ROI% = (P&L% * leverage), so P&L% = ROI% / leverage
    // For LONG: P&L% = (current - entry) / entry * 100 => entry = current / (1 + P&L%/100)
    // For SHORT: P&L% = (entry - current) / entry * 100 => entry = current / (1 - P&L%/100)
    function updateFromROI(cardId) {
      const roiInput = document.getElementById('roi-input-' + cardId);
      const entryInput = document.getElementById('entry-input-' + cardId);
      const pos = activePositions[cardId];

      if (!roiInput || !entryInput || !pos) {
        showToast('❌ Start tracking first');
        return;
      }

      const roiPct = parseFloat(roiInput.value);
      if (isNaN(roiPct)) {
        showToast('❌ Enter a valid ROI% (e.g. 44.5 or -12.3)');
        return;
      }

      if (!pos.currentPrice) {
        showToast('❌ Waiting for price data...');
        return;
      }

      // Get suggested leverage from card data attribute, or use existing position leverage, or default to 15
      const card = document.getElementById(cardId);
      const suggestedLev = (card && card.dataset.leverage) ? card.dataset.leverage : (pos.leverage || '15');

      // Ask for leverage to convert ROI to spot P&L
      const leverage = prompt('What leverage are you using?', suggestedLev.toString());
      if (!leverage) return;
      const lev = parseFloat(leverage);
      if (isNaN(lev) || lev <= 0) {
        showToast('❌ Invalid leverage');
        return;
      }

      // Convert ROI% to spot P&L%
      const spotPnlPct = roiPct / lev;
      const current = pos.currentPrice;
      const isLong = pos.direction === 'LONG';

      // Calculate entry from current price and P&L%
      let calculatedEntry;
      if (isLong) {
        // P&L% = (current - entry) / entry * 100
        // entry = current / (1 + P&L%/100)
        calculatedEntry = current / (1 + spotPnlPct / 100);
      } else {
        // P&L% = (entry - current) / entry * 100
        // entry = current / (1 - P&L%/100)
        calculatedEntry = current / (1 - spotPnlPct / 100);
      }

      // Update the entry input and save
      entryInput.value = calculatedEntry.toFixed(6);
      pos.entryPrice = calculatedEntry;
      pos.manualEntry = true;
      pos.leverage = lev; // Save leverage for display

      // Reset tracking values so trail alerts can trigger again with new entry
      // This fixes the bug where adjusting entry would stop trail notifications
      pos.prevPnlPct = undefined;
      pos.prevRoiPct = undefined;
      pos.prevTrailStatus = undefined;
      pos.prevDangers = undefined;
      pos.trailStopAlerted = false;
      pos.trailStopAlertedAt = null;

      saveActivePositions();
      updatePositionHealth(cardId);
      showToast('✅ Entry calculated: $' + calculatedEntry.toFixed(6) + ' (from ' + roiPct + '% ROI at ' + lev + 'x)');
    }

    // Calculate trailing stop based on P&L
    // Thresholds are based on ROI% (leveraged P&L) for better UX
    function calculateTrailingStop(pos) {
      if (!pos.entryPrice || !pos.currentPrice) {
        return { stop: null, info: 'Waiting for price data...' };
      }

      const entry = pos.entryPrice;
      const current = pos.currentPrice;
      const isLong = pos.direction === 'LONG';
      const leverage = pos.leverage || 1;

      // Calculate spot P&L %
      const spotPnlPct = isLong
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      // Calculate ROI (leveraged P&L) for threshold checks
      const roiPct = spotPnlPct * leverage;

      let suggestedStop;
      let info;
      let status; // profit, breakeven, loss

      // Thresholds based on ROI% (leveraged returns)
      // At 15x: 30% ROI = 2% spot, 75% ROI = 5% spot, 150% ROI = 10% spot
      if (roiPct >= 30) {
        // At +30% ROI: Trail at 70% of gains
        const lockSpotPct = spotPnlPct * 0.7;
        const lockRoiPct = roiPct * 0.7;
        suggestedStop = isLong
          ? entry * (1 + lockSpotPct / 100)
          : entry * (1 - lockSpotPct / 100);
        info = '🚀 +' + roiPct.toFixed(0) + '% ROI! Trail at 70% (lock ' + lockRoiPct.toFixed(0) + '% ROI)';
        status = 'profit';
      } else if (roiPct >= 15) {
        // At +15% ROI: Trail at 50% of gains
        const lockSpotPct = spotPnlPct * 0.5;
        const lockRoiPct = roiPct * 0.5;
        suggestedStop = isLong
          ? entry * (1 + lockSpotPct / 100)
          : entry * (1 - lockSpotPct / 100);
        info = '📈 +' + roiPct.toFixed(0) + '% ROI. Trail at 50% (lock ' + lockRoiPct.toFixed(0) + '% ROI)';
        status = 'profit';
      } else if (roiPct >= 5) {
        // At +5% ROI: Move to breakeven
        suggestedStop = entry;
        info = '✅ +' + roiPct.toFixed(0) + '% ROI - Move stop to breakeven';
        status = 'breakeven';
      } else if (roiPct >= 0) {
        // 0-5% ROI: Keep original stop
        suggestedStop = pos.stopPrice;
        info = '⏳ +' + roiPct.toFixed(1) + '% ROI - Keep original stop, wait for +5% to move to BE';
        status = 'neutral';
      } else {
        // Negative: Keep original stop
        suggestedStop = pos.stopPrice;
        info = '⚠️ ' + roiPct.toFixed(1) + '% ROI - In drawdown, keep original stop';
        status = 'loss';
      }

      return { stop: suggestedStop, info, status, pnlPct: spotPnlPct, roiPct };
    }

    // Search/filter signals
    function filterSignals(query) {
      const q = query.toUpperCase().trim();
      const cards = document.querySelectorAll('.trade-card');
      const archiveCards = document.querySelectorAll('.archive-card');
      let visibleCount = 0;

      cards.forEach(card => {
        const symbol = card.id.replace('card-', '').split('-')[0].toUpperCase();
        const matches = !q || symbol.includes(q);
        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });

      // Also filter archive
      archiveCards.forEach(card => {
        const symbol = (card.getAttribute('data-symbol') || '').toUpperCase();
        const matches = !q || symbol.includes(q);
        card.style.display = matches ? '' : 'none';
      });

      document.getElementById('search-count').textContent = visibleCount + ' active';
    }

    // Toggle archive section
    let archiveExpanded = false;
    function toggleArchive() {
      archiveExpanded = !archiveExpanded;
      const cards = document.getElementById('archive-cards');
      const toggle = document.getElementById('archive-toggle');
      if (cards && toggle) {
        cards.style.display = archiveExpanded ? 'grid' : 'none';
        toggle.textContent = archiveExpanded ? '▲ Hide' : '▼ Show';
      }
    }

    // ============= Position Monitor =============
    let activePositions = {};  // { cardId: { symbol, direction, entryPrice, entryRsi, enteredAt } }

    function loadActivePositions() {
      try {
        const saved = localStorage.getItem('focusMode_positions');
        if (saved) activePositions = JSON.parse(saved);
      } catch (e) {}
    }

    function saveActivePositions() {
      try {
        localStorage.setItem('focusMode_positions', JSON.stringify(activePositions));
      } catch (e) {}
    }

    function enterTrade(cardId, symbol, direction, entryPrice, entryRsi, targetPrice, stopPrice) {
      activePositions[cardId] = {
        symbol,
        direction,
        entryPrice,
        entryRsi,
        targetPrice,
        stopPrice,
        enteredAt: Date.now()
      };
      saveActivePositions();

      // Update UI
      document.getElementById('enter-btn-' + cardId).style.display = 'none';
      document.getElementById('monitor-active-' + cardId).style.display = 'block';

      // Highlight the card instead of expanding
      const card = document.getElementById(cardId);
      if (card) {
        highlightCard(cardId);
      }

      updatePositionHealth(cardId);
      updateCloseAllButton();
      showToast('📊 Position monitor started for ' + symbol.replace('USDT', ''));
    }

    function exitTrade(cardId) {
      delete activePositions[cardId];
      saveActivePositions();

      // Update UI
      const enterBtn = document.getElementById('enter-btn-' + cardId);
      const monitorActive = document.getElementById('monitor-active-' + cardId);
      const headerStatus = document.getElementById('header-status-' + cardId);
      if (enterBtn) enterBtn.style.display = 'block';
      if (monitorActive) monitorActive.style.display = 'none';
      if (headerStatus) headerStatus.classList.remove('active');

      showToast('Position monitor stopped');
      updateCloseAllButton();
    }

    function closeAllPositions() {
      const positionCount = Object.keys(activePositions).length;
      if (positionCount === 0) {
        showToast('No positions being tracked');
        return;
      }

      if (!confirm('Stop tracking all ' + positionCount + ' position(s)?\\n\\nThis will NOT close your actual MEXC positions - you must do that manually.')) {
        return;
      }

      // Get all card IDs before clearing
      const cardIds = Object.keys(activePositions);

      // Clear all positions
      activePositions = {};
      saveActivePositions();

      // Update UI for each card
      cardIds.forEach(function(cardId) {
        const enterBtn = document.getElementById('enter-btn-' + cardId);
        const monitorActive = document.getElementById('monitor-active-' + cardId);
        const headerStatus = document.getElementById('header-status-' + cardId);
        if (enterBtn) enterBtn.style.display = 'block';
        if (monitorActive) monitorActive.style.display = 'none';
        if (headerStatus) headerStatus.classList.remove('active');
      });

      updateCloseAllButton();
      showToast('🛑 Stopped tracking ' + positionCount + ' position(s). Remember to close on MEXC!');
    }

    function updateCloseAllButton() {
      const btn = document.getElementById('close-all-btn');
      if (btn) {
        const hasPositions = Object.keys(activePositions).length > 0;
        btn.classList.toggle('visible', hasPositions);
      }
    }

    // Investment Amount Management
    let currentInvestmentAmount = 2000;  // Default

    async function loadInvestmentAmount() {
      try {
        const res = await fetch('/api/investment-amount');
        const data = await res.json();
        currentInvestmentAmount = data.amount;

        // Update the input field
        const input = document.getElementById('investment-amount-input');
        if (input) input.value = currentInvestmentAmount;

        console.log('[Focus] Investment amount loaded:', currentInvestmentAmount);
      } catch (err) {
        console.error('[Focus] Failed to load investment amount:', err);
      }
    }

    async function saveInvestmentAmount() {
      const input = document.getElementById('investment-amount-input');
      const btn = document.getElementById('investment-save-btn');
      const amount = parseFloat(input.value);

      if (isNaN(amount) || amount <= 0) {
        showToast('❌ Enter a valid investment amount');
        return;
      }

      // Disable button during save
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
      }

      try {
        const res = await fetch('/api/investment-amount', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: amount, resetBots: false })
        });

        const data = await res.json();

        if (data.success) {
          currentInvestmentAmount = data.amount;
          showToast('✅ Investment amount updated to $' + amount.toLocaleString());
        } else {
          showToast('❌ Failed to update investment amount');
        }
      } catch (err) {
        console.error('[Focus] Failed to save investment amount:', err);
        showToast('❌ Error saving investment amount');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Save';
        }
      }
    }

    // Load investment amount on page load
    loadInvestmentAmount();

    function toggleMonitor(cardId) {
      const content = document.getElementById('monitor-content-' + cardId);
      if (content) {
        content.classList.toggle('collapsed');
      }
    }

    // Update distance from signal entry for all cards (not just active positions)
    function updateAllEntryDistances(prices) {
      document.querySelectorAll('.trade-card').forEach(function(card) {
        const cardId = card.id;
        const symbol = card.dataset.symbol;
        const signalEntry = parseFloat(card.dataset.signalEntry);
        const direction = card.dataset.direction;

        if (!symbol || !signalEntry || !direction) return;

        const currentPrice = prices[symbol];
        if (!currentPrice) return;

        updateEntryDistance(cardId, signalEntry, currentPrice, direction);
      });
    }

    function updateEntryDistance(cardId, signalEntry, currentPrice, direction) {
      const distanceBadge = document.getElementById('entry-distance-' + cardId);
      const entryCurrentValue = document.getElementById('entry-current-value-' + cardId);
      const card = document.getElementById(cardId);

      if (!signalEntry || !currentPrice) return;

      // Calculate percentage change from signal entry
      const pctChange = ((currentPrice - signalEntry) / signalEntry) * 100;

      // Determine if this is favorable or against based on direction
      const isLong = direction === 'LONG';
      const isFavorable = isLong ? pctChange < 0 : pctChange > 0;  // For longs, lower price is favorable entry
      const isAgainst = isLong ? pctChange > 0 : pctChange < 0;    // For longs, higher price means missed entry

      // Format the percentage
      const sign = pctChange >= 0 ? '+' : '';
      const pctText = sign + pctChange.toFixed(1) + '%';

      // Determine class based on favorability
      let statusClass = 'neutral';
      if (Math.abs(pctChange) > 1) {  // Only color if moved more than 1%
        statusClass = isFavorable ? 'favorable' : 'against';
      }

      // Update badge in header (collapsed view)
      if (distanceBadge) {
        distanceBadge.textContent = '📍 ' + pctText;
        distanceBadge.className = 'entry-distance ' + statusClass;
      }

      // Update expanded view row
      if (entryCurrentValue) {
        const formatPrice = function(p) { return p >= 1 ? p.toFixed(4) : p.toFixed(6); };
        const priceClass = pctChange >= 0 ? 'up' : 'down';
        entryCurrentValue.innerHTML = '$' + formatPrice(signalEntry) +
          ' → <span class="current-price ' + priceClass + '">$' + formatPrice(currentPrice) + '</span>' +
          ' <span class="distance-pct ' + statusClass + '">' + pctText + '</span>';
      }

      // Add stale class if price moved more than 20% from entry
      if (card && Math.abs(pctChange) > 20) {
        card.classList.add('stale');
      } else if (card) {
        card.classList.remove('stale');
      }
    }

    function updatePositionHealth(cardId) {
      const pos = activePositions[cardId];
      if (!pos) return;

      const monitor = document.getElementById('monitor-' + cardId);
      if (!monitor) return;

      // Calculate health indicators
      const now = Date.now();
      const timeInTrade = now - pos.enteredAt;
      const timeMinutes = Math.floor(timeInTrade / 60000);
      const timeHours = Math.floor(timeMinutes / 60);

      // Time health
      let timeStatus = 'good';
      let timeText = timeMinutes + 'm';
      if (timeHours >= 24) {
        timeStatus = 'bad';
        timeText = Math.floor(timeHours / 24) + 'd ' + (timeHours % 24) + 'h';
      } else if (timeHours >= 12) {
        timeStatus = 'warning';
        timeText = timeHours + 'h ' + (timeMinutes % 60) + 'm';
      } else if (timeHours >= 1) {
        timeText = timeHours + 'h ' + (timeMinutes % 60) + 'm';
      }

      // RSI analysis (would need live data - simplified for now)
      const entryRsi = pos.entryRsi || 50;
      const isLong = pos.direction === 'LONG';
      let rsiStatus = 'neutral';
      let rsiText = 'Entry RSI: ' + entryRsi.toFixed(0);

      if (isLong) {
        if (entryRsi <= 30) rsiText += ' (Oversold ✓)';
        else if (entryRsi >= 60) { rsiText += ' (Overbought ⚠️)'; rsiStatus = 'warning'; }
      } else {
        if (entryRsi >= 70) rsiText += ' (Overbought ✓)';
        else if (entryRsi <= 40) { rsiText += ' (Oversold ⚠️)'; rsiStatus = 'warning'; }
      }

      // Regime alignment (from current quadrant)
      const currentQuadrant = '${quadrant}';
      const currentAction = '${rule.action}';
      let regimeStatus = 'good';
      let regimeText = currentQuadrant + ' → ' + currentAction;

      if (currentAction === 'SKIP') {
        regimeStatus = 'warning';
        regimeText += ' (Regime changed!)';
      } else if (currentAction !== pos.direction) {
        regimeStatus = 'bad';
        regimeText += ' (Opposite direction!)';
      } else {
        regimeText += ' (Aligned ✓)';
      }

      // Update UI elements
      const timeEl = document.getElementById('health-time-' + cardId);
      const rsiEl = document.getElementById('health-rsi-' + cardId);
      const regimeEl = document.getElementById('health-regime-' + cardId);
      const targetEl = document.getElementById('health-target-' + cardId);
      const badgeEl = document.getElementById('monitor-badge-' + cardId);
      const suggestionEl = document.getElementById('monitor-suggestion-' + cardId);

      if (timeEl) {
        timeEl.textContent = timeText;
        timeEl.className = 'health-value ' + timeStatus;
      }
      if (rsiEl) {
        rsiEl.textContent = rsiText;
        rsiEl.className = 'health-value ' + rsiStatus;
      }
      if (regimeEl) {
        regimeEl.textContent = regimeText;
        regimeEl.className = 'health-value ' + regimeStatus;
      }
      // Distance to target - needs current price
      let targetStatus = 'neutral';
      let targetText = 'Loading...';
      let pnlPct = 0;

      if (pos.targetPrice && pos.stopPrice && pos.currentPrice) {
        const isLong = pos.direction === 'LONG';
        const entry = pos.entryPrice;
        const current = pos.currentPrice;
        const target = pos.targetPrice;
        const stop = pos.stopPrice;

        // Calculate P&L %
        pnlPct = isLong
          ? ((current - entry) / entry) * 100
          : ((entry - current) / entry) * 100;

        // Calculate distance to target as % of total move
        const totalMove = Math.abs(target - entry);
        const currentMove = isLong ? (current - entry) : (entry - current);
        const progressPct = totalMove > 0 ? (currentMove / totalMove) * 100 : 0;

        // Calculate distance to stop
        const distToStop = isLong
          ? ((current - stop) / current) * 100
          : ((stop - current) / current) * 100;

        if (pnlPct >= 0) {
          if (progressPct >= 75) {
            targetStatus = 'good';
            targetText = '🎯 ' + progressPct.toFixed(0) + '% to TP (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)';
          } else if (progressPct >= 50) {
            targetStatus = 'good';
            targetText = '📈 ' + progressPct.toFixed(0) + '% to TP (+' + pnlPct.toFixed(1) + '%)';
          } else {
            targetStatus = 'neutral';
            targetText = '📊 ' + progressPct.toFixed(0) + '% to TP (+' + pnlPct.toFixed(1) + '%)';
          }
        } else {
          if (distToStop < 2) {
            targetStatus = 'bad';
            targetText = '🚨 Near SL! (' + pnlPct.toFixed(1) + '%)';
          } else if (pnlPct < -5) {
            targetStatus = 'warning';
            targetText = '📉 Underwater (' + pnlPct.toFixed(1) + '%)';
          } else {
            targetStatus = 'neutral';
            targetText = '📊 In progress (' + pnlPct.toFixed(1) + '%)';
          }
        }
      } else if (pos.targetPrice && pos.stopPrice) {
        // No current price available - show targets instead
        pos.priceFetchAttempts = (pos.priceFetchAttempts || 0) + 1;
        if (pos.priceFetchAttempts > 3) {
          // After 3 attempts (30 seconds), show helpful info instead
          const formatP = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
          targetText = 'TP: $' + formatP(pos.targetPrice) + ' / SL: $' + formatP(pos.stopPrice);
        } else {
          targetText = 'Fetching price...';
        }
      }

      if (targetEl) {
        targetEl.textContent = targetText;
        targetEl.className = 'health-value ' + targetStatus;
      }

      // Update trailing stop suggestion
      const trailResult = calculateTrailingStop(pos);
      const pnlDisplayEl = document.getElementById('pnl-display-' + cardId);
      const trailStopEl = document.getElementById('trail-stop-' + cardId);
      const trailInfoEl = document.getElementById('trail-info-' + cardId);

      if (pnlDisplayEl) {
        if (trailResult.pnlPct !== undefined) {
          const spotPnl = trailResult.pnlPct;
          const roiPnl = trailResult.roiPct || spotPnl;
          // Show ROI prominently if leverage is known, spot P&L secondary
          let displayText;
          if (pos.leverage && pos.leverage > 1) {
            displayText = 'ROI: ' + (roiPnl >= 0 ? '+' : '') + roiPnl.toFixed(1) + '% (' + pos.leverage + 'x)';
          } else {
            displayText = 'P&L: ' + (spotPnl >= 0 ? '+' : '') + spotPnl.toFixed(2) + '%';
          }
          pnlDisplayEl.textContent = displayText;
          pnlDisplayEl.className = 'pnl-display ' + (trailResult.status === 'profit' ? 'profit' : trailResult.status === 'loss' ? 'loss' : 'neutral');
        } else {
          pnlDisplayEl.textContent = 'Waiting for price data...';
          pnlDisplayEl.className = 'pnl-display neutral';
        }
      }

      if (trailStopEl) {
        if (trailResult.stop) {
          const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
          trailStopEl.textContent = '$' + formatPrice(trailResult.stop);
          trailStopEl.className = 'trailing-stop-value ' + (trailResult.status === 'profit' ? 'profit' : trailResult.status === 'breakeven' ? 'breakeven' : 'neutral');
        } else {
          trailStopEl.textContent = '--';
          trailStopEl.className = 'trailing-stop-value neutral';
        }
      }

      if (trailInfoEl) {
        trailInfoEl.textContent = trailResult.info || 'Enter trade to see trailing stop suggestions';
      }

      // Check if trailing stop has been hit (price crossed the suggested stop level)
      if (trailResult.stop && pos.currentPrice && pos.entryPrice) {
        const isLong = pos.direction === 'LONG';
        const trailStopHit = isLong
          ? pos.currentPrice <= trailResult.stop
          : pos.currentPrice >= trailResult.stop;

        // Only alert if we had a profitable trailing stop (not the original stop)
        const isTrailingStop = trailResult.status === 'profit' || trailResult.status === 'breakeven';

        if (trailStopHit && isTrailingStop && !pos.trailStopAlerted) {
          // Mark as alerted so we don't spam
          pos.trailStopAlerted = true;
          pos.trailStopAlertedAt = Date.now();
          saveActivePositions();

          const symbol = pos.symbol.replace('USDT', '');
          const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);

          // Send notification
          sendNotification(
            '🛑 TRAILING STOP HIT: ' + symbol,
            'Price crossed your trailing stop at $' + formatPrice(trailResult.stop) + '. Consider closing position.',
            pos.direction
          );

          // Play alert sound
          playAlert(pos.direction);

          // Show toast
          showToast('🛑 ' + symbol + ' trailing stop hit! Close position manually.');

          // Flash the card
          highlightCard(cardId);
        }

        // Reset alert if price recovers above trailing stop (so it can alert again)
        if (!trailStopHit && pos.trailStopAlerted) {
          // Only reset if it's been more than 5 minutes since last alert
          if (Date.now() - (pos.trailStopAlertedAt || 0) > 5 * 60 * 1000) {
            pos.trailStopAlerted = false;
            saveActivePositions();
          }
        }
      }

      // Calculate overall health and suggestion
      const warnings = [timeStatus, rsiStatus, regimeStatus, targetStatus].filter(s => s === 'warning').length;
      const dangers = [timeStatus, rsiStatus, regimeStatus, targetStatus].filter(s => s === 'bad').length;

      if (badgeEl) {
        if (dangers > 0) {
          badgeEl.textContent = '⚠️ ' + dangers + ' Alert' + (dangers > 1 ? 's' : '');
          badgeEl.className = 'monitor-badge danger';
        } else if (warnings > 0) {
          badgeEl.textContent = '⚠️ ' + warnings + ' Warning' + (warnings > 1 ? 's' : '');
          badgeEl.className = 'monitor-badge warning';
        } else if (pnlPct > 0) {
          badgeEl.textContent = '✓ In Profit (+' + pnlPct.toFixed(1) + '%)';
          badgeEl.className = 'monitor-badge healthy';
        } else {
          badgeEl.textContent = '✓ Healthy';
          badgeEl.className = 'monitor-badge healthy';
        }
      }

      // Calculate urgency score (higher = more urgent, needs attention)
      // 100 = trailing stop hit (immediate action)
      // 90 = near stop loss (critical)
      // 80 = regime changed against position (critical)
      // 60 = trade aging with warnings
      // 50 = multiple warnings
      // 40 = great profit (action opportunity)
      // 30 = solid profit (action opportunity)
      // 20 = profitable, consider breakeven
      // 10 = healthy, let it develop
      // 0 = not tracking
      let urgencyScore = 0;

      if (suggestionEl) {
        if (targetStatus === 'bad') {
          suggestionEl.textContent = '🚨 Price near stop loss! Consider exiting or adjusting.';
          suggestionEl.className = 'monitor-suggestion warning';
          urgencyScore = 90;
        } else if (regimeStatus === 'bad') {
          // Position direction conflicts with current signal direction
          const currentAction = '${rule.action}';
          suggestionEl.textContent = '🚨 CONFLICT: Signal now says ' + currentAction + ' but you are ' + pos.direction + '. Consider closing.';
          suggestionEl.className = 'monitor-suggestion warning';
          urgencyScore = 85;
        } else if (dangers > 0) {
          suggestionEl.textContent = '🚨 Multiple warning signals. Review your position.';
          suggestionEl.className = 'monitor-suggestion warning';
          urgencyScore = 80;
        } else if (pnlPct >= 10) {
          suggestionEl.textContent = '🎯 Great profit! Consider taking partial profits or trailing stop.';
          suggestionEl.className = 'monitor-suggestion action';
          urgencyScore = 40;
        } else if (pnlPct >= 5) {
          suggestionEl.textContent = '💰 In solid profit. Consider moving stop to breakeven.';
          suggestionEl.className = 'monitor-suggestion action';
          urgencyScore = 30;
        } else if (timeHours >= 12) {
          suggestionEl.textContent = '⏰ Trade aging: Consider taking profits or tightening stop loss.';
          suggestionEl.className = 'monitor-suggestion warning';
          urgencyScore = 60;
        } else if (warnings >= 2) {
          suggestionEl.textContent = '⚠️ Multiple warnings: Review your position and consider adjustments.';
          suggestionEl.className = 'monitor-suggestion warning';
          urgencyScore = 50;
        } else if (pnlPct > 0 && timeHours >= 4) {
          suggestionEl.textContent = '💡 Position profitable. Consider moving stop to breakeven.';
          suggestionEl.className = 'monitor-suggestion action';
          urgencyScore = 20;
        } else {
          suggestionEl.textContent = '💡 Position looks healthy. Let it develop.';
          suggestionEl.className = 'monitor-suggestion';
          urgencyScore = 10;
        }
      }

      // Trailing stop hit is highest urgency
      if (pos.trailStopAlerted) {
        urgencyScore = 100;
      }

      // Store urgency score on position for sorting
      pos.urgencyScore = urgencyScore;

      // Update header status (visible when collapsed)
      const headerStatusEl = document.getElementById('header-status-' + cardId);
      const headerPnlEl = document.getElementById('header-pnl-' + cardId);
      const headerSuggestionEl = document.getElementById('header-suggestion-' + cardId);

      if (headerStatusEl) {
        headerStatusEl.classList.add('active');
      }

      if (headerPnlEl) {
        if (pos.currentPrice) {
          const pnlText = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%';
          headerPnlEl.textContent = pnlText;
          headerPnlEl.className = 'header-pnl ' + (pnlPct > 0 ? 'profit' : pnlPct < 0 ? 'loss' : 'neutral');
        } else {
          headerPnlEl.textContent = '📊 Monitoring';
          headerPnlEl.className = 'header-pnl neutral';
        }
      }

      // Show/hide conflict badge when position direction opposes current signal
      const headerConflictEl = document.getElementById('header-conflict-' + cardId);
      if (headerConflictEl) {
        const hasConflict = regimeStatus === 'bad';
        headerConflictEl.classList.toggle('visible', hasConflict);
      }

      if (headerSuggestionEl && suggestionEl) {
        // Mirror the suggestion text (without leading emoji for compactness)
        // Use indexOf to find first space, avoids regex issues with emoji surrogate pairs
        const fullText = suggestionEl.textContent || '';
        const spaceIdx = fullText.indexOf(' ');
        const suggestionText = spaceIdx > 0 ? fullText.substring(spaceIdx + 1) : fullText;
        headerSuggestionEl.textContent = suggestionText;
        // Use danger class for conflicts (highest priority visual)
        const isConflict = regimeStatus === 'bad';
        headerSuggestionEl.className = 'header-suggestion' +
          (isConflict ? ' danger' : '') +
          (suggestionEl.className.includes('warning') && !isConflict ? ' warning' : '') +
          (suggestionEl.className.includes('action') ? ' action' : '');
      }

      // Show update badge on collapsed cards when status changes significantly
      const card = document.getElementById(cardId);
      if (card && card.classList.contains('collapsed')) {
        const prevPnl = pos.prevPnlPct || 0;
        const prevDangers = pos.prevDangers || 0;
        const prevTrailStatus = pos.prevTrailStatus || 'neutral';
        const roiPct = trailResult.roiPct || 0;
        const prevRoi = pos.prevRoiPct || 0;

        // Check for trailing stop status changes (most important for manual trailing)
        if (trailResult.status === 'profit' && prevTrailStatus !== 'profit') {
          // Just entered trailing territory - time to move stop!
          highlightCard(cardId);
          showUpdateBadge(cardId, '🛡️ TRAIL STOP');
          playAlert(pos.direction);
        } else if (trailResult.status === 'breakeven' && prevTrailStatus !== 'breakeven' && prevTrailStatus !== 'profit') {
          // Just hit breakeven threshold
          highlightCard(cardId);
          showUpdateBadge(cardId, '🛡️ MOVE TO BE');
        } else if (roiPct >= 30 && prevRoi < 30) {
          // Crossed 30% ROI - trail at 70%
          highlightCard(cardId);
          showUpdateBadge(cardId, '🚀 +30% TRAIL');
        } else if (roiPct >= 15 && prevRoi < 15) {
          // Crossed 15% ROI - trail at 50%
          highlightCard(cardId);
          showUpdateBadge(cardId, '📈 +15% TRAIL');
        } else if ((prevPnl <= 0 && pnlPct > 0) || (prevPnl >= 0 && pnlPct < 0)) {
          // Crossing profit/loss threshold
          highlightCard(cardId);
          showUpdateBadge(cardId, pnlPct > 0 ? 'PROFIT' : 'LOSS');
        } else if (dangers > prevDangers) {
          highlightCard(cardId);
          showUpdateBadge(cardId, '⚠️ ALERT');
        }

        // Store for next comparison
        pos.prevPnlPct = pnlPct;
        pos.prevRoiPct = roiPct;
        pos.prevDangers = dangers;
        pos.prevTrailStatus = trailResult.status;
      }
    }

    // Fetch current prices for all symbols (active positions + all cards for distance display)
    async function fetchCurrentPrices() {
      // Get symbols from active positions
      const positionSymbols = Object.values(activePositions).map(p => p.symbol);

      // Also get symbols from all visible cards (for distance from entry display)
      const cardSymbols = [];
      document.querySelectorAll('.trade-card').forEach(function(card) {
        if (card.dataset.symbol) cardSymbols.push(card.dataset.symbol);
      });

      const symbols = [...new Set([...positionSymbols, ...cardSymbols])];
      if (symbols.length === 0) return {};

      try {
        // Use our server-side proxy to avoid CORS issues
        const response = await fetch('/api/prices?symbols=' + symbols.join(','));
        const data = await response.json();

        if (data.prices) {
          // Update active positions with current prices
          Object.keys(activePositions).forEach(cardId => {
            const symbol = activePositions[cardId].symbol;
            if (data.prices[symbol]) {
              activePositions[cardId].currentPrice = data.prices[symbol];
            }
          });
          return data.prices;
        }
        return {};
      } catch (e) {
        console.log('[Focus] Price fetch error:', e);
        return {};
      }
    }

    async function updateAllPositionHealth() {
      const prices = await fetchCurrentPrices();

      // Update position health for active trades
      Object.keys(activePositions).forEach(cardId => {
        updatePositionHealth(cardId);
      });

      // Update distance from entry for all cards (active or not)
      updateAllEntryDistances(prices);

      // Update the trailing stop alerts bar
      updateTrailAlertsBar();

      // Re-sort if using urgency sort (since urgency scores just updated)
      if (currentSortOrder === 'urgency-desc') {
        sortSignals('urgency-desc');
      }
    }

    // Update the trailing stop alerts bar at top of page
    function updateTrailAlertsBar() {
      const bar = document.getElementById('trail-alerts-bar');
      const list = document.getElementById('trail-alerts-list');
      if (!bar || !list) return;

      // Find all positions with active trail stop alerts
      const alerts = [];
      Object.keys(activePositions).forEach(cardId => {
        const pos = activePositions[cardId];
        if (pos.trailStopAlerted && pos.trailStopAlertedAt) {
          // Calculate the suggested stop for display
          const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
          let stopPrice = pos.entryPrice; // Default to breakeven

          if (pos.currentPrice && pos.entryPrice && pos.leverage) {
            const isLong = pos.direction === 'LONG';
            const spotPnl = isLong
              ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;
            const roiPct = spotPnl * pos.leverage;

            if (roiPct >= 30) {
              const lockSpotPct = spotPnl * 0.7;
              stopPrice = isLong
                ? pos.entryPrice * (1 + lockSpotPct / 100)
                : pos.entryPrice * (1 - lockSpotPct / 100);
            } else if (roiPct >= 15) {
              const lockSpotPct = spotPnl * 0.5;
              stopPrice = isLong
                ? pos.entryPrice * (1 + lockSpotPct / 100)
                : pos.entryPrice * (1 - lockSpotPct / 100);
            }
          }

          alerts.push({
            cardId: cardId,
            symbol: pos.symbol,
            direction: pos.direction,
            stopPrice: stopPrice,
            alertedAt: pos.trailStopAlertedAt
          });
        }
      });

      if (alerts.length === 0) {
        bar.classList.remove('active');
        list.innerHTML = '';
        return;
      }

      // Sort by most recent alert
      alerts.sort((a, b) => b.alertedAt - a.alertedAt);

      // Show the bar
      bar.classList.add('active');

      // Build alert items
      const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
      list.innerHTML = alerts.map(a => {
        const symbolShort = a.symbol.replace('USDT', '');
        return '<div class="trail-alert-item" onclick="scrollToCard(\\'' + a.cardId + '\\')">' +
          '<span class="symbol">' + symbolShort + '</span>' +
          '<span class="direction ' + a.direction.toLowerCase() + '">' + a.direction + '</span>' +
          '<span class="price">SL @ $' + formatPrice(a.stopPrice) + '</span>' +
          '<button class="trail-alert-dismiss" onclick="event.stopPropagation(); dismissTrailAlert(\\'' + a.cardId + '\\')" title="Dismiss">×</button>' +
          '</div>';
      }).join('');
    }

    // Scroll to a card and expand it
    function scrollToCard(cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        // Expand the card if collapsed
        card.classList.remove('collapsed');
        clearUpdateBadge(cardId);

        // Scroll into view
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Flash highlight
        highlightCard(cardId);
      }
    }

    // Dismiss a trail alert (user acknowledged it)
    function dismissTrailAlert(cardId) {
      const pos = activePositions[cardId];
      if (pos) {
        pos.trailStopAlerted = false;
        pos.trailStopAlertedAt = null;
        saveActivePositions();
        updateTrailAlertsBar();
        showToast('✓ Alert dismissed for ' + pos.symbol.replace('USDT', ''));
      }
    }

    // Create a minimal position card for orphaned positions (signal expired but position still active)
    function createOrphanedPositionCard(cardId, pos) {
      const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
      const symbol = pos.symbol;
      const direction = pos.direction;
      const entryPrice = pos.entryPrice || 0;
      const leverage = pos.leverage || 1;

      return \`
        <div class="trade-card \${direction.toLowerCase()} orphaned collapsed" id="\${cardId}" data-symbol="\${symbol}" data-direction="\${direction}" data-signal-entry="\${entryPrice}" data-leverage="\${leverage}">
          <div class="trade-card-header" onclick="toggleCard('\${cardId}')">
            <span class="trade-symbol">\${symbol.replace('USDT', '')}</span>
            <span class="trade-action \${direction.toLowerCase()}">\${direction}</span>
            <span class="orphaned-badge">ACTIVE</span>
            <span class="leverage-badge">\${leverage}x</span>
            <span class="entry-distance neutral" id="entry-distance-\${cardId}" title="Distance from entry">📍 --</span>
            <span class="header-spacer"></span>
            <span class="collapse-icon">▼</span>
            <div class="header-position-status active" id="header-status-\${cardId}">
              <span class="header-pnl neutral" id="header-pnl-\${cardId}">--</span>
              <span class="header-conflict-badge" id="header-conflict-\${cardId}">⚠️ CONFLICT</span>
              <span class="header-suggestion" id="header-suggestion-\${cardId}">Monitoring...</span>
            </div>
          </div>

          <div class="trade-card-collapsible">
            <div class="orphaned-notice">
              ⚠️ Signal expired from active window, but position is still being monitored.
            </div>

            <!-- Position Monitor Section (always active for orphaned cards) -->
            <div class="position-monitor" id="monitor-\${cardId}" data-symbol="\${symbol}" data-direction="\${direction}" data-entry="\${entryPrice}">
              <div class="monitor-active" id="monitor-active-\${cardId}" style="display: block;">
                <div class="monitor-header" onclick="toggleMonitor('\${cardId}')">
                  <span class="monitor-title">📊 Position Monitor</span>
                  <div class="monitor-summary">
                    <span class="monitor-badge healthy" id="monitor-badge-\${cardId}">✓ Monitoring</span>
                    <button class="exit-trade-btn" onclick="event.stopPropagation(); exitTrade('\${cardId}')">Exit Monitor</button>
                  </div>
                </div>
                <div class="monitor-content" id="monitor-content-\${cardId}">
                  <!-- Manual Entry Price or ROI -->
                  <div class="monitor-entry-row">
                    <span class="entry-label">My Entry:</span>
                    <input type="text" class="entry-input" id="entry-input-\${cardId}"
                           value="\${entryPrice}"
                           onchange="updateManualEntry('\${cardId}')"
                           onclick="event.stopPropagation()">
                    <button class="entry-btn" onclick="event.stopPropagation(); updateManualEntry('\${cardId}')">Set</button>
                  </div>
                  <div class="monitor-entry-row">
                    <span class="entry-label">Or ROI%:</span>
                    <input type="text" class="entry-input" id="roi-input-\${cardId}"
                           placeholder="e.g. 44.5 or -12.3"
                           onclick="event.stopPropagation()">
                    <button class="entry-btn" onclick="event.stopPropagation(); updateFromROI('\${cardId}')">Calc</button>
                  </div>

                  <!-- P&L Display -->
                  <div class="pnl-display neutral" id="pnl-display-\${cardId}">
                    Calculating...
                  </div>

                  <!-- Trailing Stop Suggestion -->
                  <div class="trailing-stop-box">
                    <div class="trailing-stop-header">
                      <span class="trailing-stop-title">🛡️ Suggested Stop Loss</span>
                      <span class="trailing-stop-value neutral" id="trail-stop-\${cardId}">--</span>
                    </div>
                    <div class="trailing-stop-info" id="trail-info-\${cardId}">
                      Waiting for price data...
                    </div>
                  </div>

                  <div class="health-indicator" style="margin-top: 10px;">
                    <span class="health-label">⏱️ Time in Trade</span>
                    <span class="health-value neutral" id="health-time-\${cardId}">--</span>
                  </div>
                  <div class="monitor-suggestion" id="monitor-suggestion-\${cardId}">
                    💡 Position monitoring active for expired signal.
                  </div>
                </div>
              </div>
            </div>

            <div class="trade-card-footer">
              <a href="#" onclick="openMexcTrade('\${symbol}'); return false;" class="trade-btn \${direction.toLowerCase()}">
                Open \${direction} on MEXC →
              </a>
            </div>
          </div>
        </div>
      \`;
    }

    function restoreActivePositions() {
      loadActivePositions();
      console.log('[Focus] Restoring positions:', Object.keys(activePositions));

      // First, check for orphaned positions (positions without active cards)
      const orphanedPositions = [];
      Object.keys(activePositions).forEach(cardId => {
        const pos = activePositions[cardId];
        const existingCard = document.getElementById(cardId);
        if (!existingCard) {
          console.log('[Focus] Orphaned position found:', cardId, pos.symbol);
          orphanedPositions.push({ cardId, pos });
        }
      });

      // Inject orphaned position cards into the active section
      if (orphanedPositions.length > 0) {
        const container = document.querySelector('.trade-cards');
        if (container) {
          orphanedPositions.forEach(({ cardId, pos }) => {
            const cardHtml = createOrphanedPositionCard(cardId, pos);
            container.insertAdjacentHTML('afterbegin', cardHtml);
            console.log('[Focus] Created orphaned card for', pos.symbol);
          });
        }
      }

      // Now restore all positions (including newly created orphaned cards)
      Object.keys(activePositions).forEach(cardId => {
        const pos = activePositions[cardId];
        const enterBtn = document.getElementById('enter-btn-' + cardId);
        const monitorActive = document.getElementById('monitor-active-' + cardId);
        if (enterBtn && monitorActive) {
          enterBtn.style.display = 'none';
          monitorActive.style.display = 'block';
        }
        // Always restore saved entry price if position exists (regardless of manualEntry flag)
        if (pos.entryPrice) {
          const entryInput = document.getElementById('entry-input-' + cardId);
          if (entryInput) {
            console.log('[Focus] Restoring entry for', cardId, ':', pos.entryPrice);
            entryInput.value = pos.entryPrice.toString();
          } else {
            console.log('[Focus] Entry input not found for', cardId);
          }
        }
      });
      // Fetch prices and update health after restoring
      updateAllPositionHealth();
      // Show/hide close all button based on active positions
      updateCloseAllButton();
    }

    // Card collapse functionality
    function toggleCard(cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        card.classList.toggle('collapsed');
        saveCollapsedState();
        // Clear update badge when expanding
        if (!card.classList.contains('collapsed')) {
          clearUpdateBadge(cardId);
        }
      }
    }

    function collapseAllCards() {
      document.querySelectorAll('.trade-card').forEach(card => card.classList.add('collapsed'));
      saveCollapsedState();
    }

    function expandAllCards() {
      document.querySelectorAll('.trade-card').forEach(card => {
        card.classList.remove('collapsed');
        clearUpdateBadge(card.id);
      });
      saveCollapsedState();
    }

    // Card highlight and update badge
    function highlightCard(cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        card.classList.remove('highlight');
        // Force reflow to restart animation
        void card.offsetWidth;
        card.classList.add('highlight');

        // Show update badge if card is collapsed
        if (card.classList.contains('collapsed')) {
          showUpdateBadge(cardId);
        }

        // Remove highlight class after animation
        setTimeout(() => card.classList.remove('highlight'), 3000);
      }
    }

    function showUpdateBadge(cardId, text = 'UPDATED') {
      const badge = document.getElementById('update-badge-' + cardId);
      if (badge) {
        badge.textContent = text;
        badge.classList.add('show');
      }
    }

    function clearUpdateBadge(cardId) {
      const badge = document.getElementById('update-badge-' + cardId);
      if (badge) {
        badge.classList.remove('show');
      }
    }

    function saveCollapsedState() {
      const collapsed = [];
      document.querySelectorAll('.trade-card.collapsed').forEach(card => {
        if (card.id) collapsed.push(card.id);
      });
      try {
        localStorage.setItem('focusMode_collapsedCards', JSON.stringify(collapsed));
      } catch (e) {}
    }

    function restoreCollapsedState() {
      try {
        const saved = localStorage.getItem('focusMode_collapsedCards');
        if (saved) {
          const collapsed = JSON.parse(saved);
          collapsed.forEach(cardId => {
            const card = document.getElementById(cardId);
            if (card) card.classList.add('collapsed');
          });
        }
      } catch (e) {}
    }

    // Sorting functionality
    let currentSortOrder = 'time-desc';

    function sortSignals(sortOrder) {
      currentSortOrder = sortOrder;
      saveSortPreference(sortOrder);

      const container = document.querySelector('.trade-cards');
      if (!container) return;

      const cards = Array.from(container.querySelectorAll('.trade-card'));
      if (cards.length === 0) return;

      cards.sort((a, b) => {
        const symbolA = a.dataset.symbol || '';
        const symbolB = b.dataset.symbol || '';
        const timeA = parseInt(a.dataset.timestamp || '0');
        const timeB = parseInt(b.dataset.timestamp || '0');
        const posA = activePositions[a.id];
        const posB = activePositions[b.id];
        const trackingA = posA ? 1 : 0;
        const trackingB = posB ? 1 : 0;
        // Quality = R:R ratio + signal count bonus
        const qualityA = parseFloat(a.dataset.quality || '0') + (parseInt(a.dataset.signals || '1') - 1) * 0.5;
        const qualityB = parseFloat(b.dataset.quality || '0') + (parseInt(b.dataset.signals || '1') - 1) * 0.5;
        // Urgency score (0 for untracked, 10-100 for tracked based on status)
        const urgencyA = posA ? (posA.urgencyScore || 0) : 0;
        const urgencyB = posB ? (posB.urgencyScore || 0) : 0;

        switch (sortOrder) {
          case 'alpha-asc':
            return symbolA.localeCompare(symbolB);
          case 'alpha-desc':
            return symbolB.localeCompare(symbolA);
          case 'time-asc':
            return timeA - timeB;
          case 'time-desc':
            return timeB - timeA;
          case 'urgency-desc':
            // Most urgent first, then by tracking status, then by time
            if (urgencyA !== urgencyB) return urgencyB - urgencyA;
            if (trackingA !== trackingB) return trackingB - trackingA;
            return timeB - timeA;
          case 'quality-desc':
            if (qualityA !== qualityB) return qualityB - qualityA;
            return timeB - timeA; // Secondary sort by time
          case 'quality-asc':
            if (qualityA !== qualityB) return qualityA - qualityB;
            return timeB - timeA; // Secondary sort by time
          case 'tracking-first':
            if (trackingA !== trackingB) return trackingB - trackingA;
            return timeB - timeA; // Secondary sort by time
          case 'tracking-last':
            if (trackingA !== trackingB) return trackingA - trackingB;
            return timeB - timeA; // Secondary sort by time
          default:
            return timeB - timeA;
        }
      });

      // Re-append cards in sorted order
      cards.forEach(card => container.appendChild(card));

      // Add separator between tracked and untracked when using relevant sort
      updateTrackingSeparator(sortOrder, container, cards);
    }

    function updateTrackingSeparator(sortOrder, container, cards) {
      // Remove existing separator
      const existingSep = container.querySelector('.tracking-separator');
      if (existingSep) existingSep.remove();

      // Only show separator for tracking-based or urgency sorts
      if (!['tracking-first', 'tracking-last', 'urgency-desc'].includes(sortOrder)) {
        return;
      }

      // Find the boundary between tracked and untracked
      let separatorIndex = -1;
      for (let i = 0; i < cards.length; i++) {
        const isTracked = !!activePositions[cards[i].id];
        const nextIsTracked = i + 1 < cards.length ? !!activePositions[cards[i + 1].id] : null;

        // For tracking-first and urgency-desc: tracked cards come first
        // Separator goes after last tracked card
        if ((sortOrder === 'tracking-first' || sortOrder === 'urgency-desc') && isTracked && nextIsTracked === false) {
          separatorIndex = i;
          break;
        }
        // For tracking-last: untracked cards come first
        // Separator goes after last untracked card
        if (sortOrder === 'tracking-last' && !isTracked && nextIsTracked === true) {
          separatorIndex = i;
          break;
        }
      }

      // Insert separator if boundary found
      if (separatorIndex >= 0 && separatorIndex < cards.length - 1) {
        const trackedCount = Object.keys(activePositions).filter(id => document.getElementById(id)).length;
        const untrackedCount = cards.length - trackedCount;

        const separator = document.createElement('div');
        separator.className = 'tracking-separator';
        separator.innerHTML = sortOrder === 'tracking-last'
          ? '<span>📊 Tracking (' + trackedCount + ' positions)</span>'
          : '<span>📋 Not Tracking (' + untrackedCount + ' signals)</span>';

        // Insert after the card at separatorIndex
        cards[separatorIndex].after(separator);
      }
    }

    function saveSortPreference(sortOrder) {
      try {
        localStorage.setItem('focusMode_sortOrder', sortOrder);
      } catch (e) {}
    }

    function restoreSortPreference() {
      try {
        const saved = localStorage.getItem('focusMode_sortOrder');
        if (saved) {
          currentSortOrder = saved;
          const sortSelect = document.getElementById('sort-select');
          if (sortSelect) sortSelect.value = saved;
          sortSignals(saved);
        }
      } catch (e) {}
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
        saveFocusModeSettings();
        updateNotificationButton();
        if (notificationsEnabled) {
          showToast('🔔 Notifications enabled!');
        }
      }
    }

    // Toggle notifications on/off
    function toggleNotifications() {
      if (!notificationsEnabled && Notification.permission !== 'granted') {
        // Need to request permission first
        enableNotifications();
        return;
      }
      notificationsEnabled = !notificationsEnabled;
      saveFocusModeSettings();
      updateNotificationButton();
      showToast(notificationsEnabled ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
    }

    function updateNotificationButton() {
      const btn = document.getElementById('notif-btn');
      if (btn) {
        btn.textContent = notificationsEnabled ? '🔔 Notifications ON' : '🔕 Notifications OFF';
        btn.classList.toggle('active', notificationsEnabled);
      }
    }

    function toggleAudio() {
      audioEnabled = !audioEnabled;
      saveFocusModeSettings();
      const btn = document.getElementById('audio-btn');
      if (btn) {
        btn.textContent = audioEnabled ? '🔊 Audio ON' : '🔇 Audio OFF';
        btn.classList.toggle('active', audioEnabled);
      }
      showToast(audioEnabled ? '🔊 Audio alerts enabled' : '🔇 Audio alerts muted');
    }

    // Test sound button - also wakes up audio context
    function testSound() {
      console.log('[Focus] Test sound clicked, audioEnabled:', audioEnabled);
      // Force enable for test
      const wasEnabled = audioEnabled;
      audioEnabled = true;
      playAlert('LONG');
      audioEnabled = wasEnabled;
      showToast('🔊 Test sound played');
    }

    // Play alert sound using Web Audio API
    function playAlert(type) {
      console.log('[Focus] playAlert called, type:', type, 'audioEnabled:', audioEnabled);
      if (!audioEnabled) {
        console.log('[Focus] Audio disabled, skipping sound');
        return;
      }

      try {
        if (!audioContext) {
          console.log('[Focus] Creating new AudioContext');
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Resume audio context if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
          console.log('[Focus] Resuming suspended AudioContext');
          audioContext.resume();
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
        console.log('[Focus] Sound played successfully');
      } catch (e) {
        console.log('[Focus] Audio error:', e);
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

    // Bulk Update Modal functions
    let parsedBulkData = [];

    function showBulkUpdateModal() {
      document.getElementById('bulk-update-modal').style.display = 'flex';
      document.getElementById('bulk-paste-input').value = '';
      document.getElementById('bulk-preview').innerHTML = '';
      document.getElementById('apply-bulk-btn').disabled = true;
      parsedBulkData = [];
    }

    function closeBulkUpdateModal() {
      document.getElementById('bulk-update-modal').style.display = 'none';
    }

    function parseBulkUpdate() {
      const input = document.getElementById('bulk-paste-input').value;
      if (!input.trim()) {
        showToast('❌ Please paste MEXC data first');
        return;
      }

      // Parse the MEXC grid bot table format
      parsedBulkData = parseMexcGridData(input);

      if (parsedBulkData.length === 0) {
        showToast('❌ Could not parse any positions from the data');
        return;
      }

      // Show preview
      const preview = document.getElementById('bulk-preview');
      let html = '';
      let matchedCount = 0;

      parsedBulkData.forEach(item => {
        const cardId = 'card-' + item.symbol + '-' + item.direction;
        const isTracked = !!activePositions[cardId];
        const cardExists = !!document.getElementById(cardId);
        matchedCount++; // All positions will be processed now

        const roiClass = item.roi >= 0 ? 'profit' : 'loss';
        let statusClass, statusText;
        if (isTracked) {
          statusClass = 'matched';
          statusText = '✓ Will update';
        } else if (cardExists) {
          statusClass = 'matched';
          statusText = '+ Will start (card visible)';
        } else {
          statusClass = 'matched';
          statusText = '+ Will start (no card)';
        }

        html += '<div class="modal-preview-item">' +
          '<span class="symbol">' + item.symbol.replace('USDT', '') + '</span>' +
          '<span>' + item.direction + ' ' + item.leverage + 'x</span>' +
          '<span class="roi ' + roiClass + '">' + (item.roi >= 0 ? '+' : '') + item.roi.toFixed(2) + '%</span>' +
          '<span class="status ' + statusClass + '">' + statusText + '</span>' +
          '</div>';
      });

      preview.innerHTML = html || '<div style="color: #8b949e;">No data parsed</div>';
      document.getElementById('apply-bulk-btn').disabled = matchedCount === 0;
      showToast('📋 Found ' + parsedBulkData.length + ' positions, ' + matchedCount + ' tracked');
    }

    function parseMexcGridData(text) {
      const results = [];
      console.log('[Bulk] Input length: ' + text.length);

      // Strategy: Find all XXX USDT symbols, then search nearby for direction/leverage/ROI
      // This handles messy pastes where data may be on same line or split weirdly

      // First, find all potential symbols (word ending in USDT)
      const upperText = text.toUpperCase();
      const symbolRegex = /([A-Z][A-Z0-9]{1,12})USDT/g;
      const foundSymbols = [];
      let m;
      while ((m = symbolRegex.exec(upperText)) !== null) {
        const sym = m[1] + 'USDT';
        // Skip header words
        if (sym !== 'INVESTMENTAMOUNTUSDT' && sym !== 'TRADINGPAIRUSDT' && sym !== 'TOTALPNLUSDT') {
          foundSymbols.push({ symbol: sym, pos: m.index });
        }
      }
      console.log('[Bulk] Found ' + foundSymbols.length + ' symbols: ' + foundSymbols.map(function(s){return s.symbol;}).join(', '));

      // For each symbol, look at the text chunk between this symbol and the next
      for (let i = 0; i < foundSymbols.length; i++) {
        const sym = foundSymbols[i];
        const nextPos = (i + 1 < foundSymbols.length) ? foundSymbols[i + 1].pos : text.length;
        const chunk = text.substring(sym.pos, nextPos);

        // Find direction + leverage: Short15X, Long10X, etc
        const dirMatch = chunk.match(/(Short|Long)[^0-9]*([0-9]+)[^A-Za-z]*X/i);
        if (!dirMatch) {
          console.log('[Bulk] ' + sym.symbol + ': no direction found');
          continue;
        }
        const direction = dirMatch[1].toUpperCase();
        const leverage = parseInt(dirMatch[2], 10);

        // Find ROI: look for USDT followed by +/-XX.XX%
        // Pattern like "+18.0825 USDT+44.67%" - we want the percentage after USDT
        let roi = null;

        // Try pattern: number + USDT + percentage (the PNL line)
        const pnlPattern = chunk.match(/[+-]?[0-9.]+\s*USDT\s*([+-][0-9.]+)\s*%/);
        if (pnlPattern) {
          roi = parseFloat(pnlPattern[1]);
        }

        // Fallback: look for percentage that's not a TP/SL Ratio
        if (roi === null) {
          // Find all percentages in chunk
          const allPcts = [];
          const pctRegex = /([+-]?[0-9.]+)\s*%/g;
          let pm;
          while ((pm = pctRegex.exec(chunk)) !== null) {
            const val = parseFloat(pm[1]);
            const context = chunk.substring(Math.max(0, pm.index - 30), pm.index).toLowerCase();
            // Skip if this is a TP/SL ratio
            if (context.indexOf('ratio') < 0 && context.indexOf('tp ') < 0 && context.indexOf('sl ') < 0) {
              allPcts.push(val);
            }
          }
          // The ROI is usually a small percentage (not the big TP ratios like 181%)
          // Pick the one that looks most like an ROI (between -50 and +100 typically)
          for (let p of allPcts) {
            if (p >= -100 && p <= 100) {
              roi = p;
              break;
            }
          }
        }

        if (roi !== null) {
          console.log('[Bulk] Parsed: ' + sym.symbol + ' ' + direction + ' ' + leverage + 'x = ' + roi + '%');
          results.push({ symbol: sym.symbol, direction: direction, leverage: leverage, roi: roi });
        } else {
          console.log('[Bulk] ' + sym.symbol + ': no ROI found');
        }
      }

      console.log('[Bulk] Total: ' + results.length + ' positions');
      return results;
    }

    function applyBulkUpdate() {
      if (parsedBulkData.length === 0) {
        showToast('❌ No data to apply');
        return;
      }

      let updated = 0;
      let started = 0;

      parsedBulkData.forEach(item => {
        const cardId = 'card-' + item.symbol + '-' + item.direction;
        const pos = activePositions[cardId];
        const card = document.getElementById(cardId);

        if (pos) {
          // Already tracking - only update leverage, preserve existing entry price
          pos.leverage = item.leverage;

          // Only calculate entry if position has no entry price yet
          if (!pos.entryPrice || pos.entryPrice === 0) {
            if (pos.currentPrice) {
              const spotPnlPct = item.roi / item.leverage;
              const isLong = item.direction === 'LONG';

              let calculatedEntry;
              if (isLong) {
                calculatedEntry = pos.currentPrice / (1 + spotPnlPct / 100);
              } else {
                calculatedEntry = pos.currentPrice / (1 - spotPnlPct / 100);
              }

              pos.entryPrice = calculatedEntry;
              pos.manualEntry = true;

              const entryInput = document.getElementById('entry-input-' + cardId);
              if (entryInput) {
                entryInput.value = calculatedEntry.toFixed(6);
              }
            } else {
              // No current price yet, store pending ROI
              pos.pendingRoi = item.roi;
            }
          }

          updated++;
        } else {
          // Not tracking yet - create new position regardless of whether card is visible
          // This allows bulk import to work even if signals are in different time windows or played out
          activePositions[cardId] = {
            symbol: item.symbol,
            direction: item.direction,
            entryPrice: 0, // Will be calculated from ROI once we have price
            entryRsi: 50, // Default
            targetPrice: 0,
            stopPrice: 0,
            enteredAt: Date.now(),
            leverage: item.leverage,
            manualEntry: true,
            pendingRoi: item.roi // Store ROI to calculate entry when price arrives
          };

          // Update UI if card exists
          if (card) {
            const enterBtn = document.getElementById('enter-btn-' + cardId);
            const monitorActive = document.getElementById('monitor-active-' + cardId);
            if (enterBtn && monitorActive) {
              enterBtn.style.display = 'none';
              monitorActive.style.display = 'block';
            }
            highlightCard(cardId);
          }

          started++;
        }
      });

      saveActivePositions();

      // Fetch prices and update - this will also calculate entries for new positions
      fetchCurrentPrices().then(function() {
        // Now calculate entry prices for positions that have pendingRoi and no entry yet
        Object.keys(activePositions).forEach(function(cardId) {
          const pos = activePositions[cardId];
          // Only calculate if pendingRoi exists AND no entry price set yet
          if (pos.pendingRoi !== undefined && pos.currentPrice && (!pos.entryPrice || pos.entryPrice === 0)) {
            const spotPnlPct = pos.pendingRoi / (pos.leverage || 1);
            const isLong = pos.direction === 'LONG';

            let calculatedEntry;
            if (isLong) {
              calculatedEntry = pos.currentPrice / (1 + spotPnlPct / 100);
            } else {
              calculatedEntry = pos.currentPrice / (1 - spotPnlPct / 100);
            }

            pos.entryPrice = calculatedEntry;
            delete pos.pendingRoi;

            // Update entry input if visible
            const entryInput = document.getElementById('entry-input-' + cardId);
            if (entryInput) {
              entryInput.value = calculatedEntry.toFixed(6);
            }
          } else if (pos.pendingRoi !== undefined && pos.entryPrice && pos.entryPrice > 0) {
            // Already has entry, just clear the pending ROI
            delete pos.pendingRoi;
          }
        });
        saveActivePositions();
        updateAllPositionHealth();
      });

      closeBulkUpdateModal();

      let msg = '';
      if (updated > 0) msg += '✅ Updated ' + updated + ' positions';
      if (started > 0) msg += (msg ? ', ' : '✅ ') + 'Started tracking ' + started + ' new';
      if (!msg) msg = '⚠️ No matching positions found';
      showToast(msg);
    }

    // Send browser notification
    function sendNotification(title, body, action) {
      console.log('[Focus] sendNotification called, notificationsEnabled:', notificationsEnabled, 'permission:', Notification.permission);
      if (!notificationsEnabled) {
        console.log('[Focus] Notifications disabled, skipping');
        return;
      }

      if (!('Notification' in window)) {
        console.log('[Focus] Notifications not supported in this browser');
        return;
      }

      if (Notification.permission !== 'granted') {
        console.log('[Focus] Notification permission not granted:', Notification.permission);
        return;
      }

      try {
        console.log('[Focus] Creating notification:', title, body);
        const notif = new Notification(title, {
          body: body,
          tag: 'focus-mode-' + Date.now(), // Unique tag to allow multiple notifications
          requireInteraction: false,
          silent: false
        });

        notif.onclick = () => {
          window.focus();
          notif.close();
        };

        notif.onerror = (e) => {
          console.log('[Focus] Notification error event:', e);
        };

        console.log('[Focus] Notification created successfully');
      } catch (e) {
        console.log('[Focus] Notification error:', e);
      }
    }

    // Test notification
    function testNotification() {
      console.log('[Focus] Test notification clicked');
      console.log('[Focus] Notification support:', 'Notification' in window);
      console.log('[Focus] Notification permission:', Notification.permission);
      console.log('[Focus] notificationsEnabled:', notificationsEnabled);

      if (!('Notification' in window)) {
        showToast('❌ Notifications not supported');
        return;
      }

      if (Notification.permission === 'denied') {
        showToast('❌ Notifications blocked - check browser settings');
        return;
      }

      if (Notification.permission !== 'granted') {
        Notification.requestPermission().then(perm => {
          console.log('[Focus] Permission result:', perm);
          if (perm === 'granted') {
            sendTestNotif();
          } else {
            showToast('❌ Notification permission denied');
          }
        });
        return;
      }

      sendTestNotif();
    }

    function sendTestNotif() {
      try {
        console.log('[Focus] Creating notification...');
        console.log('[Focus] Protocol:', window.location.protocol);
        console.log('[Focus] Permission:', Notification.permission);

        const notif = new Notification('Focus Mode Test', {
          body: 'Notifications are working! Time: ' + new Date().toLocaleTimeString(),
          tag: 'focus-test-' + Date.now(),
          requireInteraction: false,
          silent: false
        });

        notif.onshow = () => console.log('[Focus] Notification shown');
        notif.onerror = (e) => {
          console.log('[Focus] Notification error event:', e);
          showToast('❌ Notification failed to display');
        };
        notif.onclick = () => notif.close();

        showToast('✅ Notification sent (check OS notification center)');

        // Also show protocol warning if not secure
        if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
          showToast('⚠️ Non-HTTPS may block notifications');
        }
      } catch (e) {
        console.log('[Focus] Test notification error:', e);
        showToast('❌ Notification error: ' + e.message);
      }
    }

    // Poll for updates
    async function checkForUpdates() {
      try {
        const currentConfig = document.getElementById('config-select')?.value || '${configKey}';
        const response = await fetch('/api/focus-mode?config=' + encodeURIComponent(currentConfig));
        const data = await response.json();

        const newQuadrant = data.quadrant;
        const newAction = data.rule.action;
        const newActionableCount = data.actionableSignals.length;

        console.log('[Focus] checkForUpdates - lastQ:', lastQuadrant, 'newQ:', newQuadrant,
                    'lastCount:', lastActionableCount, 'newCount:', newActionableCount, 'action:', newAction);

        // Check if regime changed to actionable OR new signals appeared
        const regimeChanged = newQuadrant !== lastQuadrant;
        const signalsIncreased = newActionableCount > lastActionableCount;
        const isActionable = newAction !== 'SKIP';

        if (isActionable && (regimeChanged || signalsIncreased)) {
          console.log('[Focus] ALERT TRIGGERED! regimeChanged:', regimeChanged, 'signalsIncreased:', signalsIncreased);

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

        // Also alert for new signals even if count didn't change (new symbol replaced old one)
        if (isActionable && newActionableCount > 0 && data.actionableSignals[0]) {
          const newestSignal = data.actionableSignals[0];
          const newestTime = new Date(newestSignal.timestamp).getTime();
          const tenSecsAgo = Date.now() - 15000; // 15 second window

          if (newestTime > tenSecsAgo && !regimeChanged && !signalsIncreased) {
            console.log('[Focus] New signal detected (same count but fresh):', newestSignal.symbol);
            playAlert(newAction);
            sendNotification(
              '🔥 New Signal!',
              newestSignal.symbol.replace('USDT', '') + ' - ' + newAction,
              newAction
            );
          }
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
      // Settings are already loaded from localStorage at script start
      // But if browser permission was revoked, disable notifications
      if (notificationsEnabled && 'Notification' in window && Notification.permission !== 'granted') {
        notificationsEnabled = false;
        saveFocusModeSettings();
      }

      // Update UI to match loaded settings
      updateNotificationButton();
      updateAudioButton();
      updateLinkButton();

      // Set time window dropdown to saved value (may differ from URL if first load)
      const windowSelect = document.getElementById('time-window-select');
      if (windowSelect && activeWindowHours) {
        windowSelect.value = activeWindowHours.toString();
      }

      // Restore collapsed card states
      restoreCollapsedState();

      // Restore active position monitors BEFORE sorting
      // (so tracking-based sorts have access to activePositions)
      restoreActivePositions();

      // Restore sort preference (must run after activePositions is loaded)
      restoreSortPreference();

      // Start polling every 10 seconds
      setInterval(checkForUpdates, 10000);

      // Update position health every 10 seconds
      setInterval(updateAllPositionHealth, 10000);

      // Refresh full page every 60 seconds to get new signals list
      setTimeout(() => location.reload(), 60000);
    });

    function updateAudioButton() {
      const btn = document.getElementById('audio-btn');
      if (btn) {
        btn.textContent = audioEnabled ? '🔊 Audio ON' : '🔇 Audio OFF';
        btn.classList.toggle('active', audioEnabled);
      }
    }

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
