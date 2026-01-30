#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import { BackburnerScreener } from './screener.js';
import { PaperTradingEngine } from './paper-trading.js';
import { TrailingStopEngine } from './paper-trading-trailing.js';
import { ConfluenceBot } from './confluence-bot.js';
import { BTCExtremeBot } from './btc-extreme-bot.js';
import { BTCTrendBot } from './btc-trend-bot.js';
import { TrendOverrideBot } from './trend-override-bot.js';
import { TrendFlipBot } from './trend-flip-bot.js';
import { FadeBot } from './fade-bot.js';
import { SpotRegimeBot, createStrictFilterBot, createLooseFilterBot, createStandardFilterBot, createContrarianOnlyBot } from './spot-regime-bot.js';
import {
  FocusModeShadowBot,
  createBaselineBot as createFocusBaselineBot,
  createConflictCloseBot,
  createExcellentOverflowBot,
  createHybridBot,
  createAggressiveBot as createFocusAggressiveBot,
  createConservativeBot as createFocusConservativeBot,
  // createKellySizingBot REMOVED - see data/archived/KELLY_SIZING_EXPERIMENT.md
  createContrarianOnlyBot as createFocusContrarianBot,
  createEuphoriaFadeBot,
  createBullDipBuyerBot,
  createFullQuadrantBot,
  type FocusModeSignal,
  type SetupQuality,
  type Quadrant,
} from './focus-mode-shadow-bot.js';
// BTC Bias bots (V1 & V2) REMOVED - 0% win rate, -$7,459 losses. See data/archived/BTC_BIAS_V1_EXPERIMENT.md
import type { BiasLevel } from './btc-bias-bot.js';  // Keep type for BTC bias filter
import { createMexcSimulationBots } from './mexc-trailing-simulation.js';
import { NotificationManager } from './notifications.js';
// FocusModeManager REMOVED - legacy trade copying feature removed, shadow bots remain for A/B testing
import { BackburnerDetector } from './backburner-detector.js';
import { GoldenPocketBot } from './golden-pocket-bot.js';
import { GoldenPocketBotV2 } from './golden-pocket-bot-v2.js';
import { GoldenPocketDetectorV2 } from './golden-pocket-detector-v2.js';
import { getKlines, getFuturesKlines, spotSymbolToFutures, getCurrentPrice, getPrice, getBtcMarketData } from './mexc-api.js';
import { getMarketBiasSystemB, type SystemBBiasResult } from './market-bias-system-b.js';
import { createExperimentalBots, type ExperimentalShadowBot } from './experimental-shadow-bots.js';
import { getCurrentRSI, calculateRSI, calculateSMA, detectDivergence } from './indicators.js';
import { DEFAULT_CONFIG } from './config.js';
import { getDataPersistence } from './data-persistence.js';
import { initSchema as initTursoSchema, isTursoConfigured, executeReadQuery, getDatabaseStats, saveServerSettingsToTurso, loadServerSettingsFromTurso, saveTrailingPosition, loadTrailingPositions, deleteTrailingPosition } from './turso-db.js';
import { MexcTrailingManager, type TrackedPosition } from './mexc-trailing-manager.js';
import { getFocusModeHtml, getFocusModeApiData, calculateSmartTradeSetup } from './focus-mode-dashboard.js';
import type { BackburnerSetup, Timeframe, MomentumExhaustionSignal } from './types.js';
import { createSettingsRouter } from './routes/index.js';
import type { ServerContext } from './server-context.js';
import { createMexcClient, usdToContracts, getContractSize, type MexcFuturesClient } from './mexc-futures-client.js';
import fs from 'fs';
import path from 'path';

const app = express();

// Serve static files from views directory (CSS, JS)
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/static', express.static(path.join(__dirname, 'views')));

// ============================================================================
// TIMEFRAME FILTER CONFIG
// Based on backtest analysis (Jan 2026):
// - 1h LONG: 0% win rate, -$1,058 total → DISABLED
// - 1h SHORT: 13% win rate, -$1,291 total → DISABLED
// - 15m LONG: 57% win rate, +$6 total → ENABLED (best performer)
// - 15m SHORT: 47% win rate, -$490 total → ENABLED
// - 5m trades: 35-38% win rate → ENABLED with BTC trend filter
// ============================================================================
// V2 CHANGE: Focus exclusively on 5m timeframe (best win rate: 31.8%)
// Analysis showed 5m had best performance, 15m was marginal, 1h was terrible
const ALLOWED_TIMEFRAMES: Timeframe[] = ['5m', '15m'];  // TCG pairings: 5m→1h HTF, 15m→4h HTF

// ============================================================================
// MOMENTUM EXHAUSTION TRACKER
// Tracks coins that are "extended" on higher timeframes (4H, 1H)
// Used to filter out bad 5m trades in the direction of exhaustion
// ============================================================================
const momentumExhaustionMap = new Map<string, MomentumExhaustionSignal>();

/**
 * Update momentum exhaustion tracker when we see momentum_exhaustion signals
 */
function updateMomentumExhaustion(setup: BackburnerSetup): void {
  if (setup.signalClassification !== 'momentum_exhaustion') return;
  if (!setup.exhaustionDirection) return;

  // Only track higher timeframes (1h, 4h) - these filter lower timeframe trades
  if (setup.timeframe !== '1h' && setup.timeframe !== '4h') return;

  const key = `${setup.symbol}-${setup.timeframe}`;
  const signal: MomentumExhaustionSignal = {
    symbol: setup.symbol,
    timeframe: setup.timeframe,
    direction: setup.exhaustionDirection,
    impulsePercent: setup.impulsePercentMove,
    currentRSI: setup.currentRSI,
    currentPrice: setup.currentPrice,
    detectedAt: setup.detectedAt,
    lastUpdated: Date.now(),
    impulseStartPrice: setup.impulseLow,  // For DOWN impulse, low is start
    impulseEndPrice: setup.impulseHigh,   // For DOWN impulse, high is end
  };

  momentumExhaustionMap.set(key, signal);
  console.log(`[EXHAUSTION] ${setup.symbol} ${setup.timeframe} marked as ${setup.exhaustionDirection} (RSI: ${setup.currentRSI.toFixed(1)}, impulse: ${setup.impulsePercentMove.toFixed(1)}%)`);
}

/**
 * Clean up stale exhaustion signals (older than 4 hours)
 */
function cleanupStaleExhaustion(): void {
  const staleThreshold = 4 * 60 * 60 * 1000; // 4 hours
  const now = Date.now();

  for (const [key, signal] of momentumExhaustionMap.entries()) {
    if (now - signal.lastUpdated > staleThreshold) {
      momentumExhaustionMap.delete(key);
      console.log(`[EXHAUSTION] Cleaned up stale signal: ${key}`);
    }
  }
}

/**
 * Check if a symbol has momentum exhaustion on a higher timeframe
 * Returns the exhaustion signal if found, null otherwise
 */
function checkMomentumExhaustion(symbol: string, direction: 'long' | 'short'): MomentumExhaustionSignal | null {
  // Check 4H exhaustion first (stronger signal)
  const key4h = `${symbol}-4h`;
  const key1h = `${symbol}-1h`;

  const signal4h = momentumExhaustionMap.get(key4h);
  const signal1h = momentumExhaustionMap.get(key1h);

  // For LONG trades, check if coin is extended_long (pumped too hard)
  if (direction === 'long') {
    if (signal4h?.direction === 'extended_long') return signal4h;
    if (signal1h?.direction === 'extended_long') return signal1h;
  }

  // For SHORT trades, check if coin is extended_short (dumped too hard)
  if (direction === 'short') {
    if (signal4h?.direction === 'extended_short') return signal4h;
    if (signal1h?.direction === 'extended_short') return signal1h;
  }

  return null;
}

/**
 * Get all current momentum exhaustion signals (for dashboard)
 */
function getAllExhaustionSignals(): MomentumExhaustionSignal[] {
  return Array.from(momentumExhaustionMap.values())
    .sort((a, b) => b.impulsePercent - a.impulsePercent);  // Sort by impulse size
}

/**
 * Check if a setup should be traded based on TCG methodology
 * Returns false to skip setups that don't meet quality criteria
 */
function shouldTradeSetup(setup: BackburnerSetup, btcBias: string): boolean {
  // Only trade on allowed timeframes (5m, 15m — with proper HTF pairings)
  if (!ALLOWED_TIMEFRAMES.includes(setup.timeframe)) {
    console.log(`[FILTER] Skip ${setup.symbol} - ${setup.timeframe} timeframe not allowed for trading`);
    return false;
  }

  // ==========================================================================
  // TCG FIX 1: REQUIRE HTF ALIGNMENT
  // "5m signal marks hourly higher low" - only trade if HTF confirms direction
  // ==========================================================================
  if (setup.htfConfirmed === false) {
    console.log(`[FILTER] Skip ${setup.symbol} ${setup.timeframe} ${setup.direction} - HTF not aligned`);
    return false;
  }

  // RSI cross filter removed — the detector already gates on RSI < 30 (line 258)
  // and the "first oversold after impulse" check ensures freshness.
  // The cross filter was blocking 75% of valid entries.

  // ==========================================================================
  // MOMENTUM EXHAUSTION FILTER
  // Skip trades if the coin is "extended" on a higher timeframe
  // e.g., Don't go LONG on 5m if 4H shows extended_long (pumped too hard)
  // ==========================================================================
  const exhaustionSignal = checkMomentumExhaustion(setup.symbol, setup.direction);
  if (exhaustionSignal) {
    console.log(`[FILTER] Skip ${setup.symbol} ${setup.timeframe} ${setup.direction.toUpperCase()} - ${exhaustionSignal.timeframe} shows ${exhaustionSignal.direction} (RSI: ${exhaustionSignal.currentRSI.toFixed(1)}, impulse: ${exhaustionSignal.impulsePercent.toFixed(1)}%)`);
    return false;
  }

  // ==========================================================================
  // UNIVERSAL BTC BIAS FILTER (ALL TIMEFRAMES)
  // Based on Jan 13 analysis: 88 shorts on a bullish day = -$1,131.86 loss
  // Only trade in the direction of BTC's bias for best performance
  // ==========================================================================

  // Long setup + BTC bearish = contrarian → skip
  if (setup.direction === 'long' && (btcBias === 'short' || btcBias === 'strong_short')) {
    console.log(`[FILTER] Skip ${setup.symbol} ${setup.timeframe} LONG - BTC bearish (${btcBias})`);
    return false;
  }
  // Short setup + BTC bullish = contrarian → skip
  if (setup.direction === 'short' && (btcBias === 'long' || btcBias === 'strong_long')) {
    console.log(`[FILTER] Skip ${setup.symbol} ${setup.timeframe} SHORT - BTC bullish (${btcBias})`);
    return false;
  }

  return true;
}
const PORT = process.env.PORT || 3000;

// Store connected SSE clients
const clients: Set<express.Response> = new Set();

// Bot visibility state (which bots are shown in UI)
const botVisibility: Record<string, boolean> = {
  fixedTP: true,
  fixedBE: true,        // Fixed TP with breakeven lock at +10%
  trailing1pct: true,
  trailing10pct10x: true,
  trailing10pct20x: true,
  trendOverride: true,
  trendFlip: true,
  trailWide: true,      // 20% trigger, 10% L1 lock
  confluence: true,     // Multi-TF confluence (5m + 15m/1h)
  btcExtreme: true,
  btcTrend: true,
  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
  // MEXC Simulation bots (6 variants)
  'mexc-aggressive': true,
  'mexc-aggressive-2cb': true,
  'mexc-wide': true,
  'mexc-wide-2cb': true,
  'mexc-standard': true,
  'mexc-standard-05cb': true,
  // Golden Pocket bots (Fibonacci hype strategy - 4 variants)
  'gp-conservative': true,
  'gp-standard': true,
  'gp-aggressive': true,
  'gp-yolo': true,
  // Golden Pocket V2 bots (loosened thresholds - 4 variants)
  'gp2-conservative': true,
  'gp2-standard': true,
  'gp2-aggressive': true,
  'gp2-yolo': true,
  // V2 CHANGE: BTC Bias V2 bots REMOVED - 0% win rate, -$7,459 losses
  // 'bias-v2-20x10-trail': true,
  // 'bias-v2-20x20-trail': true,
  // 'bias-v2-10x10-trail': true,
  // 'bias-v2-10x20-trail': true,
  // 'bias-v2-20x10-hard': true,
  // 'bias-v2-20x20-hard': true,
  // 'bias-v2-10x10-hard': true,
  // 'bias-v2-10x20-hard': true,
};

// Server settings (persisted across restarts)
interface ServerSettings {
  dailyResetEnabled: boolean;
  lastResetDate: string;  // YYYY-MM-DD format
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  investmentAmount: number;  // User's actual MEXC investment amount
  botNotifications: Record<string, boolean>;  // Per-bot notification enable/disable
  // MEXC Live Execution - Bot Feeder
  mexcSelectedBots: string[];         // Which focus bots feed the execution queue
  mexcPositionSizeUsd: number;        // Real-money position size per trade (USD)
  mexcMaxPositionSizeUsd: number;     // Safety cap on position size
  mexcPositionSizeMode: 'fixed' | 'percent';  // Fixed USD or % of available balance
  mexcPositionSizePct: number;        // Percentage of available balance per trade
  mexcMaxLeverage: number;            // Override: cap leverage at this value
  mexcAutoExecute: boolean;           // Full automation: auto-execute in live mode
  mexcExecutionMode: 'dry_run' | 'shadow' | 'live';  // Persisted execution mode
  // Conditional Insurance - only activate during stress periods
  conditionalInsuranceEnabled: boolean;
}

// Default bot notification settings - top performers enabled by default
const defaultBotNotifications: Record<string, boolean> = {
  // Experimental A/B Testing Bots (top performers)
  'exp-bb-sysB': true,
  'exp-bb-sysB-contrarian': true,
  'exp-gp-sysA': false,
  'exp-gp-sysB': false,
  'exp-gp-regime': false,
  'exp-gp-sysB-contrarian': false,
  // Focus Mode Shadow Bots
  'focus-baseline': true,
  'focus-aggressive': false,
  'focus-conservative': true,
  'focus-conflict': false,
  'focus-hybrid': false,
  'focus-excellent': true,
  // focus-kelly REMOVED - see data/archived/KELLY_SIZING_EXPERIMENT.md
  'focus-contrarian-only': true,
  'focus-euphoria-fade': true,
  'focus-bull-dip': true,
  'focus-full-quadrant': false,
};

const serverSettings: ServerSettings = {
  dailyResetEnabled: false,  // Default: OFF
  lastResetDate: new Date().toISOString().split('T')[0],
  notificationsEnabled: true,  // Default: ON
  soundEnabled: true,  // Default: ON
  investmentAmount: 2000,  // Default: $2000
  botNotifications: { ...defaultBotNotifications },
  // MEXC Bot Feeder - default safe: no bots selected
  mexcSelectedBots: [],
  mexcPositionSizeUsd: 10,
  mexcMaxPositionSizeUsd: 50,
  mexcPositionSizeMode: 'fixed',
  mexcPositionSizePct: 5,
  mexcMaxLeverage: 20,
  mexcAutoExecute: false,
  mexcExecutionMode: 'dry_run',
  // Conditional insurance: enabled by default (backtest showed +$706 improvement)
  conditionalInsuranceEnabled: true,
};

// Load server settings from disk first, then Turso fallback (for Render ephemeral filesystem)
function loadServerSettings(): void {
  let loaded = false;
  try {
    const settingsPath = path.join(process.cwd(), 'data', 'server-settings.json');
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (data.botNotifications) {
        data.botNotifications = { ...defaultBotNotifications, ...data.botNotifications };
      }
      Object.assign(serverSettings, data);
      console.log('[SETTINGS] Loaded server settings from disk');
      loaded = true;
    }
  } catch (e) {
    console.error('[SETTINGS] Failed to load server settings from disk:', e);
  }

  // Turso fallback: if disk file doesn't exist (Render restart), load from cloud
  if (!loaded && isTursoConfigured()) {
    loadServerSettingsFromTurso().then(data => {
      if (data) {
        if ((data as any).botNotifications) {
          (data as any).botNotifications = { ...defaultBotNotifications, ...(data as any).botNotifications };
        }
        Object.assign(serverSettings, data);
        console.log('[SETTINGS] Loaded server settings from Turso (disk was empty)');
      }
    }).catch(e => {
      console.error('[SETTINGS] Failed to load settings from Turso:', e);
    });
  }
}

// Save server settings to disk + Turso (async cloud backup for Render persistence)
function saveServerSettings(): void {
  try {
    const settingsPath = path.join(process.cwd(), 'data', 'server-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(serverSettings, null, 2));
    console.log('[SETTINGS] Saved server settings to disk');
  } catch (e) {
    console.error('[SETTINGS] Failed to save server settings to disk:', e);
  }

  // Async Turso backup (fire-and-forget)
  if (isTursoConfigured()) {
    saveServerSettingsToTurso(serverSettings as unknown as Record<string, unknown>).catch(e => {
      console.error('[SETTINGS] Failed to save settings to Turso:', e);
    });
  }
}

// Get current date string (YYYY-MM-DD)
function getCurrentDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// Setup history (keeps removed setups for longer viewing)
const setupHistory: BackburnerSetup[] = [];
const MAX_HISTORY_SIZE = 100;

// Initialize components
const screener = new BackburnerScreener(
  {
    timeframes: DEFAULT_CONFIG.timeframes,
    minVolume24h: DEFAULT_CONFIG.minVolume24h,
    updateIntervalMs: DEFAULT_CONFIG.updateIntervalMs,
    minImpulsePercent: DEFAULT_CONFIG.minImpulsePercent,
  },
  {
    onNewSetup: handleNewSetup,
    onSetupUpdated: handleSetupUpdated,
    onSetupRemoved: handleSetupRemoved,
    onScanProgress: handleScanProgress,
    onScanStatus: handleScanStatus,
    onError: (error, symbol) => console.error(`Error${symbol ? ` (${symbol})` : ''}:`, error.message),
  }
);

// Bot 1: Fixed TP/SL strategy (1% position, 10x leverage)
// Includes friction modeling (fees + slippage) for realistic PnL
// V2 CHANGE: Adjusted TP/SL for better R:R ratio
// - Old: 20% TP, 20% SL = 1:1 R:R
// - New: 35% TP, 12% SL = 2.9:1 R:R (need >26% win rate to profit)
const fixedTPBot = new PaperTradingEngine({
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  takeProfitPercent: 35,  // V2: 35% TP (was 20%) - wider target
  stopLossPercent: 12,    // V2: 12% SL (was 20%) - tighter stop
  maxOpenPositions: 10,
  enableFriction: true,   // Enable slippage + fee modeling
}, 'fixed');

// Bot 1b: Fixed TP with breakeven lock (1% position, 10x leverage)
// Moves SL to breakeven at +10% ROI, then continues to TP
// V2 CHANGE: Adjusted TP/SL for better R:R ratio
const fixedBreakevenBot = new PaperTradingEngine({
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  takeProfitPercent: 35,  // V2: 35% TP (was 20%)
  stopLossPercent: 12,    // V2: 12% SL (was 20%)
  breakevenTriggerPercent: 8,   // V2: BE trigger at +8% ROI (was 10%)
  maxOpenPositions: 10,
  enableFriction: true,   // Enable slippage + fee modeling
}, 'fixed-be');

// Bot 2: Trailing stop strategy (1% position, 10x leverage)
// V2 CHANGE: Tighter initial stop, earlier trail trigger
const trailing1pctBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%) - start trailing sooner
  trailStepPercent: 8,         // V2: 8% (was 10%) - tighter trail steps
  level1LockPercent: 0,        // Level 1 = breakeven
  maxOpenPositions: 10,
}, '1pct');

// Bot 3: Trailing stop strategy (10% position, 10x leverage) - AGGRESSIVE
// V2 CHANGE: Tighter stops for better R:R
const trailing10pct10xBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 10,
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%)
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 0,        // Level 1 = breakeven
  maxOpenPositions: 100,
}, '10pct10x');

// Bot 4: Trailing stop strategy (10% position, 20x leverage) - VERY AGGRESSIVE
// V2 CHANGE: Tighter stops for better R:R
const trailing10pct20xBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%)
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 0,        // Level 1 = breakeven
  maxOpenPositions: 100,
}, '10pct20x');

// ============================================================================
// SHADOW BOTS - Stop Loss Variants for A/B Testing
// V2 CHANGE: Updated to test tighter stops around the new 12% baseline
// These run in parallel with the main bots to test different stop levels
// ============================================================================

// Shadow: 8% initial stop (tightest - aggressive)
const shadow10pct10x_sl8 = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 10,
  initialStopLossPercent: 8,   // V2: 8% stop (tightest)
  trailTriggerPercent: 6,
  trailStepPercent: 6,
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'shadow-10pct10x-sl8');

// Shadow: 10% initial stop
const shadow10pct10x_sl10 = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 10,
  initialStopLossPercent: 10,  // V2: 10% stop
  trailTriggerPercent: 8,
  trailStepPercent: 8,
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'shadow-10pct10x-sl10');

// Shadow: 15% initial stop (looser)
const shadow10pct10x_sl15 = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 10,
  initialStopLossPercent: 15,  // V2: 15% stop
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'shadow-10pct10x-sl15');

// Shadow: 18% initial stop (loosest in V2)
const shadow10pct10x_sl18 = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 10,
  initialStopLossPercent: 18,  // V2: 18% stop (closest to old 20%)
  trailTriggerPercent: 12,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'shadow-10pct10x-sl18');

// Array of all shadow bots for easy iteration
// V2 CHANGE: Testing 8%, 10%, 15%, 18% (removed 25%, 30% - too loose)
const shadowBots = [
  { id: 'shadow-10pct10x-sl8', bot: shadow10pct10x_sl8, stopPct: 8 },
  { id: 'shadow-10pct10x-sl10', bot: shadow10pct10x_sl10, stopPct: 10 },
  { id: 'shadow-10pct10x-sl15', bot: shadow10pct10x_sl15, stopPct: 15 },
  { id: 'shadow-10pct10x-sl18', bot: shadow10pct10x_sl18, stopPct: 18 },
];

// ============================================================================
// TIMEFRAME STRATEGY SHADOW BOTS
// Testing backtest findings: 5m fade vs 4H normal
// ============================================================================
import { TimeframeShadowBot } from './timeframe-shadow-bot.js';

// 5m Fade Strategy (backtest showed fade wins on 5m - RSI signals seem backwards)
const shadow5mFade = new TimeframeShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['5m'],
  fadeSignals: true,  // FADE: opposite of signal direction
}, 'shadow-5m-fade');

// 5m Normal Strategy (control - what current bots do)
const shadow5mNormal = new TimeframeShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['5m'],
  fadeSignals: false,  // NORMAL: follow signal direction
}, 'shadow-5m-normal');

// 4H Normal Strategy (backtest showed normal wins on 4H - RSI signals reliable)
const shadow4hNormal = new TimeframeShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['4h'],
  fadeSignals: false,  // NORMAL: follow signal direction
}, 'shadow-4h-normal');

// 4H Fade Strategy (control - to verify normal beats fade on 4H)
const shadow4hFade = new TimeframeShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['4h'],
  fadeSignals: true,  // FADE: opposite of signal direction
}, 'shadow-4h-fade');

// Array of timeframe strategy shadow bots (BACKBURNER STRATEGY)
// These use the full Backburner detection: impulse → RSI cross → state machine
const timeframeShadowBots = [
  { id: 'shadow-5m-fade', bot: shadow5mFade, desc: 'BB 5m Fade (backtest winner)' },
  { id: 'shadow-5m-normal', bot: shadow5mNormal, desc: 'BB 5m Normal (control)' },
  { id: 'shadow-4h-normal', bot: shadow4hNormal, desc: 'BB 4H Normal (backtest winner)' },
  { id: 'shadow-4h-fade', bot: shadow4hFade, desc: 'BB 4H Fade (control)' },
];

// ============================================================================
// GP SHADOW BOTS (Golden Pocket RSI Zone Strategy)
// ============================================================================
// These use SIMPLER entry logic than Backburner:
// - Just check if RSI is in golden pocket zone (23.6-38.2 long, 61.8-76.4 short)
// - No impulse requirement, no state machine
//
// BACKTEST RESULTS (Jan 2026, 83 days of 4H data, 152 symbols):
// | Strategy            | Trades | Win%  | PF   | P&L       |
// |---------------------|--------|-------|------|-----------|
// | Backburner 4H Norm  | ~19    | 89.5% | 6.13 | +$412     |
// | GP Zone 4H Norm     | 152    | 27.6% | 1.69 | +$10,672  |
//
// GP Zone generated MORE trades and MORE profit despite lower win rate.
// Testing if this holds in live paper trading.
// ============================================================================
import { GpShadowBot } from './gp-shadow-bot.js';

// GP 4H Normal (backtest showed +$10,672 profit)
const gp4hNormal = new GpShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['4h'],
  fadeSignals: false,  // NORMAL: RSI 23.6-38.2 → LONG, RSI 61.8-76.4 → SHORT
  gpLongLower: 23.6,
  gpLongUpper: 38.2,
  gpShortLower: 61.8,
  gpShortUpper: 76.4,
}, 'gp-4h-normal');

// GP 4H Fade (control - testing if fade works better on GP too)
const gp4hFade = new GpShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['4h'],
  fadeSignals: true,  // FADE: RSI 23.6-38.2 → SHORT, RSI 61.8-76.4 → LONG
  gpLongLower: 23.6,
  gpLongUpper: 38.2,
  gpShortLower: 61.8,
  gpShortUpper: 76.4,
}, 'gp-4h-fade');

// GP 5m Normal (control - comparing to 5m fade)
const gp5mNormal = new GpShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['5m'],
  fadeSignals: false,  // NORMAL direction
  gpLongLower: 23.6,
  gpLongUpper: 38.2,
  gpShortLower: 61.8,
  gpShortUpper: 76.4,
}, 'gp-5m-normal');

// GP 5m Fade (testing if 5m fade works for GP like it does for Backburner)
const gp5mFade = new GpShadowBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  allowedTimeframes: ['5m'],
  fadeSignals: true,  // FADE direction
  gpLongLower: 23.6,
  gpLongUpper: 38.2,
  gpShortLower: 61.8,
  gpShortUpper: 76.4,
}, 'gp-5m-fade');

// Array of GP shadow bots for easy iteration
const gpShadowBots = [
  { id: 'gp-4h-normal', bot: gp4hNormal, desc: 'GP 4H Normal (backtest: +$10.6k)' },
  { id: 'gp-4h-fade', bot: gp4hFade, desc: 'GP 4H Fade (control)' },
  { id: 'gp-5m-normal', bot: gp5mNormal, desc: 'GP 5m Normal (control)' },
  { id: 'gp-5m-fade', bot: gp5mFade, desc: 'GP 5m Fade (test)' },
];

// ============================================================================
// COMBINED STRATEGY BOT (4H Normal + 5m Fade)
// Uses 4H to establish trend direction, 5m fade for entry timing
// ============================================================================
import { CombinedStrategyBot } from './combined-strategy-bot.js';

const combinedStrategyBot = new CombinedStrategyBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  htfBiasValidityMs: 12 * 60 * 60 * 1000,  // 12 hours
  htfTimeframe: '4h',
  ltfTimeframe: '5m',
}, 'combined-4h5m');

// Bot 5: Wide trailing (20% trigger, 10% L1 lock)
// V2 CHANGE: Tighter initial stop, keep wide trail trigger for runners
const trailWideBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 15,     // V2: 15% (was 20%) - wait for good move
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 8,        // V2: 8% (was 10%)
  maxOpenPositions: 100,
}, 'wide');

// Bot 6: Multi-Timeframe Confluence (5m + 15m/1h required)
// V2 NOTE: With 5m-only filter, this bot may see fewer signals
// V2 CHANGE: Tighter stops
const confluenceBot = new ConfluenceBot({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%)
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 0,        // Breakeven at L1
  maxOpenPositions: 100,
  requiredTimeframe: '5m',
  confirmingTimeframes: ['15m', '1h'],
  confluenceWindowMs: 5 * 60 * 1000,  // 5 minutes
}, 'confluence');

// Bot 7: Triple Light - REMOVED (underperforming)
// Was: Tracks 5m, 15m, 1h signals per asset. Only enters when ALL 3 show green light.

// Bot 8: BTC Contrarian (50x leverage) - BTCUSDT only
// Fades extreme RSI conditions (buys oversold, sells overbought)
const btcExtremeBot = new BTCExtremeBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 50,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  extremeOversoldThreshold: 30,
  extremeOverboughtThreshold: 70,
  coolOffThreshold: 50,
});

// Bot 8: BTC Momentum (50x leverage) - BTCUSDT only
// Follows strong trends when bias score > 70%
const btcTrendBot = new BTCTrendBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 50,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  strongBiasThreshold: 70,    // Enter when bias score > 70% or < -70%
  exitBiasThreshold: 30,      // Exit when bias weakens below 30%
});

// Bot 10: Trend Override - trades WITH trend when backburner conflicts
// V2 CHANGE: Tighter stops
const trendOverrideBot = new TrendOverrideBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%)
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'override');

// Bot 11: Trend Flip - same as override but flips on profitable close
// V2 CHANGE: Tighter stops
const trendFlipBot = new TrendFlipBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 12,  // V2: 12% (was 20%)
  trailTriggerPercent: 8,      // V2: 8% (was 10%)
  trailStepPercent: 8,         // V2: 8% (was 10%)
  level1LockPercent: 0,
  maxOpenPositions: 100,
  flipOnProfit: true,
  flipStopLossPercent: 12,     // V2: 12% (was 20%)
}, 'flip');

// BTC Bias V1 Bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md

// V2 CHANGE: BTC Bias V2 Bots REMOVED - 0% win rate, -$7,459 losses (40% of total)
// Bots 30-37: BTC Bias Bots V2 (8 variants) - CONSERVATIVE
// const btcBiasBotsV2 = createBtcBiasBotsV2(2000);
const btcBiasBotsV2 = new Map<string, any>();  // Empty map to prevent runtime errors

// Bots 20-25: MEXC Trailing Stop Simulation Bots (6 variants)
// Simulates MEXC's continuous trailing stop behavior for comparison with our discrete levels
const mexcSimBots = createMexcSimulationBots(2000);

// Bots 26-29: Golden Pocket Bots (Fibonacci hype strategy)
// IMPROVED: Tighter entry zone (0.618-0.635), wider stop (0.85), RSI confirmation required
// Targets coins with sudden volatility spikes, enters on 0.618 retracement with RSI confirmation

// GP Bot 1: Conservative (3% pos, 2x leverage)
// LEVERAGE NOTE: GP SL is ~15-25% (fib invalidation), so max safe leverage is 3-5x
const gpConservativeBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 3,
  leverage: 2,            // Safe: liquidation at 50%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp-conservative');

// GP Bot 2: Standard (5% pos, 3x leverage)
const gpStandardBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 3,            // Safe: liquidation at 33%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp-standard');

// GP Bot 3: Aggressive (5% pos, 4x leverage)
const gpAggressiveBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 4,            // Safe: liquidation at 25%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp-aggressive');

// GP Bot 4: Max (10% pos, 5x leverage) - renamed from YOLO
const gpYoloBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 5,            // Borderline: liquidation at 20%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp-yolo');

// Collect all GP bots for easy iteration
const goldenPocketBots = new Map([
  ['gp-conservative', gpConservativeBot],
  ['gp-standard', gpStandardBot],
  ['gp-aggressive', gpAggressiveBot],
  ['gp-yolo', gpYoloBot],
]);

// Bots 38-41: Golden Pocket V2 Bots (4 variants) - LOOSENED THRESHOLDS
// Looser RSI requirements (50 instead of 40/60), lower volume requirement (1.5x instead of 2x)
// LEVERAGE NOTE: GP SL is ~15-25% (fib invalidation), so max safe leverage is 3-5x
const gpV2ConservativeBot = new GoldenPocketBotV2({
  initialBalance: 2000,
  positionSizePercent: 3,
  leverage: 2,            // Safe: liquidation at 50%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp2-conservative');

const gpV2StandardBot = new GoldenPocketBotV2({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 3,            // Safe: liquidation at 33%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp2-standard');

const gpV2AggressiveBot = new GoldenPocketBotV2({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 4,            // Safe: liquidation at 25%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp2-aggressive');

const gpV2YoloBot = new GoldenPocketBotV2({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 5,            // Borderline: liquidation at 20%, SL at ~20%
  maxOpenPositions: 100,
}, 'gp2-yolo');

// Collect all GP V2 bots
const goldenPocketBotsV2 = new Map([
  ['gp2-conservative', gpV2ConservativeBot],
  ['gp2-standard', gpV2StandardBot],
  ['gp2-aggressive', gpV2AggressiveBot],
  ['gp2-yolo', gpV2YoloBot],
]);

// ============================================================================
// FADE BOTS - Contrarian strategy (take OPPOSITE of RSI signal)
// Hypothesis: RSI signals might be backwards - oversold often continues down
// ============================================================================
const fadeConservativeBot = new FadeBot({
  initialBalance: 2000,
  positionSizePercent: 3,
  leverage: 3,
  initialStopLossPercent: 12,
  trailTriggerPercent: 8,
  trailStepPercent: 6,
  level1LockPercent: 2,
  maxOpenPositions: 10,
}, 'fade-conservative');

const fadeStandardBot = new FadeBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 5,
  initialStopLossPercent: 12,
  trailTriggerPercent: 8,
  trailStepPercent: 6,
  level1LockPercent: 2,
  maxOpenPositions: 10,
}, 'fade-standard');

const fadeAggressiveBot = new FadeBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 5,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 8,
  level1LockPercent: 3,
  maxOpenPositions: 10,
}, 'fade-aggressive');

// Collect all fade bots
const fadeBots = new Map([
  ['fade-conservative', fadeConservativeBot],
  ['fade-standard', fadeStandardBot],
  ['fade-aggressive', fadeAggressiveBot],
]);

// ============================================================================
// SPOT REGIME BOTS - Contrarian quadrant-based trading (Focus Mode automation)
// Based on backtesting: Only trades in profitable quadrants (NEU+BEAR, BEAR+BEAR)
// NEVER trades in BEAR+BULL (bull trap - 0% win rate)
// ============================================================================
const spotRegimeStandard = createStandardFilterBot();
const spotRegimeStrict = createStrictFilterBot();
const spotRegimeLoose = createLooseFilterBot();
const spotRegimeContrarian = createContrarianOnlyBot();

// Collect all spot regime bots
const spotRegimeBots = new Map<string, SpotRegimeBot>([
  ['spot-standard', spotRegimeStandard],
  ['spot-strict', spotRegimeStrict],
  ['spot-loose', spotRegimeLoose],
  ['spot-contrarian', spotRegimeContrarian],
]);

// ============================================================================
// FOCUS MODE SHADOW BOTS - Simulates manual leveraged trading using Focus Mode
// These mirror how you trade on MEXC Futures: leverage, quadrant rules, trailing stops
// ============================================================================
const focusShadowBots = new Map<string, FocusModeShadowBot>([
  // BASELINE: Standard Focus Mode rules, max 5 positions
  ['focus-baseline', createFocusBaselineBot()],

  // CONFLICT_CLOSE: Closes positions when regime becomes conflicting
  ['focus-conflict', createConflictCloseBot()],

  // EXCELLENT_OVERFLOW: Allows +2 extra positions for "excellent" setups
  ['focus-excellent', createExcellentOverflowBot()],

  // HYBRID: Combines conflict-close + excellent-overflow
  ['focus-hybrid', createHybridBot()],

  // AGGRESSIVE: 1.5x leverage multiplier, tighter stops, more positions
  ['focus-aggressive', createFocusAggressiveBot()],

  // CONSERVATIVE: 0.75x leverage, wider stops, stricter entry rules
  ['focus-conservative', createFocusConservativeBot()],

  // KELLY_SIZING REMOVED - see data/archived/KELLY_SIZING_EXPERIMENT.md

  // CONTRARIAN_ONLY: Only trades in NEU+BEAR and BEAR+BEAR quadrants
  ['focus-contrarian-only', createFocusContrarianBot()],

  // EUPHORIA_FADE: Fades BULL+BULL (short when market is euphoric) - testing "high win rate" claim
  ['focus-euphoria-fade', createEuphoriaFadeBot()],

  // BULL_DIP: Buys BULL+BEAR (dips in macro bull market)
  ['focus-bull-dip', createBullDipBuyerBot()],

  // FULL_QUADRANT: Trades ALL quadrants except BEAR+BULL - comprehensive data collection
  ['focus-full-quadrant', createFullQuadrantBot()],
]);

// Experimental Shadow Bots - Testing different bias system combinations
// See src/experimental-shadow-bots.ts for experiment details
const experimentalBots = createExperimentalBots(2000);

// ============================================================================
// MEXC MIRROR TRACKER
// Tracks paper positions with EXACT same params as live MEXC trades
// Enables true 1:1 comparison between paper and live performance
// ============================================================================
interface MexcMirrorPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  leverage: number;
  marginUsed: number;
  notionalSize: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailTriggerPct: number;
  trailStepPct: number;
  // Tracking
  highestPnlPct: number;
  trailActivated: boolean;
  currentStopPrice: number;
  // Metadata
  sourceBotId: string;
  sourceOrderId: string;
}

interface MexcMirrorClosedPosition extends MexcMirrorPosition {
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  realizedPnl: number;
  realizedPnlPct: number;
}

class MexcMirrorTracker {
  private positions = new Map<string, MexcMirrorPosition>();
  private closedPositions: MexcMirrorClosedPosition[] = [];
  private feePercent = 0.04;  // MEXC taker fee

  // Create a mirror position when MEXC executes
  openPosition(params: {
    symbol: string;
    direction: 'long' | 'short';
    entryPrice: number;
    leverage: number;
    marginUsed: number;
    stopLossPrice: number;
    takeProfitPrice: number;
    trailTriggerPct: number;
    trailStepPct: number;
    sourceBotId: string;
    sourceOrderId: string;
  }): MexcMirrorPosition {
    const pos: MexcMirrorPosition = {
      id: `mirror-${params.symbol}-${Date.now()}`,
      symbol: params.symbol,
      direction: params.direction,
      entryPrice: params.entryPrice,
      entryTime: Date.now(),
      leverage: params.leverage,
      marginUsed: params.marginUsed,
      notionalSize: params.marginUsed * params.leverage,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
      trailTriggerPct: params.trailTriggerPct,
      trailStepPct: params.trailStepPct,
      highestPnlPct: 0,
      trailActivated: false,
      currentStopPrice: params.stopLossPrice,
      sourceBotId: params.sourceBotId,
      sourceOrderId: params.sourceOrderId,
    };
    this.positions.set(params.symbol, pos);
    console.log(`[MIRROR] Opened ${params.direction} ${params.symbol} @ $${params.entryPrice} | ${params.leverage}x | SL: $${params.stopLossPrice.toFixed(6)}`);
    return pos;
  }

  // Update prices and check for exits
  updatePrices(priceMap: Map<string, number>): MexcMirrorClosedPosition[] {
    const closed: MexcMirrorClosedPosition[] = [];

    for (const [symbol, pos] of this.positions) {
      const currentPrice = priceMap.get(symbol.replace('_USDT', 'USDT'));
      if (!currentPrice) continue;

      // Calculate current PnL%
      const priceDiff = pos.direction === 'long'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice;
      const roePct = priceDiff * pos.leverage * 100;

      // Track peak
      if (roePct > pos.highestPnlPct) {
        pos.highestPnlPct = roePct;
      }

      // Check trail activation
      if (!pos.trailActivated && roePct >= pos.trailTriggerPct) {
        pos.trailActivated = true;
        // Lock in some profit via trailing stop
        const lockPct = pos.trailTriggerPct - pos.trailStepPct;
        const lockPriceDistance = (lockPct / 100) / pos.leverage;
        pos.currentStopPrice = pos.direction === 'long'
          ? pos.entryPrice * (1 + lockPriceDistance)
          : pos.entryPrice * (1 - lockPriceDistance);
        console.log(`[MIRROR] Trail activated for ${symbol} | New SL: $${pos.currentStopPrice.toFixed(6)} (locking ${lockPct}% ROE)`);
      }

      // Update trailing stop if activated and price improved
      if (pos.trailActivated && roePct > pos.trailTriggerPct) {
        const newLockPct = roePct - pos.trailStepPct;
        const newLockPriceDistance = (newLockPct / 100) / pos.leverage;
        const newStopPrice = pos.direction === 'long'
          ? pos.entryPrice * (1 + newLockPriceDistance)
          : pos.entryPrice * (1 - newLockPriceDistance);

        const shouldUpdate = pos.direction === 'long'
          ? newStopPrice > pos.currentStopPrice
          : newStopPrice < pos.currentStopPrice;

        if (shouldUpdate) {
          pos.currentStopPrice = newStopPrice;
        }
      }

      // Check for stop loss hit
      const slHit = pos.direction === 'long'
        ? currentPrice <= pos.currentStopPrice
        : currentPrice >= pos.currentStopPrice;

      if (slHit) {
        const exitReason = pos.trailActivated ? 'trailing_stop' : 'stop_loss';
        closed.push(this.closePosition(symbol, pos.currentStopPrice, exitReason));
      }

      // Check for take profit hit (if set)
      if (pos.takeProfitPrice > 0) {
        const tpHit = pos.direction === 'long'
          ? currentPrice >= pos.takeProfitPrice
          : currentPrice <= pos.takeProfitPrice;

        if (tpHit) {
          closed.push(this.closePosition(symbol, pos.takeProfitPrice, 'take_profit'));
        }
      }
    }

    return closed;
  }

  // Close a position
  closePosition(symbol: string, exitPrice: number, exitReason: string): MexcMirrorClosedPosition {
    const pos = this.positions.get(symbol);
    if (!pos) throw new Error(`No mirror position for ${symbol}`);

    const priceDiff = pos.direction === 'long'
      ? (exitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - exitPrice) / pos.entryPrice;
    const roePct = priceDiff * pos.leverage * 100;
    const grossPnl = pos.marginUsed * (roePct / 100);
    const fees = pos.notionalSize * (this.feePercent / 100) * 2;  // Entry + exit
    const realizedPnl = grossPnl - fees;

    const closedPos: MexcMirrorClosedPosition = {
      ...pos,
      exitPrice,
      exitTime: Date.now(),
      exitReason,
      realizedPnl,
      realizedPnlPct: roePct - (fees / pos.marginUsed * 100),
    };

    this.positions.delete(symbol);
    this.closedPositions.push(closedPos);
    console.log(`[MIRROR] Closed ${symbol} ${exitReason} | PnL: $${realizedPnl.toFixed(2)} (${roePct.toFixed(1)}% ROE)`);

    return closedPos;
  }

  // Force close when MEXC position closes (SL fired on exchange)
  forceClose(symbol: string, exitPrice: number, exitReason: string): MexcMirrorClosedPosition | null {
    if (!this.positions.has(symbol)) return null;
    return this.closePosition(symbol, exitPrice, exitReason);
  }

  getPosition(symbol: string): MexcMirrorPosition | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): MexcMirrorPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): MexcMirrorClosedPosition[] {
    return this.closedPositions;
  }

  getStats(): { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: string } {
    const wins = this.closedPositions.filter(p => p.realizedPnl > 0).length;
    const losses = this.closedPositions.filter(p => p.realizedPnl <= 0).length;
    const totalPnl = this.closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    return {
      totalTrades: this.closedPositions.length,
      wins,
      losses,
      totalPnl,
      winRate: this.closedPositions.length > 0 ? ((wins / this.closedPositions.length) * 100).toFixed(1) : '0',
    };
  }
}

const mexcMirrorTracker = new MexcMirrorTracker();

// GP V2 Detector (loosened thresholds)
const gpDetectorV2 = new GoldenPocketDetectorV2({
  minImpulsePercent: 4,      // V1: 5%
  minRelativeVolume: 1.5,    // V1: 2x
});

const notifier = new NotificationManager({
  enabled: true,  // Will be controlled by serverSettings.notificationsEnabled
  sound: true,    // Will be controlled by serverSettings.soundEnabled
  soundName: 'Glass',
  onlyTriggered: true,
});

// Helper to check if notifications are enabled
function isNotificationsEnabled(): boolean {
  return serverSettings.notificationsEnabled;
}

function isSoundEnabled(): boolean {
  return serverSettings.soundEnabled;
}

function isBotNotificationEnabled(botId: string): boolean {
  if (!serverSettings.notificationsEnabled) return false;
  return serverSettings.botNotifications[botId] !== false;
}

/**
 * Update the initial balance for all trading bots
 * Called when user syncs their real MEXC investment amount
 */
function updateAllBotsInitialBalance(amount: number): void {
  console.log(`[INVESTMENT] Updating all bots to use $${amount} initial balance`);

  // Core bots
  fixedTPBot.setInitialBalance(amount);
  fixedBreakevenBot.setInitialBalance(amount);
  trailing1pctBot.setInitialBalance(amount);
  trailing10pct10xBot.setInitialBalance(amount);
  trailing10pct20xBot.setInitialBalance(amount);
  trailWideBot.setInitialBalance(amount);
  confluenceBot.setInitialBalance(amount);
  btcExtremeBot.setInitialBalance(amount);
  btcTrendBot.setInitialBalance(amount);
  trendOverrideBot.setInitialBalance(amount);
  trendFlipBot.setInitialBalance(amount);
  combinedStrategyBot.setInitialBalance(amount);

  // Shadow bots
  for (const { bot } of shadowBots) {
    bot.setInitialBalance(amount);
  }

  // Timeframe shadow bots
  for (const { bot } of timeframeShadowBots) {
    bot.setInitialBalance(amount);
  }

  // GP shadow bots
  for (const { bot } of gpShadowBots) {
    bot.setInitialBalance(amount);
  }

  // Golden Pocket bots
  for (const [, bot] of goldenPocketBots) {
    bot.setInitialBalance(amount);
  }

  // Golden Pocket V2 bots
  for (const [, bot] of goldenPocketBotsV2) {
    bot.setInitialBalance(amount);
  }

  // Fade bots
  for (const [, bot] of fadeBots) {
    bot.setInitialBalance(amount);
  }

  // MEXC simulation bots
  for (const [, bot] of mexcSimBots) {
    bot.setInitialBalance(amount);
  }

  // Focus Mode Shadow bots
  for (const [, bot] of focusShadowBots) {
    bot.setInitialBalance(amount);
  }

  // Experimental bots (exp-bb-sysB, etc.)
  for (const [, bot] of experimentalBots) {
    bot.setInitialBalance(amount);
  }

  // Save the setting
  serverSettings.investmentAmount = amount;
  saveServerSettings();

  console.log(`[INVESTMENT] All bots updated to $${amount} initial balance`);
}

/**
 * POWERFUL desktop notification when GP bots open positions
 * These are rare, high-signal events that warrant attention
 */
async function notifyGPPositionOpened(
  botId: string,
  position: any,
  setup: any,
  isV2: boolean
): Promise<void> {
  // Check if notifications are enabled (global + per-bot)
  if (!isBotNotificationEnabled(botId)) {
    return;
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const ticker = position.symbol.replace('USDT', '');
  const dir = position.direction.toUpperCase();
  const version = isV2 ? 'V2' : 'V1';
  const botLabel = botId.replace('gp-', '').toUpperCase();
  const stateIcon = setup.state === 'deep_extreme' ? '🔥' : '🎯';
  const dirIcon = position.direction === 'long' ? '🟢' : '🔴';

  // Format entry price
  const entryPrice = position.entryPrice < 1
    ? position.entryPrice.toFixed(6)
    : position.entryPrice.toFixed(2);

  // Format market cap
  let mcap = '';
  if (setup.marketCap) {
    if (setup.marketCap >= 1_000_000_000) {
      mcap = `$${(setup.marketCap / 1_000_000_000).toFixed(1)}B`;
    } else if (setup.marketCap >= 1_000_000) {
      mcap = `$${(setup.marketCap / 1_000_000).toFixed(0)}M`;
    }
  }

  const title = `${stateIcon}${dirIcon} GP ${version} TRADE: ${ticker} ${dir}`;
  const subtitle = `Bot: ${botLabel} | ${setup.timeframe} | MCap: ${mcap}`;
  const message = `Entry: $${entryPrice} | RSI: ${setup.currentRSI?.toFixed(1) || 'N/A'}`;

  // Use terminal-notifier with sticky sound (Submarine is more attention-grabbing)
  const escapeShell = (str: string) => str.replace(/'/g, "'\\\\''" );

  try {
    // Primary: terminal-notifier (macOS)
    const cmd = `terminal-notifier -title '${escapeShell(title)}' -subtitle '${escapeShell(subtitle)}' -message '${escapeShell(message)}' -sound Submarine -group 'gp-trade'`;
    await execAsync(cmd);
  } catch {
    // Fallback: osascript
    try {
      const escapeAppleScript = (str: string) => str.replace(/"/g, '\\\\"');
      const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}" sound name "Submarine"`;
      await execAsync(`osascript -e '${script}'`);
    } catch {
      console.error('[GP-NOTIFY] Desktop notification failed');
    }
  }

  // Also log prominently
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚨 GP ${version} POSITION OPENED 🚨`);
  console.log(`   ${ticker} ${dir} | Bot: ${botLabel}`);
  console.log(`   Entry: $${entryPrice} | RSI: ${setup.currentRSI?.toFixed(1)}`);
  console.log(`   State: ${setup.state} | TF: ${setup.timeframe}`);
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * Reset all bots to initial state (closes positions, resets balances)
 * Records are preserved in data/trades/ for analysis
 */
function resetAllBots(): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('🔄 DAILY RESET: Resetting all bot states...');
  console.log(`${'='.repeat(60)}`);

  // Standard bots
  fixedTPBot.reset();
  fixedBreakevenBot.reset();
  trailing1pctBot.reset();
  trailing10pct10xBot.reset();
  trailing10pct20xBot.reset();
  trailWideBot.reset();
  confluenceBot.reset();
  btcExtremeBot.reset();
  btcTrendBot.reset();
  trendOverrideBot.reset();
  trendFlipBot.reset();

  // Shadow bots (stop loss variants)
  for (const { id, bot } of shadowBots) {
    bot.reset();
    console.log(`  ✓ Reset ${id}`);
  }

  // Timeframe strategy shadow bots (5m fade vs 4H normal testing)
  for (const { id, bot } of timeframeShadowBots) {
    bot.reset();
    console.log(`  ✓ Reset ${id}`);
  }

  // Combined strategy bot (4H normal + 5m fade)
  combinedStrategyBot.reset();
  console.log(`  ✓ Reset ${combinedStrategyBot.getBotId()}`);

  // GP shadow bots (Golden Pocket RSI Zone strategy)
  for (const { id, bot } of gpShadowBots) {
    bot.reset();
    console.log(`  ✓ Reset ${id}`);
  }

  // MEXC simulation bots
  for (const [botId, bot] of mexcSimBots) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Golden Pocket V1 bots
  for (const [botId, bot] of goldenPocketBots) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Golden Pocket V2 bots
  for (const [botId, bot] of goldenPocketBotsV2) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // BTC Bias V2 bots
  for (const [botId, bot] of btcBiasBotsV2) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Fade bots (contrarian strategy)
  for (const [botId, bot] of fadeBots) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Focus Mode Shadow bots
  for (const [botId, bot] of focusShadowBots) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Experimental Shadow bots
  for (const [botId, bot] of experimentalBots) {
    bot.reset();
    console.log(`  ✓ Reset ${botId}`);
  }

  // Update last reset date
  serverSettings.lastResetDate = getCurrentDateString();
  saveServerSettings();

  console.log(`✅ All bots reset to $${serverSettings.investmentAmount} starting balance`);
  console.log(`📊 Trade history preserved in data/trades/`);
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * Check if daily reset is needed (runs at start and periodically)
 */
function checkDailyReset(): void {
  if (!serverSettings.dailyResetEnabled) {
    return;
  }

  const today = getCurrentDateString();
  if (serverSettings.lastResetDate !== today) {
    console.log(`[DAILY RESET] New day detected: ${serverSettings.lastResetDate} -> ${today}`);
    resetAllBots();
  }
}

// State
let currentStatus = 'Starting...';
let scanProgress = { completed: 0, total: 0, phase: '' };
let currentBtcBias: 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short' = 'neutral';
let lastBtcPrice: number = 0;
let lastBtcRsiData: Record<string, number> = {};

// SSE broadcast helper
function broadcast(event: string, data: any) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
}

// Event handlers
async function handleNewSetup(setup: BackburnerSetup) {
  // Update momentum exhaustion tracker (for higher timeframe filtering)
  updateMomentumExhaustion(setup);

  // Log signal to Turso
  getDataPersistence().logSignal(setup, 'new');
  if (setup.state === 'triggered') {
    getDataPersistence().logSignal(setup, 'triggered');
  } else if (setup.state === 'deep_extreme') {
    getDataPersistence().logSignal(setup, 'deep_extreme');
  }

  // FILTER: Skip setups that historically lose money (1h timeframe, contrarian 5m)
  const passesFilter = shouldTradeSetup(setup, currentBtcBias);

  // Only open positions for main bots if setup passes filter
  let fixedPosition = null;
  let fixedBEPosition = null;
  let trail1pctPosition = null;
  let trail10pct10xPosition = null;
  let trail10pct20xPosition = null;
  let trailWidePosition = null;
  let confluencePosition = null;

  if (passesFilter) {
    fixedPosition = fixedTPBot.openPosition(setup);
    fixedBEPosition = fixedBreakevenBot.openPosition(setup);
    trail1pctPosition = trailing1pctBot.openPosition(setup);
    trail10pct10xPosition = trailing10pct10xBot.openPosition(setup);
    trail10pct20xPosition = trailing10pct20xBot.openPosition(setup);
    trailWidePosition = trailWideBot.openPosition(setup);
    confluencePosition = confluenceBot.openPosition(setup);

    // Shadow bots - open positions in parallel for A/B testing stop levels
    for (const { bot } of shadowBots) {
      bot.openPosition(setup);
    }
  } else {
    // Log skipped setups for debugging
    console.log(`[FILTER] Skipped ${setup.symbol} ${setup.timeframe} ${setup.direction} (BTC bias: ${currentBtcBias})`);
  }

  // Timeframe strategy shadow bots - ALWAYS try to open (they filter internally by timeframe)
  // These test: 5m fade vs 5m normal, 4H normal vs 4H fade
  for (const { bot } of timeframeShadowBots) {
    bot.openPosition(setup);
  }

  // Combined strategy bot - processes both 4H (for bias) and 5m (for entry) signals
  combinedStrategyBot.processSetup(setup);

  // GP shadow bots - ALWAYS try to open (they filter by RSI zone internally)
  for (const { bot } of gpShadowBots) {
    bot.openPosition(setup);
  }

  // Get active timeframes for this symbol to check for confluence
  const allSetups = screener.getAllSetups();
  const symbolSetups = allSetups.filter(s =>
    s.symbol === setup.symbol &&
    s.marketType === setup.marketType &&
    s.direction === setup.direction &&
    s.state !== 'played_out'
  );
  const activeTimeframes = symbolSetups.map(s => s.timeframe);

  // Try trend override/flip bots (contrarian strategies - only if NOT 1h timeframe)
  // Note: These are intentionally contrarian but still skip 1h due to poor performance
  const currentPrice = await getCurrentPrice(setup.symbol);
  if (currentPrice && ALLOWED_TIMEFRAMES.includes(setup.timeframe)) {
    const overridePosition = trendOverrideBot.processSetup(setup, currentBtcBias, activeTimeframes, currentPrice);
    const flipPosition = trendFlipBot.processSetup(setup, currentBtcBias, activeTimeframes, currentPrice);

    if (overridePosition) {
      broadcast('position_opened', { bot: 'trendOverride', position: overridePosition });
    }
    if (flipPosition) {
      broadcast('position_opened', { bot: 'trendFlip', position: flipPosition });
    }
  }

  if (fixedPosition) {
    broadcast('position_opened', { bot: 'fixedTP', position: fixedPosition });
  }
  if (trail1pctPosition) {
    broadcast('position_opened', { bot: 'trailing1pct', position: trail1pctPosition });
  }
  if (trail10pct10xPosition) {
    broadcast('position_opened', { bot: 'trailing10pct10x', position: trail10pct10xPosition });
  }
  if (trail10pct20xPosition) {
    broadcast('position_opened', { bot: 'trailing10pct20x', position: trail10pct20xPosition });
  }
  if (trailWidePosition) {
    broadcast('position_opened', { bot: 'trailWide', position: trailWidePosition });
  }
  if (confluencePosition) {
    broadcast('position_opened', { bot: 'confluence', position: confluencePosition });
  }

  // Try MEXC simulation bots (only if setup passes filter)
  if (passesFilter) {
    for (const [botId, bot] of mexcSimBots) {
      const position = bot.openPosition(setup);
      if (position) {
        broadcast('position_opened', { bot: botId, position });
      }
    }
  }

  // Try all Golden Pocket bots
  // V2 CHANGE: GP bots now IGNORE the HTF/RSI filters - they trade any triggered/deep_extreme
  // The GP strategy has its own entry criteria (fib levels, RSI extreme zones)
  const isGPSetup = 'fibLevels' in setup && 'tp1Price' in setup && 'stopPrice' in setup;
  const isGPV2Setup = isGPSetup && 'isV2' in setup;

  // GP bots only need: valid timeframe + actionable state (triggered/deep_extreme)
  const gpTimeframeOk = ALLOWED_TIMEFRAMES.includes(setup.timeframe);
  const gpStateOk = setup.state === 'triggered' || setup.state === 'deep_extreme';

  if (isGPSetup && gpTimeframeOk && gpStateOk) {
    console.log(`[GP-BOT] GP setup received: ${setup.symbol} ${setup.direction} ${setup.state} - attempting trades (HTF/RSI filters bypassed)`);

    // V1 GP bots (strict thresholds) - only process V1 setups
    if (!isGPV2Setup) {
      for (const [botId, bot] of goldenPocketBots) {
        const position = bot.openPosition(setup);
        if (position) {
          console.log(`[GP-BOT:${botId}] OPENED: ${position.symbol} ${position.direction}`);
          broadcast('position_opened', { bot: botId, position });
          // POWERFUL desktop notification for GP bot position opens (rare, high-signal)
          await notifyGPPositionOpened(botId, position, setup, false);
        }
      }
    }

    // V2 GP bots (loose thresholds) - only process V2 setups
    if (isGPV2Setup) {
      for (const [botId, bot] of goldenPocketBotsV2) {
        const position = bot.openPosition(setup);
        if (position) {
          console.log(`[GP2-BOT:${botId}] OPENED: ${position.symbol} ${position.direction}`);
          broadcast('position_opened', { bot: botId, position });
          // POWERFUL desktop notification for GP V2 bot position opens
          await notifyGPPositionOpened(botId, position, setup, true);
        }
      }
    }

    // EXPERIMENTAL GP BOTS: Process GP setups through experimental bots with bias/regime filters
    for (const [botId, bot] of experimentalBots) {
      // Only process GP setups for GP experimental bots (start with 'exp-gp-')
      if (botId.startsWith('exp-gp-')) {
        const result = bot.processGoldenPocketSetup(setup as any, setup.currentPrice, currentBtcBias);
        if (result.action === 'open' && result.position) {
          console.log(`[EXP:${botId}] OPENED GP ${result.position.direction.toUpperCase()} ${setup.symbol} | Reason: ${result.reason}`);
          broadcast('position_opened', { bot: botId, position: result.position });

          // Queue for MEXC live execution if this experimental bot is selected
          if (serverSettings.mexcSelectedBots.includes(botId)) {
            addToMexcQueue(
              botId,
              setup.symbol,
              result.position.direction,
              serverSettings.mexcPositionSizeUsd,
              result.position.leverage,
              result.position.stopLoss,
              result.position.takeProfit,
              undefined,
              result.position.entryPrice
            );
          }
        }
      }
    }
  } else if (isGPSetup && !gpTimeframeOk) {
    console.log(`[GP-BOT] Skipped ${setup.symbol} ${setup.timeframe} - timeframe not allowed`);
  }

  // FADE BOTS: Contrarian strategy - take OPPOSITE direction of RSI signals
  // These bots trade ANY triggered/deep_extreme signal, futures only
  if (setup.marketType === 'futures' && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    for (const [botId, bot] of fadeBots) {
      const position = bot.openPosition(setup);
      if (position) {
        console.log(`[FADE:${botId}] OPENED ${position.direction.toUpperCase()} ${setup.symbol} (signal was ${setup.direction})`);
        broadcast('position_opened', { bot: botId, position });
      }
    }
  }

  // SPOT REGIME BOTS: Contrarian quadrant-based trading (Focus Mode automation)
  // These bots use the macro/micro regime detection to only trade in profitable quadrants
  // They process ALL signals to build regime history, but only open positions in good quadrants
  if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
    // Convert setup to Signal format for spot regime bots
    const regimeSignal = {
      timestamp: setup.triggeredAt || Date.now(),
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
      rsi: setup.currentRSI,
      price: setup.currentPrice,
      entryPrice: setup.entryPrice || setup.currentPrice,
    };

    for (const [botId, bot] of spotRegimeBots) {
      const result = bot.processSignal(regimeSignal);
      if (result.action === 'open' && result.position) {
        console.log(`[REGIME:${botId}] OPENED LONG ${setup.symbol} in ${result.position.quadrant} quadrant`);
        broadcast('position_opened', { bot: botId, position: result.position });

        // Log to trade events using the position object format
        const dataPersistence = getDataPersistence();
        const positionForLog = {
          id: result.position.positionId,
          symbol: setup.symbol,
          direction: 'long' as const,
          timeframe: setup.timeframe,
          marketType: 'spot' as const,
          entryPrice: result.position.entryPriceWithSlippage,
          entryTime: result.position.entryTime,
          marginUsed: result.position.dollarValue,
          notionalSize: result.position.dollarValue,
          leverage: 1,
          takeProfitPrice: 0,
          stopLossPrice: result.position.stopLoss,
        };
        dataPersistence.logTradeOpen(botId, positionForLog as any, setup, getExecutionModeForBot(botId));
      } else if (result.action === 'skip') {
        // Still log skipped signals for debugging regime detection
        // console.log(`[REGIME:${botId}] Skipped ${setup.symbol}: ${result.reason}`);
      }
    }
  }

  // FOCUS MODE SHADOW BOTS: Simulates manual leveraged trading using Focus Mode guidance
  // These bots mirror how you trade on MEXC Futures with quadrant rules and trailing stops
  if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
    // Use the SAME calculateSmartTradeSetup function that Focus Mode dashboard uses
    // This gives us: suggestedLeverage, stopLossPrice, takeProfitPrice based on S/R levels
    const entryPrice = setup.entryPrice || setup.currentPrice;
    const direction = setup.direction.toUpperCase() as 'LONG' | 'SHORT';
    const smartSetup = calculateSmartTradeSetup(entryPrice, direction, setup.symbol, 2000);

    // Extract values from smart setup (same as Focus Mode card shows)
    const suggestedLeverage = smartSetup.suggestedLeverage;
    const stopLossPrice = smartSetup.stopLossPrice;
    const takeProfitPrice = smartSetup.takeProfitPrice;
    const suggestedPositionPct = smartSetup.suggestedPositionPct;
    const suggestedPositionSize = 2000 * (suggestedPositionPct / 100); // Based on $2000 balance

    // Quality assessment based on R:R ratio (from smart setup), impulse strength, and RSI
    // R:R >= 2 is excellent, >= 1.5 is good, >= 1 is ok, < 1 is unfavorable
    const rrBonus = smartSetup.riskRewardRatio >= 2 ? 20 :
                    smartSetup.riskRewardRatio >= 1.5 ? 10 :
                    smartSetup.riskRewardRatio >= 1 ? 0 : -20;
    const impulseStrength = setup.impulsePercentMove || 0;
    const rsiExtreme = setup.direction === 'long' ? (30 - setup.currentRSI) : (setup.currentRSI - 70);
    let qualityScore = 50 + rrBonus + (impulseStrength * 2) + (Math.max(0, rsiExtreme));
    qualityScore = Math.min(100, Math.max(0, qualityScore));

    // Quality tier matches Focus Mode card labels (EXCELLENT, GOOD, OK, UNFAVORABLE)
    let quality: SetupQuality = 'marginal';
    if (qualityScore >= 80) quality = 'excellent';
    else if (qualityScore >= 65) quality = 'good';
    else if (qualityScore >= 50) quality = 'marginal';
    else quality = 'skip';

    // Get current regime (reuse from spot regime detection)
    const timestamp = setup.triggeredAt || Date.now();
    const macroRegime = 'neutral' as const;  // Will be calculated by bot's internal detector
    const microRegime = 'neutral' as const;
    const quadrant: Quadrant = 'NEU+NEU';  // Will be calculated by bot's internal detector

    const focusSignal: FocusModeSignal = {
      timestamp,
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
      rsi: setup.currentRSI,
      currentPrice: setup.currentPrice,
      entryPrice,
      suggestedLeverage,
      suggestedPositionSize,
      suggestedStopLoss: stopLossPrice,
      suggestedTakeProfit: takeProfitPrice,
      trailTriggerPercent: 10,
      macroRegime,
      microRegime,
      quadrant,
      quality,
      qualityScore,
      impulsePercent: setup.impulsePercentMove || 0,
    };

    for (const [botId, bot] of focusShadowBots) {
      const result = bot.processSignal(focusSignal);
      if (result.action === 'open' && result.position) {
        console.log(`[FOCUS:${botId}] OPENED ${result.position.direction.toUpperCase()} ${setup.symbol} | Quality: ${quality} (${qualityScore.toFixed(0)}) | Lev: ${result.position.leverage}x`);
        broadcast('position_opened', { bot: botId, position: result.position });

        // Log to trade events
        const dataPersistence = getDataPersistence();
        const positionForLog = {
          id: result.position.positionId,
          symbol: setup.symbol,
          direction: result.position.direction,
          timeframe: setup.timeframe,
          marketType: 'futures' as const,
          entryPrice: result.position.entryPrice,
          entryTime: result.position.entryTime,
          marginUsed: result.position.marginUsed,
          notionalSize: result.position.notionalSize,
          leverage: result.position.leverage,
          takeProfitPrice: result.position.takeProfit,
          stopLossPrice: result.position.stopLoss,
          // Focus Mode specific fields for regime analysis
          entryQuadrant: result.position.entryQuadrant,
          entryQuality: result.position.entryQuality,
        };
        dataPersistence.logTradeOpen(botId, positionForLog as any, setup, getExecutionModeForBot(botId));

        // Queue for MEXC live execution if this bot is selected
        if (serverSettings.mexcSelectedBots.includes(botId)) {
          addToMexcQueue(
            botId,
            setup.symbol,
            result.position.direction,
            serverSettings.mexcPositionSizeUsd,
            result.position.leverage,
            result.position.stopLoss,
            result.position.takeProfit,
            result.position.entryQuality,
            result.position.entryPrice
          );
        }
      }
    }
  }

  // EXPERIMENTAL BOTS: Feed ALL signals to regime detectors and process Backburner setups
  if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
    // Feed signal to all experimental bots for regime detection
    const expSignal = {
      timestamp: setup.triggeredAt || Date.now(),
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
    };

    for (const [botId, bot] of experimentalBots) {
      bot.feedSignal(expSignal);

      // Only process Backburner setups (not GP) here - BB bots start with 'exp-bb-'
      // CRITICAL: Apply same timeframe filter as main bots — exp bots must NOT bypass it
      if (botId.startsWith('exp-bb-')) {
        if (!ALLOWED_TIMEFRAMES.includes(setup.timeframe)) {
          console.log(`[EXP:${botId}] Skip ${setup.symbol} ${setup.timeframe} — timeframe not allowed`);
          continue;
        }
        const result = bot.processBackburnerSetup(setup, setup.currentPrice, currentBtcBias);
        logBotDecision(botId, setup.symbol, result.action, `${setup.direction} ${setup.timeframe} RSI=${setup.currentRSI?.toFixed(1)} | ${result.reason}`);
        if (result.action === 'open' && result.position) {
          console.log(`[EXP:${botId}] OPENED ${result.position.direction.toUpperCase()} ${setup.symbol} | Reason: ${result.reason}`);
          broadcast('position_opened', { bot: botId, position: result.position });

          // Queue for MEXC live execution if this experimental bot is selected
          if (serverSettings.mexcSelectedBots.includes(botId)) {
            logBotDecision(botId, setup.symbol, 'queued_for_mexc', `${result.position.direction} $${serverSettings.mexcPositionSizeUsd} ${result.position.leverage}x | SL: ${result.position.stopLoss} TP: ${result.position.takeProfit}`);
            addToMexcQueue(
              botId,
              setup.symbol,
              result.position.direction,
              serverSettings.mexcPositionSizeUsd,
              result.position.leverage,
              result.position.stopLoss,
              result.position.takeProfit,
              undefined,
              result.position.entryPrice
            );
          }
        }
      }
    }
  }

  // Send notification (works for both regular and GP setups)
  if (isNotificationsEnabled()) {
    await notifier.notifyNewSetup(setup);
  }

  // Extra notification for GP triggered setups
  if (isGPSetup && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    const gpSetup = setup as any;
    const ticker = setup.symbol.replace('USDT', '');
    const dir = setup.direction.toUpperCase();
    const stateIcon = setup.state === 'deep_extreme' ? '🔥' : '🎯';
    const retrace = (gpSetup.retracementPercent * 100).toFixed(1);
    console.log(`[GP ALERT] ${stateIcon} ${ticker} ${dir} @ ${retrace}% retracement`);
  }

  // Broadcast setup
  broadcast('new_setup', setup);
  broadcastState();
}

async function handleSetupUpdated(setup: BackburnerSetup) {
  // Update momentum exhaustion tracker (for higher timeframe filtering)
  updateMomentumExhaustion(setup);

  // Log state changes to Turso
  getDataPersistence().logSignal(setup, 'updated');
  if (setup.state === 'triggered') {
    getDataPersistence().logSignal(setup, 'triggered');
  } else if (setup.state === 'deep_extreme') {
    getDataPersistence().logSignal(setup, 'deep_extreme');
  } else if (setup.state === 'played_out') {
    getDataPersistence().logSignal(setup, 'played_out');
  }

  // First try to update existing positions (always update regardless of filter)
  let fixedPosition = fixedTPBot.updatePosition(setup);
  let fixedBEPosition = fixedBreakevenBot.updatePosition(setup);
  let trail1pctPosition = trailing1pctBot.updatePosition(setup);
  let trail10pct10xPosition = trailing10pct10xBot.updatePosition(setup);
  let trail10pct20xPosition = trailing10pct20xBot.updatePosition(setup);
  let trailWidePosition = trailWideBot.updatePosition(setup);
  let confluencePosition = confluenceBot.updatePosition(setup);

  // Update shadow bots (always update regardless of filter)
  for (const { bot } of shadowBots) {
    bot.updatePosition(setup);
  }

  // Update timeframe strategy shadow bots
  for (const { bot } of timeframeShadowBots) {
    bot.updatePosition(setup);
  }

  // Update combined strategy bot positions
  combinedStrategyBot.updatePosition(setup);

  // Update GP shadow bot positions
  for (const { bot } of gpShadowBots) {
    bot.updatePosition(setup);
  }

  // FILTER: Check if setup passes timeframe/BTC trend filter before opening NEW positions
  const passesFilter = shouldTradeSetup(setup, currentBtcBias);

  // If no position exists and setup just became triggered/deep_extreme, try to open
  // This handles the watching -> triggered state transition
  // ONLY open if setup passes filter
  let newlyOpened = false;
  if (passesFilter && !fixedPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    fixedPosition = fixedTPBot.openPosition(setup);
    if (fixedPosition) {
      broadcast('position_opened', { bot: 'fixedTP', position: fixedPosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !fixedBEPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    fixedBEPosition = fixedBreakevenBot.openPosition(setup);
    if (fixedBEPosition) {
      broadcast('position_opened', { bot: 'fixedBE', position: fixedBEPosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !trail1pctPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail1pctPosition = trailing1pctBot.openPosition(setup);
    if (trail1pctPosition) {
      broadcast('position_opened', { bot: 'trailing1pct', position: trail1pctPosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !trail10pct10xPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail10pct10xPosition = trailing10pct10xBot.openPosition(setup);
    if (trail10pct10xPosition) {
      broadcast('position_opened', { bot: 'trailing10pct10x', position: trail10pct10xPosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !trail10pct20xPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail10pct20xPosition = trailing10pct20xBot.openPosition(setup);
    if (trail10pct20xPosition) {
      broadcast('position_opened', { bot: 'trailing10pct20x', position: trail10pct20xPosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !trailWidePosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trailWidePosition = trailWideBot.openPosition(setup);
    if (trailWidePosition) {
      broadcast('position_opened', { bot: 'trailWide', position: trailWidePosition });
      newlyOpened = true;
    }
  }
  if (passesFilter && !confluencePosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    confluencePosition = confluenceBot.openPosition(setup);
    if (confluencePosition) {
      broadcast('position_opened', { bot: 'confluence', position: confluencePosition });
      newlyOpened = true;
    }
  }

  // Shadow bots - try to open new positions if setup triggered/deep_extreme
  if (passesFilter && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    for (const { id, bot } of shadowBots) {
      const existingPos = bot.getOpenPositions().find(
        p => p.symbol === setup.symbol && p.direction === setup.direction &&
             p.timeframe === setup.timeframe && p.marketType === setup.marketType
      );
      if (!existingPos) {
        const position = bot.openPosition(setup);
        if (position) {
          // Don't broadcast for shadow bots - keep them quiet
          newlyOpened = true;
        }
      }
    }
  }

  // Try MEXC simulation bots too (they also only open on triggered/deep_extreme)
  // ONLY open if setup passes filter
  if (passesFilter && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    for (const [botId, bot] of mexcSimBots) {
      const existingPos = bot.getOpenPositions().find(
        p => p.symbol === setup.symbol && p.direction === setup.direction &&
             p.timeframe === setup.timeframe && p.marketType === setup.marketType
      );
      if (!existingPos) {
        const position = bot.openPosition(setup);
        if (position) {
          broadcast('position_opened', { bot: botId, position });
          newlyOpened = true;
        }
      }
    }
  }

  // Update all Golden Pocket positions and try to open new ones (only if passes filter)
  for (const [botId, bot] of goldenPocketBots) {
    // Always update existing positions
    let gpPosition = bot.updatePosition(setup);

    // Only open NEW positions if setup passes filter
    if (passesFilter && !gpPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
      gpPosition = bot.openPosition(setup);
      if (gpPosition) {
        broadcast('position_opened', { bot: botId, position: gpPosition });
        newlyOpened = true;
      }
    }
    if (gpPosition) {
      if (gpPosition.status !== 'open' && gpPosition.status !== 'partial_tp1') {
        broadcast('position_closed', { bot: botId, position: gpPosition });
      } else {
        broadcast('position_updated', { bot: botId, position: gpPosition });
      }
    }
  }

  // Update all Golden Pocket V2 positions and try to open new ones (only if passes filter)
  for (const [botId, bot] of goldenPocketBotsV2) {
    // Always update existing positions
    let gpPosition = bot.updatePosition(setup);

    // Only open NEW positions if setup passes filter and is a V2 setup
    const isGPV2Setup = 'fibLevels' in setup && 'tp1Price' in setup && 'stopPrice' in setup && 'isV2' in setup;
    if (passesFilter && !gpPosition && isGPV2Setup && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
      gpPosition = bot.openPosition(setup);
      if (gpPosition) {
        broadcast('position_opened', { bot: botId, position: gpPosition });
        newlyOpened = true;
      }
    }
    if (gpPosition) {
      if (gpPosition.status !== 'open' && gpPosition.status !== 'partial_tp1') {
        broadcast('position_closed', { bot: botId, position: gpPosition });
      } else {
        broadcast('position_updated', { bot: botId, position: gpPosition });
      }
    }
  }

  // Send notification if setup just became triggered/deep_extreme (state transition)
  if (isNotificationsEnabled() && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    await notifier.notifyNewSetup(setup);
  }

  // Send notification when setup plays out (distinct "done" sound)
  if (isNotificationsEnabled() && setup.state === 'played_out') {
    await notifier.notifyPlayedOut(setup);
  }

  if (fixedPosition) {
    if (fixedPosition.status !== 'open') {
      broadcast('position_closed', { bot: 'fixedTP', position: fixedPosition });
    } else {
      broadcast('position_updated', { bot: 'fixedTP', position: fixedPosition });
    }
  }

  if (trail1pctPosition) {
    if (trail1pctPosition.status !== 'open') {
      broadcast('position_closed', { bot: 'trailing1pct', position: trail1pctPosition });
    } else {
      broadcast('position_updated', { bot: 'trailing1pct', position: trail1pctPosition });
    }
  }

  if (trail10pct10xPosition) {
    if (trail10pct10xPosition.status !== 'open') {
      broadcast('position_closed', { bot: 'trailing10pct10x', position: trail10pct10xPosition });
    } else {
      broadcast('position_updated', { bot: 'trailing10pct10x', position: trail10pct10xPosition });
    }
  }

  if (trail10pct20xPosition) {
    if (trail10pct20xPosition.status !== 'open') {
      broadcast('position_closed', { bot: 'trailing10pct20x', position: trail10pct20xPosition });
    } else {
      broadcast('position_updated', { bot: 'trailing10pct20x', position: trail10pct20xPosition });
    }
  }

  if (trailWidePosition) {
    if (trailWidePosition.status !== 'open') {
      broadcast('position_closed', { bot: 'trailWide', position: trailWidePosition });
    } else {
      broadcast('position_updated', { bot: 'trailWide', position: trailWidePosition });
    }
  }

  if (confluencePosition) {
    if (confluencePosition.status !== 'open') {
      broadcast('position_closed', { bot: 'confluence', position: confluencePosition });
    } else {
      broadcast('position_updated', { bot: 'confluence', position: confluencePosition });
    }
  }

  // Update MEXC simulation bots and broadcast position changes
  for (const [botId, bot] of mexcSimBots) {
    const openBefore = bot.getOpenPositions().map(p => p.id);
    bot.updatePosition(setup, setup.currentPrice);
    const openAfter = bot.getOpenPositions().map(p => p.id);

    // Check if any positions were closed (ids in openBefore but not in openAfter)
    const closedIds = openBefore.filter(id => !openAfter.includes(id));
    for (const closedId of closedIds) {
      const closedPos = bot.getClosedPositions().find(p => p.id === closedId);
      if (closedPos) {
        broadcast('position_closed', { bot: botId, position: closedPos });
      }
    }

    // Broadcast updates for positions that are still open (matching current setup)
    const position = bot.getOpenPositions().find(
      p => p.symbol === setup.symbol && p.direction === setup.direction &&
           p.timeframe === setup.timeframe && p.marketType === setup.marketType
    );
    if (position) {
      broadcast('position_updated', { bot: botId, position });
    }
  }

  broadcast('setup_updated', setup);
  broadcastState();
}

function handleSetupRemoved(setup: BackburnerSetup) {
  // Log removal to Turso
  getDataPersistence().logSignal(setup, 'removed');

  // Handle all trailing bots
  fixedTPBot.handleSetupRemoved(setup);
  trailing1pctBot.handleSetupRemoved(setup);
  trailing10pct10xBot.handleSetupRemoved(setup);
  trailing10pct20xBot.handleSetupRemoved(setup);
  trailWideBot.handleSetupRemoved(setup);
  confluenceBot.handleSetupRemoved(setup);

  // Handle shadow bots
  for (const { bot } of shadowBots) {
    bot.handleSetupRemoved(setup);
  }

  // Handle timeframe strategy shadow bots
  for (const { bot } of timeframeShadowBots) {
    bot.handleSetupRemoved(setup);
  }

  // Handle combined strategy bot
  combinedStrategyBot.handleSetupRemoved(setup);

  // Handle GP shadow bots
  for (const { bot } of gpShadowBots) {
    bot.handleSetupRemoved(setup);
  }

  // Handle MEXC simulation bots
  for (const [botId, bot] of mexcSimBots) {
    bot.onSetupRemoved(setup);
  }

  // Handle all Golden Pocket bots
  for (const [, bot] of goldenPocketBots) {
    bot.onSetupRemoved(setup);
  }

  // Add to history
  const historySetup = { ...setup, removedAt: Date.now() };
  setupHistory.unshift(historySetup);
  if (setupHistory.length > MAX_HISTORY_SIZE) {
    setupHistory.pop();
  }

  broadcast('setup_removed', setup);
  broadcastState();
}

function handleScanProgress(completed: number, total: number, phase: string) {
  scanProgress = { completed, total, phase };
  broadcast('scan_progress', scanProgress);
}

function handleScanStatus(status: string) {
  currentStatus = status;
  broadcast('scan_status', { status });
}

function broadcastState() {
  broadcast('state', getFullState());
}

function getFullState() {
  const allSetups = screener.getAllSetups();
  const activeSetups = screener.getActiveSetups();
  const playedOutSetups = screener.getPlayedOutSetups();
  const goldenPocketSetups = screener.getGoldenPocketSetups();
  const goldenPocketV2Setups = screener.getGoldenPocketV2Setups();

  return {
    setups: {
      all: allSetups,
      active: activeSetups,
      playedOut: playedOutSetups,
      history: setupHistory,  // Full history of removed setups
      byState: {
        triggered: allSetups.filter(s => s.state === 'triggered').length,
        deep_extreme: allSetups.filter(s => s.state === 'deep_extreme').length,
        reversing: allSetups.filter(s => s.state === 'reversing').length,
      },
      byDirection: {
        long: allSetups.filter(s => s.direction === 'long').length,
        short: allSetups.filter(s => s.direction === 'short').length,
      },
      byMarket: {
        spot: allSetups.filter(s => s.marketType === 'spot').length,
        futures: allSetups.filter(s => s.marketType === 'futures').length,
      },
      goldenPocket: goldenPocketSetups,      // V1 - strict thresholds
      goldenPocketV2: goldenPocketV2Setups,  // V2 - loose thresholds
    },
    // Bot 1: Fixed TP/SL (1% position, 10x leverage)
    fixedTPBot: {
      name: 'Fixed TP/SL',
      description: '1% pos, 10x, 20% TP/SL',
      config: fixedTPBot.getConfig(),
      balance: fixedTPBot.getBalance(),
      unrealizedPnL: fixedTPBot.getUnrealizedPnL(),
      openPositions: fixedTPBot.getOpenPositions(),
      closedPositions: fixedTPBot.getClosedPositions(20),
      stats: fixedTPBot.getStats(),
      visible: botVisibility.fixedTP,
    },
    // Bot 1b: Fixed TP with Breakeven Lock (1% position, 10x leverage)
    fixedBEBot: {
      name: 'Fixed BE',
      description: '1% pos, 10x, 20% TP, BE at +10%',
      config: fixedBreakevenBot.getConfig(),
      balance: fixedBreakevenBot.getBalance(),
      unrealizedPnL: fixedBreakevenBot.getUnrealizedPnL(),
      openPositions: fixedBreakevenBot.getOpenPositions(),
      closedPositions: fixedBreakevenBot.getClosedPositions(20),
      stats: fixedBreakevenBot.getStats(),
      visible: botVisibility.fixedBE,
    },
    // Bot 2: Trailing Stop (1% position, 10x leverage)
    trailing1pctBot: {
      name: 'Trail 1%',
      description: '1% pos, 10x, trailing',
      config: trailing1pctBot.getConfig(),
      balance: trailing1pctBot.getBalance(),
      unrealizedPnL: trailing1pctBot.getUnrealizedPnL(),
      openPositions: trailing1pctBot.getOpenPositions(),
      closedPositions: trailing1pctBot.getClosedPositions(20),
      stats: trailing1pctBot.getStats(),
      visible: botVisibility.trailing1pct,
    },
    // Bot 3: Trailing Stop (10% position, 10x leverage)
    trailing10pct10xBot: {
      name: 'Trail 10% 10x',
      description: '10% pos, 10x, trailing',
      config: trailing10pct10xBot.getConfig(),
      balance: trailing10pct10xBot.getBalance(),
      unrealizedPnL: trailing10pct10xBot.getUnrealizedPnL(),
      openPositions: trailing10pct10xBot.getOpenPositions(),
      closedPositions: trailing10pct10xBot.getClosedPositions(20),
      stats: trailing10pct10xBot.getStats(),
      visible: botVisibility.trailing10pct10x,
    },
    // Bot 4: Trailing Stop (10% position, 20x leverage)
    trailing10pct20xBot: {
      name: 'Trail 10% 20x',
      description: '10% pos, 20x, trailing',
      config: trailing10pct20xBot.getConfig(),
      balance: trailing10pct20xBot.getBalance(),
      unrealizedPnL: trailing10pct20xBot.getUnrealizedPnL(),
      openPositions: trailing10pct20xBot.getOpenPositions(),
      closedPositions: trailing10pct20xBot.getClosedPositions(20),
      stats: trailing10pct20xBot.getStats(),
      visible: botVisibility.trailing10pct20x,
    },
    // Bot 5: Trail Wide (20% trigger, 10% L1 lock)
    trailWideBot: {
      name: 'Trail Wide',
      description: '10% pos, 20x, 20% trigger, 10% L1 lock',
      config: trailWideBot.getConfig(),
      balance: trailWideBot.getBalance(),
      unrealizedPnL: trailWideBot.getUnrealizedPnL(),
      openPositions: trailWideBot.getOpenPositions(),
      closedPositions: trailWideBot.getClosedPositions(20),
      stats: trailWideBot.getStats(),
      visible: botVisibility.trailWide,
    },
    // Bot 6: Multi-TF Confluence (5m + 15m/1h required)
    confluenceBot: {
      name: 'Confluence',
      description: '5m+15m/1h, 10% pos, 20x, no played_out exit',
      config: confluenceBot.getConfig(),
      balance: confluenceBot.getBalance(),
      unrealizedPnL: confluenceBot.getUnrealizedPnL(),
      openPositions: confluenceBot.getOpenPositions(),
      closedPositions: confluenceBot.getClosedPositions(20),
      stats: confluenceBot.getStats(),
      activeTriggers: confluenceBot.getActiveTriggers(),
      visible: botVisibility.confluence,
    },
    // Bot 7: BTC Contrarian (50x leverage, extreme RSI)
    btcExtremeBot: {
      name: 'BTC Contrarian',
      description: 'BTC only, 50x, fades extreme RSI',
      config: btcExtremeBot.getConfig(),
      balance: btcExtremeBot.getBalance(),
      unrealizedPnL: btcExtremeBot.getUnrealizedPnL(),
      position: btcExtremeBot.getPosition(),
      closedPositions: btcExtremeBot.getClosedPositions(20),
      stats: btcExtremeBot.getStats(),
      visible: botVisibility.btcExtreme,
    },
    // Bot 9: BTC Momentum (50x leverage, trend following)
    btcTrendBot: {
      name: 'BTC Momentum',
      description: 'BTC only, 50x, follows strong trends',
      config: btcTrendBot.getConfig(),
      balance: btcTrendBot.getBalance(),
      unrealizedPnL: btcTrendBot.getUnrealizedPnL(),
      position: btcTrendBot.getPosition(),
      closedPositions: btcTrendBot.getClosedPositions(20),
      stats: btcTrendBot.getStats(),
      visible: botVisibility.btcTrend,
    },
    // Bot 10: Trend Override - trades WITH trend when backburner conflicts
    trendOverrideBot: {
      name: 'Trend Override',
      description: 'Single TF + BTC trend conflict → trade with trend',
      config: trendOverrideBot.getConfig(),
      balance: trendOverrideBot.getBalance(),
      unrealizedPnL: trendOverrideBot.getUnrealizedPnL(),
      openPositions: trendOverrideBot.getOpenPositions(),
      closedPositions: trendOverrideBot.getClosedPositions(20),
      stats: trendOverrideBot.getStats(),
      visible: botVisibility.trendOverride,
    },
    // Bot 11: Trend Flip - override + flip on profitable close
    trendFlipBot: {
      name: 'Trend Flip',
      description: 'Override + flip to opposite on profit',
      config: trendFlipBot.getConfig(),
      balance: trendFlipBot.getBalance(),
      unrealizedPnL: trendFlipBot.getUnrealizedPnL(),
      openPositions: trendFlipBot.getOpenPositions(),
      closedPositions: trendFlipBot.getClosedPositions(20),
      stats: trendFlipBot.getStats(),
      pendingFlips: trendFlipBot.getPendingFlips(),
      visible: botVisibility.trendFlip,
    },
    // BTC Bias V1 Bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
    // Bots 20-25: MEXC Simulation Bots
    mexcSimBots: Object.fromEntries(
      Array.from(mexcSimBots.entries()).map(([key, bot]) => [
        key,
        {
          name: bot.getName(),
          config: bot.getConfig(),
          balance: bot.getBalance(),
          unrealizedPnL: bot.getUnrealizedPnL(),
          openPositions: bot.getOpenPositions(),
          closedPositions: bot.getClosedPositions(),
          stats: bot.getStats(),
          visible: botVisibility[key],
        },
      ])
    ),
    // Bots 26-29: Golden Pocket (Fibonacci hype strategy - 4 variants)
    goldenPocketBots: Object.fromEntries(
      Array.from(goldenPocketBots.entries()).map(([key, bot]) => [
        key,
        {
          name: key === 'gp-conservative' ? 'GP Conservative' :
                key === 'gp-standard' ? 'GP Standard' :
                key === 'gp-aggressive' ? 'GP Aggressive' :
                'GP YOLO',
          description: key === 'gp-conservative' ? '5% pos, 10x, Fib TP/SL' :
                       key === 'gp-standard' ? '10% pos, 10x, Fib TP/SL' :
                       key === 'gp-aggressive' ? '10% pos, 20x, Fib TP/SL' :
                       '20% pos, 20x, Fib TP/SL',
          balance: bot.getBalance(),
          unrealizedPnL: bot.getUnrealizedPnL(),
          openPositions: bot.getOpenPositions(),
          closedPositions: bot.getClosedPositions(20),
          stats: bot.getStats(),
          visible: botVisibility[key],
        },
      ])
    ),
    // Bots 30-33: Golden Pocket V2 (loose thresholds - 4 variants)
    goldenPocketBotsV2: Object.fromEntries(
      Array.from(goldenPocketBotsV2.entries()).map(([key, bot]) => [
        key,
        {
          name: key === 'gp2-conservative' ? 'GP2 Conservative' :
                key === 'gp2-standard' ? 'GP2 Standard' :
                key === 'gp2-aggressive' ? 'GP2 Aggressive' :
                'GP2 YOLO',
          description: key === 'gp2-conservative' ? '5% pos, 10x, Loose RSI' :
                       key === 'gp2-standard' ? '10% pos, 10x, Loose RSI' :
                       key === 'gp2-aggressive' ? '10% pos, 20x, Loose RSI' :
                       '20% pos, 20x, Loose RSI',
          balance: bot.getBalance(),
          unrealizedPnL: bot.getUnrealizedPnL(),
          openPositions: bot.getOpenPositions(),
          closedPositions: bot.getClosedPositions(20),
          stats: bot.getStats(),
          visible: botVisibility[key],
        },
      ])
    ),
    // Bots 34-41: BTC Bias V2 (conservative params - 8 variants)
    btcBiasBotsV2: Object.fromEntries(
      Array.from(btcBiasBotsV2.entries()).map(([key, bot]) => [
        key,
        {
          name: bot.getName(),
          config: bot.getConfig(),
          balance: bot.getBalance(),
          unrealizedPnL: bot.getUnrealizedPnL(),
          position: bot.getPosition(),
          closedPositions: bot.getClosedPositions(20),
          stats: bot.getStats(),
          isStoppedOut: bot.isStoppedOut(),
          stoppedOutDirection: bot.getStoppedOutDirection(),
          visible: botVisibility[key],
        },
      ])
    ),
    // Bots 42-44: Fade Bots (Contrarian - opposite direction of RSI signals)
    fadeBots: Object.fromEntries(
      Array.from(fadeBots.entries()).map(([key, bot]) => [
        key,
        {
          name: key === 'fade-conservative' ? 'Fade Conservative' :
                key === 'fade-standard' ? 'Fade Standard' :
                'Fade Aggressive',
          description: key === 'fade-conservative' ? '3% pos, 3x, Contrarian' :
                       key === 'fade-standard' ? '5% pos, 5x, Contrarian' :
                       '10% pos, 5x, Contrarian',
          balance: bot.getStats().currentBalance,
          openPositions: bot.getOpenPositions(),
          closedPositions: bot.getClosedPositions().slice(-20),
          stats: bot.getStats(),
          visible: botVisibility[key] ?? true,
        },
      ])
    ),
    // Bots 45-48: Spot Regime Bots (Contrarian quadrant-based - Focus Mode automation)
    spotRegimeBots: Object.fromEntries(
      Array.from(spotRegimeBots.entries()).map(([key, bot]) => [
        key,
        {
          name: key === 'spot-standard' ? 'Spot Regime Standard' :
                key === 'spot-strict' ? 'Spot Regime Strict' :
                key === 'spot-loose' ? 'Spot Regime Loose' :
                'Spot Regime Contrarian',
          description: key === 'spot-standard' ? '65% thresholds, 15% SL' :
                       key === 'spot-strict' ? '70% thresholds, 12% SL' :
                       key === 'spot-loose' ? '60% thresholds, 18% SL' :
                       'Bearish-only, 60% threshold',
          regime: bot.getRegimeStats(),
          openPositions: bot.getPositions(),
          closedPositions: bot.getTrades().slice(-20),
          stats: bot.getStats(),
          visible: botVisibility[key] ?? true,
        },
      ])
    ),
    // Bots 49-56: Focus Mode Shadow Bots (Leveraged trading with quadrant rules)
    focusShadowBots: Object.fromEntries(
      Array.from(focusShadowBots.entries()).map(([key, bot]) => [
        key,
        {
          name: key === 'focus-baseline' ? 'Focus Baseline' :
                key === 'focus-conflict' ? 'Focus Conflict-Close' :
                key === 'focus-excellent' ? 'Focus Excellent Overflow' :
                key === 'focus-hybrid' ? 'Focus Hybrid' :
                key === 'focus-aggressive' ? 'Focus Aggressive' :
                key === 'focus-conservative' ? 'Focus Conservative' :
                key === 'focus-contrarian-only' ? 'Focus Contrarian-Only' :
                key === 'focus-euphoria-fade' ? 'Focus Euphoria Fade' :
                key === 'focus-bull-dip' ? 'Focus Bull Dip Buyer' :
                key === 'focus-full-quadrant' ? 'Focus Full Quadrant' :
                key,
          description: key === 'focus-baseline' ? 'Standard rules, 5 max positions' :
                       key === 'focus-conflict' ? 'Closes on regime conflict' :
                       key === 'focus-excellent' ? '+2 positions for excellent setups' :
                       key === 'focus-hybrid' ? 'Conflict-close + excellent overflow' :
                       key === 'focus-aggressive' ? '1.5x leverage, 8 max positions' :
                       key === 'focus-conservative' ? '0.75x leverage, strict entries' :
                       key === 'focus-contrarian-only' ? 'NEU+BEAR & BEAR+BEAR only' :
                       key === 'focus-euphoria-fade' ? 'BULL+BULL shorts - fade euphoria' :
                       key === 'focus-bull-dip' ? 'BULL+BEAR longs - buy dips in uptrend' :
                       key === 'focus-full-quadrant' ? 'ALL quadrants (except BEAR+BULL)' :
                       'Unknown variant',
          regime: bot.getCurrentRegime(),
          balance: bot.getBalance(),
          unrealizedPnl: bot.getUnrealizedPnl(),
          openPositions: bot.getPositions(),
          closedPositions: bot.getClosedPositions(20),
          stats: bot.getStats(),
          config: bot.getConfig(),
          visible: botVisibility[key] ?? true,
        },
      ])
    ),
    // Bots 57+: Experimental Shadow Bots (testing different bias/regime combinations)
    experimentalBots: Object.fromEntries(
      Array.from(experimentalBots.entries()).map(([key, bot]) => [
        key,
        bot.getState(),
      ])
    ),
    botVisibility,
    meta: {
      eligibleSymbols: screener.getEligibleSymbolCount(),
      isRunning: screener.isActive(),
      status: currentStatus,
      scanProgress,
      timestamp: Date.now(),
    },
  };
}

// Create server context for route modules
const serverContext: ServerContext = {
  settings: serverSettings,
  saveSettings: saveServerSettings,
  resetAllBots,
  updateAllBotsInitialBalance,
  toggleBot: (botId: string, enabled: boolean) => {
    botVisibility[botId] = enabled;
  },
  botToggles: botVisibility,
  broadcastState,
  getFullState,
  clients,
  getCurrentDateString,
  screener,
  paperEngine: fixedTPBot, // Main paper engine reference
  trailingEngine: trailing1pctBot,
  trailWideBot,
  confluenceBot,
  btcExtremeBot,
  btcTrendBot,
  trendOverrideBot,
  trendFlipBot,
  fadeBot: fadeBots,
  goldenPocketBots,
  gp2Bots: goldenPocketBotsV2,
  focusShadowBots,
  spotRegimeBots,
  notificationManager: notifier,
};

// Mount extracted route modules
app.use('/api', express.json(), createSettingsRouter(serverContext));

// ============================================================
// MEXC Live Execution API Routes
// ============================================================

// MEXC Client singleton
let mexcClient: MexcFuturesClient | null = null;
// mexcExecutionMode is now persisted via serverSettings.mexcExecutionMode
// This alias keeps the rest of the code working without renaming everywhere
function getMexcExecutionMode(): 'dry_run' | 'shadow' | 'live' {
  return serverSettings.mexcExecutionMode || 'dry_run';
}

// Determine the execution mode for a specific bot (for trade logging)
// Returns 'live' if the bot is selected for MEXC execution in live mode,
// 'shadow' if in shadow mode, otherwise 'paper'
function getExecutionModeForBot(botId: string): string {
  if (serverSettings.mexcSelectedBots.includes(botId)) {
    const mode = getMexcExecutionMode();
    if (mode === 'live') return 'live';
    if (mode === 'shadow') return 'shadow';
  }
  return 'paper';
}
interface QueuedOrder {
  id: string;
  timestamp: number;
  bot: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  entryQuality?: string;
  entryPrice?: number;
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'cancelled' | 'closed' | 'stopped_out' | 'tp_hit';
  error?: string;
  closedAt?: number;
  closedPnl?: number;
  executedAt?: number;  // When the order was executed on MEXC
  createdAt?: number;   // When the order was created in queue
}
const mexcExecutionQueue: QueuedOrder[] = [];

// Exchange-side trailing stop manager (manages SL plan orders directly on MEXC)
const trailingManager = new MexcTrailingManager({
  trailTriggerPct: 10,   // 10% ROE to activate trail
  trailStepPct: 5,       // 5% ROE trailing step
  initialStopPct: 8,     // 8% price distance for initial SL
  renewalDays: 6,        // Renew plan orders before 7-day expiry
  minModifyIntervalMs: 5000,
});

// Decision log for bot actions (ring buffer, last 200 entries)
interface BotDecisionLog {
  timestamp: number;
  bot: string;
  symbol: string;
  action: string;
  details: string;
}
const botDecisionLogs: BotDecisionLog[] = [];
const MAX_DECISION_LOGS = 200;

function logBotDecision(bot: string, symbol: string, action: string, details: string): void {
  botDecisionLogs.push({ timestamp: Date.now(), bot, symbol, action, details });
  if (botDecisionLogs.length > MAX_DECISION_LOGS) {
    botDecisionLogs.shift();
  }
}

// Initialize MEXC client if cookie is set
function initMexcClient(): MexcFuturesClient | null {
  if (mexcClient) return mexcClient;

  const cookie = process.env.MEXC_UID_COOKIE;
  if (!cookie || cookie === 'WEB_your_uid_cookie_here') {
    console.log('[MEXC] No valid cookie configured - live trading disabled');
    return null;
  }

  mexcClient = createMexcClient(cookie, false);
  console.log('[MEXC] Client initialized');
  return mexcClient;
}

// Cached MEXC available balance for queue-time position sizing
let cachedMexcAvailableBalance: number = 0;
let cachedMexcEquity: number = 0;
let lastBalanceFetchTime: number = 0;

// Track cumulative MEXC realized PnL (for comparison with paper bot)
let mexcTotalRealizedPnl: number = 0;
let mexcTotalTrades: number = 0;
let mexcWins: number = 0;
let mexcLosses: number = 0;

async function fetchMexcBalance(): Promise<{ equity: number; available: number } | null> {
  const client = initMexcClient();
  if (!client) return null;

  const result = await client.getUsdtBalance();
  if (result.success && result.balance !== undefined && result.available !== undefined) {
    cachedMexcEquity = result.balance;
    cachedMexcAvailableBalance = result.available;
    lastBalanceFetchTime = Date.now();
    return { equity: result.balance, available: result.available };
  }
  return null;
}

// Get MEXC balance (used by Bot Feeder UI for % sizing)
app.get('/api/mexc/balance', async (req, res) => {
  try {
    const bal = await fetchMexcBalance();
    if (!bal) {
      res.json({ success: false, error: 'MEXC client not available or balance fetch failed' });
      return;
    }
    res.json({ success: true, equity: bal.equity, available: bal.available });
  } catch (err) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// Test MEXC connection
app.get('/api/mexc/test-connection', async (req, res) => {
  try {
    const client = initMexcClient();
    if (!client) {
      res.json({ success: false, error: 'MEXC_UID_COOKIE not configured' });
      return;
    }

    const bal = await fetchMexcBalance();
    res.json({
      success: bal !== null,
      balance: bal?.equity ?? 0,
      available: bal?.available ?? 0,
      error: bal === null ? 'Balance fetch failed' : undefined,
    });
  } catch (err) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// Get MEXC positions with calculated unrealized P&L
app.get('/api/mexc/positions', async (req, res) => {
  try {
    const client = initMexcClient();
    if (!client) {
      res.json({ success: false, error: 'MEXC client not configured' });
      return;
    }

    const result = await client.getOpenPositions();
    if (!result.success) {
      res.json({ success: false, error: result.error });
      return;
    }

    // Calculate unrealized PnL from current prices
    const positions = await Promise.all((result.data || []).map(async (p) => {
      let unrealized = 0;
      try {
        const ticker = await client.getTickerPrice(p.symbol);
        if (ticker.success && ticker.price) {
          const side = p.positionType === 1 ? 1 : -1; // 1=long, -1=short
          const contractSize = await getContractSize(p.symbol);
          unrealized = (ticker.price - p.holdAvgPrice) * p.holdVol * contractSize * side;
        }
      } catch { /* use 0 if price fetch fails */ }

      const isManaged = trailingManager.isTracking(p.symbol);
      const tracked = isManaged ? trailingManager.getPosition(p.symbol) : undefined;

      return {
        symbol: p.symbol,
        side: p.positionType === 1 ? 'long' as const : 'short' as const,
        size: p.holdVol,
        entryPrice: p.holdAvgPrice,
        leverage: p.leverage,
        unrealized,
        liquidationPrice: p.liquidatePrice,
        managed: isManaged,
        currentStopPrice: tracked?.currentStopPrice,
        trailActivated: tracked?.trailActivated ?? false,
        highestRoePct: tracked?.highestRoePct ?? 0,
      };
    }));

    res.json({ success: true, positions });
  } catch (err) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// Adopt an unmanaged MEXC position for trailing stop management
app.post('/api/mexc/adopt-position', express.json(), async (req, res) => {
  const { symbol, initialStopPct, trailTriggerPct, trailStepPct } = req.body;

  if (!symbol || typeof symbol !== 'string') {
    res.json({ success: false, error: 'Symbol is required' });
    return;
  }

  if (trailingManager.isTracking(symbol)) {
    res.json({ success: false, error: `${symbol} is already managed` });
    return;
  }

  const client = initMexcClient();
  if (!client) {
    res.json({ success: false, error: 'MEXC client not configured' });
    return;
  }

  try {
    // Fetch the actual MEXC position
    const posResult = await client.getPosition(symbol);
    if (!posResult.success || !posResult.data) {
      res.json({ success: false, error: `No open position found for ${symbol}` });
      return;
    }

    const pos = posResult.data;
    const direction = pos.positionType === 1 ? 'long' as const : 'short' as const;
    const leverage = pos.leverage;
    const stopPct = initialStopPct || 8;  // ROE-based: 8% ROE loss max
    const slPriceDistance = stopPct / 100 / leverage;  // Convert ROE% to price%
    const slPrice = direction === 'long'
      ? pos.holdAvgPrice * (1 - slPriceDistance)
      : pos.holdAvgPrice * (1 + slPriceDistance);

    // Cancel any existing plan orders to avoid duplicates, then create fresh SL
    await client.cancelAllPlanOrders(symbol);
    const slResult = await client.setStopLoss(symbol, slPrice);
    if (!slResult.success) {
      console.warn(`[ADOPT] Failed to create SL for ${symbol}: ${slResult.error} — proceeding anyway`);
    }

    // Start trailing manager tracking
    await trailingManager.startTracking(client, {
      symbol: pos.symbol,
      direction,
      entryPrice: pos.holdAvgPrice,
      leverage,
      volume: pos.holdVol,
      stopLossPrice: slPrice,
      botId: 'adopted',
      trailTriggerPct: trailTriggerPct || undefined,
      trailStepPct: trailStepPct || undefined,
      initialStopPct: stopPct,
    });

    // Persist to Turso
    if (isTursoConfigured()) {
      const tracked = trailingManager.getPosition(symbol);
      if (tracked) {
        saveTrailingPosition(symbol, tracked).catch(e =>
          console.error(`[ADOPT] Turso save failed for ${symbol}:`, e)
        );
      }
    }

    console.log(`[ADOPT] Now managing ${symbol} ${direction} @ $${pos.holdAvgPrice} | SL: $${slPrice.toFixed(4)} | Trail: ${trailTriggerPct || 10}%/${trailStepPct || 5}%`);

    res.json({
      success: true,
      symbol,
      direction,
      entryPrice: pos.holdAvgPrice,
      stopLossPrice: slPrice,
      managed: true,
    });
  } catch (err) {
    console.error(`[ADOPT] Error adopting ${symbol}:`, (err as Error).message);
    res.json({ success: false, error: (err as Error).message });
  }
});

// Get bot decision logs
app.get('/api/mexc/logs', (req, res) => {
  const bot = req.query.bot as string | undefined;
  const logs = bot
    ? botDecisionLogs.filter(l => l.bot === bot)
    : botDecisionLogs;
  res.json({ success: true, logs: logs.slice(-100) });
});

// Set execution mode
app.post('/api/mexc/mode', express.json(), (req, res) => {
  const { mode, confirmLive } = req.body;

  if (!['dry_run', 'shadow', 'live'].includes(mode)) {
    res.json({ success: false, error: 'Invalid mode' });
    return;
  }

  if (mode === 'live' && confirmLive !== 'I_UNDERSTAND_THIS_USES_REAL_MONEY') {
    res.json({ success: false, error: 'Live mode requires confirmation' });
    return;
  }

  serverSettings.mexcExecutionMode = mode;
  saveServerSettings();
  // Update execution mode on experimental bots for trade logging
  for (const [botId, bot] of experimentalBots) {
    bot.setExecutionMode(getExecutionModeForBot(botId));
  }
  console.log(`[MEXC] Execution mode set to: ${mode} (persisted)`);
  res.json({ success: true, mode });
});

// Get current execution mode
app.get('/api/mexc/mode', (req, res) => {
  res.json({ success: true, mode: getMexcExecutionMode() });
});

// Get execution queue
app.get('/api/mexc/queue', (req, res) => {
  res.json({ success: true, queue: mexcExecutionQueue });
});

// Clear execution queue
app.post('/api/mexc/queue/clear', (req, res) => {
  mexcExecutionQueue.length = 0;
  res.json({ success: true });
});

// Execute a specific queued order
app.post('/api/mexc/queue/execute/:index', express.json(), async (req, res) => {
  const index = parseInt(req.params.index);

  if (index < 0 || index >= mexcExecutionQueue.length) {
    res.json({ success: false, error: 'Invalid order index' });
    return;
  }

  const order = mexcExecutionQueue[index];

  if (order.status !== 'pending') {
    res.json({ success: false, error: 'Order not in pending state' });
    return;
  }

  if (getMexcExecutionMode() !== 'live') {
    res.json({ success: false, error: 'Not in live mode' });
    return;
  }

  const client = initMexcClient();
  if (!client) {
    res.json({ success: false, error: 'MEXC client not configured' });
    return;
  }

  order.status = 'executing';

  try {
    const result = await executeOnMexc(client, order);

    if (result.success) {
      order.status = 'executed';
      order.executedAt = Date.now();
      res.json({ success: true, order: result.data });
    } else {
      order.status = 'failed';
      order.error = result.error;
      res.json({ success: false, error: result.error });
    }
  } catch (err) {
    order.status = 'failed';
    order.error = (err as Error).message;
    res.json({ success: false, error: (err as Error).message });
  }
});

// Cancel a specific queued order
app.post('/api/mexc/queue/cancel/:index', (req, res) => {
  const index = parseInt(req.params.index);

  if (index < 0 || index >= mexcExecutionQueue.length) {
    res.json({ success: false, error: 'Invalid order index' });
    return;
  }

  mexcExecutionQueue[index].status = 'cancelled';
  res.json({ success: true });
});

// Emergency close all positions
app.post('/api/mexc/emergency-close', express.json(), async (req, res) => {
  const { confirm } = req.body;

  if (confirm !== 'CLOSE_ALL_NOW') {
    res.json({ success: false, error: 'Confirmation required' });
    return;
  }

  const client = initMexcClient();
  if (!client) {
    res.json({ success: false, error: 'MEXC client not configured' });
    return;
  }

  try {
    const positionsResult = await client.getOpenPositions();
    if (!positionsResult.success || !positionsResult.data) {
      res.json({ success: false, error: 'Failed to get positions' });
      return;
    }

    let closed = 0;
    const errors: string[] = [];

    for (const position of positionsResult.data) {
      try {
        const closeResult = position.positionType === 1
          ? await client.closeLong(position.symbol, position.holdVol)
          : await client.closeShort(position.symbol, position.holdVol);

        if (closeResult.success) {
          closed++;
        } else {
          errors.push(`${position.symbol}: ${closeResult.error}`);
        }
      } catch (err) {
        errors.push(`${position.symbol}: ${(err as Error).message}`);
      }
    }

    res.json({
      success: true,
      closed,
      total: positionsResult.data.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// Clean up duplicate/orphaned plan orders — cancels ALL plan orders for every position,
// then recreates one clean SL per position via the trailing manager.
app.post('/api/mexc/cleanup-orders', express.json(), async (req, res) => {
  const client = initMexcClient();
  if (!client) {
    res.json({ success: false, error: 'MEXC client not configured' });
    return;
  }

  try {
    const posResult = await client.getOpenPositions();
    if (!posResult.success) {
      res.json({ success: false, error: 'Failed to fetch positions' });
      return;
    }

    const positions = posResult.data || [];
    const openSymbols = new Set(positions.map(p => p.symbol));
    let cancelledSymbols = 0;
    let recreatedSL = 0;
    const cleaned: string[] = [];

    // 1. Cancel ALL plan orders for every open position (removes duplicates)
    for (const pos of positions) {
      try {
        await client.cancelAllPlanOrders(pos.symbol);
        cancelledSymbols++;
        cleaned.push(pos.symbol);
        console.log(`[CLEANUP] Cancelled all plan orders for ${pos.symbol}`);
      } catch (e) {
        console.error(`[CLEANUP] Failed to cancel plan orders for ${pos.symbol}:`, (e as Error).message);
      }
    }

    // 2. Also cancel plan orders for symbols NOT in open positions (truly orphaned)
    const knownSymbols = new Set<string>();
    for (const order of mexcExecutionQueue) {
      knownSymbols.add(spotSymbolToFutures(order.symbol));
    }
    for (const symbol of knownSymbols) {
      if (openSymbols.has(symbol)) continue;
      try {
        await client.cancelAllPlanOrders(symbol);
        cancelledSymbols++;
        cleaned.push(symbol + ' (orphaned)');
        console.log(`[CLEANUP] Cancelled orphaned plan orders for ${symbol}`);
      } catch (e) { /* ignore */ }
    }

    // 3. Recreate one clean SL plan order per open position
    for (const pos of positions) {
      try {
        const direction = pos.positionType === 1 ? 'long' : 'short';
        const leverage = pos.leverage || serverSettings.mexcMaxLeverage;
        const slPriceDistance = 8 / 100 / leverage; // 8% ROE
        const slPrice = direction === 'long'
          ? pos.holdAvgPrice * (1 - slPriceDistance)
          : pos.holdAvgPrice * (1 + slPriceDistance);

        // Check if trailing manager has a better (tighter) SL
        const tracked = trailingManager.getPosition(pos.symbol);
        const finalSlPrice = tracked ? tracked.currentStopPrice : slPrice;

        const slResult = await client.setStopLoss(pos.symbol, finalSlPrice);
        if (slResult.success) {
          recreatedSL++;
          console.log(`[CLEANUP] Recreated SL for ${pos.symbol} @ $${finalSlPrice.toFixed(4)}`);

          // Update trailing manager with new plan order ID
          if (tracked && slResult.data?.id) {
            tracked.planOrderId = String(slResult.data.id);
          }
        }
      } catch (e) {
        console.error(`[CLEANUP] Failed to recreate SL for ${pos.symbol}:`, (e as Error).message);
      }
    }

    res.json({
      success: true,
      cancelledSymbols,
      recreatedSL,
      cleaned,
      openPositions: positions.length,
    });
    console.log(`[CLEANUP] Done: cancelled orders for ${cancelledSymbols} symbols, recreated ${recreatedSL} SL orders, ${positions.length} positions`);
  } catch (err) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// Handle insurance trigger from experimental bots
// When insurance triggers: close half position on MEXC, update SL to breakeven
async function handleInsuranceTriggered(
  botId: string,
  position: { symbol: string; direction: 'long' | 'short'; entryPrice: number },
  lockedPnl: number
): Promise<void> {
  if (getMexcExecutionMode() !== 'live') {
    console.log(`[INSURANCE] ${botId} triggered for ${position.symbol} but mode is not live - paper only`);
    return;
  }

  if (!serverSettings.mexcSelectedBots.includes(botId)) {
    console.log(`[INSURANCE] ${botId} not in selected bots - paper only`);
    return;
  }

  const client = initMexcClient();
  if (!client) {
    console.log(`[INSURANCE] MEXC client not available`);
    return;
  }

  // Convert to futures symbol format
  const futuresSymbol = spotSymbolToFutures(position.symbol);

  try {
    // 1. Get current MEXC position
    const posResult = await client.getPosition(futuresSymbol);
    if (!posResult.success || !posResult.data) {
      console.log(`[INSURANCE] No MEXC position found for ${futuresSymbol}`);
      return;
    }

    const mexcPos = posResult.data;
    const halfVol = Math.floor(mexcPos.holdVol / 2); // Floor to get integer contracts

    if (halfVol < 1) {
      console.log(`[INSURANCE] Position too small to split: ${mexcPos.holdVol} contracts`);
      return;
    }

    const isLong = mexcPos.positionType === 1;

    // 2. Close half the position (WITHOUT canceling plan orders)
    console.log(`[INSURANCE] Closing half position: ${halfVol}/${mexcPos.holdVol} contracts of ${futuresSymbol}`);

    const closeResult = isLong
      ? await client.closeLong(futuresSymbol, halfVol, false) // false = don't cancel plan orders
      : await client.closeShort(futuresSymbol, halfVol, false);

    if (!closeResult.success) {
      console.error(`[INSURANCE] Failed to close half: ${closeResult.error}`);
      return;
    }

    console.log(`[INSURANCE] Half closed successfully. Locked ~$${lockedPnl.toFixed(2)} profit`);

    // 3. Update SL to breakeven (entry price)
    // First cancel existing SL, then create new one at entry price
    await client.cancelAllPlanOrders(futuresSymbol);

    const slResult = await client.setStopLoss(futuresSymbol, position.entryPrice);
    if (slResult.success) {
      console.log(`[INSURANCE] SL moved to breakeven @ $${position.entryPrice.toFixed(4)}`);
    } else {
      console.error(`[INSURANCE] Failed to set breakeven SL: ${slResult.error}`);
    }

    // Update trailing manager if it's tracking this position
    const tracked = trailingManager.getPosition(futuresSymbol);
    if (tracked) {
      tracked.currentStopPrice = position.entryPrice;
      tracked.halfClosed = true;
      tracked.halfClosedAt = Date.now();
      tracked.halfClosedPnl = lockedPnl;
      if (slResult.data?.id) {
        tracked.planOrderId = String(slResult.data.id);
      }
    }

  } catch (err) {
    console.error(`[INSURANCE] Error handling trigger:`, (err as Error).message);
  }
}

// Wire up insurance callbacks for experimental bots
function wireUpInsuranceCallbacks(): void {
  for (const [botId, bot] of experimentalBots) {
    bot.onInsuranceTriggered = (position, lockedPnl) => {
      handleInsuranceTriggered(botId, position, lockedPnl);
    };
  }
  console.log(`[INSURANCE] Wired up callbacks for ${experimentalBots.size} experimental bots`);
}

// Add order to execution queue (called by bots)
export function addToMexcQueue(
  bot: string,
  symbol: string,
  side: 'long' | 'short',
  size: number,
  leverage: number,
  stopLossPrice?: number,
  takeProfitPrice?: number,
  entryQuality?: string,
  entryPrice?: number
): void {
  // Convert spot symbol (BTCUSDT) to futures format (BTC_USDT) for MEXC API
  symbol = spotSymbolToFutures(symbol);

  // Dedup: skip if pending order already exists for same symbol+side
  const hasDuplicate = mexcExecutionQueue.some(
    o => o.symbol === symbol && o.side === side && o.status === 'pending'
  );
  if (hasDuplicate) {
    console.log(`[MEXC] Skipping duplicate: ${symbol} ${side} already pending`);
    return;
  }

  // Compute position size based on mode
  if (serverSettings.mexcPositionSizeMode === 'percent') {
    if (cachedMexcAvailableBalance > 0) {
      size = cachedMexcAvailableBalance * (serverSettings.mexcPositionSizePct / 100);
      console.log(`[MEXC] Percent sizing: ${serverSettings.mexcPositionSizePct}% of $${cachedMexcAvailableBalance.toFixed(2)} = $${size.toFixed(2)}`);
    } else {
      console.log(`[MEXC] Percent sizing fallback: no cached balance, using fixed $${size}`);
    }
  }

  // Enforce position size cap
  const maxSize = serverSettings.mexcMaxPositionSizeUsd;
  if (size > maxSize) {
    console.log(`[MEXC] Capping order size: $${size} → $${maxSize}`);
    size = maxSize;
  }

  // Enforce leverage cap — MUST recalculate SL when capping
  // The SL was calculated for the original leverage: SL_price_dist = ROE% / original_leverage
  // When we cap leverage, we need to widen the SL to maintain the same ROE%
  const maxLev = serverSettings.mexcMaxLeverage;
  if (leverage > maxLev) {
    console.log(`[MEXC] Capping leverage: ${leverage}x → ${maxLev}x`);

    // Recalculate SL to maintain the same ROE% loss with the new leverage
    if (stopLossPrice && entryPrice && entryPrice > 0) {
      const oldSlDistance = Math.abs(stopLossPrice - entryPrice) / entryPrice; // as decimal
      const impliedRoePct = oldSlDistance * leverage * 100; // ROE% that original SL represented
      const newSlDistance = impliedRoePct / 100 / maxLev; // Price distance for same ROE% at new leverage

      // Recalculate SL price with wider distance
      const oldSl = stopLossPrice;
      if (side === 'long') {
        stopLossPrice = entryPrice * (1 - newSlDistance);
      } else {
        stopLossPrice = entryPrice * (1 + newSlDistance);
      }
      console.log(`[MEXC] Widening SL for capped leverage: ${impliedRoePct.toFixed(1)}% ROE @ ${leverage}x → ${maxLev}x | SL: $${oldSl.toFixed(6)} → $${stopLossPrice.toFixed(6)}`);
    }

    leverage = maxLev;
  }

  const order: QueuedOrder = {
    id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
    timestamp: Date.now(),
    bot,
    symbol,
    side,
    size,
    leverage,
    stopLossPrice,
    takeProfitPrice,
    entryQuality,
    entryPrice,
    status: 'pending',
  };

  mexcExecutionQueue.push(order);
  const slStr = stopLossPrice ? ` SL:$${stopLossPrice.toFixed(4)}` : '';
  const tpStr = takeProfitPrice ? ` TP:$${takeProfitPrice.toFixed(4)}` : '';
  console.log(`[MEXC] Order queued: ${bot} ${side} ${symbol} $${size} ${leverage}x${slStr}${tpStr}`);

  // Auto-execute in shadow mode (log only)
  if (getMexcExecutionMode() === 'shadow') {
    console.log(`[MEXC-SHADOW] Would execute: ${side} ${symbol} $${size} ${leverage}x${slStr}${tpStr}`);
    order.status = 'executed';
    order.executedAt = Date.now();
  }

  // Auto-execute in live mode when full automation is enabled
  if (getMexcExecutionMode() === 'live' && serverSettings.mexcAutoExecute) {
    console.log(`[MEXC-AUTO] Auto-executing: ${side} ${symbol} $${size} ${leverage}x${slStr}${tpStr}`);
    autoExecuteOrder(order);
  }
}

// Convert USD order size to MEXC contract volume and execute
async function executeOnMexc(
  client: MexcFuturesClient,
  order: QueuedOrder
): Promise<{ success: boolean; data?: unknown; error?: string; contracts?: number; executionPrice?: number }> {
  // Get current price for contract conversion
  const priceResult = await client.getTickerPrice(order.symbol);
  if (!priceResult.success || !priceResult.price) {
    return { success: false, error: `Could not get price for ${order.symbol}: ${priceResult.error}` };
  }

  // Convert USD size to number of contracts
  const contracts = await usdToContracts(order.symbol, order.size, priceResult.price);
  console.log(`[MEXC] ${order.symbol}: $${order.size} @ $${priceResult.price} → ${contracts} contracts`);

  // Filter out zero/invalid SL/TP prices
  const sl = order.stopLossPrice && order.stopLossPrice > 0 ? order.stopLossPrice : undefined;
  const tp = order.takeProfitPrice && order.takeProfitPrice > 0 ? order.takeProfitPrice : undefined;

  const result = order.side === 'long'
    ? await client.openLong(order.symbol, contracts, order.leverage, sl, tp)
    : await client.openShort(order.symbol, contracts, order.leverage, sl, tp);

  return { ...result, contracts, executionPrice: priceResult.price };
}

// Auto-execute a queued order on MEXC (used by full automation mode)
async function autoExecuteOrder(order: QueuedOrder): Promise<void> {
  const client = initMexcClient();
  if (!client) {
    order.status = 'failed';
    order.error = 'MEXC client not available';
    console.log(`[MEXC-AUTO] Failed: client not available for ${order.symbol}`);
    return;
  }

  order.status = 'executing';

  try {
    const result = await executeOnMexc(client, order);

    if (result.success) {
      order.status = 'executed';
      order.executedAt = Date.now();
      console.log(`[MEXC-AUTO] Executed: ${order.side} ${order.symbol} $${order.size} ${order.leverage}x`);
      logBotDecision(order.bot, order.symbol, 'executed', `${order.side.toUpperCase()} $${order.size} ${order.leverage}x | SL: ${order.stopLossPrice || 'none'} | TP: ${order.takeProfitPrice || 'none'}`);
      // Refresh balance after execution
      fetchMexcBalance();

      // Start exchange-side trailing stop tracking
      const entryPrice = result.executionPrice || order.entryPrice || 0;
      // SL is ROE-based: 8% ROE loss max, converted to price distance using leverage
      const slRoePct = 8;
      const slPriceDist = slRoePct / 100 / order.leverage;
      const slPrice = order.stopLossPrice || entryPrice * (order.side === 'long' ? (1 - slPriceDist) : (1 + slPriceDist));
      try {
        await trailingManager.startTracking(client, {
          symbol: order.symbol,
          direction: order.side,
          entryPrice,
          leverage: order.leverage,
          volume: result.contracts || 0,
          stopLossPrice: slPrice,
          botId: order.bot,
        });
        // Persist trailing position to Turso
        const pos = trailingManager.getPosition(order.symbol);
        if (pos && isTursoConfigured()) {
          saveTrailingPosition(order.symbol, pos).catch(e =>
            console.error(`[TRAIL-MGR] Turso save failed for ${order.symbol}:`, e)
          );
        }
      } catch (err) {
        console.error(`[TRAIL-MGR] Failed to start tracking ${order.symbol}:`, (err as Error).message);
      }

      // Create mirror paper position with exact same MEXC params
      // This enables true 1:1 comparison between paper and live
      mexcMirrorTracker.openPosition({
        symbol: order.symbol,
        direction: order.side,
        entryPrice,
        leverage: order.leverage,
        marginUsed: order.size,
        stopLossPrice: slPrice,
        takeProfitPrice: order.takeProfitPrice || 0,
        trailTriggerPct: 10,  // Match trailing manager defaults
        trailStepPct: 5,
        sourceBotId: order.bot,
        sourceOrderId: order.id,
      });
    } else {
      order.status = 'failed';
      order.error = result.error;
      console.log(`[MEXC-AUTO] Failed: ${order.symbol} — ${result.error}`);
      logBotDecision(order.bot, order.symbol, 'failed', `${result.error}`);
    }
  } catch (err) {
    order.status = 'failed';
    order.error = (err as Error).message;
    console.log(`[MEXC-AUTO] Error: ${order.symbol} — ${(err as Error).message}`);
    logBotDecision(order.bot, order.symbol, 'error', `${(err as Error).message}`);
  }
}

// ============================================================
// Paper vs Live Comparison API - for debugging discrepancies
// ============================================================

app.get('/api/debug/paper-vs-live', async (req, res) => {
  try {
    // Get paper positions from exp-bb-sysB (primary shadow bot)
    const paperBot = experimentalBots.get('exp-bb-sysB');
    const paperState = paperBot?.getState();
    const paperPositions = paperState?.openPositions || [];
    const paperStats = paperState?.stats || { totalPnl: 0, totalTrades: 0, winRate: 0 };

    // Get MEXC live positions
    const livePositions = trailingManager.getAllPositions();

    // Get MEXC queue for pending orders
    const pendingQueue = mexcExecutionQueue.filter((o: QueuedOrder) => o.status === 'pending');
    const recentQueue = mexcExecutionQueue.slice(-20);  // Last 20 orders for context

    // Get recent closed trades from trailing manager
    const recentMexcCloses = trailingManager.getRecentCloses();

    // Calculate sizing comparison
    const paperPositionSize = 2000 * 0.10;  // $2000 * 10%
    const livePositionSize = serverSettings.mexcPositionSizeMode === 'percent'
      ? cachedMexcAvailableBalance * (serverSettings.mexcPositionSizePct / 100)
      : serverSettings.mexcPositionSizeUsd;
    const sizeRatio = paperPositionSize / (livePositionSize || 1);

    // Compare matching positions (paper vs live)
    interface PositionComparison {
      symbol: string;
      paper: any;
      live: any;
      entryPriceDiff?: number;
      slPriceDiff?: number | null;
      sizeDiff?: number;
    }
    const comparison: PositionComparison[] = [];

    for (const paperPos of paperPositions) {
      const livePos = livePositions.find((l: { symbol: string }) => l.symbol === paperPos.symbol);
      const comp: PositionComparison = {
        symbol: paperPos.symbol,
        paper: {
          direction: paperPos.direction,
          entryPrice: paperPos.entryPrice,
          stopLoss: paperPos.stopLoss,
          size: paperPos.positionSize,
          roe: paperPos.unrealizedPnlPercent,
          trailActivated: paperPos.trailActivated,
        },
        live: livePos ? {
          direction: livePos.direction,
          entryPrice: livePos.entryPrice,  // From MEXC holdAvgPrice
          stopLoss: livePos.currentStopPrice,
          size: livePositionSize,
          peakRoe: livePos.highestRoePct,
          trailActivated: livePos.trailActivated,
        } : null,
      };

      if (livePos) {
        comp.entryPriceDiff = ((livePos.entryPrice - paperPos.entryPrice) / paperPos.entryPrice) * 100;
        comp.slPriceDiff = livePos.currentStopPrice && paperPos.stopLoss
          ? ((livePos.currentStopPrice - paperPos.stopLoss) / paperPos.stopLoss) * 100
          : null;
        comp.sizeDiff = (livePositionSize / paperPos.positionSize) * 100;
        // Add live peak ROE for comparison
        comp.live.peakRoe = livePos.highestRoePct;
      }

      comparison.push(comp);
    }

    // Add live positions not in paper
    for (const livePos of livePositions) {
      if (!paperPositions.find((p: { symbol: string }) => p.symbol === livePos.symbol)) {
        comparison.push({
          symbol: livePos.symbol,
          paper: null,
          live: {
            direction: livePos.direction,
            entryPrice: livePos.entryPrice,
            stopLoss: livePos.currentStopPrice,
            size: livePositionSize,
            peakRoe: livePos.highestRoePct,
          },
        });
      }
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),

      sizing: {
        paperMode: 'percent',
        paperPercent: 10,
        paperBalance: 2000,
        paperPositionSize,
        liveMode: serverSettings.mexcPositionSizeMode,
        livePercent: serverSettings.mexcPositionSizePct,
        liveBalance: cachedMexcAvailableBalance,
        livePositionSize,
        sizeRatio: `${sizeRatio.toFixed(1)}:1 (paper is ${sizeRatio.toFixed(1)}x larger)`,
      },

      paperSummary: {
        balance: paperState?.balance || 0,
        totalPnl: paperStats.totalPnl || 0,
        totalTrades: paperStats.totalTrades || 0,
        winRate: paperStats.winRate || 0,
        openPositions: paperPositions.length,
      },

      liveSummary: {
        cachedBalance: cachedMexcAvailableBalance,
        openPositions: livePositions.length,
        pendingOrders: pendingQueue.length,
        recentCloses: recentMexcCloses.length,
        // ACTUAL MEXC results (not paper simulation)
        mexcRealizedPnl: mexcTotalRealizedPnl,
        mexcTotalTrades,
        mexcWins,
        mexcLosses,
        mexcWinRate: mexcTotalTrades > 0 ? (mexcWins / mexcTotalTrades * 100) : 0,
      },

      positionComparison: comparison,

      recentMexcCloses,

      mexcQueue: recentQueue.map((o: QueuedOrder) => ({
        symbol: o.symbol,
        side: o.side,
        size: o.size,
        leverage: o.leverage,
        status: o.status,
        entryPrice: o.entryPrice,
        error: o.error,
        timestamp: o.timestamp,
      })),

      insights: (() => {
        const paperPnl = Number(paperStats.totalPnl) || 0;
        const scaledPaperPnl = paperPnl / sizeRatio;
        return [
          sizeRatio > 5 ? `⚠️ Paper positions are ${sizeRatio.toFixed(1)}x larger than live - scale paper PnL by /${sizeRatio.toFixed(1)} for comparison` : null,
          comparison.some(c => c.entryPriceDiff && Math.abs(c.entryPriceDiff) > 0.1) ? '⚠️ Entry price differences detected between paper and live' : null,
          comparison.some(c => c.slPriceDiff && Math.abs(c.slPriceDiff) > 0.5) ? '⚠️ Stop loss price differences detected' : null,
          comparison.some(c => c.paper && !c.live) ? '⚠️ Some paper positions have no live equivalent' : null,
          comparison.some(c => c.live && !c.paper) ? '⚠️ Some live positions have no paper equivalent (orphaned)' : null,
          // Compare paper scaled PnL vs actual MEXC PnL
          mexcTotalTrades > 0 && paperPnl > 0
            ? `📊 Paper PnL: $${paperPnl.toFixed(2)} → Scaled (/${sizeRatio.toFixed(1)}): $${scaledPaperPnl.toFixed(2)} | ACTUAL MEXC: $${mexcTotalRealizedPnl.toFixed(2)}`
            : null,
          mexcTotalTrades > 0 && Math.abs(scaledPaperPnl - mexcTotalRealizedPnl) > 5
            ? `🚨 DISCREPANCY: Scaled paper ($${scaledPaperPnl.toFixed(2)}) vs MEXC ($${mexcTotalRealizedPnl.toFixed(2)}) = $${(scaledPaperPnl - mexcTotalRealizedPnl).toFixed(2)} unexplained`
            : null,
        ].filter(Boolean);
      })(),
    });
  } catch (error) {
    res.json({ success: false, error: (error as Error).message });
  }
});

// ============================================================
// MEXC Bot Selection API
// ============================================================

// Get current bot selection and available bots with stats
app.get('/api/mexc/bot-selection', (req, res) => {
  // Focus shadow bots
  const focusAvailable = Array.from(focusShadowBots.entries()).map(([id, bot]) => {
    const stats = bot.getStats();
    return {
      id,
      group: 'focus',
      totalTrades: stats.totalTrades,
      openPositions: stats.openPositions,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      profitFactor: stats.profitFactor,
    };
  });

  // Experimental shadow bots
  const expAvailable = Array.from(experimentalBots.entries()).map(([id, bot]) => {
    const state = bot.getState();
    return {
      id,
      group: 'experimental',
      description: state.description,
      totalTrades: state.stats.totalTrades,
      openPositions: state.openPositions.length,
      winRate: state.stats.winRate,
      totalPnl: state.stats.totalPnl,
      profitFactor: state.stats.profitFactor,
    };
  });

  res.json({
    success: true,
    selected: serverSettings.mexcSelectedBots,
    positionSizeUsd: serverSettings.mexcPositionSizeUsd,
    maxPositionSizeUsd: serverSettings.mexcMaxPositionSizeUsd,
    positionSizeMode: serverSettings.mexcPositionSizeMode,
    positionSizePct: serverSettings.mexcPositionSizePct,
    maxLeverage: serverSettings.mexcMaxLeverage,
    autoExecute: serverSettings.mexcAutoExecute,
    cachedAvailableBalance: cachedMexcAvailableBalance,
    available: [...focusAvailable, ...expAvailable],
  });
});

// Update bot selection
app.post('/api/mexc/bot-selection', express.json(), (req, res) => {
  const { selectedBots, positionSizeUsd, positionSizeMode, positionSizePct,
          maxPositionSizeUsd, maxLeverage, autoExecute } = req.body;

  if (Array.isArray(selectedBots)) {
    // Validate all IDs exist in focusShadowBots or experimentalBots
    const validIds = selectedBots.filter((id: string) => focusShadowBots.has(id) || experimentalBots.has(id));
    serverSettings.mexcSelectedBots = validIds;
  }

  if (typeof positionSizeUsd === 'number' && positionSizeUsd > 0) {
    serverSettings.mexcPositionSizeUsd = Math.min(positionSizeUsd, serverSettings.mexcMaxPositionSizeUsd);
  }

  if (positionSizeMode === 'fixed' || positionSizeMode === 'percent') {
    serverSettings.mexcPositionSizeMode = positionSizeMode;
  }

  if (typeof positionSizePct === 'number' && positionSizePct > 0 && positionSizePct <= 100) {
    serverSettings.mexcPositionSizePct = positionSizePct;
  }

  if (typeof maxPositionSizeUsd === 'number' && maxPositionSizeUsd > 0) {
    serverSettings.mexcMaxPositionSizeUsd = maxPositionSizeUsd;
    // Re-cap current size if needed
    if (serverSettings.mexcPositionSizeUsd > maxPositionSizeUsd) {
      serverSettings.mexcPositionSizeUsd = maxPositionSizeUsd;
    }
  }

  if (typeof maxLeverage === 'number' && maxLeverage >= 1 && maxLeverage <= 200) {
    serverSettings.mexcMaxLeverage = maxLeverage;
  }

  if (typeof autoExecute === 'boolean') {
    serverSettings.mexcAutoExecute = autoExecute;
    if (autoExecute) {
      console.log(`[MEXC] ⚠️ AUTO-EXECUTE ENABLED — orders will execute automatically in live mode`);
    } else {
      console.log(`[MEXC] Auto-execute disabled — manual execution required`);
    }
  }

  // Update execution mode on experimental bots for trade logging
  for (const [botId, bot] of experimentalBots) {
    bot.setExecutionMode(getExecutionModeForBot(botId));
  }

  saveServerSettings();
  const sizeDesc = serverSettings.mexcPositionSizeMode === 'percent'
    ? `${serverSettings.mexcPositionSizePct}% of balance`
    : `$${serverSettings.mexcPositionSizeUsd}`;
  console.log(`[MEXC] Bot selection updated: ${serverSettings.mexcSelectedBots.join(', ') || '(none)'} | Size: ${sizeDesc} | MaxLev: ${serverSettings.mexcMaxLeverage}x | Auto: ${serverSettings.mexcAutoExecute}`);

  res.json({
    success: true,
    selected: serverSettings.mexcSelectedBots,
    positionSizeUsd: serverSettings.mexcPositionSizeUsd,
    maxPositionSizeUsd: serverSettings.mexcMaxPositionSizeUsd,
    positionSizeMode: serverSettings.mexcPositionSizeMode,
    positionSizePct: serverSettings.mexcPositionSizePct,
    maxLeverage: serverSettings.mexcMaxLeverage,
    autoExecute: serverSettings.mexcAutoExecute,
  });
});

// Toggle conditional insurance (stress-period protection)
app.post('/api/mexc/conditional-insurance', express.json(), (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    res.json({ success: false, error: 'enabled must be a boolean' });
    return;
  }

  serverSettings.conditionalInsuranceEnabled = enabled;

  // Apply to all experimental bots that support insurance
  for (const [botId, bot] of experimentalBots) {
    if (bot.isConditionalInsuranceEnabled !== undefined) {
      bot.setConditionalInsurance(enabled);
    }
  }

  saveServerSettings();

  const { winRate, sampleSize } = experimentalBots.get('exp-bb-sysB')?.getRecentWinRate() || { winRate: 0, sampleSize: 0 };

  console.log(`[INSURANCE] Conditional insurance ${enabled ? 'ENABLED' : 'DISABLED'} | Current WR: ${winRate.toFixed(0)}% (${sampleSize} trades)`);

  res.json({
    success: true,
    enabled: serverSettings.conditionalInsuranceEnabled,
    currentWinRate: winRate,
    sampleSize,
  });
});

// Get conditional insurance status
app.get('/api/mexc/conditional-insurance', (req, res) => {
  const bot = experimentalBots.get('exp-bb-sysB');
  const { winRate, sampleSize } = bot?.getRecentWinRate() || { winRate: 0, sampleSize: 0 };
  const isStress = winRate < 50 && sampleSize >= 3;

  res.json({
    enabled: serverSettings.conditionalInsuranceEnabled,
    currentWinRate: winRate,
    sampleSize,
    isStressPeriod: isStress,
    thresholdPercent: 2,  // Hardcoded for now, could make configurable
    stressWinRateThreshold: 50,
  });
});

// ============================================================
// MEXC Cookie Health Monitoring
// ============================================================

interface CookieHealthState {
  lastCheck: Date | null;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  isHealthy: boolean;
  lastError: string | null;
}

const cookieHealth: CookieHealthState = {
  lastCheck: null,
  lastSuccess: null,
  lastFailure: null,
  consecutiveFailures: 0,
  isHealthy: true,
  lastError: null,
};

// Send notification when cookie fails
async function notifyCookieFailure(error: string): Promise<void> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Try terminal-notifier first (most reliable on macOS)
    try {
      await execAsync(`terminal-notifier -title '🔴 MEXC Cookie Expired' -message '${error.replace(/'/g, "\\'")}' -subtitle 'Live trading disabled' -sound 'Basso'`);
    } catch {
      // Fall back to osascript
      await execAsync(`osascript -e 'display notification "${error.replace(/"/g, '\\"')}" with title "MEXC Cookie Expired" subtitle "Live trading disabled" sound name "Basso"'`);
    }
  } catch (err) {
    console.error('[MEXC-HEALTH] Failed to send notification:', err);
  }
}

// Check MEXC cookie health
async function checkCookieHealth(): Promise<boolean> {
  cookieHealth.lastCheck = new Date();

  const cookie = process.env.MEXC_UID_COOKIE;
  if (!cookie || cookie === 'WEB_your_uid_cookie_here') {
    // No cookie configured - not an error, just not set up
    cookieHealth.isHealthy = false;
    cookieHealth.lastError = 'Cookie not configured';
    return false;
  }

  try {
    const client = initMexcClient();
    if (!client) {
      cookieHealth.isHealthy = false;
      cookieHealth.lastError = 'Client initialization failed';
      return false;
    }

    const result = await client.testConnection();

    if (result.success) {
      // Reset failure count on success
      if (cookieHealth.consecutiveFailures > 0) {
        console.log(`[MEXC-HEALTH] Connection restored after ${cookieHealth.consecutiveFailures} failures`);
      }
      cookieHealth.lastSuccess = new Date();
      cookieHealth.consecutiveFailures = 0;
      cookieHealth.isHealthy = true;
      cookieHealth.lastError = null;
      return true;
    } else {
      cookieHealth.consecutiveFailures++;
      cookieHealth.lastFailure = new Date();
      cookieHealth.isHealthy = false;
      cookieHealth.lastError = result.error || 'Connection test failed';

      // Notify on first failure or every 3rd consecutive failure
      if (cookieHealth.consecutiveFailures === 1 || cookieHealth.consecutiveFailures % 3 === 0) {
        console.log(`[MEXC-HEALTH] Cookie failed (${cookieHealth.consecutiveFailures}x): ${cookieHealth.lastError}`);
        await notifyCookieFailure(cookieHealth.lastError);
      }
      return false;
    }
  } catch (err) {
    cookieHealth.consecutiveFailures++;
    cookieHealth.lastFailure = new Date();
    cookieHealth.isHealthy = false;
    cookieHealth.lastError = (err as Error).message;

    if (cookieHealth.consecutiveFailures === 1 || cookieHealth.consecutiveFailures % 3 === 0) {
      console.log(`[MEXC-HEALTH] Cookie check error (${cookieHealth.consecutiveFailures}x): ${cookieHealth.lastError}`);
      await notifyCookieFailure(cookieHealth.lastError);
    }
    return false;
  }
}

// MEXC order history endpoint - fetches real trade history from MEXC
app.get('/api/mexc/history', async (req, res) => {
  const client = initMexcClient();
  if (!client) {
    res.json({ success: false, error: 'MEXC client not configured' });
    return;
  }

  try {
    // Get all symbols we might have traded
    const positions = await client.getOpenPositions();
    const symbols = new Set<string>();

    // Add current positions
    if (positions.success && positions.data) {
      for (const pos of positions.data) {
        symbols.add(pos.symbol);
      }
    }

    // Fetch order history for each symbol
    const allTrades: Array<{
      symbol: string;
      side: string;
      entryPrice: number;
      exitPrice: number;
      volume: number;
      profit: number;
      leverage: number;
      createTime: number;
      closeTime: number;
    }> = [];

    // Also check recently closed symbols from our tracking
    const recentSymbols = ['LRC_USDT', 'ZRO_USDT', 'FUN_USDT', 'INIT_USDT', 'GPS_USDT', 'FORM_USDT'];
    for (const s of recentSymbols) symbols.add(s);

    for (const symbol of symbols) {
      try {
        const history = await client.getOrderHistory(symbol, 1, 50);
        if (history.success && history.data) {
          for (const order of history.data) {
            // Only include closed orders with realized profit
            if (order.state === 3 && order.profit !== 0) { // state 3 = filled
              allTrades.push({
                symbol: order.symbol,
                side: order.side === 1 || order.side === 4 ? 'long' : 'short',
                entryPrice: order.price,
                exitPrice: order.dealAvgPrice,
                volume: order.vol,
                profit: order.profit,
                leverage: order.leverage,
                createTime: order.createTime,
                closeTime: order.updateTime,
              });
            }
          }
        }
        // Rate limit between requests
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`[MEXC-HISTORY] Failed to fetch history for ${symbol}:`, (e as Error).message);
      }
    }

    // Sort by close time, most recent first
    allTrades.sort((a, b) => b.closeTime - a.closeTime);

    // Calculate summary
    const totalProfit = allTrades.reduce((sum, t) => sum + t.profit, 0);
    const wins = allTrades.filter(t => t.profit > 0).length;
    const losses = allTrades.filter(t => t.profit < 0).length;

    res.json({
      success: true,
      summary: {
        totalTrades: allTrades.length,
        totalProfit,
        wins,
        losses,
        winRate: allTrades.length > 0 ? (wins / allTrades.length * 100).toFixed(1) : 0,
      },
      trades: allTrades.slice(0, 100), // Return last 100 trades
    });
  } catch (error) {
    console.error('[MEXC-HISTORY] Error:', error);
    res.json({ success: false, error: (error as Error).message });
  }
});

// Cookie health check endpoint
app.get('/api/mexc/cookie-health', async (req, res) => {
  // Run a fresh check if requested
  if (req.query.refresh === 'true') {
    await checkCookieHealth();
  }

  res.json({
    success: true,
    health: {
      isHealthy: cookieHealth.isHealthy,
      lastCheck: cookieHealth.lastCheck?.toISOString() || null,
      lastSuccess: cookieHealth.lastSuccess?.toISOString() || null,
      lastFailure: cookieHealth.lastFailure?.toISOString() || null,
      consecutiveFailures: cookieHealth.consecutiveFailures,
      lastError: cookieHealth.lastError,
      cookieConfigured: !!process.env.MEXC_UID_COOKIE && process.env.MEXC_UID_COOKIE !== 'WEB_your_uid_cookie_here',
    },
  });
});

// Start periodic cookie health check (every 30 minutes)
// Only runs in production to avoid unnecessary API calls during dev
if (process.env.NODE_ENV === 'production') {
  // Initial check after 1 minute (give server time to start)
  setTimeout(() => {
    checkCookieHealth().then(healthy => {
      console.log(`[MEXC-HEALTH] Initial check: ${healthy ? 'healthy' : 'unhealthy'}`);
    });
  }, 60 * 1000);

  // Then check every 30 minutes
  setInterval(() => {
    checkCookieHealth().then(healthy => {
      if (!healthy) {
        console.log(`[MEXC-HEALTH] Periodic check failed - cookie may need refresh`);
      }
    });
  }, 30 * 60 * 1000);

  console.log('[MEXC-HEALTH] Cookie health monitoring enabled (30min interval)');
}

// Periodic balance refresh for % position sizing (every 5 minutes)
// Runs in all environments since it's needed for queue-time sizing
setInterval(async () => {
  if (serverSettings.mexcPositionSizeMode === 'percent') {
    const bal = await fetchMexcBalance();
    if (bal) {
      console.log(`[MEXC] Balance refreshed for % sizing: $${bal.available.toFixed(2)} available`);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// End MEXC Live Execution API Routes
// ============================================================

// Serve static HTML - Screener (main page)
app.get('/', (req, res) => {
  res.send(getHtmlPage());
});

// Focus Mode Dashboard (contrarian trading)
app.get('/focus', (req, res) => {
  const configKey = req.query.config as string;
  const windowHours = parseInt(req.query.window as string) || 4;
  res.send(getFocusModeHtml(configKey, windowHours));
});

// Focus Mode API
app.get('/api/focus-mode', (req, res) => {
  const configKey = req.query.config as string;
  res.json(getFocusModeApiData(configKey));
});

// Momentum Exhaustion API - returns all extended coins
app.get('/api/exhaustion', (req, res) => {
  const signals = getAllExhaustionSignals();
  res.json({
    timestamp: new Date().toISOString(),
    count: signals.length,
    signals: signals.map(s => ({
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: s.direction,
      impulsePercent: s.impulsePercent,
      currentRSI: s.currentRSI,
      currentPrice: s.currentPrice,
      detectedAt: new Date(s.detectedAt).toISOString(),
      lastUpdated: new Date(s.lastUpdated).toISOString(),
      ageMinutes: Math.round((Date.now() - s.detectedAt) / 60000),
    })),
  });
});

// Check exhaustion for a specific symbol
app.get('/api/exhaustion/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const longExhaustion = checkMomentumExhaustion(symbol, 'long');
  const shortExhaustion = checkMomentumExhaustion(symbol, 'short');

  res.json({
    symbol,
    timestamp: new Date().toISOString(),
    longBlocked: !!longExhaustion,
    shortBlocked: !!shortExhaustion,
    longExhaustion: longExhaustion ? {
      timeframe: longExhaustion.timeframe,
      direction: longExhaustion.direction,
      impulsePercent: longExhaustion.impulsePercent,
      currentRSI: longExhaustion.currentRSI,
    } : null,
    shortExhaustion: shortExhaustion ? {
      timeframe: shortExhaustion.timeframe,
      direction: shortExhaustion.direction,
      impulsePercent: shortExhaustion.impulsePercent,
      currentRSI: shortExhaustion.currentRSI,
    } : null,
  });
});

// API endpoints
app.get('/api/state', (req, res) => {
  res.json(getFullState());
});

app.get('/api/stats', (req, res) => {
  res.json({
    fixedTP: fixedTPBot.getStats(),
    trailing1pct: trailing1pctBot.getStats(),
    trailing10pct10x: trailing10pct10xBot.getStats(),
    trailing10pct20x: trailing10pct20xBot.getStats(),
  });
});

// Reset specific bot or all bots
app.post('/api/reset', express.json(), (req, res) => {
  const bot = req.body?.bot;
  if (bot === 'fixedTP') {
    fixedTPBot.reset();
    res.json({ success: true, bot: 'fixedTP', balance: fixedTPBot.getBalance() });
  } else if (bot === 'trailing1pct') {
    trailing1pctBot.reset();
    res.json({ success: true, bot: 'trailing1pct', balance: trailing1pctBot.getBalance() });
  } else if (bot === 'trailing10pct10x') {
    trailing10pct10xBot.reset();
    res.json({ success: true, bot: 'trailing10pct10x', balance: trailing10pct10xBot.getBalance() });
  } else if (bot === 'trailing10pct20x') {
    trailing10pct20xBot.reset();
    res.json({ success: true, bot: 'trailing10pct20x', balance: trailing10pct20xBot.getBalance() });
  } else if (bot === 'trailWide') {
    trailWideBot.reset();
    res.json({ success: true, bot: 'trailWide', balance: trailWideBot.getBalance() });
  } else if (bot === 'confluence') {
    confluenceBot.reset();
    res.json({ success: true, bot: 'confluence', balance: confluenceBot.getBalance() });
  } else if (bot === 'btcExtreme') {
    btcExtremeBot.reset();
    res.json({ success: true, bot: 'btcExtreme', balance: btcExtremeBot.getBalance() });
  } else if (bot === 'btcTrend') {
    btcTrendBot.reset();
    res.json({ success: true, bot: 'btcTrend', balance: btcTrendBot.getBalance() });
  } else if (mexcSimBots.has(bot)) {
    const mexcBot = mexcSimBots.get(bot)!;
    mexcBot.reset();
    res.json({ success: true, bot, balance: mexcBot.getBalance() });
  } else if (bot && bot.startsWith('shadow-')) {
    // Reset specific shadow bot
    const shadowBot = shadowBots.find(s => s.id === bot);
    if (shadowBot) {
      shadowBot.bot.reset();
      res.json({ success: true, bot, balance: shadowBot.bot.getBalance() });
    } else {
      res.status(404).json({ success: false, error: 'Shadow bot not found' });
    }
  } else {
    // Reset all bots
    fixedTPBot.reset();
    trailing1pctBot.reset();
    trailing10pct10xBot.reset();
    trailing10pct20xBot.reset();
    trailWideBot.reset();
    confluenceBot.reset();
    btcExtremeBot.reset();
    btcTrendBot.reset();
    // Reset MEXC simulation bots
    for (const [, mexcBot] of mexcSimBots) {
      mexcBot.reset();
    }
    // Reset shadow bots
    for (const { bot: shadowBot } of shadowBots) {
      shadowBot.reset();
    }
    // Reset timeframe strategy shadow bots
    for (const { bot: tfBot } of timeframeShadowBots) {
      tfBot.reset();
    }
    // Reset combined strategy bot
    combinedStrategyBot.reset();
    // Reset GP shadow bots
    for (const { bot } of gpShadowBots) {
      bot.reset();
    }
    res.json({
      success: true,
      bot: 'all',
      balances: {
        fixedTP: fixedTPBot.getBalance(),
        trailing1pct: trailing1pctBot.getBalance(),
        trailing10pct10x: trailing10pct10xBot.getBalance(),
        trailing10pct20x: trailing10pct20xBot.getBalance(),
        trailWide: trailWideBot.getBalance(),
        confluence: confluenceBot.getBalance(),
        btcExtreme: btcExtremeBot.getBalance(),
        btcTrend: btcTrendBot.getBalance(),
        ...Object.fromEntries(Array.from(mexcSimBots.entries()).map(([k, b]) => [k, b.getBalance()])),
        ...Object.fromEntries(shadowBots.map(s => [s.id, s.bot.getBalance()])),
        ...Object.fromEntries(timeframeShadowBots.map(s => [s.id, s.bot.getBalance()])),
        ...Object.fromEntries(gpShadowBots.map(s => [s.id, s.bot.getBalance()])),
        [combinedStrategyBot.getBotId()]: combinedStrategyBot.getBalance(),
      },
    });
  }
  broadcastState();
});

// Daily reset settings API
app.get('/api/daily-reset', (req, res) => {
  res.json({
    enabled: serverSettings.dailyResetEnabled,
    lastResetDate: serverSettings.lastResetDate,
    currentDate: getCurrentDateString(),
  });
});

app.post('/api/daily-reset', express.json(), (req, res) => {
  const { enabled, triggerNow } = req.body;

  // Update setting if provided
  if (typeof enabled === 'boolean') {
    serverSettings.dailyResetEnabled = enabled;
    saveServerSettings();
    console.log(`[SETTINGS] Daily reset ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  // Trigger immediate reset if requested
  if (triggerNow === true) {
    resetAllBots();
    broadcastState();
  }

  res.json({
    success: true,
    enabled: serverSettings.dailyResetEnabled,
    lastResetDate: serverSettings.lastResetDate,
  });
});

// Notification & Sound settings API
app.get('/api/notification-settings', (req, res) => {
  res.json({
    notificationsEnabled: serverSettings.notificationsEnabled,
    soundEnabled: serverSettings.soundEnabled,
    botNotifications: serverSettings.botNotifications,
  });
});

app.post('/api/notification-settings', express.json(), (req, res) => {
  const { notificationsEnabled, soundEnabled, botNotifications } = req.body;

  if (typeof notificationsEnabled === 'boolean') {
    serverSettings.notificationsEnabled = notificationsEnabled;
    console.log(`[SETTINGS] Notifications ${notificationsEnabled ? 'ENABLED' : 'DISABLED'}`);
  }

  if (typeof soundEnabled === 'boolean') {
    serverSettings.soundEnabled = soundEnabled;
    console.log(`[SETTINGS] Sound ${soundEnabled ? 'ENABLED' : 'DISABLED'}`);
  }

  // Update individual bot notification settings
  if (botNotifications && typeof botNotifications === 'object') {
    for (const [botId, enabled] of Object.entries(botNotifications)) {
      if (typeof enabled === 'boolean') {
        serverSettings.botNotifications[botId] = enabled;
        console.log(`[SETTINGS] Bot ${botId} notifications ${enabled ? 'ENABLED' : 'DISABLED'}`);
      }
    }
  }

  saveServerSettings();

  res.json({
    success: true,
    notificationsEnabled: serverSettings.notificationsEnabled,
    soundEnabled: serverSettings.soundEnabled,
    botNotifications: serverSettings.botNotifications,
  });
});

// Investment Amount API - sync with real MEXC investment
app.get('/api/investment-amount', (req, res) => {
  res.json({
    amount: serverSettings.investmentAmount,
  });
});

app.post('/api/investment-amount', express.json(), (req, res) => {
  const { amount, resetBots } = req.body;

  if (typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'Invalid amount - must be a positive number' });
    return;
  }

  // Update all bots with the new initial balance
  updateAllBotsInitialBalance(amount);

  // Optionally reset all bots to start fresh with the new balance
  if (resetBots === true) {
    console.log('[INVESTMENT] Resetting all bots with new investment amount');
    fixedTPBot.reset();
    fixedBreakevenBot.reset();
    trailing1pctBot.reset();
    trailing10pct10xBot.reset();
    trailing10pct20xBot.reset();
    trailWideBot.reset();
    confluenceBot.reset();
    btcExtremeBot.reset();
    btcTrendBot.reset();
    trendOverrideBot.reset();
    trendFlipBot.reset();
    combinedStrategyBot.reset();
    for (const { bot } of shadowBots) bot.reset();
    for (const { bot } of timeframeShadowBots) bot.reset();
    for (const { bot } of gpShadowBots) bot.reset();
    for (const [, bot] of goldenPocketBots) bot.reset();
    for (const [, bot] of goldenPocketBotsV2) bot.reset();
    for (const [, bot] of fadeBots) bot.reset();
    for (const [, bot] of mexcSimBots) bot.reset();
    for (const [, bot] of focusShadowBots) bot.reset();
    for (const [, bot] of experimentalBots) bot.reset();
  }

  broadcastState();

  res.json({
    success: true,
    amount: serverSettings.investmentAmount,
    botsReset: resetBots === true,
  });
});

// Toggle bot visibility
app.post('/api/toggle-bot', express.json(), (req, res) => {
  const { bot, visible } = req.body;
  if (bot === 'fixedTP') {
    botVisibility.fixedTP = visible !== false;
    res.json({ success: true, bot: 'fixedTP', visible: botVisibility.fixedTP });
  } else if (bot === 'trailing1pct') {
    botVisibility.trailing1pct = visible !== false;
    res.json({ success: true, bot: 'trailing1pct', visible: botVisibility.trailing1pct });
  } else if (bot === 'trailing10pct10x') {
    botVisibility.trailing10pct10x = visible !== false;
    res.json({ success: true, bot: 'trailing10pct10x', visible: botVisibility.trailing10pct10x });
  } else if (bot === 'trailing10pct20x') {
    botVisibility.trailing10pct20x = visible !== false;
    res.json({ success: true, bot: 'trailing10pct20x', visible: botVisibility.trailing10pct20x });
  } else if (bot === 'trailWide') {
    botVisibility.trailWide = visible !== false;
    res.json({ success: true, bot: 'trailWide', visible: botVisibility.trailWide });
  } else if (bot === 'confluence') {
    botVisibility.confluence = visible !== false;
    res.json({ success: true, bot: 'confluence', visible: botVisibility.confluence });
  } else if (bot === 'btcExtreme') {
    botVisibility.btcExtreme = visible !== false;
    res.json({ success: true, bot: 'btcExtreme', visible: botVisibility.btcExtreme });
  } else if (bot === 'btcTrend') {
    botVisibility.btcTrend = visible !== false;
    res.json({ success: true, bot: 'btcTrend', visible: botVisibility.btcTrend });
  } else if (bot === 'trendOverride') {
    botVisibility.trendOverride = visible !== false;
    res.json({ success: true, bot: 'trendOverride', visible: botVisibility.trendOverride });
  } else if (bot === 'trendFlip') {
    botVisibility.trendFlip = visible !== false;
    res.json({ success: true, bot: 'trendFlip', visible: botVisibility.trendFlip });
  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
  } else {
    res.status(400).json({ error: 'Invalid bot name' });
    return;
  }
  broadcastState();
});

// Check a specific symbol on demand
app.get('/api/check/:symbol', async (req, res) => {
  try {
    let symbol = req.params.symbol.toUpperCase().trim();
    if (!symbol.endsWith('USDT')) {
      symbol = symbol + 'USDT';
    }
    const futuresSymbol = spotSymbolToFutures(symbol);
    const timeframes: Timeframe[] = ['5m', '15m', '1h'];

    const detector = new BackburnerDetector({
      rsiPeriod: DEFAULT_CONFIG.rsiPeriod,
      rsiOversoldThreshold: DEFAULT_CONFIG.rsiOversoldThreshold,
      rsiOverboughtThreshold: DEFAULT_CONFIG.rsiOverboughtThreshold,
      minImpulsePercent: DEFAULT_CONFIG.minImpulsePercent,
    });

    const results: any[] = [];

    for (const marketType of ['spot', 'futures'] as const) {
      for (const timeframe of timeframes) {
        try {
          const candles = marketType === 'spot'
            ? await getKlines(symbol, timeframe)
            : await getFuturesKlines(futuresSymbol, timeframe);

          if (!candles || candles.length < 50) {
            results.push({
              symbol,
              marketType,
              timeframe,
              error: 'Insufficient data',
            });
            continue;
          }

          // RSI on closed candles only (exclude forming candle for consistency with detectors)
          const closedCandles = candles.slice(0, -1);
          const currentRSI = getCurrentRSI(closedCandles, DEFAULT_CONFIG.rsiPeriod);
          const currentPrice = candles[candles.length - 1].close;
          const setups = detector.analyzeSymbol(symbol, timeframe, candles);
          const activeSetup = setups.find(s => s.state !== 'played_out');

          results.push({
            symbol,
            marketType,
            timeframe,
            currentPrice,
            currentRSI: currentRSI?.toFixed(1),
            rsiZone: currentRSI !== null
              ? currentRSI < 30 ? 'oversold'
              : currentRSI > 70 ? 'overbought'
              : currentRSI < 40 ? 'low'
              : currentRSI > 60 ? 'high'
              : 'neutral'
              : 'unknown',
            setup: activeSetup ? {
              direction: activeSetup.direction,
              state: activeSetup.state,
              entryPrice: activeSetup.entryPrice,
              impulsePercent: activeSetup.impulsePercentMove,
            } : null,
          });
        } catch (error) {
          results.push({
            symbol,
            marketType,
            timeframe,
            error: (error as Error).message,
          });
        }
      }
    }

    res.json({
      symbol,
      timestamp: Date.now(),
      results,
      activeSetups: detector.getActiveSetups(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Price proxy endpoint for Focus Mode position monitor
app.get('/api/prices', async (req, res) => {
  try {
    const symbols = (req.query.symbols as string)?.split(',') || [];
    if (symbols.length === 0) {
      return res.json({ prices: {} });
    }

    const prices: Record<string, number> = {};

    for (const symbol of symbols) {
      try {
        // Use MEXC API via our existing functions (works with rate limiting)
        const price = await getPrice(symbol, 'futures');
        if (price && price > 0) {
          prices[symbol] = price;
        }
      } catch (e) {
        console.log(`Failed to fetch price for ${symbol}:`, e);
      }
    }

    res.json({ prices });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// BTC RSI cache to avoid rate limiter contention
let btcRsiCache: { data: unknown; timestamp: number } | null = null;
const BTC_RSI_CACHE_MS = 30000; // Cache for 30 seconds

// BTC RSI multi-timeframe endpoint for chart
app.get('/api/btc-rsi', async (req, res) => {
  try {
    // Return cached data if fresh enough
    if (btcRsiCache && Date.now() - btcRsiCache.timestamp < BTC_RSI_CACHE_MS) {
      return res.json(btcRsiCache.data);
    }

    const timeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
    const rsiPeriod = 14;
    const smaPeriod = 9; // SMA of RSI for crossover signals
    const dataPoints = 100; // Last 100 data points per timeframe

    const results: Record<string, {
      timeframe: string;
      rsi: { timestamp: number; value: number }[];
      rsiSMA: { timestamp: number; value: number }[];
      current: { rsi: number; sma: number; signal: 'bullish' | 'bearish' | 'neutral' };
      divergence: {
        type: string | null;
        strength: string | null;
        description: string | null;
      } | null;
    }> = {};

    for (const tf of timeframes) {
      try {
        const candles = await getKlines('BTCUSDT', tf, 200);
        if (!candles || candles.length < 50) continue;

        // RSI on closed candles only (exclude forming candle)
        const closedCandles = candles.slice(0, -1);
        const rsiValues = calculateRSI(closedCandles, rsiPeriod);
        const rsiNumbers = rsiValues.map(r => r.value);
        const smaValues = calculateSMA(rsiNumbers, smaPeriod);

        // Detect divergence
        const divergence = detectDivergence(closedCandles, rsiValues, 50, 5);

        // Align SMA with RSI timestamps (SMA starts smaPeriod-1 later)
        const alignedRSI = rsiValues.slice(-dataPoints);
        const alignedSMA = smaValues.slice(-(dataPoints));

        // Pad SMA array to match RSI length if needed
        const smaPadded = alignedSMA.map((val, i) => ({
          timestamp: alignedRSI[i + (alignedRSI.length - alignedSMA.length)]?.timestamp || 0,
          value: val,
        })).filter(s => s.timestamp > 0);

        const currentRSI = rsiNumbers[rsiNumbers.length - 1];
        const currentSMA = smaValues[smaValues.length - 1];
        const prevRSI = rsiNumbers[rsiNumbers.length - 2];
        const prevSMA = smaValues[smaValues.length - 2];

        // Determine signal based on RSI crossing SMA
        let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (currentRSI > currentSMA && prevRSI <= prevSMA) {
          signal = 'bullish'; // Just crossed above
        } else if (currentRSI < currentSMA && prevRSI >= prevSMA) {
          signal = 'bearish'; // Just crossed below
        } else if (currentRSI > currentSMA) {
          signal = 'bullish'; // Above SMA
        } else if (currentRSI < currentSMA) {
          signal = 'bearish'; // Below SMA
        }

        results[tf] = {
          timeframe: tf,
          rsi: alignedRSI.map(r => ({ timestamp: r.timestamp, value: r.value })),
          rsiSMA: smaPadded,
          current: {
            rsi: Math.round(currentRSI * 100) / 100,
            sma: Math.round(currentSMA * 100) / 100,
            signal,
          },
          divergence: divergence ? {
            type: divergence.type,
            strength: divergence.strength,
            description: divergence.description,
          } : null,
        };
      } catch (err) {
        console.error(`Error fetching BTC RSI for ${tf}:`, err);
      }
    }

    // Calculate market bias based on timeframe signals
    // Higher timeframes have more weight
    const weights: Record<string, number> = {
      '4h': 3,   // Highest weight - major trend
      '1h': 2,   // Medium weight - intermediate trend
      '15m': 1,  // Lower weight - short-term
      '5m': 0.5, // Minimal weight - noise
      '1m': 0.25, // Least weight - most noise
    };

    let bullishScore = 0;
    let bearishScore = 0;
    let totalWeight = 0;

    for (const tf of Object.keys(results)) {
      const signal = results[tf].current.signal;
      const weight = weights[tf] || 1;
      totalWeight += weight;

      if (signal === 'bullish') {
        bullishScore += weight;
      } else if (signal === 'bearish') {
        bearishScore += weight;
      }
    }

    // Calculate bias percentage (-100 to +100)
    const biasScore = totalWeight > 0
      ? ((bullishScore - bearishScore) / totalWeight) * 100
      : 0;

    // Determine overall bias
    let marketBias: 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short' = 'neutral';
    let biasReason = '';

    const htfBullish = results['4h']?.current.signal === 'bullish' && results['1h']?.current.signal === 'bullish';
    const htfBearish = results['4h']?.current.signal === 'bearish' && results['1h']?.current.signal === 'bearish';
    const ltfBullish = results['15m']?.current.signal === 'bullish' && results['5m']?.current.signal === 'bullish';
    const ltfBearish = results['15m']?.current.signal === 'bearish' && results['5m']?.current.signal === 'bearish';

    if (htfBullish && ltfBullish) {
      marketBias = 'strong_long';
      biasReason = 'All timeframes aligned bullish';
    } else if (htfBearish && ltfBearish) {
      marketBias = 'strong_short';
      biasReason = 'All timeframes aligned bearish';
    } else if (htfBullish) {
      marketBias = 'long';
      biasReason = '4H & 1H bullish - favor longs';
    } else if (htfBearish) {
      marketBias = 'short';
      biasReason = '4H & 1H bearish - favor shorts';
    } else if (biasScore > 30) {
      marketBias = 'long';
      biasReason = 'Majority timeframes bullish';
    } else if (biasScore < -30) {
      marketBias = 'short';
      biasReason = 'Majority timeframes bearish';
    } else {
      marketBias = 'neutral';
      biasReason = 'Mixed signals - no clear bias';
    }

    // Store global BTC bias for trend override bots
    currentBtcBias = marketBias;

    // Update BTC Extreme Bot with current RSI data
    const btcPrice = await getCurrentPrice('BTCUSDT');
    if (btcPrice && results['4h'] && results['1h'] && results['15m'] && results['5m'] && results['1m']) {
      // Store globally for hourly snapshots
      lastBtcPrice = btcPrice;
      lastBtcRsiData = {
        '4h': results['4h'].current.rsi,
        '1h': results['1h'].current.rsi,
        '15m': results['15m'].current.rsi,
        '5m': results['5m'].current.rsi,
        '1m': results['1m'].current.rsi,
      };

      const rsiData = {
        rsi4h: results['4h'].current.rsi,
        rsi1h: results['1h'].current.rsi,
        rsi15m: results['15m'].current.rsi,
        rsi5m: results['5m'].current.rsi,
        rsi1m: results['1m'].current.rsi,
        bias: marketBias,
        biasScore: biasScore,
      };
      btcExtremeBot.update(btcPrice, rsiData);
      btcTrendBot.update(btcPrice, rsiData);

      // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md

      // Update BTC Bias V2 bots (all 8 V2 variants - conservative params)
      for (const [botKey, bot] of btcBiasBotsV2) {
        bot.processBiasUpdate(marketBias as BiasLevel, btcPrice, biasScore);
      }

      // Log market snapshot for analytics (rate-limited internally)
      const activeSetups = screener.getActiveSetups();
      getDataPersistence().logMarketSnapshot({
        btcPrice,
        btcRsi: {
          rsi4h: rsiData.rsi4h,
          rsi1h: rsiData.rsi1h,
          rsi15m: rsiData.rsi15m,
          rsi5m: rsiData.rsi5m,
          rsi1m: rsiData.rsi1m,
        },
        marketBias,
        biasScore,
        activeSetups: {
          total: activeSetups.length,
          triggered: activeSetups.filter(s => s.state === 'triggered').length,
          deepExtreme: activeSetups.filter(s => s.state === 'deep_extreme').length,
          byDirection: {
            long: activeSetups.filter(s => s.direction === 'long').length,
            short: activeSetups.filter(s => s.direction === 'short').length,
          },
        },
      });
    }

    // Calculate momentum indicators from 1h candles (most relevant for trading)
    let momentum: {
      price?: number;
      change1h?: number;
      change4h?: number;
      change24h?: number;
      atrPercent?: number;
      volumeRatio?: number;
      rangePosition?: number;
      isChoppy?: boolean;
    } = {};

    try {
      // Get more candles for 24h data (need ~24 candles for 1h timeframe)
      const candles1h = await getKlines('BTCUSDT', '1h', 50);
      if (candles1h && candles1h.length >= 25) {
        const currentPrice = candles1h[candles1h.length - 1].close;
        const price1hAgo = candles1h[candles1h.length - 2].close;
        const price4hAgo = candles1h[candles1h.length - 5]?.close || price1hAgo;
        const price24hAgo = candles1h[candles1h.length - 25]?.close || price4hAgo;

        momentum.price = currentPrice;
        momentum.change1h = ((currentPrice - price1hAgo) / price1hAgo) * 100;
        momentum.change4h = ((currentPrice - price4hAgo) / price4hAgo) * 100;
        momentum.change24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

        // Calculate ATR (14-period) as % of price
        const atrPeriod = 14;
        const recentCandles = candles1h.slice(-atrPeriod - 1);
        let atrSum = 0;
        for (let i = 1; i < recentCandles.length; i++) {
          const high = recentCandles[i].high;
          const low = recentCandles[i].low;
          const prevClose = recentCandles[i - 1].close;
          const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
          atrSum += tr;
        }
        const atr = atrSum / atrPeriod;
        momentum.atrPercent = (atr / currentPrice) * 100;

        // Volume ratio: current volume vs 20-period average
        const recentVol = candles1h.slice(-20);
        const avgVolume = recentVol.reduce((sum, c) => sum + c.volume, 0) / 20;
        const currentVolume = candles1h[candles1h.length - 1].volume;
        momentum.volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

        // 24h range position: where is price in the high-low range?
        const last24h = candles1h.slice(-24);
        const high24h = Math.max(...last24h.map(c => c.high));
        const low24h = Math.min(...last24h.map(c => c.low));
        const range = high24h - low24h;
        momentum.rangePosition = range > 0 ? ((currentPrice - low24h) / range) * 100 : 50;

        // Choppy market detection: many direction changes, low net movement
        // If we moved back and forth but ended up < 1% from start, it's choppy
        const netMove = Math.abs(momentum.change24h || 0);
        const totalMove = last24h.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
        const efficiency = (netMove / (totalMove / currentPrice * 100)) || 0;
        momentum.isChoppy = netMove < 2 && efficiency < 0.3;
      }
    } catch (err) {
      console.error('Error calculating momentum:', err);
    }

    const responseData = {
      symbol: 'BTCUSDT',
      timestamp: Date.now(),
      timeframes: results,
      marketBias: {
        bias: marketBias,
        score: Math.round(biasScore),
        reason: biasReason,
        details: {
          bullishScore: Math.round(bullishScore * 100) / 100,
          bearishScore: Math.round(bearishScore * 100) / 100,
          htfBullish,
          htfBearish,
          ltfBullish,
          ltfBearish,
        },
      },
      momentum,
    };

    // Cache the response
    btcRsiCache = { data: responseData, timestamp: Date.now() };

    res.json(responseData);
  } catch (error) {
    console.error('[BTC RSI] Error:', (error as Error).message);
    // On error, return cached data if available (even if stale)
    if (btcRsiCache) {
      console.log('[BTC RSI] Returning stale cache due to error');
      return res.json(btcRsiCache.data);
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// System B Bias endpoint - Multi-indicator bias (funding rate, OI, etc)
app.get('/api/bias-system-b', async (req, res) => {
  try {
    const systemB = getMarketBiasSystemB();

    // Get RSI data to pass to System B (it combines with other indicators)
    const rsiData: Record<string, { rsi: number; signal: string }> = {};
    const timeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

    for (const tf of timeframes) {
      try {
        const candles = await getKlines('BTCUSDT', tf, 50);
        if (candles && candles.length >= 20) {
          // RSI on closed candles only (exclude forming candle)
          const closedCandles = candles.slice(0, -1);
          const rsiResults = calculateRSI(closedCandles, 14);
          if (rsiResults.length > 0) {
            const currentRsi = rsiResults[rsiResults.length - 1].value;
            const rsiValues = rsiResults.map(r => r.value);
            const rsiSma = calculateSMA(rsiValues.slice(-9), 9);
            const signal = currentRsi > rsiSma[rsiSma.length - 1] ? 'bullish' : 'bearish';
            rsiData[tf] = { rsi: currentRsi, signal };
          }
        }
      } catch (e) {
        // Skip timeframe on error
      }
    }

    const result = await systemB.calculateBias(Object.keys(rsiData).length > 0 ? rsiData : undefined);

    res.json({
      success: true,
      systemB: {
        bias: result.bias,
        score: result.score,
        confidence: result.confidence,
        reason: result.reason,
        indicators: result.indicators,
        marketData: result.marketData ? {
          price: result.marketData.lastPrice,
          fundingRate: (result.marketData.fundingRate * 100).toFixed(4) + '%',
          openInterest: result.marketData.openInterest,
          volume24h: result.marketData.volume24h,
          priceChange24h: result.marketData.priceChange24h.toFixed(2) + '%',
        } : null,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Database query endpoint (read-only, for external analysis)
app.get('/api/db-stats', async (req, res) => {
  const result = await getDatabaseStats();
  res.json(result);
});

// Export trades as CSV
app.get('/api/export-trades', async (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const botId = req.query.bot as string;

  // Calculate date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  let sql = `SELECT * FROM trade_events WHERE date >= ? AND date <= ?`;
  const args: (string | number)[] = [
    startDate.toISOString().split('T')[0],
    endDate.toISOString().split('T')[0],
  ];

  if (botId) {
    sql += ` AND bot_id = ?`;
    args.push(botId);
  }

  sql += ` ORDER BY timestamp DESC`;

  const result = await executeReadQuery(sql, args);

  if (!result.success || !result.rows) {
    res.status(500).json({ success: false, error: result.error || 'Query failed' });
    return;
  }

  // Convert to CSV
  if (result.rows.length === 0) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trades_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
    res.send('No trades found in the specified date range');
    return;
  }

  // Get columns from first row
  const columns = result.columns || Object.keys(result.rows[0] as Record<string, unknown>);
  const csvRows = [columns.join(',')];

  for (const row of result.rows) {
    const values = columns.map((col: string) => {
      const val = (row as Record<string, unknown>)[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return String(val);
    });
    csvRows.push(values.join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="trades_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
  res.send(csvRows.join('\n'));
});

app.post('/api/query-db', express.json(), async (req, res) => {
  const { sql, args } = req.body;

  if (!sql || typeof sql !== 'string') {
    res.status(400).json({ success: false, error: 'SQL query required' });
    return;
  }

  const result = await executeReadQuery(sql, args || []);
  res.json(result);
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  // Send initial state
  res.write(`event: state\ndata: ${JSON.stringify(getFullState())}\n\n`);

  req.on('close', () => {
    clients.delete(res);
  });
});

// HTML page with embedded styles and scripts
function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backburner Screener</title>
  <link rel="stylesheet" href="/static/css/dashboard.css">
</head>
<body>
  <div class="container">
    <!-- Navigation Tabs -->
    <nav class="nav-tabs">
      <a href="/" class="nav-tab active">
        <span class="tab-icon">📊</span>Screener
      </a>
      <a href="/focus" class="nav-tab">
        <span class="tab-icon">🎯</span>Focus Mode
      </a>
    </nav>

    <header>
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div>
          <h1>🔥 Backburner Screener</h1>
          <p class="subtitle">TCG Strategy Scanner | MEXC Spot + Futures | Paper Trading</p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="symbolSearch" placeholder="Check symbol (e.g. RENDER)"
            style="padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #c9d1d9; font-size: 14px; width: 180px;">
          <button onclick="checkSymbol()" id="checkBtn"
            style="padding: 8px 16px; border-radius: 6px; border: none; background: #238636; color: white; font-weight: 600; cursor: pointer;">
            Check
          </button>
          <button onclick="openGuide()" title="Trading Guide"
            style="padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-weight: 600; cursor: pointer;">
            ?
          </button>
          <button onclick="openSettings()" title="Settings"
            style="padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-weight: 600; cursor: pointer;">
            ⚙️
          </button>
        </div>
      </div>
    </header>

    <!-- Symbol check modal -->
    <div id="checkModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 20px; overflow-y: auto;">
      <div style="max-width: 600px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 id="checkTitle" style="color: #58a6ff;">Symbol Analysis</h2>
          <button onclick="closeModal()" style="background: none; border: none; color: #8b949e; font-size: 24px; cursor: pointer;">&times;</button>
        </div>
        <div id="checkResults">Loading...</div>
      </div>
    </div>

    <!-- Trading Guide modal -->
    <div id="guideModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 20px; overflow-y: auto;">
      <div style="max-width: 700px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2 style="color: #58a6ff; margin: 0;">Trading Guide</h2>
          <button onclick="closeGuide()" style="background: none; border: none; color: #8b949e; font-size: 24px; cursor: pointer;">&times;</button>
        </div>

        <div style="color: #c9d1d9; line-height: 1.6;">
          <h3 style="color: #f0883e; margin-top: 0;">🔥 Backburner Strategy</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">TCG's mean-reversion strategy - catching oversold/overbought extremes after impulse moves.</p>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Entry Conditions</h4>
          <ol style="margin: 0 0 16px 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #c9d1d9;">RSI Extreme</strong>: RSI ≤ 30 (oversold/long) or RSI ≥ 70 (overbought/short)</li>
            <li><strong style="color: #c9d1d9;">Impulse Move</strong>: Price moved ≥ 3% in direction of the extreme</li>
            <li><strong style="color: #c9d1d9;">Triggered</strong>: RSI crosses back above 30 (long) or below 70 (short)</li>
          </ol>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Setup States</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 16px;">
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span class="badge badge-extreme" style="background: #f85149;">extreme</span> RSI in extreme zone, waiting for trigger
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span class="badge badge-deep" style="background: #da3633;">deep extreme</span> RSI ≤ 20 or ≥ 80 (stronger signal)
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span class="badge badge-triggered" style="background: #238636;">triggered</span> Entry signal fired - position opened
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span class="badge badge-played_out" style="background: #6e7681;">played out</span> RSI normalized (50±5) - exit signal
            </div>
          </div>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Exit Conditions</h4>
          <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #3fb950;">RSI Played Out</strong>: RSI returns to neutral zone (45-55)</li>
            <li><strong style="color: #a371f7;">Trailing Stop</strong>: Price retraces after profit (locks in gains)</li>
            <li><strong style="color: #f85149;">Stop Loss</strong>: Initial -12% SL hit before trailing activates (V2: tighter stops)</li>
          </ul>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">RSI Divergence Reliability</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Divergences are shown as supplementary information only - they don't affect entry conditions.</p>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
            <thead>
              <tr style="border-bottom: 1px solid #30363d;">
                <th style="text-align: left; padding: 8px; color: #8b949e;">Timeframe</th>
                <th style="text-align: left; padding: 8px; color: #8b949e;">Reliability</th>
                <th style="text-align: left; padding: 8px; color: #8b949e;">Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr style="border-bottom: 1px solid #21262d;">
                <td style="padding: 8px;">1m, 5m</td>
                <td style="padding: 8px; color: #f85149;">Low</td>
                <td style="padding: 8px; color: #8b949e;">High noise, many false signals. Rare but short-lived.</td>
              </tr>
              <tr style="border-bottom: 1px solid #21262d;">
                <td style="padding: 8px;">15m</td>
                <td style="padding: 8px; color: #d29922;">Low-Medium</td>
                <td style="padding: 8px; color: #8b949e;">Best used to confirm higher TF signals.</td>
              </tr>
              <tr style="border-bottom: 1px solid #21262d;">
                <td style="padding: 8px;">1h</td>
                <td style="padding: 8px; color: #3fb950;">Medium</td>
                <td style="padding: 8px; color: #8b949e;">Minimum recommended for meaningful divergences.</td>
              </tr>
              <tr style="border-bottom: 1px solid #21262d;">
                <td style="padding: 8px;">4h</td>
                <td style="padding: 8px; color: #3fb950;">Medium-High</td>
                <td style="padding: 8px; color: #8b949e;">Good balance of quality and frequency.</td>
              </tr>
              <tr>
                <td style="padding: 8px;">Daily+</td>
                <td style="padding: 8px; color: #58a6ff;">High</td>
                <td style="padding: 8px; color: #8b949e;">Most reliable, but fewer opportunities.</td>
              </tr>
            </tbody>
          </table>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Divergence Types</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 20px;">
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #3fb950;">&#x2B06; Bullish</span>: Price lower low, RSI higher low (reversal)
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #f85149;">&#x2B07; Bearish</span>: Price higher high, RSI lower high (reversal)
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #58a6ff;">&#x2B06;H Hidden Bull</span>: Price higher low, RSI lower low (continuation)
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #ff7b72;">&#x2B07;H Hidden Bear</span>: Price lower high, RSI higher high (continuation)
            </div>
          </div>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Best Practices</h4>
          <ul style="margin: 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li>Multi-timeframe confirmation is ideal (e.g., 4h divergence + 1h confirmation)</li>
            <li>Strong trends can invalidate divergences - they can persist during parabolic moves</li>
            <li>Never use divergence alone - combine with other signals (RSI levels, volume, structure)</li>
            <li>Higher TF divergences are more trustworthy but take longer to play out</li>
          </ul>

          <h3 style="color: #f0883e; margin-top: 24px;">Trailing Stop Levels</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Trailing stops are based on <strong style="color: #c9d1d9;">ROI (return on margin)</strong>, not raw price change.</p>
          <ul style="margin: 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #c9d1d9;">L1</strong> (0%+): Triggered at 10% ROI - locks in breakeven</li>
            <li><strong style="color: #c9d1d9;">L2</strong> (10%+): Triggered at 20% ROI - locks in 10% ROI profit</li>
            <li><strong style="color: #c9d1d9;">L3</strong> (20%+): Triggered at 30% ROI - locks in 20% ROI profit</li>
            <li>And so on... each level locks in an additional 10% ROI</li>
          </ul>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">Bot Configurations</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Each bot runs independently with its own balance and settings.</p>

          <div style="display: grid; gap: 12px; font-size: 12px;">
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #238636;">
              <strong style="color: #3fb950;">🎯 Fixed 20/20</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">1% position, 10x leverage, 35% TP/12% SL (V2). Conservative with fixed exits. Exits on RSI played_out or setup removal.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #2ea043;">
              <strong style="color: #2ea043;">🛡️ Fixed BE (Breakeven Lock)</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">1% position, 10x leverage, 35% TP (V2). <strong style="color: #c9d1d9;">SL moves to breakeven at +8% ROI</strong>. Protects gains while targeting 35% profit.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #8957e5;">
              <strong style="color: #a371f7;">📉 Trail Light</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">1% position, 10x leverage, trailing stops. Most conservative trailing bot. Good for testing strategies with minimal risk.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #d29922;">
              <strong style="color: #d29922;">📈 Trail Standard</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">10% position, 10x leverage, trailing stops. Balanced risk/reward. 10% trail trigger, breakeven at L1.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #f85149;">
              <strong style="color: #f85149;">💀 Trail Aggressive</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">10% position, 20x leverage, trailing stops. High risk/reward. Balance compounds quickly in trending markets.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #58a6ff;">
              <strong style="color: #58a6ff;">🌊 Trail Wide</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">10% position, 20x leverage, 20% trail trigger (delayed), L1 locks 10% ROI. Reduces premature L1 exits from Jan 8 analysis.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #a371f7;">
              <strong style="color: #a371f7;">🔗 Multi-TF (Confluence)</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">10% position, 20x leverage. Only opens when 5m AND (15m OR 1h) trigger for same asset within 5 min. Does NOT exit on played_out - only trailing stop.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #ff6b35;">
              <strong style="color: #ff6b35;">₿ Contrarian</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">BTC only, 10% position, 50x leverage. Fades extreme RSI conditions - buys oversold (RSI<30), sells overbought (RSI>70). Exits when RSI crosses 50.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #00d4aa;">
              <strong style="color: #00d4aa;">₿ Momentum</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">BTC only, 10% position, 50x leverage. Follows strong trends when bias score >70%. Exits when bias weakens below 30%.</p>
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">🎯 Golden Pocket Strategy</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Fibonacci retracement strategy targeting "hype/pump" assets with sudden volatility spikes. Works in <strong style="color: #c9d1d9;">both directions</strong>.</p>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">How It Works</h4>
          <ol style="margin: 0 0 16px 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #c9d1d9;">Detect Impulse</strong>: Rapid move ≥5% with 3x normal volume</li>
            <li><strong style="color: #c9d1d9;">Calculate Fibonacci</strong>: Draw retracement from swing low to swing high (or vice versa)</li>
            <li><strong style="color: #c9d1d9;">Entry Zone</strong>: "Golden Pocket" = 0.618 to 0.65 retracement level</li>
            <li><strong style="color: #c9d1d9;">Stop Loss</strong>: Below/above 0.786 level (invalidation)</li>
            <li><strong style="color: #c9d1d9;">Take Profit</strong>: TP1 at 0.382 (50%), TP2 at swing high/low retest (50%)</li>
          </ol>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Fibonacci Levels</h4>
          <div style="background: #0d1117; border-radius: 6px; padding: 12px; margin-bottom: 16px; font-size: 12px;">
            <div style="display: grid; grid-template-columns: 80px 1fr; gap: 4px;">
              <span style="color: #3fb950;">0.0</span><span style="color: #8b949e;">Swing High (TP2 for longs)</span>
              <span style="color: #58a6ff;">0.236</span><span style="color: #8b949e;">First retracement level</span>
              <span style="color: #a371f7;">0.382</span><span style="color: #8b949e;">TP1 level (close 50%)</span>
              <span style="color: #d29922;">0.5</span><span style="color: #8b949e;">Halfway retracement</span>
              <span style="color: #f0883e; font-weight: bold;">0.618</span><span style="color: #c9d1d9; font-weight: bold;">Golden Pocket TOP (entry zone)</span>
              <span style="color: #f0883e; font-weight: bold;">0.65</span><span style="color: #c9d1d9; font-weight: bold;">Golden Pocket BOTTOM (entry zone)</span>
              <span style="color: #f85149;">0.786</span><span style="color: #8b949e;">Invalidation level (stop loss)</span>
              <span style="color: #6e7681;">1.0</span><span style="color: #8b949e;">Swing Low (TP2 for shorts)</span>
            </div>
          </div>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Direction Logic</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 16px;">
            <div style="padding: 10px; background: #0d1117; border-radius: 6px; border-left: 3px solid #3fb950;">
              <strong style="color: #3fb950;">📈 LONG Setup</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0; font-size: 11px;">After UP impulse → wait for pullback to golden pocket → buy the dip → target swing high retest</p>
            </div>
            <div style="padding: 10px; background: #0d1117; border-radius: 6px; border-left: 3px solid #f85149;">
              <strong style="color: #f85149;">📉 SHORT Setup</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0; font-size: 11px;">After DOWN impulse → wait for bounce to golden pocket → short the bounce → target swing low retest</p>
            </div>
          </div>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">Golden Pocket Bot Variants</h4>
          <div style="display: grid; gap: 8px; font-size: 12px;">
            <div style="padding: 10px; background: #0d1117; border-radius: 8px; border-left: 3px solid #238636;">
              <strong style="color: #3fb950;">🛡️ GP Conservative</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">1% position, 5x leverage. Strictest filters (3x volume req). Best for learning the strategy.</p>
            </div>
            <div style="padding: 10px; background: #0d1117; border-radius: 8px; border-left: 3px solid #d29922;">
              <strong style="color: #d29922;">⚖️ GP Standard</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">5% position, 10x leverage. Balanced risk/reward with standard filters.</p>
            </div>
            <div style="padding: 10px; background: #0d1117; border-radius: 8px; border-left: 3px solid #f85149;">
              <strong style="color: #f85149;">🔥 GP Aggressive</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">10% position, 20x leverage. Looser filters, more trades. Higher risk/reward.</p>
            </div>
            <div style="padding: 10px; background: #0d1117; border-radius: 8px; border-left: 3px solid #a371f7;">
              <strong style="color: #a371f7;">🎰 GP YOLO</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">25% position, 50x leverage. Maximum risk. Only for degen plays.</p>
            </div>
          </div>

          <h4 style="color: #c9d1d9; margin-top: 16px; margin-bottom: 8px;">Setup States</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #8b949e;">👀 watching</span> - Approaching golden pocket zone
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #3fb950;">✅ triggered</span> - In golden pocket, entry signal
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #f0883e;">🔥 deep_extreme</span> - In pocket + RSI extreme
            </div>
            <div style="padding: 8px; background: #0d1117; border-radius: 6px;">
              <span style="color: #58a6ff;">↩️ reversing</span> - Price moving toward target
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">🔄 Trend Override Strategy</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">When a backburner signal <strong style="color: #c9d1d9;">conflicts</strong> with BTC's macro trend, trade <strong style="color: #c9d1d9;">WITH the trend</strong> instead of against it.</p>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">How It Works</h4>
          <ol style="margin: 0 0 16px 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #c9d1d9;">Single-TF Only</strong>: Only triggers on 1-timeframe setups (not confluence)</li>
            <li><strong style="color: #c9d1d9;">Detect Conflict</strong>: Backburner says LONG but BTC trend is bearish (or vice versa)</li>
            <li><strong style="color: #c9d1d9;">Override Direction</strong>: Trade OPPOSITE to backburner (ride the trend)</li>
            <li><strong style="color: #c9d1d9;">Stay In</strong>: Uses trailing stops, doesn't exit on played_out</li>
          </ol>

          <div style="background: #0d1117; border-radius: 6px; padding: 12px; margin-bottom: 16px; font-size: 12px;">
            <p style="color: #c9d1d9; margin: 0 0 8px 0;"><strong>Example:</strong></p>
            <p style="color: #8b949e; margin: 0;">5m RSI oversold (backburner says LONG) + BTC bearish macro → Opens <span style="color: #f85149;">SHORT</span> instead</p>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">🔁 Trend Flip Strategy</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Same entry logic as Override, but <strong style="color: #c9d1d9;">flips direction</strong> when a position closes in profit to catch the reversal.</p>

          <h4 style="color: #c9d1d9; margin-bottom: 8px;">How It Works</h4>
          <ol style="margin: 0 0 16px 0; padding-left: 20px; color: #8b949e; font-size: 13px;">
            <li><strong style="color: #c9d1d9;">Same Entry</strong>: Override logic (single-TF conflict with BTC trend)</li>
            <li><strong style="color: #c9d1d9;">Profitable Close</strong>: When position closes in profit...</li>
            <li><strong style="color: #c9d1d9;">Flip Direction</strong>: Immediately open opposite direction</li>
            <li><strong style="color: #c9d1d9;">Catch Reversal</strong>: Rides momentum, then catches mean reversion</li>
          </ol>

          <div style="background: #0d1117; border-radius: 6px; padding: 12px; font-size: 12px;">
            <p style="color: #c9d1d9; margin: 0 0 8px 0;"><strong>Example Flow:</strong></p>
            <p style="color: #8b949e; margin: 0;">SHORT (override) → closes +15% profit → LONG (flip) → catches bounce</p>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h3 style="color: #f0883e;">₿ BTC-Only Strategies</h3>
          <p style="color: #8b949e; margin-bottom: 12px;">Specialized bots that trade only Bitcoin based on macro conditions.</p>

          <div style="display: grid; gap: 12px; font-size: 12px;">
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #ff6b35;">
              <strong style="color: #ff6b35;">₿ Contrarian (BTCExtremeBot)</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">Fades extreme RSI conditions - buys oversold (RSI<30), sells overbought (RSI>70). 50x leverage, exits when RSI crosses 50.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #00d4aa;">
              <strong style="color: #00d4aa;">₿ Momentum (BTCTrendBot)</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">Follows strong trends when bias score >70%. 50x leverage, exits when bias weakens below 30%.</p>
            </div>
            <div style="padding: 12px; background: #0d1117; border-radius: 8px; border-left: 3px solid #58a6ff;">
              <strong style="color: #58a6ff;">₿ Bias V2 (Multi-Level)</strong>
              <p style="color: #8b949e; margin: 4px 0 0 0;">Four separate bots tracking BTC bias at different thresholds: Extreme (±80%), Strong (±60%), Moderate (±40%), and Weak (±20%). Each bot only trades its assigned level.</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Settings Modal -->
    <div id="settingsModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 20px; overflow-y: auto;">
      <div style="max-width: 450px; margin: 80px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2 style="color: #58a6ff; margin: 0;">⚙️ Settings</h2>
          <button onclick="closeSettings()" style="background: none; border: none; color: #8b949e; font-size: 24px; cursor: pointer;">&times;</button>
        </div>

        <div style="color: #c9d1d9;">
          <h4 style="margin: 0 0 12px 0; color: #8b949e;">Link Destination</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Where should symbol hyperlinks open?</p>

          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="display: flex; align-items: center; gap: 10px; padding: 12px; background: #0d1117; border-radius: 8px; cursor: pointer; border: 2px solid transparent;" id="linkOption_bots">
              <input type="radio" name="linkDestination" value="bots" onchange="updateLinkSetting('bots')" style="accent-color: #58a6ff;">
              <div>
                <div style="font-weight: 600;">🤖 Trading Bots</div>
                <div style="font-size: 11px; color: #8b949e;">Opens MEXC grid bot page for the symbol</div>
              </div>
            </label>
            <label style="display: flex; align-items: center; gap: 10px; padding: 12px; background: #0d1117; border-radius: 8px; cursor: pointer; border: 2px solid transparent;" id="linkOption_futures">
              <input type="radio" name="linkDestination" value="futures" onchange="updateLinkSetting('futures')" style="accent-color: #58a6ff;">
              <div>
                <div style="font-weight: 600;">📊 Futures Trading</div>
                <div style="font-size: 11px; color: #8b949e;">Opens MEXC futures trading page</div>
              </div>
            </label>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">🔔 Notifications & Sound</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Control browser notifications and sound alerts for new signals.</p>

          <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="notificationsToggle" onchange="toggleNotifications(this.checked)" style="accent-color: #58a6ff; width: 18px; height: 18px;">
              <span>Enable push notifications</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="soundToggle" onchange="toggleSound(this.checked)" style="accent-color: #58a6ff; width: 18px; height: 18px;">
              <span>Enable sound alerts</span>
            </label>
          </div>

          <button onclick="testNotification()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #58a6ff; background: transparent; color: #58a6ff; font-weight: 600; cursor: pointer; margin-right: 8px;">
            🔔 Test Notification
          </button>
          <button onclick="testSound()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #58a6ff; background: transparent; color: #58a6ff; font-weight: 600; cursor: pointer;">
            🔊 Test Sound
          </button>

          <!-- Bot-specific notification toggles -->
          <div style="margin-top: 16px; padding: 12px; background: #0d1117; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 12px; color: #8b949e; font-weight: 600;">Bot Notifications</span>
              <div style="display: flex; gap: 8px;">
                <button onclick="toggleAllBotNotifications(true)" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 11px; cursor: pointer;">All On</button>
                <button onclick="toggleAllBotNotifications(false)" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 11px; cursor: pointer;">All Off</button>
              </div>
            </div>

            <!-- Experimental Bots -->
            <div style="margin-bottom: 8px;">
              <div style="font-size: 11px; color: #58a6ff; margin-bottom: 6px;">🧪 Experimental Bots</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-bb-sysB" onchange="toggleBotNotification('exp-bb-sysB', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-bb-sysB</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-bb-sysB-contrarian" onchange="toggleBotNotification('exp-bb-sysB-contrarian', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-bb-sysB-ctr</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-gp-sysA" onchange="toggleBotNotification('exp-gp-sysA', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-gp-sysA</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-gp-sysB" onchange="toggleBotNotification('exp-gp-sysB', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-gp-sysB</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-gp-regime" onchange="toggleBotNotification('exp-gp-regime', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-gp-regime</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_exp-gp-sysB-contrarian" onchange="toggleBotNotification('exp-gp-sysB-contrarian', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">exp-gp-sysB-ctr</span>
                </label>
              </div>
            </div>

            <!-- Focus Mode Bots -->
            <div>
              <div style="font-size: 11px; color: #f0883e; margin-bottom: 6px;">🎯 Focus Mode Bots</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-baseline" onchange="toggleBotNotification('focus-baseline', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">baseline</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-conservative" onchange="toggleBotNotification('focus-conservative', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">conservative</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-aggressive" onchange="toggleBotNotification('focus-aggressive', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">aggressive</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-excellent" onchange="toggleBotNotification('focus-excellent', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">excellent</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-conflict" onchange="toggleBotNotification('focus-conflict', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">conflict</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-hybrid" onchange="toggleBotNotification('focus-hybrid', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">hybrid</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-contrarian-only" onchange="toggleBotNotification('focus-contrarian-only', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">contrarian</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-euphoria-fade" onchange="toggleBotNotification('focus-euphoria-fade', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">euphoria-fade</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-bull-dip" onchange="toggleBotNotification('focus-bull-dip', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">bull-dip</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px;">
                  <input type="checkbox" id="botNotif_focus-full-quadrant" onchange="toggleBotNotification('focus-full-quadrant', this.checked)" style="accent-color: #3fb950; width: 14px; height: 14px;">
                  <span style="color: #c9d1d9;">full-quadrant</span>
                </label>
              </div>
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">Saved List</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Your saved list contains <span id="settingsSavedCount" style="color: #58a6ff;">0</span> items and is stored in your browser.</p>
          <button onclick="clearSavedList()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #f85149; background: transparent; color: #f85149; font-weight: 600; cursor: pointer;">
            🗑️ Clear Saved List
          </button>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">🔄 Daily Reset</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Reset all bot balances and positions at midnight (UTC). Trade history is preserved for analysis.</p>

          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="dailyResetToggle" onchange="toggleDailyReset(this.checked)" style="accent-color: #58a6ff; width: 18px; height: 18px;">
              <span>Enable daily reset</span>
            </label>
          </div>

          <div id="dailyResetInfo" style="padding: 12px; background: #0d1117; border-radius: 8px; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="color: #8b949e;">Status:</span>
              <span id="dailyResetStatus" style="color: #6e7681;">Loading...</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #8b949e;">Last reset:</span>
              <span id="dailyResetLastDate" style="color: #6e7681;">-</span>
            </div>
          </div>

          <button onclick="triggerManualReset()" style="margin-top: 12px; padding: 8px 16px; border-radius: 6px; border: 1px solid #f0883e; background: transparent; color: #f0883e; font-weight: 600; cursor: pointer;">
            🔄 Reset All Bots Now
          </button>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">🛡️ Conditional Insurance</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">During stress periods (hourly win rate &lt;50%), automatically take partial profit at 2% ROE and move stop-loss to breakeven. Backtest showed +$706 improvement.</p>

          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="conditionalInsuranceToggle" onchange="toggleConditionalInsurance(this.checked)" style="accent-color: #58a6ff; width: 18px; height: 18px;">
              <span>Enable conditional insurance</span>
            </label>
          </div>

          <div id="insuranceInfo" style="padding: 12px; background: #0d1117; border-radius: 8px; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="color: #8b949e;">Status:</span>
              <span id="insuranceStatus" style="color: #6e7681;">Loading...</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #8b949e;">Currently stressed:</span>
              <span id="insuranceStressStatus" style="color: #6e7681;">-</span>
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">💰 Investment Amount</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Sync your real MEXC investment to match ROI calculations with actual trades. This affects all tracked setups.</p>

          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <span style="color: #c9d1d9;">$</span>
            <input type="number" id="investmentAmountInput" placeholder="2000" min="1" step="100"
              style="width: 120px; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 14px;">
            <span style="color: #6e7681; font-size: 12px;">USD</span>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button onclick="updateInvestmentAmount(false)" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #238636; background: transparent; color: #3fb950; font-weight: 600; cursor: pointer;">
              💾 Save (Keep Balances)
            </button>
            <button onclick="updateInvestmentAmount(true)" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #f0883e; background: transparent; color: #f0883e; font-weight: 600; cursor: pointer;">
              🔄 Save & Reset Bots
            </button>
          </div>

          <div id="investmentStatus" style="margin-top: 12px; padding: 8px 12px; background: #0d1117; border-radius: 6px; font-size: 12px; display: none;"></div>

          <hr style="border: none; border-top: 1px solid #30363d; margin: 20px 0;">

          <h4 style="margin: 0 0 12px 0; color: #8b949e;">📦 Data Management</h4>
          <p style="color: #6e7681; font-size: 12px; margin: 0 0 12px 0;">Export trade history or view database statistics.</p>

          <div id="dbStats" style="background: #0d1117; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span style="color: #8b949e; font-size: 12px;">Total Trades:</span>
              <span id="dbTotalTrades" style="color: #c9d1d9; font-size: 12px;">Loading...</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span style="color: #8b949e; font-size: 12px;">Wins / Losses:</span>
              <span id="dbWinLoss" style="color: #c9d1d9; font-size: 12px;">-</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span style="color: #8b949e; font-size: 12px;">Date Range:</span>
              <span id="dbDateRange" style="color: #c9d1d9; font-size: 12px;">-</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #8b949e; font-size: 12px;">Total P&L:</span>
              <span id="dbTotalPnl" style="color: #c9d1d9; font-size: 12px;">-</span>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <select id="exportDays" style="padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px;">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
              <option value="9999">All time</option>
            </select>
            <button onclick="exportTrades()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #238636; background: transparent; color: #3fb950; font-weight: 600; cursor: pointer;">
              📥 Export CSV
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Bot History Modal -->
    <div id="historyModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 20px; overflow-y: auto;">
      <div style="max-width: 800px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 id="historyModalTitle" style="color: #58a6ff; margin: 0;">Bot History</h2>
          <button onclick="closeHistoryModal()" style="background: none; border: none; color: #8b949e; font-size: 24px; cursor: pointer;">&times;</button>
        </div>
        <div id="historyModalContent">Loading...</div>
      </div>
    </div>

    <div class="status-bar">
      <div>
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
      </div>
      <div id="symbolCount">-</div>
    </div>

    <!-- Bot Control Panel -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <span style="font-size: 14px; color: #8b949e;">Bot Controls</span>
      <div style="display: flex; gap: 8px;">
        <button onclick="collapseAllSections()" style="padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; font-size: 11px; cursor: pointer;">Collapse All</button>
        <button onclick="expandAllSections()" style="padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; font-size: 11px; cursor: pointer;">Expand All</button>
        <button onclick="resetBots()" style="padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #f85149; font-weight: 600; cursor: pointer; font-size: 11px;">🔄 Reset All</button>
      </div>
    </div>

    <!-- Section: Altcoin Bots -->
    <div class="section-header" onclick="toggleSection('altcoinBots')">
      <span class="section-title">📊 Altcoin Backburner Bots (12)</span>
      <span class="section-toggle" id="altcoinBotsToggle">▼</span>
    </div>
    <div class="section-content" id="altcoinBotsContent">
      <div class="bot-toggles-row">
        <div class="bot-toggle" id="toggleFixedTP" onclick="event.stopPropagation(); toggleBot('fixedTP')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #238636; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #3fb950; font-size: 11px;">🎯 Fixed</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #3fb950;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing1pct" onclick="event.stopPropagation(); toggleBot('trailing1pct')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #8957e5; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #a371f7; font-size: 11px;">📈 Trail 1%</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #a371f7;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing10pct10x" onclick="event.stopPropagation(); toggleBot('trailing10pct10x')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #d29922; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #d29922; font-size: 11px;">🔥 10%10x</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #d29922;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing10pct20x" onclick="event.stopPropagation(); toggleBot('trailing10pct20x')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #f85149; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #f85149; font-size: 11px;">💀 10%20x</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #f85149;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailWide" onclick="event.stopPropagation(); toggleBot('trailWide')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #58a6ff; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #58a6ff; font-size: 11px;">🌊 Wide</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #58a6ff;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleConfluence" onclick="event.stopPropagation(); toggleBot('confluence')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #a371f7; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #a371f7; font-size: 11px;">🔗 Multi-TF</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #a371f7;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBtcExtreme" onclick="event.stopPropagation(); toggleBot('btcExtreme')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #ff6b35; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff6b35; font-size: 11px;">₿ Contra</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff6b35;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBtcTrend" onclick="event.stopPropagation(); toggleBot('btcTrend')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #00d4aa; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00d4aa; font-size: 11px;">₿ Moment</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00d4aa;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrendOverride" onclick="event.stopPropagation(); toggleBot('trendOverride')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #e040fb; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #e040fb; font-size: 11px;">↕ Override</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #e040fb;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrendFlip" onclick="event.stopPropagation(); toggleBot('trendFlip')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #00bcd4; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00bcd4; font-size: 11px;">🔄 Flip</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00bcd4;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleFixedBE" onclick="event.stopPropagation(); toggleBot('fixedBE')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #2ea043; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #2ea043; font-size: 11px;">🛡️ FixBE</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #2ea043;"></span>
          </div>
        </div>
      </div>

    <!-- 11-Bot Stats Comparison -->
    <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
      <div class="stat-box" style="border-left: 3px solid #238636;">
        <div class="stat-value" id="fixedBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Fix20 | P&L: <span id="fixedPnL" class="positive">$0</span> | Unreal: <span id="fixedUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="fixedWinRate">0%</span> win (<span id="fixedTrades">0</span> trades) | Costs: <span id="fixedCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #2ea043;" title="Fixed 20% TP, SL moves to breakeven at +10% ROI">
        <div class="stat-value" id="fixedBEBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">🛡️FixBE | P&L: <span id="fixedBEPnL" class="positive">$0</span> | Unreal: <span id="fixedBEUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="fixedBEWinRate">0%</span> win (<span id="fixedBETrades">0</span> trades) | Costs: <span id="fixedBECosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #8957e5;">
        <div class="stat-value" id="trail1pctBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Light | P&L: <span id="trail1pctPnL" class="positive">$0</span> | Unreal: <span id="trail1pctUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trail1pctWinRate">0%</span> win (<span id="trail1pctTrades">0</span> trades) | Costs: <span id="trail1pctCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #d29922;">
        <div class="stat-value" id="trail10pct10xBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Std | P&L: <span id="trail10pct10xPnL" class="positive">$0</span> | Unreal: <span id="trail10pct10xUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trail10pct10xWinRate">0%</span> win (<span id="trail10pct10xTrades">0</span> trades) | Costs: <span id="trail10pct10xCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #f85149;">
        <div class="stat-value" id="trail10pct20xBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Aggr | P&L: <span id="trail10pct20xPnL" class="positive">$0</span> | Unreal: <span id="trail10pct20xUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trail10pct20xWinRate">0%</span> win (<span id="trail10pct20xTrades">0</span> trades) | Costs: <span id="trail10pct20xCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #58a6ff;">
        <div class="stat-value" id="trailWideBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Wide | P&L: <span id="trailWidePnL" class="positive">$0</span> | Unreal: <span id="trailWideUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trailWideWinRate">0%</span> win (<span id="trailWideTrades">0</span> trades) | Costs: <span id="trailWideCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #a371f7;">
        <div class="stat-value" id="confluenceBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">MTF | P&L: <span id="confluencePnL" class="positive">$0</span> | Unreal: <span id="confluenceUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="confluenceWinRate">0%</span> win (<span id="confluenceTrades">0</span> trades) | Costs: <span id="confluenceCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #ff6b35;">
        <div class="stat-value" id="btcExtremeBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">₿Ctrn | P&L: <span id="btcExtremePnL" class="positive">$0</span> | Unreal: <span id="btcExtremeUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="btcExtremeWinRate">0%</span> win (<span id="btcExtremeTrades">0</span> trades) | Costs: <span id="btcExtremeCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #00d4aa;">
        <div class="stat-value" id="btcTrendBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">₿Mtm | P&L: <span id="btcTrendPnL" class="positive">$0</span> | Unreal: <span id="btcTrendUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="btcTrendWinRate">0%</span> win (<span id="btcTrendTrades">0</span> trades) | Costs: <span id="btcTrendCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #e040fb;">
        <div class="stat-value" id="trendOverrideBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Override | P&L: <span id="trendOverridePnL" class="positive">$0</span> | Unreal: <span id="trendOverrideUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trendOverrideWinRate">0%</span> win (<span id="trendOverrideTrades">0</span> trades) | Costs: <span id="trendOverrideCosts" style="color: #f85149;">$0</span></div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #00bcd4;">
        <div class="stat-value" id="trendFlipBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Flip | P&L: <span id="trendFlipPnL" class="positive">$0</span> | Unreal: <span id="trendFlipUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="trendFlipWinRate">0%</span> win (<span id="trendFlipTrades">0</span> trades) | Costs: <span id="trendFlipCosts" style="color: #f85149;">$0</span></div>
      </div>
    </div>
    </div>

    <!-- BTC Bias V1 bots REMOVED - See data/archived/BTC_BIAS_V1_EXPERIMENT.md for learnings -->

    <!-- Section: MEXC Simulation Bots -->
    <div class="section-header" onclick="toggleSection('mexcSim')" style="margin-top: 12px;">
      <span class="section-title">📈 MEXC Simulation Bots (6)</span>
      <span class="section-toggle" id="mexcSimToggle">▼</span>
    </div>
    <div class="section-content" id="mexcSimContent">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        Simulates MEXC's continuous trailing stop behavior (callback % from peak). Compare vs our discrete level system.
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 12px;">
        <div class="stat-box" style="border-left: 3px solid #ff5722;">
          <div class="stat-value" id="mexcAggressiveBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Aggressive 1%cb | <span id="mexcAggressivePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcAggressiveWinRate">0%</span> win | <span id="mexcAggressiveTrailing">0</span> trailing</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #e91e63;">
          <div class="stat-value" id="mexcAggressive2cbBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Aggressive 2%cb | <span id="mexcAggressive2cbPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcAggressive2cbWinRate">0%</span> win | <span id="mexcAggressive2cbTrailing">0</span> trailing</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #9c27b0;">
          <div class="stat-value" id="mexcWideBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Wide 1%cb | <span id="mexcWidePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcWideWinRate">0%</span> win | <span id="mexcWideTrailing">0</span> trailing</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #673ab7;">
          <div class="stat-value" id="mexcWide2cbBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Wide 2%cb | <span id="mexcWide2cbPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcWide2cbWinRate">0%</span> win | <span id="mexcWide2cbTrailing">0</span> trailing</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #3f51b5;">
          <div class="stat-value" id="mexcStandardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Standard 1%cb | <span id="mexcStandardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcStandardWinRate">0%</span> win | <span id="mexcStandardTrailing">0</span> trailing</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #2196f3;">
          <div class="stat-value" id="mexcStandard05cbBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Standard 0.5%cb | <span id="mexcStandard05cbPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="mexcStandard05cbWinRate">0%</span> win | <span id="mexcStandard05cbTrailing">0</span> trailing</div>
        </div>
      </div>
    </div>

    <!-- Section: Golden Pocket Bots -->
    <div class="section-header" onclick="toggleSection('goldenPocket')" style="margin-top: 12px;">
      <span class="section-title">🎯 Golden Pocket Bots (4)</span>
      <span class="section-toggle" id="goldenPocketToggle">▼</span>
    </div>
    <div class="section-content" id="goldenPocketContent">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        Fibonacci retracement strategy: Entry at 0.618-0.65, TP1 at 0.382 (50%), TP2 at swing high (50%), SL at 0.786.
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
        <div class="stat-box" style="border-left: 3px solid #4caf50;">
          <div class="stat-value" id="gpConservativeBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Conservative 3% 5x | <span id="gpConservativePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpConservativeUnrealPnL" class="positive">$0</span> | Real: <span id="gpConservativePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpConservativeWinRate">0%</span> win | <span id="gpConservativeTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #8bc34a;">
          <div class="stat-value" id="gpStandardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Standard 5% 10x | <span id="gpStandardPositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpStandardUnrealPnL" class="positive">$0</span> | Real: <span id="gpStandardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpStandardWinRate">0%</span> win | <span id="gpStandardTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #ff9800;">
          <div class="stat-value" id="gpAggressiveBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Aggressive 5% 15x | <span id="gpAggressivePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpAggressiveUnrealPnL" class="positive">$0</span> | Real: <span id="gpAggressivePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpAggressiveWinRate">0%</span> win | <span id="gpAggressiveTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #f44336;">
          <div class="stat-value" id="gpYoloBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">YOLO 10% 20x | <span id="gpYoloPositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpYoloUnrealPnL" class="positive">$0</span> | Real: <span id="gpYoloPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpYoloWinRate">0%</span> win | <span id="gpYoloTP1Rate">0%</span> TP1</div>
        </div>
      </div>
      <!-- GP Account Equity Summary -->
      <div style="display: flex; gap: 12px; padding: 8px 12px; background: #0d1117; border-radius: 6px; border: 1px solid #30363d;">
        <div style="flex: 1;">
          <span style="color: #8b949e; font-size: 11px;">Account Equity (Balance + Unrealized)</span>
          <div style="display: flex; gap: 20px; margin-top: 4px;">
            <span style="font-size: 12px;"><span style="color: #4caf50;">Cons:</span> <span id="gpConsEquity" style="color: #c9d1d9; font-weight: 600;">$2,000</span></span>
            <span style="font-size: 12px;"><span style="color: #8bc34a;">Std:</span> <span id="gpStdEquity" style="color: #c9d1d9; font-weight: 600;">$2,000</span></span>
            <span style="font-size: 12px;"><span style="color: #ff9800;">Agg:</span> <span id="gpAggEquity" style="color: #c9d1d9; font-weight: 600;">$2,000</span></span>
            <span style="font-size: 12px;"><span style="color: #f44336;">YOLO:</span> <span id="gpYoloEquity" style="color: #c9d1d9; font-weight: 600;">$2,000</span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Golden Pocket V2 Section (Loose Thresholds) -->
    <div class="section-header" onclick="toggleSection('goldenPocketV2')" style="margin-top: 12px;">
      <span class="section-title">🎯 Golden Pocket V2 (Loose RSI)</span>
      <span class="section-toggle" id="goldenPocketV2Toggle">▸</span>
    </div>
    <div class="section-content" id="goldenPocketV2Content" style="display: none;">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        V2: Loosened RSI thresholds (RSI &lt; 50 for longs vs V1's &lt; 40). A/B testing vs strict V1.
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
        <div class="stat-box" style="border-left: 3px solid #4caf50;">
          <div class="stat-value" id="gp2ConservativeBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">V2 Cons 5% 10x | <span id="gp2ConservativePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gp2ConservativeUnrealPnL" class="positive">$0</span> | Real: <span id="gp2ConservativePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gp2ConservativeWinRate">0%</span> win | <span id="gp2ConservativeTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #8bc34a;">
          <div class="stat-value" id="gp2StandardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">V2 Std 10% 10x | <span id="gp2StandardPositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gp2StandardUnrealPnL" class="positive">$0</span> | Real: <span id="gp2StandardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gp2StandardWinRate">0%</span> win | <span id="gp2StandardTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #ff9800;">
          <div class="stat-value" id="gp2AggressiveBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">V2 Agg 10% 20x | <span id="gp2AggressivePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gp2AggressiveUnrealPnL" class="positive">$0</span> | Real: <span id="gp2AggressivePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gp2AggressiveWinRate">0%</span> win | <span id="gp2AggressiveTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #f44336;">
          <div class="stat-value" id="gp2YoloBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">V2 YOLO 20% 20x | <span id="gp2YoloPositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gp2YoloUnrealPnL" class="positive">$0</span> | Real: <span id="gp2YoloPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gp2YoloWinRate">0%</span> win | <span id="gp2YoloTP1Rate">0%</span> TP1</div>
        </div>
      </div>
    </div>

    <!-- V2 CHANGE: BTC Bias V2 Section HIDDEN - bots removed due to 0% win rate -->
    <div class="section-header" onclick="toggleSection('btcBiasBotsV2')" style="margin-top: 12px; display: none;">
      <span class="section-title">📈 BTC Bias V2 (Conservative)</span>
      <span class="section-toggle" id="btcBiasBotsV2Toggle">▸</span>
    </div>
    <div class="section-content" id="btcBiasBotsV2Content" style="display: none;">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        V2: 10-20% position, 10-20x leverage, 2-3% callback (vs V1's 100%/50x/0.5%). Designed to survive volatility.
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
        <div class="stat-box" style="border-left: 3px solid #58a6ff;">
          <div class="stat-value" id="biasV220x10trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">20% 10x Trail 3%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV220x10trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV220x10trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #58a6ff;">
          <div class="stat-value" id="biasV220x20trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">20% 20x Trail 2%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV220x20trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV220x20trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #79c0ff;">
          <div class="stat-value" id="biasV210x10trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 10x Trail 3%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV210x10trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV210x10trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #79c0ff;">
          <div class="stat-value" id="biasV210x20trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 20x Trail 2%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV210x20trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV210x20trailStatus">-</span></div>
        </div>
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr);">
        <div class="stat-box" style="border-left: 3px solid #a371f7;">
          <div class="stat-value" id="biasV220x10hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">20% 10x Hard 30%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV220x10hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV220x10hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #a371f7;">
          <div class="stat-value" id="biasV220x20hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">20% 20x Hard 30%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV220x20hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV220x20hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #d2a8ff;">
          <div class="stat-value" id="biasV210x10hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 10x Hard 30%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV210x10hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV210x10hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #d2a8ff;">
          <div class="stat-value" id="biasV210x20hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 20x Hard 30%</div>
          <div class="stat-label" style="margin-top: 2px;">PnL: <span id="biasV210x20hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="biasV210x20hardStatus">-</span></div>
        </div>
      </div>
    </div>

    <!-- Section: Experimental Shadow Bots -->
    <div class="section-header" onclick="toggleSection('expBots')" style="margin-top: 12px;">
      <span class="section-title">🧪 Experimental Shadow Bots (A/B Testing)</span>
      <span class="section-toggle" id="expBotsToggle">▼</span>
    </div>
    <div class="section-content" id="expBotsContent">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        Paper trading bots testing different bias filters (System A vs B) and signal sources (Backburner vs Golden Pocket). All run on shadow mode.
      </div>
      <div class="stats-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 12px;" id="expBotsGrid">
        <!-- exp-bb-sysB (TOP PERFORMER) -->
        <div class="stat-box" style="border-left: 3px solid #ffd700;" title="Backburner + System B multi-indicator bias filter">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; font-weight: bold; color: #ffd700;">exp-bb-sysB</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-bb-sysB" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-bb-sysB', !isBotNotificationEnabled('exp-bb-sysB'))"></span>
              <span id="expBbSysBRank" style="font-size: 10px; color: #ffd700;">🏆 #1</span>
            </span>
          </div>
          <div class="stat-value" id="expBbSysBBalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">BB + System B | <span id="expBbSysBPositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expBbSysBPnL" class="positive">$0</span> | Unreal: <span id="expBbSysBUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expBbSysBWinRate">0%</span> win (<span id="expBbSysBTrades">0</span> trades)</div>
        </div>
        <!-- exp-bb-sysB-contrarian -->
        <div class="stat-box" style="border-left: 3px solid #a371f7;" title="Backburner + System B + NEU+BEAR/BEAR+BEAR quadrants only">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: #a371f7;">exp-bb-sysB-contrarian</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-bb-sysB-contrarian" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-bb-sysB-contrarian', !isBotNotificationEnabled('exp-bb-sysB-contrarian'))"></span>
              <span id="expBbSysBContrarianRank" style="font-size: 10px; color: #6e7681;">#2</span>
            </span>
          </div>
          <div class="stat-value" id="expBbSysBContrarianBalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">BB + SysB + Contrarian | <span id="expBbSysBContrarianPositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expBbSysBContrarianPnL" class="positive">$0</span> | Unreal: <span id="expBbSysBContrarianUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expBbSysBContrarianWinRate">0%</span> win (<span id="expBbSysBContrarianTrades">0</span> trades)</div>
        </div>
        <!-- exp-gp-sysA -->
        <div class="stat-box" style="border-left: 3px solid #58a6ff;" title="Golden Pocket + System A RSI-only bias filter">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: #58a6ff;">exp-gp-sysA</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-gp-sysA" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-gp-sysA', !isBotNotificationEnabled('exp-gp-sysA'))"></span>
              <span id="expGpSysARank" style="font-size: 10px; color: #6e7681;">#3</span>
            </span>
          </div>
          <div class="stat-value" id="expGpSysABalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">GP + System A (RSI) | <span id="expGpSysAPositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expGpSysAPnL" class="positive">$0</span> | Unreal: <span id="expGpSysAUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expGpSysAWinRate">0%</span> win (<span id="expGpSysATrades">0</span> trades)</div>
        </div>
        <!-- exp-gp-sysB -->
        <div class="stat-box" style="border-left: 3px solid #3fb950;" title="Golden Pocket + System B multi-indicator bias filter">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: #3fb950;">exp-gp-sysB</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-gp-sysB" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-gp-sysB', !isBotNotificationEnabled('exp-gp-sysB'))"></span>
              <span id="expGpSysBRank" style="font-size: 10px; color: #6e7681;">#4</span>
            </span>
          </div>
          <div class="stat-value" id="expGpSysBBalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">GP + System B | <span id="expGpSysBPositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expGpSysBPnL" class="positive">$0</span> | Unreal: <span id="expGpSysBUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expGpSysBWinRate">0%</span> win (<span id="expGpSysBTrades">0</span> trades)</div>
        </div>
        <!-- exp-gp-regime -->
        <div class="stat-box" style="border-left: 3px solid #f85149;" title="Golden Pocket + Regime filter (NEU+BEAR/BEAR+BEAR quadrants)">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: #f85149;">exp-gp-regime</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-gp-regime" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-gp-regime', !isBotNotificationEnabled('exp-gp-regime'))"></span>
              <span id="expGpRegimeRank" style="font-size: 10px; color: #6e7681;">#5</span>
            </span>
          </div>
          <div class="stat-value" id="expGpRegimeBalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">GP + Regime Filter | <span id="expGpRegimePositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expGpRegimePnL" class="positive">$0</span> | Unreal: <span id="expGpRegimeUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expGpRegimeWinRate">0%</span> win (<span id="expGpRegimeTrades">0</span> trades)</div>
        </div>
        <!-- exp-gp-sysB-contrarian -->
        <div class="stat-box" style="border-left: 3px solid #d29922;" title="Golden Pocket + System B + Contrarian quadrants">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: #d29922;">exp-gp-sysB-contrarian</span>
            <span style="display: flex; align-items: center; gap: 4px;">
              <span id="notifBadge_exp-gp-sysB-contrarian" style="font-size: 10px; cursor: pointer;" title="Click to toggle notifications" onclick="toggleBotNotification('exp-gp-sysB-contrarian', !isBotNotificationEnabled('exp-gp-sysB-contrarian'))"></span>
              <span id="expGpSysBContrarianRank" style="font-size: 10px; color: #6e7681;">#6</span>
            </span>
          </div>
          <div class="stat-value" id="expGpSysBContrarianBalance" style="font-size: 18px;">$2,000</div>
          <div class="stat-label">GP + SysB + Contrarian | <span id="expGpSysBContrarianPositions">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">P&L: <span id="expGpSysBContrarianPnL" class="positive">$0</span> | Unreal: <span id="expGpSysBContrarianUnreal" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="expGpSysBContrarianWinRate">0%</span> win (<span id="expGpSysBContrarianTrades">0</span> trades)</div>
        </div>
      </div>
      <!-- Performance summary row -->
      <div style="display: flex; gap: 12px; padding: 8px 12px; background: #0d1117; border-radius: 6px; border: 1px solid #30363d; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <span style="color: #8b949e; font-size: 11px;">Best Performer:</span>
          <span id="expBestBot" style="color: #ffd700; font-weight: 600; margin-left: 4px;">-</span>
          <span id="expBestPnL" style="color: #3fb950; font-size: 12px; margin-left: 8px;">-</span>
        </div>
        <div style="flex: 1; min-width: 200px;">
          <span style="color: #8b949e; font-size: 11px;">Total Experimental P&L:</span>
          <span id="expTotalPnL" style="font-weight: 600; margin-left: 4px; color: #c9d1d9;">$0</span>
        </div>
        <div style="flex: 1; min-width: 200px;">
          <span style="color: #8b949e; font-size: 11px;">Total Trades:</span>
          <span id="expTotalTrades" style="font-weight: 600; margin-left: 4px; color: #c9d1d9;">0</span>
        </div>
      </div>
    </div>

    <!-- Section: MEXC Live Execution Queue -->
    <div class="section-header" onclick="toggleSection('mexcLive')" style="margin-top: 12px;">
      <span class="section-title" title="Bridge between bot signals and real MEXC futures trading. Requires MEXC_UID_COOKIE environment variable to connect.">🚀 MEXC Live Execution</span>
      <span class="section-toggle" id="mexcLiveToggle">▼</span>
    </div>
    <div class="section-content" id="mexcLiveContent">
      <!-- Safety Notice -->
      <div style="margin-bottom: 12px; padding: 10px 12px; background: rgba(56, 139, 253, 0.08); border: 1px solid #1f6feb33; border-radius: 6px;">
        <div style="color: #58a6ff; font-size: 11px; font-weight: 600; margin-bottom: 4px;">How this works</div>
        <div style="color: #8b949e; font-size: 10px; line-height: 1.5;">
          When a paper-trading bot signals a trade, it gets added to the <strong style="color: #c9d1d9;">Execution Queue</strong> below.
          What happens next depends on the <strong style="color: #c9d1d9;">Execution Mode</strong>:
          Dry Run = queue only (no action), Shadow = log only (no real orders), Live = real MEXC orders (real money).
          Orders in the queue can be individually approved, executed, or cancelled.
        </div>
      </div>

      <!-- Bot Feeder Configuration -->
      <div style="margin-bottom: 12px; padding: 12px; background: #0d1117; border-radius: 8px; border: 1px solid #30363d;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="color: #c9d1d9; font-size: 12px; font-weight: 600;" title="Select which paper-trading bot(s) feed signals into the execution queue. When a selected bot opens a paper position, a corresponding order is added to the queue for real execution.">🤖 Bot Feeder</span>
          <span id="mexcBotFeederStatus" style="font-size: 10px; color: #8b949e;">No bots selected</span>
        </div>
        <div style="color: #8b949e; font-size: 10px; margin-bottom: 8px;">
          Select which bot(s) feed signals to the queue. Only selected bots will add orders when they open paper positions.
        </div>
        <div id="mexcBotCheckboxes" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px; margin-bottom: 10px;">
          <div style="color: #6e7681; font-size: 10px; padding: 4px;">Loading bots...</div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; padding-top: 8px; border-top: 1px solid #21262d; flex-wrap: wrap;">
          <div style="display: flex; gap: 2px; background: #161b22; border-radius: 4px; border: 1px solid #30363d;">
            <button id="mexcSizeModeFixed" onclick="setMexcSizeMode('fixed')"
              style="padding: 4px 10px; border-radius: 3px; border: none; font-size: 10px; font-weight: 600; cursor: pointer; background: #238636; color: white;"
              title="Use a fixed USD amount per trade">$ Fixed</button>
            <button id="mexcSizeModePct" onclick="setMexcSizeMode('percent')"
              style="padding: 4px 10px; border-radius: 3px; border: none; font-size: 10px; font-weight: 600; cursor: pointer; background: transparent; color: #8b949e;"
              title="Use a percentage of your MEXC available balance per trade">% Balance</button>
          </div>
          <div id="mexcSizeFixedGroup" style="display: flex; gap: 4px; align-items: center;">
            <input type="number" id="mexcPositionSize" value="10" min="1" max="10000"
              style="width: 70px; padding: 4px 8px; border-radius: 4px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 12px;">
            <span style="color: #6e7681; font-size: 10px;">USD</span>
          </div>
          <div id="mexcSizePctGroup" style="display: none; gap: 4px; align-items: center;">
            <input type="number" id="mexcPositionPct" value="5" min="0.5" max="100" step="0.5"
              style="width: 60px; padding: 4px 8px; border-radius: 4px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 12px;">
            <span style="color: #6e7681; font-size: 10px;">%</span>
            <span id="mexcPctPreview" style="color: #58a6ff; font-size: 10px;" title="Estimated trade size based on current available balance"></span>
          </div>
          <button onclick="saveMexcBotSelection()" style="padding: 4px 12px; border-radius: 4px; border: none; background: #238636; color: white; font-size: 11px; cursor: pointer;">Save</button>
        </div>
        <div style="display: flex; gap: 12px; align-items: center; padding-top: 8px; margin-top: 8px; border-top: 1px solid #21262d; flex-wrap: wrap;">
          <label style="color: #8b949e; font-size: 11px; white-space: nowrap;" title="Safety cap: orders exceeding this USD amount will be clamped">Max Size:</label>
          <div style="display: flex; gap: 4px; align-items: center;">
            <span style="color: #6e7681; font-size: 11px;">$</span>
            <input type="number" id="mexcMaxPositionSize" value="50" min="5" max="10000"
              style="width: 70px; padding: 4px 8px; border-radius: 4px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 12px;"
              onchange="saveMexcBotSelection()">
          </div>
          <label style="color: #8b949e; font-size: 11px; white-space: nowrap; margin-left: 8px;" title="Safety cap: leverage will be capped at this value regardless of what the bot suggests">Max Leverage:</label>
          <div style="display: flex; gap: 4px; align-items: center;">
            <input type="number" id="mexcMaxLeverage" value="20" min="1" max="200"
              style="width: 55px; padding: 4px 8px; border-radius: 4px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 12px;"
              onchange="saveMexcBotSelection()">
            <span style="color: #6e7681; font-size: 11px;">x</span>
          </div>
          <div style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
            <label style="color: #f85149; font-size: 10px; font-weight: 600; white-space: nowrap; cursor: pointer;" title="DANGEROUS: When enabled AND in Live mode, orders will be executed automatically without manual approval. Requires double confirmation to enable."
              for="mexcAutoExecuteToggle">Auto-Execute</label>
            <input type="checkbox" id="mexcAutoExecuteToggle" onchange="toggleAutoExecute(this.checked)"
              style="accent-color: #f85149; cursor: pointer;">
          </div>
        </div>
      </div>

      <div style="display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
        <!-- Connection Status Card -->
        <div style="flex: 1; min-width: 200px; padding: 12px; background: #0d1117; border-radius: 8px; border: 1px solid #30363d;" title="Shows whether the server can communicate with MEXC Futures API using your session cookie. If disconnected, check that MEXC_UID_COOKIE is set in your environment variables.">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="color: #8b949e; font-size: 11px;">MEXC Connection</span>
            <span id="mexcConnectionStatus" style="font-size: 10px; padding: 2px 8px; border-radius: 4px; background: #6e7681; color: white;" title="Green = connected to MEXC API. Red = cookie missing or expired. Grey = not tested yet.">Disconnected</span>
          </div>
          <div style="font-size: 20px; font-weight: 600; color: #c9d1d9;" id="mexcBalance" title="Total USDT balance in your MEXC Futures account">$0.00</div>
          <div style="font-size: 11px; color: #8b949e; margin-top: 4px;" title="Balance not locked in open positions — this is what's available for new trades">Available: <span id="mexcAvailable">$0.00</span></div>
        </div>

        <!-- Execution Mode Card -->
        <div style="flex: 1; min-width: 200px; padding: 12px; background: #0d1117; border-radius: 8px; border: 1px solid #30363d;" title="Controls what happens when a bot signals a new trade. Only 'Live' mode places real orders on MEXC.">
          <div style="color: #8b949e; font-size: 11px; margin-bottom: 8px;">Execution Mode</div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button onclick="setMexcMode('dry_run')" id="mexcModeDryRun" style="flex: 1; padding: 8px; border-radius: 6px; border: 2px solid #238636; background: #238636; color: white; font-size: 11px; font-weight: 600; cursor: pointer;" title="DRY RUN (Default — Safe)\nBot signals are added to the queue but NO action is taken.\nYou can manually review and execute individual orders from the queue.\nNo connection to MEXC needed. No real money involved.">
              🔬 Dry Run
            </button>
            <button onclick="setMexcMode('shadow')" id="mexcModeShadow" style="flex: 1; padding: 8px; border-radius: 6px; border: 2px solid #30363d; background: #21262d; color: #8b949e; font-size: 11px; font-weight: 600; cursor: pointer;" title="SHADOW MODE (Logging Only)\nBot signals are added to the queue AND auto-marked as 'executed' in logs.\nNO real orders are placed on MEXC — this only simulates execution for logging.\nUseful to see what WOULD have been traded without risking real money.">
              👻 Shadow
            </button>
            <button onclick="setMexcMode('live')" id="mexcModeLive" style="flex: 1; padding: 8px; border-radius: 6px; border: 2px solid #30363d; background: #21262d; color: #8b949e; font-size: 11px; font-weight: 600; cursor: pointer;" title="LIVE MODE (Real Money!)\nBot signals are added to the queue. You must manually click 'Execute' on each order to place it.\nOrders are sent to MEXC Futures API and REAL positions are opened with REAL money.\nRequires active MEXC connection. Double confirmation required to enable.">
              💰 Live
            </button>
          </div>
        </div>

        <!-- Open Positions Summary -->
        <div style="flex: 1; min-width: 200px; padding: 12px; background: #0d1117; border-radius: 8px; border: 1px solid #30363d;" title="Shows open positions on your actual MEXC Futures account. Auto-syncs on page load and every 10s.">
          <div style="color: #8b949e; font-size: 11px; margin-bottom: 8px;">MEXC Positions</div>
          <div style="font-size: 20px; font-weight: 600; color: #c9d1d9;"><span id="mexcPositionCount">...</span> <span style="font-size: 12px; color: #8b949e;">open</span></div>
          <div style="font-size: 11px; color: #8b949e; margin-top: 4px;">Unrealized P&L: <span id="mexcUnrealizedPnL" class="positive" title="Combined unrealized profit/loss across all open MEXC positions">loading...</span></div>
        </div>
      </div>

      <!-- Open Positions Detail -->
      <div id="mexcPositionsDetail" style="background: #0d1117; border-radius: 8px; border: 1px solid #30363d; overflow: hidden; display: none;">
        <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d;">
          <span style="font-size: 12px; font-weight: 600; color: #c9d1d9;">Open MEXC Positions</span>
        </div>
        <div id="mexcPositionsList" style="max-height: 200px; overflow-y: auto;"></div>
      </div>

      <!-- Execution Queue -->
      <div style="background: #0d1117; border-radius: 8px; border: 1px solid #30363d; overflow: hidden;">
        <div style="padding: 10px 12px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 12px; font-weight: 600; color: #c9d1d9;" title="Orders generated by paper-trading bots appear here. In Dry Run mode, you review and execute them manually. In Live mode, click 'Execute' to send a real order to MEXC.">📋 Execution Queue</span>
          <div style="display: flex; gap: 6px;">
            <button onclick="refreshMexcQueue()" style="padding: 4px 10px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;" title="Reload the queue from the server">↻ Refresh</button>
            <button onclick="clearMexcQueue()" style="padding: 4px 10px; border-radius: 4px; border: 1px solid #f85149; background: #21262d; color: #f85149; font-size: 10px; cursor: pointer;" title="Remove ALL orders from the queue (pending, executed, failed). Does NOT close any open MEXC positions.">Clear All</button>
          </div>
        </div>
        <div id="mexcQueueTable" style="max-height: 200px; overflow-y: auto;">
          <div style="padding: 20px; text-align: center; color: #6e7681; font-size: 12px;">
            No pending orders. When a bot signals a trade, it will appear here for execution.
          </div>
        </div>
      </div>

      <!-- Bot Decision Logs -->
      <div style="background: #0d1117; border-radius: 8px; border: 1px solid #30363d; overflow: hidden; margin-top: 12px;">
        <div style="padding: 10px 12px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 12px; font-weight: 600; color: #c9d1d9;" title="Detailed log of all bot decisions — opens, skips, executions, closures">📜 Bot Decision Log</span>
          <button onclick="refreshBotLogs()" style="padding: 4px 10px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">↻ Refresh</button>
        </div>
        <div id="botDecisionLogTable" style="max-height: 250px; overflow-y: auto; font-family: monospace;">
          <div style="padding: 12px; text-align: center; color: #6e7681; font-size: 11px;">No decisions logged yet.</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <button onclick="testMexcConnection()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #238636; background: #21262d; color: #238636; font-size: 11px; font-weight: 600; cursor: pointer;" title="Test API connection to MEXC Futures using your session cookie. Shows your account balance if successful. Safe — does not place any orders.">
          🔌 Test Connection
        </button>
        <button onclick="syncMexcPositions()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #58a6ff; background: #21262d; color: #58a6ff; font-size: 11px; font-weight: 600; cursor: pointer;" title="Fetch current open positions from your MEXC Futures account. Safe — read-only, does not modify any positions.">
          🔄 Sync Positions
        </button>
        <button onclick="emergencyCloseAll()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #f85149; background: #21262d; color: #f85149; font-size: 11px; font-weight: 600; cursor: pointer;" title="DANGER: Immediately closes ALL open positions on your MEXC Futures account at market price. This is irreversible — all positions will be liquidated. Use only in emergencies. Requires double confirmation.">
          🛑 Emergency Close All
        </button>
      </div>

      <!-- Live Mode Warning -->
      <div id="liveModeWarning" style="display: none; margin-top: 12px; padding: 12px; background: rgba(248, 81, 73, 0.1); border: 1px solid #f85149; border-radius: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 16px;">⚠️</span>
          <div>
            <div style="color: #f85149; font-weight: 600; font-size: 12px;">LIVE TRADING ACTIVE</div>
            <div style="color: #f85149; font-size: 11px;">Real orders will be executed on MEXC Futures with REAL money when you click 'Execute' on queued orders.</div>
            <div style="color: #8b949e; font-size: 10px; margin-top: 4px;">Orders still require manual approval — they won't execute automatically. Switch back to Dry Run to disable.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Setups Card with Tabs -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="card-header" style="flex-wrap: wrap; gap: 12px;">
        <span class="card-title">📊 Setups</span>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="tab-btn active" id="tabActive" onclick="setSetupsTab('active')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #238636; color: white; font-size: 12px; cursor: pointer;">
            Active <span id="activeCount">0</span>
          </button>
          <button class="tab-btn" id="tabPlayedOut" onclick="setSetupsTab('playedOut')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 12px; cursor: pointer;">
            Played Out <span id="playedOutCount">0</span>
          </button>
          <button class="tab-btn" id="tabHistory" onclick="setSetupsTab('history')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 12px; cursor: pointer;">
            History <span id="historyCount">0</span>
          </button>
          <button class="tab-btn" id="tabAll" onclick="setSetupsTab('all')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 12px; cursor: pointer;">
            All <span id="allCount">0</span>
          </button>
          <button class="tab-btn" id="tabGoldenPocket" onclick="setSetupsTab('goldenPocket')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #f0883e; background: #21262d; color: #f0883e; font-size: 12px; cursor: pointer;">
            🎯 GP <span id="gpCount">0</span>
          </button>
          <span style="color: #30363d; margin: 0 4px;">|</span>
          <button class="tab-btn" id="tabSavedList" onclick="setSetupsTab('savedList')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #58a6ff; background: #21262d; color: #58a6ff; font-size: 12px; cursor: pointer;">
            📋 List <span id="savedListCount">0</span>
          </button>
        </div>
      </div>
      <!-- Selection controls bar -->
      <div id="selectionControls" style="display: flex; gap: 8px; padding: 8px 12px; background: #0d1117; border-bottom: 1px solid #30363d; flex-wrap: wrap; align-items: center;">
        <span style="color: #8b949e; font-size: 11px;">Selection:</span>
        <button onclick="selectAllSetups()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">Select All</button>
        <button onclick="deselectAllSetups()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">Deselect All</button>
        <button onclick="addSelectedToList()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #3fb950; background: #21262d; color: #3fb950; font-size: 10px; cursor: pointer;">+ Add to List</button>
        <button onclick="removeSelectedFromList()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #f85149; background: #21262d; color: #f85149; font-size: 10px; cursor: pointer;">- Remove</button>
        <span style="color: #6e7681; font-size: 10px; margin-left: 8px;" id="selectionStatus">0 selected</span>
        <span style="color: #30363d; margin: 0 8px;">|</span>
        <span style="color: #8b949e; font-size: 11px;">Market:</span>
        <select id="marketFilter" onchange="setMarketFilter(this.value)" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; font-size: 10px; cursor: pointer;">
          <option value="all">All</option>
          <option value="spot">Spot Only</option>
          <option value="futures">Futures Only</option>
        </select>
      </div>
      <div id="setupsTable">
        <div class="empty-state">Scanning for setups...</div>
      </div>
    </div>

    <!-- Bot Cards Section - Collapsible -->
    <div class="section-header" onclick="toggleSection('botCards')" style="margin-top: 8px;">
      <span class="section-title">📋 Active Positions & History (14 bots)</span>
      <span class="section-toggle" id="botCardsToggle">▼</span>
    </div>
    <div class="section-content" id="botCardsContent">
    <div class="grid" id="botCardsGrid">
      <div class="card bot-card" id="fixedTPCard" style="border-left: 3px solid #238636;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('fixedTP')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="fixedTPToggle">▼</span>
            <span class="card-title">🎯 Fixed 20/20</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('fixedTP', '🎯 Fixed 20/20')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="fixedHistoryCount">0</span></button>
            <span id="fixedPositionCount">0</span>
          </div>
        </div>
        <div id="fixedTPContent"><div id="fixedPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="fixedBECard" style="border-left: 3px solid #2ea043;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('fixedBE')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="fixedBEToggle">▼</span>
            <span class="card-title" title="Fixed 20% TP, moves SL to breakeven at +10% ROI">🛡️ Fixed BE</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('fixedBE', '🛡️ Fixed BE')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="fixedBEHistoryCount">0</span></button>
            <span id="fixedBEPositionCount">0</span>
          </div>
        </div>
        <div id="fixedBEContent"><div id="fixedBEPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="trailing1pctCard" style="border-left: 3px solid #8957e5;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trailing1pct')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trailing1pctToggle">▼</span>
            <span class="card-title">📉 Trail Light</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trailing1pct', '📉 Trail Light')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail1pctHistoryCount">0</span></button>
            <span id="trail1pctPositionCount">0</span>
          </div>
        </div>
        <div id="trailing1pctContent"><div id="trail1pctPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="trailing10pct10xCard" style="border-left: 3px solid #d29922;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trailing10pct10x')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trailing10pct10xToggle">▼</span>
            <span class="card-title">📈 Trail Standard</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trailing10pct10x', '📈 Trail Standard')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail10pct10xHistoryCount">0</span></button>
            <span id="trail10pct10xPositionCount">0</span>
          </div>
        </div>
        <div id="trailing10pct10xContent"><div id="trail10pct10xPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="trailing10pct20xCard" style="border-left: 3px solid #f85149;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trailing10pct20x')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trailing10pct20xToggle">▼</span>
            <span class="card-title">💀 Trail Aggressive</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trailing10pct20x', '💀 Trail Aggressive')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail10pct20xHistoryCount">0</span></button>
            <span id="trail10pct20xPositionCount">0</span>
          </div>
        </div>
        <div id="trailing10pct20xContent"><div id="trail10pct20xPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="trailWideCard" style="border-left: 3px solid #58a6ff;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trailWide')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trailWideToggle">▼</span>
            <span class="card-title">🌊 Trail Wide</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trailWide', '🌊 Trail Wide')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trailWideHistoryCount">0</span></button>
            <span id="trailWidePositionCount">0</span>
          </div>
        </div>
        <div id="trailWideContent"><div id="trailWidePositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="confluenceCard" style="border-left: 3px solid #a371f7;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('confluence')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="confluenceToggle">▼</span>
            <span class="card-title">🔗 Multi-TF</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('confluence', '🔗 Multi-TF')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="confluenceHistoryCount">0</span></button>
            <span id="confluencePositionCount">0</span>
          </div>
        </div>
        <div id="confluenceContent">
          <div id="confluenceTriggersBox" style="margin-bottom: 8px; font-size: 11px; color: #8b949e;"></div>
          <div id="confluencePositionsTable"><div class="empty-state">No positions</div></div>
        </div>
      </div>
      <div class="card bot-card" id="btcExtremeCard" style="border-left: 3px solid #ff6b35;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('btcExtreme')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="btcExtremeToggle">▼</span>
            <span class="card-title">₿ Contrarian</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('btcExtreme', '₿ Contrarian')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="btcExtremeHistoryCount">0</span></button>
            <span id="btcExtremePositionCount">0</span>
          </div>
        </div>
        <div id="btcExtremeContent"><div id="btcExtremePositionTable"><div class="empty-state">No position</div></div></div>
      </div>
      <div class="card bot-card" id="btcTrendCard" style="border-left: 3px solid #00d4aa;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('btcTrend')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="btcTrendToggle">▼</span>
            <span class="card-title">₿ Momentum</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('btcTrend', '₿ Momentum')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="btcTrendHistoryCount">0</span></button>
            <span id="btcTrendPositionCount">0</span>
          </div>
        </div>
        <div id="btcTrendContent"><div id="btcTrendPositionTable"><div class="empty-state">No position</div></div></div>
      </div>
      <div class="card bot-card" id="trendOverrideCard" style="border-left: 3px solid #e040fb;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trendOverride')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trendOverrideToggle">▼</span>
            <span class="card-title">↕ Override</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trendOverride', '↕ Override')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trendOverrideHistoryCount">0</span></button>
            <span id="trendOverridePositionCount">0</span>
          </div>
        </div>
        <div id="trendOverrideContent"><div id="trendOverridePositionTable"><div class="empty-state">No position</div></div></div>
      </div>
      <div class="card bot-card" id="trendFlipCard" style="border-left: 3px solid #00bcd4;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('trendFlip')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="trendFlipToggle">▼</span>
            <span class="card-title">🔄 Flip</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('trendFlip', '🔄 Flip')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trendFlipHistoryCount">0</span></button>
            <span id="trendFlipPositionCount">0</span>
          </div>
        </div>
        <div id="trendFlipContent"><div id="trendFlipPositionTable"><div class="empty-state">No position</div></div></div>
      </div>
      <!-- GP Bot Cards -->
      <div class="card bot-card" id="gpConservativeCard" style="border-left: 3px solid #4caf50;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('gpConservative')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="gpConservativeToggle">▼</span>
            <span class="card-title">🎯 GP-Conservative</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('gpConservative', '🎯 GP-Conservative')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="gpConsHistoryCount">0</span></button>
            <span id="gpConsCardPositionCount">0</span>
          </div>
        </div>
        <div id="gpConservativeContent"><div id="gpConsPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="gpStandardCard" style="border-left: 3px solid #8bc34a;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('gpStandard')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="gpStandardToggle">▼</span>
            <span class="card-title">🎯 GP-Standard</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('gpStandard', '🎯 GP-Standard')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="gpStdHistoryCount">0</span></button>
            <span id="gpStdCardPositionCount">0</span>
          </div>
        </div>
        <div id="gpStandardContent"><div id="gpStdPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="gpAggressiveCard" style="border-left: 3px solid #ff9800;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('gpAggressive')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="gpAggressiveToggle">▼</span>
            <span class="card-title">🎯 GP-Aggressive</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('gpAggressive', '🎯 GP-Aggressive')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="gpAggHistoryCount">0</span></button>
            <span id="gpAggCardPositionCount">0</span>
          </div>
        </div>
        <div id="gpAggressiveContent"><div id="gpAggPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
      <div class="card bot-card" id="gpYoloCard" style="border-left: 3px solid #f44336;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('gpYolo')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="gpYoloToggle">▼</span>
            <span class="card-title">💀 GP-YOLO</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('gpYolo', '💀 GP-YOLO')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="gpYoloHistoryCount">0</span></button>
            <span id="gpYoloCardPositionCount">0</span>
          </div>
        </div>
        <div id="gpYoloContent"><div id="gpYoloPositionsTable"><div class="empty-state">No positions</div></div></div>
      </div>
    </div>
    </div><!-- End botCardsContent -->

    <!-- BTC Market Bias Systems (A/B Testing) -->
    <div class="card" style="margin-top: 20px;">
      <div class="card-header">
        <span class="card-title">📊 BTC Market Bias</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button onclick="refreshBtcRsi()" id="refreshRsiBtn" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; font-size: 12px; cursor: pointer;">
            Refresh
          </button>
        </div>
      </div>

      <!-- Bias System Tabs -->
      <div style="display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid #30363d;">
        <button id="tabSystemA" onclick="switchBiasTab('A')" class="bias-tab active" style="padding: 10px 20px; border: none; background: transparent; color: #58a6ff; font-size: 13px; font-weight: 600; cursor: pointer; border-bottom: 2px solid #58a6ff;">
          System A (RSI Only)
        </button>
        <button id="tabSystemB" onclick="switchBiasTab('B')" class="bias-tab" style="padding: 10px 20px; border: none; background: transparent; color: #8b949e; font-size: 13px; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent;">
          System B (Multi-Indicator)
        </button>
      </div>

      <!-- System A: RSI Multi-Timeframe (Current) -->
      <div id="biasSystemA" style="display: block;">
        <div id="marketBiasBox" style="margin-bottom: 16px; padding: 16px; background: #0d1117; border-radius: 8px; border: 2px solid #30363d; text-align: center;">
          <div style="display: flex; justify-content: center; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px;">Market Bias (RSI)</div>
              <div id="marketBiasLabel" style="font-size: 28px; font-weight: bold; color: #8b949e; margin: 4px 0;">-</div>
            </div>
            <div style="text-align: left;">
              <div id="marketBiasReason" style="font-size: 13px; color: #c9d1d9;">Analyzing...</div>
              <div id="marketBiasScore" style="font-size: 11px; color: #6e7681;">Score: -</div>
            </div>
          </div>
          <div id="marketBiasAdvice" style="margin-top: 12px; padding: 8px 12px; background: #161b22; border-radius: 6px; font-size: 12px; color: #8b949e;">
            Waiting for data...
          </div>
        </div>
      </div>

      <!-- System B: Multi-Indicator (Funding Rate, OI, etc) -->
      <div id="biasSystemB" style="display: none;">
        <div id="marketBiasBoxB" style="margin-bottom: 16px; padding: 16px; background: #0d1117; border-radius: 8px; border: 2px solid #1f6feb; text-align: center;">
          <div style="display: flex; justify-content: center; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 11px; color: #58a6ff; text-transform: uppercase; letter-spacing: 1px;">Market Bias (Multi-Indicator)</div>
              <div id="marketBiasLabelB" style="font-size: 28px; font-weight: bold; color: #8b949e; margin: 4px 0;">-</div>
            </div>
            <div style="text-align: left;">
              <div id="marketBiasReasonB" style="font-size: 13px; color: #c9d1d9;">Analyzing...</div>
              <div id="marketBiasScoreB" style="font-size: 11px; color: #6e7681;">Score: - | Confidence: -</div>
            </div>
          </div>

          <!-- Indicator Breakdown -->
          <div id="indicatorBreakdown" style="margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; text-align: left;">
            <div class="indicator-box" id="indRSI" style="padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
              <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">RSI Multi-TF</div>
              <div style="font-size: 14px; font-weight: bold; color: #8b949e; margin: 2px 0;">-</div>
              <div style="font-size: 10px; color: #6e7681;">-</div>
            </div>
            <div class="indicator-box" id="indFunding" style="padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
              <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Funding Rate</div>
              <div style="font-size: 14px; font-weight: bold; color: #8b949e; margin: 2px 0;">-</div>
              <div style="font-size: 10px; color: #6e7681;">-</div>
            </div>
            <div class="indicator-box" id="indOI" style="padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
              <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Open Interest</div>
              <div style="font-size: 14px; font-weight: bold; color: #8b949e; margin: 2px 0;">-</div>
              <div style="font-size: 10px; color: #6e7681;">-</div>
            </div>
            <div class="indicator-box" id="indPremium" style="padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
              <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Premium/Discount</div>
              <div style="font-size: 14px; font-weight: bold; color: #8b949e; margin: 2px 0;">-</div>
              <div style="font-size: 10px; color: #6e7681;">-</div>
            </div>
            <div class="indicator-box" id="indMomentum" style="padding: 10px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
              <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Momentum</div>
              <div style="font-size: 14px; font-weight: bold; color: #8b949e; margin: 2px 0;">-</div>
              <div style="font-size: 10px; color: #6e7681;">-</div>
            </div>
          </div>

          <!-- Market Data Summary -->
          <div id="marketDataSummary" style="margin-top: 12px; padding: 8px 12px; background: #161b22; border-radius: 6px; font-size: 11px; color: #8b949e; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap;">
            <span>Price: <span id="mdPrice">-</span></span>
            <span>Funding: <span id="mdFunding">-</span></span>
            <span>OI: <span id="mdOI">-</span></span>
            <span>24h: <span id="mdChange">-</span></span>
          </div>
        </div>
      </div>

      <!-- Signal Summary -->
      <div id="btcSignalSummary" style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;">
        <div class="signal-box" data-tf="4h" style="flex: 1; min-width: 90px; padding: 8px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e;">4H</div>
          <div id="signal4h" style="font-size: 14px; font-weight: bold; color: #8b949e;">-</div>
          <div id="rsi4h" style="font-size: 11px; color: #6e7681;">RSI: -</div>
          <div id="div4h" style="font-size: 10px; color: #6e7681; margin-top: 4px;">-</div>
        </div>
        <div class="signal-box" data-tf="1h" style="flex: 1; min-width: 90px; padding: 8px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e;">1H</div>
          <div id="signal1h" style="font-size: 14px; font-weight: bold; color: #8b949e;">-</div>
          <div id="rsi1h" style="font-size: 11px; color: #6e7681;">RSI: -</div>
          <div id="div1h" style="font-size: 10px; color: #6e7681; margin-top: 4px;">-</div>
        </div>
        <div class="signal-box" data-tf="15m" style="flex: 1; min-width: 90px; padding: 8px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e;">15M</div>
          <div id="signal15m" style="font-size: 14px; font-weight: bold; color: #8b949e;">-</div>
          <div id="rsi15m" style="font-size: 11px; color: #6e7681;">RSI: -</div>
          <div id="div15m" style="font-size: 10px; color: #6e7681; margin-top: 4px;">-</div>
        </div>
        <div class="signal-box" data-tf="5m" style="flex: 1; min-width: 90px; padding: 8px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e;">5M</div>
          <div id="signal5m" style="font-size: 14px; font-weight: bold; color: #8b949e;">-</div>
          <div id="rsi5m" style="font-size: 11px; color: #6e7681;">RSI: -</div>
          <div id="div5m" style="font-size: 10px; color: #6e7681; margin-top: 4px;">-</div>
        </div>
        <div class="signal-box" data-tf="1m" style="flex: 1; min-width: 90px; padding: 8px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e;">1M</div>
          <div id="signal1m" style="font-size: 14px; font-weight: bold; color: #8b949e;">-</div>
          <div id="rsi1m" style="font-size: 11px; color: #6e7681;">RSI: -</div>
          <div id="div1m" style="font-size: 10px; color: #6e7681; margin-top: 4px;">-</div>
        </div>
      </div>

      <!-- Momentum Indicators Row -->
      <div id="momentumIndicators" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px;">
        <div class="momentum-box" style="padding: 12px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">BTC Price</div>
          <div id="btcCurrentPrice" style="font-size: 18px; font-weight: bold; color: #f0f6fc; margin: 4px 0;">-</div>
          <div style="display: flex; justify-content: center; gap: 8px; font-size: 11px;">
            <span id="btcChange1h" style="color: #8b949e;">1h: -</span>
            <span id="btcChange4h" style="color: #8b949e;">4h: -</span>
            <span id="btcChange24h" style="color: #8b949e;">24h: -</span>
          </div>
        </div>
        <div class="momentum-box" style="padding: 12px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Volatility (ATR)</div>
          <div id="btcVolatility" style="font-size: 18px; font-weight: bold; color: #f0f6fc; margin: 4px 0;">-</div>
          <div id="btcVolatilityLabel" style="font-size: 11px; color: #8b949e;">Loading...</div>
        </div>
        <div class="momentum-box" style="padding: 12px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">Volume vs Avg</div>
          <div id="btcVolumeRatio" style="font-size: 18px; font-weight: bold; color: #f0f6fc; margin: 4px 0;">-</div>
          <div id="btcVolumeLabel" style="font-size: 11px; color: #8b949e;">Loading...</div>
        </div>
        <div class="momentum-box" style="padding: 12px; background: #0d1117; border-radius: 6px; text-align: center; border: 1px solid #30363d;">
          <div style="font-size: 10px; color: #8b949e; text-transform: uppercase;">24h Range</div>
          <div id="btcRangePosition" style="font-size: 18px; font-weight: bold; color: #f0f6fc; margin: 4px 0;">-</div>
          <div id="btcRangeLabel" style="font-size: 11px; color: #8b949e;">Loading...</div>
        </div>
      </div>

      <!-- Strategy Performance Summary -->
      <div id="performanceSummary" style="background: #0d1117; border-radius: 8px; border: 1px solid #30363d; padding: 12px;">
        <div style="font-size: 11px; color: #8b949e; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;">Today's Performance</div>
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
          <div style="text-align: center;">
            <div style="font-size: 10px; color: #6e7681;">GP Bots (Best)</div>
            <div id="perfGpPnL" style="font-size: 16px; font-weight: bold; color: #8b949e;">$0.00</div>
            <div id="perfGpWinRate" style="font-size: 10px; color: #6e7681;">0W / 0L</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: #6e7681;">Trailing Bots</div>
            <div id="perfTrailPnL" style="font-size: 16px; font-weight: bold; color: #8b949e;">$0.00</div>
            <div id="perfTrailWinRate" style="font-size: 10px; color: #6e7681;">0W / 0L</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: #6e7681;">Active Positions</div>
            <div id="perfActiveCount" style="font-size: 16px; font-weight: bold; color: #58a6ff;">0</div>
            <div id="perfUnrealizedPnL" style="font-size: 10px; color: #6e7681;">Unreal: $0</div>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 11px;">
            <span style="color: #6e7681;">GP Setups:</span>
            <span id="perfGpSetups" style="color: #c9d1d9; margin-left: 4px;">0 active</span>
            <span style="color: #6e7681; margin-left: 12px;">BB Setups:</span>
            <span id="perfBbSetups" style="color: #c9d1d9; margin-left: 4px;">0 active</span>
          </div>
          <div id="perfChoppyWarning" style="font-size: 11px; color: #d29922; display: none;">
            ⚠️ Choppy Market Detected
          </div>
        </div>
      </div>
    </div>
  </div>
  <script src="/static/js/dashboard.js"></script>
</body>
</html>`;
}

// Start server and screener
async function main() {
  console.log('🔥 Starting Backburner Web Server...');

  // Initialize Turso database if configured
  if (isTursoConfigured()) {
    console.log('📀 Initializing Turso database...');
    await initTursoSchema();
    console.log('✅ Turso database ready');
  } else {
    console.log('📁 Using local file storage (Turso not configured)');
  }

  console.log('📊 Running 4 paper trading bots:');
  console.log('   1. Fixed TP/SL: 1% pos, 10x, 20% TP/SL');
  console.log('   2. Trail 1%: 1% pos, 10x, trailing stop');
  console.log('   3. Trail 10% 10x: 10% pos, 10x, trailing stop (AGGRESSIVE)');
  console.log('   4. Trail 10% 20x: 10% pos, 20x, trailing stop (VERY AGGRESSIVE)');

  app.listen(PORT, () => {
    console.log(`✅ Web UI available at http://localhost:${PORT}`);

    // Self-ping to prevent Render free tier spin-down
    // Pings /api/state every 10 minutes to stay alive
    if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
      const selfPingUrl = `${process.env.RENDER_EXTERNAL_URL}/api/state`;
      console.log(`🔄 Self-ping enabled: ${selfPingUrl}`);

      setInterval(async () => {
        try {
          const response = await fetch(selfPingUrl);
          if (response.ok) {
            console.log(`[PING] Self-ping OK at ${new Date().toISOString()}`);
          }
        } catch (err) {
          console.log(`[PING] Self-ping failed:`, err);
        }
      }, 10 * 60 * 1000); // Every 10 minutes
    }
  });

  // Log bot configurations to data persistence
  const dataPersistence = getDataPersistence();
  dataPersistence.logBotConfig('fixed', 'Fixed 20/20', { ...fixedTPBot.getConfig() });
  dataPersistence.logBotConfig('fixed-be', 'Fixed BE', { ...fixedBreakevenBot.getConfig() });
  dataPersistence.logBotConfig('1pct', 'Trail Light', { ...trailing1pctBot.getConfig() });
  dataPersistence.logBotConfig('10pct10x', 'Trail Standard', { ...trailing10pct10xBot.getConfig() });
  dataPersistence.logBotConfig('10pct20x', 'Trail Aggressive', { ...trailing10pct20xBot.getConfig() });
  dataPersistence.logBotConfig('wide', 'Trail Wide', { ...trailWideBot.getConfig() });
  dataPersistence.logBotConfig('confluence', 'Multi-TF', { ...confluenceBot.getConfig() });
  dataPersistence.logBotConfig('btcExtreme', 'BTC Contrarian', { ...btcExtremeBot.getConfig() });
  dataPersistence.logBotConfig('btcTrend', 'BTC Momentum', { ...btcTrendBot.getConfig() });

  // Log shadow bot configurations
  for (const { id, bot, stopPct } of shadowBots) {
    dataPersistence.logBotConfig(id, `Shadow SL${stopPct}%`, { ...bot.getConfig(), isShadow: true });
  }

  // Log timeframe strategy shadow bot configurations
  for (const { id, bot, desc } of timeframeShadowBots) {
    dataPersistence.logBotConfig(id, desc, { ...bot.getConfig(), isTimeframeShadow: true });
  }

  // Log combined strategy bot configuration
  dataPersistence.logBotConfig(combinedStrategyBot.getBotId(), 'Combined 4H+5m Strategy', {
    ...combinedStrategyBot.getConfig(),
    isCombinedStrategy: true,
  });

  // Log GP shadow bot configurations
  for (const { id, bot, desc } of gpShadowBots) {
    dataPersistence.logBotConfig(id, desc, { ...bot.getConfig(), isGpShadow: true });
  }

  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
  // Log BTC Bias V2 bot configurations
  for (const [key, bot] of btcBiasBotsV2) {
    dataPersistence.logBotConfig(key, bot.getName(), { ...bot.getConfig() });
  }
  // Log GP V2 bot configurations
  for (const [key, bot] of goldenPocketBotsV2) {
    dataPersistence.logBotConfig(key, `GP2 ${key.replace('gp2-', '')}`, { ...bot.getConfig() });
  }
  console.log('📊 Bot configurations logged to data persistence');

  // Register hourly snapshot callback for comprehensive data collection
  dataPersistence.registerHourlySnapshotCallback(() => {
    const now = new Date();
    const hour = `${now.toISOString().split('T')[0]}-${now.getHours().toString().padStart(2, '0')}`;

    // Collect bot states
    const bots: Record<string, {
      botId: string;
      botType: string;
      balance: number;
      unrealizedPnL: number;
      openPositionCount: number;
      openPositions: Array<{
        symbol: string;
        direction: string;
        entryPrice: number;
        currentPrice: number;
        unrealizedPnL: number;
        unrealizedROI: number;
      }>;
      closedTradesToday: number;
      pnlToday: number;
      stopPct?: number;  // For shadow bots - indicates the stop loss % being tested
    }> = {};

    // Trailing bots
    const trailingBots = [
      { id: 'trailing1pct', bot: trailing1pctBot, type: 'trailing' },
      { id: 'trailing10pct10x', bot: trailing10pct10xBot, type: 'trailing' },
      { id: 'trailing10pct20x', bot: trailing10pct20xBot, type: 'trailing' },
      { id: 'trailWide', bot: trailWideBot, type: 'trailing' },
    ];

    for (const { id, bot, type } of trailingBots) {
      const stats = bot.getStats();
      const positions = bot.getOpenPositions();
      bots[id] = {
        botId: id,
        botType: type,
        balance: stats.currentBalance,
        unrealizedPnL: positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: (p as any).unrealizedROI || 0,
        })),
        closedTradesToday: stats.totalTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // Shadow bots (stop loss A/B testing)
    for (const { id, bot, stopPct } of shadowBots) {
      const stats = bot.getStats();
      const positions = bot.getOpenPositions();
      bots[id] = {
        botId: id,
        botType: 'shadow',
        balance: stats.currentBalance,
        unrealizedPnL: positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: (p as any).unrealizedROI || 0,
        })),
        closedTradesToday: stats.totalTrades,
        pnlToday: stats.totalPnL,
        stopPct,  // Extra metadata for shadow bots
      };
    }

    // Timeframe strategy shadow bots (5m fade vs 4H normal testing)
    for (const { id, bot } of timeframeShadowBots) {
      const stats = bot.getStats();
      const positions = bot.getOpenPositions();
      bots[id] = {
        botId: id,
        botType: 'timeframe_shadow',
        balance: stats.currentBalance,
        unrealizedPnL: positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: p.unrealizedPnLPercent || 0,
        })),
        closedTradesToday: stats.closedTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // Combined strategy bot (4H normal + 5m fade)
    {
      const stats = combinedStrategyBot.getStats();
      const positions = combinedStrategyBot.getOpenPositions();
      bots[combinedStrategyBot.getBotId()] = {
        botId: combinedStrategyBot.getBotId(),
        botType: 'combined_strategy',
        balance: stats.currentBalance,
        unrealizedPnL: positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: p.unrealizedPnLPercent || 0,
        })),
        closedTradesToday: stats.closedTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // GP shadow bots (Golden Pocket RSI Zone strategy)
    for (const { id, bot } of gpShadowBots) {
      const stats = bot.getStats();
      const positions = bot.getOpenPositions();
      bots[id] = {
        botId: id,
        botType: 'gp_shadow',
        balance: stats.currentBalance,
        unrealizedPnL: positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: p.unrealizedPnLPercent || 0,
        })),
        closedTradesToday: stats.closedTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md

    // BTC Bias V2 bots (conservative params)
    for (const [key, bot] of btcBiasBotsV2) {
      const stats = bot.getStats();
      const position = bot.getPosition();
      bots[key] = {
        botId: key,
        botType: 'btc_bias_v2',
        balance: stats.currentBalance,
        unrealizedPnL: bot.getUnrealizedPnL(),
        openPositionCount: position ? 1 : 0,
        openPositions: position ? [{
          symbol: 'BTCUSDT',
          direction: position.direction,
          entryPrice: position.entryPrice,
          currentPrice: position.highestPrice,
          unrealizedPnL: position.unrealizedPnL,
          unrealizedROI: position.unrealizedROI,
        }] : [],
        closedTradesToday: stats.totalTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // GP V2 bots (loose thresholds)
    for (const [key, bot] of goldenPocketBotsV2) {
      const stats = bot.getStats();
      const positions = bot.getOpenPositions();
      bots[key] = {
        botId: key,
        botType: 'gp_v2',
        balance: bot.getBalance(),
        unrealizedPnL: bot.getUnrealizedPnL(),
        openPositionCount: positions.length,
        openPositions: positions.map(p => ({
          symbol: p.symbol,
          direction: p.direction,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice || p.entryPrice,
          unrealizedPnL: p.unrealizedPnL || 0,
          unrealizedROI: 0,
        })),
        closedTradesToday: stats.totalTrades,
        pnlToday: stats.totalPnL,
      };
    }

    // Get active setups count (use screener which is module-scoped)
    const allSetups = screener.getAllSetups();
    const activeSetups = {
      total: allSetups.length,
      triggered: allSetups.filter(s => s.state === 'triggered').length,
      deepExtreme: allSetups.filter(s => s.state === 'deep_extreme').length,
    };

    return {
      timestamp: now.toISOString(),
      hour,
      btcPrice: lastBtcPrice || 0,
      btcBias: currentBtcBias || 'unknown',
      btcRsi: lastBtcRsiData ? {
        '1m': lastBtcRsiData['1m'] || 0,
        '5m': lastBtcRsiData['5m'] || 0,
        '15m': lastBtcRsiData['15m'] || 0,
        '1h': lastBtcRsiData['1h'] || 0,
        '4h': lastBtcRsiData['4h'] || 0,
      } as Record<string, number> : {} as Record<string, number>,
      bots,
      activeSetups,
    };
  });
  console.log('⏰ Hourly snapshot callback registered');

  // Load server settings (daily reset, etc.)
  loadServerSettings();

  // Sync execution mode from persisted settings to experimental bots
  for (const [botId, bot] of experimentalBots) {
    bot.setExecutionMode(getExecutionModeForBot(botId));
  }

  // Wire up insurance callbacks for experimental bots (MEXC half-close on stress period gains)
  wireUpInsuranceCallbacks();

  // Sync conditional insurance setting from persisted settings
  for (const [botId, bot] of experimentalBots) {
    if (bot.setConditionalInsurance) {
      bot.setConditionalInsurance(serverSettings.conditionalInsuranceEnabled);
    }
  }
  console.log(`[INSURANCE] Conditional insurance: ${serverSettings.conditionalInsuranceEnabled ? 'ENABLED' : 'DISABLED'}`);

  // Restore experimental bot state (critical for trailing stop persistence across restarts)
  for (const [botId, bot] of experimentalBots) {
    const saved = dataPersistence.loadPositions(botId);
    if (saved && saved.openPositions && saved.openPositions.length > 0) {
      try {
        bot.restoreState({
          balance: saved.balance,
          peakBalance: saved.peakBalance,
          openPositions: saved.openPositions as Array<[string, any]>,
          closedPositions: (saved.closedPositions || []) as any[],
        });
      } catch (err) {
        console.error(`[EXP:${botId}] Failed to restore state:`, (err as Error).message);
      }
    }
  }

  // Sync leverage from server settings to selected experimental bots
  for (const botId of serverSettings.mexcSelectedBots) {
    const bot = experimentalBots.get(botId);
    if (bot) {
      bot.setLeverage(serverSettings.mexcMaxLeverage);
    }
  }

  // Bootstrap stress detection from Turso historical trade data
  // This ensures stress detection works immediately after server restart
  if (isTursoConfigured()) {
    (async () => {
      try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const result = await executeReadQuery(
          `SELECT timestamp, realized_pnl_percent, exit_reason
           FROM trade_events
           WHERE bot_id = ? AND event_type = 'close' AND timestamp >= ?
           ORDER BY timestamp DESC
           LIMIT 100`,
          ['exp-bb-sysB', twoHoursAgo]
        );

        if (result.success && result.rows && result.rows.length > 0) {
          const closes = (result.rows as Array<Record<string, unknown>>).map(row => ({
            timestamp: new Date(row.timestamp as string).getTime(),
            isWin: (row.exit_reason === 'trailing_stop' || (row.realized_pnl_percent as number) > 0),
          }));

          const bot = experimentalBots.get('exp-bb-sysB');
          if (bot) {
            bot.bootstrapRecentCloses(closes);
          }
        } else {
          console.log('[STRESS] No recent trades found in Turso for stress detection');
        }
      } catch (err) {
        console.error('[STRESS] Failed to bootstrap stress detection:', (err as Error).message);
      }
    })();
  }

  // Reconcile trailing manager with MEXC positions on startup
  (async () => {
    try {
      const client = initMexcClient();
      if (!client) {
        console.log('[RECONCILE] Skipping — MEXC client not available');
        return;
      }

      // 0. Fetch MEXC balance immediately on startup (needed for percent sizing)
      const balResult = await fetchMexcBalance();
      if (balResult) {
        console.log(`[STARTUP] MEXC balance cached: $${balResult.available.toFixed(2)} available`);
      } else {
        console.log(`[STARTUP] Failed to fetch MEXC balance — percent sizing will fall back to fixed USD`);
      }

      // 1. Load trailing positions from Turso
      if (isTursoConfigured()) {
        const savedPositions = await loadTrailingPositions();
        if (savedPositions.length > 0) {
          trailingManager.restoreState(savedPositions as TrackedPosition[]);
          // Verify plan orders still exist on MEXC
          await trailingManager.verifyPlanOrders(client);
          console.log(`[RECONCILE] Restored ${savedPositions.length} trailing positions from Turso`);
        }
      }

      // 2. Get all live MEXC positions
      const posResult = await client.getOpenPositions();
      if (!posResult.success || !posResult.data) {
        console.log('[RECONCILE] Could not fetch MEXC positions');
        return;
      }

      const mexcPositions = posResult.data;
      const trackedSymbols = new Set(trailingManager.getTrackedPositions().map(p => p.symbol));

      // 3. For each MEXC position not already tracked — start tracking with initial SL
      for (const pos of mexcPositions) {
        if (!trackedSymbols.has(pos.symbol)) {
          console.warn(`[RECONCILE] MEXC position ${pos.symbol} not tracked — creating SL plan order and tracking`);
          const direction = pos.positionType === 1 ? 'long' as const : 'short' as const;
          const leverage = pos.leverage || serverSettings.mexcMaxLeverage;
          const initialStopPct = 8;  // ROE-based: 8% ROE loss max
          const slPriceDistance = initialStopPct / 100 / leverage;  // Convert ROE% to price%
          const slPrice = direction === 'long'
            ? pos.holdAvgPrice * (1 - slPriceDistance)
            : pos.holdAvgPrice * (1 + slPriceDistance);

          // Cancel any existing plan orders first to avoid duplicates on restart
          await client.cancelAllPlanOrders(pos.symbol);

          // Create a fresh plan order on MEXC so the trailing manager can modify it
          const slResult = await client.setStopLoss(pos.symbol, slPrice);
          if (!slResult.success) {
            console.warn(`[RECONCILE] Failed to create SL plan order for ${pos.symbol}: ${slResult.error}`);
          }

          await trailingManager.startTracking(client, {
            symbol: pos.symbol,
            direction,
            entryPrice: pos.holdAvgPrice,
            leverage,
            volume: pos.holdVol,
            stopLossPrice: slPrice,
            botId: 'reconciled',
          });

          if (isTursoConfigured()) {
            const tracked = trailingManager.getPosition(pos.symbol);
            if (tracked) {
              saveTrailingPosition(pos.symbol, tracked).catch(e =>
                console.error(`[RECONCILE] Turso save failed for ${pos.symbol}:`, e)
              );
            }
          }
        }
      }

      // 4. For each tracked position not on MEXC — SL fired while server was down
      const mexcSymbols = new Set(mexcPositions.map(p => p.symbol));
      const closedWhileDown = trailingManager.detectExternalCloses(mexcSymbols);
      for (const sym of closedWhileDown) {
        console.log(`[RECONCILE] ${sym} was closed while server was down (SL fired on exchange)`);
        logBotDecision('trail-mgr', sym, 'reconcile_close', 'Position closed while server was offline');
        if (isTursoConfigured()) {
          deleteTrailingPosition(sym).catch(e =>
            console.error(`[RECONCILE] Turso delete failed for ${sym}:`, e)
          );
        }
      }

      console.log(`[RECONCILE] Done — tracking ${trailingManager.getTrackedPositions().length} positions`);
    } catch (err) {
      console.error('[RECONCILE] Error during startup reconciliation:', (err as Error).message);
    }
  })();

  // Check for daily reset on startup
  checkDailyReset();

  // Periodic daily reset check (every 5 minutes)
  setInterval(() => {
    checkDailyReset();
    cleanupStaleExhaustion();  // Also clean up stale momentum exhaustion signals
  }, 5 * 60 * 1000);

  // Position persistence DISABLED - start fresh each time
  // To re-enable, uncomment the loadState() calls below
  console.log('📊 Starting with fresh bot state (persistence disabled)');
  // trailing1pctBot.loadState();
  // trailing10pct10xBot.loadState();
  // trailing10pct20xBot.loadState();
  // trailWideBot.loadState();

  // Save all bot states (to disk and Turso)
  const saveAllBotStates = () => {
    // Trailing bots (have saveState method)
    trailing1pctBot.saveState();
    trailing10pct10xBot.saveState();
    trailing10pct20xBot.saveState();
    trailWideBot.saveState();

    // Fixed TP bot - manual save
    dataPersistence.savePositions(
      'fixed',
      fixedTPBot.getOpenPositions(),
      fixedTPBot.getClosedPositions(100),
      fixedTPBot.getBalance(),
      fixedTPBot.getStats().peakBalance
    );

    // Fixed BE bot - manual save
    dataPersistence.savePositions(
      'fixed-be',
      fixedBreakevenBot.getOpenPositions(),
      fixedBreakevenBot.getClosedPositions(100),
      fixedBreakevenBot.getBalance(),
      fixedBreakevenBot.getStats().peakBalance
    );

    // Confluence bot - manual save
    dataPersistence.savePositions(
      'confluence',
      confluenceBot.getOpenPositions(),
      confluenceBot.getClosedPositions(),
      confluenceBot.getBalance(),
      confluenceBot.getStats().peakBalance
    );

    // GP bots - manual save
    for (const [botId, bot] of goldenPocketBots) {
      const positions = bot.getOpenPositions();
      const closedPositions = bot.getClosedPositions();
      const stats = bot.getStats();
      dataPersistence.savePositions(botId, positions, closedPositions, stats.currentBalance, stats.peakBalance);
    }

    // MEXC sim bots
    for (const [botId, bot] of mexcSimBots) {
      const positions = bot.getOpenPositions();
      const closedPositions = bot.getClosedPositions();
      const stats = bot.getStats();
      dataPersistence.savePositions(botId, positions, closedPositions, stats.currentBalance, stats.peakBalance);
    }

    // Experimental shadow bots - save state for trailing stop persistence
    for (const [botId, bot] of experimentalBots) {
      const state = bot.saveState();
      dataPersistence.savePositions(
        botId,
        state.openPositions,
        state.closedPositions,
        state.balance,
        state.peakBalance
      );
    }
  };

  // Graceful shutdown handler
  const saveAllPositions = () => {
    saveAllBotStates();
    dataPersistence.stop();
    console.log('✅ Shutdown complete');
  };

  // Periodic state save to Turso (every 5 minutes)
  setInterval(() => {
    saveAllBotStates();
    console.log('[STATE] Bot states saved to Turso');
  }, 5 * 60 * 1000);

  // Handle various shutdown signals
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT (Ctrl+C)');
    saveAllPositions();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM');
    saveAllPositions();
    process.exit(0);
  });

  // Handle uncaught exceptions - log crash and save state
  process.on('uncaughtException', (error) => {
    console.error('\n❌ Uncaught Exception:', error);
    dataPersistence.logCrash(error, { type: 'uncaughtException' });
    saveAllPositions();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error('\n❌ Unhandled Rejection:', error);
    dataPersistence.logCrash(error, { type: 'unhandledRejection', promise: String(promise) });
    // Don't exit on unhandled rejections, just log
  });

  try {
    await screener.start();
    console.log('✅ Screener started');

    // Periodic real-time price updates for ALL positions (every 10 seconds)
    // This ensures P&L is calculated from live ticker data, not stale candle closes
    setInterval(async () => {
      // Helper to track and broadcast position closures
      const trackClosures = <T extends { id?: string; status?: string }>(
        botId: string,
        openBefore: T[],
        openAfter: T[],
        closedPositions: T[]
      ) => {
        const beforeIds = new Set(openBefore.map(p => p.id));
        const afterIds = new Set(openAfter.map(p => p.id));
        const closedIds = [...beforeIds].filter(id => !afterIds.has(id));

        for (const closedId of closedIds) {
          const closedPos = closedPositions.find(p => p.id === closedId);
          if (closedPos) {
            broadcast('position_closed', { bot: botId, position: closedPos });
          }
        }
      };

      // Update System B bias for experimental bots (they need this for their filters)
      try {
        const systemB = getMarketBiasSystemB();
        const result = await systemB.calculateBias();
        for (const [, bot] of experimentalBots) {
          bot.updateBias(result);
        }
      } catch (biasErr) {
        console.error('[EXP BOTS] Error updating System B bias:', biasErr);
      }

      // Update ALL positions with real-time prices (for trailing bots that have the new method)
      // Use getPrice which handles both spot and futures markets
      await fixedTPBot.updateOrphanedPositions(getCurrentPrice);
      await trailing1pctBot.updateAllPositionPrices(getPrice);
      await trailing10pct10xBot.updateAllPositionPrices(getPrice);
      await trailing10pct20xBot.updateAllPositionPrices(getPrice);
      await trailWideBot.updateAllPositionPrices(getPrice);
      await confluenceBot.updateOrphanedPositions(getCurrentPrice);

      // Update shadow bots with real-time prices
      for (const { bot } of shadowBots) {
        await bot.updateAllPositionPrices(getPrice);
      }

      // Update timeframe strategy shadow bots with real-time prices
      for (const { bot } of timeframeShadowBots) {
        await bot.updateAllPositionPrices(getPrice);
      }

      // Update combined strategy bot positions with real-time prices
      await combinedStrategyBot.updateAllPositionPrices(getPrice);

      // Update GP shadow bot positions with real-time prices
      for (const { bot } of gpShadowBots) {
        await bot.updateAllPositionPrices(getPrice);
      }

      // Track and broadcast trend override closures
      const overrideBefore = trendOverrideBot.getOpenPositions();
      await trendOverrideBot.updateOrphanedPositions(getCurrentPrice);
      const overrideAfter = trendOverrideBot.getOpenPositions();
      trackClosures('trendOverride', overrideBefore, overrideAfter, trendOverrideBot.getClosedPositions(10));

      // Track and broadcast trend flip closures
      const flipBefore = trendFlipBot.getOpenPositions();
      await trendFlipBot.updateOrphanedPositions(getCurrentPrice, currentBtcBias);
      const flipAfter = trendFlipBot.getOpenPositions();
      trackClosures('trendFlip', flipBefore, flipAfter, trendFlipBot.getClosedPositions(10));

      // Update MEXC simulation bots and track closures
      for (const [botId, bot] of mexcSimBots) {
        const openBefore = bot.getOpenPositions();
        await bot.updateAllPositionPrices(getCurrentPrice);
        const openAfter = bot.getOpenPositions();
        trackClosures(botId, openBefore, openAfter, bot.getClosedPositions());
      }

      // Update Golden Pocket bot positions with current prices
      const gpPriceMap = new Map<string, number>();
      for (const [, bot] of goldenPocketBots) {
        for (const symbol of bot.getOpenSymbols()) {
          if (!gpPriceMap.has(symbol)) {
            const price = await getPrice(symbol, 'futures');
            if (price) gpPriceMap.set(symbol, price);
          }
        }
        bot.updateAllPositionsWithPrices(gpPriceMap);
      }

      // Update Fade bot positions with current prices and track closures
      const fadePriceMap = new Map<string, number>();
      for (const [botId, bot] of fadeBots) {
        const openBefore = bot.getOpenPositions();
        // Collect all symbols that need prices
        for (const pos of openBefore) {
          if (!fadePriceMap.has(pos.symbol)) {
            const price = await getPrice(pos.symbol, 'futures');
            if (price) fadePriceMap.set(pos.symbol, price);
          }
        }
        // Update positions and check for stop hits
        const { closed } = bot.updatePositions(fadePriceMap);
        // Broadcast any closed positions
        for (const closedPos of closed) {
          broadcast('position_closed', { bot: botId, position: closedPos });
        }
      }

      // Update Spot Regime bot positions with current prices and track closures
      for (const [botId, bot] of spotRegimeBots) {
        const positions = bot.getPositions();
        for (const pos of positions) {
          // Get spot price for this symbol
          const price = await getPrice(pos.symbol, 'spot');
          if (price) {
            const closeResult = bot.updatePrice(pos.symbol, pos.timeframe, price, Date.now());
            if (closeResult) {
              console.log(`[REGIME:${botId}] CLOSED ${pos.symbol}: ${closeResult.exitReason} | PnL: $${closeResult.netPnL.toFixed(2)}`);
              broadcast('position_closed', { bot: botId, position: closeResult });

              // Log close event to persistence using the position object format
              const dataPersistence = getDataPersistence();
              const positionForClose = {
                positionId: closeResult.positionId,
                symbol: closeResult.symbol,
                direction: 'long' as const,
                timeframe: closeResult.timeframe,
                marketType: 'spot' as const,
                entryPrice: closeResult.entryPriceWithSlippage,
                entryTime: closeResult.entryTime,
                exitPrice: closeResult.exitPriceWithSlippage,
                exitTime: closeResult.exitTime,
                exitReason: closeResult.exitReason,
                realizedPnL: closeResult.netPnL,
                realizedPnLPercent: closeResult.netPnLPercent,
                marginUsed: 100,  // Default position size
                notionalSize: 100,
                leverage: 1,
                takeProfitPrice: 0,
                stopLossPrice: 0,
              };
              dataPersistence.logTradeClose(botId, positionForClose as any, getExecutionModeForBot(botId));
            }
          }
        }
      }

      // Update Focus Mode Shadow bot positions with current prices and track closures
      const focusPriceMap = new Map<string, number>();
      for (const [botId, bot] of focusShadowBots) {
        const positions = bot.getPositions();
        // Collect all symbols that need prices
        for (const pos of positions) {
          if (!focusPriceMap.has(pos.symbol)) {
            const price = await getPrice(pos.symbol, 'futures');
            if (price) focusPriceMap.set(pos.symbol, price);
          }
        }

        // Update all positions and get closed ones
        const closed = bot.updatePrices(focusPriceMap, Date.now());

        // Broadcast and log any closed positions
        for (const closedPos of closed) {
          console.log(`[FOCUS:${botId}] CLOSED ${closedPos.symbol}: ${closedPos.exitReason} | PnL: $${closedPos.realizedPnl.toFixed(2)}`);
          broadcast('position_closed', { bot: botId, position: closedPos });

          // Log close event to persistence
          const dataPersistence = getDataPersistence();
          const positionForClose = {
            id: closedPos.positionId,
            symbol: closedPos.symbol,
            direction: closedPos.direction,
            timeframe: closedPos.timeframe,
            marketType: 'futures' as const,
            entryPrice: closedPos.entryPrice,
            entryTime: closedPos.entryTime,
            exitPrice: closedPos.exitPrice,
            exitTime: closedPos.exitTime,
            exitReason: closedPos.exitReason,
            realizedPnL: closedPos.realizedPnl,
            realizedPnLPercent: closedPos.realizedPnlPercent,
            marginUsed: closedPos.marginUsed,
            notionalSize: closedPos.notionalSize,
            leverage: closedPos.leverage,
            takeProfitPrice: closedPos.takeProfit,
            stopLossPrice: closedPos.stopLoss,
            // Focus Mode specific fields for regime analysis
            entryQuadrant: closedPos.entryQuadrant,
            entryQuality: closedPos.entryQuality,
            trailActivated: closedPos.trailActivated,
            highestPnlPercent: closedPos.highestPnlPercent,
          };
          dataPersistence.logTradeClose(botId, positionForClose as any, getExecutionModeForBot(botId));
        }
      }

      // Update Experimental bot positions with current prices and track closures
      const expPriceMap = new Map<string, number>();
      for (const [botId, bot] of experimentalBots) {
        // Get state to access positions
        const state = bot.getState();
        // Collect all symbols that need prices from open positions
        for (const pos of state.openPositions) {
          if (!expPriceMap.has(pos.symbol)) {
            const price = await getPrice(pos.symbol, 'futures');
            if (price) expPriceMap.set(pos.symbol, price);
          }
        }

        // Update all positions and get closed ones
        const closed = bot.updatePrices(expPriceMap);

        // Broadcast and log any closed positions
        for (const closedPos of closed) {
          console.log(`[EXP:${botId}] CLOSED ${closedPos.symbol}: ${closedPos.exitReason} | PnL: $${closedPos.realizedPnl.toFixed(2)}`);
          broadcast('position_closed', { bot: botId, position: closedPos });

          // Close corresponding MEXC live position if this bot is selected for execution
          // IMPORTANT: Only close MEXC for trailing_stop exits (we manage trailing ourselves)
          // For stop_loss exits, let MEXC's own SL trigger - paper bot uses different leverage math
          // and would close MEXC positions prematurely (paper=20x, MEXC=10x means paper SL triggers sooner)
          if (getMexcExecutionMode() === 'live' && serverSettings.mexcSelectedBots.includes(botId)) {
            const futuresSymbol = spotSymbolToFutures(closedPos.symbol);

            // Only actively close MEXC for trailing stops (we manage those)
            // SL exits: MEXC has its own SL order that will fire - don't double-close
            const shouldCloseMexc = closedPos.exitReason === 'trailing_stop' ||
                                    closedPos.exitReason === 'insurance_be';

            if (shouldCloseMexc) {
              const client = initMexcClient();
              if (client) {
                try {
                  const closeResult = await client.closePosition(futuresSymbol);
                  if (closeResult.success) {
                    console.log(`[MEXC-EXIT] Closed ${futuresSymbol} ${closedPos.direction} | Reason: ${closedPos.exitReason} | Paper PnL: $${closedPos.realizedPnl.toFixed(2)}`);
                  } else {
                    console.error(`[MEXC-EXIT] Failed to close ${futuresSymbol}: ${closeResult.error}`);
                  }
                } catch (err) {
                  console.error(`[MEXC-EXIT] Error closing ${futuresSymbol}:`, (err as Error).message);
                }
              }
            } else {
              console.log(`[MEXC-EXIT] Skipping close for ${futuresSymbol} (${closedPos.exitReason}) — letting MEXC SL handle it`);
            }

            // Stop trailing manager tracking for this position regardless
            if (trailingManager.isTracking(futuresSymbol)) {
              trailingManager.stopTracking(futuresSymbol);
              if (isTursoConfigured()) {
                deleteTrailingPosition(futuresSymbol).catch(e =>
                  console.error(`[TRAIL-MGR] Turso delete failed for ${futuresSymbol}:`, e)
                );
              }
            }
          }

          // Log close event to persistence
          const dataPersistence = getDataPersistence();
          const positionForClose = {
            id: closedPos.id,
            symbol: closedPos.symbol,
            direction: closedPos.direction,
            timeframe: '5m',  // Default for experimental
            marketType: 'futures' as const,
            entryPrice: closedPos.entryPrice,
            entryTime: closedPos.entryTime,
            exitPrice: closedPos.exitPrice,
            exitTime: closedPos.exitTime,
            exitReason: closedPos.exitReason,
            realizedPnL: closedPos.realizedPnl,
            realizedPnLPercent: closedPos.realizedPnlPercent,
            marginUsed: closedPos.positionSize,
            notionalSize: closedPos.positionSize * closedPos.leverage,
            leverage: closedPos.leverage,
            takeProfitPrice: closedPos.takeProfit,
            stopLossPrice: closedPos.stopLoss,
            // Experimental bot specific fields
            entryBias: closedPos.entryBias,
            entryQuadrant: closedPos.entryQuadrant,
            trailActivated: closedPos.trailActivated,
            highestPnlPercent: closedPos.highestPnlPercent,
          };
          dataPersistence.logTradeClose(botId, positionForClose as any, getExecutionModeForBot(botId));
        }
      }

      // Update exchange-side trailing stops with current prices
      if (trailingManager.getTrackedPositions().length > 0) {
        try {
          const client = initMexcClient();
          if (client) {
            // Build futures-symbol price map for trailing manager
            const futuresPriceMap = new Map<string, number>();
            for (const [spotSymbol, price] of expPriceMap) {
              futuresPriceMap.set(spotSymbolToFutures(spotSymbol), price);
            }
            // Also fetch prices for any tracked symbols not in expPriceMap
            for (const pos of trailingManager.getTrackedPositions()) {
              if (!futuresPriceMap.has(pos.symbol)) {
                try {
                  const ticker = await client.getTickerPrice(pos.symbol);
                  if (ticker.success && ticker.price) {
                    futuresPriceMap.set(pos.symbol, ticker.price);
                  }
                } catch { /* skip */ }
              }
            }
            const modified = await trailingManager.updatePrices(client, futuresPriceMap);
            if (modified.length > 0) {
              // Persist updated positions to Turso
              if (isTursoConfigured()) {
                for (const sym of modified) {
                  const pos = trailingManager.getPosition(sym);
                  if (pos) {
                    saveTrailingPosition(sym, pos).catch(e =>
                      console.error(`[TRAIL-MGR] Turso save failed for ${sym}:`, e)
                    );
                  }
                }
              }
            }

            // Update MEXC mirror positions with same price data
            const mirrorClosed = mexcMirrorTracker.updatePrices(futuresPriceMap);
            for (const closedPos of mirrorClosed) {
              console.log(`[MIRROR] Position closed: ${closedPos.symbol} ${closedPos.exitReason} | PnL: $${closedPos.realizedPnl.toFixed(2)}`);

              // Log to Turso with execution_mode='live-mirror'
              if (isTursoConfigured()) {
                const dataPersistence = getDataPersistence();
                const positionForClose = {
                  id: closedPos.id,
                  symbol: closedPos.symbol.replace('_USDT', 'USDT'),
                  direction: closedPos.direction,
                  timeframe: '5m' as const,
                  marketType: 'futures' as const,
                  entryPrice: closedPos.entryPrice,
                  entryTime: closedPos.entryTime,
                  exitPrice: closedPos.exitPrice,
                  exitTime: closedPos.exitTime,
                  exitReason: closedPos.exitReason,
                  marginUsed: closedPos.marginUsed,
                  notionalSize: closedPos.notionalSize,
                  leverage: closedPos.leverage,
                  realizedPnL: closedPos.realizedPnl,
                  realizedPnLPercent: closedPos.realizedPnlPct,
                  trailActivated: closedPos.trailActivated,
                  highestPnlPercent: closedPos.highestPnlPct,
                  // Required fields for PaperPosition (not used for Turso logging)
                  takeProfitPrice: closedPos.takeProfitPrice,
                  stopLossPrice: closedPos.stopLossPrice,
                  currentPrice: closedPos.exitPrice,
                  unrealizedPnL: 0,
                  unrealizedPnLPercent: 0,
                };
                dataPersistence.logTradeClose('mexc-mirror', positionForClose as any, 'live-mirror');
              }
            }
          }
        } catch (err) {
          console.error('[TRAIL-MGR] Error updating prices:', (err as Error).message);
        }
      }

      // MEXC position lifecycle: detect SL/TP closures and update queue statuses
      if (getMexcExecutionMode() !== 'dry_run') {
        try {
          const client = initMexcClient();
          if (client) {
            const posResult = await client.getOpenPositions();
            if (posResult.success) {
              const openSymbols = new Set((posResult.data || []).map(p => p.symbol));

              // Check executed orders: if their symbol is no longer in open positions, mark as closed
              for (const order of mexcExecutionQueue) {
                if (order.status !== 'executed') continue;
                const futuresSymbol = spotSymbolToFutures(order.symbol);
                if (!openSymbols.has(futuresSymbol)) {
                  // Position is gone from MEXC — was closed (SL, TP, or manual)
                  const hadSL = order.stopLossPrice && order.stopLossPrice > 0;
                  const hadTP = order.takeProfitPrice && order.takeProfitPrice > 0;
                  order.status = 'closed';
                  order.closedAt = Date.now();

                  // CRITICAL: Fetch actual MEXC trade history to get real PnL
                  try {
                    const history = await client.getOrderHistory(futuresSymbol, 1, 10);
                    if (history.success && history.data && history.data.length > 0) {
                      // Find the close order (side 2 = close short, side 4 = close long)
                      const closeOrders = history.data.filter(o =>
                        (o.side === 2 || o.side === 4) && o.state === 3 // state 3 = filled
                      );
                      if (closeOrders.length > 0) {
                        const lastClose = closeOrders[0];
                        order.closedPnl = lastClose.profit;
                        const exitPrice = lastClose.dealAvgPrice;
                        const fees = (lastClose.takerFee || 0) + (lastClose.makerFee || 0);

                        // Detect HOW the position was closed
                        // orderType 1 = limit, 5 = market (manual), 6 = plan order (SL/TP triggered)
                        // category 1 = open, 2 = close
                        const closeType = lastClose.orderType === 5 ? 'MANUAL' :
                                         lastClose.orderType === 6 ? 'TRIGGERED' :
                                         lastClose.orderType === 1 ? 'LIMIT' : `TYPE_${lastClose.orderType}`;
                        const isManualClose = lastClose.orderType === 5;

                        console.log(`[MEXC-SYNC] ${order.symbol} ACTUAL MEXC RESULT: PnL=$${lastClose.profit.toFixed(4)} | Exit=$${exitPrice.toFixed(6)} | Type=${closeType} | Fees=$${fees.toFixed(4)}`);
                        logBotDecision(order.bot, order.symbol, isManualClose ? 'manual_close' : 'mexc_close_result', `${closeType} PnL: $${lastClose.profit.toFixed(4)} | Exit: $${exitPrice.toFixed(6)} | Fees: $${fees.toFixed(4)}`);

                        // Update cumulative MEXC stats
                        mexcTotalRealizedPnl += lastClose.profit;
                        mexcTotalTrades++;
                        if (lastClose.profit > 0) {
                          mexcWins++;
                        } else {
                          mexcLosses++;
                        }
                        const mexcWinRate = mexcTotalTrades > 0 ? (mexcWins / mexcTotalTrades * 100) : 0;
                        console.log(`[MEXC-STATS] Cumulative: $${mexcTotalRealizedPnl.toFixed(2)} | ${mexcTotalTrades} trades | WR: ${mexcWinRate.toFixed(0)}%`);

                        // Track in trailing manager for comparison API
                        const trackedPos = trailingManager.getPosition(futuresSymbol);

                        // PERSIST REAL MEXC TRADE TO TURSO
                        // This is the actual exchange result, not paper simulation
                        if (isTursoConfigured()) {
                          const entryPrice = trackedPos?.entryPrice || order.entryPrice || lastClose.price;
                          const direction = trackedPos?.direction || order.side;
                          const leverage = trackedPos?.leverage || order.leverage || 10;
                          const marginUsed = Math.abs(lastClose.profit) / (Math.abs((exitPrice - entryPrice) / entryPrice) * leverage) || 5;

                          // Calculate duration if we have entry time
                          const entryTime = order.executedAt || order.timestamp || lastClose.createTime;
                          const durationMs = lastClose.updateTime - entryTime;

                          const dataPersistence = getDataPersistence();
                          // Determine exit reason from order type
                          const mexcExitReason = lastClose.orderType === 5 ? 'manual_close' :
                                                  lastClose.orderType === 6 ? 'mexc_triggered' :
                                                  'mexc_close';

                          dataPersistence.logTradeClose('mexc-live', {
                            id: `mexc-${futuresSymbol}-${lastClose.updateTime}`,
                            symbol: futuresSymbol.replace('_USDT', 'USDT'),
                            direction: direction,
                            timeframe: '5m' as const,
                            marketType: 'futures' as const,
                            entryPrice: entryPrice,
                            entryTime: entryTime,
                            exitPrice: exitPrice,
                            exitTime: lastClose.updateTime,
                            exitReason: mexcExitReason,
                            marginUsed: marginUsed,
                            notionalSize: marginUsed * leverage,
                            leverage: leverage,
                            realizedPnL: lastClose.profit,
                            realizedPnLPercent: lastClose.profit / marginUsed * 100,
                            trailActivated: trackedPos?.trailActivated || false,
                            highestPnlPercent: trackedPos?.highestRoePct || 0,
                            takeProfitPrice: 0,
                            stopLossPrice: 0,
                            currentPrice: exitPrice,
                            unrealizedPnL: 0,
                            unrealizedPnLPercent: 0,
                            durationMs: durationMs,
                          } as any, 'mexc-live');
                          console.log(`[MEXC-PERSIST] Logged real MEXC trade: ${futuresSymbol} PnL=$${lastClose.profit.toFixed(4)} duration=${Math.round(durationMs/1000)}s`);
                        }
                        if (trackedPos) {
                          trailingManager.recordClose(
                            futuresSymbol,
                            trackedPos.direction,
                            trackedPos.entryPrice,
                            'mexc_sl_or_close',
                            exitPrice,
                            lastClose.profit
                          );
                        }

                        // Force close mirror position with actual MEXC exit price
                        const mirrorClosed = mexcMirrorTracker.forceClose(futuresSymbol, exitPrice, 'mexc_close');
                        if (mirrorClosed && isTursoConfigured()) {
                          const dataPersistence = getDataPersistence();
                          const positionForClose = {
                            id: mirrorClosed.id,
                            symbol: mirrorClosed.symbol.replace('_USDT', 'USDT'),
                            direction: mirrorClosed.direction,
                            timeframe: '5m' as const,
                            marketType: 'futures' as const,
                            entryPrice: mirrorClosed.entryPrice,
                            entryTime: mirrorClosed.entryTime,
                            exitPrice: mirrorClosed.exitPrice,
                            exitTime: mirrorClosed.exitTime,
                            exitReason: mirrorClosed.exitReason,
                            marginUsed: mirrorClosed.marginUsed,
                            notionalSize: mirrorClosed.notionalSize,
                            leverage: mirrorClosed.leverage,
                            realizedPnL: mirrorClosed.realizedPnl,
                            realizedPnLPercent: mirrorClosed.realizedPnlPct,
                            trailActivated: mirrorClosed.trailActivated,
                            highestPnlPercent: mirrorClosed.highestPnlPct,
                            // Required fields for PaperPosition (not used for Turso logging)
                            takeProfitPrice: mirrorClosed.takeProfitPrice,
                            stopLossPrice: mirrorClosed.stopLossPrice,
                            currentPrice: mirrorClosed.exitPrice,
                            unrealizedPnL: 0,
                            unrealizedPnLPercent: 0,
                          };
                          dataPersistence.logTradeClose('mexc-mirror', positionForClose as any, 'live-mirror');
                          console.log(`[MIRROR] Synced with MEXC close: ${futuresSymbol} | Mirror PnL: $${mirrorClosed.realizedPnl.toFixed(2)} vs MEXC: $${lastClose.profit.toFixed(2)}`);
                        }
                      }
                    }
                  } catch (historyErr) {
                    console.error(`[MEXC-SYNC] Failed to fetch order history for ${futuresSymbol}:`, (historyErr as Error).message);
                  }

                  logBotDecision(order.bot, order.symbol, 'position_closed', `MEXC position no longer open (had SL: ${hadSL}, TP: ${hadTP})`);
                  console.log(`[MEXC-SYNC] ${order.symbol} position closed on MEXC — marking queue order as closed`);

                  // Clean up orphaned plan orders (SL/TP) for this symbol
                  try {
                    await client.cancelAllPlanOrders(futuresSymbol);
                    console.log(`[MEXC-SYNC] Cleaned up plan orders for ${futuresSymbol}`);
                  } catch (e) {
                    console.error(`[MEXC-SYNC] Failed to cancel plan orders for ${futuresSymbol}:`, (e as Error).message);
                  }
                }
              }

              // Detect trailing-manager positions closed externally (SL fired on MEXC, manual close)
              if (trailingManager.getTrackedPositions().length > 0) {
                const closedByExchange = trailingManager.detectExternalCloses(openSymbols);
                for (const sym of closedByExchange) {
                  logBotDecision('trail-mgr', sym, 'external_close', 'MEXC position gone — SL fired or manually closed');
                  if (isTursoConfigured()) {
                    deleteTrailingPosition(sym).catch(e =>
                      console.error(`[TRAIL-MGR] Turso delete failed for ${sym}:`, e)
                    );
                  }
                }
              }

              // Broadcast updated position count and P&L
              let totalUnrealized = 0;
              for (const p of (posResult.data || [])) {
                try {
                  const ticker = await client.getTickerPrice(p.symbol);
                  if (ticker.success && ticker.price) {
                    const side = p.positionType === 1 ? 1 : -1;
                    totalUnrealized += (ticker.price - p.holdAvgPrice) * p.holdVol * side;
                  }
                } catch { /* skip */ }
              }

              broadcast('mexc_positions_update', {
                count: (posResult.data || []).length,
                unrealizedPnl: totalUnrealized,
              });
            }
          }
        } catch (err) {
          // Don't crash the loop on MEXC API errors
          console.error('[MEXC-SYNC] Error polling positions:', (err as Error).message);
        }
      }

      broadcastState(); // Update clients with new prices
    }, 10000);
  } catch (error) {
    console.error('Failed to start screener:', error);
    process.exit(1);
  }
}

main();
