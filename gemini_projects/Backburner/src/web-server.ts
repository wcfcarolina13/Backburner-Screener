#!/usr/bin/env node

import express from 'express';
import { BackburnerScreener } from './screener.js';
import { PaperTradingEngine } from './paper-trading.js';
import { TrailingStopEngine } from './paper-trading-trailing.js';
import { ConfluenceBot } from './confluence-bot.js';
import { TripleLightBot } from './triple-light-bot.js';
import { BTCExtremeBot } from './btc-extreme-bot.js';
import { BTCTrendBot } from './btc-trend-bot.js';
import { TrendOverrideBot } from './trend-override-bot.js';
import { TrendFlipBot } from './trend-flip-bot.js';
import { createBtcBiasBots, type BiasLevel } from './btc-bias-bot.js';
import { createMexcSimulationBots } from './mexc-trailing-simulation.js';
import { NotificationManager } from './notifications.js';
import { FocusModeManager, getFocusModeManager } from './focus-mode.js';
import { BackburnerDetector } from './backburner-detector.js';
import { GoldenPocketBot } from './golden-pocket-bot.js';
import { getKlines, getFuturesKlines, spotSymbolToFutures, getCurrentPrice, getPrice } from './mexc-api.js';
import { getCurrentRSI, calculateRSI, calculateSMA, detectDivergence } from './indicators.js';
import { DEFAULT_CONFIG } from './config.js';
import { getDataPersistence } from './data-persistence.js';
import type { BackburnerSetup, Timeframe } from './types.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Store connected SSE clients
const clients: Set<express.Response> = new Set();

// Bot visibility state (which bots are shown in UI)
const botVisibility: Record<string, boolean> = {
  fixedTP: true,
  trailing1pct: true,
  trailing10pct10x: true,
  trailing10pct20x: true,
  trendOverride: true,
  trendFlip: true,
  trailWide: true,      // 20% trigger, 10% L1 lock
  confluence: true,     // Multi-TF confluence (5m + 15m/1h)
  tripleLight: true,    // Asset-level 3-green-light bot
  btcExtreme: true,
  btcTrend: true,
  // BTC Bias bots (8 variants)
  bias100x20trail: true,
  bias100x50trail: true,
  bias10x20trail: true,
  bias10x50trail: true,
  bias100x20hard: true,
  bias100x50hard: true,
  bias10x20hard: true,
  bias10x50hard: true,
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
};

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
const fixedTPBot = new PaperTradingEngine({
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  takeProfitPercent: 20,  // 20% TP or RSI played_out, whichever first
  stopLossPercent: 20,
  maxOpenPositions: 10,
}, 'fixed');

// Bot 2: Trailing stop strategy (1% position, 10x leverage)
const trailing1pctBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 1,
  leverage: 10,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,     // Level 1 = breakeven
  maxOpenPositions: 10,
}, '1pct');

// Bot 3: Trailing stop strategy (10% position, 10x leverage) - AGGRESSIVE
const trailing10pct10xBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 10,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,     // Level 1 = breakeven
  maxOpenPositions: 100,  // No practical limit - uses 10% of available balance
}, '10pct10x');

// Bot 4: Trailing stop strategy (10% position, 20x leverage) - VERY AGGRESSIVE
const trailing10pct20xBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,     // Level 1 = breakeven
  maxOpenPositions: 100,  // No practical limit - uses 10% of available balance
}, '10pct20x');

// Bot 5: Wide trailing (20% trigger, 10% L1 lock)
// Hypothesis: Later trail trigger + non-zero L1 lock = fewer premature exits
const trailWideBot = new TrailingStopEngine({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage (same as 10pct20x for comparison)
  initialStopLossPercent: 20,
  trailTriggerPercent: 20,  // Don't start trailing until 20% ROI
  trailStepPercent: 10,
  level1LockPercent: 10,    // Level 1 locks at 10% ROI instead of breakeven
  maxOpenPositions: 100,
}, 'wide');

// Bot 6: Multi-Timeframe Confluence (5m + 15m/1h required)
// Only opens when same asset triggers on multiple timeframes within 5 minutes
// Does NOT close on played_out - only exits via trailing stop
const confluenceBot = new ConfluenceBot({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,     // Breakeven at L1
  maxOpenPositions: 100,
  requiredTimeframe: '5m',
  confirmingTimeframes: ['15m', '1h'],
  confluenceWindowMs: 5 * 60 * 1000,  // 5 minutes
}, 'confluence');

// Bot 7: Triple Light (Asset-Level Signal Aggregation)
// Tracks 5m, 15m, 1h signals per asset. Only enters when ALL 3 show green light.
// ONE position per asset (not per timeframe). Exits when all signals expire.
const tripleLightBot = new TripleLightBot({
  initialBalance: 2000,
  positionSizePercent: 10,  // 10% of account per trade
  leverage: 20,             // 20x leverage
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,     // Breakeven at L1
  maxOpenPositions: 100,
  trackedTimeframes: ['5m', '15m', '1h'],
  minLightsToEnter: 3,      // Only enter on strong signals (all 3 green)
}, 'triple');

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
const trendOverrideBot = new TrendOverrideBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
}, 'override');

// Bot 11: Trend Flip - same as override but flips on profitable close
const trendFlipBot = new TrendFlipBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
  flipOnProfit: true,
  flipStopLossPercent: 20,  // Same stop for flipped positions
}, 'flip');

// Bots 12-19: BTC Bias Bots (8 variants)
// Only trade BTC based on macro bias, hold through neutral, require stronger bias after stop-out
const btcBiasBots = createBtcBiasBots(2000);

// Bots 20-25: MEXC Trailing Stop Simulation Bots (6 variants)
// Simulates MEXC's continuous trailing stop behavior for comparison with our discrete levels
const mexcSimBots = createMexcSimulationBots(2000);

// Bots 26-29: Golden Pocket Bots (Fibonacci hype strategy)
// Targets coins with sudden volatility spikes, enters on 0.618-0.65 retracement
// Multiple variants with different leverage and position sizing

// GP Bot 1: Conservative (5% pos, 10x leverage)
const gpConservativeBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  maxOpenPositions: 10,
}, 'gp-conservative');

// GP Bot 2: Standard (10% pos, 10x leverage)
const gpStandardBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 10,
  maxOpenPositions: 10,
}, 'gp-standard');

// GP Bot 3: Aggressive (10% pos, 20x leverage)
const gpAggressiveBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  maxOpenPositions: 10,
}, 'gp-aggressive');

// GP Bot 4: YOLO (20% pos, 20x leverage)
const gpYoloBot = new GoldenPocketBot({
  initialBalance: 2000,
  positionSizePercent: 20,
  leverage: 20,
  maxOpenPositions: 5,
}, 'gp-yolo');

// Collect all GP bots for easy iteration
const goldenPocketBots = new Map([
  ['gp-conservative', gpConservativeBot],
  ['gp-standard', gpStandardBot],
  ['gp-aggressive', gpAggressiveBot],
  ['gp-yolo', gpYoloBot],
]);

const notifier = new NotificationManager({
  enabled: true,
  sound: true,
  soundName: 'Glass',
  onlyTriggered: true,
});

// Focus Mode - for manual trade copying with notifications
const focusMode = getFocusModeManager();

// State
let currentStatus = 'Starting...';
let scanProgress = { completed: 0, total: 0, phase: '' };
let currentBtcBias: 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short' = 'neutral';

// SSE broadcast helper
function broadcast(event: string, data: any) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
}

// Event handlers
async function handleNewSetup(setup: BackburnerSetup) {
  // Try to open positions on all trailing bots
  const fixedPosition = fixedTPBot.openPosition(setup);
  const trail1pctPosition = trailing1pctBot.openPosition(setup);
  const trail10pct10xPosition = trailing10pct10xBot.openPosition(setup);
  const trail10pct20xPosition = trailing10pct20xBot.openPosition(setup);
  const trailWidePosition = trailWideBot.openPosition(setup);
  const confluencePosition = confluenceBot.openPosition(setup);
  const tripleLightPosition = tripleLightBot.handleNewSetup(setup);

  // Get active timeframes for this symbol to check for confluence
  const allSetups = screener.getAllSetups();
  const symbolSetups = allSetups.filter(s =>
    s.symbol === setup.symbol &&
    s.marketType === setup.marketType &&
    s.direction === setup.direction &&
    s.state !== 'played_out'
  );
  const activeTimeframes = symbolSetups.map(s => s.timeframe);

  // Try trend override/flip bots (only for single-timeframe setups conflicting with BTC trend)
  const currentPrice = await getCurrentPrice(setup.symbol);
  if (currentPrice) {
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
  if (tripleLightPosition) {
    broadcast('position_opened', { bot: 'tripleLight', position: tripleLightPosition });
  }

  // Try MEXC simulation bots
  for (const [botId, bot] of mexcSimBots) {
    const position = bot.openPosition(setup);
    if (position) {
      broadcast('position_opened', { bot: botId, position });
    }
  }

  // Try all Golden Pocket bots (only process setups that have fibLevels from the GP detector)
  const isGPSetup = 'fibLevels' in setup && 'tp1Price' in setup && 'stopPrice' in setup;
  if (isGPSetup && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    console.log(`[GP-BOT] GP setup received: ${setup.symbol} ${setup.direction} ${setup.state} - attempting trades`);
  }
  for (const [botId, bot] of goldenPocketBots) {
    const position = bot.openPosition(setup);
    if (position) {
      console.log(`[GP-BOT:${botId}] OPENED: ${position.symbol} ${position.direction}`);
      broadcast('position_opened', { bot: botId, position });
    }
  }

  // Focus Mode: Track positions from target bot (Trail Standard by default)
  if (focusMode.isEnabled()) {
    const targetBotId = focusMode.getConfig().targetBot;
    let targetPosition = null;
    if (targetBotId === 'trailing10pct10x' && trail10pct10xPosition) {
      targetPosition = trail10pct10xPosition;
    } else if (targetBotId === 'trailing10pct20x' && trail10pct20xPosition) {
      targetPosition = trail10pct20xPosition;
    } else if (targetBotId === 'trailWide' && trailWidePosition) {
      targetPosition = trailWidePosition;
    } else if (targetBotId === 'trailing1pct' && trail1pctPosition) {
      targetPosition = trail1pctPosition;
    }

    if (targetPosition) {
      await focusMode.onPositionOpened(targetPosition, setup);
    }
  }

  // Send notification (works for both regular and GP setups)
  await notifier.notifyNewSetup(setup);

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
  // First try to update existing positions
  let fixedPosition = fixedTPBot.updatePosition(setup);
  let trail1pctPosition = trailing1pctBot.updatePosition(setup);
  let trail10pct10xPosition = trailing10pct10xBot.updatePosition(setup);
  let trail10pct20xPosition = trailing10pct20xBot.updatePosition(setup);
  let trailWidePosition = trailWideBot.updatePosition(setup);
  let confluencePosition = confluenceBot.updatePosition(setup);
  let tripleLightPosition = tripleLightBot.handleSetupUpdated(setup);

  // If no position exists and setup just became triggered/deep_extreme, try to open
  // This handles the watching -> triggered state transition
  let newlyOpened = false;
  if (!fixedPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    fixedPosition = fixedTPBot.openPosition(setup);
    if (fixedPosition) {
      broadcast('position_opened', { bot: 'fixedTP', position: fixedPosition });
      newlyOpened = true;
    }
  }
  if (!trail1pctPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail1pctPosition = trailing1pctBot.openPosition(setup);
    if (trail1pctPosition) {
      broadcast('position_opened', { bot: 'trailing1pct', position: trail1pctPosition });
      newlyOpened = true;
    }
  }
  if (!trail10pct10xPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail10pct10xPosition = trailing10pct10xBot.openPosition(setup);
    if (trail10pct10xPosition) {
      broadcast('position_opened', { bot: 'trailing10pct10x', position: trail10pct10xPosition });
      newlyOpened = true;
    }
  }
  if (!trail10pct20xPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trail10pct20xPosition = trailing10pct20xBot.openPosition(setup);
    if (trail10pct20xPosition) {
      broadcast('position_opened', { bot: 'trailing10pct20x', position: trail10pct20xPosition });
      newlyOpened = true;
    }
  }
  if (!trailWidePosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    trailWidePosition = trailWideBot.openPosition(setup);
    if (trailWidePosition) {
      broadcast('position_opened', { bot: 'trailWide', position: trailWidePosition });
      newlyOpened = true;
    }
  }
  if (!confluencePosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    confluencePosition = confluenceBot.openPosition(setup);
    if (confluencePosition) {
      broadcast('position_opened', { bot: 'confluence', position: confluencePosition });
      newlyOpened = true;
    }
  }
  if (!tripleLightPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
    tripleLightPosition = tripleLightBot.handleNewSetup(setup);
    if (tripleLightPosition) {
      broadcast('position_opened', { bot: 'tripleLight', position: tripleLightPosition });
      newlyOpened = true;
    }
  }

  // Try MEXC simulation bots too (they also only open on triggered/deep_extreme)
  if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
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

  // Update all Golden Pocket positions and try to open new ones
  for (const [botId, bot] of goldenPocketBots) {
    let gpPosition = bot.updatePosition(setup);
    if (!gpPosition && (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
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
  if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
    await notifier.notifyNewSetup(setup);
  }

  // Send notification when setup plays out (distinct "done" sound)
  if (setup.state === 'played_out') {
    await notifier.notifyPlayedOut(setup);
  }

  // Focus Mode: If a position was just opened in the target bot, track it
  if (newlyOpened && focusMode.isEnabled()) {
    const targetBotId = focusMode.getConfig().targetBot;
    let targetPosition = null;
    if (targetBotId === 'trailing10pct10x' && trail10pct10xPosition && trail10pct10xPosition.status === 'open') {
      targetPosition = trail10pct10xPosition;
    } else if (targetBotId === 'trailing10pct20x' && trail10pct20xPosition && trail10pct20xPosition.status === 'open') {
      targetPosition = trail10pct20xPosition;
    } else if (targetBotId === 'trailWide' && trailWidePosition && trailWidePosition.status === 'open') {
      targetPosition = trailWidePosition;
    } else if (targetBotId === 'trailing1pct' && trail1pctPosition && trail1pctPosition.status === 'open') {
      targetPosition = trail1pctPosition;
    }
    if (targetPosition) {
      // Check if Focus Mode is already tracking this position
      const focusPositions = focusMode.getActivePositions();
      const alreadyTracking = focusPositions.some(
        p => p.symbol === setup.symbol && p.direction === setup.direction &&
             p.timeframe === setup.timeframe && p.marketType === setup.marketType
      );
      if (!alreadyTracking) {
        await focusMode.onPositionOpened(targetPosition, setup);
      }
    }
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

  if (tripleLightPosition) {
    if (tripleLightPosition.status !== 'open') {
      broadcast('position_closed', { bot: 'tripleLight', position: tripleLightPosition });
    } else {
      broadcast('position_updated', { bot: 'tripleLight', position: tripleLightPosition });
    }
  }

  // Update MEXC simulation bots
  for (const [botId, bot] of mexcSimBots) {
    bot.updatePosition(setup, setup.currentPrice);
  }

  // Focus Mode: Track trailing stop updates
  if (focusMode.isEnabled()) {
    const targetBotId = focusMode.getConfig().targetBot;
    let targetPosition = null;
    let positionClosed = false;

    if (targetBotId === 'trailing10pct10x' && trail10pct10xPosition) {
      targetPosition = trail10pct10xPosition;
      positionClosed = trail10pct10xPosition.status !== 'open';
    } else if (targetBotId === 'trailing10pct20x' && trail10pct20xPosition) {
      targetPosition = trail10pct20xPosition;
      positionClosed = trail10pct20xPosition.status !== 'open';
    } else if (targetBotId === 'trailWide' && trailWidePosition) {
      targetPosition = trailWidePosition;
      positionClosed = trailWidePosition.status !== 'open';
    } else if (targetBotId === 'trailing1pct' && trail1pctPosition) {
      targetPosition = trail1pctPosition;
      positionClosed = trail1pctPosition.status !== 'open';
    }

    if (targetPosition) {
      if (positionClosed) {
        await focusMode.onPositionClosed(targetPosition, targetPosition.exitReason || 'Unknown');
      } else {
        await focusMode.onPositionUpdated(targetPosition);
      }
    }
  }

  broadcast('setup_updated', setup);
  broadcastState();
}

function handleSetupRemoved(setup: BackburnerSetup) {
  // Handle all trailing bots
  fixedTPBot.handleSetupRemoved(setup);
  trailing1pctBot.handleSetupRemoved(setup);
  trailing10pct10xBot.handleSetupRemoved(setup);
  trailing10pct20xBot.handleSetupRemoved(setup);
  trailWideBot.handleSetupRemoved(setup);
  confluenceBot.handleSetupRemoved(setup);
  tripleLightBot.handleSetupRemoved(setup);

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
      goldenPocket: goldenPocketSetups,
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
    // Bot 7: Triple Light (Asset-level 3-green-light system)
    tripleLightBot: {
      name: 'Triple Light',
      description: '5m+15m+1h all green, 10% pos, 20x',
      config: tripleLightBot.getConfig(),
      balance: tripleLightBot.getBalance(),
      unrealizedPnL: tripleLightBot.getUnrealizedPnL(),
      openPositions: tripleLightBot.getOpenPositions(),
      closedPositions: tripleLightBot.getClosedPositions(20),
      stats: tripleLightBot.getStats(),
      assetSignals: tripleLightBot.getAssetSignals(),
      visible: botVisibility.tripleLight,
    },
    // Bot 8: BTC Contrarian (50x leverage, extreme RSI)
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
    // Bots 12-19: BTC Bias Bots
    btcBiasBots: Object.fromEntries(
      Array.from(btcBiasBots.entries()).map(([key, bot]) => [
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
    botVisibility,
    // Focus Mode state - sync with target bot positions first
    focusMode: (() => {
      // Sync Focus Mode with current positions from target bot
      const targetBotId = focusMode.getConfig().targetBot;
      let targetBotPositions: any[] = [];
      if (targetBotId === 'trailing10pct10x') {
        targetBotPositions = trailing10pct10xBot.getOpenPositions();
      } else if (targetBotId === 'trailing10pct20x') {
        targetBotPositions = trailing10pct20xBot.getOpenPositions();
      } else if (targetBotId === 'trailWide') {
        targetBotPositions = trailWideBot.getOpenPositions();
      } else if (targetBotId === 'trailing1pct') {
        targetBotPositions = trailing1pctBot.getOpenPositions();
      }
      focusMode.syncWithBotPositions(targetBotPositions);
      return focusMode.getState();
    })(),
    meta: {
      eligibleSymbols: screener.getEligibleSymbolCount(),
      isRunning: screener.isActive(),
      status: currentStatus,
      scanProgress,
      timestamp: Date.now(),
    },
  };
}

// Serve static HTML
app.get('/', (req, res) => {
  res.send(getHtmlPage());
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
  } else if (bot === 'tripleLight') {
    tripleLightBot.reset();
    res.json({ success: true, bot: 'tripleLight', balance: tripleLightBot.getBalance() });
  } else if (mexcSimBots.has(bot)) {
    const mexcBot = mexcSimBots.get(bot)!;
    mexcBot.reset();
    res.json({ success: true, bot, balance: mexcBot.getBalance() });
  } else {
    // Reset all bots
    fixedTPBot.reset();
    trailing1pctBot.reset();
    trailing10pct10xBot.reset();
    trailing10pct20xBot.reset();
    trailWideBot.reset();
    confluenceBot.reset();
    tripleLightBot.reset();
    btcExtremeBot.reset();
    btcTrendBot.reset();
    // Reset MEXC simulation bots
    for (const [, mexcBot] of mexcSimBots) {
      mexcBot.reset();
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
        tripleLight: tripleLightBot.getBalance(),
        btcExtreme: btcExtremeBot.getBalance(),
        btcTrend: btcTrendBot.getBalance(),
        ...Object.fromEntries(Array.from(mexcSimBots.entries()).map(([k, b]) => [k, b.getBalance()])),
      },
    });
  }
  broadcastState();
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
  } else if (bot === 'tripleLight') {
    botVisibility.tripleLight = visible !== false;
    res.json({ success: true, bot: 'tripleLight', visible: botVisibility.tripleLight });
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
  } else if (bot.startsWith('bias')) {
    // Handle BTC Bias bots dynamically
    if (btcBiasBots.has(bot)) {
      botVisibility[bot] = visible !== false;
      res.json({ success: true, bot, visible: botVisibility[bot] });
    } else {
      res.status(400).json({ error: 'Invalid bot name' });
      return;
    }
  } else {
    res.status(400).json({ error: 'Invalid bot name' });
    return;
  }
  broadcastState();
});

// Focus Mode API endpoints
app.get('/api/focus', (req, res) => {
  res.json(focusMode.getState());
});

app.post('/api/focus/enable', express.json(), (req, res) => {
  focusMode.setEnabled(true);
  broadcastState();
  res.json({ success: true, enabled: true });
});

app.post('/api/focus/disable', express.json(), (req, res) => {
  focusMode.setEnabled(false);
  broadcastState();
  res.json({ success: true, enabled: false });
});

app.post('/api/focus/config', express.json(), (req, res) => {
  const { accountBalance, maxPositionSizePercent, leverage, targetBot, maxOpenPositions } = req.body;
  const config: any = {};
  if (accountBalance !== undefined) config.accountBalance = accountBalance;
  if (maxPositionSizePercent !== undefined) config.maxPositionSizePercent = maxPositionSizePercent;
  if (leverage !== undefined) config.leverage = leverage;
  if (maxOpenPositions !== undefined) config.maxOpenPositions = maxOpenPositions;

  // If target bot changed, clear all tracked positions and re-sync
  const currentConfig = focusMode.getConfig();
  if (targetBot !== undefined && targetBot !== currentConfig.targetBot) {
    config.targetBot = targetBot;
    focusMode.updateConfig(config);
    // Clear all positions and let sync re-import from new bot
    focusMode.clearAllPositions();
  } else {
    focusMode.updateConfig(config);
  }

  broadcastState();
  res.json({ success: true, config: focusMode.getConfig() });
});

app.post('/api/focus/test-notification', async (req, res) => {
  await focusMode.testNotification();
  res.json({ success: true });
});

app.post('/api/focus/clear-closed', (req, res) => {
  focusMode.clearClosedPositions();
  broadcastState();
  res.json({ success: true });
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

          const currentRSI = getCurrentRSI(candles, DEFAULT_CONFIG.rsiPeriod);
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

// BTC RSI multi-timeframe endpoint for chart
app.get('/api/btc-rsi', async (req, res) => {
  try {
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

        const rsiValues = calculateRSI(candles, rsiPeriod);
        const rsiNumbers = rsiValues.map(r => r.value);
        const smaValues = calculateSMA(rsiNumbers, smaPeriod);

        // Detect divergence
        const divergence = detectDivergence(candles, rsiValues, 50, 5);

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

      // Update BTC Bias bots (all 8 variants)
      for (const [botKey, bot] of btcBiasBots) {
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

    res.json({
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
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
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
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    header {
      background: linear-gradient(135deg, #1a1f2e 0%, #0d1117 100%);
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #8b949e; font-size: 14px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 16px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #30363d;
    }
    .card-title { font-size: 16px; font-weight: 600; color: #f0f6fc; }

    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .stat-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .stat-value { font-size: 24px; font-weight: bold; color: #f0f6fc; }
    .stat-value.positive { color: #3fb950; }
    .stat-value.negative { color: #f85149; }
    .stat-label { font-size: 11px; color: #8b949e; text-transform: uppercase; margin-top: 4px; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 8px; color: #8b949e; font-weight: 500; border-bottom: 1px solid #30363d; }
    td { padding: 10px 8px; border-bottom: 1px solid #21262d; }
    tr:hover { background: #1c2128; }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-long { background: #238636; color: #fff; }
    .badge-short { background: #da3633; color: #fff; }
    .badge-spot { background: #1f6feb; color: #fff; }
    .badge-futures { background: #8957e5; color: #fff; }
    .badge-triggered { background: #238636; color: #fff; }
    .badge-deep { background: #da3633; color: #fff; }
    .badge-reversing { background: #9e6a03; color: #fff; }
    .badge-watching { background: #30363d; color: #8b949e; }
    .badge-played_out { background: #21262d; color: #6e7681; text-decoration: line-through; }

    .pnl { font-weight: 600; }
    .pnl.positive { color: #3fb950; }
    .pnl.negative { color: #f85149; }

    .progress-bar {
      background: #30363d;
      border-radius: 4px;
      height: 6px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill {
      background: #238636;
      height: 100%;
      transition: width 0.3s ease;
    }

    .status-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .status-dot.active { background: #3fb950; }
    .status-dot.inactive { background: #f85149; }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #8b949e;
    }

    .liq-safe { color: #3fb950; }
    .liq-med { color: #d29922; }
    .liq-high { color: #f85149; font-weight: bold; }

    .bot-card { transition: opacity 0.3s ease; }
    .bot-toggle { transition: opacity 0.3s ease, border-color 0.3s ease; }
    .bot-toggle:hover { border-color: #58a6ff !important; }

    /* Collapsible sections */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 16px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      margin-bottom: 12px;
      cursor: pointer;
      user-select: none;
    }
    .section-header:hover { border-color: #58a6ff; }
    .section-title { font-weight: 600; font-size: 14px; color: #f0f6fc; }
    .section-toggle { color: #8b949e; font-size: 16px; transition: transform 0.2s ease; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
    .section-toggle:hover { background: rgba(88, 166, 255, 0.2); }
    .section-toggle.collapsed { transform: rotate(-90deg); }
    .section-content { overflow: hidden; transition: all 0.3s ease; }
    .section-content.collapsed { display: none !important; }
    .bot-toggles-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
    .bot-toggle-mini { flex: 0 0 auto; min-width: 80px; padding: 4px 8px; background: #161b22; border: 2px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 10px; }
    .bot-toggle-mini:hover { border-color: #58a6ff !important; }

    @media (max-width: 1200px) {
      .stats-grid { grid-template-columns: repeat(4, 1fr) !important; }
    }
    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
    }
  </style>
</head>
<body>
  <div class="container">
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
            <li><strong style="color: #f85149;">Stop Loss</strong>: Initial -20% SL hit before trailing activates</li>
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
              <p style="color: #8b949e; margin: 4px 0 0 0;">1% position, 10x leverage, 20% TP/20% SL. Conservative with fixed exits. Exits on RSI played_out or setup removal.</p>
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

    <!-- Focus Mode Panel -->
    <div id="focusModePanel" class="card" style="margin-bottom: 16px; border-left: 3px solid #f0883e; display: none;">
      <div class="card-header" style="background: linear-gradient(135deg, #21262d 0%, #161b22 100%); cursor: pointer;" onclick="toggleSection('focusMode')">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="section-toggle" id="focusModeToggle">▼</span>
          <span class="card-title">🎯 Focus Mode - Trade Copying</span>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span id="focusPositionCount" style="font-size: 12px; color: #8b949e;">0/5 positions</span>
          <button id="focusToggleBtn" onclick="event.stopPropagation(); toggleFocusMode()" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #f0883e; background: #21262d; color: #f0883e; font-size: 11px; font-weight: 600; cursor: pointer;">
            Enable
          </button>
          <button onclick="event.stopPropagation(); testFocusNotification()" style="padding: 4px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 11px; cursor: pointer;" title="Test notification">
            🔔
          </button>
        </div>
      </div>
      <div id="focusModeContent" style="padding: 12px;">
        <!-- Config row -->
        <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #21262d;">
          <div style="font-size: 11px; color: #8b949e;">
            Mirror: <select id="focusTargetBot" onchange="updateFocusConfig()" style="background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 2px 8px; font-size: 11px;">
              <option value="trailing10pct10x">Trail Standard (Best)</option>
              <option value="trailWide">Trail Wide</option>
              <option value="trailing10pct20x">Trail Aggressive</option>
              <option value="trailing1pct">Trail Light</option>
            </select>
          </div>
          <div style="font-size: 11px; color: #8b949e;">
            Balance: $<input type="number" id="focusBalance" value="1000" onchange="updateFocusConfig()" style="width: 60px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 2px 4px; font-size: 11px;">
          </div>
          <div style="font-size: 11px; color: #8b949e;">
            Max %: <input type="number" id="focusMaxPercent" value="5" min="1" max="100" onchange="updateFocusConfig()" style="width: 40px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 2px 4px; font-size: 11px;">
          </div>
          <div style="font-size: 11px; color: #8b949e;">
            Leverage: <input type="number" id="focusLeverage" value="10" min="1" max="100" onchange="updateFocusConfig()" style="width: 40px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 2px 4px; font-size: 11px;">x
          </div>
        </div>
        <!-- Active positions -->
        <div id="focusPositions" style="font-size: 12px;">
          <div style="color: #6e7681; text-align: center; padding: 16px;">
            Enable Focus Mode to receive trade copy notifications
          </div>
        </div>
        <!-- Recent actions -->
        <div id="focusActions" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #21262d; display: none;">
          <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px;">Recent Actions:</div>
          <div id="focusActionsList" style="font-size: 11px; max-height: 100px; overflow-y: auto;"></div>
        </div>
      </div>
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
      <span class="section-title">📊 Altcoin Backburner Bots (11)</span>
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
        <div class="bot-toggle" id="toggleTripleLight" onclick="event.stopPropagation(); toggleBot('tripleLight')" style="flex: 1; min-width: 85px; padding: 6px 10px; background: #161b22; border: 2px solid #f0e68c; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #f0e68c; font-size: 11px;">🚦 Triple</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #f0e68c;"></span>
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
      </div>
    </div>

    <!-- 11-Bot Stats Comparison -->
    <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
      <div class="stat-box" style="border-left: 3px solid #238636;">
        <div class="stat-value" id="fixedBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">Fix20 | P&L: <span id="fixedPnL" class="positive">$0</span> | Unreal: <span id="fixedUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="fixedWinRate">0%</span> win (<span id="fixedTrades">0</span> trades) | Costs: <span id="fixedCosts" style="color: #f85149;">$0</span></div>
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
      <div class="stat-box" style="border-left: 3px solid #f0e68c;">
        <div class="stat-value" id="tripleLightBalance" style="font-size: 18px;">$2,000</div>
        <div class="stat-label">3x | P&L: <span id="tripleLightPnL" class="positive">$0</span> | Unreal: <span id="tripleLightUnrealPnL" class="positive">$0</span></div>
        <div class="stat-label" style="margin-top: 2px;"><span id="tripleLightWinRate">0%</span> win (<span id="tripleLightTrades">0</span> trades) | Costs: <span id="tripleLightCosts" style="color: #f85149;">$0</span></div>
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

    <!-- Section: BTC Bias Bots -->
    <div class="section-header" onclick="toggleSection('btcBiasBots')" style="margin-top: 12px;">
      <span class="section-title">₿ BTC Bias Bots (8)</span>
      <span class="section-toggle" id="btcBiasBotsToggle">▼</span>
    </div>
    <div class="section-content" id="btcBiasBotsContent">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        BTC-only bots that trade based on macro bias. Hold through neutral, exit on opposite bias or stop. Require bias to cycle/strengthen after stop-out for re-entry.
      </div>
      <div class="bot-toggles-row">
        <div class="bot-toggle" id="toggleBias100x20trail" onclick="event.stopPropagation(); toggleBot('bias100x20trail')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #ffd700; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ffd700; font-size: 11px;">100% 20x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ffd700;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias100x50trail" onclick="event.stopPropagation(); toggleBot('bias100x50trail')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #ff8c00; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff8c00; font-size: 11px;">100% 50x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff8c00;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias10x20trail" onclick="event.stopPropagation(); toggleBot('bias10x20trail')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #98fb98; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #98fb98; font-size: 11px;">10% 20x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #98fb98;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias10x50trail" onclick="event.stopPropagation(); toggleBot('bias10x50trail')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #00ced1; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00ced1; font-size: 11px;">10% 50x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00ced1;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias100x20hard" onclick="event.stopPropagation(); toggleBot('bias100x20hard')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #dc143c; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #dc143c; font-size: 11px;">100% 20x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #dc143c;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias100x50hard" onclick="event.stopPropagation(); toggleBot('bias100x50hard')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #8b0000; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff6666; font-size: 11px;">100% 50x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff6666;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias10x20hard" onclick="event.stopPropagation(); toggleBot('bias10x20hard')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #9370db; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #9370db; font-size: 11px;">10% 20x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #9370db;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBias10x50hard" onclick="event.stopPropagation(); toggleBot('bias10x50hard')" style="flex: 1; min-width: 110px; padding: 6px 10px; background: #161b22; border: 2px solid #4169e1; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #4169e1; font-size: 11px;">10% 50x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #4169e1;"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- BTC Bias Bots Stats (collapsible) -->
    <div class="section-header" onclick="toggleSection('btcBiasStats')" style="margin-top: 12px;">
      <span class="section-title">₿ BTC Bias Bot Stats</span>
      <span class="section-toggle" id="btcBiasStatsToggle">▼</span>
    </div>
    <div class="section-content" id="btcBiasStatsContent">
      <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 12px;">
        <div class="stat-box" style="border-left: 3px solid #ffd700;">
          <div class="stat-value" id="bias100x20trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">100% 20x Trail | <span id="bias100x20trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias100x20trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #ff8c00;">
          <div class="stat-value" id="bias100x50trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">100% 50x Trail | <span id="bias100x50trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias100x50trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #98fb98;">
          <div class="stat-value" id="bias10x20trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 20x Trail | <span id="bias10x20trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias10x20trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #00ced1;">
          <div class="stat-value" id="bias10x50trailBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 50x Trail | <span id="bias10x50trailPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias10x50trailStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #dc143c;">
          <div class="stat-value" id="bias100x20hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">100% 20x Hard | <span id="bias100x20hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias100x20hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #8b0000;">
          <div class="stat-value" id="bias100x50hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">100% 50x Hard | <span id="bias100x50hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias100x50hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #9370db;">
          <div class="stat-value" id="bias10x20hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 20x Hard | <span id="bias10x20hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias10x20hardStatus">-</span></div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #4169e1;">
          <div class="stat-value" id="bias10x50hardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">10% 50x Hard | <span id="bias10x50hardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="bias10x50hardStatus">-</span></div>
        </div>
      </div>
    </div>

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
          <div class="stat-label">Conservative 5% 10x | <span id="gpConservativePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpConservativeUnrealPnL" class="positive">$0</span> | Real: <span id="gpConservativePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpConservativeWinRate">0%</span> win | <span id="gpConservativeTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #8bc34a;">
          <div class="stat-value" id="gpStandardBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Standard 10% 10x | <span id="gpStandardPositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpStandardUnrealPnL" class="positive">$0</span> | Real: <span id="gpStandardPnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpStandardWinRate">0%</span> win | <span id="gpStandardTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #ff9800;">
          <div class="stat-value" id="gpAggressiveBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">Aggressive 10% 20x | <span id="gpAggressivePositionCount">0</span> pos</div>
          <div class="stat-label" style="margin-top: 2px;">Unreal: <span id="gpAggressiveUnrealPnL" class="positive">$0</span> | Real: <span id="gpAggressivePnL" class="positive">$0</span></div>
          <div class="stat-label" style="margin-top: 2px;"><span id="gpAggressiveWinRate">0%</span> win | <span id="gpAggressiveTP1Rate">0%</span> TP1</div>
        </div>
        <div class="stat-box" style="border-left: 3px solid #f44336;">
          <div class="stat-value" id="gpYoloBalance" style="font-size: 16px;">$2,000</div>
          <div class="stat-label">YOLO 20% 20x | <span id="gpYoloPositionCount">0</span> pos</div>
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
      </div>
      <div id="setupsTable">
        <div class="empty-state">Scanning for setups...</div>
      </div>
    </div>

    <!-- Bot Cards - 8 bots in grid -->
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
      <div class="card bot-card" id="tripleLightCard" style="border-left: 3px solid #f0e68c;">
        <div class="card-header" style="cursor: pointer;" onclick="toggleSection('tripleLight')">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="section-toggle" id="tripleLightToggle">▼</span>
            <span class="card-title">🚦 Triple Light</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="event.stopPropagation(); showBotHistory('tripleLight', '🚦 Triple Light')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="tripleLightHistoryCount">0</span></button>
            <span id="tripleLightPositionCount">0</span>
          </div>
        </div>
        <div id="tripleLightContent">
          <div id="tripleLightSignalsBox" style="margin-bottom: 8px; font-size: 11px; color: #8b949e;"></div>
          <div id="tripleLightPositionsTable"><div class="empty-state">No positions</div></div>
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
    </div>

    <!-- BTC RSI Multi-Timeframe Chart -->
    <div class="card" style="margin-top: 20px;">
      <div class="card-header">
        <span class="card-title">📊 BTC RSI Multi-Timeframe</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span style="font-size: 11px; color: #8b949e;">RSI(14) vs SMA(9)</span>
          <button onclick="refreshBtcRsi()" id="refreshRsiBtn" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; font-size: 12px; cursor: pointer;">
            Refresh
          </button>
        </div>
      </div>

      <!-- Market Bias Indicator -->
      <div id="marketBiasBox" style="margin-bottom: 16px; padding: 16px; background: #0d1117; border-radius: 8px; border: 2px solid #30363d; text-align: center;">
        <div style="display: flex; justify-content: center; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div>
            <div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px;">Market Bias</div>
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

      <!-- Chart Container -->
      <div style="position: relative; height: 300px;">
        <canvas id="btcRsiChart"></canvas>
      </div>
      <div style="display: flex; justify-content: center; gap: 16px; margin-top: 12px; font-size: 11px;">
        <span><span style="display: inline-block; width: 12px; height: 3px; background: #f85149; margin-right: 4px;"></span>4H</span>
        <span><span style="display: inline-block; width: 12px; height: 3px; background: #d29922; margin-right: 4px;"></span>1H</span>
        <span><span style="display: inline-block; width: 12px; height: 3px; background: #3fb950; margin-right: 4px;"></span>15M</span>
        <span><span style="display: inline-block; width: 12px; height: 3px; background: #58a6ff; margin-right: 4px;"></span>5M</span>
        <span><span style="display: inline-block; width: 12px; height: 3px; background: #a371f7; margin-right: 4px;"></span>1M</span>
        <span style="color: #6e7681;">|</span>
        <span style="color: #6e7681;">Dashed = SMA(9)</span>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
  <script>
    const eventSource = new EventSource('/events');

    eventSource.onopen = () => {
      document.getElementById('statusDot').className = 'status-dot active';
      document.getElementById('statusText').textContent = 'Connected';
    };

    eventSource.onerror = () => {
      document.getElementById('statusDot').className = 'status-dot inactive';
      document.getElementById('statusText').textContent = 'Disconnected - Reconnecting...';
    };

    eventSource.addEventListener('state', (e) => {
      const state = JSON.parse(e.data);
      updateUI(state);
    });

    eventSource.addEventListener('scan_status', (e) => {
      const { status } = JSON.parse(e.data);
      document.getElementById('statusText').textContent = status;
    });

    // Symbol check functionality
    document.getElementById('symbolSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') checkSymbol();
    });

    async function checkSymbol() {
      const input = document.getElementById('symbolSearch');
      const symbol = input.value.trim();
      if (!symbol) return;

      const btn = document.getElementById('checkBtn');
      btn.textContent = '...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/check/' + encodeURIComponent(symbol));
        const data = await res.json();

        document.getElementById('checkTitle').textContent = data.symbol + ' Analysis';
        document.getElementById('checkResults').innerHTML = renderCheckResults(data);
        document.getElementById('checkModal').style.display = 'block';
      } catch (err) {
        alert('Error checking symbol: ' + err.message);
      } finally {
        btn.textContent = 'Check';
        btn.disabled = false;
      }
    }

    function closeModal() {
      document.getElementById('checkModal').style.display = 'none';
    }

    function openGuide() {
      document.getElementById('guideModal').style.display = 'block';
    }

    function closeGuide() {
      document.getElementById('guideModal').style.display = 'none';
    }

    // History modal - stores last fetched state for rendering
    let lastState = null;

    function showBotHistory(botKey, botName) {
      document.getElementById('historyModalTitle').textContent = botName + ' History';
      if (lastState) {
        const content = renderHistoryModalContent(botKey, lastState);
        document.getElementById('historyModalContent').innerHTML = content;
      } else {
        document.getElementById('historyModalContent').innerHTML = '<div class="empty-state">Loading...</div>';
      }
      document.getElementById('historyModal').style.display = 'block';
    }

    function closeHistoryModal() {
      document.getElementById('historyModal').style.display = 'none';
    }

    function renderHistoryModalContent(botKey, state) {
      let trades = [];
      let isTrailing = true;

      // Map bot keys to state properties
      const botMap = {
        'fixedTP': { prop: 'fixedTPBot', trailing: false },
        'trailing1pct': { prop: 'trailing1pctBot', trailing: true },
        'trailing10pct10x': { prop: 'trailing10pct10xBot', trailing: true },
        'trailing10pct20x': { prop: 'trailing10pct20xBot', trailing: true },
        'trailWide': { prop: 'trailWideBot', trailing: true },
        'confluence': { prop: 'confluenceBot', trailing: true },
        'tripleLight': { prop: 'tripleLightBot', trailing: true },
        'btcExtreme': { prop: 'btcExtremeBot', trailing: true, btc: true },
        'btcTrend': { prop: 'btcTrendBot', trailing: true, btc: true },
        'trendOverride': { prop: 'trendOverrideBot', trailing: true },
        'trendFlip': { prop: 'trendFlipBot', trailing: true },
      };

      const config = botMap[botKey];
      if (config && state[config.prop]) {
        trades = state[config.prop].closedPositions || [];
        isTrailing = config.trailing;
      }

      if (trades.length === 0) {
        return '<div class="empty-state">No trade history</div>';
      }

      if (isTrailing) {
        return renderTrailingHistoryTable(trades);
      } else {
        return renderHistoryTable(trades);
      }
    }

    // Close modals on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeGuide();
        closeHistoryModal();
      }
    });

    // Section collapse/expand state
    const sectionState = {
      altcoinBots: true,
      btcBiasBots: true,
      btcBiasStats: true,
      mexcSim: true,
      goldenPocket: true,
      // Focus Mode and Bot Cards
      focusMode: true,
      fixedTP: true,
      trailing1pct: true,
      trailing10pct10x: true,
      trailing10pct20x: true,
      trailWide: true,
      confluence: true,
      tripleLight: true,
      btcExtreme: true,
      btcTrend: true,
      trendOverride: true,
      trendFlip: true,
    };

    function toggleSection(sectionId) {
      console.log('[toggleSection] Called for: ' + sectionId);
      // Toggle state
      sectionState[sectionId] = !sectionState[sectionId];
      const isExpanded = sectionState[sectionId];
      console.log('[toggleSection] New state for ' + sectionId + ': ' + (isExpanded ? 'expanded' : 'collapsed'));
      const content = document.getElementById(sectionId + 'Content');
      const toggle = document.getElementById(sectionId + 'Toggle');
      if (content && toggle) {
        // Use direct style manipulation for reliable hiding
        content.style.display = isExpanded ? 'block' : 'none';
        toggle.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        console.log('[toggleSection] Applied styles - display: ' + content.style.display + ', transform: ' + toggle.style.transform);
      } else {
        console.warn('[toggleSection] Elements not found for ' + sectionId + '. Content: ' + !!content + ', Toggle: ' + !!toggle);
      }
    }

    function collapseAllSections() {
      Object.keys(sectionState).forEach(id => {
        sectionState[id] = false;
        const content = document.getElementById(id + 'Content');
        const toggle = document.getElementById(id + 'Toggle');
        if (content && toggle) {
          content.style.display = 'none';
          toggle.style.transform = 'rotate(-90deg)';
        }
      });
    }

    function expandAllSections() {
      Object.keys(sectionState).forEach(id => {
        sectionState[id] = true;
        const content = document.getElementById(id + 'Content');
        const toggle = document.getElementById(id + 'Toggle');
        if (content && toggle) {
          content.style.display = 'block';
          toggle.style.transform = 'rotate(0deg)';
        }
      });
    }

    function renderCheckResults(data) {
      let html = '<table style="width: 100%; border-collapse: collapse;">';
      html += '<tr style="border-bottom: 1px solid #30363d;"><th style="text-align: left; padding: 8px; color: #8b949e;">Market</th><th style="text-align: left; padding: 8px; color: #8b949e;">TF</th><th style="text-align: right; padding: 8px; color: #8b949e;">RSI</th><th style="text-align: left; padding: 8px; color: #8b949e;">Setup</th></tr>';

      for (const r of data.results) {
        if (r.error) {
          html += '<tr style="border-bottom: 1px solid #21262d;"><td style="padding: 8px; color: #8b949e;">' + r.marketType.toUpperCase() + '</td><td style="padding: 8px;">' + r.timeframe + '</td><td colspan="2" style="padding: 8px; color: #6e7681;">' + r.error + '</td></tr>';
          continue;
        }

        const rsiColor = r.rsiZone === 'oversold' ? '#f85149' : r.rsiZone === 'overbought' ? '#3fb950' : r.rsiZone === 'low' ? '#d29922' : r.rsiZone === 'high' ? '#58a6ff' : '#8b949e';
        const rsiLabel = r.rsiZone === 'oversold' ? ' (OS)' : r.rsiZone === 'overbought' ? ' (OB)' : '';

        let setupHtml = '<span style="color: #6e7681;">No setup</span>';
        if (r.setup) {
          const dirColor = r.setup.direction === 'long' ? '#3fb950' : '#f85149';
          const stateColor = r.setup.state === 'triggered' ? '#3fb950' : r.setup.state === 'deep_extreme' ? '#f85149' : r.setup.state === 'reversing' ? '#d29922' : '#8b949e';
          setupHtml = '<span style="color: ' + dirColor + '; font-weight: bold;">' + r.setup.direction.toUpperCase() + '</span> <span style="background: ' + stateColor + '22; color: ' + stateColor + '; padding: 2px 6px; border-radius: 4px; font-size: 12px;">' + r.setup.state.toUpperCase() + '</span>';
        }

        html += '<tr style="border-bottom: 1px solid #21262d;">';
        html += '<td style="padding: 8px; color: #c9d1d9;">' + r.marketType.toUpperCase() + '</td>';
        html += '<td style="padding: 8px; font-weight: 500;">' + r.timeframe + '</td>';
        html += '<td style="padding: 8px; text-align: right; color: ' + rsiColor + '; font-weight: bold;">' + r.currentRSI + rsiLabel + '</td>';
        html += '<td style="padding: 8px;">' + setupHtml + '</td>';
        html += '</tr>';
      }

      html += '</table>';

      if (data.activeSetups && data.activeSetups.length > 0) {
        html += '<div style="margin-top: 16px; padding: 12px; background: #0d1117; border-radius: 8px;"><strong style="color: #3fb950;">Active Setups: ' + data.activeSetups.length + '</strong></div>';
      }

      return html;
    }

    // Bot visibility state (synced with server)
    let botVisibility = {
      fixedTP: true, trailing1pct: true, trailing10pct10x: true, trailing10pct20x: true,
      trailWide: true, confluence: true, tripleLight: true,
      btcExtreme: true, btcTrend: true, trendOverride: true, trendFlip: true,
      // BTC Bias bots
      bias100x20trail: true, bias100x50trail: true, bias10x20trail: true, bias10x50trail: true,
      bias100x20hard: true, bias100x50hard: true, bias10x20hard: true, bias10x50hard: true,
    };

    // Setups tab state
    let currentSetupsTab = 'active';
    let allSetupsData = { all: [], active: [], playedOut: [], history: [], goldenPocket: [] };

    // Saved list state
    let savedList = new Set();  // Keys: symbol-timeframe-direction-marketType
    let selectedSetups = new Set();  // Currently selected in UI

    function getSetupKey(s) {
      return s.symbol + '-' + s.timeframe + '-' + s.direction + '-' + s.marketType;
    }

    function toggleSetupSelection(key) {
      if (selectedSetups.has(key)) {
        selectedSetups.delete(key);
      } else {
        selectedSetups.add(key);
      }
      updateSelectionStatus();
      // Update checkbox visual
      const cb = document.querySelector('[data-setup-key="' + key + '"]');
      if (cb) cb.checked = selectedSetups.has(key);
    }

    function selectAllSetups() {
      const currentSetups = getCurrentDisplayedSetups();
      currentSetups.forEach(s => selectedSetups.add(getSetupKey(s)));
      updateSelectionStatus();
      renderSetupsWithTab();
    }

    function deselectAllSetups() {
      selectedSetups.clear();
      updateSelectionStatus();
      renderSetupsWithTab();
    }

    function addSelectedToList() {
      selectedSetups.forEach(key => savedList.add(key));
      updateSavedListCount();
      selectedSetups.clear();
      updateSelectionStatus();
      renderSetupsWithTab();
    }

    function removeSelectedFromList() {
      selectedSetups.forEach(key => savedList.delete(key));
      updateSavedListCount();
      selectedSetups.clear();
      updateSelectionStatus();
      renderSetupsWithTab();
    }

    function updateSelectionStatus() {
      const el = document.getElementById('selectionStatus');
      if (el) el.textContent = selectedSetups.size + ' selected';
    }

    function updateSavedListCount() {
      const el = document.getElementById('savedListCount');
      if (el) el.textContent = savedList.size;
    }

    function getCurrentDisplayedSetups() {
      if (currentSetupsTab === 'active') return allSetupsData.active || [];
      if (currentSetupsTab === 'playedOut') return allSetupsData.playedOut || [];
      if (currentSetupsTab === 'history') return allSetupsData.history || [];
      if (currentSetupsTab === 'goldenPocket') {
        return (allSetupsData.goldenPocket || []).filter(s => gpStateFilters[s.state]);
      }
      if (currentSetupsTab === 'savedList') {
        // Collect all setups that are in saved list
        const all = [...(allSetupsData.all || []), ...(allSetupsData.goldenPocket || [])];
        return all.filter(s => savedList.has(getSetupKey(s)));
      }
      return allSetupsData.all || [];
    }

    // GP filter state - which states to show
    let gpStateFilters = {
      watching: true,
      triggered: true,
      deep_extreme: true,
      reversing: true,
      played_out: false  // Hide played_out by default
    };

    function toggleGpFilter(state) {
      gpStateFilters[state] = !gpStateFilters[state];
      updateGpFilterButtons();
      renderSetupsWithTab();
    }

    function updateGpFilterButtons() {
      ['watching', 'triggered', 'deep_extreme', 'reversing', 'played_out'].forEach(state => {
        const btn = document.getElementById('gpFilter_' + state);
        if (btn) {
          btn.style.opacity = gpStateFilters[state] ? '1' : '0.4';
          btn.style.textDecoration = gpStateFilters[state] ? 'none' : 'line-through';
        }
      });
    }

    function setSetupsTab(tab) {
      currentSetupsTab = tab;
      // Update tab button styles
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.style.background = '#21262d';
        btn.style.color = '#8b949e';
      });
      const activeBtn = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (activeBtn) {
        const bgColor = tab === 'playedOut' ? '#6e7681' :
                        tab === 'history' ? '#8957e5' :
                        tab === 'goldenPocket' ? '#f0883e' :
                        tab === 'savedList' ? '#58a6ff' : '#238636';
        activeBtn.style.background = bgColor;
        activeBtn.style.color = 'white';
      }
      // Re-render setups table with current filter
      renderSetupsWithTab();
    }

    function renderSetupsWithTab() {
      let setups;
      if (currentSetupsTab === 'active') {
        setups = allSetupsData.active;
      } else if (currentSetupsTab === 'playedOut') {
        setups = allSetupsData.playedOut;
      } else if (currentSetupsTab === 'history') {
        setups = allSetupsData.history;
      } else if (currentSetupsTab === 'goldenPocket') {
        // Apply GP state filters
        let filteredSetups = (allSetupsData.goldenPocket || []).filter(s => gpStateFilters[s.state]);
        document.getElementById('setupsTable').innerHTML = renderGoldenPocketTable(filteredSetups, allSetupsData.goldenPocket?.length || 0);
        return;
      } else if (currentSetupsTab === 'savedList') {
        // Show saved list items (both regular and GP setups)
        setups = getCurrentDisplayedSetups();
        document.getElementById('setupsTable').innerHTML = renderSavedListTable(setups);
        return;
      } else {
        setups = allSetupsData.all;
      }
      document.getElementById('setupsTable').innerHTML = renderSetupsTable(setups, currentSetupsTab);
    }

    function renderGoldenPocketTable(setups, totalCount) {
      // Build MEXC futures URL from symbol (e.g., RIVERUSDT -> RIVER_USDT)
      function getMexcFuturesUrl(symbol) {
        const base = symbol.replace('USDT', '');
        return 'https://www.mexc.com/futures/' + base + '_USDT';
      }

      // Filter bar
      let html = '<div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; align-items: center;">';
      html += '<span style="color: #8b949e; font-size: 11px; margin-right: 4px;">Filter:</span>';
      html += '<button id="gpFilter_watching" onclick="toggleGpFilter(\\'watching\\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #8b949e; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.watching ? '1' : '0.4') + ';">watching</button>';
      html += '<button id="gpFilter_triggered" onclick="toggleGpFilter(\\'triggered\\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #3fb950; background: #21262d; color: #3fb950; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.triggered ? '1' : '0.4') + ';">triggered</button>';
      html += '<button id="gpFilter_deep_extreme" onclick="toggleGpFilter(\\'deep_extreme\\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #f0883e; background: #21262d; color: #f0883e; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.deep_extreme ? '1' : '0.4') + ';">deep</button>';
      html += '<button id="gpFilter_reversing" onclick="toggleGpFilter(\\'reversing\\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #58a6ff; background: #21262d; color: #58a6ff; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.reversing ? '1' : '0.4') + ';">reversing</button>';
      html += '<button id="gpFilter_played_out" onclick="toggleGpFilter(\\'played_out\\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #6e7681; background: #21262d; color: #6e7681; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.played_out ? '1' : '0.4') + ';">played out</button>';
      html += '<span style="color: #6e7681; font-size: 10px; margin-left: 8px;">(' + (setups?.length || 0) + '/' + (totalCount || 0) + ')</span>';
      html += '</div>';

      if (!setups || setups.length === 0) {
        return html + '<div class="empty-state">No Golden Pocket setups match filters</div>';
      }

      html += '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
      html += '<thead><tr style="border-bottom: 1px solid #30363d;">';
      html += '<th style="width: 30px; padding: 8px;"></th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Symbol</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Dir</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">TF</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">State</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Retrace%</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Entry Zone</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">TP1</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Stop</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Updated</th>';
      html += '</tr></thead><tbody>';

      for (const s of setups) {
        const dirColor = s.direction === 'long' ? '#3fb950' : '#f85149';
        const dirIcon = s.direction === 'long' ? '📈' : '📉';
        const stateColor = s.state === 'triggered' ? '#3fb950' :
                           s.state === 'deep_extreme' ? '#f0883e' :
                           s.state === 'reversing' ? '#58a6ff' : '#8b949e';
        const ticker = s.symbol.replace('USDT', '');
        const mexcUrl = getMexcFuturesUrl(s.symbol);
        const lastUpdated = formatTimeAgo(s.lastUpdated || s.detectedAt);
        const key = getSetupKey(s);
        const isSelected = selectedSetups.has(key);
        const inList = savedList.has(key);

        html += '<tr style="border-bottom: 1px solid #21262d;' + (inList ? ' background: #1c2128;' : '') + '">';
        html += '<td style="padding: 8px;"><input type="checkbox" data-setup-key="' + key + '" onclick="toggleSetupSelection(\\'' + key + '\\')" ' + (isSelected ? 'checked' : '') + ' style="cursor: pointer;">' + (inList ? '<span title="In list" style="color: #58a6ff; margin-left: 4px;">📋</span>' : '') + '</td>';
        html += '<td style="padding: 8px; font-weight: 600;"><a href="' + mexcUrl + '" target="_blank" style="color: #58a6ff; text-decoration: none;" title="Open on MEXC Futures">' + ticker + '</a></td>';
        html += '<td style="padding: 8px; color: ' + dirColor + ';">' + dirIcon + ' ' + s.direction.toUpperCase() + '</td>';
        html += '<td style="padding: 8px;">' + s.timeframe + '</td>';
        html += '<td style="padding: 8px; color: ' + stateColor + ';">' + s.state + '</td>';
        html += '<td style="padding: 8px; text-align: right;">' + (s.retracementPercent * 100).toFixed(1) + '%</td>';
        html += '<td style="padding: 8px; text-align: right; color: #f0883e;">' + (s.fibLevels?.level618?.toFixed(6) || '-') + ' - ' + (s.fibLevels?.level65?.toFixed(6) || '-') + '</td>';
        html += '<td style="padding: 8px; text-align: right; color: #3fb950;">' + (s.tp1Price?.toFixed(6) || '-') + '</td>';
        html += '<td style="padding: 8px; text-align: right; color: #f85149;">' + (s.stopPrice?.toFixed(6) || '-') + '</td>';
        html += '<td style="padding: 8px; text-align: right; color: #8b949e;">' + lastUpdated + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      return html;
    }

    function renderSavedListTable(setups) {
      if (!setups || setups.length === 0) {
        return '<div class="empty-state">No setups in your saved list. Select setups and click "+ Add to List"</div>';
      }

      function getMexcFuturesUrl(symbol) {
        const base = symbol.replace('USDT', '');
        return 'https://www.mexc.com/futures/' + base + '_USDT';
      }

      let html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
      html += '<thead><tr style="border-bottom: 1px solid #30363d;">';
      html += '<th style="width: 30px; padding: 8px;"></th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Symbol</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Type</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Dir</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">TF</th>';
      html += '<th style="text-align: left; padding: 8px; color: #8b949e;">State</th>';
      html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Updated</th>';
      html += '</tr></thead><tbody>';

      for (const s of setups) {
        const dirColor = s.direction === 'long' ? '#3fb950' : '#f85149';
        const dirIcon = s.direction === 'long' ? '📈' : '📉';
        const stateColor = s.state === 'triggered' ? '#3fb950' :
                           s.state === 'deep_extreme' ? '#f0883e' :
                           s.state === 'reversing' ? '#58a6ff' : '#8b949e';
        const ticker = s.symbol.replace('USDT', '');
        const mexcUrl = getMexcFuturesUrl(s.symbol);
        const lastUpdated = formatTimeAgo(s.lastUpdated || s.detectedAt);
        const key = getSetupKey(s);
        const isSelected = selectedSetups.has(key);
        const isGP = 'fibLevels' in s;

        html += '<tr style="border-bottom: 1px solid #21262d;">';
        html += '<td style="padding: 8px;"><input type="checkbox" data-setup-key="' + key + '" onclick="toggleSetupSelection(\\'' + key + '\\')" ' + (isSelected ? 'checked' : '') + ' style="cursor: pointer;"></td>';
        html += '<td style="padding: 8px; font-weight: 600;"><a href="' + mexcUrl + '" target="_blank" style="color: #58a6ff; text-decoration: none;" title="Open on MEXC Futures">' + ticker + '</a></td>';
        html += '<td style="padding: 8px; color: ' + (isGP ? '#f0883e' : '#8b949e') + ';">' + (isGP ? '🎯 GP' : '🔥 BB') + '</td>';
        html += '<td style="padding: 8px; color: ' + dirColor + ';">' + dirIcon + ' ' + s.direction.toUpperCase() + '</td>';
        html += '<td style="padding: 8px;">' + s.timeframe + '</td>';
        html += '<td style="padding: 8px; color: ' + stateColor + ';">' + s.state + '</td>';
        html += '<td style="padding: 8px; text-align: right; color: #8b949e;">' + lastUpdated + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      return html;
    }

    // Focus Mode functions
    let focusModeEnabled = false;

    async function toggleFocusMode() {
      const endpoint = focusModeEnabled ? '/api/focus/disable' : '/api/focus/enable';
      try {
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        focusModeEnabled = data.enabled;
        updateFocusModeUI();
      } catch (err) {
        console.error('Failed to toggle focus mode:', err);
      }
    }

    async function updateFocusConfig() {
      const config = {
        targetBot: document.getElementById('focusTargetBot').value,
        accountBalance: parseFloat(document.getElementById('focusBalance').value) || 1000,
        maxPositionSizePercent: parseFloat(document.getElementById('focusMaxPercent').value) || 5,
        leverage: parseFloat(document.getElementById('focusLeverage').value) || 10,
      };
      try {
        await fetch('/api/focus/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
      } catch (err) {
        console.error('Failed to update focus config:', err);
      }
    }

    async function testFocusNotification() {
      try {
        await fetch('/api/focus/test-notification', { method: 'POST' });
      } catch (err) {
        console.error('Failed to test notification:', err);
      }
    }

    function updateFocusModeUI() {
      const panel = document.getElementById('focusModePanel');
      const btn = document.getElementById('focusToggleBtn');

      // Always show panel
      panel.style.display = 'block';

      if (focusModeEnabled) {
        btn.textContent = 'Disable';
        btn.style.background = '#f0883e';
        btn.style.color = '#0d1117';
        panel.style.borderLeftColor = '#3fb950';
      } else {
        btn.textContent = 'Enable';
        btn.style.background = '#21262d';
        btn.style.color = '#f0883e';
        panel.style.borderLeftColor = '#f0883e';
      }
    }

    function updateFocusPositions(focusState) {
      if (!focusState) return;

      focusModeEnabled = focusState.enabled;
      updateFocusModeUI();

      // Update config fields
      document.getElementById('focusTargetBot').value = focusState.targetBot || 'trailing10pct10x';
      document.getElementById('focusBalance').value = focusState.accountBalance || 1000;
      document.getElementById('focusMaxPercent').value = focusState.maxPositionSizePercent || 5;
      document.getElementById('focusLeverage').value = focusState.leverage || 10;

      // Update position count
      document.getElementById('focusPositionCount').textContent = focusState.positionCount + ' positions';

      // Update positions display
      const posDiv = document.getElementById('focusPositions');
      if (focusState.activePositions && focusState.activePositions.length > 0) {
        let html = '<table style="width: 100%; border-collapse: collapse;">';
        html += '<tr style="border-bottom: 1px solid #30363d;"><th style="text-align: left; padding: 4px; color: #8b949e; font-size: 11px;">Symbol</th><th style="text-align: center; padding: 4px; color: #8b949e; font-size: 11px;">Action</th><th style="text-align: right; padding: 4px; color: #8b949e; font-size: 11px;">Size</th><th style="text-align: right; padding: 4px; color: #8b949e; font-size: 11px;">Stop</th><th style="text-align: right; padding: 4px; color: #8b949e; font-size: 11px;">P&L</th></tr>';

        for (const pos of focusState.activePositions) {
          const dirClass = pos.direction === 'long' ? 'badge-long' : 'badge-short';
          const pnl = pos.unrealizedPnL || 0;
          const pnlPct = pos.unrealizedPnLPercent || 0;
          const pnlClass = pnl >= 0 ? 'positive' : 'negative';
          const pnlSign = pnl >= 0 ? '+' : '';
          // Calculate ROI-based stop (price % * leverage)
          const stopPricePct = pos.initialStopPercent || 2;
          const stopRoiPct = stopPricePct * (pos.suggestedLeverage || 10);
          const leverage = pos.suggestedLeverage || 10;

          // Format stop price for easy copy-paste to MEXC
          const stopPrice = pos.currentStopPrice || 0;
          const stopPriceStr = stopPrice < 0.01 ? stopPrice.toFixed(6) : stopPrice < 1 ? stopPrice.toFixed(4) : stopPrice.toFixed(2);
          const entryPrice = pos.entryPrice || 0;
          const entryPriceStr = entryPrice < 0.01 ? entryPrice.toFixed(6) : entryPrice < 1 ? entryPrice.toFixed(4) : entryPrice.toFixed(2);

          html += '<tr style="border-bottom: 1px solid #21262d;">';
          html += '<td style="padding: 6px 4px;"><span style="font-weight: 600;">' + pos.symbol.replace('USDT', '') + '</span> <span class="badge ' + dirClass + '" style="font-size: 10px;">' + pos.direction.toUpperCase() + '</span><br/><span style="color: #6e7681; font-size: 10px;">' + pos.timeframe + ' ' + pos.marketType + '</span></td>';

          // Action column - clear instructions
          html += '<td style="text-align: center; padding: 6px 4px; font-size: 11px;">';
          if (pos.status === 'pending_open') {
            html += '<span style="color: #f0883e; font-weight: 600;">OPEN NOW</span>';
            html += '<br/><span style="color: #c9d1d9; font-size: 10px;">Entry ~$' + entryPriceStr + '</span>';
          } else if (pos.currentTrailLevel > 0) {
            const lockedRoi = (pos.currentTrailLevel - 1) * 10;
            html += '<span style="color: #3fb950; font-weight: 600;">MOVE STOP</span>';
            html += '<br/><span style="color: #58a6ff; font-size: 10px;">Lock +' + lockedRoi + '% ROI</span>';
          } else {
            html += '<span style="color: #8b949e;">HOLD</span>';
            html += '<br/><span style="color: #6e7681; font-size: 10px;">Wait for +10% ROI</span>';
          }
          html += '</td>';

          // Size column
          html += '<td style="text-align: right; padding: 6px 4px; color: #c9d1d9; font-size: 11px;">$' + pos.suggestedSize.toFixed(0) + '<br/><span style="color: #6e7681;">' + leverage + 'x</span></td>';

          // Stop Price column - THE KEY INFO for MEXC
          html += '<td style="text-align: right; padding: 6px 4px; font-size: 11px;">';
          if (pos.currentTrailLevel > 0) {
            const lockedRoi = (pos.currentTrailLevel - 1) * 10;
            html += '<span style="color: #3fb950; font-weight: 600; font-size: 12px;">$' + stopPriceStr + '</span>';
            html += '<br/><span style="color: #6e7681; font-size: 10px;">+' + lockedRoi + '% ROI</span>';
          } else {
            html += '<span style="color: #f85149; font-weight: 600; font-size: 12px;">$' + stopPriceStr + '</span>';
            html += '<br/><span style="color: #6e7681; font-size: 10px;">-' + stopRoiPct.toFixed(0) + '% ROI</span>';
          }
          html += '</td>';

          // P&L column
          html += '<td style="text-align: right; padding: 6px 4px;" class="pnl ' + pnlClass + '">' + pnlSign + '$' + pnl.toFixed(2) + '<br/><span style="font-size: 10px;">' + pnlSign + pnlPct.toFixed(1) + '%</span></td>';
          html += '</tr>';
        }
        html += '</table>';
        posDiv.innerHTML = html;
      } else if (focusModeEnabled) {
        posDiv.innerHTML = '<div style="color: #6e7681; text-align: center; padding: 16px;">Waiting for signals from ' + focusState.targetBot + '...</div>';
      } else {
        posDiv.innerHTML = '<div style="color: #6e7681; text-align: center; padding: 16px;">Enable Focus Mode to receive trade copy notifications</div>';
      }

      // Update recent actions
      const actionsDiv = document.getElementById('focusActions');
      const actionsList = document.getElementById('focusActionsList');
      if (focusState.recentActions && focusState.recentActions.length > 0) {
        actionsDiv.style.display = 'block';
        let actHtml = '';
        for (const action of focusState.recentActions.slice(0, 8)) {
          const ticker = action.position.symbol.replace('USDT', '');
          const pos = action.position;
          const stopPrice = (pos.currentStopPrice || 0).toPrecision(4);
          const entryPrice = (pos.entryPrice || 0).toPrecision(4);
          const stopRoiPct = ((pos.initialStopPercent || 2) * (pos.suggestedLeverage || 10)).toFixed(0);

          if (action.type === 'OPEN_POSITION') {
            actHtml += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d;">';
            actHtml += '<div style="color: #f0883e; font-weight: 600;">🟢 OPEN ' + ticker + ' ' + pos.direction.toUpperCase() + ' ' + pos.timeframe + '</div>';
            actHtml += '<div style="color: #8b949e; font-size: 11px; margin-top: 2px;">Entry: $' + entryPrice + ' | Stop: $' + stopPrice + ' (-' + stopRoiPct + '% ROI)</div>';
            actHtml += '<div style="color: #6e7681; font-size: 10px;">Size: $' + pos.suggestedSize + ' @ ' + pos.suggestedLeverage + 'x</div>';
            actHtml += '</div>';
          } else if (action.type === 'CLOSE_POSITION') {
            const pnl = pos.unrealizedPnL || 0;
            const pnlStr = pnl >= 0 ? '+$' + pnl.toFixed(2) : '-$' + Math.abs(pnl).toFixed(2);
            actHtml += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d;">';
            actHtml += '<div style="color: #f85149; font-weight: 600;">🔴 CLOSE ' + ticker + ' - ' + action.reason + '</div>';
            actHtml += '<div style="color: #8b949e; font-size: 11px; margin-top: 2px;">P&L: ' + pnlStr + '</div>';
            actHtml += '</div>';
          } else if (action.type === 'MOVE_TO_BREAKEVEN') {
            actHtml += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d;">';
            actHtml += '<div style="color: #3fb950; font-weight: 600;">🔒 ' + ticker + ' MOVE STOP TO BREAKEVEN</div>';
            actHtml += '<div style="color: #8b949e; font-size: 11px; margin-top: 2px;">New stop: $' + entryPrice + ' (entry price)</div>';
            actHtml += '</div>';
          } else if (action.type === 'LOCK_PROFIT') {
            actHtml += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d;">';
            actHtml += '<div style="color: #58a6ff; font-weight: 600;">📈 ' + ticker + ' RAISE STOP - Lock +' + action.lockedPnL + '% ROI</div>';
            actHtml += '<div style="color: #8b949e; font-size: 11px; margin-top: 2px;">New stop: $' + stopPrice + '</div>';
            actHtml += '</div>';
          } else if (action.type === 'UPDATE_STOP') {
            actHtml += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d;">';
            actHtml += '<div style="color: #58a6ff; font-weight: 600;">⬆️ ' + ticker + ' Trail L' + action.oldLevel + ' → L' + action.newLevel + '</div>';
            actHtml += '<div style="color: #8b949e; font-size: 11px; margin-top: 2px;">New stop: $' + stopPrice + '</div>';
            actHtml += '</div>';
          }
        }
        actionsList.innerHTML = actHtml;
      } else {
        actionsDiv.style.display = 'none';
      }
    }

    async function toggleBot(bot) {
      const newVisible = !botVisibility[bot];
      try {
        await fetch('/api/toggle-bot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot, visible: newVisible })
        });
        botVisibility[bot] = newVisible;
        updateBotVisibility();
      } catch (err) {
        console.error('Failed to toggle bot:', err);
      }
    }

    async function resetBots() {
      if (!confirm('Reset all paper trading bots? This will clear all positions and history.')) return;
      try {
        await fetch('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      } catch (err) {
        console.error('Failed to reset bots:', err);
      }
    }

    function updateBotVisibility() {
      // Helper to safely set display on elements
      const setDisplay = (ids, display) => {
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = display;
        });
      };

      // Helper to update toggle button style
      const setToggle = (toggleId, active, color) => {
        const toggle = document.getElementById(toggleId);
        if (toggle) {
          toggle.style.opacity = active ? '1' : '0.5';
          const indicator = toggle.querySelector('.toggle-indicator');
          if (indicator) indicator.style.background = active ? color : '#30363d';
        }
      };

      // Fixed TP/SL bot (green)
      setDisplay(['fixedTPCard'], botVisibility.fixedTP ? 'block' : 'none');
      setToggle('toggleFixedTP', botVisibility.fixedTP, '#3fb950');

      // Trailing 1% bot (purple)
      setDisplay(['trailing1pctCard'], botVisibility.trailing1pct ? 'block' : 'none');
      setToggle('toggleTrailing1pct', botVisibility.trailing1pct, '#a371f7');

      // Trailing 10% 10x bot (orange)
      setDisplay(['trailing10pct10xCard'], botVisibility.trailing10pct10x ? 'block' : 'none');
      setToggle('toggleTrailing10pct10x', botVisibility.trailing10pct10x, '#d29922');

      // Trailing 10% 20x bot (red)
      setDisplay(['trailing10pct20xCard'], botVisibility.trailing10pct20x ? 'block' : 'none');
      setToggle('toggleTrailing10pct20x', botVisibility.trailing10pct20x, '#f85149');

      // Trail Wide bot (blue)
      setDisplay(['trailWideCard'], botVisibility.trailWide ? 'block' : 'none');
      setToggle('toggleTrailWide', botVisibility.trailWide, '#58a6ff');

      // Confluence bot (cyan)
      setDisplay(['confluenceCard'], botVisibility.confluence ? 'block' : 'none');
      setToggle('toggleConfluence', botVisibility.confluence, '#39d4e8');

      // Triple Light bot (lime)
      setDisplay(['tripleLightCard'], botVisibility.tripleLight ? 'block' : 'none');
      setToggle('toggleTripleLight', botVisibility.tripleLight, '#7ee787');

      // BTC Extreme bot (orange)
      setDisplay(['btcExtremeCard'], botVisibility.btcExtreme ? 'block' : 'none');
      setToggle('toggleBtcExtreme', botVisibility.btcExtreme, '#ff6b35');

      // BTC Trend bot (teal)
      setDisplay(['btcTrendCard'], botVisibility.btcTrend ? 'block' : 'none');
      setToggle('toggleBtcTrend', botVisibility.btcTrend, '#00d4aa');

      // Trend Override bot (magenta)
      setDisplay(['trendOverrideCard'], botVisibility.trendOverride ? 'block' : 'none');
      setToggle('toggleTrendOverride', botVisibility.trendOverride, '#e040fb');

      // Trend Flip bot (cyan)
      setDisplay(['trendFlipCard'], botVisibility.trendFlip ? 'block' : 'none');
      setToggle('toggleTrendFlip', botVisibility.trendFlip, '#00bcd4');

      // BTC Bias bots
      setToggle('toggleBias100x20trail', botVisibility.bias100x20trail, '#ffd700');
      setToggle('toggleBias100x50trail', botVisibility.bias100x50trail, '#ff8c00');
      setToggle('toggleBias10x20trail', botVisibility.bias10x20trail, '#98fb98');
      setToggle('toggleBias10x50trail', botVisibility.bias10x50trail, '#00ced1');
      setToggle('toggleBias100x20hard', botVisibility.bias100x20hard, '#dc143c');
      setToggle('toggleBias100x50hard', botVisibility.bias100x50hard, '#ff6666');
      setToggle('toggleBias10x20hard', botVisibility.bias10x20hard, '#9370db');
      setToggle('toggleBias10x50hard', botVisibility.bias10x50hard, '#4169e1');
    }

    function updateUI(state) {
      // Store state for history modal
      lastState = state;

      // Sync bot visibility from server
      if (state.botVisibility) {
        botVisibility = state.botVisibility;
        updateBotVisibility();
      }

      // Update symbol count
      document.getElementById('symbolCount').textContent = state.meta.eligibleSymbols + ' symbols';

      // Update status
      document.getElementById('statusDot').className = 'status-dot ' + (state.meta.isRunning ? 'active' : 'inactive');
      document.getElementById('statusText').textContent = state.meta.status;

      // Store setups data and update tab counts
      allSetupsData = {
        all: state.setups.all,
        active: state.setups.active,
        playedOut: state.setups.playedOut,
        history: state.setups.history || [],
        goldenPocket: state.setups.goldenPocket || [],
      };
      document.getElementById('activeCount').textContent = state.setups.active.length;
      document.getElementById('playedOutCount').textContent = state.setups.playedOut.length;
      document.getElementById('historyCount').textContent = (state.setups.history || []).length;
      document.getElementById('allCount').textContent = state.setups.all.length;
      document.getElementById('gpCount').textContent = (state.setups.goldenPocket || []).length;

      // Render setups table based on current tab
      renderSetupsWithTab();

      // Update Fixed TP/SL bot stats (Bot 1)
      const fixedStats = state.fixedTPBot.stats;
      const fixedUnreal = state.fixedTPBot.unrealizedPnL;
      document.getElementById('fixedBalance').textContent = formatCurrency(fixedStats.currentBalance);
      const fixedPnL = document.getElementById('fixedPnL');
      fixedPnL.textContent = formatCurrency(fixedStats.totalPnL);
      fixedPnL.className = fixedStats.totalPnL >= 0 ? 'positive' : 'negative';
      const fixedUnrealEl = document.getElementById('fixedUnrealPnL');
      fixedUnrealEl.textContent = formatCurrency(fixedUnreal);
      fixedUnrealEl.className = fixedUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('fixedWinRate').textContent = fixedStats.winRate.toFixed(0) + '%';
      document.getElementById('fixedTrades').textContent = fixedStats.totalTrades;
      document.getElementById('fixedCosts').textContent = formatCurrency(fixedStats.totalExecutionCosts || 0);

      // Update Trailing 1% bot stats (Bot 2)
      const trail1pctStats = state.trailing1pctBot.stats;
      const trail1pctUnreal = state.trailing1pctBot.unrealizedPnL;
      document.getElementById('trail1pctBalance').textContent = formatCurrency(trail1pctStats.currentBalance);
      const trail1pctPnL = document.getElementById('trail1pctPnL');
      trail1pctPnL.textContent = formatCurrency(trail1pctStats.totalPnL);
      trail1pctPnL.className = trail1pctStats.totalPnL >= 0 ? 'positive' : 'negative';
      const trail1pctUnrealEl = document.getElementById('trail1pctUnrealPnL');
      trail1pctUnrealEl.textContent = formatCurrency(trail1pctUnreal);
      trail1pctUnrealEl.className = trail1pctUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('trail1pctWinRate').textContent = trail1pctStats.winRate.toFixed(0) + '%';
      document.getElementById('trail1pctTrades').textContent = trail1pctStats.totalTrades;
      document.getElementById('trail1pctCosts').textContent = formatCurrency(trail1pctStats.totalExecutionCosts || 0);

      // Update Trailing 10% 10x bot stats (Bot 3)
      const trail10pct10xStats = state.trailing10pct10xBot.stats;
      const trail10pct10xUnreal = state.trailing10pct10xBot.unrealizedPnL;
      document.getElementById('trail10pct10xBalance').textContent = formatCurrency(trail10pct10xStats.currentBalance);
      const trail10pct10xPnL = document.getElementById('trail10pct10xPnL');
      trail10pct10xPnL.textContent = formatCurrency(trail10pct10xStats.totalPnL);
      trail10pct10xPnL.className = trail10pct10xStats.totalPnL >= 0 ? 'positive' : 'negative';
      const trail10pct10xUnrealEl = document.getElementById('trail10pct10xUnrealPnL');
      trail10pct10xUnrealEl.textContent = formatCurrency(trail10pct10xUnreal);
      trail10pct10xUnrealEl.className = trail10pct10xUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('trail10pct10xWinRate').textContent = trail10pct10xStats.winRate.toFixed(0) + '%';
      document.getElementById('trail10pct10xTrades').textContent = trail10pct10xStats.totalTrades;
      document.getElementById('trail10pct10xCosts').textContent = formatCurrency(trail10pct10xStats.totalExecutionCosts || 0);

      // Update Trailing 10% 20x bot stats (Bot 4)
      const trail10pct20xStats = state.trailing10pct20xBot.stats;
      const trail10pct20xUnreal = state.trailing10pct20xBot.unrealizedPnL;
      document.getElementById('trail10pct20xBalance').textContent = formatCurrency(trail10pct20xStats.currentBalance);
      const trail10pct20xPnL = document.getElementById('trail10pct20xPnL');
      trail10pct20xPnL.textContent = formatCurrency(trail10pct20xStats.totalPnL);
      trail10pct20xPnL.className = trail10pct20xStats.totalPnL >= 0 ? 'positive' : 'negative';
      const trail10pct20xUnrealEl = document.getElementById('trail10pct20xUnrealPnL');
      trail10pct20xUnrealEl.textContent = formatCurrency(trail10pct20xUnreal);
      trail10pct20xUnrealEl.className = trail10pct20xUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('trail10pct20xWinRate').textContent = trail10pct20xStats.winRate.toFixed(0) + '%';
      document.getElementById('trail10pct20xTrades').textContent = trail10pct20xStats.totalTrades;
      document.getElementById('trail10pct20xCosts').textContent = formatCurrency(trail10pct20xStats.totalExecutionCosts || 0);

      // Update Trail Wide bot stats (Bot 5)
      const trailWideStats = state.trailWideBot.stats;
      const trailWideUnreal = state.trailWideBot.unrealizedPnL;
      document.getElementById('trailWideBalance').textContent = formatCurrency(trailWideStats.currentBalance);
      const trailWidePnL = document.getElementById('trailWidePnL');
      trailWidePnL.textContent = formatCurrency(trailWideStats.totalPnL);
      trailWidePnL.className = trailWideStats.totalPnL >= 0 ? 'positive' : 'negative';
      const trailWideUnrealEl = document.getElementById('trailWideUnrealPnL');
      trailWideUnrealEl.textContent = formatCurrency(trailWideUnreal);
      trailWideUnrealEl.className = trailWideUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('trailWideWinRate').textContent = trailWideStats.winRate.toFixed(0) + '%';
      document.getElementById('trailWideTrades').textContent = trailWideStats.totalTrades;
      document.getElementById('trailWideCosts').textContent = formatCurrency(trailWideStats.totalExecutionCosts || 0);

      // Update Confluence bot stats (Bot 6)
      const confluenceStats = state.confluenceBot.stats;
      const confluenceUnreal = state.confluenceBot.unrealizedPnL;
      document.getElementById('confluenceBalance').textContent = formatCurrency(confluenceStats.currentBalance);
      const confluencePnL = document.getElementById('confluencePnL');
      confluencePnL.textContent = formatCurrency(confluenceStats.totalPnL);
      confluencePnL.className = confluenceStats.totalPnL >= 0 ? 'positive' : 'negative';
      const confluenceUnrealEl = document.getElementById('confluenceUnrealPnL');
      confluenceUnrealEl.textContent = formatCurrency(confluenceUnreal);
      confluenceUnrealEl.className = confluenceUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('confluenceWinRate').textContent = confluenceStats.winRate.toFixed(0) + '%';
      document.getElementById('confluenceTrades').textContent = confluenceStats.totalTrades;
      document.getElementById('confluenceCosts').textContent = formatCurrency(confluenceStats.totalExecutionCosts || 0);

      // Update Triple Light bot stats (Bot 7)
      const tripleLightStats = state.tripleLightBot.stats;
      const tripleLightUnreal = state.tripleLightBot.unrealizedPnL;
      document.getElementById('tripleLightBalance').textContent = formatCurrency(tripleLightStats.currentBalance);
      const tripleLightPnL = document.getElementById('tripleLightPnL');
      tripleLightPnL.textContent = formatCurrency(tripleLightStats.totalPnL);
      tripleLightPnL.className = tripleLightStats.totalPnL >= 0 ? 'positive' : 'negative';
      const tripleLightUnrealEl = document.getElementById('tripleLightUnrealPnL');
      tripleLightUnrealEl.textContent = formatCurrency(tripleLightUnreal);
      tripleLightUnrealEl.className = tripleLightUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('tripleLightWinRate').textContent = tripleLightStats.winRate.toFixed(0) + '%';
      document.getElementById('tripleLightTrades').textContent = tripleLightStats.totalTrades;
      document.getElementById('tripleLightCosts').textContent = formatCurrency(tripleLightStats.totalExecutionCosts || 0);

      // Update BTC Extreme bot stats (Bot 8)
      const btcExtremeStats = state.btcExtremeBot.stats;
      const btcExtremeUnreal = state.btcExtremeBot.unrealizedPnL;
      document.getElementById('btcExtremeBalance').textContent = formatCurrency(btcExtremeStats.currentBalance);
      const btcExtremePnL = document.getElementById('btcExtremePnL');
      btcExtremePnL.textContent = formatCurrency(btcExtremeStats.totalPnL);
      btcExtremePnL.className = btcExtremeStats.totalPnL >= 0 ? 'positive' : 'negative';
      const btcExtremeUnrealEl = document.getElementById('btcExtremeUnrealPnL');
      btcExtremeUnrealEl.textContent = formatCurrency(btcExtremeUnreal);
      btcExtremeUnrealEl.className = btcExtremeUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('btcExtremeWinRate').textContent = btcExtremeStats.winRate.toFixed(0) + '%';
      document.getElementById('btcExtremeTrades').textContent = btcExtremeStats.totalTrades;
      document.getElementById('btcExtremeCosts').textContent = formatCurrency(btcExtremeStats.totalExecutionCosts || 0);

      // Update BTC Trend bot stats (Bot 9)
      const btcTrendStats = state.btcTrendBot.stats;
      const btcTrendUnreal = state.btcTrendBot.unrealizedPnL;
      document.getElementById('btcTrendBalance').textContent = formatCurrency(btcTrendStats.currentBalance);
      const btcTrendPnL = document.getElementById('btcTrendPnL');
      btcTrendPnL.textContent = formatCurrency(btcTrendStats.totalPnL);
      btcTrendPnL.className = btcTrendStats.totalPnL >= 0 ? 'positive' : 'negative';
      const btcTrendUnrealEl = document.getElementById('btcTrendUnrealPnL');
      btcTrendUnrealEl.textContent = formatCurrency(btcTrendUnreal);
      btcTrendUnrealEl.className = btcTrendUnreal >= 0 ? 'positive' : 'negative';
      document.getElementById('btcTrendWinRate').textContent = btcTrendStats.winRate.toFixed(0) + '%';
      document.getElementById('btcTrendTrades').textContent = btcTrendStats.totalTrades;
      document.getElementById('btcTrendCosts').textContent = formatCurrency(btcTrendStats.totalExecutionCosts || 0);

      // Update Trend Override bot stats (Bot 10)
      if (state.trendOverrideBot) {
        const trendOverrideStats = state.trendOverrideBot.stats;
        const trendOverrideUnreal = state.trendOverrideBot.unrealizedPnL;
        document.getElementById('trendOverrideBalance').textContent = formatCurrency(trendOverrideStats.currentBalance);
        const trendOverridePnL = document.getElementById('trendOverridePnL');
        trendOverridePnL.textContent = formatCurrency(trendOverrideStats.totalPnL);
        trendOverridePnL.className = trendOverrideStats.totalPnL >= 0 ? 'positive' : 'negative';
        const trendOverrideUnrealEl = document.getElementById('trendOverrideUnrealPnL');
        trendOverrideUnrealEl.textContent = formatCurrency(trendOverrideUnreal);
        trendOverrideUnrealEl.className = trendOverrideUnreal >= 0 ? 'positive' : 'negative';
        document.getElementById('trendOverrideWinRate').textContent = trendOverrideStats.winRate.toFixed(0) + '%';
        document.getElementById('trendOverrideTrades').textContent = trendOverrideStats.totalTrades;
        document.getElementById('trendOverrideCosts').textContent = formatCurrency(trendOverrideStats.totalExecutionCosts || 0);
      }

      // Update Trend Flip bot stats (Bot 11)
      if (state.trendFlipBot) {
        const trendFlipStats = state.trendFlipBot.stats;
        const trendFlipUnreal = state.trendFlipBot.unrealizedPnL;
        document.getElementById('trendFlipBalance').textContent = formatCurrency(trendFlipStats.currentBalance);
        const trendFlipPnL = document.getElementById('trendFlipPnL');
        trendFlipPnL.textContent = formatCurrency(trendFlipStats.totalPnL);
        trendFlipPnL.className = trendFlipStats.totalPnL >= 0 ? 'positive' : 'negative';
        const trendFlipUnrealEl = document.getElementById('trendFlipUnrealPnL');
        trendFlipUnrealEl.textContent = formatCurrency(trendFlipUnreal);
        trendFlipUnrealEl.className = trendFlipUnreal >= 0 ? 'positive' : 'negative';
        document.getElementById('trendFlipWinRate').textContent = trendFlipStats.winRate.toFixed(0) + '%';
        document.getElementById('trendFlipTrades').textContent = trendFlipStats.totalTrades;
        document.getElementById('trendFlipCosts').textContent = formatCurrency(trendFlipStats.totalExecutionCosts || 0);
      }

      // Update BTC Bias bots stats (Bots 12-19)
      if (state.btcBiasBots) {
        const biasKeys = ['bias100x20trail', 'bias100x50trail', 'bias10x20trail', 'bias10x50trail',
                         'bias100x20hard', 'bias100x50hard', 'bias10x20hard', 'bias10x50hard'];
        for (const key of biasKeys) {
          const bot = state.btcBiasBots[key];
          if (bot) {
            const balEl = document.getElementById(key + 'Balance');
            const pnlEl = document.getElementById(key + 'PnL');
            const statusEl = document.getElementById(key + 'Status');
            if (balEl) balEl.textContent = formatCurrency(bot.balance);
            // Show unrealized PnL if position is open, otherwise show realized
            const displayPnL = bot.position ? bot.unrealizedPnL : bot.stats.totalPnL;
            if (pnlEl) {
              pnlEl.textContent = formatCurrency(displayPnL);
              pnlEl.className = displayPnL >= 0 ? 'positive' : 'negative';
            }
            if (statusEl) {
              if (bot.position) {
                const dir = bot.position.direction.toUpperCase();
                const roiPct = bot.position.marginUsed > 0 ? (bot.unrealizedPnL / bot.position.marginUsed * 100).toFixed(1) : '0';
                statusEl.innerHTML = '<span style="color: ' + (bot.position.direction === 'long' ? '#3fb950' : '#f85149') + ';">' + dir + ' ' + roiPct + '% ROI</span>';
              } else if (bot.isStoppedOut) {
                statusEl.innerHTML = '<span style="color: #f85149;">Stopped out (' + (bot.stoppedOutDirection || '-') + ')</span>';
              } else {
                statusEl.innerHTML = '<span style="color: #8b949e;">No position</span>';
              }
            }
          }
        }
      }

      // Update MEXC Simulation bots stats (Bots 20-25)
      if (state.mexcSimBots) {
        const mexcKeyMap = {
          'mexc-aggressive': 'mexcAggressive',
          'mexc-aggressive-2cb': 'mexcAggressive2cb',
          'mexc-wide': 'mexcWide',
          'mexc-wide-2cb': 'mexcWide2cb',
          'mexc-standard': 'mexcStandard',
          'mexc-standard-05cb': 'mexcStandard05cb',
        };
        for (const [key, elementId] of Object.entries(mexcKeyMap)) {
          const bot = state.mexcSimBots[key];
          if (bot) {
            const balEl = document.getElementById(elementId + 'Balance');
            const pnlEl = document.getElementById(elementId + 'PnL');
            const winRateEl = document.getElementById(elementId + 'WinRate');
            const trailingEl = document.getElementById(elementId + 'Trailing');
            const posCountEl = document.getElementById(elementId + 'PositionCount');
            if (balEl) balEl.textContent = formatCurrency(bot.balance);
            // Show unrealized if there are open positions, otherwise realized
            const hasOpenPositions = bot.openPositions && bot.openPositions.length > 0;
            const displayPnL = hasOpenPositions ? (bot.unrealizedPnL || 0) : bot.stats.totalPnL;
            if (pnlEl) {
              pnlEl.textContent = formatCurrency(displayPnL);
              pnlEl.className = displayPnL >= 0 ? 'positive' : 'negative';
            }
            if (winRateEl) winRateEl.textContent = bot.stats.winRate.toFixed(0) + '%';
            if (trailingEl) trailingEl.textContent = bot.stats.trailingActivatedCount || 0;
            if (posCountEl) posCountEl.textContent = (bot.openPositions || []).length;
          }
        }
      }

      // Update Golden Pocket bots stats (Bots 26-29)
      if (state.goldenPocketBots) {
        const gpKeyMap = {
          'gp-conservative': 'gpConservative',
          'gp-standard': 'gpStandard',
          'gp-aggressive': 'gpAggressive',
          'gp-yolo': 'gpYolo',
        };
        for (const [key, elementId] of Object.entries(gpKeyMap)) {
          const bot = state.goldenPocketBots[key];
          if (bot) {
            const balEl = document.getElementById(elementId + 'Balance');
            const pnlEl = document.getElementById(elementId + 'PnL');
            const unrealEl = document.getElementById(elementId + 'UnrealPnL');
            const winRateEl = document.getElementById(elementId + 'WinRate');
            const tp1RateEl = document.getElementById(elementId + 'TP1Rate');
            const posCountEl = document.getElementById(elementId + 'PositionCount');
            if (balEl) balEl.textContent = formatCurrency(bot.balance);
            if (pnlEl) {
              pnlEl.textContent = formatCurrency(bot.stats.totalPnL);
              pnlEl.className = bot.stats.totalPnL >= 0 ? 'positive' : 'negative';
            }
            if (unrealEl) {
              unrealEl.textContent = formatCurrency(bot.unrealizedPnL || 0);
              unrealEl.className = (bot.unrealizedPnL || 0) >= 0 ? 'positive' : 'negative';
            }
            if (winRateEl) winRateEl.textContent = bot.stats.winRate.toFixed(0) + '%';
            if (tp1RateEl) tp1RateEl.textContent = (bot.stats.tp1HitRate || 0).toFixed(0) + '%';
            if (posCountEl) posCountEl.textContent = (bot.openPositions || []).length;
          }
        }
        // Update GP Account Equity values
        const gpEquityMap = {
          'gp-conservative': 'gpConsEquity',
          'gp-standard': 'gpStdEquity',
          'gp-aggressive': 'gpAggEquity',
          'gp-yolo': 'gpYoloEquity',
        };
        for (const [key, eqId] of Object.entries(gpEquityMap)) {
          const bot = state.goldenPocketBots[key];
          if (bot) {
            const equity = bot.balance + (bot.unrealizedPnL || 0);
            const eqEl = document.getElementById(eqId);
            if (eqEl) {
              eqEl.textContent = formatCurrency(equity);
              eqEl.style.color = equity >= 2000 ? '#3fb950' : '#f85149';
            }
          }
        }
      }

      // Update Fixed TP/SL positions (Bot 1)
      document.getElementById('fixedPositionCount').textContent = state.fixedTPBot.openPositions.length;
      document.getElementById('fixedPositionsTable').innerHTML = renderPositionsTable(state.fixedTPBot.openPositions, 'fixed');

      // Update Trailing 1% positions (Bot 2)
      document.getElementById('trail1pctPositionCount').textContent = state.trailing1pctBot.openPositions.length;
      document.getElementById('trail1pctPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing1pctBot.openPositions);

      // Update Trailing 10% 10x positions (Bot 3)
      document.getElementById('trail10pct10xPositionCount').textContent = state.trailing10pct10xBot.openPositions.length;
      document.getElementById('trail10pct10xPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing10pct10xBot.openPositions);

      // Update Trailing 10% 20x positions (Bot 4)
      document.getElementById('trail10pct20xPositionCount').textContent = state.trailing10pct20xBot.openPositions.length;
      document.getElementById('trail10pct20xPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing10pct20xBot.openPositions);

      // Update Trail Wide positions (Bot 5)
      document.getElementById('trailWidePositionCount').textContent = state.trailWideBot.openPositions.length;
      document.getElementById('trailWidePositionsTable').innerHTML = renderTrailingPositionsTable(state.trailWideBot.openPositions);

      // Update Confluence positions (Bot 6)
      document.getElementById('confluencePositionCount').textContent = state.confluenceBot.openPositions.length;
      document.getElementById('confluencePositionsTable').innerHTML = renderTrailingPositionsTable(state.confluenceBot.openPositions);
      // Update confluence active triggers display
      const triggers = state.confluenceBot.activeTriggers || [];
      const triggersBox = document.getElementById('confluenceTriggersBox');
      if (triggers.length > 0) {
        triggersBox.innerHTML = triggers.map(t =>
          '<span style="margin-right: 8px; color: ' + (t.hasConfluence ? '#a371f7' : '#6e7681') + ';">' +
          t.symbol.replace('USDT', '') + ' ' + t.direction.toUpperCase() + ' [' + t.timeframes.join(',') + ']' +
          (t.hasConfluence ? ' ✓' : '') + '</span>'
        ).join('');
      } else {
        triggersBox.innerHTML = 'Waiting for multi-TF triggers...';
      }

      // Update Triple Light positions (Bot 7)
      document.getElementById('tripleLightPositionCount').textContent = state.tripleLightBot.openPositions.length;
      document.getElementById('tripleLightPositionsTable').innerHTML = renderTripleLightPositionsTable(state.tripleLightBot.openPositions);
      // Update triple light signals display
      const assetSignals = state.tripleLightBot.assetSignals || [];
      const signalsBox = document.getElementById('tripleLightSignalsBox');
      if (assetSignals.length > 0) {
        signalsBox.innerHTML = assetSignals.slice(0, 8).map(s => {
          const lights = '🟢'.repeat(s.greenLights) + '⚫'.repeat(3 - s.greenLights);
          const color = s.greenLights === 3 ? '#f0e68c' : (s.greenLights >= 2 ? '#6e7681' : '#3d4148');
          return '<span style="margin-right: 8px; color: ' + color + ';">' +
            s.symbol.replace('USDT', '') + ' ' + (s.direction || '-').toUpperCase() + ' ' + lights + '</span>';
        }).join('');
      } else {
        signalsBox.innerHTML = 'Waiting for 3-green-light signals...';
      }

      // Update history counts (for badge display in buttons)
      document.getElementById('fixedHistoryCount').textContent = state.fixedTPBot.closedPositions.length;
      document.getElementById('trail1pctHistoryCount').textContent = state.trailing1pctBot.closedPositions.length;
      document.getElementById('trail10pct10xHistoryCount').textContent = state.trailing10pct10xBot.closedPositions.length;
      document.getElementById('trail10pct20xHistoryCount').textContent = state.trailing10pct20xBot.closedPositions.length;
      document.getElementById('trailWideHistoryCount').textContent = state.trailWideBot.closedPositions.length;
      document.getElementById('confluenceHistoryCount').textContent = state.confluenceBot.closedPositions.length;
      document.getElementById('tripleLightHistoryCount').textContent = state.tripleLightBot.closedPositions.length;
      document.getElementById('btcExtremeHistoryCount').textContent = state.btcExtremeBot.closedPositions.length;
      document.getElementById('btcTrendHistoryCount').textContent = state.btcTrendBot.closedPositions.length;

      // Update BTC position counts and tables (these bots have single positions, not arrays)
      const btcPos = state.btcExtremeBot.position;
      document.getElementById('btcExtremePositionCount').textContent = btcPos ? '1' : '0';
      document.getElementById('btcExtremePositionTable').innerHTML = renderBtcExtremePosition(btcPos);

      const btcTrendPos = state.btcTrendBot.position;
      document.getElementById('btcTrendPositionCount').textContent = btcTrendPos ? '1' : '0';
      document.getElementById('btcTrendPositionTable').innerHTML = renderBtcTrendPosition(btcTrendPos);

      // Update Trend Override positions (Bot 10)
      if (state.trendOverrideBot) {
        document.getElementById('trendOverridePositionCount').textContent = state.trendOverrideBot.openPositions.length;
        document.getElementById('trendOverridePositionTable').innerHTML = renderTrailingPositionsTable(state.trendOverrideBot.openPositions);
        document.getElementById('trendOverrideHistoryCount').textContent = state.trendOverrideBot.closedPositions.length;
      }

      // Update Trend Flip positions (Bot 11)
      if (state.trendFlipBot) {
        document.getElementById('trendFlipPositionCount').textContent = state.trendFlipBot.openPositions.length;
        document.getElementById('trendFlipPositionTable').innerHTML = renderTrailingPositionsTable(state.trendFlipBot.openPositions);
        document.getElementById('trendFlipHistoryCount').textContent = state.trendFlipBot.closedPositions.length;
      }

      // Update Focus Mode
      if (state.focusMode) {
        updateFocusPositions(state.focusMode);
      }
    }

    function formatCurrency(value) {
      return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatPercent(value) {
      const sign = value >= 0 ? '+' : '';
      return sign + value.toFixed(2) + '%';
    }

    function formatTimeAgo(timestamp) {
      if (!timestamp) return '-';
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return seconds + 's ago';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
      return Math.floor(seconds / 86400) + 'd ago';
    }

    function renderSetupsTable(setups, tabType) {
      if (setups.length === 0) {
        const msg = tabType === 'playedOut' ? 'No played out setups' :
                    tabType === 'history' ? 'No removed setups in history' :
                    tabType === 'all' ? 'No setups detected yet' : 'No active setups';
        return '<div class="empty-state">' + msg + '</div>';
      }

      // History tab has a 'Removed' column instead of 'Updated'
      const lastColHeader = tabType === 'history' ? 'Removed' : 'Updated';

      return '<table><thead><tr><th style="width: 30px;"></th><th>Mkt</th><th>Symbol</th><th>Dir</th><th>TF</th><th>State</th><th>RSI</th><th>Div</th><th>Price</th><th>Impulse</th><th>Triggered</th><th>' + lastColHeader + '</th></tr></thead><tbody>' +
        setups.map(s => {
          const stateClass = s.state === 'deep_extreme' ? 'deep' : s.state;
          const rowStyle = tabType === 'history' || s.state === 'played_out' ? 'opacity: 0.7;' : '';
          const impulseColor = s.impulsePercentMove >= 0 ? '#3fb950' : '#f85149';
          const impulseSign = s.impulsePercentMove >= 0 ? '+' : '';
          const rsiColor = s.currentRSI < 30 ? '#f85149' : s.currentRSI > 70 ? '#3fb950' : s.currentRSI < 40 ? '#d29922' : s.currentRSI > 60 ? '#58a6ff' : '#c9d1d9';
          const lastColTime = tabType === 'history' ? formatTimeAgo(s.removedAt) : formatTimeAgo(s.lastUpdated || s.detectedAt);
          const key = getSetupKey(s);
          const isSelected = selectedSetups.has(key);
          const inList = savedList.has(key);
          // Divergence display
          let divHtml = '-';
          if (s.divergence && s.divergence.type) {
            const divConfig = {
              'bullish': { label: '⬆', color: '#3fb950' },
              'bearish': { label: '⬇', color: '#f85149' },
              'hidden_bullish': { label: '⬆H', color: '#58a6ff' },
              'hidden_bearish': { label: '⬇H', color: '#ff7b72' }
            };
            const cfg = divConfig[s.divergence.type];
            if (cfg) {
              const strengthDots = s.divergence.strength === 'strong' ? '●●●' : s.divergence.strength === 'moderate' ? '●●○' : '●○○';
              divHtml = '<span style="color: ' + cfg.color + '; cursor: help;" title="' + (s.divergence.description || s.divergence.type) + '">' + cfg.label + ' ' + strengthDots + '</span>';
            }
          }
          return \`<tr style="\${rowStyle}\${inList ? ' background: #1c2128;' : ''}">
            <td><input type="checkbox" data-setup-key="\${key}" onclick="toggleSetupSelection('\${key}')" \${isSelected ? 'checked' : ''} style="cursor: pointer;">\${inList ? '<span title="In list" style="color: #58a6ff; margin-left: 4px;">📋</span>' : ''}</td>
            <td><span class="badge badge-\${s.marketType}">\${s.marketType === 'futures' ? 'F' : 'S'}</span></td>
            <td><strong>\${s.symbol.replace('USDT', '')}</strong><br><span style="font-size: 10px; color: #6e7681;">\${s.coinName || ''}</span></td>
            <td><span class="badge badge-\${s.direction}">\${s.direction.toUpperCase()}</span></td>
            <td>\${s.timeframe}</td>
            <td><span class="badge badge-\${stateClass}">\${s.state.replace('_', ' ')}</span></td>
            <td style="font-weight: 600; color: \${rsiColor}">\${s.currentRSI.toFixed(1)}</td>
            <td style="font-size: 11px;">\${divHtml}</td>
            <td style="font-family: monospace; font-size: 12px;">\${formatPrice(s.currentPrice)}</td>
            <td style="color: \${impulseColor}; font-weight: 500;">\${impulseSign}\${s.impulsePercentMove?.toFixed(1) || '?'}%</td>
            <td style="color: #8b949e; font-size: 11px;">\${formatTimeAgo(s.triggeredAt || s.detectedAt)}</td>
            <td style="color: #6e7681; font-size: 11px;">\${lastColTime}</td>
          </tr>\`;
        }).join('') +
        '</tbody></table>';
    }

    function formatPrice(price) {
      if (!price) return '-';
      if (price >= 1000) return price.toFixed(2);
      if (price >= 1) return price.toFixed(4);
      if (price >= 0.01) return price.toFixed(6);
      return price.toPrecision(4);
    }

    function renderPositionsTable(positions, botType) {
      if (positions.length === 0) return '<div class="empty-state">No open positions</div>';

      return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Entry</th><th>Current</th><th>P&L</th><th>TP/SL</th></tr></thead><tbody>' +
        positions.map(p => \`<tr>
          <td><strong>\${p.symbol.replace('USDT', '')}</strong></td>
          <td>\${p.timeframe || '?'}</td>
          <td><span class="badge badge-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
          <td>\${p.entryPrice.toPrecision(5)}</td>
          <td>\${p.currentPrice.toPrecision(5)}</td>
          <td class="pnl \${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(p.unrealizedPnL)} (\${formatPercent(p.unrealizedPnLPercent)})</td>
          <td>\${p.takeProfitPrice?.toPrecision(4) || '∞'} / \${p.stopLossPrice.toPrecision(4)}</td>
        </tr>\`).join('') +
        '</tbody></table>';
    }

    function renderTrailingPositionsTable(positions) {
      if (positions.length === 0) return '<div class="empty-state">No open positions</div>';

      return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th></tr></thead><tbody>' +
        positions.map(p => {
          const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
          const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
          // Calculate return on margin (ROI) - this is what MEXC shows
          const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;
          return \`<tr>
            <td><strong>\${p.symbol.replace('USDT', '')}</strong></td>
            <td>\${p.timeframe || '?'}</td>
            <td><span class="badge badge-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
            <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">\${p.leverage}x</span></td>
            <td>\${p.entryPrice.toPrecision(5)}</td>
            <td>\${p.currentPrice.toPrecision(5)}</td>
            <td class="pnl \${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
            <td style="color: \${trailColor}; font-weight: 600;">\${trailText}</td>
            <td>\${p.currentStopLossPrice.toPrecision(4)}</td>
          </tr>\`;
        }).join('') +
        '</tbody></table>';
    }

    function renderTripleLightPositionsTable(positions) {
      if (positions.length === 0) return '<div class="empty-state">No open positions</div>';

      return '<table><thead><tr><th>Symbol</th><th>Dir</th><th>Lights</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th></tr></thead><tbody>' +
        positions.map(p => {
          const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
          const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
          // Calculate return on margin (ROI)
          const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;
          // Green lights display
          const currentLights = p.currentGreenLights || p.entryGreenLights || 0;
          const lights = '🟢'.repeat(currentLights) + '⚫'.repeat(3 - currentLights);
          return \`<tr>
            <td><strong>\${p.symbol.replace('USDT', '')}</strong></td>
            <td><span class="badge badge-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
            <td style="font-size: 12px;">\${lights}</td>
            <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">\${p.leverage}x</span></td>
            <td>\${p.entryPrice.toPrecision(5)}</td>
            <td>\${p.currentPrice.toPrecision(5)}</td>
            <td class="pnl \${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
            <td style="color: \${trailColor}; font-weight: 600;">\${trailText}</td>
            <td>\${p.currentStopLossPrice.toPrecision(4)}</td>
          </tr>\`;
        }).join('') +
        '</tbody></table>';
    }

    function renderHistoryTable(trades) {
      if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

      return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr></thead><tbody>' +
        trades.map(t => \`<tr>
          <td><strong>\${t.symbol.replace('USDT', '')}</strong></td>
          <td>\${t.timeframe || '?'}</td>
          <td><span class="badge badge-\${t.direction}">\${t.direction.toUpperCase()}</span></td>
          <td>\${t.entryPrice.toPrecision(5)}</td>
          <td>\${t.exitPrice?.toPrecision(5) || '-'}</td>
          <td class="pnl \${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">\${formatCurrency(t.realizedPnL || 0)} (\${formatPercent(t.realizedPnLPercent || 0)})</td>
          <td>\${t.exitReason || '-'}</td>
        </tr>\`).join('') +
        '</tbody></table>';
    }

    function renderTrailingHistoryTable(trades) {
      if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

      // Calculate cost summary
      const totalCosts = trades.reduce((sum, t) => sum + (t.totalCosts || 0), 0);
      const totalFees = trades.reduce((sum, t) => sum + (t.entryCosts || 0) + (t.exitCosts || 0), 0);
      const totalFunding = trades.reduce((sum, t) => sum + (t.fundingPaid || 0), 0);
      const totalPnL = trades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
      const rawPnL = trades.reduce((sum, t) => sum + (t.rawPnL || (t.realizedPnL || 0) + (t.totalCosts || 0)), 0);

      const costsSummary = totalCosts > 0 ? \`
        <div style="display: flex; gap: 16px; margin-bottom: 12px; padding: 10px; background: #0d1117; border-radius: 6px; font-size: 12px;">
          <div><span style="color: #8b949e;">Total Fees:</span> <span style="color: #f85149;">\${formatCurrency(totalFees)}</span></div>
          <div><span style="color: #8b949e;">Funding:</span> <span style="color: #f85149;">\${formatCurrency(totalFunding)}</span></div>
          <div><span style="color: #8b949e;">Total Costs:</span> <span style="color: #f85149;">\${formatCurrency(totalCosts)}</span></div>
          <div><span style="color: #8b949e;">Net P&L:</span> <span class="\${totalPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(totalPnL)}</span></div>
          <div><span style="color: #8b949e;">Costs/Gross:</span> <span style="color: #d29922;">\${rawPnL > 0 ? ((totalCosts / rawPnL) * 100).toFixed(1) : 0}%</span></div>
        </div>\` : '';

      return costsSummary + '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Exit</th><th>Gross</th><th>Costs</th><th>Net P&L</th><th>Trail</th><th>Reason</th></tr></thead><tbody>' +
        trades.map(t => {
          const trailColor = t.trailLevel > 0 ? '#a371f7' : '#8b949e';
          // Calculate return on margin (ROI)
          const returnOnMargin = t.marginUsed > 0 ? ((t.realizedPnL || 0) / t.marginUsed) * 100 : 0;
          const grossPnL = t.rawPnL || (t.realizedPnL || 0) + (t.totalCosts || 0);
          const costs = t.totalCosts || 0;
          return \`<tr>
            <td><strong>\${t.symbol.replace('USDT', '')}</strong></td>
            <td>\${t.timeframe || '?'}</td>
            <td><span class="badge badge-\${t.direction}">\${t.direction.toUpperCase()}</span></td>
            <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(t.marginUsed || 0)}<br><span style="font-size: 10px;">\${t.leverage || '?'}x</span></td>
            <td>\${t.entryPrice.toPrecision(5)}</td>
            <td>\${t.exitPrice?.toPrecision(5) || '-'}</td>
            <td class="pnl \${grossPnL >= 0 ? 'positive' : 'negative'}" style="font-size: 11px;">\${formatCurrency(grossPnL)}</td>
            <td style="color: #f85149; font-size: 11px;">\${costs > 0 ? '-' + formatCurrency(costs) : '-'}</td>
            <td class="pnl \${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">\${formatCurrency(t.realizedPnL || 0)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
            <td style="color: \${trailColor}; font-weight: 600;">L\${t.trailLevel || 0}</td>
            <td>\${t.exitReason || '-'}</td>
          </tr>\`;
        }).join('') +
        '</tbody></table>';
    }

    function renderBtcExtremePosition(position) {
      if (!position) return '<div class="empty-state">No open position</div>';

      const p = position;
      const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
      const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
      const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;

      return '<table><thead><tr><th>Symbol</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th><th>Reason</th></tr></thead><tbody>' +
        \`<tr>
          <td><strong>₿ BTC</strong></td>
          <td><span class="badge badge-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
          <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">50x</span></td>
          <td>\${p.entryPrice.toPrecision(5)}</td>
          <td>\${p.currentPrice.toPrecision(5)}</td>
          <td class="pnl \${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
          <td style="color: \${trailColor}; font-weight: 600;">\${trailText}</td>
          <td>\${p.currentStopLossPrice.toPrecision(4)}</td>
          <td style="font-size: 11px; color: #6e7681;">\${p.openReason || '-'}</td>
        </tr>\` +
        '</tbody></table>';
    }

    function renderBtcTrendPosition(position) {
      if (!position) return '<div class="empty-state">No open position</div>';

      const p = position;
      const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
      const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
      const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;

      return '<table><thead><tr><th>Symbol</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th><th>Reason</th></tr></thead><tbody>' +
        \`<tr>
          <td><strong>₿ BTC</strong></td>
          <td><span class="badge badge-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
          <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">50x</span></td>
          <td>\${p.entryPrice.toPrecision(5)}</td>
          <td>\${p.currentPrice.toPrecision(5)}</td>
          <td class="pnl \${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
          <td style="color: \${trailColor}; font-weight: 600;">\${trailText}</td>
          <td>\${p.currentStopLossPrice.toPrecision(4)}</td>
          <td style="font-size: 11px; color: #00d4aa;">\${p.openReason || '-'}</td>
        </tr>\` +
        '</tbody></table>';
    }

    function renderBtcExtremeHistoryTable(trades) {
      if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

      return '<table><thead><tr><th>Dir</th><th>Margin</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Trail</th><th>Open</th><th>Close</th></tr></thead><tbody>' +
        trades.map(t => {
          const trailColor = t.trailLevel > 0 ? '#a371f7' : '#8b949e';
          const returnOnMargin = t.marginUsed > 0 ? ((t.realizedPnL || 0) / t.marginUsed) * 100 : 0;
          return \`<tr>
            <td><span class="badge badge-\${t.direction}">\${t.direction.toUpperCase()}</span></td>
            <td style="color: #8b949e; font-size: 11px;">\${formatCurrency(t.marginUsed || 0)}<br><span style="font-size: 10px;">50x</span></td>
            <td>\${t.entryPrice.toPrecision(5)}</td>
            <td>\${t.exitPrice?.toPrecision(5) || '-'}</td>
            <td class="pnl \${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">\${formatCurrency(t.realizedPnL || 0)}<br><span style="font-size: 10px;">(\${formatPercent(returnOnMargin)} ROI)</span></td>
            <td style="color: \${trailColor}; font-weight: 600;">L\${t.trailLevel || 0}</td>
            <td style="font-size: 11px; color: #6e7681;">\${t.openReason || '-'}</td>
            <td style="font-size: 11px; color: #6e7681;">\${t.closeReason || '-'}</td>
          </tr>\`;
        }).join('') +
        '</tbody></table>';
    }

    function formatMarketCap(mcap) {
      if (!mcap) return 'N/A';
      if (mcap >= 1e9) return '$' + (mcap / 1e9).toFixed(1) + 'B';
      if (mcap >= 1e6) return '$' + (mcap / 1e6).toFixed(0) + 'M';
      return '$' + (mcap / 1e3).toFixed(0) + 'K';
    }

    // BTC RSI Chart
    let btcRsiChart = null;
    const tfColors = {
      '4h': '#f85149',
      '1h': '#d29922',
      '15m': '#3fb950',
      '5m': '#58a6ff',
      '1m': '#a371f7',
    };

    async function refreshBtcRsi() {
      const btn = document.getElementById('refreshRsiBtn');
      btn.textContent = '...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/btc-rsi');
        const data = await res.json();
        updateBtcRsiChart(data);
        updateBtcSignalSummary(data);
        updateMarketBias(data);
      } catch (err) {
        console.error('Failed to fetch BTC RSI:', err);
      } finally {
        btn.textContent = 'Refresh';
        btn.disabled = false;
      }
    }

    function updateBtcSignalSummary(data) {
      const tfs = ['4h', '1h', '15m', '5m', '1m'];
      for (const tf of tfs) {
        const tfData = data.timeframes[tf];
        if (!tfData) continue;

        const signalEl = document.getElementById('signal' + tf);
        const rsiEl = document.getElementById('rsi' + tf);
        const divEl = document.getElementById('div' + tf);

        const signal = tfData.current.signal;
        const rsi = tfData.current.rsi;
        const sma = tfData.current.sma;
        const divergence = tfData.divergence;

        signalEl.textContent = signal === 'bullish' ? '▲ BULL' : signal === 'bearish' ? '▼ BEAR' : '— NEUT';
        signalEl.style.color = signal === 'bullish' ? '#3fb950' : signal === 'bearish' ? '#f85149' : '#8b949e';
        rsiEl.textContent = rsi.toFixed(1) + ' / ' + sma.toFixed(1);

        // Update divergence display
        if (divEl) {
          if (divergence && divergence.type) {
            const divConfig = {
              'bullish': { label: '⬆ BULL DIV', color: '#3fb950' },
              'bearish': { label: '⬇ BEAR DIV', color: '#f85149' },
              'hidden_bullish': { label: '⬆ H.BULL', color: '#58a6ff' },
              'hidden_bearish': { label: '⬇ H.BEAR', color: '#ff7b72' }
            };
            const cfg = divConfig[divergence.type];
            if (cfg) {
              const strengthIcon = divergence.strength === 'strong' ? '●●●' : divergence.strength === 'moderate' ? '●●○' : '●○○';
              divEl.textContent = cfg.label + ' ' + strengthIcon;
              divEl.style.color = cfg.color;
              divEl.title = divergence.description || '';
            } else {
              divEl.textContent = '-';
              divEl.style.color = '#6e7681';
              divEl.title = '';
            }
          } else {
            divEl.textContent = '-';
            divEl.style.color = '#6e7681';
            divEl.title = '';
          }
        }

        // Update box border based on signal
        const box = signalEl.closest('.signal-box');
        if (box) {
          box.style.borderColor = signal === 'bullish' ? '#238636' : signal === 'bearish' ? '#da3633' : '#30363d';
        }
      }
    }

    function updateMarketBias(data) {
      if (!data.marketBias) return;

      const { bias, score, reason } = data.marketBias;
      const biasBox = document.getElementById('marketBiasBox');
      const biasLabel = document.getElementById('marketBiasLabel');
      const biasReason = document.getElementById('marketBiasReason');
      const biasScore = document.getElementById('marketBiasScore');
      const biasAdvice = document.getElementById('marketBiasAdvice');

      // Set label and colors based on bias
      const biasConfig = {
        'strong_long': { label: 'STRONG LONG', color: '#3fb950', border: '#238636', icon: '🟢' },
        'long': { label: 'FAVOR LONGS', color: '#3fb950', border: '#238636', icon: '🟢' },
        'neutral': { label: 'NEUTRAL', color: '#8b949e', border: '#30363d', icon: '⚪' },
        'short': { label: 'FAVOR SHORTS', color: '#f85149', border: '#da3633', icon: '🔴' },
        'strong_short': { label: 'STRONG SHORT', color: '#f85149', border: '#da3633', icon: '🔴' },
      };

      const config = biasConfig[bias] || biasConfig['neutral'];

      biasLabel.textContent = config.icon + ' ' + config.label;
      biasLabel.style.color = config.color;
      biasBox.style.borderColor = config.border;
      biasReason.textContent = reason;
      biasScore.textContent = 'Bias Score: ' + (score > 0 ? '+' : '') + score + '%';

      // Generate trading advice
      let advice = '';
      if (bias === 'strong_long') {
        advice = '✅ Ideal conditions for LONG trades. All timeframes aligned bullish.';
      } else if (bias === 'long') {
        advice = '👍 Conditions favor LONG trades. Consider avoiding shorts.';
      } else if (bias === 'strong_short') {
        advice = '✅ Ideal conditions for SHORT trades. All timeframes aligned bearish.';
      } else if (bias === 'short') {
        advice = '👍 Conditions favor SHORT trades. Consider avoiding longs.';
      } else {
        advice = '⚠️ Mixed signals. Trade with caution or wait for clearer alignment.';
      }
      biasAdvice.textContent = advice;
      biasAdvice.style.color = bias.includes('long') ? '#3fb950' : bias.includes('short') ? '#f85149' : '#d29922';
    }

    function updateBtcRsiChart(data) {
      const ctx = document.getElementById('btcRsiChart').getContext('2d');

      // Destroy existing chart
      if (btcRsiChart) {
        btcRsiChart.destroy();
      }

      const datasets = [];
      const tfs = ['4h', '1h', '15m', '5m', '1m'];

      // Use 1m timeframe timestamps as the base (most data points)
      for (const tf of tfs) {
        const tfData = data.timeframes[tf];
        if (!tfData) continue;

        // RSI line
        datasets.push({
          label: tf.toUpperCase() + ' RSI',
          data: tfData.rsi.map(r => ({ x: r.timestamp, y: r.value })),
          borderColor: tfColors[tf],
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.1,
        });

        // SMA line (dashed)
        datasets.push({
          label: tf.toUpperCase() + ' SMA',
          data: tfData.rsiSMA.map(r => ({ x: r.timestamp, y: r.value })),
          borderColor: tfColors[tf],
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0.1,
        });
      }

      btcRsiChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              backgroundColor: '#161b22',
              borderColor: '#30363d',
              borderWidth: 1,
              titleColor: '#f0f6fc',
              bodyColor: '#c9d1d9',
              callbacks: {
                title: function(items) {
                  if (!items.length) return '';
                  return new Date(items[0].parsed.x).toLocaleString();
                },
              },
            },
          },
          scales: {
            x: {
              type: 'time',
              time: {
                displayFormats: {
                  minute: 'HH:mm',
                  hour: 'HH:mm',
                },
              },
              grid: {
                color: '#21262d',
              },
              ticks: {
                color: '#8b949e',
                maxTicksLimit: 8,
              },
            },
            y: {
              min: 0,
              max: 100,
              grid: {
                color: '#21262d',
              },
              ticks: {
                color: '#8b949e',
                stepSize: 10,
              },
            },
          },
          // Add horizontal lines at 30, 50, 70
          annotation: {
            annotations: {
              line30: {
                type: 'line',
                yMin: 30,
                yMax: 30,
                borderColor: '#da3633',
                borderWidth: 1,
                borderDash: [2, 2],
              },
              line50: {
                type: 'line',
                yMin: 50,
                yMax: 50,
                borderColor: '#8b949e',
                borderWidth: 1,
                borderDash: [2, 2],
              },
              line70: {
                type: 'line',
                yMin: 70,
                yMax: 70,
                borderColor: '#238636',
                borderWidth: 1,
                borderDash: [2, 2],
              },
            },
          },
        },
      });
    }

    // Load BTC RSI on page load
    setTimeout(refreshBtcRsi, 1000);

    // Auto-refresh every 30 seconds (faster for BTC bots)
    setInterval(refreshBtcRsi, 30000);
  </script>
</body>
</html>`;
}

// Start server and screener
async function main() {
  console.log('🔥 Starting Backburner Web Server...');
  console.log('📊 Running 4 paper trading bots:');
  console.log('   1. Fixed TP/SL: 1% pos, 10x, 20% TP/SL');
  console.log('   2. Trail 1%: 1% pos, 10x, trailing stop');
  console.log('   3. Trail 10% 10x: 10% pos, 10x, trailing stop (AGGRESSIVE)');
  console.log('   4. Trail 10% 20x: 10% pos, 20x, trailing stop (VERY AGGRESSIVE)');

  app.listen(PORT, () => {
    console.log(`✅ Web UI available at http://localhost:${PORT}`);
  });

  // Log bot configurations to data persistence
  const dataPersistence = getDataPersistence();
  dataPersistence.logBotConfig('fixed', 'Fixed 20/20', { ...fixedTPBot.getConfig() });
  dataPersistence.logBotConfig('1pct', 'Trail Light', { ...trailing1pctBot.getConfig() });
  dataPersistence.logBotConfig('10pct10x', 'Trail Standard', { ...trailing10pct10xBot.getConfig() });
  dataPersistence.logBotConfig('10pct20x', 'Trail Aggressive', { ...trailing10pct20xBot.getConfig() });
  dataPersistence.logBotConfig('wide', 'Trail Wide', { ...trailWideBot.getConfig() });
  dataPersistence.logBotConfig('confluence', 'Multi-TF', { ...confluenceBot.getConfig() });
  dataPersistence.logBotConfig('btcExtreme', 'BTC Contrarian', { ...btcExtremeBot.getConfig() });
  dataPersistence.logBotConfig('btcTrend', 'BTC Momentum', { ...btcTrendBot.getConfig() });
  console.log('📊 Bot configurations logged to data persistence');

  // Position persistence DISABLED - start fresh each time
  // To re-enable, uncomment the loadState() calls below
  console.log('📊 Starting with fresh bot state (persistence disabled)');
  // trailing1pctBot.loadState();
  // trailing10pct10xBot.loadState();
  // trailing10pct20xBot.loadState();
  // trailWideBot.loadState();

  // Graceful shutdown handler
  const saveAllPositions = () => {
    dataPersistence.stop();
    console.log('✅ Shutdown complete');
  };

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
      // Update ALL positions with real-time prices (for trailing bots that have the new method)
      // Use getPrice which handles both spot and futures markets
      await fixedTPBot.updateOrphanedPositions(getCurrentPrice);
      await trailing1pctBot.updateAllPositionPrices(getPrice);
      await trailing10pct10xBot.updateAllPositionPrices(getPrice);
      await trailing10pct20xBot.updateAllPositionPrices(getPrice);
      await trailWideBot.updateAllPositionPrices(getPrice);
      await confluenceBot.updateOrphanedPositions(getCurrentPrice);
      await tripleLightBot.updateOrphanedPositions(getCurrentPrice);
      await trendOverrideBot.updateOrphanedPositions(getCurrentPrice);
      await trendFlipBot.updateOrphanedPositions(getCurrentPrice, currentBtcBias);
      // Update MEXC simulation bots (all positions, not just orphaned)
      for (const [, bot] of mexcSimBots) {
        await bot.updateAllPositionPrices(getCurrentPrice);
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
      broadcastState(); // Update clients with new prices
    }, 10000);
  } catch (error) {
    console.error('Failed to start screener:', error);
    process.exit(1);
  }
}

main();
