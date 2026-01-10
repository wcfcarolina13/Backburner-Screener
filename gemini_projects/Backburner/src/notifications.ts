import { exec } from 'child_process';
import { promisify } from 'util';
import type { BackburnerSetup } from './types.js';

const execAsync = promisify(exec);

// Notification settings
export interface NotificationConfig {
  enabled: boolean;
  sound: boolean;
  soundName: string;  // macOS sound name (e.g., 'Glass', 'Ping', 'Pop', 'Purr', 'Submarine')
  playedOutSoundName: string;  // Different sound for played out notifications
  onlyTriggered: boolean;  // Only notify on triggered/deep_extreme states
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  sound: true,
  soundName: 'Glass',  // Pleasant chime sound for new setups
  playedOutSoundName: 'Purr',  // Softer sound for played out
  onlyTriggered: true,  // Only alert on actionable setups
};

/**
 * Send a notification using terminal-notifier (most reliable on macOS)
 */
async function sendNotification(
  title: string,
  message: string,
  subtitle?: string,
  sound?: string
): Promise<void> {
  try {
    // Escape special characters for shell
    const escapeShell = (str: string) => str.replace(/'/g, "'\\''");

    let cmd = `terminal-notifier -title '${escapeShell(title)}' -message '${escapeShell(message)}'`;

    if (subtitle) {
      cmd += ` -subtitle '${escapeShell(subtitle)}'`;
    }

    if (sound) {
      cmd += ` -sound ${sound}`;
    }

    await execAsync(cmd);
  } catch (error) {
    // Silently fail - notifications are non-critical
    // Could fall back to osascript if terminal-notifier isn't installed
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
      console.error('Notification failed - terminal-notifier not installed');
    }
  }
}

/**
 * Format a setup for notification display
 */
function formatSetupForNotification(setup: BackburnerSetup): {
  title: string;
  message: string;
  subtitle: string;
} {
  const ticker = setup.symbol.replace('USDT', '');
  const direction = setup.direction.toUpperCase();
  const market = setup.marketType === 'futures' ? 'Futures' : 'Spot';
  const rsi = setup.currentRSI.toFixed(1);

  const stateEmoji = setup.state === 'deep_extreme' ? '🔥' : '⚡';
  const dirEmoji = setup.direction === 'long' ? '🟢' : '🔴';

  // Format market cap
  let mcap = 'N/A';
  if (setup.marketCap) {
    if (setup.marketCap >= 1_000_000_000) {
      mcap = `$${(setup.marketCap / 1_000_000_000).toFixed(1)}B`;
    } else if (setup.marketCap >= 1_000_000) {
      mcap = `$${(setup.marketCap / 1_000_000).toFixed(0)}M`;
    } else {
      mcap = `$${(setup.marketCap / 1_000).toFixed(0)}K`;
    }
  }

  const title = `${stateEmoji} ${ticker} ${direction} ${setup.timeframe}`;
  const subtitle = `${dirEmoji} ${market} | RSI: ${rsi} | MCap: ${mcap}`;
  const message = setup.coinName
    ? `${setup.coinName} - ${setup.state.replace('_', ' ').toUpperCase()}`
    : `${setup.state.replace('_', ' ').toUpperCase()}`;

  return { title, message, subtitle };
}

/**
 * Notification manager for Backburner setups
 */
export class NotificationManager {
  private config: NotificationConfig;
  private notifiedSetups: Set<string> = new Set();

  constructor(config?: Partial<NotificationConfig>) {
    this.config = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };
  }

  /**
   * Notify about a new setup
   */
  async notifyNewSetup(setup: BackburnerSetup): Promise<void> {
    if (!this.config.enabled) return;

    // Only notify on actionable states if configured
    if (this.config.onlyTriggered) {
      if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
        return;
      }
    }

    // Create unique key to avoid duplicate notifications
    const key = `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;

    // Don't notify for the same setup twice
    if (this.notifiedSetups.has(key)) {
      return;
    }

    this.notifiedSetups.add(key);

    const { title, message, subtitle } = formatSetupForNotification(setup);
    const sound = this.config.sound ? this.config.soundName : undefined;

    await sendNotification(title, message, subtitle, sound);
  }

  /**
   * Notify about a setup state change (e.g., watching -> triggered)
   */
  async notifyStateChange(setup: BackburnerSetup, previousState: string): Promise<void> {
    if (!this.config.enabled) return;

    // Only notify when transitioning TO an actionable state
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return;
    }

    // Don't notify if it was already in an actionable state
    if (previousState === 'triggered' || previousState === 'deep_extreme') {
      return;
    }

    const { title, message, subtitle } = formatSetupForNotification(setup);
    const sound = this.config.sound ? this.config.soundName : undefined;

    await sendNotification(
      `🔔 ${title}`,
      `State changed: ${previousState} → ${setup.state}`,
      subtitle,
      sound
    );
  }

  /**
   * Notify when a setup has played out (position should be closed)
   */
  async notifyPlayedOut(setup: BackburnerSetup): Promise<void> {
    if (!this.config.enabled) return;

    const ticker = setup.symbol.replace('USDT', '');
    const direction = setup.direction.toUpperCase();
    const market = setup.marketType === 'futures' ? 'F' : 'S';

    const title = `✅ ${ticker} ${direction} Played Out`;
    const subtitle = `${market} ${setup.timeframe} - Take profit zone reached`;
    const message = setup.coinName || ticker;
    const sound = this.config.sound ? this.config.playedOutSoundName : undefined;

    await sendNotification(title, message, subtitle, sound);
  }

  /**
   * Clear notification history for a setup (allows re-notification)
   */
  clearSetup(symbol: string, timeframe: string, direction: string, marketType: string): void {
    const key = `${symbol}-${timeframe}-${direction}-${marketType}`;
    this.notifiedSetups.delete(key);
  }

  /**
   * Clear all notification history
   */
  clearAll(): void {
    this.notifiedSetups.clear();
  }

  /**
   * Update notification config
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Test notification
   */
  async testNotification(): Promise<void> {
    await sendNotification(
      '🔔 Backburner Test',
      'Notifications are working!',
      'This is a test notification',
      this.config.sound ? this.config.soundName : undefined
    );
  }
}
