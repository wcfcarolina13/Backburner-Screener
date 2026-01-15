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
 * Configuration for the Golden Pocket V2 strategy
 * V2 uses LOOSENED thresholds for more frequent signals
 */
export interface GoldenPocketV2Config {
  // Impulse detection
  minImpulsePercent: number;      // Minimum % move to qualify as impulse
  impulseLookbackCandles: number; // How many candles to look back for impulse
  minRelativeVolume: number;      // Minimum relative volume vs 20-period avg

  // Entry zone (Fibonacci levels)
  goldenPocketTop: number;        // 0.618
  goldenPocketBottom: number;     // 0.65
  invalidationLevel: number;      // 0.786

  // RSI thresholds - V2 LOOSENED
  longTriggeredRSI: number;       // RSI below this for long triggered (v1: 40, v2: 50)
  longDeepExtremeRSI: number;     // RSI below this for long deep_extreme (v1: 30, v2: 35)
  shortTriggeredRSI: number;      // RSI above this for short triggered (v1: 60, v2: 50)
  shortDeepExtremeRSI: number;    // RSI above this for short deep_extreme (v1: 70, v2: 65)

  // Take profit levels
  tp1Level: number;               // 0.382 (sell 50%)
  tp2Level: number;               // 0.0 (swing high retest, sell remaining 50%)
}

const DEFAULT_V2_CONFIG: GoldenPocketV2Config = {
  // Impulse detection - slightly relaxed
  minImpulsePercent: 4,           // 4% move (v1: 5%)
  impulseLookbackCandles: 15,     // 15 candles (v1: 12) - wider lookback
  minRelativeVolume: 1.5,         // 1.5x volume (v1: 2x) - more permissive

  // Entry zone unchanged
  goldenPocketTop: 0.618,
  goldenPocketBottom: 0.65,
  invalidationLevel: 0.786,

  // RSI thresholds - LOOSENED for more signals
  longTriggeredRSI: 50,           // v1: 40 - now triggers at RSI < 50
  longDeepExtremeRSI: 35,         // v1: 30 - now deep at RSI < 35
  shortTriggeredRSI: 50,          // v1: 60 - now triggers at RSI > 50
  shortDeepExtremeRSI: 65,        // v1: 70 - now deep at RSI > 65

  // Take profit unchanged
  tp1Level: 0.382,
  tp2Level: 0,
};

/**
 * Extended setup with Golden Pocket V2 specific data
 */
export interface GoldenPocketV2Setup extends BackburnerSetup {
  fibLevels: FibonacciLevels;
  retracementPercent: number;
  relativeVolume: number;
  tp1Price: number;
  tp2Price: number;
  stopPrice: number;
  isV2: true;  // Flag to identify V2 setups
}

/**
 * Golden Pocket Detector V2
 *
 * Same strategy as V1 but with LOOSENED thresholds:
 * - Lower impulse requirement (4% vs 5%)
 * - Lower volume requirement (1.5x vs 2x)
 * - More permissive RSI thresholds for triggering
 *
 * Purpose: Compare signal quality vs V1 (strict) over time
 */
export class GoldenPocketDetectorV2 {
  private config: GoldenPocketV2Config;
  private activeSetups: Map<string, GoldenPocketV2Setup> = new Map();

  constructor(config?: Partial<GoldenPocketV2Config>) {
    this.config = { ...DEFAULT_V2_CONFIG, ...config };
  }

  private getSetupKey(symbol: string, timeframe: Timeframe, direction: SetupDirection): string {
    return `gp2-${symbol}-${timeframe}-${direction}`;
  }

  analyzeSymbol(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    _higherTFCandles?: Candle[]
  ): BackburnerSetup[] {
    const minCandles = Math.max(50, this.config.impulseLookbackCandles + 20);
    if (candles.length < minCandles) {
      return [];
    }

    const results: BackburnerSetup[] = [];

    // Check both directions
    for (const direction of ['long', 'short'] as SetupDirection[]) {
      const key = this.getSetupKey(symbol, timeframe, direction);
      const existingSetup = this.activeSetups.get(key);

      if (existingSetup) {
        const updated = this.updateExistingSetup(existingSetup, candles);
        if (updated) {
          results.push(updated);
        }
      } else {
        const newSetup = this.detectNewSetup(symbol, timeframe, candles, direction);
        if (newSetup) {
          results.push(newSetup);
        }
      }
    }

    return results;
  }

  private detectNewSetup(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    direction: SetupDirection
  ): GoldenPocketV2Setup | null {
    const impulse = this.detectRecentImpulse(candles);
    if (!impulse) {
      return null;
    }

    // Check direction matches impulse
    if (direction === 'long' && impulse.direction !== 'up') return null;
    if (direction === 'short' && impulse.direction !== 'down') return null;

    // Calculate volume during impulse vs average
    const impulseCandles = candles.slice(impulse.startIndex, impulse.endIndex + 1);
    const avgVolume20 = calculateAvgVolume(candles.slice(-40, -20), 20);
    const impulseVolume = calculateAvgVolume(impulseCandles, impulseCandles.length);
    const relativeVolume = avgVolume20 > 0 ? impulseVolume / avgVolume20 : 0;

    // V2: Relaxed volume requirement (1.5x)
    if (relativeVolume < this.config.minRelativeVolume) {
      return null;
    }

    const fibLevels = calculateFibonacciLevels(
      impulse.high,
      impulse.low,
      impulse.direction
    );

    const currentPrice = candles[candles.length - 1].close;
    const retracementPercent = getFibRetracementPercent(currentPrice, fibLevels);

    const inGoldenPocket = isInGoldenPocket(currentPrice, fibLevels);
    const isApproaching = retracementPercent >= 50 && retracementPercent < 61.8;
    const isInvalidatedNow = isInvalidated(currentPrice, fibLevels);

    if (isInvalidatedNow) {
      return null;
    }

    const currentRSI = getCurrentRSI(candles, 14) || 50;

    // Check for divergence
    const rsiValues = calculateRSI(candles, 14);
    const rsiResultsForDivergence = rsiValues.map(r => ({
      value: r.value,
      timestamp: r.timestamp,
    }));
    const divergenceResult = detectDivergence(candles, rsiResultsForDivergence, 50, 3);

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

    // V2: LOOSENED RSI thresholds
    let state: SetupState;
    if (inGoldenPocket) {
      if (direction === 'long') {
        // V2: RSI < 50 for triggered (v1: < 40), < 35 for deep (v1: < 30)
        if (currentRSI < this.config.longDeepExtremeRSI) {
          state = 'deep_extreme';
        } else if (currentRSI < this.config.longTriggeredRSI) {
          state = 'triggered';
        } else {
          state = 'watching';
        }
      } else {
        // V2: RSI > 50 for triggered (v1: > 60), > 65 for deep (v1: > 70)
        if (currentRSI > this.config.shortDeepExtremeRSI) {
          state = 'deep_extreme';
        } else if (currentRSI > this.config.shortTriggeredRSI) {
          state = 'triggered';
        } else {
          state = 'watching';
        }
      }
    } else if (isApproaching) {
      state = 'watching';
    } else if (retracementPercent < 50) {
      return null;
    } else {
      state = 'watching';
    }

    if (state === 'watching' && retracementPercent < 45) {
      return null;
    }

    const now = Date.now();
    const isActionable = state === 'triggered' || state === 'deep_extreme';

    let tp1Price: number;
    let tp2Price: number;
    let stopPrice: number;

    if (direction === 'long') {
      tp1Price = fibLevels.level382;
      tp2Price = fibLevels.high;
      stopPrice = fibLevels.invalidationLevel;
    } else {
      tp1Price = fibLevels.level382;
      tp2Price = fibLevels.low;
      stopPrice = fibLevels.invalidationLevel;
    }

    const setup: GoldenPocketV2Setup = {
      symbol,
      timeframe,
      direction,
      state,
      impulseHigh: impulse.high,
      impulseLow: impulse.low,
      impulseStartTime: candles[impulse.startIndex].timestamp,
      impulseEndTime: candles[impulse.endIndex].timestamp,
      impulsePercentMove: impulse.percentMove,
      currentRSI,
      rsiAtTrigger: isActionable ? currentRSI : undefined,
      currentPrice,
      entryPrice: isActionable ? currentPrice : undefined,
      detectedAt: now,
      triggeredAt: isActionable ? now : undefined,
      lastUpdated: now,
      impulseAvgVolume: impulseVolume,
      pullbackAvgVolume: calculateAvgVolume(candles.slice(impulse.endIndex + 1), 10),
      volumeContracting: true,
      relativeVolume,
      fibLevels,
      retracementPercent,
      tp1Price,
      tp2Price,
      stopPrice,
      divergence: setupDivergence,
      marketType: 'futures',
      liquidityRisk: 'high',
      isV2: true,
    };

    this.activeSetups.set(this.getSetupKey(symbol, timeframe, direction), setup);
    return setup;
  }

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
    const lookbackStart = Math.max(0, candles.length - this.config.impulseLookbackCandles - 10);
    const recentCandles = candles.slice(lookbackStart);

    const highResult = findHighestHigh(recentCandles);
    const lowResult = findLowestLow(recentCandles);

    const highIndex = lookbackStart + highResult.index;
    const lowIndex = lookbackStart + lowResult.index;

    const percentMove = ((highResult.price - lowResult.price) / lowResult.price) * 100;

    // V2: Relaxed impulse requirement (4%)
    if (percentMove < this.config.minImpulsePercent) {
      return null;
    }

    if (lowIndex < highIndex) {
      return {
        startIndex: lowIndex,
        endIndex: highIndex,
        high: highResult.price,
        low: lowResult.price,
        percentMove,
        direction: 'up',
      };
    } else {
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

  private updateExistingSetup(
    setup: GoldenPocketV2Setup,
    candles: Candle[]
  ): GoldenPocketV2Setup | null {
    const currentPrice = candles[candles.length - 1].close;
    const currentRSI = getCurrentRSI(candles, 14) || 50;

    setup.currentPrice = currentPrice;
    setup.currentRSI = currentRSI;
    setup.lastUpdated = Date.now();
    setup.retracementPercent = getFibRetracementPercent(currentPrice, setup.fibLevels);

    const key = this.getSetupKey(setup.symbol, setup.timeframe, setup.direction);

    if (isInvalidated(currentPrice, setup.fibLevels)) {
      setup.state = 'played_out';
      setup.playedOutAt = Date.now();
      this.activeSetups.delete(key);
      return setup;
    }

    if (setup.direction === 'long') {
      if (currentPrice >= setup.fibLevels.high * 0.995) {
        setup.state = 'played_out';
        setup.playedOutAt = Date.now();
        this.activeSetups.delete(key);
        return setup;
      }
    } else {
      if (currentPrice <= setup.fibLevels.low * 1.005) {
        setup.state = 'played_out';
        setup.playedOutAt = Date.now();
        this.activeSetups.delete(key);
        return setup;
      }
    }

    const inGoldenPocket = isInGoldenPocket(currentPrice, setup.fibLevels);

    if (inGoldenPocket) {
      // V2 thresholds
      if (setup.direction === 'long') {
        setup.state = currentRSI < this.config.longDeepExtremeRSI ? 'deep_extreme' : 'triggered';
      } else {
        setup.state = currentRSI > this.config.shortDeepExtremeRSI ? 'deep_extreme' : 'triggered';
      }
      if (!setup.triggeredAt) {
        setup.triggeredAt = Date.now();
        setup.rsiAtTrigger = currentRSI;
        setup.entryPrice = currentPrice;
      }
    } else if (setup.retracementPercent < 61.8) {
      if (setup.state === 'triggered' || setup.state === 'deep_extreme') {
        setup.state = 'reversing';
      }
    } else if (setup.retracementPercent > 65 && setup.retracementPercent < 78.6) {
      setup.state = 'reversing';
    }

    if (setup.state === 'reversing' && setup.retracementPercent < 40) {
      setup.state = 'played_out';
      setup.playedOutAt = Date.now();
      this.activeSetups.delete(key);
      return setup;
    }

    this.activeSetups.set(key, setup);
    return setup;
  }

  getActiveSetups(): GoldenPocketV2Setup[] {
    return Array.from(this.activeSetups.values());
  }

  removeSetup(symbol: string, timeframe: Timeframe, direction: SetupDirection): void {
    this.activeSetups.delete(this.getSetupKey(symbol, timeframe, direction));
  }

  clearAllSetups(): void {
    this.activeSetups.clear();
  }

  getActiveSetupCount(): number {
    return this.activeSetups.size;
  }
}
