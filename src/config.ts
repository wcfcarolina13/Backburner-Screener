import type { ScreenerConfig, Timeframe } from './types.js';

// Default configuration for the Backburner screener
export const DEFAULT_CONFIG: ScreenerConfig = {
  // Target timeframes (5m, 15m, 1h, 4h)
  // Added 4h for testing higher timeframe hypothesis (backtest shows 4H normal beats 5m)
  timeframes: ['5m', '15m', '1h', '4h'] as Timeframe[],

  // RSI settings based on TCG Backburner strategy
  rsiPeriod: 14,
  // Long setups (buy oversold after impulse UP)
  rsiOversoldThreshold: 30,      // Primary entry when RSI < 30
  rsiDeepOversoldThreshold: 20,  // Secondary add when RSI < 20
  // Short setups (sell overbought after impulse DOWN)
  rsiOverboughtThreshold: 70,    // Primary entry when RSI > 70
  rsiDeepOverboughtThreshold: 80, // Secondary add when RSI > 80

  // Impulse move detection
  minImpulsePercent: 5,  // Minimum 5% move to qualify as impulse (increased from 3%)
  minImpulseDominance: 0.5, // Minimum dominance score (0-1) - how "clean" the impulse must be

  // Volume filter (24h volume in USDT)
  // $250K is enough for small position sizes ($2-4K notional)
  minVolume24h: 250_000,

  // Market cap filter (filters out fake volume coins)
  minMarketCap: 5_000_000,   // $5M minimum market cap (lowered for more coverage)
  requireMarketCap: true,    // Only show coins with CoinGecko data (keeps out scams)

  // Volume tiers for quality classification (based on market cap now)
  volumeTiers: {
    bluechip: 1_000_000_000,  // $1B+ market cap = blue chip
    midcap: 100_000_000,      // $100M-$1B market cap = mid cap
    lowcap: 10_000_000,       // $10M-$100M market cap = low cap (SHITCOIN warning)
  },

  // Update frequency
  updateIntervalMs: 10000,  // Update every 10 seconds

  // Rate limiting
  maxConcurrentRequests: 10,

  // Exclude patterns for stablecoins and exotic assets
  // NOTE: Patterns are tested against baseAsset (e.g., "BTC") and symbol (e.g., "BTCUSDT")
  excludePatterns: [
    // Stablecoins (exact matches only)
    /^USDT$/i,
    /^USDC$/i,
    /^BUSD$/i,
    /^DAI$/i,
    /^TUSD$/i,
    /^USDP$/i,
    /^GUSD$/i,
    /^FRAX$/i,
    /^LUSD$/i,
    /^SUSD$/i,
    /^USDD$/i,
    /^FDUSD$/i,
    /^PYUSD$/i,
    /^EURC$/i,
    /^UST$/i,
    /^USDJ$/i,
    /^CUSD$/i,
    /^HUSD$/i,

    // Leveraged tokens
    /\d+[LS]$/i,      // 3L, 3S, 5L, 5S etc
    /BULL$/i,
    /BEAR$/i,
    /^.+UP$/i,        // BTCUP, ETHUP (but not "UP" alone)
    /^.+DOWN$/i,      // BTCDOWN, ETHDOWN

    // Wrapped tokens (exact matches for known wrapped assets)
    /^WBTC$/i,
    /^WETH$/i,

    // Index/basket tokens
    /^DPI$/i,
    /^MVI$/i,
    /^BED$/i,

    // Rebasing tokens
    /^AMPL$/i,
    /^OHM$/i,

    // Test/deprecated
    /TEST/i,
    /OLD$/i,
    /^LEGACY/i,

    // Low-quality meme/scam patterns (be specific to avoid catching legit coins)
    /^SAFEMOON/i,     // SafeMoon specifically
    /^BABYDOGE/i,     // BabyDoge specifically
    /^MINIDOGE/i,     // Mini tokens
    /ELON$/i,         // Elon tokens like DOGELON

    // Tokenized stocks on MEXC futures (JPMSTOCK_USDT, AAPLSTOCK_USDT, etc.)
    /STOCK$/i,
  ],
};

// Whitelisted futures-only symbols that bypass CoinGecko market cap requirement.
// These are known legitimate assets with no MEXC spot pair but active futures contracts.
// Add symbols here manually after verifying they're real, liquid, and tradeable.
export const FUTURES_WHITELIST: string[] = [
  'SILVER_USDT',   // Silver (XAG) commodity — $527M daily turnover
  'PAXG_USDT',     // Gold (PAXG) — $155M daily turnover
];

// Per-timeframe minimum impulse % for LTF fallback (when HTF candles unavailable).
// Primary impulse detection uses HTF candles with the global minImpulsePercent (5%).
// These lower thresholds only apply when falling back to LTF-only impulse detection.
export const TIMEFRAME_IMPULSE_MIN: Record<string, number> = {
  '5m':  2,   // 2% on 5m (fallback only — HTF 1h impulse is primary)
  '15m': 3,   // 3% on 15m (fallback only — HTF 4h impulse is primary)
  '1h':  5,   // 5% on 1h (no HTF pairing, always uses LTF)
  '4h':  5,   // 5% on 4h (no HTF pairing, always uses LTF)
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
  '1m': 1 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

// MEXC kline interval mapping
// Note: MEXC uses '60m' instead of '1h'
export const MEXC_INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '60m',  // MEXC uses 60m, not 1h
  '4h': '4h',
  '1d': '1d',
};

// How many candles to fetch for analysis
export const CANDLES_TO_FETCH = 100;

// Setup expiry times (how long before a setup is considered stale)
export const SETUP_EXPIRY_MS: Record<Timeframe, number> = {
  '1m': 30 * 60 * 1000,        // 30 minutes for 1m
  '5m': 2 * 60 * 60 * 1000,    // 2 hours for 5m
  '15m': 6 * 60 * 60 * 1000,   // 6 hours for 15m
  '1h': 24 * 60 * 60 * 1000,   // 24 hours for 1h
  '4h': 48 * 60 * 60 * 1000,   // 48 hours for 4h
  '1d': 7 * 24 * 60 * 60 * 1000, // 7 days for daily
};
