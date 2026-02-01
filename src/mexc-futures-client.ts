/**
 * MEXC Futures API Client
 *
 * Uses the cookie bypass method to access MEXC futures API
 * which has been "under maintenance" since July 2022.
 *
 * Authentication uses the u_id cookie from your browser session.
 *
 * Based on: https://github.com/biberhund/MEXC_Future_Order_API_Maintenance_Bypass
 */

import crypto from 'crypto';

// API Endpoints
const MAINNET_BASE = 'https://futures.mexc.com/api/v1';
const TESTNET_BASE = 'https://contract.mexc.com/api/v1'; // Testnet URL (verify this)

// Order sides
export enum OrderSide {
  OPEN_LONG = 1,
  CLOSE_SHORT = 2,
  OPEN_SHORT = 3,
  CLOSE_LONG = 4,
}

// Order types
export enum OrderType {
  LIMIT = 1,
  POST_ONLY = 2,
  IOC = 3,
  FOK = 4,
  MARKET = 5,
  MARKET_IOC = 6,
}

// Position interfaces
export interface MexcPosition {
  positionId: number;
  symbol: string;
  positionType: number; // 1 = long, 2 = short
  openType: number;
  state: number;
  holdVol: number;
  frozenVol: number;
  closeVol: number;
  holdAvgPrice: number;
  openAvgPrice: number;
  closeAvgPrice: number;
  liquidatePrice: number;
  oim: number;
  im: number;
  holdFee: number;
  realised: number;
  leverage: number;
  createTime: number;
  updateTime: number;
  autoAddIm: boolean;
}

export interface MexcAsset {
  currency: string;
  positionMargin: number;
  frozenBalance: number;
  availableBalance: number;
  cashBalance: number;
  equity: number;
  unrealized: number;
}

export interface MexcOrder {
  orderId: string;
  symbol: string;
  positionId: number;
  price: number;
  vol: number;
  leverage: number;
  side: number;
  category: number;
  orderType: number;
  dealAvgPrice: number;
  dealVol: number;
  orderMargin: number;
  takerFee: number;
  makerFee: number;
  profit: number;
  feeCurrency: string;
  openType: number;
  state: number;
  externalOid: string;
  createTime: number;
  updateTime: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  vol: number;
  leverage: number;
  price?: number; // Required for limit orders
  openType?: number; // 1 = isolated, 2 = cross (default: 1)
  stopLossPrice?: number;
  takeProfitPrice?: number;
  externalOid?: string; // Custom order ID
}

export interface MexcClientConfig {
  apiKey: string; // The u_id cookie value (starts with "WEB")
  isTestnet?: boolean;
}

/**
 * MEXC Futures API Client using cookie bypass
 */
// Cached contract details: symbol -> { contractSize, minVol, priceScale, volScale }
interface ContractSpec {
  contractSize: number;
  minVol: number;
  priceScale: number;
  volScale: number;
}
const contractSpecCache = new Map<string, ContractSpec>();
let contractSpecLastFetch = 0;
const CONTRACT_SPEC_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and cache all contract specs from MEXC public API.
 * Does NOT require authentication.
 */
async function ensureContractSpecs(): Promise<void> {
  if (contractSpecCache.size > 0 && Date.now() - contractSpecLastFetch < CONTRACT_SPEC_TTL) return;
  try {
    const resp = await fetch('https://futures.mexc.com/api/v1/contract/detail');
    const data = await resp.json() as { success: boolean; data: Array<Record<string, unknown>> };
    if (!data.success || !Array.isArray(data.data)) return;
    for (const c of data.data) {
      if (c.state !== 0) continue; // only active contracts
      contractSpecCache.set(c.symbol as string, {
        contractSize: c.contractSize as number,
        minVol: (c.minVol as number) || 1,
        priceScale: (c.priceScale as number) || 4,
        volScale: (c.volScale as number) || 0,
      });
    }
    contractSpecLastFetch = Date.now();
    console.log(`[MEXC] Cached ${contractSpecCache.size} contract specs`);
  } catch (err) {
    console.error('[MEXC] Failed to fetch contract specs:', (err as Error).message);
  }
}

/**
 * Convert a USD notional size to the number of contracts for a given symbol.
 * contracts = floor(usdSize / (price * contractSize))
 * Returns at least minVol (1) if the position can be opened.
 */
/**
 * Get the contract size for a symbol (how many tokens per contract).
 * Returns 1 if unknown.
 */
export async function getContractSize(symbol: string): Promise<number> {
  await ensureContractSpecs();
  return contractSpecCache.get(symbol)?.contractSize ?? 1;
}

export async function usdToContracts(symbol: string, usdSize: number, price: number): Promise<number> {
  await ensureContractSpecs();
  const spec = contractSpecCache.get(symbol);
  if (!spec) {
    // Fallback: assume contractSize=1 (true for many altcoins)
    console.warn(`[MEXC] No contract spec for ${symbol}, assuming contractSize=1`);
    return Math.max(1, Math.floor(usdSize / price));
  }
  const valuePerContract = price * spec.contractSize;
  const contracts = Math.floor(usdSize / valuePerContract);
  return Math.max(spec.minVol, contracts);
}

export class MexcFuturesClient {
  private apiKey: string;
  private baseUrl: string;

  // Rate limiting for order cancellations to avoid 429 errors
  private lastCancelTime = 0;
  private static readonly CANCEL_DELAY_MS = 500; // 500ms between cancel operations

  constructor(config: MexcClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.isTestnet ? TESTNET_BASE : MAINNET_BASE;

    if (!this.apiKey || !this.apiKey.startsWith('WEB')) {
      console.warn('[MEXC] Warning: API key should be a u_id cookie starting with "WEB"');
    }
  }

  /**
   * Wait if needed to respect cancel rate limit
   */
  private async waitForCancelRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCancelTime;
    if (elapsed < MexcFuturesClient.CANCEL_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, MexcFuturesClient.CANCEL_DELAY_MS - elapsed));
    }
    this.lastCancelTime = Date.now();
  }

  /**
   * Generate the signature for authenticated requests
   * Based on MEXC's internal signing algorithm
   */
  private generateSignature(timestamp: string, payload: object): string {
    // Create partial hash: md5(key + timestamp), take chars from position 7 onwards
    const partialHashInput = this.apiKey + timestamp;
    const partialHashFull = crypto.createHash('md5').update(partialHashInput).digest('hex');
    const partialHash = partialHashFull.substring(7);

    // Serialize payload with compact JSON (no spaces)
    const serializedPayload = JSON.stringify(payload, null, 0).replace(/\s/g, '');

    // Final signature: md5(timestamp + serializedPayload + partialHash)
    const signatureInput = timestamp + serializedPayload + partialHash;
    return crypto.createHash('md5').update(signatureInput).digest('hex');
  }

  /**
   * Make an authenticated request to MEXC
   */
  private async makeRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    payload: object = {}
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const timestamp = Date.now().toString();
    const signature = this.generateSignature(timestamp, payload);
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-mxc-sign': signature,
      'x-mxc-nonce': timestamp,
      'Authorization': this.apiKey,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    try {
      const options: RequestInit = {
        method,
        headers,
      };

      if (method === 'POST') {
        options.body = JSON.stringify(payload);
      } else if (method === 'GET' && Object.keys(payload).length > 0) {
        const params = new URLSearchParams(payload as Record<string, string>);
        const urlWithParams = `${url}?${params.toString()}`;
        const response = await fetch(urlWithParams, options);
        const data = await response.json();

        if (!response.ok || data.code !== 0) {
          return { success: false, error: data.message || `HTTP ${response.status}` };
        }
        return { success: true, data: data.data };
      }

      const response = await fetch(url, options);
      const data = await response.json();

      if (!response.ok || data.code !== 0) {
        return { success: false, error: data.message || `HTTP ${response.status}` };
      }

      return { success: true, data: data.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[MEXC] Request failed:', message);
      return { success: false, error: message };
    }
  }

  // ============ Account Endpoints ============

  /**
   * Get account assets (balance info)
   */
  async getAssets(): Promise<{ success: boolean; data?: MexcAsset[]; error?: string }> {
    return this.makeRequest<MexcAsset[]>('GET', '/private/account/assets');
  }

  /**
   * Get USDT balance specifically
   */
  async getUsdtBalance(): Promise<{ success: boolean; balance?: number; available?: number; error?: string }> {
    const result = await this.getAssets();
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    const usdt = result.data.find(a => a.currency === 'USDT');
    if (!usdt) {
      return { success: false, error: 'USDT asset not found' };
    }

    return {
      success: true,
      balance: usdt.equity,
      available: usdt.availableBalance,
    };
  }

  // ============ Position Endpoints ============

  /**
   * Get all open positions
   */
  async getOpenPositions(): Promise<{ success: boolean; data?: MexcPosition[]; error?: string }> {
    return this.makeRequest<MexcPosition[]>('GET', '/private/position/open_positions');
  }

  /**
   * Get closed position history (last N days)
   * This uses the web interface endpoint for position history
   */
  async getPositionHistory(pageNum = 1, pageSize = 20): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return this.makeRequest<any[]>('GET', '/private/position/list/history_positions', {
      page_num: pageNum.toString(),
      page_size: pageSize.toString(),
    });
  }

  /**
   * Alternative: Get all historical positions
   */
  async getHistoricalPositions(): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return this.makeRequest<any[]>('GET', '/private/position/history_positions');
  }

  /**
   * Get position for a specific symbol
   */
  async getPosition(symbol: string): Promise<{ success: boolean; data?: MexcPosition; error?: string }> {
    const result = await this.getOpenPositions();
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    const position = result.data.find(p => p.symbol === symbol);
    return position
      ? { success: true, data: position }
      : { success: false, error: `No position found for ${symbol}` };
  }

  // ============ Order Endpoints ============

  /**
   * Place a new order
   */
  async createOrder(params: OrderParams): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const payload: Record<string, unknown> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      vol: params.vol,
      leverage: params.leverage,
      openType: params.openType || 1, // Default to isolated margin
    };

    // Add optional params (skip zero/falsy SL/TP — MEXC rejects price=0)
    if (params.price !== undefined) payload.price = params.price;
    if (params.stopLossPrice) payload.stopLossPrice = params.stopLossPrice;
    if (params.takeProfitPrice) payload.takeProfitPrice = params.takeProfitPrice;
    if (params.externalOid) payload.externalOid = params.externalOid;

    console.log('[MEXC] Creating order:', payload);
    return this.makeRequest<MexcOrder>('POST', '/private/order/create', payload);
  }

  /**
   * Cancel an order (rate-limited to avoid 429 errors)
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    await this.waitForCancelRateLimit();
    return this.makeRequest('POST', '/private/order/cancel', { orderId });
  }

  /**
   * Cancel all orders for a symbol (rate-limited to avoid 429 errors)
   */
  async cancelAllOrders(symbol: string): Promise<{ success: boolean; error?: string }> {
    await this.waitForCancelRateLimit();
    return this.makeRequest('POST', '/private/order/cancel_all', { symbol });
  }

  /**
   * Get open orders for a symbol
   * Note: Symbol is required for this endpoint
   */
  async getOpenOrders(symbol: string, pageNum = 1, pageSize = 20): Promise<{ success: boolean; data?: MexcOrder[]; error?: string }> {
    return this.makeRequest<MexcOrder[]>('GET', `/private/order/list/open_orders/${symbol}`, {
      page_num: pageNum.toString(),
      page_size: pageSize.toString(),
    });
  }

  /**
   * Get all open orders across all symbols
   */
  async getAllOpenOrders(): Promise<{ success: boolean; data?: MexcOrder[]; error?: string }> {
    // First get positions to know which symbols to check
    const positionsResult = await this.getOpenPositions();
    if (!positionsResult.success) {
      return { success: false, error: positionsResult.error };
    }

    const symbols = new Set<string>();
    for (const pos of positionsResult.data || []) {
      symbols.add(pos.symbol);
    }

    // If no positions, check common symbols
    if (symbols.size === 0) {
      symbols.add('BTC_USDT');
    }

    const allOrders: MexcOrder[] = [];
    for (const symbol of symbols) {
      const result = await this.getOpenOrders(symbol);
      if (result.success && result.data) {
        allOrders.push(...result.data);
      }
    }

    return { success: true, data: allOrders };
  }

  /**
   * Get order history
   */
  async getOrderHistory(symbol: string, pageNum = 1, pageSize = 20): Promise<{ success: boolean; data?: MexcOrder[]; error?: string }> {
    return this.makeRequest<MexcOrder[]>('GET', '/private/order/history', {
      symbol,
      page_num: pageNum.toString(),
      page_size: pageSize.toString(),
    });
  }

  // ============ Stop Order / Plan Order Endpoints ============

  /**
   * Get stop orders (SL/TP orders) for a position
   */
  async getStopOrders(symbol: string, pageNum = 1, pageSize = 20): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return this.makeRequest<any[]>('GET', `/private/stoporder/list/orders/${symbol}`, {
      page_num: pageNum.toString(),
      page_size: pageSize.toString(),
    });
  }

  /**
   * Create a stop order (SL or TP) for a position
   * This creates a trigger order that executes when price hits the specified level
   *
   * @param symbol - Contract symbol (e.g., 'DOGE_USDT')
   * @param vol - Volume to close
   * @param side - 1=open long, 2=close short, 3=open short, 4=close long
   * @param triggerPrice - Price that triggers the order
   * @param triggerType - Comparison: 1=greater than or equal, 2=less than or equal
   * @param trend - Price type: 1=latest price, 2=fair price, 3=index price
   * @param executeCycle - Duration: 1=24 hours, 2=7 days
   * @param orderType - 1=limit, 5=market
   * @param openType - 1=isolated, 2=cross
   */
  async createStopOrder(params: {
    symbol: string;
    vol: number;
    side: OrderSide; // CLOSE_LONG (4) for long SL/TP, CLOSE_SHORT (2) for short SL/TP
    triggerPrice: number;
    triggerType: number; // 1=>=, 2=<=
    trend?: number; // 1=latest, 2=fair, 3=index (default: 1)
    executeCycle?: number; // 1=24h, 2=7d (default: 2)
    orderType?: number; // 1=limit, 5=market (default: 5)
    openType?: number; // 1=isolated, 2=cross (default: 1)
    price?: number; // Required for limit orders
    leverage?: number; // Required for isolated margin
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    const payload: Record<string, unknown> = {
      symbol: params.symbol,
      vol: params.vol,
      side: params.side,
      triggerPrice: params.triggerPrice,
      triggerType: params.triggerType,
      trend: params.trend || 1, // Default: latest price
      executeCycle: params.executeCycle || 2, // Default: 7 days
      orderType: params.orderType || 5, // Default: market
      openType: params.openType || 1, // Default: isolated
    };

    // Add price for limit orders
    if (params.orderType === 1 && params.price !== undefined) {
      payload.price = params.price;
    }

    // Add leverage for isolated margin
    if (params.leverage !== undefined) {
      payload.leverage = params.leverage;
    }

    console.log('[MEXC] Creating plan order:', payload);
    return this.makeRequest<any>('POST', '/private/planorder/place', payload);
  }

  /**
   * Cancel a stop order (rate-limited to avoid 429 errors)
   */
  async cancelStopOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    await this.waitForCancelRateLimit();
    return this.makeRequest('POST', '/private/stoporder/cancel', { orderId });
  }

  /**
   * Modify stop order prices
   * Note: This is for modifying an existing stop order's trigger price
   */
  async modifyStopOrder(params: {
    stopPlanOrderId: string;
    stopLossPrice?: number;
    takeProfitPrice?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const payload: Record<string, unknown> = {
      stopPlanOrderId: params.stopPlanOrderId,
    };
    if (params.stopLossPrice !== undefined) payload.stopLossPrice = params.stopLossPrice;
    if (params.takeProfitPrice !== undefined) payload.takeProfitPrice = params.takeProfitPrice;

    return this.makeRequest('POST', '/private/stoporder/change_plan_price', payload);
  }

  /**
   * Get plan orders (trigger orders)
   */
  async getPlanOrders(symbol: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return this.makeRequest<any[]>('GET', `/private/planorder/list/orders/${symbol}`);
  }

  /**
   * Cancel a plan order (rate-limited to avoid 429 errors)
   */
  async cancelPlanOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    await this.waitForCancelRateLimit();
    return this.makeRequest('POST', '/private/planorder/cancel', { orderId });
  }

  /**
   * Cancel all plan orders for a symbol (rate-limited to avoid 429 errors)
   */
  async cancelAllPlanOrders(symbol: string): Promise<{ success: boolean; error?: string }> {
    await this.waitForCancelRateLimit();
    return this.makeRequest('POST', '/private/planorder/cancel_all', { symbol });
  }

  /**
   * Helper: Set stop-loss for an existing position
   * Creates a market order that triggers when price drops to stopPrice (for longs)
   * or rises to stopPrice (for shorts)
   *
   * IMPORTANT: This cancels ALL existing plan orders for the symbol first to prevent duplicates.
   */
  async setStopLoss(
    symbol: string,
    stopPrice: number,
    volume?: number // If not provided, uses full position
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    // Get the position info
    const posResult = await this.getPosition(symbol);
    if (!posResult.success || !posResult.data) {
      return { success: false, error: posResult.error || 'No position found' };
    }

    const position = posResult.data;
    const vol = volume || position.holdVol;
    const isLong = position.positionType === 1;
    const side = isLong ? OrderSide.CLOSE_LONG : OrderSide.CLOSE_SHORT;

    // For stop-loss:
    // - Long position: trigger when price <= stopPrice (falling)
    // - Short position: trigger when price >= stopPrice (rising)
    const triggerType = isLong ? 2 : 1; // 2=<=, 1=>=

    // DUPLICATE ORDER FIX: Cancel all existing plan orders BEFORE creating new one
    // This prevents accumulation of orphaned orders
    try {
      await this.cancelAllPlanOrders(symbol);
    } catch (e) {
      // Not fatal - continue with creation
      console.warn(`[MEXC-CLIENT] Failed to cancel existing orders for ${symbol} before setStopLoss: ${(e as Error).message}`);
    }

    return this.createStopOrder({
      symbol,
      vol,
      side,
      triggerPrice: stopPrice,
      triggerType,
      trend: 1, // Use latest price
      openType: position.openType || 1,
      leverage: position.leverage,
    });
  }

  /**
   * Helper: Set take-profit for an existing position
   * Creates a market order that triggers when price rises to targetPrice (for longs)
   * or drops to targetPrice (for shorts)
   */
  async setTakeProfit(
    symbol: string,
    targetPrice: number,
    volume?: number // If not provided, uses full position
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    // Get the position info
    const posResult = await this.getPosition(symbol);
    if (!posResult.success || !posResult.data) {
      return { success: false, error: posResult.error || 'No position found' };
    }

    const position = posResult.data;
    const vol = volume || position.holdVol;
    const isLong = position.positionType === 1;
    const side = isLong ? OrderSide.CLOSE_LONG : OrderSide.CLOSE_SHORT;

    // For take-profit:
    // - Long position: trigger when price >= targetPrice (rising)
    // - Short position: trigger when price <= targetPrice (falling)
    const triggerType = isLong ? 1 : 2; // 1=>=, 2=<=

    return this.createStopOrder({
      symbol,
      vol,
      side,
      triggerPrice: targetPrice,
      triggerType,
      trend: 1, // Use latest price
      openType: position.openType || 1,
      leverage: position.leverage,
    });
  }

  // ============ Leverage Endpoints ============

  /**
   * Get current leverage settings for a symbol
   * Returns both long and short leverage
   */
  async getLeverage(symbol: string): Promise<{
    success: boolean;
    longLeverage?: number;
    shortLeverage?: number;
    error?: string
  }> {
    // The leverage endpoint returns an array with leverage info
    interface LeverageItem {
      positionType: number; // 1 = long, 2 = short
      leverage: number;
    }
    const result = await this.makeRequest<LeverageItem[]>('GET', '/private/position/leverage', { symbol });
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    // Handle both array and object responses
    const data = result.data;
    if (Array.isArray(data)) {
      const longItem = data.find(item => item.positionType === 1);
      const shortItem = data.find(item => item.positionType === 2);
      return {
        success: true,
        longLeverage: longItem?.leverage,
        shortLeverage: shortItem?.leverage,
      };
    }

    // If it's a single object with longLeverage/shortLeverage fields
    const obj = data as unknown as { longLeverage?: number; shortLeverage?: number; leverage?: number };
    return {
      success: true,
      longLeverage: obj.longLeverage ?? obj.leverage,
      shortLeverage: obj.shortLeverage ?? obj.leverage,
    };
  }

  /**
   * Set leverage for a symbol
   * @param positionId - Position ID (required if position exists)
   * @param leverage - New leverage value
   * @param symbol - Symbol (required if no position)
   * @param openType - 1=isolated, 2=cross (required if no position)
   * @param positionType - 1=long, 2=short (required if no position)
   */
  async setLeverage(
    leverage: number,
    options: {
      positionId?: number;
      symbol?: string;
      openType?: number;
      positionType?: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const payload: Record<string, unknown> = { leverage };

    if (options.positionId) {
      payload.positionId = options.positionId;
    } else {
      // When no position exists, need symbol, openType, and positionType
      if (options.symbol) payload.symbol = options.symbol;
      if (options.openType) payload.openType = options.openType;
      if (options.positionType) payload.positionType = options.positionType;
    }

    return this.makeRequest('POST', '/private/position/change_leverage', payload);
  }

  /**
   * Convenience method to set leverage for a new position
   */
  async setSymbolLeverage(
    symbol: string,
    leverage: number,
    positionType: 'long' | 'short' = 'long',
    marginType: 'isolated' | 'cross' = 'isolated'
  ): Promise<{ success: boolean; error?: string }> {
    return this.setLeverage(leverage, {
      symbol,
      openType: marginType === 'isolated' ? 1 : 2,
      positionType: positionType === 'long' ? 1 : 2,
    });
  }

  // ============ Market Data Endpoints ============

  /**
   * Get ticker price for a symbol
   */
  async getTickerPrice(symbol: string): Promise<{ success: boolean; price?: number; error?: string }> {
    const result = await this.makeRequest<{ lastPrice: number }>('GET', '/contract/ticker', { symbol });
    if (!result.success) return { success: false, error: result.error };
    return { success: true, price: result.data?.lastPrice };
  }

  /**
   * Check if the API connection is working
   */
  async testConnection(): Promise<{ success: boolean; balance?: number; error?: string }> {
    console.log('[MEXC] Testing connection...');
    const result = await this.getUsdtBalance();

    if (result.success) {
      console.log(`[MEXC] Connection successful! Balance: $${result.balance?.toFixed(2)}`);
    } else {
      console.error('[MEXC] Connection failed:', result.error);
    }

    return result;
  }

  // ============ Helper Methods ============

  /**
   * Place a market long order with stop loss and take profit
   */
  async openLong(
    symbol: string,
    volume: number,
    leverage: number,
    stopLossPrice?: number,
    takeProfitPrice?: number
  ): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    return this.createOrder({
      symbol,
      side: OrderSide.OPEN_LONG,
      type: OrderType.MARKET,
      vol: volume,
      leverage,
      stopLossPrice,
      takeProfitPrice,
    });
  }

  /**
   * Place a market short order with stop loss and take profit
   */
  async openShort(
    symbol: string,
    volume: number,
    leverage: number,
    stopLossPrice?: number,
    takeProfitPrice?: number
  ): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    return this.createOrder({
      symbol,
      side: OrderSide.OPEN_SHORT,
      type: OrderType.MARKET,
      vol: volume,
      leverage,
      stopLossPrice,
      takeProfitPrice,
    });
  }

  /**
   * Close a long position
   * Also cancels any associated plan orders (SL/TP) for clean exit
   */
  async closeLong(symbol: string, volume: number, cancelPlanOrders = true): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const position = await this.getPosition(symbol);
    if (!position.success || !position.data) {
      return { success: false, error: position.error || 'No position to close' };
    }

    // Cancel associated plan orders first to avoid orphaned SL/TP
    if (cancelPlanOrders) {
      await this.cancelAllPlanOrders(symbol);
    }

    return this.createOrder({
      symbol,
      side: OrderSide.CLOSE_LONG,
      type: OrderType.MARKET,
      vol: volume,
      leverage: position.data.leverage,
    });
  }

  /**
   * Close a short position
   * Also cancels any associated plan orders (SL/TP) for clean exit
   */
  async closeShort(symbol: string, volume: number, cancelPlanOrders = true): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const position = await this.getPosition(symbol);
    if (!position.success || !position.data) {
      return { success: false, error: position.error || 'No position to close' };
    }

    // Cancel associated plan orders first to avoid orphaned SL/TP
    if (cancelPlanOrders) {
      await this.cancelAllPlanOrders(symbol);
    }

    return this.createOrder({
      symbol,
      side: OrderSide.CLOSE_SHORT,
      type: OrderType.MARKET,
      vol: volume,
      leverage: position.data.leverage,
    });
  }

  /**
   * Close any position (auto-detects long/short)
   * Also cancels any associated plan orders
   */
  async closePosition(symbol: string, volume?: number): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const position = await this.getPosition(symbol);
    if (!position.success || !position.data) {
      return { success: false, error: position.error || 'No position to close' };
    }

    const vol = volume || position.data.holdVol;
    const isLong = position.data.positionType === 1;

    return isLong
      ? this.closeLong(symbol, vol)
      : this.closeShort(symbol, vol);
  }
}

// Export a factory function for convenience
export function createMexcClient(apiKey: string, isTestnet = false): MexcFuturesClient {
  return new MexcFuturesClient({ apiKey, isTestnet });
}
