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
import { NotificationManager } from './notifications.js';
import { BackburnerDetector } from './backburner-detector.js';
import { getKlines, getFuturesKlines, spotSymbolToFutures, getCurrentPrice } from './mexc-api.js';
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

const notifier = new NotificationManager({
  enabled: true,
  sound: true,
  soundName: 'Glass',
  onlyTriggered: true,
});

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

  // Send notification
  await notifier.notifyNewSetup(setup);

  // Broadcast setup
  broadcast('new_setup', setup);
  broadcastState();
}

function handleSetupUpdated(setup: BackburnerSetup) {
  // Update all trailing bots
  const fixedPosition = fixedTPBot.updatePosition(setup);
  const trail1pctPosition = trailing1pctBot.updatePosition(setup);
  const trail10pct10xPosition = trailing10pct10xBot.updatePosition(setup);
  const trail10pct20xPosition = trailing10pct20xBot.updatePosition(setup);
  const trailWidePosition = trailWideBot.updatePosition(setup);
  const confluencePosition = confluenceBot.updatePosition(setup);
  const tripleLightPosition = tripleLightBot.handleSetupUpdated(setup);

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
    .section-toggle { color: #8b949e; font-size: 16px; transition: transform 0.2s ease; }
    .section-toggle.collapsed { transform: rotate(-90deg); }
    .section-content { transition: max-height 0.3s ease, opacity 0.3s ease; overflow: hidden; }
    .section-content.collapsed { max-height: 0 !important; opacity: 0; margin-bottom: 0; }
    .bot-toggles-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .bot-toggle-mini { flex: 0 0 auto; min-width: 100px; padding: 6px 10px; background: #161b22; border: 2px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 11px; }
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
      <span class="section-title">📊 Altcoin Backburner Bots (11)</span>
      <span class="section-toggle" id="altcoinBotsToggle">▼</span>
    </div>
    <div class="section-content" id="altcoinBotsContent">
      <div class="bot-toggles-row">
        <div class="bot-toggle" id="toggleFixedTP" onclick="event.stopPropagation(); toggleBot('fixedTP')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #238636; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #3fb950; font-size: 12px;">🎯 Fixed</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #3fb950;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing1pct" onclick="event.stopPropagation(); toggleBot('trailing1pct')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #8957e5; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #a371f7; font-size: 12px;">📈 Trail 1%</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #a371f7;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing10pct10x" onclick="event.stopPropagation(); toggleBot('trailing10pct10x')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #d29922; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #d29922; font-size: 12px;">🔥 10% 10x</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #d29922;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailing10pct20x" onclick="event.stopPropagation(); toggleBot('trailing10pct20x')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #f85149; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #f85149; font-size: 12px;">💀 Aggressive</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #f85149;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrailWide" onclick="event.stopPropagation(); toggleBot('trailWide')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #58a6ff; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #58a6ff; font-size: 12px;">🌊 Wide</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #58a6ff;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleConfluence" onclick="event.stopPropagation(); toggleBot('confluence')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #a371f7; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #a371f7; font-size: 12px;">🔗 Multi-TF</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #a371f7;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTripleLight" onclick="event.stopPropagation(); toggleBot('tripleLight')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #f0e68c; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #f0e68c; font-size: 12px;">🚦 Triple</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #f0e68c;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBtcExtreme" onclick="event.stopPropagation(); toggleBot('btcExtreme')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #ff6b35; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff6b35; font-size: 12px;">₿ Contra</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff6b35;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleBtcTrend" onclick="event.stopPropagation(); toggleBot('btcTrend')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #00d4aa; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00d4aa; font-size: 12px;">₿ Mtm</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00d4aa;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrendOverride" onclick="event.stopPropagation(); toggleBot('trendOverride')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #e040fb; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #e040fb; font-size: 12px;">↕ Override</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #e040fb;"></span>
          </div>
        </div>
        <div class="bot-toggle" id="toggleTrendFlip" onclick="event.stopPropagation(); toggleBot('trendFlip')" style="flex: 1; min-width: 120px; padding: 8px 10px; background: #161b22; border: 2px solid #00bcd4; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00bcd4; font-size: 12px;">🔄 Flip</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00bcd4;"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Section: BTC Bias Bots -->
    <div class="section-header" onclick="toggleSection('btcBiasBots')">
      <span class="section-title">₿ BTC Bias Bots (8)</span>
      <span class="section-toggle" id="btcBiasBotsToggle">▼</span>
    </div>
    <div class="section-content" id="btcBiasBotsContent">
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px; padding: 6px 10px; background: #0d1117; border-radius: 4px;">
        BTC-only bots that trade based on macro bias. Hold through neutral, exit on opposite bias or stop. Require bias to cycle/strengthen after stop-out for re-entry.
      </div>
      <div class="bot-toggles-row">
        <div class="bot-toggle" id="toggleBias100x20trail" onclick="event.stopPropagation(); toggleBot('bias100x20trail')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #ffd700; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ffd700; font-size: 11px;">100% 20x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ffd700;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">Full size, trailing stop</div>
        </div>
        <div class="bot-toggle" id="toggleBias100x50trail" onclick="event.stopPropagation(); toggleBot('bias100x50trail')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #ff8c00; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff8c00; font-size: 11px;">100% 50x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff8c00;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">Full size, high lev</div>
        </div>
        <div class="bot-toggle" id="toggleBias10x20trail" onclick="event.stopPropagation(); toggleBot('bias10x20trail')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #98fb98; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #98fb98; font-size: 11px;">10% 20x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #98fb98;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">10% size, trailing</div>
        </div>
        <div class="bot-toggle" id="toggleBias10x50trail" onclick="event.stopPropagation(); toggleBot('bias10x50trail')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #00ced1; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #00ced1; font-size: 11px;">10% 50x Trail</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #00ced1;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">10% size, high lev</div>
        </div>
        <div class="bot-toggle" id="toggleBias100x20hard" onclick="event.stopPropagation(); toggleBot('bias100x20hard')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #dc143c; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #dc143c; font-size: 11px;">100% 20x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #dc143c;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">Full size, 20% ROI stop</div>
        </div>
        <div class="bot-toggle" id="toggleBias100x50hard" onclick="event.stopPropagation(); toggleBot('bias100x50hard')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #8b0000; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #ff6666; font-size: 11px;">100% 50x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff6666;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">Full size, high lev hard</div>
        </div>
        <div class="bot-toggle" id="toggleBias10x20hard" onclick="event.stopPropagation(); toggleBot('bias10x20hard')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #9370db; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #9370db; font-size: 11px;">10% 20x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #9370db;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">10% size, hard stop</div>
        </div>
        <div class="bot-toggle" id="toggleBias10x50hard" onclick="event.stopPropagation(); toggleBot('bias10x50hard')" style="flex: 1; min-width: 140px; padding: 8px 10px; background: #161b22; border: 2px solid #4169e1; border-radius: 6px; cursor: pointer;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #4169e1; font-size: 11px;">10% 50x Hard</span>
            <span class="toggle-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #4169e1;"></span>
          </div>
          <div style="font-size: 9px; color: #6e7681; margin-top: 2px;">10% size, high lev hard</div>
        </div>
      </div>
    </div>

    <!-- 8-Bot Stats Comparison -->
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

    <!-- Setups Card with Tabs -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="card-header" style="flex-wrap: wrap; gap: 12px;">
        <span class="card-title">📊 Setups</span>
        <div style="display: flex; gap: 8px;">
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
        </div>
      </div>
      <div id="setupsTable">
        <div class="empty-state">Scanning for setups...</div>
      </div>
    </div>

    <!-- Bot Cards - 8 bots in grid -->
    <div class="grid" id="botCardsGrid">
      <div class="card bot-card" id="fixedTPCard" style="border-left: 3px solid #238636;">
        <div class="card-header">
          <span class="card-title">🎯 Fixed 20/20</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('fixedTP', '🎯 Fixed 20/20')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="fixedHistoryCount">0</span></button>
            <span id="fixedPositionCount">0</span>
          </div>
        </div>
        <div id="fixedPositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="trailing1pctCard" style="border-left: 3px solid #8957e5;">
        <div class="card-header">
          <span class="card-title">📉 Trail Light</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trailing1pct', '📉 Trail Light')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail1pctHistoryCount">0</span></button>
            <span id="trail1pctPositionCount">0</span>
          </div>
        </div>
        <div id="trail1pctPositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="trailing10pct10xCard" style="border-left: 3px solid #d29922;">
        <div class="card-header">
          <span class="card-title">📈 Trail Standard</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trailing10pct10x', '📈 Trail Standard')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail10pct10xHistoryCount">0</span></button>
            <span id="trail10pct10xPositionCount">0</span>
          </div>
        </div>
        <div id="trail10pct10xPositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="trailing10pct20xCard" style="border-left: 3px solid #f85149;">
        <div class="card-header">
          <span class="card-title">💀 Trail Aggressive</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trailing10pct20x', '💀 Trail Aggressive')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trail10pct20xHistoryCount">0</span></button>
            <span id="trail10pct20xPositionCount">0</span>
          </div>
        </div>
        <div id="trail10pct20xPositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="trailWideCard" style="border-left: 3px solid #58a6ff;">
        <div class="card-header">
          <span class="card-title">🌊 Trail Wide</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trailWide', '🌊 Trail Wide')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trailWideHistoryCount">0</span></button>
            <span id="trailWidePositionCount">0</span>
          </div>
        </div>
        <div id="trailWidePositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="confluenceCard" style="border-left: 3px solid #a371f7;">
        <div class="card-header">
          <span class="card-title">🔗 Multi-TF</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('confluence', '🔗 Multi-TF')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="confluenceHistoryCount">0</span></button>
            <span id="confluencePositionCount">0</span>
          </div>
        </div>
        <div id="confluenceTriggersBox" style="margin-bottom: 8px; font-size: 11px; color: #8b949e;"></div>
        <div id="confluencePositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="tripleLightCard" style="border-left: 3px solid #f0e68c;">
        <div class="card-header">
          <span class="card-title">🚦 Triple Light</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('tripleLight', '🚦 Triple Light')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="tripleLightHistoryCount">0</span></button>
            <span id="tripleLightPositionCount">0</span>
          </div>
        </div>
        <div id="tripleLightSignalsBox" style="margin-bottom: 8px; font-size: 11px; color: #8b949e;"></div>
        <div id="tripleLightPositionsTable"><div class="empty-state">No positions</div></div>
      </div>
      <div class="card bot-card" id="btcExtremeCard" style="border-left: 3px solid #ff6b35;">
        <div class="card-header">
          <span class="card-title">₿ Contrarian</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('btcExtreme', '₿ Contrarian')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="btcExtremeHistoryCount">0</span></button>
            <span id="btcExtremePositionCount">0</span>
          </div>
        </div>
        <div id="btcExtremePositionTable"><div class="empty-state">No position</div></div>
      </div>
      <div class="card bot-card" id="btcTrendCard" style="border-left: 3px solid #00d4aa;">
        <div class="card-header">
          <span class="card-title">₿ Momentum</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('btcTrend', '₿ Momentum')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="btcTrendHistoryCount">0</span></button>
            <span id="btcTrendPositionCount">0</span>
          </div>
        </div>
        <div id="btcTrendPositionTable"><div class="empty-state">No position</div></div>
      </div>
      <div class="card bot-card" id="trendOverrideCard" style="border-left: 3px solid #e040fb;">
        <div class="card-header">
          <span class="card-title">↕ Override</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trendOverride', '↕ Override')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trendOverrideHistoryCount">0</span></button>
            <span id="trendOverridePositionCount">0</span>
          </div>
        </div>
        <div id="trendOverridePositionTable"><div class="empty-state">No position</div></div>
      </div>
      <div class="card bot-card" id="trendFlipCard" style="border-left: 3px solid #00bcd4;">
        <div class="card-header">
          <span class="card-title">🔄 Flip</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="showBotHistory('trendFlip', '🔄 Flip')" style="padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer;">📜 <span id="trendFlipHistoryCount">0</span></button>
            <span id="trendFlipPositionCount">0</span>
          </div>
        </div>
        <div id="trendFlipPositionTable"><div class="empty-state">No position</div></div>
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
    };

    function toggleSection(sectionId) {
      sectionState[sectionId] = !sectionState[sectionId];
      const content = document.getElementById(sectionId + 'Content');
      const toggle = document.getElementById(sectionId + 'Toggle');
      if (content && toggle) {
        if (sectionState[sectionId]) {
          content.classList.remove('collapsed');
          content.style.maxHeight = content.scrollHeight + 'px';
          toggle.classList.remove('collapsed');
        } else {
          content.classList.add('collapsed');
          toggle.classList.add('collapsed');
        }
      }
    }

    function collapseAllSections() {
      Object.keys(sectionState).forEach(id => {
        sectionState[id] = false;
        const content = document.getElementById(id + 'Content');
        const toggle = document.getElementById(id + 'Toggle');
        if (content && toggle) {
          content.classList.add('collapsed');
          toggle.classList.add('collapsed');
        }
      });
    }

    function expandAllSections() {
      Object.keys(sectionState).forEach(id => {
        sectionState[id] = true;
        const content = document.getElementById(id + 'Content');
        const toggle = document.getElementById(id + 'Toggle');
        if (content && toggle) {
          content.classList.remove('collapsed');
          content.style.maxHeight = content.scrollHeight + 'px';
          toggle.classList.remove('collapsed');
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
    let allSetupsData = { all: [], active: [], playedOut: [], history: [] };

    function setSetupsTab(tab) {
      currentSetupsTab = tab;
      // Update tab button styles
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.style.background = '#21262d';
        btn.style.color = '#8b949e';
      });
      const activeBtn = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (activeBtn) {
        activeBtn.style.background = tab === 'playedOut' ? '#6e7681' : tab === 'history' ? '#8957e5' : '#238636';
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
      } else {
        setups = allSetupsData.all;
      }
      document.getElementById('setupsTable').innerHTML = renderSetupsTable(setups, currentSetupsTab);
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
      };
      document.getElementById('activeCount').textContent = state.setups.active.length;
      document.getElementById('playedOutCount').textContent = state.setups.playedOut.length;
      document.getElementById('historyCount').textContent = (state.setups.history || []).length;
      document.getElementById('allCount').textContent = state.setups.all.length;

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
            if (pnlEl) {
              pnlEl.textContent = formatCurrency(bot.stats.totalPnL);
              pnlEl.className = bot.stats.totalPnL >= 0 ? 'positive' : 'negative';
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

      return '<table><thead><tr><th>Mkt</th><th>Symbol</th><th>Dir</th><th>TF</th><th>State</th><th>RSI</th><th>Div</th><th>Price</th><th>Impulse</th><th>Triggered</th><th>' + lastColHeader + '</th></tr></thead><tbody>' +
        setups.map(s => {
          const stateClass = s.state === 'deep_extreme' ? 'deep' : s.state;
          const rowStyle = tabType === 'history' || s.state === 'played_out' ? 'opacity: 0.7;' : '';
          const impulseColor = s.impulsePercentMove >= 0 ? '#3fb950' : '#f85149';
          const impulseSign = s.impulsePercentMove >= 0 ? '+' : '';
          const rsiColor = s.currentRSI < 30 ? '#f85149' : s.currentRSI > 70 ? '#3fb950' : s.currentRSI < 40 ? '#d29922' : s.currentRSI > 60 ? '#58a6ff' : '#c9d1d9';
          const lastColTime = tabType === 'history' ? formatTimeAgo(s.removedAt) : formatTimeAgo(s.lastUpdated || s.detectedAt);
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
          return \`<tr style="\${rowStyle}">
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

  try {
    await screener.start();
    console.log('✅ Screener started');

    // Periodic orphaned position price updates (every 30 seconds)
    setInterval(async () => {
      await fixedTPBot.updateOrphanedPositions(getCurrentPrice);
      await trailing1pctBot.updateOrphanedPositions(getCurrentPrice);
      await trailing10pct10xBot.updateOrphanedPositions(getCurrentPrice);
      await trailing10pct20xBot.updateOrphanedPositions(getCurrentPrice);
      await trailWideBot.updateOrphanedPositions(getCurrentPrice);
      await confluenceBot.updateOrphanedPositions(getCurrentPrice);
      await tripleLightBot.updateOrphanedPositions(getCurrentPrice);
      await trendOverrideBot.updateOrphanedPositions(getCurrentPrice);
      await trendFlipBot.updateOrphanedPositions(getCurrentPrice, currentBtcBias);
      broadcastState(); // Update clients with new prices
    }, 30000);
  } catch (error) {
    console.error('Failed to start screener:', error);
    process.exit(1);
  }
}

main();
