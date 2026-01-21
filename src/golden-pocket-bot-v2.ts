import type { BackburnerSetup, MarketType } from './types.js';
import { getDataPersistence } from './data-persistence.js';
import type { GoldenPocketV2Setup } from './golden-pocket-detector-v2.js';

/**
 * Golden Pocket Bot V2 Configuration
 *
 * Uses the same trading logic as V1 but works with V2 detector
 * which has loosened RSI thresholds for more frequent signals.
 */
export interface GoldenPocketBotV2Config {
  initialBalance: number;
  positionSizePercent: number;
  leverage: number;
  maxOpenPositions: number;
  requireFutures?: boolean;
  splitEntry: boolean;
  entryLevels: number[];
  entryWeights: number[];
}

const DEFAULT_CONFIG: GoldenPocketBotV2Config = {
  initialBalance: 2000,
  positionSizePercent: 2,
  leverage: 10,
  maxOpenPositions: 100,  // V2: Effectively unlimited - don't miss trades
  requireFutures: true,
  splitEntry: false,
  entryLevels: [0.618, 0.635, 0.65],
  entryWeights: [0.33, 0.33, 0.34],
};

export type GPV2PositionStatus =
  | 'open'
  | 'partial_tp1'
  | 'closed_tp1'
  | 'closed_tp2'
  | 'closed_sl'
  | 'closed_invalidated';

export interface GoldenPocketV2Position {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  marketType: MarketType;
  timeframe: string;
  entryPrice: number;
  entryTime: number;
  marginUsed: number;
  notionalSize: number;
  leverage: number;
  tp1Price: number;
  tp2Price: number;
  stopPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  status: GPV2PositionStatus;
  remainingSize: number;
  tp1Closed: boolean;
  tp1PnL?: number;
  exitPrice?: number;
  exitTime?: number;
  realizedPnL?: number;
  realizedPnLPercent?: number;
  exitReason?: string;
  fibHigh: number;
  fibLow: number;
  retracementAtEntry: number;
  isV2: true;  // Flag to identify V2 positions
}

export interface GoldenPocketV2Stats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  currentBalance: number;
  peakBalance: number;
  maxDrawdown: number;
  tp1HitRate: number;
  tp2HitRate: number;
  avgRetracementAtEntry: number;
}

/**
 * Golden Pocket Trading Bot V2
 *
 * Same trading logic as V1, but designed to work with the V2 detector
 * which has loosened thresholds. This allows A/B testing between
 * strict (V1) and loose (V2) signal generation.
 */
export class GoldenPocketBotV2 {
  private config: GoldenPocketBotV2Config;
  private positions: Map<string, GoldenPocketV2Position> = new Map();
  private closedPositions: GoldenPocketV2Position[] = [];
  private balance: number;
  private peakBalance: number;
  private botId: string;
  private tp1Hits: number = 0;
  private tp2Hits: number = 0;
  private totalRetracementAtEntry: number = 0;

  constructor(config?: Partial<GoldenPocketBotV2Config>, botId = 'gp2-standard') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.botId = botId;
  }

  getBotId(): string {
    return this.botId;
  }

  getConfig(): GoldenPocketBotV2Config {
    return { ...this.config };
  }

  private getPositionKey(setup: BackburnerSetup): string {
    return `${setup.symbol}-${setup.timeframe}-${setup.direction}-${setup.marketType}`;
  }

  private generatePositionId(setup: BackburnerSetup): string {
    return `gp2-${setup.symbol}-${setup.timeframe}-${Date.now()}`;
  }

  private isGoldenPocketV2Setup(setup: BackburnerSetup): setup is GoldenPocketV2Setup {
    return 'fibLevels' in setup && 'tp1Price' in setup && 'stopPrice' in setup && 'isV2' in setup;
  }

  openPosition(setup: BackburnerSetup): GoldenPocketV2Position | null {
    if (!this.isGoldenPocketV2Setup(setup)) {
      return null;
    }

    if (setup.state !== 'triggered' && setup.state !== 'deep_extreme') {
      return null;
    }

    if (this.config.requireFutures && setup.marketType !== 'futures') {
      return null;
    }

    const key = this.getPositionKey(setup);

    if (this.positions.has(key)) {
      return null;
    }

    if (this.positions.size >= this.config.maxOpenPositions) {
      return null;
    }

    const margin = this.balance * (this.config.positionSizePercent / 100);
    const notional = margin * this.config.leverage;

    if (margin > this.balance) {
      return null;
    }

    const entryPrice = setup.currentPrice;

    const position: GoldenPocketV2Position = {
      id: this.generatePositionId(setup),
      symbol: setup.symbol,
      direction: setup.direction,
      marketType: setup.marketType,
      timeframe: setup.timeframe,
      entryPrice,
      entryTime: Date.now(),
      marginUsed: margin,
      notionalSize: notional,
      leverage: this.config.leverage,
      tp1Price: setup.tp1Price,
      tp2Price: setup.tp2Price,
      stopPrice: setup.stopPrice,
      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      status: 'open',
      remainingSize: notional,
      tp1Closed: false,
      fibHigh: setup.fibLevels.high,
      fibLow: setup.fibLevels.low,
      retracementAtEntry: setup.retracementPercent,
      isV2: true,
    };

    this.balance -= margin;
    this.positions.set(key, position);
    this.totalRetracementAtEntry += setup.retracementPercent;

    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[GP2:${this.botId} ${timestamp}] OPENED: ${setup.symbol} ${setup.direction.toUpperCase()} @ ${entryPrice.toPrecision(6)} | ` +
      `Retracement: ${setup.retracementPercent.toFixed(1)}% | TP1: ${setup.tp1Price.toPrecision(6)} | TP2: ${setup.tp2Price.toPrecision(6)} | SL: ${setup.stopPrice.toPrecision(6)}`
    );

    try {
      const logPosition = {
        ...position,
        takeProfitPrice: position.tp1Price,
        stopLossPrice: position.stopPrice,
      };
      getDataPersistence().logTradeOpen(this.botId, logPosition as any, setup);
    } catch (e) {
      console.error(`[GP2:${this.botId}] Failed to log trade open:`, e);
    }

    return position;
  }

  updatePosition(setup: BackburnerSetup): GoldenPocketV2Position | null {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (!position || position.status === 'closed_tp2' || position.status === 'closed_sl' || position.status === 'closed_invalidated') {
      return null;
    }

    position.currentPrice = setup.currentPrice;

    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    position.unrealizedPnL = position.remainingSize * priceChange;
    position.unrealizedPnLPercent = priceChange * 100;

    this.checkExitConditions(position, setup);

    return position;
  }

  private checkExitConditions(position: GoldenPocketV2Position, setup: BackburnerSetup): void {
    if (position.direction === 'long') {
      if (position.currentPrice <= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      if (!position.tp1Closed && position.currentPrice >= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      if (position.currentPrice >= position.tp2Price * 0.998) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing High Retest)');
        return;
      }
    }

    if (position.direction === 'short') {
      if (position.currentPrice >= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      if (!position.tp1Closed && position.currentPrice <= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      if (position.currentPrice <= position.tp2Price * 1.002) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing Low Retest)');
        return;
      }
    }
  }

  private partialClose(position: GoldenPocketV2Position, level: 'tp1'): void {
    if (level === 'tp1' && !position.tp1Closed) {
      const closeSize = position.notionalSize * 0.5;
      const priceChange = position.direction === 'long'
        ? (position.currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - position.currentPrice) / position.entryPrice;

      const pnl = closeSize * priceChange;

      position.tp1Closed = true;
      position.tp1PnL = pnl;
      position.remainingSize = position.notionalSize * 0.5;
      position.status = 'partial_tp1';

      const marginReturn = position.marginUsed * 0.5;
      this.balance += marginReturn + pnl;
      position.marginUsed *= 0.5;

      if (this.balance > this.peakBalance) {
        this.peakBalance = this.balance;
      }

      this.tp1Hits++;

      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `[GP2:${this.botId} ${timestamp}] PARTIAL TP1: ${position.symbol} | Closed 50% @ ${position.currentPrice.toPrecision(6)} | ` +
        `PnL: $${pnl.toFixed(2)} (${(priceChange * 100).toFixed(2)}%) | Remaining: $${position.remainingSize.toFixed(2)}`
      );
    }
  }

  private closePosition(position: GoldenPocketV2Position, status: GPV2PositionStatus, reason: string): void {
    const key = `${position.symbol}-${position.timeframe}-${position.direction}-${position.marketType}`;

    if (!this.positions.has(key)) {
      return;
    }

    const priceChange = position.direction === 'long'
      ? (position.currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - position.currentPrice) / position.entryPrice;

    const remainingPnL = position.remainingSize * priceChange;
    const totalPnL = (position.tp1PnL || 0) + remainingPnL;

    position.realizedPnL = totalPnL;
    position.realizedPnLPercent = (totalPnL / position.notionalSize) * 100;
    position.exitPrice = position.currentPrice;
    position.exitTime = Date.now();
    position.status = status;
    position.exitReason = reason;

    this.balance += position.marginUsed + remainingPnL;

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    if (status === 'closed_tp2') {
      this.tp2Hits++;
    }

    this.positions.delete(key);
    this.closedPositions.push(position);

    const timestamp = new Date().toLocaleTimeString();
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;
    console.log(
      `[GP2:${this.botId} ${timestamp}] CLOSED: ${position.symbol} | ${reason} | ` +
      `PnL: ${pnlStr} (${position.realizedPnLPercent?.toFixed(2)}%) | Balance: $${this.balance.toFixed(2)}`
    );

    try {
      const logPosition = {
        ...position,
        takeProfitPrice: position.tp1Price,
        stopLossPrice: position.stopPrice,
        exitPrice: position.exitPrice || position.currentPrice,
        exitTime: position.exitTime || Date.now(),
        exitReason: reason,
        realizedPnL: totalPnL,
        realizedPnLPercent: position.realizedPnLPercent,
      };
      getDataPersistence().logTradeClose(this.botId, logPosition as any);
    } catch (e) {
      console.error(`[GP2:${this.botId}] Failed to log trade close:`, e);
    }
  }

  onSetupRemoved(setup: BackburnerSetup): void {
    const key = this.getPositionKey(setup);
    const position = this.positions.get(key);

    if (position && position.status === 'open') {
      if (setup.state === 'played_out') {
        const priceChange = position.direction === 'long'
          ? (position.currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - position.currentPrice) / position.entryPrice;

        if (priceChange < 0) {
          return;
        }

        if (priceChange > 0.05) {
          this.closePosition(position, 'closed_tp1', 'Setup Removed (In Profit)');
        }
      }
    }
  }

  getOpenPositions(): GoldenPocketV2Position[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(limit = 50): GoldenPocketV2Position[] {
    return this.closedPositions.slice(-limit).reverse();
  }

  getStats(): GoldenPocketV2Stats {
    const wins = this.closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.realizedPnL || 0) <= 0);
    const totalPnL = this.closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);

    return {
      totalTrades: this.closedPositions.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedPositions.length > 0 ? (wins.length / this.closedPositions.length) * 100 : 0,
      totalPnL,
      currentBalance: this.balance,
      peakBalance: this.peakBalance,
      maxDrawdown: this.peakBalance - Math.min(this.balance, ...this.closedPositions.map(() => this.balance)),
      tp1HitRate: this.closedPositions.length > 0 ? (this.tp1Hits / this.closedPositions.length) * 100 : 0,
      tp2HitRate: this.closedPositions.length > 0 ? (this.tp2Hits / this.closedPositions.length) * 100 : 0,
      avgRetracementAtEntry: this.closedPositions.length > 0
        ? this.totalRetracementAtEntry / (this.closedPositions.length + this.positions.size)
        : 0,
    };
  }

  getBalance(): number {
    return this.balance;
  }

  getUnrealizedPnL(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.unrealizedPnL || 0;
    }
    return total;
  }

  updateAllPositionsWithPrices(priceMap: Map<string, number>): void {
    for (const [key, position] of this.positions) {
      const price = priceMap.get(position.symbol);
      if (price && (position.status === 'open' || position.status === 'partial_tp1')) {
        position.currentPrice = price;

        const priceChange = position.direction === 'long'
          ? (position.currentPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - position.currentPrice) / position.entryPrice;

        position.unrealizedPnL = position.remainingSize * priceChange;
        position.unrealizedPnLPercent = priceChange * 100;

        this.checkExitConditionsWithPrice(position, price);
      }
    }
  }

  private checkExitConditionsWithPrice(position: GoldenPocketV2Position, currentPrice: number): void {
    if (position.direction === 'long') {
      if (currentPrice <= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      if (!position.tp1Closed && currentPrice >= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      if (currentPrice >= position.tp2Price * 0.998) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing High Retest)');
        return;
      }
    }

    if (position.direction === 'short') {
      if (currentPrice >= position.stopPrice) {
        this.closePosition(position, 'closed_sl', 'Stop Loss Hit (0.786 Invalidation)');
        return;
      }

      if (!position.tp1Closed && currentPrice <= position.tp1Price) {
        this.partialClose(position, 'tp1');
      }

      if (currentPrice <= position.tp2Price * 1.002) {
        this.closePosition(position, 'closed_tp2', 'Full Target Hit (Swing Low Retest)');
        return;
      }
    }
  }

  getOpenSymbols(): string[] {
    const symbols = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.status === 'open' || position.status === 'partial_tp1') {
        symbols.add(position.symbol);
      }
    }
    return Array.from(symbols);
  }

  restoreState(
    positions: GoldenPocketV2Position[],
    closedPositions: GoldenPocketV2Position[],
    balance: number
  ): void {
    this.positions.clear();
    for (const pos of positions) {
      const key = `${pos.symbol}-${pos.timeframe}-${pos.direction}-${pos.marketType}`;
      this.positions.set(key, pos);
    }
    this.closedPositions = closedPositions;
    this.balance = balance;

    console.log(`[GP2:${this.botId}] Restored state: ${positions.length} open, ${closedPositions.length} closed, balance: $${balance.toFixed(2)}`);
  }

  /**
   * Reset bot to initial state (for daily reset feature)
   */
  reset(): void {
    this.positions.clear();
    this.closedPositions = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.tp1Hits = 0;
    this.tp2Hits = 0;
    this.totalRetracementAtEntry = 0;
    console.log(`[GP2:${this.botId}] Reset to initial state: $${this.balance}`);
  }

  setInitialBalance(amount: number): void { this.config.initialBalance = amount; }
}
