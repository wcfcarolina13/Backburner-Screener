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
export class MexcFuturesClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: MexcClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.isTestnet ? TESTNET_BASE : MAINNET_BASE;

    if (!this.apiKey || !this.apiKey.startsWith('WEB')) {
      console.warn('[MEXC] Warning: API key should be a u_id cookie starting with "WEB"');
    }
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

    // Add optional params
    if (params.price !== undefined) payload.price = params.price;
    if (params.stopLossPrice !== undefined) payload.stopLossPrice = params.stopLossPrice;
    if (params.takeProfitPrice !== undefined) payload.takeProfitPrice = params.takeProfitPrice;
    if (params.externalOid) payload.externalOid = params.externalOid;

    console.log('[MEXC] Creating order:', payload);
    return this.makeRequest<MexcOrder>('POST', '/private/order/create', payload);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    return this.makeRequest('POST', '/private/order/cancel', { orderId });
  }

  /**
   * Cancel all orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<{ success: boolean; error?: string }> {
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
   */
  async closeLong(symbol: string, volume: number): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const position = await this.getPosition(symbol);
    if (!position.success || !position.data) {
      return { success: false, error: position.error || 'No position to close' };
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
   */
  async closeShort(symbol: string, volume: number): Promise<{ success: boolean; data?: MexcOrder; error?: string }> {
    const position = await this.getPosition(symbol);
    if (!position.success || !position.data) {
      return { success: false, error: position.error || 'No position to close' };
    }

    return this.createOrder({
      symbol,
      side: OrderSide.CLOSE_SHORT,
      type: OrderType.MARKET,
      vol: volume,
      leverage: position.data.leverage,
    });
  }
}

// Export a factory function for convenience
export function createMexcClient(apiKey: string, isTestnet = false): MexcFuturesClient {
  return new MexcFuturesClient({ apiKey, isTestnet });
}
