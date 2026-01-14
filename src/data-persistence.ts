import fs from 'fs';
import path from 'path';
import type { BackburnerSetup, Timeframe } from './types.js';
import type { PaperPosition, TradingStats } from './paper-trading.js';

// Data directory path
const DATA_DIR = path.join(process.cwd(), 'data');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const MARKET_DIR = path.join(DATA_DIR, 'market');
const CONFIGS_DIR = path.join(DATA_DIR, 'configs');
const POSITIONS_DIR = path.join(DATA_DIR, 'positions');
const CRASHES_DIR = path.join(DATA_DIR, 'crashes');
const HOURLY_DIR = path.join(DATA_DIR, 'hourly');

// Ensure directories exist
function ensureDirectories(): void {
  for (const dir of [DATA_DIR, SIGNALS_DIR, TRADES_DIR, DAILY_DIR, MARKET_DIR, CONFIGS_DIR, POSITIONS_DIR, CRASHES_DIR, HOURLY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Get today's date string (YYYY-MM-DD)
function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// Get timestamp string for filenames
function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Signal event types
export type SignalEventType = 'new' | 'updated' | 'triggered' | 'deep_extreme' | 'played_out' | 'removed' | 'expired';

// Logged signal event
export interface SignalEvent {
  timestamp: string;
  eventType: SignalEventType;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: Timeframe;
  marketType: 'spot' | 'futures';
  state: string;
  rsi: number;
  price: number;
  entryPrice?: number;
  impulsePercent: number;
  marketCap?: number;
  qualityTier?: string;
  coinName?: string;
}

// Trade event (open or close)
export interface TradeEvent {
  timestamp: string;
  eventType: 'open' | 'close';
  botId: string;
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: 'spot' | 'futures';

  // Entry info
  entryPrice: number;
  entryTime: string;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  takeProfitPrice: number;
  stopLossPrice: number;

  // Exit info (if close event)
  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  durationMs?: number;

  // Signal info at entry
  signalRsi?: number;
  signalState?: string;
  impulsePercent?: number;
}

// Market conditions snapshot (logged periodically)
export interface MarketSnapshot {
  timestamp: string;
  btcPrice: number;
  btcRsi: {
    rsi4h: number;
    rsi1h: number;
    rsi15m: number;
    rsi5m: number;
    rsi1m: number;
  };
  marketBias: string;      // 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short'
  biasScore: number;       // -100 to +100
  activeSetups: {
    total: number;
    triggered: number;
    deepExtreme: number;
    byDirection: { long: number; short: number };
  };
}

// Bot configuration snapshot
export interface BotConfigSnapshot {
  botId: string;
  botName: string;
  config: Record<string, unknown>;
  snapshotTime: string;
}

// Generic trade event for any bot type (including BTC Bias bots)
export interface GenericTradeEvent {
  timestamp: string;
  eventType: 'open' | 'close' | 'update';
  botId: string;
  botType: string;  // 'paper' | 'trailing' | 'btc_bias' | 'golden_pocket' etc.
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';

  // Entry info
  entryPrice: number;
  entryTime: string;
  marginUsed: number;
  notionalSize: number;
  leverage: number;

  // Current state (for updates)
  currentPrice?: number;
  unrealizedPnL?: number;
  unrealizedROI?: number;
  highestPrice?: number;
  lowestPrice?: number;
  currentStopPrice?: number;

  // Exit info (if close event)
  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;
  realizedPnL?: number;
  realizedROI?: number;
  durationMs?: number;
  totalCosts?: number;

  // Additional context
  entryBias?: string;
  metadata?: Record<string, unknown>;
}

// Hourly snapshot of all bot states
export interface HourlySnapshot {
  timestamp: string;
  hour: string;  // YYYY-MM-DD-HH format

  // BTC market state
  btcPrice: number;
  btcBias: string;
  btcRsi: Record<string, number>;

  // Bot summaries (balance + open positions)
  bots: Record<string, {
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
  }>;

  // Active setups summary
  activeSetups: {
    total: number;
    triggered: number;
    deepExtreme: number;
  };
}

// Daily summary structure
export interface DailySummary {
  date: string;
  generatedAt: string;

  // Signal stats
  signals: {
    total: number;
    byDirection: { long: number; short: number };
    byTimeframe: Record<string, number>;
    byState: Record<string, number>;
    byQualityTier: Record<string, number>;
    uniqueSymbols: number;
  };

  // Trade stats per bot
  bots: Record<string, {
    botId: string;
    config: Record<string, unknown>;
    trades: {
      total: number;
      wins: number;
      losses: number;
      winRate: number;
      totalPnL: number;
      totalPnLPercent: number;
      avgWin: number;
      avgLoss: number;
      profitFactor: number;
      avgDurationMs: number;
      byExitReason: Record<string, number>;
      byDirection: { long: { pnl: number; count: number }; short: { pnl: number; count: number } };
      byTimeframe: Record<string, { pnl: number; count: number }>;
    };
    balance: number;
    peakBalance: number;
    drawdown: number;
    drawdownPercent: number;
  }>;

  // Aggregate stats
  aggregate: {
    totalPnL: number;
    totalTrades: number;
    winRate: number;
  };

  // Market conditions summary
  marketConditions?: {
    btcPriceRange: { high: number; low: number; open: number; close: number };
    biasDistribution: Record<string, number>;  // Time spent in each bias state
    avgBiasScore: number;
    volatilityEstimate: number;  // Based on price range
    dominantBias: string;
  };
}

/**
 * Data Persistence Manager
 * Handles logging signals, trades, and generating daily summaries
 */
export class DataPersistence {
  private signalEvents: SignalEvent[] = [];
  private tradeEvents: TradeEvent[] = [];
  private genericTradeEvents: GenericTradeEvent[] = [];
  private marketSnapshots: MarketSnapshot[] = [];
  private botConfigs: BotConfigSnapshot[] = [];
  private currentDate: string;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private hourlyInterval: ReturnType<typeof setInterval> | null = null;
  private lastMarketSnapshotTime: number = 0;
  private marketSnapshotIntervalMs: number = 60000; // Log every 60 seconds
  private lastHourlySnapshotHour: string = '';
  private hourlySnapshotCallback: (() => HourlySnapshot | null) | null = null;

  constructor() {
    ensureDirectories();
    this.currentDate = getDateString();
    this.loadTodaysData();

    // Flush to disk every 30 seconds
    this.flushInterval = setInterval(() => this.flush(), 30000);

    // Check for hourly snapshots every minute
    this.hourlyInterval = setInterval(() => this.checkHourlySnapshot(), 60000);
  }

  /**
   * Register callback to collect hourly snapshot data
   * This should be called by web-server to provide bot state data
   */
  registerHourlySnapshotCallback(callback: () => HourlySnapshot | null): void {
    this.hourlySnapshotCallback = callback;
  }

  /**
   * Load today's existing data (if restarting mid-day)
   */
  private loadTodaysData(): void {
    const signalFile = path.join(SIGNALS_DIR, `${this.currentDate}.json`);
    const tradeFile = path.join(TRADES_DIR, `${this.currentDate}.json`);
    const marketFile = path.join(MARKET_DIR, `${this.currentDate}.json`);
    const configFile = path.join(CONFIGS_DIR, `${this.currentDate}.json`);
    const allTradesFile = path.join(TRADES_DIR, `${this.currentDate}-all.json`);

    if (fs.existsSync(signalFile)) {
      try {
        this.signalEvents = JSON.parse(fs.readFileSync(signalFile, 'utf-8'));
      } catch {
        this.signalEvents = [];
      }
    }

    if (fs.existsSync(tradeFile)) {
      try {
        this.tradeEvents = JSON.parse(fs.readFileSync(tradeFile, 'utf-8'));
      } catch {
        this.tradeEvents = [];
      }
    }

    if (fs.existsSync(marketFile)) {
      try {
        this.marketSnapshots = JSON.parse(fs.readFileSync(marketFile, 'utf-8'));
      } catch {
        this.marketSnapshots = [];
      }
    }

    if (fs.existsSync(configFile)) {
      try {
        this.botConfigs = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      } catch {
        this.botConfigs = [];
      }
    }

    if (fs.existsSync(allTradesFile)) {
      try {
        this.genericTradeEvents = JSON.parse(fs.readFileSync(allTradesFile, 'utf-8'));
      } catch {
        this.genericTradeEvents = [];
      }
    }
  }

  /**
   * Check if date has changed and roll over files
   */
  private checkDateRollover(): void {
    const today = getDateString();
    if (today !== this.currentDate) {
      // Generate end-of-day summary for previous day
      this.generateDailySummary(this.currentDate);

      // Roll over to new day
      this.flush();
      this.currentDate = today;
      this.signalEvents = [];
      this.tradeEvents = [];
      this.genericTradeEvents = [];
      this.marketSnapshots = [];
      this.botConfigs = [];
    }
  }

  /**
   * Log a signal event
   */
  logSignal(setup: BackburnerSetup, eventType: SignalEventType): void {
    this.checkDateRollover();

    const event: SignalEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
      marketType: setup.marketType,
      state: setup.state,
      rsi: setup.currentRSI,
      price: setup.currentPrice,
      entryPrice: setup.entryPrice,
      impulsePercent: setup.impulsePercentMove,
      marketCap: setup.marketCap,
      qualityTier: setup.qualityTier,
      coinName: setup.coinName,
    };

    this.signalEvents.push(event);
  }

  /**
   * Log a trade open event
   */
  logTradeOpen(
    botId: string,
    position: PaperPosition,
    setup: BackburnerSetup
  ): void {
    this.checkDateRollover();

    const event: TradeEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'open',
      botId,
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      timeframe: position.timeframe,
      marketType: position.marketType,
      entryPrice: position.entryPrice,
      entryTime: new Date(position.entryTime).toISOString(),
      marginUsed: position.marginUsed,
      notionalSize: position.notionalSize,
      leverage: position.leverage,
      takeProfitPrice: position.takeProfitPrice,
      stopLossPrice: position.stopLossPrice,
      signalRsi: setup.currentRSI,
      signalState: setup.state,
      impulsePercent: setup.impulsePercentMove,
    };

    this.tradeEvents.push(event);
  }

  /**
   * Log a trade close event
   */
  logTradeClose(botId: string, position: PaperPosition): void {
    this.checkDateRollover();

    const event: TradeEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'close',
      botId,
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      timeframe: position.timeframe,
      marketType: position.marketType,
      entryPrice: position.entryPrice,
      entryTime: new Date(position.entryTime).toISOString(),
      marginUsed: position.marginUsed,
      notionalSize: position.notionalSize,
      leverage: position.leverage,
      takeProfitPrice: position.takeProfitPrice,
      stopLossPrice: position.stopLossPrice,
      exitPrice: position.exitPrice,
      exitTime: position.exitTime ? new Date(position.exitTime).toISOString() : undefined,
      exitReason: position.exitReason,
      realizedPnL: position.realizedPnL,
      realizedPnLPercent: position.realizedPnLPercent,
      durationMs: position.exitTime ? position.exitTime - position.entryTime : undefined,
    };

    this.tradeEvents.push(event);
  }

  /**
   * Log a market snapshot (rate-limited to once per interval)
   */
  logMarketSnapshot(snapshot: Omit<MarketSnapshot, 'timestamp'>): void {
    const now = Date.now();
    if (now - this.lastMarketSnapshotTime < this.marketSnapshotIntervalMs) {
      return; // Rate limit
    }

    this.checkDateRollover();
    this.lastMarketSnapshotTime = now;

    const fullSnapshot: MarketSnapshot = {
      timestamp: new Date().toISOString(),
      ...snapshot,
    };

    this.marketSnapshots.push(fullSnapshot);
  }

  /**
   * Log bot configuration (once per day per bot, or on change)
   */
  logBotConfig(botId: string, botName: string, config: Record<string, unknown>): void {
    this.checkDateRollover();

    // Check if we already have this bot's config for today
    const existing = this.botConfigs.find(c => c.botId === botId);
    if (existing) {
      // Check if config changed
      if (JSON.stringify(existing.config) === JSON.stringify(config)) {
        return; // No change
      }
    }

    const snapshot: BotConfigSnapshot = {
      botId,
      botName,
      config,
      snapshotTime: new Date().toISOString(),
    };

    // Replace existing or add new
    const index = this.botConfigs.findIndex(c => c.botId === botId);
    if (index >= 0) {
      this.botConfigs[index] = snapshot;
    } else {
      this.botConfigs.push(snapshot);
    }
  }

  /**
   * Log a generic trade event (works for any bot type)
   * This is the preferred method for new bots like BTC Bias
   */
  logGenericTrade(event: Omit<GenericTradeEvent, 'timestamp'>): void {
    this.checkDateRollover();

    const fullEvent: GenericTradeEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.genericTradeEvents.push(fullEvent);
  }

  /**
   * Check if we should take an hourly snapshot
   */
  private checkHourlySnapshot(): void {
    const now = new Date();
    const hourKey = `${getDateString(now)}-${now.getHours().toString().padStart(2, '0')}`;

    if (hourKey === this.lastHourlySnapshotHour) {
      return; // Already captured this hour
    }

    // Take the snapshot
    if (this.hourlySnapshotCallback) {
      const snapshot = this.hourlySnapshotCallback();
      if (snapshot) {
        this.saveHourlySnapshot(snapshot);
        this.lastHourlySnapshotHour = hourKey;
      }
    }
  }

  /**
   * Save hourly snapshot to disk
   */
  private saveHourlySnapshot(snapshot: HourlySnapshot): void {
    const date = getDateString();
    const hourlyFile = path.join(HOURLY_DIR, `${date}.json`);

    // Load existing hourly data for today
    let hourlyData: HourlySnapshot[] = [];
    if (fs.existsSync(hourlyFile)) {
      try {
        hourlyData = JSON.parse(fs.readFileSync(hourlyFile, 'utf-8'));
      } catch {
        hourlyData = [];
      }
    }

    hourlyData.push(snapshot);
    fs.writeFileSync(hourlyFile, JSON.stringify(hourlyData, null, 2));
  }

  /**
   * Flush data to disk
   */
  flush(): void {
    const signalFile = path.join(SIGNALS_DIR, `${this.currentDate}.json`);
    const tradeFile = path.join(TRADES_DIR, `${this.currentDate}.json`);
    const marketFile = path.join(MARKET_DIR, `${this.currentDate}.json`);
    const configFile = path.join(CONFIGS_DIR, `${this.currentDate}.json`);

    // Merge generic trade events into trade events file for backwards compatibility
    // We'll also keep a separate comprehensive log
    const allTradesFile = path.join(TRADES_DIR, `${this.currentDate}-all.json`);

    fs.writeFileSync(signalFile, JSON.stringify(this.signalEvents, null, 2));
    fs.writeFileSync(tradeFile, JSON.stringify(this.tradeEvents, null, 2));
    fs.writeFileSync(marketFile, JSON.stringify(this.marketSnapshots, null, 2));
    fs.writeFileSync(configFile, JSON.stringify(this.botConfigs, null, 2));

    // Write comprehensive trades log (includes both legacy and generic events)
    if (this.genericTradeEvents.length > 0) {
      fs.writeFileSync(allTradesFile, JSON.stringify(this.genericTradeEvents, null, 2));
    }
  }

  /**
   * Generate daily summary for a specific date
   */
  generateDailySummary(
    date: string = this.currentDate,
    botConfigs?: Record<string, Record<string, unknown>>,
    botStats?: Record<string, TradingStats>
  ): DailySummary {
    // Load data for the specified date
    const signalFile = path.join(SIGNALS_DIR, `${date}.json`);
    const tradeFile = path.join(TRADES_DIR, `${date}.json`);
    const marketFile = path.join(MARKET_DIR, `${date}.json`);

    let signals: SignalEvent[] = [];
    let trades: TradeEvent[] = [];
    let marketSnapshots: MarketSnapshot[] = [];

    if (fs.existsSync(signalFile)) {
      try {
        signals = JSON.parse(fs.readFileSync(signalFile, 'utf-8'));
      } catch { /* empty */ }
    }

    if (fs.existsSync(tradeFile)) {
      try {
        trades = JSON.parse(fs.readFileSync(tradeFile, 'utf-8'));
      } catch { /* empty */ }
    }

    if (fs.existsSync(marketFile)) {
      try {
        marketSnapshots = JSON.parse(fs.readFileSync(marketFile, 'utf-8'));
      } catch { /* empty */ }
    }

    // Calculate signal stats
    const uniqueSymbols = new Set(signals.map(s => s.symbol));
    const signalStats = {
      total: signals.length,
      byDirection: {
        long: signals.filter(s => s.direction === 'long').length,
        short: signals.filter(s => s.direction === 'short').length,
      },
      byTimeframe: {} as Record<string, number>,
      byState: {} as Record<string, number>,
      byQualityTier: {} as Record<string, number>,
      uniqueSymbols: uniqueSymbols.size,
    };

    for (const signal of signals) {
      signalStats.byTimeframe[signal.timeframe] = (signalStats.byTimeframe[signal.timeframe] || 0) + 1;
      signalStats.byState[signal.state] = (signalStats.byState[signal.state] || 0) + 1;
      if (signal.qualityTier) {
        signalStats.byQualityTier[signal.qualityTier] = (signalStats.byQualityTier[signal.qualityTier] || 0) + 1;
      }
    }

    // Calculate trade stats per bot
    const closeTrades = trades.filter(t => t.eventType === 'close');
    const botIds = [...new Set(closeTrades.map(t => t.botId))];

    const bots: DailySummary['bots'] = {};

    for (const botId of botIds) {
      const botTrades = closeTrades.filter(t => t.botId === botId);
      const wins = botTrades.filter(t => (t.realizedPnL || 0) > 0);
      const losses = botTrades.filter(t => (t.realizedPnL || 0) < 0);

      const totalWins = wins.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
      const totalLosses = Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));
      const totalPnL = botTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
      const avgDuration = botTrades.reduce((sum, t) => sum + (t.durationMs || 0), 0) / (botTrades.length || 1);

      // By exit reason
      const byExitReason: Record<string, number> = {};
      for (const t of botTrades) {
        if (t.exitReason) {
          byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1;
        }
      }

      // By direction
      const longTrades = botTrades.filter(t => t.direction === 'long');
      const shortTrades = botTrades.filter(t => t.direction === 'short');

      // By timeframe
      const byTimeframe: Record<string, { pnl: number; count: number }> = {};
      for (const t of botTrades) {
        if (!byTimeframe[t.timeframe]) {
          byTimeframe[t.timeframe] = { pnl: 0, count: 0 };
        }
        byTimeframe[t.timeframe].pnl += t.realizedPnL || 0;
        byTimeframe[t.timeframe].count += 1;
      }

      bots[botId] = {
        botId,
        config: botConfigs?.[botId] || {},
        trades: {
          total: botTrades.length,
          wins: wins.length,
          losses: losses.length,
          winRate: botTrades.length > 0 ? (wins.length / botTrades.length) * 100 : 0,
          totalPnL,
          totalPnLPercent: 0, // Will be updated from bot stats
          avgWin: wins.length > 0 ? totalWins / wins.length : 0,
          avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
          profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
          avgDurationMs: avgDuration,
          byExitReason,
          byDirection: {
            long: {
              pnl: longTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0),
              count: longTrades.length,
            },
            short: {
              pnl: shortTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0),
              count: shortTrades.length,
            },
          },
          byTimeframe,
        },
        balance: botStats?.[botId]?.currentBalance || 0,
        peakBalance: botStats?.[botId]?.peakBalance || 0,
        drawdown: botStats?.[botId]?.maxDrawdown || 0,
        drawdownPercent: botStats?.[botId]?.maxDrawdownPercent || 0,
      };
    }

    // Aggregate
    const aggregate = {
      totalPnL: Object.values(bots).reduce((sum, b) => sum + b.trades.totalPnL, 0),
      totalTrades: Object.values(bots).reduce((sum, b) => sum + b.trades.total, 0),
      winRate: 0 as number,
    };

    const totalWins = Object.values(bots).reduce((sum, b) => sum + b.trades.wins, 0);
    aggregate.winRate = aggregate.totalTrades > 0 ? (totalWins / aggregate.totalTrades) * 100 : 0;

    // Calculate market conditions from snapshots
    let marketConditions: DailySummary['marketConditions'] = undefined;
    if (marketSnapshots.length > 0) {
      const prices = marketSnapshots.map(s => s.btcPrice);
      const biasScores = marketSnapshots.map(s => s.biasScore);

      // Calculate bias distribution (time spent in each state)
      const biasDistribution: Record<string, number> = {};
      for (const snap of marketSnapshots) {
        biasDistribution[snap.marketBias] = (biasDistribution[snap.marketBias] || 0) + 1;
      }

      // Find dominant bias
      let dominantBias = 'neutral';
      let maxCount = 0;
      for (const [bias, count] of Object.entries(biasDistribution)) {
        if (count > maxCount) {
          maxCount = count;
          dominantBias = bias;
        }
      }

      const priceHigh = Math.max(...prices);
      const priceLow = Math.min(...prices);
      const priceRange = priceHigh - priceLow;
      const midPrice = (priceHigh + priceLow) / 2;

      marketConditions = {
        btcPriceRange: {
          high: priceHigh,
          low: priceLow,
          open: prices[0],
          close: prices[prices.length - 1],
        },
        biasDistribution,
        avgBiasScore: biasScores.reduce((a, b) => a + b, 0) / biasScores.length,
        volatilityEstimate: midPrice > 0 ? (priceRange / midPrice) * 100 : 0,
        dominantBias,
      };
    }

    const summary: DailySummary = {
      date,
      generatedAt: new Date().toISOString(),
      signals: signalStats,
      bots,
      aggregate,
      marketConditions,
    };

    // Save summary
    const summaryFile = path.join(DAILY_DIR, `${date}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

    return summary;
  }

  /**
   * Get today's signals
   */
  getTodaysSignals(): SignalEvent[] {
    return [...this.signalEvents];
  }

  /**
   * Get today's trades
   */
  getTodaysTrades(): TradeEvent[] {
    return [...this.tradeEvents];
  }

  /**
   * Load signals for a specific date
   */
  loadSignals(date: string): SignalEvent[] {
    const file = path.join(SIGNALS_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Load trades for a specific date
   */
  loadTrades(date: string): TradeEvent[] {
    const file = path.join(TRADES_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Load daily summary
   */
  loadDailySummary(date: string): DailySummary | null {
    const file = path.join(DAILY_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Load market snapshots for a specific date
   */
  loadMarketSnapshots(date: string): MarketSnapshot[] {
    const file = path.join(MARKET_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Load bot configs for a specific date
   */
  loadBotConfigs(date: string): BotConfigSnapshot[] {
    const file = path.join(CONFIGS_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Get today's market snapshots
   */
  getTodaysMarketSnapshots(): MarketSnapshot[] {
    return [...this.marketSnapshots];
  }

  /**
   * Get today's bot configs
   */
  getTodaysBotConfigs(): BotConfigSnapshot[] {
    return [...this.botConfigs];
  }

  /**
   * List available dates with data
   */
  listAvailableDates(): string[] {
    const dates = new Set<string>();

    if (fs.existsSync(SIGNALS_DIR)) {
      for (const file of fs.readdirSync(SIGNALS_DIR)) {
        if (file.endsWith('.json')) {
          dates.add(file.replace('.json', ''));
        }
      }
    }

    if (fs.existsSync(TRADES_DIR)) {
      for (const file of fs.readdirSync(TRADES_DIR)) {
        if (file.endsWith('.json')) {
          dates.add(file.replace('.json', ''));
        }
      }
    }

    return [...dates].sort().reverse();
  }

  /**
   * Generate an LLM-friendly analysis prompt for a given date
   * This creates a comprehensive data package for querying insights
   */
  generateAnalysisPrompt(date: string): string {
    const summary = this.loadDailySummary(date);
    const signals = this.loadSignals(date);
    const trades = this.loadTrades(date);
    const market = this.loadMarketSnapshots(date);
    const configs = this.loadBotConfigs(date);

    if (!summary && signals.length === 0 && trades.length === 0) {
      return `No data available for ${date}`;
    }

    let prompt = `# Trading System Analysis for ${date}\n\n`;

    // Market conditions
    if (summary?.marketConditions) {
      const mc = summary.marketConditions;
      prompt += `## Market Conditions\n`;
      prompt += `- BTC Price Range: $${mc.btcPriceRange.low.toFixed(0)} - $${mc.btcPriceRange.high.toFixed(0)}\n`;
      prompt += `- BTC Open/Close: $${mc.btcPriceRange.open.toFixed(0)} → $${mc.btcPriceRange.close.toFixed(0)}\n`;
      prompt += `- Volatility: ${mc.volatilityEstimate.toFixed(2)}%\n`;
      prompt += `- Dominant Bias: ${mc.dominantBias}\n`;
      prompt += `- Average Bias Score: ${mc.avgBiasScore.toFixed(1)}\n`;
      prompt += `- Bias Distribution: ${JSON.stringify(mc.biasDistribution)}\n\n`;
    }

    // Signal summary
    if (summary?.signals) {
      const s = summary.signals;
      prompt += `## Signal Summary\n`;
      prompt += `- Total signals: ${s.total}\n`;
      prompt += `- Direction: Long=${s.byDirection.long}, Short=${s.byDirection.short}\n`;
      prompt += `- By timeframe: ${JSON.stringify(s.byTimeframe)}\n`;
      prompt += `- By state: ${JSON.stringify(s.byState)}\n`;
      prompt += `- Unique symbols: ${s.uniqueSymbols}\n\n`;
    }

    // Bot performance
    if (summary?.bots && Object.keys(summary.bots).length > 0) {
      prompt += `## Bot Performance\n`;
      for (const [botId, bot] of Object.entries(summary.bots)) {
        prompt += `\n### ${botId}\n`;
        prompt += `- Trades: ${bot.trades.total} (Wins: ${bot.trades.wins}, Losses: ${bot.trades.losses})\n`;
        prompt += `- Win Rate: ${bot.trades.winRate.toFixed(1)}%\n`;
        prompt += `- Total P&L: $${bot.trades.totalPnL.toFixed(2)}\n`;
        prompt += `- Avg Win: $${bot.trades.avgWin.toFixed(2)}, Avg Loss: $${bot.trades.avgLoss.toFixed(2)}\n`;
        prompt += `- Profit Factor: ${bot.trades.profitFactor === Infinity ? '∞' : bot.trades.profitFactor.toFixed(2)}\n`;
        prompt += `- By Direction: Long P&L=$${bot.trades.byDirection.long.pnl.toFixed(2)} (${bot.trades.byDirection.long.count}), Short P&L=$${bot.trades.byDirection.short.pnl.toFixed(2)} (${bot.trades.byDirection.short.count})\n`;
        prompt += `- Exit Reasons: ${JSON.stringify(bot.trades.byExitReason)}\n`;
      }
      prompt += `\n`;
    }

    // Aggregate
    if (summary?.aggregate) {
      prompt += `## Aggregate Results\n`;
      prompt += `- Total Trades: ${summary.aggregate.totalTrades}\n`;
      prompt += `- Total P&L: $${summary.aggregate.totalPnL.toFixed(2)}\n`;
      prompt += `- Overall Win Rate: ${summary.aggregate.winRate.toFixed(1)}%\n\n`;
    }

    // Bot configs
    if (configs.length > 0) {
      prompt += `## Bot Configurations\n`;
      for (const cfg of configs) {
        prompt += `- ${cfg.botId} (${cfg.botName}): ${JSON.stringify(cfg.config)}\n`;
      }
      prompt += `\n`;
    }

    // Trade details (sample of closed trades)
    const closedTrades = trades.filter(t => t.eventType === 'close');
    if (closedTrades.length > 0) {
      prompt += `## Sample Closed Trades (last 20)\n`;
      const sample = closedTrades.slice(-20);
      for (const t of sample) {
        const pnlSign = (t.realizedPnL || 0) >= 0 ? '+' : '';
        prompt += `- ${t.botId} | ${t.symbol} ${t.direction.toUpperCase()} ${t.timeframe} | ${pnlSign}$${(t.realizedPnL || 0).toFixed(2)} | ${t.exitReason}\n`;
      }
      prompt += `\n`;
    }

    prompt += `## Analysis Request\n`;
    prompt += `Based on the data above, please analyze:\n`;
    prompt += `1. What patterns led to winning vs losing trades?\n`;
    prompt += `2. Which bot configurations performed best and why?\n`;
    prompt += `3. How did market conditions (bias, volatility) affect results?\n`;
    prompt += `4. What parameter adjustments would you recommend?\n`;
    prompt += `5. Are there any concerning patterns or anomalies?\n`;

    return prompt;
  }

  /**
   * Save bot positions to disk (for persistence across restarts)
   */
  savePositions(botId: string, positions: unknown[], closedPositions: unknown[], balance: number, peakBalance: number): void {
    const positionFile = path.join(POSITIONS_DIR, `${botId}.json`);
    const data = {
      botId,
      savedAt: new Date().toISOString(),
      balance,
      peakBalance,
      openPositions: positions,
      closedPositions: closedPositions.slice(-100), // Keep last 100 closed positions
    };
    try {
      fs.writeFileSync(positionFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`Failed to save positions for ${botId}:`, e);
    }
  }

  /**
   * Load bot positions from disk
   */
  loadPositions(botId: string): {
    openPositions: unknown[];
    closedPositions: unknown[];
    balance: number;
    peakBalance: number;
    savedAt: string;
  } | null {
    const positionFile = path.join(POSITIONS_DIR, `${botId}.json`);
    if (!fs.existsSync(positionFile)) {
      return null;
    }
    try {
      const data = JSON.parse(fs.readFileSync(positionFile, 'utf-8'));
      console.log(`Loaded ${data.openPositions?.length || 0} open positions for ${botId} (saved at ${data.savedAt})`);
      return {
        openPositions: data.openPositions || [],
        closedPositions: data.closedPositions || [],
        balance: data.balance,
        peakBalance: data.peakBalance,
        savedAt: data.savedAt,
      };
    } catch (e) {
      console.error(`Failed to load positions for ${botId}:`, e);
      return null;
    }
  }

  /**
   * Log a crash event with full details
   */
  logCrash(error: Error, context?: Record<string, unknown>): void {
    const timestamp = getTimestamp();
    const crashFile = path.join(CRASHES_DIR, `crash-${timestamp}.json`);
    const data = {
      timestamp: new Date().toISOString(),
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      context: context || {},
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    };
    try {
      fs.writeFileSync(crashFile, JSON.stringify(data, null, 2));
      console.error(`Crash logged to ${crashFile}`);
    } catch (e) {
      console.error('Failed to log crash:', e);
    }
  }

  /**
   * Get all crash logs
   */
  getCrashLogs(): Array<{ file: string; data: unknown }> {
    try {
      const files = fs.readdirSync(CRASHES_DIR).filter(f => f.endsWith('.json'));
      return files.map(file => ({
        file,
        data: JSON.parse(fs.readFileSync(path.join(CRASHES_DIR, file), 'utf-8')),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Stop the persistence manager
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.hourlyInterval) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = null;
    }
    this.flush();
  }

  /**
   * Get today's generic trade events
   */
  getTodaysGenericTrades(): GenericTradeEvent[] {
    return [...this.genericTradeEvents];
  }

  /**
   * Load hourly snapshots for a specific date
   */
  loadHourlySnapshots(date: string): HourlySnapshot[] {
    const file = path.join(HOURLY_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }
}

// Singleton instance
let persistenceInstance: DataPersistence | null = null;

export function getDataPersistence(): DataPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new DataPersistence();
  }
  return persistenceInstance;
}

/**
 * Data compression utilities
 * Compresses old market snapshot data to hourly averages to save disk space
 */
export function compressMarketData(date: string): { original: number; compressed: number } | null {
  const marketFile = path.join(MARKET_DIR, `${date}.json`);
  const compressedFile = path.join(MARKET_DIR, `${date}-compressed.json`);

  if (!fs.existsSync(marketFile)) {
    return null;
  }

  try {
    const snapshots: MarketSnapshot[] = JSON.parse(fs.readFileSync(marketFile, 'utf-8'));
    const originalSize = snapshots.length;

    if (originalSize === 0) return null;

    // Group by hour
    const hourlyGroups: Record<string, MarketSnapshot[]> = {};
    for (const snap of snapshots) {
      const hour = snap.timestamp.slice(0, 13); // YYYY-MM-DDTHH
      if (!hourlyGroups[hour]) hourlyGroups[hour] = [];
      hourlyGroups[hour].push(snap);
    }

    // Create hourly averages
    const compressed: MarketSnapshot[] = [];
    for (const [hour, snaps] of Object.entries(hourlyGroups)) {
      if (snaps.length === 0) continue;

      const avgSnapshot: MarketSnapshot = {
        timestamp: `${hour}:00:00.000Z`,
        btcPrice: snaps.reduce((sum, s) => sum + s.btcPrice, 0) / snaps.length,
        btcRsi: {
          rsi4h: snaps.reduce((sum, s) => sum + s.btcRsi.rsi4h, 0) / snaps.length,
          rsi1h: snaps.reduce((sum, s) => sum + s.btcRsi.rsi1h, 0) / snaps.length,
          rsi15m: snaps.reduce((sum, s) => sum + s.btcRsi.rsi15m, 0) / snaps.length,
          rsi5m: snaps.reduce((sum, s) => sum + s.btcRsi.rsi5m, 0) / snaps.length,
          rsi1m: snaps.reduce((sum, s) => sum + s.btcRsi.rsi1m, 0) / snaps.length,
        },
        // Most common bias in the hour
        marketBias: getMostCommon(snaps.map(s => s.marketBias)),
        biasScore: snaps.reduce((sum, s) => sum + s.biasScore, 0) / snaps.length,
        activeSetups: {
          total: Math.round(snaps.reduce((sum, s) => sum + s.activeSetups.total, 0) / snaps.length),
          triggered: Math.round(snaps.reduce((sum, s) => sum + s.activeSetups.triggered, 0) / snaps.length),
          deepExtreme: Math.round(snaps.reduce((sum, s) => sum + s.activeSetups.deepExtreme, 0) / snaps.length),
          byDirection: {
            long: Math.round(snaps.reduce((sum, s) => sum + s.activeSetups.byDirection.long, 0) / snaps.length),
            short: Math.round(snaps.reduce((sum, s) => sum + s.activeSetups.byDirection.short, 0) / snaps.length),
          },
        },
      };
      compressed.push(avgSnapshot);
    }

    // Sort by timestamp
    compressed.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Write compressed file
    fs.writeFileSync(compressedFile, JSON.stringify(compressed, null, 2));

    // Rename original to backup and compressed to main
    const backupFile = path.join(MARKET_DIR, `${date}-full.json`);
    fs.renameSync(marketFile, backupFile);
    fs.renameSync(compressedFile, marketFile);

    console.log(`[DATA] Compressed market data for ${date}: ${originalSize} -> ${compressed.length} snapshots`);
    return { original: originalSize, compressed: compressed.length };
  } catch (e) {
    console.error(`[DATA] Failed to compress market data for ${date}:`, e);
    return null;
  }
}

function getMostCommon<T>(arr: T[]): T {
  const counts = new Map<T, number>();
  let maxCount = 0;
  let mostCommon = arr[0];
  for (const item of arr) {
    const count = (counts.get(item) || 0) + 1;
    counts.set(item, count);
    if (count > maxCount) {
      maxCount = count;
      mostCommon = item;
    }
  }
  return mostCommon;
}

/**
 * Cleanup utility to compress all market data older than N days
 */
export function compressOldMarketData(daysToKeep = 7): void {
  const today = new Date();

  if (!fs.existsSync(MARKET_DIR)) return;

  const files = fs.readdirSync(MARKET_DIR).filter(f =>
    f.endsWith('.json') && !f.includes('-full') && !f.includes('-compressed')
  );

  for (const file of files) {
    const dateStr = file.replace('.json', '');
    const fileDate = new Date(dateStr);
    const daysDiff = Math.floor((today.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff > daysToKeep) {
      compressMarketData(dateStr);
    }
  }
}

/**
 * Get data storage statistics
 */
export function getDataStats(): {
  totalFiles: number;
  totalSizeKB: number;
  byCategory: Record<string, { files: number; sizeKB: number }>;
} {
  const stats = {
    totalFiles: 0,
    totalSizeKB: 0,
    byCategory: {} as Record<string, { files: number; sizeKB: number }>,
  };

  const dirs = [
    { name: 'signals', path: SIGNALS_DIR },
    { name: 'trades', path: TRADES_DIR },
    { name: 'market', path: MARKET_DIR },
    { name: 'configs', path: CONFIGS_DIR },
    { name: 'daily', path: DAILY_DIR },
    { name: 'hourly', path: HOURLY_DIR },
    { name: 'positions', path: POSITIONS_DIR },
    { name: 'crashes', path: CRASHES_DIR },
  ];

  for (const dir of dirs) {
    stats.byCategory[dir.name] = { files: 0, sizeKB: 0 };

    if (!fs.existsSync(dir.path)) continue;

    const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir.path, file);
      const fileStats = fs.statSync(filePath);
      const sizeKB = fileStats.size / 1024;

      stats.totalFiles++;
      stats.totalSizeKB += sizeKB;
      stats.byCategory[dir.name].files++;
      stats.byCategory[dir.name].sizeKB += sizeKB;
    }
  }

  return stats;
}
