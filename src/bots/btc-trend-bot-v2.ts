/**
 * BTC Trend-Following Bot V2
 *
 * Refactored to use BaseBot infrastructure.
 * Demonstrates how to extend SinglePositionBot with variant-specific logic.
 *
 * Strategy:
 * - Trades BTCUSDT following the trend when bias is strong
 * - "Trend is your friend" - goes with momentum, not against it
 * - Opens long when strong bullish bias, short when strong bearish bias
 * - Closes when bias weakens or reverses
 */

import {
  SinglePositionBot,
  type BaseBotConfig,
  type BasePosition,
  type BaseBotStats,
  type MarketData,
} from './base-bot.js';

// ============= Types =============

export interface BTCTrendBotV2Config extends BaseBotConfig {
  // Trend entry thresholds
  strongBiasThreshold: number;    // Bias score threshold for entry (e.g., 70 = strong trend)
  exitBiasThreshold: number;      // Exit when bias weakens below this
}

export interface BTCRSIDataV2 extends MarketData {
  rsi4h: number;
  rsi1h: number;
  rsi15m: number;
  rsi5m: number;
  rsi1m: number;
  bias: 'long' | 'short' | 'strong_long' | 'strong_short' | 'neutral';
  biasScore: number;              // -100 to 100
}

export interface BTCTrendPositionV2 extends BasePosition {
  entryRSI: number;
  entryBias: string;
  currentRSI: number;
  openReason: string;
}

export interface BTCTrendStatsV2 extends BaseBotStats {
  avgTrailLevel: number;
  avgHoldTime: number;
}

// ============= Default Config =============

export const DEFAULT_BTC_TREND_V2_CONFIG: BTCTrendBotV2Config = {
  botId: 'btc-trend-v2',
  initialBalance: 2000,
  positionSizePercent: 10,
  leverage: 50,
  maxOpenPositions: 1,

  // Stops
  stopLossPercent: 20,            // 20% ROI stop
  trailTriggerPercent: 10,        // Trail after 10% ROI
  trailStepPercent: 10,           // Lock in 10% ROI increments

  // Trend thresholds
  strongBiasThreshold: 70,        // Enter when bias score > 70 or < -70
  exitBiasThreshold: 30,          // Exit when bias weakens to < 30 (or > -30 for shorts)
};

// ============= Bot Implementation =============

export class BTCTrendBotV2 extends SinglePositionBot<
  BTCTrendBotV2Config,
  BTCTrendPositionV2,
  BTCRSIDataV2,
  BTCTrendStatsV2
> {
  private lastPrice: number = 0;

  constructor(config?: Partial<BTCTrendBotV2Config>) {
    super({ ...DEFAULT_BTC_TREND_V2_CONFIG, ...config });
  }

  // ============= Abstract Method Implementations =============

  protected canEnter(data: BTCRSIDataV2): 'long' | 'short' | null {
    // Already have a position
    if (this.position) return null;

    // Strong bullish bias - go long with the trend
    if (
      data.biasScore >= this.config.strongBiasThreshold &&
      (data.bias === 'long' || data.bias === 'strong_long')
    ) {
      return 'long';
    }

    // Strong bearish bias - go short with the trend
    if (
      data.biasScore <= -this.config.strongBiasThreshold &&
      (data.bias === 'short' || data.bias === 'strong_short')
    ) {
      return 'short';
    }

    return null;
  }

  protected calculateStops(
    entryPrice: number,
    direction: 'long' | 'short',
    _data: BTCRSIDataV2
  ): { stopLoss: number; takeProfit?: number } {
    // stopLossPercent is ROI% (e.g., 20% = max 20% loss on margin)
    // Convert to price% by dividing by leverage
    const roiPercent = (this.config.stopLossPercent || 20) / 100;
    const pricePercent = roiPercent / this.config.leverage;

    const stopLoss = direction === 'long'
      ? entryPrice * (1 - pricePercent)
      : entryPrice * (1 + pricePercent);

    // No fixed take profit - we use trailing stops and trend exit
    return { stopLoss };
  }

  protected shouldExit(position: BTCTrendPositionV2, data: BTCRSIDataV2): string | null {
    // Check if trend has weakened
    if (position.direction === 'long') {
      // Exit long if bias weakens significantly
      if (data.biasScore < this.config.exitBiasThreshold) {
        return `Trend weakened - Bias: ${data.biasScore.toFixed(0)}%`;
      }
    } else {
      // Exit short if bias turns positive or weakens significantly
      if (data.biasScore > -this.config.exitBiasThreshold) {
        return `Trend weakened - Bias: ${data.biasScore.toFixed(0)}%`;
      }
    }

    return null;
  }

  protected generatePositionId(_data: BTCRSIDataV2): string {
    return `btc-trend-v2-${Date.now()}`;
  }

  // ============= Custom Methods =============

  /**
   * Calculate weighted RSI from multi-timeframe data
   */
  private calculateWeightedRSI(data: BTCRSIDataV2): number {
    return (
      data.rsi4h * 3 +
      data.rsi1h * 2 +
      data.rsi15m * 1 +
      data.rsi5m * 0.5 +
      data.rsi1m * 0.25
    ) / 6.75;
  }

  /**
   * Open a new position with trend-specific fields
   */
  openPosition(data: BTCRSIDataV2): BTCTrendPositionV2 | null {
    const direction = this.canEnter(data);
    if (!direction) return null;

    // Use the base implementation
    const basePosition = this.openPositionInternal(data);
    if (!basePosition) return null;

    // Add trend-specific fields
    const weightedRSI = this.calculateWeightedRSI(data);
    basePosition.entryRSI = weightedRSI;
    basePosition.entryBias = data.bias;
    basePosition.currentRSI = weightedRSI;
    basePosition.openReason = `Strong ${direction === 'long' ? 'bullish' : 'bearish'} trend (${data.biasScore.toFixed(0)}%)`;

    this.lastPrice = data.currentPrice;
    return basePosition;
  }

  /**
   * Update position with new price and RSI data
   */
  update(data: BTCRSIDataV2): BTCTrendPositionV2 | null {
    this.lastPrice = data.currentPrice;

    if (!this.position) {
      // Try to open a new position
      return this.openPosition(data);
    }

    // Update RSI
    this.position.currentRSI = this.calculateWeightedRSI(data);

    // Use base update logic
    return this.updatePositionInternal(data);
  }

  /**
   * Force close the position
   */
  forceClose(reason: string = 'Manual close'): BTCTrendPositionV2 | null {
    if (!this.position) return null;
    return this.closePositionInternal(this.position, 'closed_manual', reason);
  }

  // ============= Stats Override =============

  getStats(): BTCTrendStatsV2 {
    const baseStats = super.getStats();

    // Add trend-specific stats
    const avgTrailLevel = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.trailLevel, 0) / this.closedPositions.length
      : 0;

    const avgHoldTime = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + ((p.exitTime || 0) - p.entryTime), 0) / this.closedPositions.length
      : 0;

    return {
      ...baseStats,
      avgTrailLevel,
      avgHoldTime,
    };
  }

  // ============= Logging Override =============

  protected logTradeOpen(position: BTCTrendPositionV2, _data: BTCRSIDataV2): void {
    const timestamp = new Date().toLocaleTimeString();
    console.error(
      `[BTC-TREND-V2 ${timestamp}] OPENED ${position.direction.toUpperCase()} @ ${position.entryPrice.toFixed(2)} | ` +
      `Bias: ${position.entryBias} | Margin: $${position.marginUsed.toFixed(2)} | SL: ${position.stopLossPrice.toFixed(2)}`
    );
  }

  protected logTradeClose(position: BTCTrendPositionV2): void {
    const holdTimeMs = (position.exitTime || Date.now()) - position.entryTime;
    const holdTimeStr = holdTimeMs < 60000
      ? `${Math.floor(holdTimeMs / 1000)}s`
      : holdTimeMs < 3600000
        ? `${Math.floor(holdTimeMs / 60000)}m`
        : `${(holdTimeMs / 3600000).toFixed(1)}h`;

    const roi = position.marginUsed > 0
      ? ((position.realizedPnL || 0) / position.marginUsed) * 100
      : 0;

    const timestamp = new Date().toLocaleTimeString();
    console.error(
      `[BTC-TREND-V2 ${timestamp}] CLOSED ${position.direction.toUpperCase()} @ ${position.exitPrice?.toFixed(2)} | ` +
      `P&L: $${(position.realizedPnL || 0).toFixed(2)} (${roi.toFixed(1)}% ROI) | Hold: ${holdTimeStr} | ${position.exitReason}`
    );
  }
}
