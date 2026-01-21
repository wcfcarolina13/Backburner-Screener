/**
 * Combined Strategy Bot - 4H Normal + 5m Fade
 *
 * Tests the hypothesis: Use 4H normal to establish trend direction,
 * then use 5m fade to time entries aligned with that trend.
 *
 * Logic:
 * - When a 4H signal fires, store the bias (LONG or SHORT) for that symbol
 * - When a 5m signal fires on the same symbol:
 *   - If 4H bias is LONG and 5m signal is SHORT → FADE to LONG ✅ (aligned)
 *   - If 4H bias is SHORT and 5m signal is LONG → FADE to SHORT ✅ (aligned)
 *   - Otherwise, skip (not aligned)
 *
 * This filters for confluence between higher timeframe direction and
 * lower timeframe entry timing.
 */

import { getExecutionCostsCalculator, determineVolatility } from './execution-costs.js';
import type { BackburnerSetup, Timeframe, MarketType } from './types.js';

const costsCalculator = getExecutionCostsCalculator();

export interface CombinedStrategyBotConfig {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  initialStopLossPercent: number;
  trailTriggerPercent: number;
  trailStepPercent: number;
  level1LockPercent: number;
  maxOpenPositions: number;

  // How long is a 4H bias valid for 5m entries? (in ms)
  htfBiasValidityMs: number;

  // Timeframe settings
  htfTimeframe: Timeframe;  // Higher timeframe for bias (default: 4h)
  ltfTimeframe: Timeframe;  // Lower timeframe for entry (default: 5m)
}

interface HtfBias {
  direction: 'long' | 'short';
  signalTime: number;
  validUntil: number;
  signalRsi: number;
  signalPrice: number;
}

export interface CombinedPosition {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;

  // HTF bias that established the direction
  htfBiasDirection: 'long' | 'short';
  htfBiasTime: number;

  // LTF signal that triggered entry (we faded this)
  ltfSignalDirection: 'long' | 'short';
  ltfSignalTime: number;

  entryPrice: number;
  effectiveEntryPrice: number;
  entryTime: number;
  entryCosts: number;

  marginUsed: number;
  notionalSize: number;
  leverage: number;

  initialStopLossPrice: number;
  currentStopLossPrice: number;
  highWaterMark: number;
  trailLevel: number;

  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  status: 'open' | 'closed';

  exitPrice?: number;
  exitTime?: number;
  exitCosts?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  closeReason?: string;
}

const DEFAULT_CONFIG: CombinedStrategyBotConfig = {
  initialBalance: 2000,
  positionSizePercent: 5,
  leverage: 10,
  initialStopLossPercent: 15,
  trailTriggerPercent: 10,
  trailStepPercent: 5,
  level1LockPercent: 2,
  maxOpenPositions: 50,
  htfBiasValidityMs: 12 * 60 * 60 * 1000,  // 12 hours (3 x 4H candles)
  htfTimeframe: '4h',
  ltfTimeframe: '5m',
};

export class CombinedStrategyBot {
  private config: CombinedStrategyBotConfig;
  private balance: number;
  private peakBalance: number;
  private positions: Map<string, CombinedPosition> = new Map();
  private closedPositions: CombinedPosition[] = [];
  private botId: string;

  // Track HTF biases per symbol
  private htfBiases: Map<string, HtfBias> = new Map();

  // Stats
  private alignedSignals: number = 0;
  private skippedSignals: number = 0;

  constructor(config: Partial<CombinedStrategyBotConfig> = {}, botId: string = 'combined-4h5m') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
  }

  getBotId(): string {
    return this.botId;
  }

  getConfig(): CombinedStrategyBotConfig {
    return { ...this.config };
  }

  getBalance(): number {
    return this.balance;
  }

  private getPositionKey(symbol: string, marketType: MarketType): string {
    return `${symbol}-combined-${marketType}`;
  }

  private generatePositionId(symbol: string): string {
    return `${this.botId}-${symbol}-${Date.now()}`;
  }

  /**
   * Process a setup - could be HTF bias or LTF entry trigger
   */
  processSetup(setup: BackburnerSetup): CombinedPosition | null {
    // Only trade triggered or deep_extreme signals
    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    // Only futures
    if (setup.marketType !== 'futures') {
      return null;
    }

    const now = Date.now();

    // Is this a HTF (4H) signal? → Update bias
    if (setup.timeframe === this.config.htfTimeframe) {
      this.htfBiases.set(setup.symbol, {
        direction: setup.direction,
        signalTime: now,
        validUntil: now + this.config.htfBiasValidityMs,
        signalRsi: setup.currentRSI,
        signalPrice: setup.currentPrice,
      });
      console.log(`[${this.botId}] 4H BIAS: ${setup.symbol} ${setup.direction.toUpperCase()} (valid for ${this.config.htfBiasValidityMs / (60 * 60 * 1000)}h)`);
      return null;  // Don't trade on HTF signal, just store bias
    }

    // Is this a LTF (5m) signal? → Check for aligned entry
    if (setup.timeframe === this.config.ltfTimeframe) {
      return this.tryAlignedEntry(setup);
    }

    return null;  // Other timeframes ignored
  }

  /**
   * Try to open a position if 5m signal aligns with 4H bias
   */
  private tryAlignedEntry(setup: BackburnerSetup): CombinedPosition | null {
    const now = Date.now();

    // Check for valid HTF bias
    const bias = this.htfBiases.get(setup.symbol);
    if (!bias) {
      // No 4H bias for this symbol
      return null;
    }

    // Check if bias is still valid
    if (now > bias.validUntil) {
      // Bias expired
      this.htfBiases.delete(setup.symbol);
      return null;
    }

    // Check alignment: 4H direction should match the FADED 5m direction
    // 4H LONG + 5m SHORT (faded to LONG) = ✅ Aligned
    // 4H SHORT + 5m LONG (faded to SHORT) = ✅ Aligned
    const fadedDirection = setup.direction === 'long' ? 'short' : 'long';

    if (bias.direction !== fadedDirection) {
      // Not aligned - 4H and faded 5m don't agree
      this.skippedSignals++;
      console.log(`[${this.botId}] SKIP: ${setup.symbol} - 4H ${bias.direction} but 5m fade would be ${fadedDirection}`);
      return null;
    }

    // ✅ Aligned! Open position
    this.alignedSignals++;
    return this.openPosition(setup, bias);
  }

  /**
   * Open an aligned position
   */
  private openPosition(setup: BackburnerSetup, bias: HtfBias): CombinedPosition | null {
    const key = this.getPositionKey(setup.symbol, setup.marketType);

    // No duplicate positions
    if (this.positions.has(key)) {
      return null;
    }

    // Check max positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    // Calculate position size
    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;

    if (margin > this.balance) {
      return null;
    }

    // Direction is the FADE of the 5m signal (which aligns with 4H bias)
    const direction = setup.direction === 'long' ? 'short' : 'long';

    const entryPrice = setup.currentPrice;
    const volatility = determineVolatility(setup.currentRSI);
    const costs = costsCalculator.calculateEntryCosts(
      entryPrice,
      notional,
      direction,
      volatility
    );

    const effectiveEntryPrice = costs.effectiveEntryPrice;

    // Calculate initial stop loss
    const stopLossMultiplier = direction === 'long'
      ? (1 - this.config.initialStopLossPercent / 100)
      : (1 + this.config.initialStopLossPercent / 100);
    const initialStopLossPrice = effectiveEntryPrice * stopLossMultiplier;

    const position: CombinedPosition = {
      id: this.generatePositionId(setup.symbol),
      symbol: setup.symbol,
      direction,
      marketType: setup.marketType,

      htfBiasDirection: bias.direction,
      htfBiasTime: bias.signalTime,
      ltfSignalDirection: setup.direction,
      ltfSignalTime: Date.now(),

      entryPrice,
      effectiveEntryPrice,
      entryTime: Date.now(),
      entryCosts: costs.entryCosts,

      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,

      initialStopLossPrice,
      currentStopLossPrice: initialStopLossPrice,
      highWaterMark: 0,
      trailLevel: 0,

      currentPrice: entryPrice,
      unrealizedPnL: -costs.entryCosts,
      unrealizedPnLPercent: (-costs.entryCosts / margin) * 100,
      status: 'open',
    };

    this.balance -= margin;
    this.positions.set(key, position);

    console.log(`[${this.botId}] ✅ ALIGNED ENTRY: ${direction.toUpperCase()} ${setup.symbol}`);
    console.log(`   4H ${bias.direction.toUpperCase()} → 5m ${setup.direction.toUpperCase()} (faded) → ${direction.toUpperCase()} @ ${entryPrice.toFixed(6)}`);

    return position;
  }

  /**
   * Update position with new price
   */
  updatePosition(setup: BackburnerSetup): CombinedPosition | null {
    // Also check if this is a new HTF signal to update bias
    if (setup.timeframe === this.config.htfTimeframe &&
        (setup.state === 'triggered' || setup.state === 'deep_extreme')) {
      const now = Date.now();
      this.htfBiases.set(setup.symbol, {
        direction: setup.direction,
        signalTime: now,
        validUntil: now + this.config.htfBiasValidityMs,
        signalRsi: setup.currentRSI,
        signalPrice: setup.currentPrice,
      });
    }

    const key = this.getPositionKey(setup.symbol, setup.marketType);
    const position = this.positions.get(key);

    if (!position || position.status === 'closed') {
      return null;
    }

    return this.updatePositionPrice(position, setup.currentPrice, key);
  }

  /**
   * Update all positions with current prices
   */
  async updateAllPositionPrices(getPrice: (symbol: string, marketType: MarketType) => Promise<number | null>): Promise<{ closed: CombinedPosition[], updated: CombinedPosition[] }> {
    const closed: CombinedPosition[] = [];
    const updated: CombinedPosition[] = [];

    for (const [key, position] of this.positions) {
      const currentPrice = await getPrice(position.symbol, position.marketType);
      if (!currentPrice) continue;

      const result = this.updatePositionPrice(position, currentPrice, key);
      if (result) {
        if (result.status === 'closed') {
          closed.push(result);
        } else {
          updated.push(result);
        }
      }
    }

    return { closed, updated };
  }

  private updatePositionPrice(position: CombinedPosition, currentPrice: number, key: string): CombinedPosition | null {
    position.currentPrice = currentPrice;

    // Calculate unrealized PnL
    const priceChange = position.direction === 'long'
      ? (currentPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
      : (position.effectiveEntryPrice - currentPrice) / position.effectiveEntryPrice;

    const grossPnL = priceChange * position.notionalSize;
    position.unrealizedPnL = grossPnL - position.entryCosts;
    position.unrealizedPnLPercent = (position.unrealizedPnL / position.marginUsed) * 100;

    // Update high water mark
    if (position.unrealizedPnLPercent > position.highWaterMark) {
      position.highWaterMark = position.unrealizedPnLPercent;
    }

    // Check trailing stop logic
    this.updateTrailingStop(position);

    // Check if stop hit
    const stopHit = position.direction === 'long'
      ? currentPrice <= position.currentStopLossPrice
      : currentPrice >= position.currentStopLossPrice;

    if (stopHit) {
      this.closePosition(key, position, currentPrice);
    }

    return position;
  }

  private updateTrailingStop(position: CombinedPosition): void {
    const roiPercent = position.unrealizedPnLPercent;

    // Level 0: Not yet triggered
    if (position.trailLevel === 0) {
      if (roiPercent >= this.config.trailTriggerPercent) {
        position.trailLevel = 1;
        const lockPercent = this.config.level1LockPercent;
        const lockPrice = position.direction === 'long'
          ? position.effectiveEntryPrice * (1 + lockPercent / 100)
          : position.effectiveEntryPrice * (1 - lockPercent / 100);
        position.currentStopLossPrice = lockPrice;
        console.log(`[${this.botId}] ${position.symbol} trail L1 @ ROI ${roiPercent.toFixed(1)}%`);
      }
      return;
    }

    // Higher levels
    const nextLevel = position.trailLevel + 1;
    const nextLevelTrigger = this.config.trailTriggerPercent + (position.trailLevel * this.config.trailStepPercent);

    if (roiPercent >= nextLevelTrigger) {
      position.trailLevel = nextLevel;
      const lockPercent = this.config.level1LockPercent + ((nextLevel - 1) * this.config.trailStepPercent);
      const lockPrice = position.direction === 'long'
        ? position.effectiveEntryPrice * (1 + lockPercent / 100)
        : position.effectiveEntryPrice * (1 - lockPercent / 100);
      position.currentStopLossPrice = lockPrice;
      console.log(`[${this.botId}] ${position.symbol} trail L${nextLevel} @ ROI ${roiPercent.toFixed(1)}%`);
    }
  }

  private closePosition(key: string, position: CombinedPosition, exitPrice: number): void {
    const costs = costsCalculator.calculateExitCosts(
      exitPrice,
      position.notionalSize,
      position.direction,
      'normal'
    );

    const effectiveExitPrice = costs.effectiveExitPrice;

    const priceChange = position.direction === 'long'
      ? (effectiveExitPrice - position.effectiveEntryPrice) / position.effectiveEntryPrice
      : (position.effectiveEntryPrice - effectiveExitPrice) / position.effectiveEntryPrice;

    const grossPnL = priceChange * position.notionalSize;
    const totalCosts = position.entryCosts + costs.exitCosts;
    const realizedPnL = grossPnL - totalCosts;
    const realizedPnLPercent = (realizedPnL / position.marginUsed) * 100;

    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitCosts = costs.exitCosts;
    position.realizedPnL = realizedPnL;
    position.realizedPnLPercent = realizedPnLPercent;
    position.status = 'closed';

    let closeReason = 'initial_stop';
    if (position.trailLevel > 0) {
      closeReason = `trail_L${position.trailLevel}`;
    }
    position.closeReason = closeReason;

    this.balance += position.marginUsed + realizedPnL;
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    this.positions.delete(key);
    this.closedPositions.push(position);

    const emoji = realizedPnL >= 0 ? '✅' : '❌';
    console.log(`[${this.botId}] ${emoji} CLOSED ${position.direction.toUpperCase()} ${position.symbol}`);
    console.log(`   4H ${position.htfBiasDirection} + 5m ${position.ltfSignalDirection} (faded) | PnL: $${realizedPnL.toFixed(2)} (${realizedPnLPercent.toFixed(1)}%) | ${closeReason}`);
  }

  /**
   * Handle setup removal
   */
  handleSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup.symbol, setup.marketType);
    const position = this.positions.get(key);

    if (position) {
      this.closePosition(key, position, position.currentPrice);
    }
  }

  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => (p.realizedPnL || 0) > 0);
    const losses = closed.filter(p => (p.realizedPnL || 0) <= 0);
    const totalPnL = closed.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    // Calculate max drawdown
    let maxDrawdown = 0;
    let runningBalance = this.config.initialBalance;
    let peak = this.config.initialBalance;
    for (const p of closed) {
      runningBalance += p.realizedPnL || 0;
      if (runningBalance > peak) peak = runningBalance;
      const drawdown = peak - runningBalance;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      botId: this.botId,
      strategy: '4H Normal + 5m Fade',
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      totalPnL,
      maxDrawdown,
      maxDrawdownPercent: (maxDrawdown / this.config.initialBalance) * 100,
      openPositions: this.positions.size,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, p) => s + (p.realizedPnL || 0), 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0) / losses.length) : 0,
      profitFactor: Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0)) > 0
        ? wins.reduce((s, p) => s + (p.realizedPnL || 0), 0) / Math.abs(losses.reduce((s, p) => s + (p.realizedPnL || 0), 0))
        : wins.length > 0 ? Infinity : 0,
      alignedSignals: this.alignedSignals,
      skippedSignals: this.skippedSignals,
      activeBiases: this.htfBiases.size,
    };
  }

  getOpenPositions(): CombinedPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): CombinedPosition[] {
    return this.closedPositions;
  }

  getActiveBiases(): Map<string, HtfBias> {
    return new Map(this.htfBiases);
  }

  reset(): void {
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.positions.clear();
    this.closedPositions = [];
    this.htfBiases.clear();
    this.alignedSignals = 0;
    this.skippedSignals = 0;
    console.log(`[${this.botId}] Reset to $${this.balance}`);
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }
}
