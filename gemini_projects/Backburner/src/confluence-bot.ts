import type { BackburnerSetup, MarketType, Timeframe } from './types.js';
import { TrailingStopEngine, type TrailingStopConfig, type TrailingPosition } from './paper-trading-trailing.js';

/**
 * Multi-Timeframe Confluence Bot
 *
 * Only opens positions when the same asset triggers on multiple timeframes:
 * - Requires 5m trigger AND (15m OR 1h trigger)
 * - Uses trailing stop logic
 * - Does NOT close on played_out (only closes on stop loss)
 */

// Debug logging
const DEBUG_CONFLUENCE = false;

function debugLog(message: string, data?: Record<string, unknown>, important = false): void {
  if (!DEBUG_CONFLUENCE && !important) return;

  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[CONFLUENCE ${timestamp}]`;
  if (data) {
    console.error(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

export interface ConfluenceConfig extends Omit<TrailingStopConfig, 'level1LockPercent'> {
  level1LockPercent?: number;
  // Which timeframes are required for confluence
  requiredTimeframe: Timeframe;           // Must have this (e.g., '5m')
  confirmingTimeframes: Timeframe[];       // Must have at least one of these (e.g., ['15m', '1h'])
  // How long a trigger is valid for confluence (ms)
  confluenceWindowMs: number;              // e.g., 5 minutes = 300000
}

export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 20,
  initialStopLossPercent: 20,
  trailTriggerPercent: 10,
  trailStepPercent: 10,
  level1LockPercent: 0,
  maxOpenPositions: 100,
  requiredTimeframe: '5m',
  confirmingTimeframes: ['15m', '1h'],
  confluenceWindowMs: 5 * 60 * 1000,  // 5 minutes
};

// Track recent triggers per asset
interface TriggerRecord {
  setup: BackburnerSetup;
  timestamp: number;
}

/**
 * Confluence Bot - Multi-timeframe confirmation trading
 */
export class ConfluenceBot {
  private config: ConfluenceConfig;
  private trailingEngine: TrailingStopEngine;

  // Track recent triggers: symbol -> direction -> timeframe -> TriggerRecord
  private recentTriggers: Map<string, Map<string, Map<Timeframe, TriggerRecord>>> = new Map();

  // Track which symbols already have open positions (symbol-direction)
  private openPositionKeys: Set<string> = new Set();

  constructor(config?: Partial<ConfluenceConfig>, botId = 'confluence') {
    this.config = { ...DEFAULT_CONFLUENCE_CONFIG, ...config };

    // Create underlying trailing engine with same config
    this.trailingEngine = new TrailingStopEngine({
      initialBalance: this.config.initialBalance,
      positionSizePercent: this.config.positionSizePercent,
      leverage: this.config.leverage,
      initialStopLossPercent: this.config.initialStopLossPercent,
      trailTriggerPercent: this.config.trailTriggerPercent,
      trailStepPercent: this.config.trailStepPercent,
      level1LockPercent: this.config.level1LockPercent || 0,
      maxOpenPositions: this.config.maxOpenPositions,
    }, botId);
  }

  getBotId(): string {
    return this.trailingEngine.getBotId();
  }

  /**
   * Clean up old triggers outside the confluence window
   */
  private cleanupOldTriggers(): void {
    const now = Date.now();
    const cutoff = now - this.config.confluenceWindowMs;

    for (const [symbol, directionMap] of this.recentTriggers) {
      for (const [direction, timeframeMap] of directionMap) {
        for (const [tf, record] of timeframeMap) {
          if (record.timestamp < cutoff) {
            timeframeMap.delete(tf);
          }
        }
        if (timeframeMap.size === 0) {
          directionMap.delete(direction);
        }
      }
      if (directionMap.size === 0) {
        this.recentTriggers.delete(symbol);
      }
    }
  }

  /**
   * Record a trigger and check for confluence
   */
  private recordTrigger(setup: BackburnerSetup): void {
    const { symbol, direction, timeframe } = setup;

    if (!this.recentTriggers.has(symbol)) {
      this.recentTriggers.set(symbol, new Map());
    }
    const directionMap = this.recentTriggers.get(symbol)!;

    if (!directionMap.has(direction)) {
      directionMap.set(direction, new Map());
    }
    const timeframeMap = directionMap.get(direction)!;

    timeframeMap.set(timeframe, {
      setup,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if we have confluence for a symbol/direction
   */
  private hasConfluence(symbol: string, direction: 'long' | 'short'): BackburnerSetup | null {
    const directionMap = this.recentTriggers.get(symbol);
    if (!directionMap) return null;

    const timeframeMap = directionMap.get(direction);
    if (!timeframeMap) return null;

    // Check if we have the required timeframe
    const requiredTrigger = timeframeMap.get(this.config.requiredTimeframe);
    if (!requiredTrigger) return null;

    // Check if we have at least one confirming timeframe
    let hasConfirming = false;
    let confirmingSetup: BackburnerSetup | null = null;

    for (const tf of this.config.confirmingTimeframes) {
      const trigger = timeframeMap.get(tf);
      if (trigger) {
        hasConfirming = true;
        confirmingSetup = trigger.setup;
        break;
      }
    }

    if (hasConfirming) {
      // Return the required timeframe setup (5m) as the entry setup
      debugLog(`CONFLUENCE DETECTED: ${symbol} ${direction.toUpperCase()} - 5m + confirming timeframe`, {
        symbol,
        direction,
        timeframes: Array.from(timeframeMap.keys()),
      }, true);
      return requiredTrigger.setup;
    }

    return null;
  }

  /**
   * Process a new setup - record trigger and check for confluence
   */
  openPosition(setup: BackburnerSetup): TrailingPosition | null {
    // Only consider triggered or deep_extreme states
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only consider timeframes we care about
    const relevantTimeframes = [this.config.requiredTimeframe, ...this.config.confirmingTimeframes];
    if (!relevantTimeframes.includes(setup.timeframe)) {
      return null;
    }

    // Clean up old triggers
    this.cleanupOldTriggers();

    // Record this trigger
    this.recordTrigger(setup);

    // Check if we already have a position for this symbol/direction
    const posKey = `${setup.symbol}-${setup.direction}`;
    if (this.openPositionKeys.has(posKey)) {
      return null;
    }

    // Check for confluence
    const confluenceSetup = this.hasConfluence(setup.symbol, setup.direction);
    if (!confluenceSetup) {
      return null;
    }

    // We have confluence! Open position via trailing engine
    // Use a modified setup that bypasses the per-timeframe deduplication
    // by using a special key format
    const modifiedSetup: BackburnerSetup = {
      ...confluenceSetup,
      // Override timeframe to 'confluence' marker so trailing engine treats it uniquely
      // Actually, we need to be careful here - let's track our own open positions
    };

    const position = this.trailingEngine.openPosition(confluenceSetup);
    if (position) {
      this.openPositionKeys.add(posKey);
      debugLog(`POSITION OPENED via confluence: ${setup.symbol} ${setup.direction.toUpperCase()}`, {
        symbol: setup.symbol,
        direction: setup.direction,
        entryPrice: position.entryPrice,
      }, true);
    }

    return position;
  }

  /**
   * Update position - delegate to trailing engine
   * Note: We do NOT close on played_out for this bot
   */
  updatePosition(setup: BackburnerSetup): TrailingPosition | null {
    // Create a modified setup that won't trigger played_out exits
    const modifiedSetup: BackburnerSetup = {
      ...setup,
      // Override played_out state to keep position open
      state: setup.state === 'played_out' ? 'triggered' : setup.state,
    };

    const position = this.trailingEngine.updatePosition(modifiedSetup);

    // If position was closed (by trailing stop), remove from our tracking
    if (position && position.status !== 'open') {
      const posKey = `${setup.symbol}-${setup.direction}`;
      this.openPositionKeys.delete(posKey);
    }

    return position;
  }

  /**
   * Handle setup removed - keep position open (orphaned)
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    this.trailingEngine.handleSetupRemoved(setup);
  }

  /**
   * Update orphaned positions
   */
  async updateOrphanedPositions(getPriceFn: (symbol: string) => Promise<number>): Promise<void> {
    // Get positions before update
    const beforeKeys = new Set(this.trailingEngine.getOpenPositions().map(p => `${p.symbol}-${p.direction}`));

    await this.trailingEngine.updateOrphanedPositions(getPriceFn);

    // Check if any positions were closed
    const afterKeys = new Set(this.trailingEngine.getOpenPositions().map(p => `${p.symbol}-${p.direction}`));

    for (const key of beforeKeys) {
      if (!afterKeys.has(key)) {
        this.openPositionKeys.delete(key);
      }
    }
  }

  // Delegate stats/position methods to trailing engine
  getOpenPositions(): TrailingPosition[] {
    return this.trailingEngine.getOpenPositions();
  }

  getClosedPositions(limit = 50): TrailingPosition[] {
    return this.trailingEngine.getClosedPositions(limit);
  }

  getStats() {
    return this.trailingEngine.getStats();
  }

  getBalance(): number {
    return this.trailingEngine.getBalance();
  }

  getUnrealizedPnL(): number {
    return this.trailingEngine.getUnrealizedPnL();
  }

  getConfig(): ConfluenceConfig {
    return { ...this.config };
  }

  reset(): void {
    this.trailingEngine.reset();
    this.recentTriggers.clear();
    this.openPositionKeys.clear();
  }

  /**
   * Get current trigger state for debugging/UI
   */
  getActiveTriggers(): Array<{
    symbol: string;
    direction: string;
    timeframes: Timeframe[];
    hasConfluence: boolean;
  }> {
    this.cleanupOldTriggers();

    const result: Array<{
      symbol: string;
      direction: string;
      timeframes: Timeframe[];
      hasConfluence: boolean;
    }> = [];

    for (const [symbol, directionMap] of this.recentTriggers) {
      for (const [direction, timeframeMap] of directionMap) {
        const timeframes = Array.from(timeframeMap.keys());
        const hasRequired = timeframes.includes(this.config.requiredTimeframe);
        const hasConfirming = this.config.confirmingTimeframes.some(tf => timeframes.includes(tf));

        result.push({
          symbol,
          direction,
          timeframes,
          hasConfluence: hasRequired && hasConfirming,
        });
      }
    }

    return result;
  }
}
