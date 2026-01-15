import type { Candle, Timeframe, BackburnerSetup, SetupState, SetupDirection } from './types.js';
import { DEFAULT_CONFIG } from './config.js';
import {
  calculateRSI,
  getCurrentRSI,
  calculateAvgVolume,
  findHighestHigh,
  findLowestLow,
  calculateFibonacciLevels,
  isInGoldenPocket,
  isInvalidated,
  getFibRetracementPercent,
  detectDivergence,
  type FibonacciLevels,
} from './indicators.js';

/**
 * Configuration for the Golden Pocket strategy
 */
export interface GoldenPocketConfig {
  // Impulse detection
  minImpulsePercent: number;      // Minimum % move to qualify as impulse (default: 5%)
  impulseLookbackCandles: number; // How many candles to look back for impulse (e.g., 12 for 60min on 5m)
  minRelativeVolume: number;      // Minimum relative volume vs 20-period avg (default: 3x)

  // Entry zone (Fibonacci levels)
  goldenPocketTop: number;        // 0.618
  goldenPocketBottom: number;     // 0.65
  invalidationLevel: number;      // 0.786

  // Take profit levels
  tp1Level: number;               // 0.382 (sell 50%)
  tp2Level: number;               // 0.0 (swing high retest, sell remaining 50%)
}

const DEFAULT_GOLDEN_POCKET_CONFIG: GoldenPocketConfig = {
  minImpulsePercent: 5,
  impulseLookbackCandles: 12,     // 12 candles = 60min on 5m, 3h on 15m
  minRelativeVolume: 3,
  goldenPocketTop: 0.618,
  goldenPocketBottom: 0.65,
  invalidationLevel: 0.786,
  tp1Level: 0.382,
  tp2Level: 0,
};

/**
 * Extended setup with Golden Pocket specific data
 */
export interface GoldenPocketSetup extends BackburnerSetup {
  fibLevels: FibonacciLevels;
  retracementPercent: number;     // Current retracement level (0-100)
  relativeVolume: number;         // Impulse volume vs average
  tp1Price: number;               // 0.382 level
  tp2Price: number;               // Swing high (0.0 level)
  stopPrice: number;              // 0.786 level
}

/**
 * Golden Pocket Detector
 *
 * Targets "hype/pump" assets with sudden volatility spikes.
 * Strategy:
 * 1. Detect rapid impulse moves (>5% in ~60 minutes with 3x volume)
 * 2. Calculate Fibonacci retracement levels
 * 3. Enter when price retraces to the Golden Pocket (0.618-0.65)
 * 4. Stop loss below 0.786 (invalidation)
 * 5. Take profit at 0.382 (50%) and swing high retest (50%)
 */
export class GoldenPocketDetector {
  private config: GoldenPocketConfig;
  private activeSetups: Map<string, GoldenPocketSetup> = new Map();

  constructor(config?: Partial<GoldenPocketConfig>) {
    this.config = { ...DEFAULT_GOLDEN_POCKET_CONFIG, ...config };
  }

  /**
   * Generate a unique key for a setup
   */
  private getSetupKey(symbol: string, timeframe: Timeframe, direction: SetupDirection): string {
    return `gp-${symbol}-${timeframe}-${direction}`;
  }

  /**
   * Analyze candles for Golden Pocket setups
   * Currently focuses on LONG setups (buying the dip after a pump)
   */
  analyzeSymbol(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    _higherTFCandles?: Candle[]
  ): BackburnerSetup[] {
    // Need enough candles for analysis
    const minCandles = Math.max(50, this.config.impulseLookbackCandles + 20);
    if (candles.length < minCandles) {
      return [];
    }

    const results: BackburnerSetup[] = [];

    // Check both directions for setups (long AND short)
    for (const direction of ['long', 'short'] as SetupDirection[]) {
      const key = this.getSetupKey(symbol, timeframe, direction);
      const existingSetup = this.activeSetups.get(key);

      if (existingSetup) {
        const updated = this.updateExistingSetup(existingSetup, candles);
        if (updated) {
          results.push(updated);
        }
      } else {
        // Try to detect a new setup for this direction
        const newSetup = this.detectNewSetup(symbol, timeframe, candles, direction);
        if (newSetup) {
          results.push(newSetup);
        }
      }
    }

    return results;
  }

  /**
   * Detect a new Golden Pocket setup for a specific direction
   */
  private detectNewSetup(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    direction: SetupDirection
  ): GoldenPocketSetup | null {
    // Step 1: Find recent impulse move in the lookback window
    const impulse = this.detectRecentImpulse(candles);
    if (!impulse) {
      return null;
    }

    // Check direction matches impulse
    // LONG: Requires UP impulse (buy the dip after pump)
    // SHORT: Requires DOWN impulse (short the bounce after dump)
    if (direction === 'long' && impulse.direction !== 'up') {
      return null;
    }
    if (direction === 'short' && impulse.direction !== 'down') {
      return null;
    }

    // Step 2: Calculate volume during impulse vs average
    const impulseCandles = candles.slice(impulse.startIndex, impulse.endIndex + 1);
    const avgVolume20 = calculateAvgVolume(candles.slice(-40, -20), 20);
    const impulseVolume = calculateAvgVolume(impulseCandles, impulseCandles.length);
    const relativeVolume = avgVolume20 > 0 ? impulseVolume / avgVolume20 : 0;

    // Must have elevated volume (3x default)
    if (relativeVolume < this.config.minRelativeVolume) {
      return null;
    }

    // Step 3: Calculate Fibonacci levels
    const fibLevels = calculateFibonacciLevels(
      impulse.high,
      impulse.low,
      impulse.direction
    );

    // Step 4: Check if current price is in the Golden Pocket
    const currentPrice = candles[candles.length - 1].close;
    const retracementPercent = getFibRetracementPercent(currentPrice, fibLevels);

    // Check if price is approaching or in the Golden Pocket
    const inGoldenPocket = isInGoldenPocket(currentPrice, fibLevels);
    const isApproaching = retracementPercent >= 50 && retracementPercent < 61.8;
    const isInvalidatedNow = isInvalidated(currentPrice, fibLevels);

    if (isInvalidatedNow) {
      return null; // Already broke the 0.786 level
    }

    // Calculate RSI for additional context
    const currentRSI = getCurrentRSI(candles, 14) || 50;

    // Check for RSI-price divergence that aligns with the setup direction
    const rsiValues = calculateRSI(candles, 14);
    const rsiResultsForDivergence = rsiValues.map(r => ({
      value: r.value,
      timestamp: r.timestamp,
    }));
    const divergenceResult = detectDivergence(candles, rsiResultsForDivergence, 50, 3);

    // Only include divergence if it supports the setup direction
    let setupDivergence: BackburnerSetup['divergence'] = undefined;
    if (divergenceResult) {
      const isBullishDiv = divergenceResult.type === 'bullish' || divergenceResult.type === 'hidden_bullish';
      const isBearishDiv = divergenceResult.type === 'bearish' || divergenceResult.type === 'hidden_bearish';

      if ((direction === 'long' && isBullishDiv) || (direction === 'short' && isBearishDiv)) {
        setupDivergence = {
          type: divergenceResult.type!,
          strength: divergenceResult.strength,
          description: divergenceResult.description,
        };
      }
    }

    // Determine setup state based on direction and RSI
    // IMPROVED: Now requires RSI confirmation for triggered state
    let state: SetupState;
    if (inGoldenPocket) {
      // In the entry zone - check RSI for confirmation
      if (direction === 'long') {
        // For longs: require RSI < 40 for triggered, < 30 for deep_extreme
        if (currentRSI < 30) {
          state = 'deep_extreme';
        } else if (currentRSI < 40) {
          state = 'triggered';
        } else {
          // RSI not oversold enough - just watch
          state = 'watching';
        }
      } else {
        // For shorts: require RSI > 60 for triggered, > 70 for deep_extreme
        if (currentRSI > 70) {
          state = 'deep_extreme';
        } else if (currentRSI > 60) {
          state = 'triggered';
        } else {
          // RSI not overbought enough - just watch
          state = 'watching';
        }
      }
    } else if (isApproaching) {
      // Approaching the zone - watch it
      state = 'watching';
    } else if (retracementPercent < 50) {
      // Not retraced enough yet
      return null;
    } else {
      // Between 63.5% and 85% - watching zone (was triggering before, now more conservative)
      state = 'watching';
    }

    // Only create setups that are at least watching
    if (state === 'watching' && retracementPercent < 45) {
      return null;
    }

    const now = Date.now();
    const isActionable = state === 'triggered' || state === 'deep_extreme';

    // Calculate TP and stop prices based on direction
    let tp1Price: number;
    let tp2Price: number;
    let stopPrice: number;

    if (direction === 'long') {
      // Long: TP1 at 0.382 (partial), TP2 at swing high (0.0), stop at 0.85 (wider)
      tp1Price = fibLevels.level382;
      tp2Price = fibLevels.high;
      stopPrice = fibLevels.invalidationLevel;  // Now at 0.85 for better R:R
    } else {
      // Short: TP1 at 0.382 (partial), TP2 at swing low (0.0), stop at 0.85 (wider)
      tp1Price = fibLevels.level382;
      tp2Price = fibLevels.low;
      stopPrice = fibLevels.invalidationLevel;  // Now at 0.85 for better R:R
    }

    const setup: GoldenPocketSetup = {
      symbol,
      timeframe,
      direction,
      state,

      // Impulse details
      impulseHigh: impulse.high,
      impulseLow: impulse.low,
      impulseStartTime: candles[impulse.startIndex].timestamp,
      impulseEndTime: candles[impulse.endIndex].timestamp,
      impulsePercentMove: impulse.percentMove,

      // RSI
      currentRSI,
      rsiAtTrigger: isActionable ? currentRSI : undefined,

      // Prices
      currentPrice,
      entryPrice: isActionable ? currentPrice : undefined,

      // Timing
      detectedAt: now,
      triggeredAt: isActionable ? now : undefined,
      lastUpdated: now,

      // Volume
      impulseAvgVolume: impulseVolume,
      pullbackAvgVolume: calculateAvgVolume(candles.slice(impulse.endIndex + 1), 10),
      volumeContracting: true, // Typically want low volume on retracement
      relativeVolume,

      // Golden Pocket specific
      fibLevels,
      retracementPercent,
      tp1Price,
      tp2Price,
      stopPrice,

      // Divergence
      divergence: setupDivergence,

      // Default metadata (will be set by screener)
      marketType: 'futures',
      liquidityRisk: 'high', // Hype coins are typically high risk
    };

    this.activeSetups.set(this.getSetupKey(symbol, timeframe, direction), setup);
    return setup;
  }

  /**
   * Detect a recent impulse move within the lookback window
   */
  private detectRecentImpulse(
    candles: Candle[]
  ): {
    startIndex: number;
    endIndex: number;
    high: number;
    low: number;
    percentMove: number;
    direction: 'up' | 'down';
  } | null {
    // Look at recent candles for the impulse
    const lookbackStart = Math.max(0, candles.length - this.config.impulseLookbackCandles - 10);
    const recentCandles = candles.slice(lookbackStart);

    // Find swing high and low in recent window
    const highResult = findHighestHigh(recentCandles);
    const lowResult = findLowestLow(recentCandles);

    // Adjust indices to full candle array
    const highIndex = lookbackStart + highResult.index;
    const lowIndex = lookbackStart + lowResult.index;

    // Calculate percent move
    const percentMove = ((highResult.price - lowResult.price) / lowResult.price) * 100;

    // Must meet minimum impulse threshold
    if (percentMove < this.config.minImpulsePercent) {
      return null;
    }

    // Determine direction based on which came first
    if (lowIndex < highIndex) {
      // Low came first = UP impulse (what we want for long setups)
      return {
        startIndex: lowIndex,
        endIndex: highIndex,
        high: highResult.price,
        low: lowResult.price,
        percentMove,
        direction: 'up',
      };
    } else {
      // High came first = DOWN impulse (for short setups)
      return {
        startIndex: highIndex,
        endIndex: lowIndex,
        high: highResult.price,
        low: lowResult.price,
        percentMove,
        direction: 'down',
      };
    }
  }

  /**
   * Update an existing setup
   */
  private updateExistingSetup(
    setup: GoldenPocketSetup,
    candles: Candle[]
  ): GoldenPocketSetup | null {
    const currentPrice = candles[candles.length - 1].close;
    const currentRSI = getCurrentRSI(candles, 14) || 50;

    // Update basic fields
    setup.currentPrice = currentPrice;
    setup.currentRSI = currentRSI;
    setup.lastUpdated = Date.now();
    setup.retracementPercent = getFibRetracementPercent(currentPrice, setup.fibLevels);

    // Update divergence detection
    const rsiValues = calculateRSI(candles, 14);
    const rsiResultsForDivergence = rsiValues.map(r => ({
      value: r.value,
      timestamp: r.timestamp,
    }));
    const divergenceResult = detectDivergence(candles, rsiResultsForDivergence, 50, 3);

    if (divergenceResult) {
      const isBullishDiv = divergenceResult.type === 'bullish' || divergenceResult.type === 'hidden_bullish';
      const isBearishDiv = divergenceResult.type === 'bearish' || divergenceResult.type === 'hidden_bearish';

      if ((setup.direction === 'long' && isBullishDiv) || (setup.direction === 'short' && isBearishDiv)) {
        setup.divergence = {
          type: divergenceResult.type!,
          strength: divergenceResult.strength,
          description: divergenceResult.description,
        };
      } else {
        setup.divergence = undefined;
      }
    } else {
      setup.divergence = undefined;
    }

    const key = this.getSetupKey(setup.symbol, setup.timeframe, setup.direction);

    // Check for invalidation (broke past 0.786)
    if (isInvalidated(currentPrice, setup.fibLevels)) {
      setup.state = 'played_out';
      setup.playedOutAt = Date.now();
      this.activeSetups.delete(key);
      return setup;
    }

    // Check for target reached based on direction
    if (setup.direction === 'long') {
      // Long target: back to swing high
      if (currentPrice >= setup.fibLevels.high * 0.995) {
        setup.state = 'played_out';
        setup.playedOutAt = Date.now();
        this.activeSetups.delete(key);
        return setup;
      }
    } else {
      // Short target: back to swing low
      if (currentPrice <= setup.fibLevels.low * 1.005) {
        setup.state = 'played_out';
        setup.playedOutAt = Date.now();
        this.activeSetups.delete(key);
        return setup;
      }
    }

    // Update state based on current position
    const inGoldenPocket = isInGoldenPocket(currentPrice, setup.fibLevels);

    if (inGoldenPocket) {
      // Determine deep extreme based on direction
      if (setup.direction === 'long') {
        setup.state = currentRSI < 30 ? 'deep_extreme' : 'triggered';
      } else {
        setup.state = currentRSI > 70 ? 'deep_extreme' : 'triggered';
      }
      if (!setup.triggeredAt) {
        setup.triggeredAt = Date.now();
        setup.rsiAtTrigger = currentRSI;
        setup.entryPrice = currentPrice;
      }
    } else if (setup.retracementPercent < 61.8) {
      // Price moved out of the golden pocket toward target
      if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
        setup.state = 'reversing';
      }
    } else if (setup.retracementPercent > 65 && setup.retracementPercent < 78.6) {
      // Between golden pocket and invalidation - risky zone
      setup.state = 'reversing';
    }

    // Check if setup has played out (moved significantly toward target)
    if (setup.state === 'reversing' && setup.retracementPercent < 40) {
      setup.state = 'played_out';
      setup.playedOutAt = Date.now();
      this.activeSetups.delete(key);
      return setup;
    }

    this.activeSetups.set(key, setup);
    return setup;
  }

  /**
   * Get all active setups
   */
  getActiveSetups(): GoldenPocketSetup[] {
    return Array.from(this.activeSetups.values());
  }

  /**
   * Remove a setup
   */
  removeSetup(symbol: string, timeframe: Timeframe, direction: SetupDirection): void {
    this.activeSetups.delete(this.getSetupKey(symbol, timeframe, direction));
  }

  /**
   * Clear all setups
   */
  clearAllSetups(): void {
    this.activeSetups.clear();
  }

  /**
   * Get count of active setups
   */
  getActiveSetupCount(): number {
    return this.activeSetups.size;
  }
}
