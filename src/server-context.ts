/**
 * Server Context
 * Shared state and functions that route modules need access to
 */

import type { Response } from 'express';

// Server settings interface
export interface ServerSettings {
  dailyResetEnabled: boolean;
  lastResetDate: string;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  investmentAmount: number;
}

// Bot toggle state
export interface BotToggles {
  [key: string]: boolean;
}

// Server context interface - passed to route modules
export interface ServerContext {
  // Settings
  settings: ServerSettings;
  saveSettings: () => void;

  // Bot management
  resetAllBots: () => void;
  updateAllBotsInitialBalance: (amount: number) => void;
  toggleBot: (botId: string, enabled: boolean) => void;
  botToggles: BotToggles;

  // State broadcasting
  broadcastState: () => void;
  getFullState: () => any;
  clients: Set<Response>;

  // Utilities
  getCurrentDateString: () => string;

  // Screener and bots (for market data routes)
  screener: any;
  paperEngine: any;
  trailingEngine: any;
  trailWideBot: any;
  confluenceBot: any;
  btcExtremeBot: any;
  btcTrendBot: any;
  trendOverrideBot: any;
  trendFlipBot: any;
  fadeBot: any;
  goldenPocketBots: any;
  gp2Bots: any;
  focusShadowBots: any;
  spotRegimeBots: any;

  // Focus mode
  focusModeManager: any;
  notificationManager: any;
}
