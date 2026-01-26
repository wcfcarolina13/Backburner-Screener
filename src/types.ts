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
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

// RSI calculation result
export interface RSIResult {
  value: number;
  timestamp: number;
}

// Setup direction
export type SetupDirection = 'long' | 'short';

// Market type
export type MarketType = 'spot' | 'futures';

// Liquidity risk level
export type LiquidityRisk = 'low' | 'medium' | 'high';

// Backburner setup state
export type SetupState =
  | 'watching'        // Had impulse move, waiting for RSI trigger
  | 'triggered'       // RSI just hit threshold - ACTIVE SETUP
  | 'deep_extreme'    // RSI at extreme levels (< 20 or > 80)
  | 'reversing'       // Price reversing from extreme
  | 'played_out';     // Setup completed or invalidated

// Signal classification - distinguishes true backburner from momentum exhaustion
export type SignalClassification =
  | 'backburner'           // True backburner: impulse opposite to RSI extreme (buy dips, fade bounces)
  | 'momentum_exhaustion'; // False positive: impulse same direction as RSI extreme (extended move)

// Momentum exhaustion direction
export type ExhaustionDirection =
  | 'extended_long'   // Pumped hard + overbought = extended to upside
  | 'extended_short'; // Dumped hard + oversold = extended to downside

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
  impulseSource?: 'htf' | 'ltf';  // Where the impulse was detected (HTF candles or LTF fallback)

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

  // CoinGecko data
  coinName?: string;         // Full name (e.g., "Bitcoin", "Ethereum")
  marketCap?: number;        // Market cap in USD
  marketCapRank?: number;    // CoinGecko ranking

  // Higher timeframe trend (for multi-timeframe confirmation)
  higherTFBullish?: boolean;
  htfConfirmed?: boolean;    // True if HTF trend aligns with setup direction

  // TCG-compliant structure-based stop loss
  // For longs: stop below pullback low (the low that RSI extreme occurred at)
  // For shorts: stop above bounce high (the high that RSI extreme occurred at)
  pullbackLow?: number;      // Lowest price during the pullback (for longs)
  bounceHigh?: number;       // Highest price during the bounce (for shorts)
  structureStopPrice?: number;  // Calculated stop price based on structure

  // RSI transition tracking (entry on cross, not just "is below")
  rsiCrossedThreshold?: boolean;  // Did RSI cross the threshold (30 or 70)?
  rsiCrossTime?: number;          // When did the cross happen?
  previousRSI?: number;           // RSI value before current (to detect cross)

  // Position building support
  rsiTrend?: 'dropping' | 'rising' | 'flat';  // Is RSI still worsening?
  canAddPosition?: boolean;   // Safe to add at RSI<20 (still dropping)?
  positionTier?: 1 | 2;       // Tier 1 = RSI<30, Tier 2 = RSI<20

  // Technical trailing - track swing lows/highs for structure-based trailing
  recentSwingLows?: { price: number; time: number }[];   // Last 3 swing lows
  recentSwingHighs?: { price: number; time: number }[];  // Last 3 swing highs

  // Market type and risk
  marketType: MarketType;    // spot or futures
  liquidityRisk: LiquidityRisk;  // low/medium/high based on volume

  // RSI-Price divergence (optional - strengthens the setup when present)
  divergence?: {
    type: 'bullish' | 'bearish' | 'hidden_bullish' | 'hidden_bearish';
    strength: 'strong' | 'moderate' | 'weak';
    description: string;
  };

  // Signal classification - distinguishes true backburner from momentum exhaustion
  // True backburner: impulse OPPOSITE to RSI extreme (buy dips after pump, fade bounces after dump)
  // Momentum exhaustion: impulse SAME direction as RSI extreme (coin is just extended)
  signalClassification?: SignalClassification;
  exhaustionDirection?: ExhaustionDirection;  // Only set if signalClassification === 'momentum_exhaustion'
}

// Momentum exhaustion signal - tracked separately for filtering
// These are NOT trade signals, they're warnings that a coin is extended
export interface MomentumExhaustionSignal {
  symbol: string;
  timeframe: Timeframe;
  direction: ExhaustionDirection;  // extended_long or extended_short
  impulsePercent: number;          // How much the coin moved
  currentRSI: number;              // Current RSI value
  currentPrice: number;
  detectedAt: number;              // When we first detected this
  lastUpdated: number;             // When we last confirmed it's still valid
  impulseStartPrice: number;       // Where the move started
  impulseEndPrice: number;         // Where the move ended (the extreme)
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
  minImpulseDominance: number; // 0-1, how "clean" the impulse must be
  minVolume24h: number;
  // Market cap filtering
  minMarketCap: number;
  requireMarketCap: boolean;
  // Quality tiers (now based on market cap)
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
