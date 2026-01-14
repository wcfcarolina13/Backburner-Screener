import { PaperTradingEngine, type PaperTradingConfig, type PaperPosition } from './paper-trading.js';
import { getDataPersistence } from './data-persistence.js';
import type { BackburnerSetup, Timeframe, QualityTier } from './types.js';

/**
 * Bot filter configuration - determines which setups a bot will trade
 */
export interface BotFilterConfig {
  // Direction filter
  directions?: ('long' | 'short')[];  // Default: both

  // Timeframe filter
  timeframes?: Timeframe[];           // Default: all

  // Market type filter
  marketTypes?: ('spot' | 'futures')[]; // Default: both

  // Quality tier filter
  qualityTiers?: QualityTier[];       // Default: all

  // RSI filter (trade only if RSI is within range)
  minRsi?: number;                    // Default: 0
  maxRsi?: number;                    // Default: 100

  // Impulse filter
  minImpulsePercent?: number;         // Default: 0

  // State filter (which states to trade)
  states?: ('triggered' | 'deep_extreme')[]; // Default: both
}

/**
 * Full bot configuration
 */
export interface BotConfig {
  id: string;
  name: string;
  enabled: boolean;

  // Paper trading config
  trading: Partial<PaperTradingConfig>;

  // Filters
  filters: BotFilterConfig;
}

/**
 * Default bot configurations for comparison
 */
export const DEFAULT_BOTS: BotConfig[] = [
  {
    id: 'default',
    name: 'Default Bot',
    enabled: true,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1,
      leverage: 10,
      takeProfitPercent: 20,
      stopLossPercent: 20,
      maxOpenPositions: 10,
    },
    filters: {
      directions: ['long', 'short'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'long-only',
    name: 'Long Only',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1,
      leverage: 10,
      takeProfitPercent: 20,
      stopLossPercent: 20,
      maxOpenPositions: 5,
    },
    filters: {
      directions: ['long'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'short-only',
    name: 'Short Only',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1,
      leverage: 10,
      takeProfitPercent: 20,
      stopLossPercent: 20,
      maxOpenPositions: 5,
    },
    filters: {
      directions: ['short'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'bluechip',
    name: 'Bluechip Only',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 2,  // Higher size for quality
      leverage: 10,
      takeProfitPercent: 15,   // Tighter TP
      stopLossPercent: 10,     // Tighter SL
      maxOpenPositions: 5,
    },
    filters: {
      qualityTiers: ['bluechip'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'deep-only',
    name: 'Deep Extreme Only',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1.5,
      leverage: 10,
      takeProfitPercent: 25,   // Wider TP for deep extremes
      stopLossPercent: 15,
      maxOpenPositions: 5,
    },
    filters: {
      states: ['deep_extreme'],
    },
  },
  {
    id: '5m-scalper',
    name: '5m Scalper',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 0.5,  // Smaller size, more trades
      leverage: 10,
      takeProfitPercent: 10,     // Quick TP
      stopLossPercent: 10,       // Quick SL
      maxOpenPositions: 15,      // More positions
    },
    filters: {
      timeframes: ['5m'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: '1h-swing',
    name: '1h Swing',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 2,
      leverage: 5,               // Lower leverage for swings
      takeProfitPercent: 30,     // Wider TP
      stopLossPercent: 20,
      maxOpenPositions: 5,
    },
    filters: {
      timeframes: ['1h'],
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'tight-sl',
    name: 'Tight Stop Loss',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1,
      leverage: 10,
      takeProfitPercent: 20,
      stopLossPercent: 10,       // 10% stop loss
      maxOpenPositions: 10,
    },
    filters: {
      states: ['triggered', 'deep_extreme'],
    },
  },
  {
    id: 'wide-tp',
    name: 'Wide Take Profit',
    enabled: false,
    trading: {
      initialBalance: 2000,
      positionSizePercent: 1,
      leverage: 10,
      takeProfitPercent: 40,     // 40% take profit
      stopLossPercent: 20,
      maxOpenPositions: 10,
    },
    filters: {
      states: ['triggered', 'deep_extreme'],
    },
  },
];

/**
 * Bot Manager - Manages multiple paper trading bots
 */
export class BotManager {
  private bots: Map<string, { config: BotConfig; engine: PaperTradingEngine }> = new Map();

  constructor(configs: BotConfig[] = DEFAULT_BOTS) {
    for (const config of configs) {
      if (config.enabled) {
        const engine = new PaperTradingEngine(config.trading, config.id);
        this.bots.set(config.id, { config, engine });
      }
    }
  }

  /**
   * Check if a setup passes a bot's filters
   */
  private passesFilters(setup: BackburnerSetup, filters: BotFilterConfig): boolean {
    // Direction filter
    if (filters.directions && !filters.directions.includes(setup.direction)) {
      return false;
    }

    // Timeframe filter
    if (filters.timeframes && !filters.timeframes.includes(setup.timeframe)) {
      return false;
    }

    // Market type filter
    if (filters.marketTypes && !filters.marketTypes.includes(setup.marketType)) {
      return false;
    }

    // Quality tier filter
    if (filters.qualityTiers && setup.qualityTier && !filters.qualityTiers.includes(setup.qualityTier)) {
      return false;
    }

    // RSI filter
    if (filters.minRsi !== undefined && setup.currentRSI < filters.minRsi) {
      return false;
    }
    if (filters.maxRsi !== undefined && setup.currentRSI > filters.maxRsi) {
      return false;
    }

    // Impulse filter
    if (filters.minImpulsePercent !== undefined && setup.impulsePercentMove < filters.minImpulsePercent) {
      return false;
    }

    // State filter
    if (filters.states) {
      const validStates = filters.states as string[];
      if (!validStates.includes(setup.state)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Process a new setup - attempt to open positions for all eligible bots
   */
  openPositions(setup: BackburnerSetup): Map<string, PaperPosition | null> {
    const results = new Map<string, PaperPosition | null>();

    for (const [botId, { config, engine }] of this.bots) {
      if (this.passesFilters(setup, config.filters)) {
        const position = engine.openPosition(setup);
        results.set(botId, position);
      }
    }

    return results;
  }

  /**
   * Update positions for all bots
   */
  updatePositions(setup: BackburnerSetup): Map<string, PaperPosition | null> {
    const results = new Map<string, PaperPosition | null>();

    for (const [botId, { engine }] of this.bots) {
      const position = engine.updatePosition(setup);
      if (position) {
        results.set(botId, position);
      }
    }

    return results;
  }

  /**
   * Handle setup removed for all bots
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    for (const [, { engine }] of this.bots) {
      engine.handleSetupRemoved(setup);
    }
  }

  /**
   * Update orphaned positions for all bots
   */
  async updateOrphanedPositions(getPriceFn: (symbol: string) => Promise<number>): Promise<void> {
    for (const [, { engine }] of this.bots) {
      await engine.updateOrphanedPositions(getPriceFn);
    }
  }

  /**
   * Get all bots
   */
  getBots(): Array<{ id: string; name: string; config: BotConfig; engine: PaperTradingEngine }> {
    return Array.from(this.bots.entries()).map(([id, { config, engine }]) => ({
      id,
      name: config.name,
      config,
      engine,
    }));
  }

  /**
   * Get a specific bot
   */
  getBot(id: string): { config: BotConfig; engine: PaperTradingEngine } | undefined {
    return this.bots.get(id);
  }

  /**
   * Get aggregate stats across all bots
   */
  getAggregateStats(): {
    totalBalance: number;
    totalPnL: number;
    totalTrades: number;
    avgWinRate: number;
  } {
    let totalBalance = 0;
    let totalPnL = 0;
    let totalTrades = 0;
    let totalWinRate = 0;
    let botCount = 0;

    for (const [, { engine }] of this.bots) {
      const stats = engine.getStats();
      totalBalance += stats.currentBalance;
      totalPnL += stats.totalPnL;
      totalTrades += stats.totalTrades;
      totalWinRate += stats.winRate;
      botCount++;
    }

    return {
      totalBalance,
      totalPnL,
      totalTrades,
      avgWinRate: botCount > 0 ? totalWinRate / botCount : 0,
    };
  }

  /**
   * Get all open positions across all bots
   */
  getAllOpenPositions(): Array<{ botId: string; position: PaperPosition }> {
    const positions: Array<{ botId: string; position: PaperPosition }> = [];

    for (const [botId, { engine }] of this.bots) {
      for (const position of engine.getOpenPositions()) {
        positions.push({ botId, position });
      }
    }

    return positions;
  }

  /**
   * Generate summary for data persistence
   */
  getBotConfigs(): Record<string, Record<string, unknown>> {
    const configs: Record<string, Record<string, unknown>> = {};
    for (const [id, { config }] of this.bots) {
      configs[id] = {
        name: config.name,
        ...config.trading,
        filters: config.filters,
      };
    }
    return configs;
  }

  /**
   * Get stats for all bots
   */
  getBotStats(): Record<string, import('./paper-trading.js').TradingStats> {
    const stats: Record<string, import('./paper-trading.js').TradingStats> = {};
    for (const [id, { engine }] of this.bots) {
      stats[id] = engine.getStats();
    }
    return stats;
  }

  /**
   * Reset all bots
   */
  resetAll(): void {
    for (const [, { engine }] of this.bots) {
      engine.reset();
    }
  }
}

/**
 * Load bot configuration from file
 */
export function loadBotConfig(filePath: string): BotConfig[] {
  try {
    const fs = require('fs');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Fall back to defaults
  }
  return DEFAULT_BOTS;
}

/**
 * Save bot configuration to file
 */
export function saveBotConfig(filePath: string, configs: BotConfig[]): void {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(configs, null, 2));
}
