/**
 * Bots Index
 * Exports all bot classes and types
 */

export {
  BaseBot,
  SinglePositionBot,
  MultiPositionBot,
  type BaseBotConfig,
  type BasePosition,
  type BasePositionStatus,
  type BaseBotStats,
  type MarketData,
} from './base-bot.js';

export {
  BTCTrendBotV2,
  type BTCTrendBotV2Config,
  type BTCRSIDataV2,
  type BTCTrendPositionV2,
  type BTCTrendStatsV2,
  DEFAULT_BTC_TREND_V2_CONFIG,
} from './btc-trend-bot-v2.js';
