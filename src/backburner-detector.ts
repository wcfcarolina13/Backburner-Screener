import type { Candle, Timeframe, BackburnerSetup, SetupState, SetupDirection } from './types.js';
import { DEFAULT_CONFIG } from './config.js';
import {
  calculateRSI,
  getCurrentRSI,
  detectImpulseMove,
  isVolumeContracting,
  isHigherTFBullish,
  calculateAvgVolume,
  detectDivergence,
  // TCG-compliant helpers
  findPullbackLow,
  findBounceHigh,
  detectRSITrend,
  detectRSICross,
  detectHTFTrend,
  calculateStructureStop,
  findRecentSwingLows,
  findRecentSwingHighs,
} from './indicators.js';

/**
 * The Backburner Detector
 *
 * Implements The Chart Guys' Backburner strategy for BOTH directions:
 *
 * LONG Setup:
 * 1. Identify a strong impulse move UP
 * 2. Wait for the FIRST oversold condition (RSI < 30)
 * 3. Buy for high-probability bounce
 *
 * SHORT Setup:
 * 1. Identify a strong impulse move DOWN
 * 2. Wait for the FIRST overbought condition (RSI > 70)
 * 3. Short for high-probability fade
 *
 * Key principles:
 * - Only the FIRST extreme RSI after impulse is valid
 * - Volume should contract during counter-move
 */
export class BackburnerDetector {
  private config = DEFAULT_CONFIG;
  private activeSetups: Map<string, BackburnerSetup> = new Map();

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Generate a unique key for a setup (includes direction)
   */
  private getSetupKey(symbol: string, timeframe: Timeframe, direction: SetupDirection): string {
    return `${symbol}-${timeframe}-${direction}`;
  }

  /**
   * Analyze candles and detect/update Backburner setups
   * Returns an array since we can have both long AND short setups
   */
  analyzeSymbol(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    higherTFCandles?: Candle[]
  ): BackburnerSetup[] {
    if (candles.length < 50) {
      return [];
    }

    const results: BackburnerSetup[] = [];

    // Calculate current RSI
    const rsiValues = calculateRSI(candles, this.config.rsiPeriod);
    const currentRSI = getCurrentRSI(candles, this.config.rsiPeriod);

    if (currentRSI === null || rsiValues.length < 5) {
      return [];
    }

    const currentPrice = candles[candles.length - 1].close;

    // Check higher timeframe trend if available
    const higherTFBullish = higherTFCandles
      ? isHigherTFBullish(higherTFCandles)
      : undefined;

    // Check for existing setups and update them
    for (const direction of ['long', 'short'] as SetupDirection[]) {
      const key = this.getSetupKey(symbol, timeframe, direction);
      const existingSetup = this.activeSetups.get(key);

      if (existingSetup) {
        const updated = this.updateExistingSetup(
          existingSetup,
          candles,
          currentRSI,
          currentPrice,
          higherTFBullish
        );
        if (updated) {
          results.push(updated);
        }
      } else {
        // Try to detect a new setup for this direction
        const newSetup = this.detectNewSetup(
          symbol,
          timeframe,
          direction,
          candles,
          rsiValues,
          currentRSI,
          currentPrice,
          higherTFBullish
        );
        if (newSetup) {
          results.push(newSetup);
        }
      }
    }

    return results;
  }

  /**
   * Detect a new Backburner setup for a specific direction
   *
   * TCG-Compliant Implementation:
   * 1. Timeframe hierarchy: 5m requires HTF bullish/bearish alignment
   * 2. Structure-based stops: track pullback low for stop placement
   * 3. Entry on RSI transition: trigger on cross event, not just "is below"
   * 4. Position building: track if RSI still dropping for safe adds
   * 5. Technical trailing data: collect swing points for structure trailing
   */
  private detectNewSetup(
    symbol: string,
    timeframe: Timeframe,
    direction: SetupDirection,
    candles: Candle[],
    rsiValues: { value: number; timestamp: number }[],
    currentRSI: number,
    currentPrice: number,
    higherTFBullish?: boolean
  ): BackburnerSetup | null {
    // Look for an impulse move
    const impulse = detectImpulseMove(candles, this.config.minImpulsePercent);

    if (!impulse) {
      return null;
    }

    // Check direction matches
    if (direction === 'long' && impulse.direction !== 'up') {
      return null;
    }
    if (direction === 'short' && impulse.direction !== 'down') {
      return null;
    }

    // ==========================================================================
    // FIX 1: TIMEFRAME HIERARCHY
    // TCG: "5m signal marks hourly higher low; 1h signal marks daily higher low"
    // ==========================================================================
    let htfConfirmed = true; // Default to true if no HTF data

    if (higherTFBullish !== undefined) {
      // For LONG setups: HTF must be bullish
      // For SHORT setups: HTF must be bearish
      if (direction === 'long' && !higherTFBullish) {
        htfConfirmed = false;
        // Don't reject outright - store for UI display, but mark as unconfirmed
      }
      if (direction === 'short' && higherTFBullish) {
        htfConfirmed = false;
      }
    }

    // ==========================================================================
    // FIX 3: ENTRY ON RSI TRANSITION (not just "is below")
    // TCG: "Entry when RSI crosses below 30"
    // ==========================================================================
    const previousRSI = rsiValues.length >= 2 ? rsiValues[rsiValues.length - 2].value : currentRSI;
    let rsiCrossedThreshold = false;
    let rsiCrossTime: number | undefined;

    if (direction === 'long') {
      // Detect cross BELOW 30
      rsiCrossedThreshold = detectRSICross(previousRSI, currentRSI, this.config.rsiOversoldThreshold, 'below');
      if (rsiCrossedThreshold) {
        rsiCrossTime = candles[candles.length - 1].timestamp;
      }
    } else {
      // Detect cross ABOVE 70
      rsiCrossedThreshold = detectRSICross(previousRSI, currentRSI, this.config.rsiOverboughtThreshold, 'above');
      if (rsiCrossedThreshold) {
        rsiCrossTime = candles[candles.length - 1].timestamp;
      }
    }

    // LONG: Check if we're in pullback territory after UP impulse
    if (direction === 'long') {
      // Current price should be below the impulse high but above the impulse low
      if (currentPrice >= impulse.endPrice) {
        return null; // Still at highs - not pulling back yet
      }
      if (currentPrice <= impulse.startPrice) {
        return null; // Broke below impulse low - structure broken
      }

      // Check if this is the FIRST oversold condition
      const isFirstOversold = this.isFirstExtremeAfterImpulse(
        rsiValues,
        impulse.endIndex,
        candles.length,
        'oversold'
      );

      if (!isFirstOversold && currentRSI >= this.config.rsiOversoldThreshold) {
        return null;
      }

      // Check RSI is actually oversold
      if (currentRSI >= this.config.rsiOversoldThreshold) {
        return null;
      }
    }

    // SHORT: Check if we're in bounce territory after DOWN impulse
    if (direction === 'short') {
      // Current price should be above the impulse low but below the impulse high
      if (currentPrice <= impulse.endPrice) {
        return null; // Still at lows - not bouncing yet
      }
      if (currentPrice >= impulse.startPrice) {
        return null; // Broke above impulse high - structure broken
      }

      // Check if this is the FIRST overbought condition
      const isFirstOverbought = this.isFirstExtremeAfterImpulse(
        rsiValues,
        impulse.endIndex,
        candles.length,
        'overbought'
      );

      if (!isFirstOverbought && currentRSI <= this.config.rsiOverboughtThreshold) {
        return null;
      }

      // Check RSI is actually overbought
      if (currentRSI <= this.config.rsiOverboughtThreshold) {
        return null;
      }
    }

    // ==========================================================================
    // FIX 2: STRUCTURE-BASED STOPS
    // TCG: "Stop goes under the pullback low / signal low"
    // ==========================================================================
    let pullbackLow: number | undefined;
    let bounceHigh: number | undefined;
    let structureStopPrice: number | undefined;

    if (direction === 'long') {
      const pullbackResult = findPullbackLow(candles, impulse.endIndex);
      if (pullbackResult) {
        pullbackLow = pullbackResult.price;
        structureStopPrice = calculateStructureStop('long', pullbackLow, undefined, 0.5) ?? undefined;
      }
    } else {
      const bounceResult = findBounceHigh(candles, impulse.endIndex);
      if (bounceResult) {
        bounceHigh = bounceResult.price;
        structureStopPrice = calculateStructureStop('short', undefined, bounceHigh, 0.5) ?? undefined;
      }
    }

    // ==========================================================================
    // FIX 5: POSITION BUILDING
    // TCG: "Tier only while RSI is still extreme and worsening"
    // ==========================================================================
    const rsiTrend = detectRSITrend(rsiValues, 3);

    // Determine position tier: 1 = RSI<30/RSI>70, 2 = RSI<20/RSI>80
    let positionTier: 1 | 2 = 1;
    if (direction === 'long' && currentRSI < this.config.rsiDeepOversoldThreshold) {
      positionTier = 2;
    } else if (direction === 'short' && currentRSI > this.config.rsiDeepOverboughtThreshold) {
      positionTier = 2;
    }

    // Can add position if:
    // - RSI is still dropping (for longs) or rising (for shorts)
    // - OR we're at Tier 1 and haven't added Tier 2 yet
    const canAddPosition =
      (direction === 'long' && rsiTrend === 'dropping') ||
      (direction === 'short' && rsiTrend === 'rising');

    // ==========================================================================
    // FIX 4: TECHNICAL TRAILING DATA
    // TCG: "Walk up stop under the last higher low"
    // ==========================================================================
    const recentSwingLows = findRecentSwingLows(candles, 3, 3).map(s => ({
      price: s.price,
      time: s.time,
    }));
    const recentSwingHighs = findRecentSwingHighs(candles, 3, 3).map(s => ({
      price: s.price,
      time: s.time,
    }));

    // Analyze volume
    const impulseCandles = candles.slice(impulse.startIndex, impulse.endIndex + 1);
    const counterMoveCandles = candles.slice(impulse.endIndex + 1);
    const volumeContracting = isVolumeContracting(impulseCandles, counterMoveCandles);

    // Determine setup state
    const state = this.determineInitialState(currentRSI, direction);

    if (state === 'watching') {
      return null;
    }

    const isActionable = state === 'triggered' || state === 'deep_extreme';

    // Check for RSI-price divergence that aligns with the setup direction
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

    const setup: BackburnerSetup = {
      symbol,
      timeframe,
      direction,
      state,
      impulseHigh: direction === 'long' ? impulse.endPrice : impulse.startPrice,
      impulseLow: direction === 'long' ? impulse.startPrice : impulse.endPrice,
      impulseStartTime: candles[impulse.startIndex].timestamp,
      impulseEndTime: candles[impulse.endIndex].timestamp,
      impulsePercentMove: impulse.percentMove,
      currentRSI,
      rsiAtTrigger: currentRSI,
      currentPrice,
      entryPrice: isActionable ? currentPrice : undefined,
      detectedAt: Date.now(),
      triggeredAt: isActionable ? Date.now() : undefined,
      lastUpdated: Date.now(),
      impulseAvgVolume: calculateAvgVolume(impulseCandles, impulseCandles.length),
      pullbackAvgVolume: calculateAvgVolume(counterMoveCandles, counterMoveCandles.length),
      volumeContracting,
      higherTFBullish,
      divergence: setupDivergence,

      // TCG-compliant fields
      htfConfirmed,
      pullbackLow,
      bounceHigh,
      structureStopPrice,
      rsiCrossedThreshold,
      rsiCrossTime,
      previousRSI,
      rsiTrend,
      canAddPosition,
      positionTier,
      recentSwingLows,
      recentSwingHighs,

      // These will be set by the screener with actual values
      marketType: 'spot',
      liquidityRisk: 'medium',
    };

    this.activeSetups.set(this.getSetupKey(symbol, timeframe, direction), setup);
    return setup;
  }

  /**
   * Check if this is the first extreme RSI condition after the impulse move
   */
  private isFirstExtremeAfterImpulse(
    rsiValues: { value: number; timestamp: number }[],
    impulseEndIndex: number,
    totalCandles: number,
    type: 'oversold' | 'overbought'
  ): boolean {
    const rsiOffset = totalCandles - rsiValues.length;
    const startRSIIndex = Math.max(0, impulseEndIndex - rsiOffset);

    let extremeCount = 0;
    for (let i = startRSIIndex; i < rsiValues.length; i++) {
      if (type === 'oversold' && rsiValues[i].value < this.config.rsiOversoldThreshold) {
        extremeCount++;
      }
      if (type === 'overbought' && rsiValues[i].value > this.config.rsiOverboughtThreshold) {
        extremeCount++;
      }
    }

    return extremeCount <= 1;
  }

  /**
   * Determine initial state based on RSI and direction
   */
  private determineInitialState(currentRSI: number, direction: SetupDirection): SetupState {
    if (direction === 'long') {
      if (currentRSI < this.config.rsiDeepOversoldThreshold) {
        return 'deep_extreme';
      } else if (currentRSI < this.config.rsiOversoldThreshold) {
        return 'triggered';
      }
    } else {
      if (currentRSI > this.config.rsiDeepOverboughtThreshold) {
        return 'deep_extreme';
      } else if (currentRSI > this.config.rsiOverboughtThreshold) {
        return 'triggered';
      }
    }
    return 'watching';
  }

  /**
   * Update an existing setup based on new data
   */
  private updateExistingSetup(
    setup: BackburnerSetup,
    candles: Candle[],
    currentRSI: number,
    currentPrice: number,
    higherTFBullish?: boolean
  ): BackburnerSetup | null {
    const key = this.getSetupKey(setup.symbol, setup.timeframe, setup.direction);

    // Update basic fields
    setup.currentRSI = currentRSI;
    setup.currentPrice = currentPrice;
    setup.lastUpdated = Date.now();
    if (higherTFBullish !== undefined) {
      setup.higherTFBullish = higherTFBullish;
    }

    // Check for invalidation conditions
    if (this.isSetupInvalidated(setup, currentPrice, currentRSI)) {
      setup.state = 'played_out';
      this.activeSetups.delete(key);
      return setup;
    }

    // Update state based on current conditions
    setup.state = this.determineUpdatedState(setup, currentRSI);

    // If setup is played out, remove it
    if (setup.state === 'played_out') {
      this.activeSetups.delete(key);
    } else {
      this.activeSetups.set(key, setup);
    }

    return setup;
  }

  /**
   * Check if a setup has been invalidated
   */
  private isSetupInvalidated(setup: BackburnerSetup, currentPrice: number, currentRSI: number): boolean {
    if (setup.direction === 'long') {
      // LONG invalidation: broke below impulse low
      if (currentPrice < setup.impulseLow) {
        return true;
      }
      // Target reached: back to impulse high
      if ((setup.state === 'triggered' || setup.state === 'deep_extreme') &&
          currentPrice >= setup.impulseHigh * 0.99) {
        return true;
      }
      // Second oversold after bounce = no longer first
      if (setup.state === 'reversing' && currentRSI < this.config.rsiOversoldThreshold) {
        return true;
      }
    } else {
      // SHORT invalidation: broke above impulse high
      if (currentPrice > setup.impulseHigh) {
        return true;
      }
      // Target reached: back to impulse low
      if ((setup.state === 'triggered' || setup.state === 'deep_extreme') &&
          currentPrice <= setup.impulseLow * 1.01) {
        return true;
      }
      // Second overbought after fade = no longer first
      if (setup.state === 'reversing' && currentRSI > this.config.rsiOverboughtThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine the updated state of a setup
   */
  private determineUpdatedState(setup: BackburnerSetup, currentRSI: number): SetupState {
    const prevState = setup.state;

    if (setup.direction === 'long') {
      // Deep oversold
      if (currentRSI < this.config.rsiDeepOversoldThreshold) {
        return 'deep_extreme';
      }
      // Still in triggered zone
      if (currentRSI < this.config.rsiOversoldThreshold) {
        return 'triggered';
      }
      // RSI recovered above 30
      if (prevState === 'triggered' || prevState === 'deep_extreme') {
        if (currentRSI > 40) {
          return 'played_out';
        }
        return 'reversing';
      }
      if (prevState === 'reversing') {
        if (currentRSI > 50) {
          return 'played_out';
        }
        return 'reversing';
      }
    } else {
      // Deep overbought
      if (currentRSI > this.config.rsiDeepOverboughtThreshold) {
        return 'deep_extreme';
      }
      // Still in triggered zone
      if (currentRSI > this.config.rsiOverboughtThreshold) {
        return 'triggered';
      }
      // RSI dropped below 70
      if (prevState === 'triggered' || prevState === 'deep_extreme') {
        if (currentRSI < 60) {
          return 'played_out';
        }
        return 'reversing';
      }
      if (prevState === 'reversing') {
        if (currentRSI < 50) {
          return 'played_out';
        }
        return 'reversing';
      }
    }

    return setup.state;
  }

  /**
   * Get all active setups
   */
  getActiveSetups(): BackburnerSetup[] {
    return Array.from(this.activeSetups.values());
  }

  /**
   * Get setups for a specific timeframe
   */
  getSetupsByTimeframe(timeframe: Timeframe): BackburnerSetup[] {
    return this.getActiveSetups().filter(s => s.timeframe === timeframe);
  }

  /**
   * Get setups in a specific state
   */
  getSetupsByState(state: SetupState): BackburnerSetup[] {
    return this.getActiveSetups().filter(s => s.state === state);
  }

  /**
   * Remove a setup manually
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
   * Get the total number of active setups
   */
  getActiveSetupCount(): number {
    return this.activeSetups.size;
  }
}
