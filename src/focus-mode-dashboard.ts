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
  <link rel="stylesheet" href="/static/css/focus-mode.css">
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
    // Initialize values for external focus-mode.js
    window.FOCUS_MODE_INIT = {
      quadrant: '${quadrant}',
      actionableCount: ${actionableSignals.length}
    };
  </script>
  <script src="/static/js/focus-mode.js"></script>
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
