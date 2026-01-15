/**
 * Focus Mode - Real-World Trade Copying Assistant
 *
 * Tracks the best-performing bot (Trail Standard by default) and provides:
 * 1. Actionable notifications for when to open/close positions
 * 2. Clear stop loss and take profit guidance
 * 3. Position sizing recommendations
 * 4. Real-time trailing stop level updates
 *
 * Use this to manually copy paper trades to real MEXC account.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { BackburnerSetup, Timeframe } from './types.js';

const execAsync = promisify(exec);

// Focus Mode configuration
export type FocusTargetBot =
  | 'trailing10pct10x' | 'trailing10pct20x' | 'trailWide' | 'trailing1pct'
  | 'fixedTP' | 'confluence' | 'trendOverride' | 'trendFlip'
  | 'btcExtreme' | 'btcTrend'
  | 'gp-conservative' | 'gp-standard' | 'gp-aggressive' | 'gp-yolo'
  | 'gp2-conservative' | 'gp2-standard' | 'gp2-aggressive' | 'gp2-yolo';

export interface FocusModeConfig {
  enabled: boolean;
  // Which bot to mirror (id of the bot)
  targetBot: FocusTargetBot;
  // Real trading account settings
  accountBalance: number;       // Your real MEXC balance
  maxPositionSizePercent: number;  // Max % of account per trade (e.g., 5%)
  maxOpenPositions: number;     // Max concurrent positions
  leverage: number;             // Target leverage to use
  // Notification settings
  soundEnabled: boolean;
  openSound: string;            // Sound for new position alerts
  closeSound: string;           // Sound for close position alerts
  updateSound: string;          // Sound for trailing stop updates
  // Tracking state
  copyingEnabled: boolean;      // Whether to send copy notifications
}

export const DEFAULT_FOCUS_CONFIG: FocusModeConfig = {
  enabled: false,
  targetBot: 'trailWide',        // Trail Wide - historically best performer
  accountBalance: 2000,          // Default real balance
  maxPositionSizePercent: 10,    // 10% of available balance per trade
  maxOpenPositions: 999,         // Effectively unlimited
  leverage: 20,                  // 20x leverage
  soundEnabled: true,
  openSound: 'Hero',             // Distinctive sound for open
  closeSound: 'Ping',            // Close sound
  updateSound: 'Pop',            // Trail level update
  copyingEnabled: true,
};

// Tracked position for focus mode
export interface FocusPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  timeframe: string;
  marketType: 'spot' | 'futures';

  // Entry details (for notification)
  entryPrice: number;
  entryTime: number;
  suggestedSize: number;        // In USDT (margin)
  suggestedLeverage: number;

  // Paper bot position size (for P&L scaling)
  paperNotionalSize: number;    // Paper bot's notional size

  // Stop loss tracking
  currentStopPrice: number;
  currentTrailLevel: number;
  initialStopPercent: number;   // For setting initial SL on MEXC

  // Status
  status: 'pending_open' | 'open' | 'pending_close' | 'closed';
  lastNotificationTime: number;

  // Performance (scaled to user's position size, not paper bot's)
  unrealizedPnL: number;        // Scaled to user's notional size
  unrealizedPnLPercent: number; // ROI percentage (same as paper bot)
}

// Action types for notifications
export type FocusAction =
  | { type: 'OPEN_POSITION'; position: FocusPosition; urgency: 'high' | 'medium' }
  | { type: 'UPDATE_STOP'; position: FocusPosition; oldLevel: number; newLevel: number }
  | { type: 'CLOSE_POSITION'; position: FocusPosition; reason: string }
  | { type: 'MOVE_TO_BREAKEVEN'; position: FocusPosition }
  | { type: 'LOCK_PROFIT'; position: FocusPosition; lockedPnL: number };

/**
 * Send a notification with specific sound
 */
async function sendFocusNotification(
  title: string,
  message: string,
  subtitle?: string,
  sound?: string
): Promise<void> {
  try {
    const escapeShell = (str: string) => str.replace(/'/g, "'\\''");

    let cmd = `terminal-notifier -title '${escapeShell(title)}' -message '${escapeShell(message)}'`;

    if (subtitle) {
      cmd += ` -subtitle '${escapeShell(subtitle)}'`;
    }

    if (sound) {
      cmd += ` -sound ${sound}`;
    }

    // Open URL to focus the terminal
    cmd += ` -open 'http://localhost:3000'`;

    await execAsync(cmd);
  } catch (error) {
    // Fallback to osascript
    try {
      const escapeAppleScript = (str: string) => str.replace(/"/g, '\\"');
      let script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
      if (subtitle) {
        script += ` subtitle "${escapeAppleScript(subtitle)}"`;
      }
      if (sound) {
        script += ` sound name "${sound}"`;
      }
      await execAsync(`osascript -e '${script}'`);
    } catch {
      console.error('[FOCUS] Notification failed');
    }
  }
}

/**
 * Focus Mode Manager
 *
 * Monitors the target bot and generates actionable trade signals
 */
export class FocusModeManager {
  private config: FocusModeConfig;
  private trackedPositions: Map<string, FocusPosition> = new Map();
  private actionHistory: FocusAction[] = [];
  private lastBotState: any = null;

  constructor(config?: Partial<FocusModeConfig>) {
    this.config = { ...DEFAULT_FOCUS_CONFIG, ...config };
  }

  /**
   * Enable/disable focus mode
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled) {
      console.log(`[FOCUS] Focus Mode ENABLED - Mirroring ${this.config.targetBot}`);
    } else {
      console.log('[FOCUS] Focus Mode DISABLED');
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FocusModeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): FocusModeConfig {
    return { ...this.config };
  }

  /**
   * Calculate suggested position size based on real account
   */
  private calculateSuggestedSize(notionalSize: number, leverage: number): number {
    // Scale position relative to paper account size
    const paperAccountSize = 2000; // Paper bots start with $2000
    const scaleFactor = this.config.accountBalance / paperAccountSize;

    // Scale the margin used (notional / leverage)
    const paperMargin = notionalSize / leverage;
    let suggestedMargin = paperMargin * scaleFactor;

    // Apply max position size limit
    const maxMargin = this.config.accountBalance * (this.config.maxPositionSizePercent / 100);
    suggestedMargin = Math.min(suggestedMargin, maxMargin);

    return Math.round(suggestedMargin * 100) / 100;
  }

  /**
   * Scale P&L from paper bot to user's actual position size
   * The paper bot's P&L is based on its notional size, we need to scale it
   * to what the user would actually make with their suggested position
   */
  private scaleUserPnL(paperPnL: number, paperNotionalSize: number, userMargin: number, userLeverage: number): number {
    if (paperNotionalSize === 0) return 0;
    const userNotionalSize = userMargin * userLeverage;
    return paperPnL * (userNotionalSize / paperNotionalSize);
  }

  /**
   * Process a new position opened by the target bot
   */
  async onPositionOpened(botPosition: any, setup: BackburnerSetup): Promise<FocusAction | null> {
    if (!this.config.enabled || !this.config.copyingEnabled) return null;

    const key = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;

    // Don't duplicate if already tracking
    if (this.trackedPositions.has(key)) return null;

    // Check max positions
    const openCount = Array.from(this.trackedPositions.values())
      .filter(p => p.status === 'open' || p.status === 'pending_open').length;

    if (openCount >= this.config.maxOpenPositions) {
      console.log(`[FOCUS] Skipping ${setup.symbol} - max positions reached (${openCount}/${this.config.maxOpenPositions})`);
      return null;
    }

    // Calculate suggested size
    const suggestedSize = this.calculateSuggestedSize(botPosition.notionalSize, botPosition.leverage);

    // Calculate initial stop price percentage
    // Note: trailing bots use currentStopLossPrice, not currentStopPrice
    const currentStop = botPosition.currentStopLossPrice || botPosition.currentStopPrice || botPosition.initialStopLossPrice;
    const stopPercent = botPosition.direction === 'long'
      ? ((botPosition.entryPrice - currentStop) / botPosition.entryPrice) * 100
      : ((currentStop - botPosition.entryPrice) / botPosition.entryPrice) * 100;

    const focusPosition: FocusPosition = {
      id: key,
      symbol: setup.symbol,
      direction: setup.direction,
      timeframe: setup.timeframe,
      marketType: setup.marketType,
      entryPrice: botPosition.entryPrice,
      entryTime: Date.now(),
      suggestedSize,
      suggestedLeverage: this.config.leverage,
      paperNotionalSize: botPosition.notionalSize || 2000, // Store for P&L scaling
      currentStopPrice: currentStop,
      currentTrailLevel: botPosition.trailLevel || 0,
      initialStopPercent: stopPercent || 0,
      status: 'pending_open',
      lastNotificationTime: Date.now(),
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
    };

    this.trackedPositions.set(key, focusPosition);

    const action: FocusAction = {
      type: 'OPEN_POSITION',
      position: focusPosition,
      urgency: setup.state === 'deep_extreme' ? 'high' : 'medium',
    };

    this.actionHistory.push(action);

    // Send notification
    if (this.config.copyingEnabled) {
      const ticker = setup.symbol.replace('USDT', '');
      const dirEmoji = setup.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const urgEmoji = action.urgency === 'high' ? '🔥🔥' : '⚡';

      await sendFocusNotification(
        `${urgEmoji} OPEN ${ticker} ${dirEmoji}`,
        `Size: $${suggestedSize} @ ${this.config.leverage}x | Entry: $${focusPosition.entryPrice.toPrecision(5)}`,
        `Stop: ${stopPercent.toFixed(1)}% | ${setup.timeframe} ${setup.marketType}`,
        this.config.soundEnabled ? this.config.openSound : undefined
      );
    }

    return action;
  }

  /**
   * Process position update (trailing stop level change)
   */
  async onPositionUpdated(botPosition: any): Promise<FocusAction | null> {
    if (!this.config.enabled) return null;

    const key = `${botPosition.symbol}-${botPosition.timeframe}-${botPosition.direction}-${botPosition.marketType}`;
    const tracked = this.trackedPositions.get(key);

    if (!tracked) return null;

    // Update P&L - scale from paper bot's notional to user's suggested position
    const scaledPnL = this.scaleUserPnL(
      botPosition.unrealizedPnL || 0,
      tracked.paperNotionalSize,
      tracked.suggestedSize,
      tracked.suggestedLeverage
    );
    tracked.unrealizedPnL = scaledPnL;
    // ROI percent is the same regardless of position size (it's % return on margin)
    tracked.unrealizedPnLPercent = botPosition.unrealizedPnLPercent || 0;
    tracked.currentStopPrice = botPosition.currentStopLossPrice || botPosition.currentStopPrice || tracked.currentStopPrice;
    tracked.status = 'open';

    const oldLevel = tracked.currentTrailLevel;
    const newLevel = botPosition.trailLevel || 0;

    // Check if trail level changed
    if (newLevel !== oldLevel) {
      tracked.currentTrailLevel = newLevel;

      let action: FocusAction;

      if (oldLevel === 0 && newLevel === 1) {
        // First trail level = move to breakeven
        action = { type: 'MOVE_TO_BREAKEVEN', position: tracked };

        if (this.config.copyingEnabled) {
          const ticker = tracked.symbol.replace('USDT', '');
          await sendFocusNotification(
            `🔒 ${ticker} Move to BREAKEVEN`,
            `Trail L1 hit - Move stop to entry price`,
            `Entry: $${tracked.entryPrice.toPrecision(5)} | Current P&L: ${tracked.unrealizedPnLPercent.toFixed(1)}%`,
            this.config.soundEnabled ? this.config.updateSound : undefined
          );
        }
      } else if (newLevel > oldLevel) {
        // Trail level increased
        const lockedRoi = (newLevel - 1) * 10; // Each level locks 10% ROI

        action = {
          type: 'LOCK_PROFIT',
          position: tracked,
          lockedPnL: lockedRoi,
        };

        if (this.config.copyingEnabled) {
          const ticker = tracked.symbol.replace('USDT', '');
          await sendFocusNotification(
            `📈 ${ticker} Trail L${oldLevel}→L${newLevel}`,
            `Lock ${lockedRoi}% ROI profit | Raise stop loss`,
            `New stop: $${tracked.currentStopPrice.toPrecision(5)}`,
            this.config.soundEnabled ? this.config.updateSound : undefined
          );
        }
      } else {
        // No significant change
        return null;
      }

      tracked.lastNotificationTime = Date.now();
      this.actionHistory.push(action);
      return action;
    }

    return null;
  }

  /**
   * Process position closed
   */
  async onPositionClosed(botPosition: any, reason: string): Promise<FocusAction | null> {
    if (!this.config.enabled) return null;

    const key = `${botPosition.symbol}-${botPosition.timeframe}-${botPosition.direction}-${botPosition.marketType}`;
    const tracked = this.trackedPositions.get(key);

    if (!tracked) return null;

    tracked.status = 'pending_close';
    // Scale the realized P&L to user's position size
    const paperPnL = botPosition.realizedPnL || botPosition.unrealizedPnL || 0;
    tracked.unrealizedPnL = this.scaleUserPnL(
      paperPnL,
      tracked.paperNotionalSize,
      tracked.suggestedSize,
      tracked.suggestedLeverage
    );

    const action: FocusAction = {
      type: 'CLOSE_POSITION',
      position: tracked,
      reason,
    };

    this.actionHistory.push(action);

    if (this.config.copyingEnabled) {
      const ticker = tracked.symbol.replace('USDT', '');
      const pnlEmoji = tracked.unrealizedPnL >= 0 ? '💰' : '❌';
      const pnlStr = tracked.unrealizedPnL >= 0
        ? `+$${tracked.unrealizedPnL.toFixed(2)}`
        : `-$${Math.abs(tracked.unrealizedPnL).toFixed(2)}`;

      await sendFocusNotification(
        `${pnlEmoji} CLOSE ${ticker} NOW`,
        `${reason} | P&L: ${pnlStr}`,
        `Exit at market price immediately`,
        this.config.soundEnabled ? this.config.closeSound : undefined
      );
    }

    // Keep in tracked for UI display, but mark as closed
    tracked.status = 'closed';

    return action;
  }

  /**
   * Get all tracked positions for focus UI
   */
  getTrackedPositions(): FocusPosition[] {
    return Array.from(this.trackedPositions.values());
  }

  /**
   * Get only open/active positions
   */
  getActivePositions(): FocusPosition[] {
    return Array.from(this.trackedPositions.values())
      .filter(p => p.status === 'open' || p.status === 'pending_open');
  }

  /**
   * Get recent actions for focus UI
   */
  getRecentActions(limit = 20): FocusAction[] {
    return this.actionHistory.slice(-limit).reverse();
  }

  /**
   * Get focus mode state for API/UI
   */
  getState() {
    const activePositions = this.getActivePositions();
    const totalUnrealizedPnL = activePositions.reduce((sum, p) => sum + p.unrealizedPnL, 0);

    return {
      enabled: this.config.enabled,
      copyingEnabled: this.config.copyingEnabled,
      targetBot: this.config.targetBot,
      accountBalance: this.config.accountBalance,
      maxPositionSizePercent: this.config.maxPositionSizePercent,
      leverage: this.config.leverage,
      activePositions,
      totalUnrealizedPnL,
      positionCount: activePositions.length,
      maxPositions: this.config.maxOpenPositions,
      recentActions: this.getRecentActions(10),
    };
  }

  /**
   * Clear a closed position from tracking
   */
  clearPosition(positionId: string): void {
    this.trackedPositions.delete(positionId);
  }

  /**
   * Clear all closed positions
   */
  clearClosedPositions(): void {
    for (const [key, pos] of this.trackedPositions) {
      if (pos.status === 'closed') {
        this.trackedPositions.delete(key);
      }
    }
  }

  /**
   * Clear ALL positions (used when switching target bot)
   */
  clearAllPositions(): void {
    this.trackedPositions.clear();
    this.actionHistory = [];
  }

  /**
   * Sync all Focus Mode positions with the current state of bot positions
   * This updates P&L, stop prices, trail levels, closes positions that no longer exist,
   * AND imports any new positions from the bot that aren't being tracked yet
   */
  syncWithBotPositions(botPositions: any[]): void {
    if (!this.config.enabled) return;

    // Create a map of bot positions for quick lookup
    const botPosMap = new Map<string, any>();
    for (const bp of botPositions) {
      const key = `${bp.symbol}-${bp.timeframe}-${bp.direction}-${bp.marketType}`;
      botPosMap.set(key, bp);
    }

    // Update each tracked position
    for (const [key, tracked] of this.trackedPositions) {
      const botPos = botPosMap.get(key);

      if (botPos && botPos.status === 'open') {
        // Update from bot position - scale P&L to user's position size
        const scaledPnL = this.scaleUserPnL(
          botPos.unrealizedPnL || 0,
          tracked.paperNotionalSize,
          tracked.suggestedSize,
          tracked.suggestedLeverage
        );
        tracked.unrealizedPnL = scaledPnL;
        // ROI percent is the same regardless of position size
        tracked.unrealizedPnLPercent = botPos.unrealizedPnLPercent || 0;
        tracked.currentStopPrice = botPos.currentStopLossPrice || botPos.currentStopPrice || tracked.currentStopPrice;
        tracked.status = 'open';

        const oldLevel = tracked.currentTrailLevel;
        const newLevel = botPos.trailLevel || 0;

        // Check for trail level changes and record actions
        if (newLevel !== oldLevel) {
          tracked.currentTrailLevel = newLevel;

          if (oldLevel === 0 && newLevel === 1) {
            const action: FocusAction = { type: 'MOVE_TO_BREAKEVEN', position: tracked };
            this.actionHistory.push(action);
          } else if (newLevel > oldLevel) {
            const lockedRoi = (newLevel - 1) * 10;
            const action: FocusAction = {
              type: 'LOCK_PROFIT',
              position: tracked,
              lockedPnL: lockedRoi,
            };
            this.actionHistory.push(action);
          }
        }
      } else if (!botPos && tracked.status !== 'closed') {
        // Bot position no longer exists - mark as closed
        tracked.status = 'closed';
        const action: FocusAction = {
          type: 'CLOSE_POSITION',
          position: tracked,
          reason: 'Position closed',
        };
        this.actionHistory.push(action);
      }
    }

    // Import any bot positions that aren't being tracked yet
    for (const [key, botPos] of botPosMap) {
      if (botPos.status !== 'open') continue;
      if (this.trackedPositions.has(key)) continue;

      // Calculate initial stop percent from bot position
      const currentStop = botPos.currentStopLossPrice || botPos.initialStopLossPrice;
      const stopPercent = botPos.direction === 'long'
        ? ((botPos.entryPrice - currentStop) / botPos.entryPrice) * 100
        : ((currentStop - botPos.entryPrice) / botPos.entryPrice) * 100;

      // Import this position
      const paperNotionalSize = botPos.notionalSize || 2000;
      const suggestedSize = this.calculateSuggestedSize(paperNotionalSize, botPos.leverage);

      // Scale P&L to user's position size
      const scaledPnL = this.scaleUserPnL(
        botPos.unrealizedPnL || 0,
        paperNotionalSize,
        suggestedSize,
        this.config.leverage
      );

      const focusPosition: FocusPosition = {
        id: key,
        symbol: botPos.symbol,
        direction: botPos.direction,
        timeframe: botPos.timeframe,
        marketType: botPos.marketType,
        entryPrice: botPos.entryPrice,
        entryTime: botPos.entryTime || Date.now(),
        suggestedSize,
        suggestedLeverage: this.config.leverage,
        paperNotionalSize,
        currentStopPrice: currentStop,
        currentTrailLevel: botPos.trailLevel || 0,
        initialStopPercent: stopPercent || 2,
        status: 'open',
        lastNotificationTime: Date.now(),
        unrealizedPnL: scaledPnL,
        unrealizedPnLPercent: botPos.unrealizedPnLPercent || 0,
      };

      this.trackedPositions.set(key, focusPosition);
    }
  }

  /**
   * Test notification
   */
  async testNotification(): Promise<void> {
    await sendFocusNotification(
      '🎯 Focus Mode Test',
      'Notifications are working!',
      'This is a test for trade copying alerts',
      this.config.soundEnabled ? this.config.openSound : undefined
    );
  }
}

// Singleton instance
let focusModeInstance: FocusModeManager | null = null;

export function getFocusModeManager(): FocusModeManager {
  if (!focusModeInstance) {
    focusModeInstance = new FocusModeManager();
  }
  return focusModeInstance;
}
