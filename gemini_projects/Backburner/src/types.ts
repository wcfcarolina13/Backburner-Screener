// Candle/OHLCV data
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Timeframe options
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';

// RSI calculation result
export interface RSIResult {
  value: number;
  timestamp: number;
}

// Setup direction
export type SetupDirection = 'long' | 'short';

// Backburner setup state
export type SetupState =
  | 'watching'        // Had impulse move, waiting for RSI trigger
  | 'triggered'       // RSI just hit threshold - ACTIVE SETUP
  | 'deep_extreme'    // RSI at extreme levels (< 20 or > 80)
  | 'reversing'       // Price reversing from extreme
  | 'played_out';     // Setup completed or invalidated

// Quality tier based on 24h volume
export type QualityTier = 'bluechip' | 'midcap' | 'shitcoin';

// A detected Backburner setup
export interface BackburnerSetup {
  symbol: string;
  timeframe: Timeframe;
  direction: SetupDirection;
  state: SetupState;

  // Impulse move details
  impulseHigh: number;
  impulseLow: number;
  impulseStartTime: number;
  impulseEndTime: number;
  impulsePercentMove: number;

  // Current RSI readings
  currentRSI: number;
  rsiAtTrigger?: number;

  // Price levels
  currentPrice: number;
  entryPrice?: number;

  // Timing
  detectedAt: number;
  triggeredAt?: number;
  lastUpdated: number;
  playedOutAt?: number;  // When the setup was marked as played out

  // Volume analysis
  impulseAvgVolume: number;
  pullbackAvgVolume: number;
  volumeContracting: boolean;
  volume24h?: number;
  qualityTier?: QualityTier;

  // Higher timeframe trend (for multi-timeframe confirmation)
  higherTFBullish?: boolean;
}

// Symbol info from MEXC
export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed: boolean;
  isMarginTradingAllowed: boolean;
}

// Screening result for display
export interface ScreeningResult {
  symbol: string;
  timeframe: Timeframe;
  state: SetupState;
  rsi: number;
  priceChange: string;
  volumeRatio: string;
  impulseMove: string;
  detectedAgo: string;
}

// Configuration for the screener
export interface ScreenerConfig {
  timeframes: Timeframe[];
  rsiPeriod: number;
  // Long setups (oversold)
  rsiOversoldThreshold: number;
  rsiDeepOversoldThreshold: number;
  // Short setups (overbought)
  rsiOverboughtThreshold: number;
  rsiDeepOverboughtThreshold: number;
  minImpulsePercent: number;
  minVolume24h: number;
  volumeTiers: {
    bluechip: number;
    midcap: number;
    lowcap: number;
  };
  updateIntervalMs: number;
  maxConcurrentRequests: number;
  excludePatterns: RegExp[];
}

// MEXC API response types
export interface MEXCTickerResponse {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
}

export interface MEXCKlineResponse {
  0: number;  // Open time
  1: string;  // Open
  2: string;  // High
  3: string;  // Low
  4: string;  // Close
  5: string;  // Volume
  6: number;  // Close time
  7: string;  // Quote asset volume
}
