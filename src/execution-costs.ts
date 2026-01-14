/**
 * Execution Costs Module
 *
 * Models realistic trading costs including:
 * - Trading fees (maker/taker)
 * - Slippage (conservative estimates without order book)
 * - Funding rates (for perpetual futures)
 *
 * Goal: Prevent false positives from idealized backtests by ensuring
 * PnL reflects realistic execution, even for small accounts.
 */

// MEXC Futures fee structure (as of 2024)
// VIP Level 0 (default for small accounts)
export interface FeeStructure {
  makerFee: number;   // Maker fee rate (e.g., 0.0002 = 0.02%)
  takerFee: number;   // Taker fee rate (e.g., 0.0004 = 0.04%)
}

// Slippage model parameters
export interface SlippageConfig {
  baseSlippageBps: number;        // Base slippage in basis points (e.g., 5 = 0.05%)
  volatilityMultiplier: number;   // Multiplier for high volatility
  sizeImpactFactor: number;       // Additional slippage per $10k notional
  minSlippageBps: number;         // Minimum slippage floor
  maxSlippageBps: number;         // Maximum slippage cap
}

// Funding rate configuration
export interface FundingConfig {
  defaultRatePercent: number;     // Default funding rate per 8h (e.g., 0.01%)
  extremeRatePercent: number;     // Rate during extreme conditions (e.g., 0.1%)
  intervalHours: number;          // Funding interval (8h for most exchanges)
}

// Complete execution costs configuration
export interface ExecutionCostsConfig {
  fees: FeeStructure;
  slippage: SlippageConfig;
  funding: FundingConfig;
  enabled: boolean;               // Master switch to enable/disable cost modeling
}

// Default configuration based on MEXC perpetual futures
export const DEFAULT_EXECUTION_COSTS: ExecutionCostsConfig = {
  fees: {
    // MEXC Futures fees (standard retail rates)
    // Grid bot observation: 0.67 USDT fees on 186 USDT over multiple fills
    // For single trades, standard MEXC taker fee is ~0.02-0.04%
    makerFee: 0.0002,   // 0.02% maker fee
    takerFee: 0.0004,   // 0.04% taker fee (market orders)
  },
  slippage: {
    // Minimal slippage for liquid pairs
    // Real trading shows minimal slippage on most pairs
    baseSlippageBps: 2,           // 0.02% base slippage
    volatilityMultiplier: 1.5,    // 1.5x slippage in volatile conditions
    sizeImpactFactor: 0.5,        // +0.5bp per $10k notional (minimal)
    minSlippageBps: 1,            // Minimum 0.01% slippage floor
    maxSlippageBps: 20,           // Maximum 0.20% slippage cap
  },
  funding: {
    // Perpetual futures funding rates
    // Positive = longs pay shorts (common in bull markets)
    // Negative = shorts pay longs (common in bear markets)
    defaultRatePercent: 0.01,     // 0.01% per 8h (typical neutral market)
    extremeRatePercent: 0.1,      // 0.1% per 8h (during extreme trends)
    intervalHours: 8,             // Standard 8-hour funding
  },
  enabled: true,
};

// Cost breakdown for a single trade
export interface TradeCosts {
  entryFee: number;           // Fee paid on entry
  exitFee: number;            // Fee paid on exit (estimated)
  entrySlippage: number;      // Slippage cost on entry
  exitSlippage: number;       // Slippage cost on exit (estimated)
  fundingPaid: number;        // Cumulative funding paid/received
  totalCosts: number;         // Sum of all costs
  effectiveEntryPrice: number; // Entry price after slippage
  // Breakdown in percentage of notional
  costsAsPercent: number;
}

// Volatility state for slippage calculation
export type VolatilityState = 'low' | 'normal' | 'high' | 'extreme';

/**
 * Execution Costs Calculator
 *
 * Calculates realistic trading costs based on position parameters
 */
export class ExecutionCostsCalculator {
  private config: ExecutionCostsConfig;

  constructor(config?: Partial<ExecutionCostsConfig>) {
    this.config = { ...DEFAULT_EXECUTION_COSTS, ...config };
    if (config?.fees) {
      this.config.fees = { ...DEFAULT_EXECUTION_COSTS.fees, ...config.fees };
    }
    if (config?.slippage) {
      this.config.slippage = { ...DEFAULT_EXECUTION_COSTS.slippage, ...config.slippage };
    }
    if (config?.funding) {
      this.config.funding = { ...DEFAULT_EXECUTION_COSTS.funding, ...config.funding };
    }
  }

  /**
   * Check if costs are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Calculate slippage in basis points based on market conditions
   */
  calculateSlippageBps(
    notionalSize: number,
    volatility: VolatilityState = 'normal'
  ): number {
    if (!this.config.enabled) return 0;

    const { baseSlippageBps, volatilityMultiplier, sizeImpactFactor, minSlippageBps, maxSlippageBps } = this.config.slippage;

    // Base slippage
    let slippageBps = baseSlippageBps;

    // Volatility adjustment
    switch (volatility) {
      case 'low':
        slippageBps *= 0.5;
        break;
      case 'normal':
        // No change
        break;
      case 'high':
        slippageBps *= volatilityMultiplier;
        break;
      case 'extreme':
        slippageBps *= volatilityMultiplier * 1.5;
        break;
    }

    // Size impact (additional slippage for larger orders)
    const sizeImpact = (notionalSize / 10000) * sizeImpactFactor;
    slippageBps += sizeImpact;

    // Apply bounds
    return Math.min(maxSlippageBps, Math.max(minSlippageBps, slippageBps));
  }

  /**
   * Calculate effective entry price after slippage
   */
  calculateEffectiveEntryPrice(
    entryPrice: number,
    direction: 'long' | 'short',
    notionalSize: number,
    volatility: VolatilityState = 'normal'
  ): number {
    if (!this.config.enabled) return entryPrice;

    const slippageBps = this.calculateSlippageBps(notionalSize, volatility);
    const slippageRate = slippageBps / 10000;

    // Slippage always works against the trader
    if (direction === 'long') {
      // Long: buy at higher price
      return entryPrice * (1 + slippageRate);
    } else {
      // Short: sell at lower price
      return entryPrice * (1 - slippageRate);
    }
  }

  /**
   * Calculate effective exit price after slippage
   */
  calculateEffectiveExitPrice(
    exitPrice: number,
    direction: 'long' | 'short',
    notionalSize: number,
    volatility: VolatilityState = 'normal'
  ): number {
    if (!this.config.enabled) return exitPrice;

    const slippageBps = this.calculateSlippageBps(notionalSize, volatility);
    const slippageRate = slippageBps / 10000;

    // Slippage always works against the trader
    if (direction === 'long') {
      // Long exit (sell): sell at lower price
      return exitPrice * (1 - slippageRate);
    } else {
      // Short exit (buy back): buy at higher price
      return exitPrice * (1 + slippageRate);
    }
  }

  /**
   * Calculate trading fee for a given notional size
   * Assumes taker (market) orders for entries/exits
   */
  calculateFee(notionalSize: number, isMaker = false): number {
    if (!this.config.enabled) return 0;

    const feeRate = isMaker ? this.config.fees.makerFee : this.config.fees.takerFee;
    return notionalSize * feeRate;
  }

  /**
   * Calculate funding payment for holding a position
   *
   * @param notionalSize Position notional size
   * @param direction Long or short
   * @param holdingTimeMs How long the position was held in milliseconds
   * @param marketBias 'bullish', 'bearish', or 'neutral' - affects funding direction
   */
  calculateFunding(
    notionalSize: number,
    direction: 'long' | 'short',
    holdingTimeMs: number,
    marketBias: 'bullish' | 'bearish' | 'neutral' = 'neutral'
  ): number {
    if (!this.config.enabled) return 0;

    const { defaultRatePercent, extremeRatePercent, intervalHours } = this.config.funding;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Number of funding intervals during holding period
    const fundingPeriods = holdingTimeMs / intervalMs;
    if (fundingPeriods < 0.1) return 0; // Ignore very short holds

    // Determine funding rate based on market bias
    let fundingRate: number;
    let payerIsLong: boolean;

    switch (marketBias) {
      case 'bullish':
        // In bull markets, longs pay shorts (positive funding)
        fundingRate = extremeRatePercent / 100;
        payerIsLong = true;
        break;
      case 'bearish':
        // In bear markets, shorts pay longs (negative funding)
        fundingRate = extremeRatePercent / 100;
        payerIsLong = false;
        break;
      case 'neutral':
      default:
        // Neutral market - small positive funding (longs pay)
        fundingRate = defaultRatePercent / 100;
        payerIsLong = true;
        break;
    }

    // Calculate payment
    const fundingPerPeriod = notionalSize * fundingRate;
    const totalFunding = fundingPerPeriod * fundingPeriods;

    // Positive value means trader pays, negative means trader receives
    if ((direction === 'long' && payerIsLong) || (direction === 'short' && !payerIsLong)) {
      return totalFunding;  // Trader pays
    } else {
      return -totalFunding; // Trader receives
    }
  }

  /**
   * Calculate all costs for a trade
   */
  calculateTradeCosts(
    entryPrice: number,
    exitPrice: number,
    notionalSize: number,
    direction: 'long' | 'short',
    holdingTimeMs: number,
    marketBias: 'bullish' | 'bearish' | 'neutral' = 'neutral',
    volatility: VolatilityState = 'normal'
  ): TradeCosts {
    if (!this.config.enabled) {
      return {
        entryFee: 0,
        exitFee: 0,
        entrySlippage: 0,
        exitSlippage: 0,
        fundingPaid: 0,
        totalCosts: 0,
        effectiveEntryPrice: entryPrice,
        costsAsPercent: 0,
      };
    }

    // Calculate fees (taker for both entry and exit)
    const entryFee = this.calculateFee(notionalSize);
    const exitFee = this.calculateFee(notionalSize);

    // Calculate slippage costs
    const effectiveEntryPrice = this.calculateEffectiveEntryPrice(entryPrice, direction, notionalSize, volatility);
    const effectiveExitPrice = this.calculateEffectiveExitPrice(exitPrice, direction, notionalSize, volatility);

    // Slippage cost = price difference * (notional / price)
    const entrySlippage = Math.abs(effectiveEntryPrice - entryPrice) * (notionalSize / entryPrice);
    const exitSlippage = Math.abs(effectiveExitPrice - exitPrice) * (notionalSize / exitPrice);

    // Calculate funding
    const fundingPaid = this.calculateFunding(notionalSize, direction, holdingTimeMs, marketBias);

    // Total costs (funding can be negative if received)
    const totalCosts = entryFee + exitFee + entrySlippage + exitSlippage + fundingPaid;

    return {
      entryFee,
      exitFee,
      entrySlippage,
      exitSlippage,
      fundingPaid,
      totalCosts,
      effectiveEntryPrice,
      costsAsPercent: (totalCosts / notionalSize) * 100,
    };
  }

  /**
   * Calculate entry costs only (for opening a position)
   * Returns effective entry price and entry costs
   */
  calculateEntryCosts(
    entryPrice: number,
    notionalSize: number,
    direction: 'long' | 'short',
    volatility: VolatilityState = 'normal'
  ): { effectiveEntryPrice: number; entryCosts: number } {
    if (!this.config.enabled) {
      return { effectiveEntryPrice: entryPrice, entryCosts: 0 };
    }

    const entryFee = this.calculateFee(notionalSize);
    const effectiveEntryPrice = this.calculateEffectiveEntryPrice(entryPrice, direction, notionalSize, volatility);
    const entrySlippage = Math.abs(effectiveEntryPrice - entryPrice) * (notionalSize / entryPrice);

    return {
      effectiveEntryPrice,
      entryCosts: entryFee + entrySlippage,
    };
  }

  /**
   * Calculate exit costs only (for closing a position)
   */
  calculateExitCosts(
    exitPrice: number,
    notionalSize: number,
    direction: 'long' | 'short',
    volatility: VolatilityState = 'normal'
  ): { effectiveExitPrice: number; exitCosts: number } {
    if (!this.config.enabled) {
      return { effectiveExitPrice: exitPrice, exitCosts: 0 };
    }

    const exitFee = this.calculateFee(notionalSize);
    const effectiveExitPrice = this.calculateEffectiveExitPrice(exitPrice, direction, notionalSize, volatility);
    const exitSlippage = Math.abs(effectiveExitPrice - exitPrice) * (notionalSize / exitPrice);

    return {
      effectiveExitPrice,
      exitCosts: exitFee + exitSlippage,
    };
  }

  /**
   * Adjust PnL for execution costs
   * This is a convenience method for adjusting raw PnL after the fact
   */
  adjustPnLForCosts(
    rawPnL: number,
    notionalSize: number,
    holdingTimeMs: number,
    direction: 'long' | 'short',
    marketBias: 'bullish' | 'bearish' | 'neutral' = 'neutral',
    volatility: VolatilityState = 'normal'
  ): { adjustedPnL: number; totalCosts: number } {
    if (!this.config.enabled) {
      return { adjustedPnL: rawPnL, totalCosts: 0 };
    }

    // Calculate all costs
    const entryFee = this.calculateFee(notionalSize);
    const exitFee = this.calculateFee(notionalSize);
    const slippageBps = this.calculateSlippageBps(notionalSize, volatility);
    const slippageCost = (slippageBps / 10000) * notionalSize * 2; // Entry + exit
    const fundingPaid = this.calculateFunding(notionalSize, direction, holdingTimeMs, marketBias);

    const totalCosts = entryFee + exitFee + slippageCost + fundingPaid;

    return {
      adjustedPnL: rawPnL - totalCosts,
      totalCosts,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): ExecutionCostsConfig {
    return { ...this.config };
  }

  /**
   * Get fee structure
   */
  getFeeStructure(): FeeStructure {
    return { ...this.config.fees };
  }

  /**
   * Estimate total round-trip cost as percentage of notional
   * Useful for quick estimates
   */
  estimateRoundTripCostPercent(notionalSize: number, holdingHours = 24): number {
    if (!this.config.enabled) return 0;

    // Fees
    const feesCost = (this.config.fees.takerFee * 2) * 100; // Entry + exit as %

    // Slippage (normal conditions)
    const slippageBps = this.calculateSlippageBps(notionalSize, 'normal');
    const slippageCost = (slippageBps / 100) * 2; // Entry + exit

    // Funding (assume neutral market)
    const fundingIntervals = holdingHours / this.config.funding.intervalHours;
    const fundingCost = this.config.funding.defaultRatePercent * fundingIntervals;

    return feesCost + slippageCost + fundingCost;
  }
}

// Singleton instance with default config
let costsCalculatorInstance: ExecutionCostsCalculator | null = null;

export function getExecutionCostsCalculator(config?: Partial<ExecutionCostsConfig>): ExecutionCostsCalculator {
  if (!costsCalculatorInstance || config) {
    costsCalculatorInstance = new ExecutionCostsCalculator(config);
  }
  return costsCalculatorInstance;
}

/**
 * Helper to determine volatility state from RSI or other indicators
 */
export function determineVolatility(
  rsi?: number,
  priceChangePercent?: number
): VolatilityState {
  // High volatility indicators
  if (priceChangePercent !== undefined) {
    if (Math.abs(priceChangePercent) > 5) return 'extreme';
    if (Math.abs(priceChangePercent) > 2) return 'high';
  }

  if (rsi !== undefined) {
    // Extreme RSI often indicates high volatility
    if (rsi < 15 || rsi > 85) return 'extreme';
    if (rsi < 25 || rsi > 75) return 'high';
    if (rsi > 40 && rsi < 60) return 'low';
  }

  return 'normal';
}

/**
 * Helper to determine market bias from various signals
 */
export function determineMarketBias(
  btcRsi4h?: number,
  btcPriceChange24h?: number
): 'bullish' | 'bearish' | 'neutral' {
  let score = 0;

  if (btcRsi4h !== undefined) {
    if (btcRsi4h > 60) score += 1;
    if (btcRsi4h > 70) score += 1;
    if (btcRsi4h < 40) score -= 1;
    if (btcRsi4h < 30) score -= 1;
  }

  if (btcPriceChange24h !== undefined) {
    if (btcPriceChange24h > 2) score += 1;
    if (btcPriceChange24h > 5) score += 1;
    if (btcPriceChange24h < -2) score -= 1;
    if (btcPriceChange24h < -5) score -= 1;
  }

  if (score >= 2) return 'bullish';
  if (score <= -2) return 'bearish';
  return 'neutral';
}
