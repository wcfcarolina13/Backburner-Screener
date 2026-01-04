import type { ScreenerConfig, Timeframe } from './types.js';

// Default configuration for the Backburner screener
export const DEFAULT_CONFIG: ScreenerConfig = {
  // Target timeframes (5m, 15m, 1h as specified)
  timeframes: ['5m', '15m', '1h'] as Timeframe[],

  // RSI settings based on TCG Backburner strategy
  rsiPeriod: 14,
  rsiOversoldThreshold: 30,      // Primary entry when RSI < 30
  rsiDeepOversoldThreshold: 20,  // Secondary entry opportunity when RSI < 20

  // Impulse move detection
  minImpulsePercent: 5,  // Minimum 5% move to qualify as impulse (increased from 3%)

  // Volume filter (24h volume in USDT)
  minVolume24h: 1_000_000,  // $1M minimum to be included

  // Volume tiers for quality classification
  volumeTiers: {
    bluechip: 20_000_000,   // $20M+ = blue chip (BTC, ETH, SOL, etc.)
    midcap: 5_000_000,      // $5M-$20M = mid cap
    lowcap: 1_000_000,      // $1M-$5M = low cap (SHITCOIN warning)
  },

  // Update frequency
  updateIntervalMs: 10000,  // Update every 10 seconds

  // Rate limiting
  maxConcurrentRequests: 10,

  // Exclude patterns for stablecoins and exotic assets
  excludePatterns: [
    // Stablecoins
    /^USDT/i,
    /^USDC/i,
    /^BUSD/i,
    /^DAI/i,
    /^TUSD/i,
    /^USDP/i,
    /^GUSD/i,
    /^FRAX/i,
    /^LUSD/i,
    /^SUSD/i,
    /^USDD/i,
    /^FDUSD/i,
    /^PYUSD/i,
    /^EURC/i,
    /^EUR[A-Z]/i,
    /^UST/i,
    /^USDJ/i,
    /^CUSD/i,
    /^HUSD/i,

    // Leveraged tokens
    /\d+[LS]$/i,      // 3L, 3S, 5L, 5S etc
    /BULL$/i,
    /BEAR$/i,
    /UP$/i,
    /DOWN$/i,

    // Wrapped/bridged versions (often duplicate)
    /^W[A-Z]{2,}/,    // WBTC, WETH, etc (but keep if traded against USDT)

    // Index/basket tokens
    /^DPI/i,
    /^MVI/i,
    /^BED/i,

    // Rebasing tokens
    /^AMPL/i,
    /^OHM/i,
    /^TIME/i,

    // Test/deprecated
    /TEST/i,
    /OLD$/i,
    /^LEGACY/i,

    // Low-quality meme/scam patterns
    /^SAFE/i,         // SafeMoon clones
    /^BABY/i,         // BabyDoge etc
    /^MINI/i,         // Mini tokens
    /^FLOKI/i,        // Floki variants (keep original FLOKI if volume is high)
    /INU$/i,          // Random inu coins (not SHIB which is established)
    /MOON$/i,         // Moon tokens
    /ELON$/i,         // Elon tokens
    /DOGE(?!$)/i,     // Doge clones (but not DOGE itself)
    /SHIB(?!$)/i,     // Shib clones (but not SHIB itself)
    /PEPE(?!$)/i,     // Pepe clones (but not PEPE itself)
  ],
};

// MEXC API endpoints
export const MEXC_API = {
  BASE_URL: 'https://api.mexc.com',
  EXCHANGE_INFO: '/api/v3/exchangeInfo',
  KLINES: '/api/v3/klines',
  TICKER_24H: '/api/v3/ticker/24hr',
  TICKER_PRICE: '/api/v3/ticker/price',
};

// Timeframe to milliseconds mapping
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

// MEXC kline interval mapping
export const MEXC_INTERVAL: Record<Timeframe, string> = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

// How many candles to fetch for analysis
export const CANDLES_TO_FETCH = 100;

// Setup expiry times (how long before a setup is considered stale)
export const SETUP_EXPIRY_MS: Record<Timeframe, number> = {
  '5m': 2 * 60 * 60 * 1000,    // 2 hours for 5m
  '15m': 6 * 60 * 60 * 1000,   // 6 hours for 15m
  '1h': 24 * 60 * 60 * 1000,   // 24 hours for 1h
  '4h': 48 * 60 * 60 * 1000,   // 48 hours for 4h
  '1d': 7 * 24 * 60 * 60 * 1000, // 7 days for daily
};
