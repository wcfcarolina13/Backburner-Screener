import type { Candle, RSIResult } from './types.js';

/**
 * Fibonacci retracement levels for a price range
 */
export interface FibonacciLevels {
  // For upward impulse: high is 0.0, low is 1.0
  // For downward impulse: low is 0.0, high is 1.0
  high: number;
  low: number;
  direction: 'up' | 'down';

  // Standard Fibonacci retracement levels
  level236: number;  // 23.6% retracement
  level382: number;  // 38.2% retracement (first TP for longs)
  level500: number;  // 50% retracement
  level618: number;  // 61.8% retracement (Golden Pocket top)
  level650: number;  // 65% retracement (Golden Pocket middle)
  level786: number;  // 78.6% retracement (invalidation level)

  // Golden Pocket zone
  goldenPocketTop: number;     // 0.618 level
  goldenPocketBottom: number;  // 0.65 level
  invalidationLevel: number;   // 0.786 level
}

/**
 * Calculate Fibonacci retracement levels from a swing high/low
 * For LONG setups (upward impulse): retracement is from high back toward low
 * For SHORT setups (downward impulse): retracement is from low back toward high
 */
export function calculateFibonacciLevels(
  high: number,
  low: number,
  direction: 'up' | 'down'
): FibonacciLevels {
  const range = high - low;

  if (direction === 'up') {
    // For upward impulse, retracement goes DOWN from high toward low
    // 0.0 = swing high (start of retracement)
    // 1.0 = swing low (full retracement)
    return {
      high,
      low,
      direction,
      level236: high - (range * 0.236),
      level382: high - (range * 0.382),
      level500: high - (range * 0.500),
      level618: high - (range * 0.618),
      level650: high - (range * 0.650),
      level786: high - (range * 0.786),
      goldenPocketTop: high - (range * 0.618),
      goldenPocketBottom: high - (range * 0.650),
      invalidationLevel: high - (range * 0.786),
    };
  } else {
    // For downward impulse, retracement goes UP from low toward high
    // 0.0 = swing low (start of retracement)
    // 1.0 = swing high (full retracement)
    return {
      high,
      low,
      direction,
      level236: low + (range * 0.236),
      level382: low + (range * 0.382),
      level500: low + (range * 0.500),
      level618: low + (range * 0.618),
      level650: low + (range * 0.650),
      level786: low + (range * 0.786),
      goldenPocketTop: low + (range * 0.618),
      goldenPocketBottom: low + (range * 0.650),
      invalidationLevel: low + (range * 0.786),
    };
  }
}

/**
 * Check if price is in the Golden Pocket zone (0.618 - 0.65)
 */
export function isInGoldenPocket(
  price: number,
  fibLevels: FibonacciLevels
): boolean {
  if (fibLevels.direction === 'up') {
    // For longs: price should be between 0.618 and 0.65 (below the top)
    return price <= fibLevels.goldenPocketTop && price >= fibLevels.goldenPocketBottom;
  } else {
    // For shorts: price should be between 0.618 and 0.65 (above the bottom)
    return price >= fibLevels.goldenPocketTop && price <= fibLevels.goldenPocketBottom;
  }
}

/**
 * Check if price has broken the invalidation level (0.786)
 */
export function isInvalidated(
  price: number,
  fibLevels: FibonacciLevels
): boolean {
  if (fibLevels.direction === 'up') {
    // For longs: invalidated if price closes below 0.786
    return price < fibLevels.invalidationLevel;
  } else {
    // For shorts: invalidated if price closes above 0.786
    return price > fibLevels.invalidationLevel;
  }
}

/**
 * Calculate where price is relative to Fibonacci levels
 * Returns the retracement percentage (0 = swing high/low, 100 = swing low/high)
 */
export function getFibRetracementPercent(
  price: number,
  fibLevels: FibonacciLevels
): number {
  const range = fibLevels.high - fibLevels.low;
  if (range === 0) return 0;

  if (fibLevels.direction === 'up') {
    // For upward impulse, measure how far price has retraced from high
    return ((fibLevels.high - price) / range) * 100;
  } else {
    // For downward impulse, measure how far price has retraced from low
    return ((price - fibLevels.low) / range) * 100;
  }
}

/**
 * Calculate RSI (Relative Strength Index)
 * Uses Wilder's smoothing method (exponential moving average)
 */
export function calculateRSI(candles: Candle[], period = 14): RSIResult[] {
  if (candles.length < period + 1) {
    return [];
  }

  const results: RSIResult[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate price changes
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  // Calculate initial average gain and loss
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // First RSI value
  if (avgLoss === 0) {
    results.push({ value: 100, timestamp: candles[period].timestamp });
  } else {
    const rs = avgGain / avgLoss;
    results.push({ value: 100 - (100 / (1 + rs)), timestamp: candles[period].timestamp });
  }

  // Calculate subsequent RSI values using Wilder's smoothing
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      results.push({ value: 100, timestamp: candles[i + 1].timestamp });
    } else {
      const rs = avgGain / avgLoss;
      results.push({ value: 100 - (100 / (1 + rs)), timestamp: candles[i + 1].timestamp });
    }
  }

  return results;
}

/**
 * Get the current (most recent) RSI value
 */
export function getCurrentRSI(candles: Candle[], period = 14): number | null {
  const rsiValues = calculateRSI(candles, period);
  if (rsiValues.length === 0) return null;
  return rsiValues[rsiValues.length - 1].value;
}

/**
 * Calculate Simple Moving Average
 */
export function calculateSMA(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

/**
 * Calculate Exponential Moving Average
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Start with SMA for first value
  const sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(sma);

  // Calculate EMA for remaining values
  for (let i = period; i < values.length; i++) {
    const ema = (values[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
    result.push(ema);
  }

  return result;
}

/**
 * Calculate Average Volume over a period
 */
export function calculateAvgVolume(candles: Candle[], period: number): number {
  if (candles.length < period) {
    return candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  }
  const recentCandles = candles.slice(-period);
  return recentCandles.reduce((sum, c) => sum + c.volume, 0) / period;
}

/**
 * Find the highest high in a range of candles
 */
export function findHighestHigh(candles: Candle[]): { price: number; index: number; timestamp: number } {
  let highest = candles[0];
  let highestIndex = 0;

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > highest.high) {
      highest = candles[i];
      highestIndex = i;
    }
  }

  return {
    price: highest.high,
    index: highestIndex,
    timestamp: highest.timestamp,
  };
}

/**
 * Find the lowest low in a range of candles
 */
export function findLowestLow(candles: Candle[]): { price: number; index: number; timestamp: number } {
  let lowest = candles[0];
  let lowestIndex = 0;

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].low < lowest.low) {
      lowest = candles[i];
      lowestIndex = i;
    }
  }

  return {
    price: lowest.low,
    index: lowestIndex,
    timestamp: lowest.timestamp,
  };
}

/**
 * Detect if there was a significant impulse move
 * Returns the impulse details if found, null otherwise
 */
export function detectImpulseMove(
  candles: Candle[],
  minPercentMove: number,
  lookbackPeriod = 50
): {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  percentMove: number;
  direction: 'up' | 'down';
} | null {
  if (candles.length < lookbackPeriod) return null;

  const recentCandles = candles.slice(-lookbackPeriod);

  // Find significant swing points
  const highest = findHighestHigh(recentCandles);
  const lowest = findLowestLow(recentCandles);

  // Determine if we had an upward impulse (for long setups)
  // The high should come AFTER the low for an upward impulse
  if (highest.index > lowest.index) {
    const percentMove = ((highest.price - lowest.price) / lowest.price) * 100;

    if (percentMove >= minPercentMove) {
      return {
        startIndex: lowest.index,
        endIndex: highest.index,
        startPrice: lowest.price,
        endPrice: highest.price,
        percentMove,
        direction: 'up',
      };
    }
  }

  // Check for downward impulse (for short setups)
  if (lowest.index > highest.index) {
    const percentMove = ((highest.price - lowest.price) / highest.price) * 100;

    if (percentMove >= minPercentMove) {
      return {
        startIndex: highest.index,
        endIndex: lowest.index,
        startPrice: highest.price,
        endPrice: lowest.price,
        percentMove,
        direction: 'down',
      };
    }
  }

  return null;
}

/**
 * Check if volume is contracting during pullback
 */
export function isVolumeContracting(
  impulseCandles: Candle[],
  pullbackCandles: Candle[]
): boolean {
  if (impulseCandles.length === 0 || pullbackCandles.length === 0) {
    return false;
  }

  const impulseAvgVol = impulseCandles.reduce((sum, c) => sum + c.volume, 0) / impulseCandles.length;
  const pullbackAvgVol = pullbackCandles.reduce((sum, c) => sum + c.volume, 0) / pullbackCandles.length;

  // Volume should be lower during pullback
  return pullbackAvgVol < impulseAvgVol * 0.8; // At least 20% lower
}

/**
 * Check if RSI just crossed below a threshold
 * Returns true if RSI was above threshold and is now below
 */
export function rsiJustCrossedBelow(
  rsiValues: RSIResult[],
  threshold: number,
  lookback = 3
): boolean {
  if (rsiValues.length < lookback + 1) return false;

  const recent = rsiValues.slice(-lookback);
  const current = recent[recent.length - 1].value;

  // Check if current is below threshold and at least one recent was above
  if (current >= threshold) return false;

  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].value >= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Determine higher timeframe trend direction
 * Simple implementation: compare current price to SMA
 */
export function isHigherTFBullish(candles: Candle[], smaPeriod = 20): boolean {
  if (candles.length < smaPeriod) return false;

  const closes = candles.map(c => c.close);
  const sma = calculateSMA(closes, smaPeriod);

  if (sma.length === 0) return false;

  const currentPrice = candles[candles.length - 1].close;
  const currentSMA = sma[sma.length - 1];

  return currentPrice > currentSMA;
}

/**
 * Divergence types
 */
export type DivergenceType =
  | 'bullish'        // Price lower low, RSI higher low - reversal signal
  | 'bearish'        // Price higher high, RSI lower high - reversal signal
  | 'hidden_bullish' // Price higher low, RSI lower low - continuation signal
  | 'hidden_bearish' // Price lower high, RSI higher high - continuation signal
  | null;

export interface DivergenceResult {
  type: DivergenceType;
  strength: 'strong' | 'moderate' | 'weak';
  priceSwing1: { value: number; index: number; timestamp: number };
  priceSwing2: { value: number; index: number; timestamp: number };
  rsiSwing1: { value: number; index: number; timestamp: number };
  rsiSwing2: { value: number; index: number; timestamp: number };
  description: string;
}

/**
 * Find swing highs in a data series
 * A swing high is a point higher than N bars on each side
 */
function findSwingHighs(
  data: { value: number; timestamp: number }[],
  lookback: number = 5
): { value: number; index: number; timestamp: number }[] {
  const swings: { value: number; index: number; timestamp: number }[] = [];

  for (let i = lookback; i < data.length - lookback; i++) {
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i].value <= data[i - j].value || data[i].value <= data[i + j].value) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swings.push({ value: data[i].value, index: i, timestamp: data[i].timestamp });
    }
  }

  return swings;
}

/**
 * Find swing lows in a data series
 * A swing low is a point lower than N bars on each side
 */
function findSwingLows(
  data: { value: number; timestamp: number }[],
  lookback: number = 5
): { value: number; index: number; timestamp: number }[] {
  const swings: { value: number; index: number; timestamp: number }[] = [];

  for (let i = lookback; i < data.length - lookback; i++) {
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i].value >= data[i - j].value || data[i].value >= data[i + j].value) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swings.push({ value: data[i].value, index: i, timestamp: data[i].timestamp });
    }
  }

  return swings;
}

/**
 * Detect RSI-Price divergences
 * Looks for the most recent divergence within the lookback period
 */
export function detectDivergence(
  candles: Candle[],
  rsiValues: RSIResult[],
  lookbackBars: number = 50,
  swingLookback: number = 3  // Reduced from 5 to find more swing points
): DivergenceResult | null {
  if (candles.length < lookbackBars || rsiValues.length < lookbackBars) {
    return null;
  }

  // Get recent data
  const recentCandles = candles.slice(-lookbackBars);
  const recentRSI = rsiValues.slice(-lookbackBars);

  // Convert candles to price data for swing detection
  const priceHighs = recentCandles.map((c, i) => ({ value: c.high, timestamp: c.timestamp }));
  const priceLows = recentCandles.map((c, i) => ({ value: c.low, timestamp: c.timestamp }));
  const rsiData = recentRSI.map(r => ({ value: r.value, timestamp: r.timestamp }));

  // Find swing points
  const priceSwingHighs = findSwingHighs(priceHighs, swingLookback);
  const priceSwingLows = findSwingLows(priceLows, swingLookback);
  const rsiSwingHighs = findSwingHighs(rsiData, swingLookback);
  const rsiSwingLows = findSwingLows(rsiData, swingLookback);

  // Need at least 2 swing points to compare
  if (priceSwingHighs.length < 2 && priceSwingLows.length < 2) {
    return null;
  }

  // Check for bearish divergence (price higher high, RSI lower high)
  if (priceSwingHighs.length >= 2 && rsiSwingHighs.length >= 2) {
    const [prevPriceHigh, currPriceHigh] = priceSwingHighs.slice(-2);
    const [prevRsiHigh, currRsiHigh] = rsiSwingHighs.slice(-2);

    // Price made higher high but RSI made lower high
    if (currPriceHigh.value > prevPriceHigh.value && currRsiHigh.value < prevRsiHigh.value) {
      const priceDiff = ((currPriceHigh.value - prevPriceHigh.value) / prevPriceHigh.value) * 100;
      const rsiDiff = prevRsiHigh.value - currRsiHigh.value;

      let strength: 'strong' | 'moderate' | 'weak' = 'weak';
      if (rsiDiff > 10 && priceDiff > 2) strength = 'strong';
      else if (rsiDiff > 5 || priceDiff > 1) strength = 'moderate';

      return {
        type: 'bearish',
        strength,
        priceSwing1: prevPriceHigh,
        priceSwing2: currPriceHigh,
        rsiSwing1: prevRsiHigh,
        rsiSwing2: currRsiHigh,
        description: `Bearish divergence: Price higher high (+${priceDiff.toFixed(1)}%), RSI lower high (-${rsiDiff.toFixed(1)})`,
      };
    }
  }

  // Check for bullish divergence (price lower low, RSI higher low)
  if (priceSwingLows.length >= 2 && rsiSwingLows.length >= 2) {
    const [prevPriceLow, currPriceLow] = priceSwingLows.slice(-2);
    const [prevRsiLow, currRsiLow] = rsiSwingLows.slice(-2);

    // Price made lower low but RSI made higher low
    if (currPriceLow.value < prevPriceLow.value && currRsiLow.value > prevRsiLow.value) {
      const priceDiff = ((prevPriceLow.value - currPriceLow.value) / prevPriceLow.value) * 100;
      const rsiDiff = currRsiLow.value - prevRsiLow.value;

      let strength: 'strong' | 'moderate' | 'weak' = 'weak';
      if (rsiDiff > 10 && priceDiff > 2) strength = 'strong';
      else if (rsiDiff > 5 || priceDiff > 1) strength = 'moderate';

      return {
        type: 'bullish',
        strength,
        priceSwing1: prevPriceLow,
        priceSwing2: currPriceLow,
        rsiSwing1: prevRsiLow,
        rsiSwing2: currRsiLow,
        description: `Bullish divergence: Price lower low (-${priceDiff.toFixed(1)}%), RSI higher low (+${rsiDiff.toFixed(1)})`,
      };
    }
  }

  // Check for hidden bearish (price lower high, RSI higher high) - continuation
  if (priceSwingHighs.length >= 2 && rsiSwingHighs.length >= 2) {
    const [prevPriceHigh, currPriceHigh] = priceSwingHighs.slice(-2);
    const [prevRsiHigh, currRsiHigh] = rsiSwingHighs.slice(-2);

    if (currPriceHigh.value < prevPriceHigh.value && currRsiHigh.value > prevRsiHigh.value) {
      const priceDiff = ((prevPriceHigh.value - currPriceHigh.value) / prevPriceHigh.value) * 100;
      const rsiDiff = currRsiHigh.value - prevRsiHigh.value;

      let strength: 'strong' | 'moderate' | 'weak' = 'weak';
      if (rsiDiff > 8 && priceDiff > 1.5) strength = 'strong';
      else if (rsiDiff > 4 || priceDiff > 0.75) strength = 'moderate';

      return {
        type: 'hidden_bearish',
        strength,
        priceSwing1: prevPriceHigh,
        priceSwing2: currPriceHigh,
        rsiSwing1: prevRsiHigh,
        rsiSwing2: currRsiHigh,
        description: `Hidden bearish: Price lower high (-${priceDiff.toFixed(1)}%), RSI higher high (+${rsiDiff.toFixed(1)}) - downtrend continuation`,
      };
    }
  }

  // Check for hidden bullish (price higher low, RSI lower low) - continuation
  if (priceSwingLows.length >= 2 && rsiSwingLows.length >= 2) {
    const [prevPriceLow, currPriceLow] = priceSwingLows.slice(-2);
    const [prevRsiLow, currRsiLow] = rsiSwingLows.slice(-2);

    if (currPriceLow.value > prevPriceLow.value && currRsiLow.value < prevRsiLow.value) {
      const priceDiff = ((currPriceLow.value - prevPriceLow.value) / prevPriceLow.value) * 100;
      const rsiDiff = prevRsiLow.value - currRsiLow.value;

      let strength: 'strong' | 'moderate' | 'weak' = 'weak';
      if (rsiDiff > 8 && priceDiff > 1.5) strength = 'strong';
      else if (rsiDiff > 4 || priceDiff > 0.75) strength = 'moderate';

      return {
        type: 'hidden_bullish',
        strength,
        priceSwing1: prevPriceLow,
        priceSwing2: currPriceLow,
        rsiSwing1: prevRsiLow,
        rsiSwing2: currRsiLow,
        description: `Hidden bullish: Price higher low (+${priceDiff.toFixed(1)}%), RSI lower low (-${rsiDiff.toFixed(1)}) - uptrend continuation`,
      };
    }
  }

  return null;
}
