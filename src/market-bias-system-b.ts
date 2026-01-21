/**
 * MARKET BIAS SYSTEM B - Multi-Indicator Bias
 *
 * This is an alternative to System A (RSI-only) for A/B testing.
 *
 * Indicators included:
 * 1. RSI Multi-Timeframe (same as System A)
 * 2. Funding Rate - Extreme funding suggests reversal
 * 3. Open Interest Change - Rising OI + price = trend strength
 * 4. Price vs Fair Price - Premium/discount to mark price
 * 5. Volume Profile - Unusual volume signals
 *
 * Each indicator contributes to an overall bias score.
 */

import { getBtcMarketData, getFundingRateHistory, type FuturesMarketData } from './mexc-api.js';

export type BiasLevel = 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short';

// Individual indicator signals
export interface IndicatorSignal {
  name: string;
  value: number;           // Raw value
  signal: 'bullish' | 'bearish' | 'neutral';
  strength: number;        // -100 to +100
  description: string;
}

// Complete bias analysis
export interface SystemBBiasResult {
  bias: BiasLevel;
  score: number;           // -100 to +100
  confidence: number;      // 0-100%
  reason: string;
  indicators: IndicatorSignal[];
  marketData: FuturesMarketData | null;
  timestamp: number;
}

// Historical data for tracking changes
interface HistoricalSnapshot {
  timestamp: number;
  openInterest: number;
  price: number;
  fundingRate: number;
}

class MarketBiasSystemB {
  private history: HistoricalSnapshot[] = [];
  private maxHistoryLength = 100;  // Keep last 100 snapshots
  private lastResult: SystemBBiasResult | null = null;

  /**
   * Calculate comprehensive market bias using multiple indicators
   */
  async calculateBias(rsiData?: Record<string, { rsi: number; signal: string }>): Promise<SystemBBiasResult> {
    const indicators: IndicatorSignal[] = [];
    const marketData = await getBtcMarketData();

    // 1. RSI Multi-Timeframe (if provided)
    if (rsiData) {
      const rsiSignal = this.analyzeRSI(rsiData);
      indicators.push(rsiSignal);
    }

    // 2. Funding Rate Analysis
    if (marketData) {
      const fundingSignal = await this.analyzeFundingRate(marketData.fundingRate);
      indicators.push(fundingSignal);

      // 3. Open Interest Analysis
      const oiSignal = this.analyzeOpenInterest(marketData);
      indicators.push(oiSignal);

      // 4. Price vs Fair Price (Premium/Discount)
      const premiumSignal = this.analyzePremiumDiscount(marketData);
      indicators.push(premiumSignal);

      // 5. 24h Price Change Momentum
      const momentumSignal = this.analyzeMomentum(marketData);
      indicators.push(momentumSignal);

      // Store snapshot for historical analysis
      this.addSnapshot({
        timestamp: Date.now(),
        openInterest: marketData.openInterest,
        price: marketData.lastPrice,
        fundingRate: marketData.fundingRate,
      });
    }

    // Calculate weighted score
    const weights: Record<string, number> = {
      'RSI Multi-TF': 3,
      'Funding Rate': 2,
      'Open Interest': 2,
      'Premium/Discount': 1,
      'Momentum': 1,
    };

    let totalWeight = 0;
    let weightedScore = 0;

    for (const indicator of indicators) {
      const weight = weights[indicator.name] || 1;
      weightedScore += indicator.strength * weight;
      totalWeight += weight;
    }

    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Determine bias level
    let bias: BiasLevel = 'neutral';
    let reason = '';

    // Check for strong consensus
    const bullishCount = indicators.filter(i => i.signal === 'bullish').length;
    const bearishCount = indicators.filter(i => i.signal === 'bearish').length;
    const consensusRatio = Math.max(bullishCount, bearishCount) / indicators.length;

    if (score > 50 && consensusRatio >= 0.6) {
      bias = 'strong_long';
      reason = `Strong bullish: ${bullishCount}/${indicators.length} indicators bullish`;
    } else if (score < -50 && consensusRatio >= 0.6) {
      bias = 'strong_short';
      reason = `Strong bearish: ${bearishCount}/${indicators.length} indicators bearish`;
    } else if (score > 25) {
      bias = 'long';
      reason = `Moderately bullish (score: ${score.toFixed(0)})`;
    } else if (score < -25) {
      bias = 'short';
      reason = `Moderately bearish (score: ${score.toFixed(0)})`;
    } else {
      bias = 'neutral';
      reason = 'Mixed signals - no clear bias';
    }

    // Calculate confidence based on indicator agreement
    const confidence = Math.min(100, consensusRatio * 100 + Math.abs(score) * 0.3);

    const result: SystemBBiasResult = {
      bias,
      score: Math.round(score),
      confidence: Math.round(confidence),
      reason,
      indicators,
      marketData,
      timestamp: Date.now(),
    };

    this.lastResult = result;
    return result;
  }

  /**
   * Analyze RSI across timeframes
   */
  private analyzeRSI(rsiData: Record<string, { rsi: number; signal: string }>): IndicatorSignal {
    const weights: Record<string, number> = {
      '4h': 3, '1h': 2, '15m': 1, '5m': 0.5, '1m': 0.25
    };

    let bullishScore = 0;
    let bearishScore = 0;
    let totalWeight = 0;

    for (const [tf, data] of Object.entries(rsiData)) {
      const weight = weights[tf] || 1;
      totalWeight += weight;

      if (data.signal === 'bullish') {
        bullishScore += weight;
      } else if (data.signal === 'bearish') {
        bearishScore += weight;
      }
    }

    const strength = totalWeight > 0
      ? ((bullishScore - bearishScore) / totalWeight) * 100
      : 0;

    return {
      name: 'RSI Multi-TF',
      value: strength,
      signal: strength > 20 ? 'bullish' : strength < -20 ? 'bearish' : 'neutral',
      strength,
      description: `RSI across ${Object.keys(rsiData).length} timeframes`,
    };
  }

  /**
   * Analyze funding rate for contrarian signals
   * Extreme positive funding = too many longs = bearish
   * Extreme negative funding = too many shorts = bullish
   */
  private async analyzeFundingRate(currentRate: number): Promise<IndicatorSignal> {
    // Get historical funding to understand context
    const history = await getFundingRateHistory('BTC_USDT', 10);
    const avgRate = history.length > 0
      ? history.reduce((sum, h) => sum + h.fundingRate, 0) / history.length
      : 0;

    // Convert to percentage for readability (0.0001 = 0.01%)
    const ratePercent = currentRate * 100;
    const avgPercent = avgRate * 100;

    // Extreme thresholds (in %)
    const extremePositive = 0.05;  // 0.05% = very positive
    const extremeNegative = -0.02; // -0.02% = very negative

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;
    let description = '';

    if (ratePercent > extremePositive) {
      // Very positive funding = shorts get paid, too many longs
      signal = 'bearish';
      strength = -Math.min(100, (ratePercent / extremePositive) * 50);
      description = `High funding (${ratePercent.toFixed(3)}%) - crowded long`;
    } else if (ratePercent < extremeNegative) {
      // Very negative funding = longs get paid, too many shorts
      signal = 'bullish';
      strength = Math.min(100, (Math.abs(ratePercent) / Math.abs(extremeNegative)) * 50);
      description = `Negative funding (${ratePercent.toFixed(3)}%) - crowded short`;
    } else if (ratePercent > 0.01) {
      signal = 'bearish';
      strength = -20;
      description = `Positive funding (${ratePercent.toFixed(3)}%)`;
    } else if (ratePercent < -0.005) {
      signal = 'bullish';
      strength = 20;
      description = `Slightly negative funding (${ratePercent.toFixed(3)}%)`;
    } else {
      signal = 'neutral';
      strength = 0;
      description = `Neutral funding (${ratePercent.toFixed(3)}%)`;
    }

    return {
      name: 'Funding Rate',
      value: ratePercent,
      signal,
      strength,
      description,
    };
  }

  /**
   * Analyze open interest changes
   * Rising OI + Rising Price = Strong trend
   * Rising OI + Falling Price = Bearish pressure
   * Falling OI = Positions closing, trend weakening
   */
  private analyzeOpenInterest(marketData: FuturesMarketData): IndicatorSignal {
    const currentOI = marketData.openInterest;
    const priceChange = marketData.priceChange24h;

    // Get historical OI if available
    const recentHistory = this.history.slice(-10);
    let oiChange = 0;

    if (recentHistory.length > 0) {
      const oldOI = recentHistory[0].openInterest;
      oiChange = oldOI > 0 ? ((currentOI - oldOI) / oldOI) * 100 : 0;
    }

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;
    let description = '';

    if (oiChange > 5 && priceChange > 1) {
      // Rising OI + Rising Price = Strong bullish
      signal = 'bullish';
      strength = Math.min(80, oiChange * 2 + priceChange * 5);
      description = `Rising OI (+${oiChange.toFixed(1)}%) with price up`;
    } else if (oiChange > 5 && priceChange < -1) {
      // Rising OI + Falling Price = New shorts opening, bearish
      signal = 'bearish';
      strength = -Math.min(80, oiChange * 2 + Math.abs(priceChange) * 5);
      description = `Rising OI (+${oiChange.toFixed(1)}%) with price down - shorts entering`;
    } else if (oiChange < -5) {
      // Falling OI = Positions closing
      signal = 'neutral';
      strength = 0;
      description = `Falling OI (${oiChange.toFixed(1)}%) - positions closing`;
    } else {
      signal = 'neutral';
      strength = 0;
      description = `Stable OI (${oiChange.toFixed(1)}%)`;
    }

    return {
      name: 'Open Interest',
      value: oiChange,
      signal,
      strength,
      description,
    };
  }

  /**
   * Analyze premium/discount to fair price
   * Futures trading at premium to spot = bullish sentiment
   * Futures trading at discount = bearish sentiment
   */
  private analyzePremiumDiscount(marketData: FuturesMarketData): IndicatorSignal {
    const lastPrice = marketData.lastPrice;
    const indexPrice = marketData.indexPrice;

    if (!indexPrice || indexPrice === 0) {
      return {
        name: 'Premium/Discount',
        value: 0,
        signal: 'neutral',
        strength: 0,
        description: 'Index price unavailable',
      };
    }

    const premiumPercent = ((lastPrice - indexPrice) / indexPrice) * 100;

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;
    let description = '';

    if (premiumPercent > 0.1) {
      signal = 'bullish';
      strength = Math.min(50, premiumPercent * 100);
      description = `Futures at ${premiumPercent.toFixed(2)}% premium`;
    } else if (premiumPercent < -0.1) {
      signal = 'bearish';
      strength = Math.max(-50, premiumPercent * 100);
      description = `Futures at ${Math.abs(premiumPercent).toFixed(2)}% discount`;
    } else {
      signal = 'neutral';
      strength = 0;
      description = `Near fair value (${premiumPercent.toFixed(3)}%)`;
    }

    return {
      name: 'Premium/Discount',
      value: premiumPercent,
      signal,
      strength,
      description,
    };
  }

  /**
   * Analyze 24h momentum
   */
  private analyzeMomentum(marketData: FuturesMarketData): IndicatorSignal {
    const change = marketData.priceChange24h;

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;
    let description = '';

    if (change > 3) {
      signal = 'bullish';
      strength = Math.min(80, change * 10);
      description = `Strong 24h momentum (+${change.toFixed(1)}%)`;
    } else if (change < -3) {
      signal = 'bearish';
      strength = Math.max(-80, change * 10);
      description = `Weak 24h momentum (${change.toFixed(1)}%)`;
    } else if (change > 1) {
      signal = 'bullish';
      strength = 20;
      description = `Positive momentum (+${change.toFixed(1)}%)`;
    } else if (change < -1) {
      signal = 'bearish';
      strength = -20;
      description = `Negative momentum (${change.toFixed(1)}%)`;
    } else {
      signal = 'neutral';
      strength = 0;
      description = `Flat (${change.toFixed(1)}%)`;
    }

    return {
      name: 'Momentum',
      value: change,
      signal,
      strength,
      description,
    };
  }

  private addSnapshot(snapshot: HistoricalSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > this.maxHistoryLength) {
      this.history.shift();
    }
  }

  getLastResult(): SystemBBiasResult | null {
    return this.lastResult;
  }

  getHistory(): HistoricalSnapshot[] {
    return [...this.history];
  }
}

// Singleton instance
let systemBInstance: MarketBiasSystemB | null = null;

export function getMarketBiasSystemB(): MarketBiasSystemB {
  if (!systemBInstance) {
    systemBInstance = new MarketBiasSystemB();
  }
  return systemBInstance;
}

export { MarketBiasSystemB };
