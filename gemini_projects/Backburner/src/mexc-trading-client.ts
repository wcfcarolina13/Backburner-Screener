/**
 * MEXC Futures Trading Client - Authenticated API
 *
 * SECURITY NOTES:
 * - API keys are loaded from environment variables only
 * - Keys are NEVER logged, exposed in errors, or stored in memory longer than needed
 * - All requests are signed with HMAC-SHA256
 * - IP whitelist should be configured in MEXC dashboard for extra security
 */

import * as crypto from 'crypto';

const MEXC_FUTURES_API = 'https://contract.mexc.com';

// Safety configuration loaded from environment
interface SafetyConfig {
  liveTradingEnabled: boolean;
  maxPositionSizeUsdt: number;
  maxTotalExposureUsdt: number;
  maxLeverage: number;
  blacklistedSymbols: Set<string>;
  emergencyStop: boolean;
}

// Order types
export type OrderSide = 'BUY' | 'SELL';  // BUY = open long / close short, SELL = open short / close long
export type OrderType = 'MARKET' | 'LIMIT';
export type PositionSide = 'LONG' | 'SHORT';

export interface FuturesOrder {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;       // In contracts
  price?: number;         // Required for LIMIT orders
  leverage?: number;      // Optional, sets leverage before order
  reduceOnly?: boolean;   // True to close position only
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  symbol?: string;
  side?: OrderSide;
  quantity?: number;
  price?: number;
  status?: string;
  error?: string;
}

export interface PositionInfo {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginUsed: number;
  liquidationPrice: number;
}

export interface AccountInfo {
  availableBalance: number;
  totalBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  positions: PositionInfo[];
}

class MexcTradingClient {
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private safetyConfig: SafetyConfig;
  private initialized = false;

  constructor() {
    // Load safety config from environment
    this.safetyConfig = {
      liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
      maxPositionSizeUsdt: parseFloat(process.env.MAX_POSITION_SIZE_USDT || '100'),
      maxTotalExposureUsdt: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USDT || '500'),
      maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20', 10),
      blacklistedSymbols: new Set((process.env.BLACKLISTED_SYMBOLS || '').split(',').filter(Boolean)),
      emergencyStop: process.env.EMERGENCY_STOP === 'true',
    };
  }

  /**
   * Initialize the client with API credentials
   * Call this once at startup after loading environment
   */
  initialize(): boolean {
    const key = process.env.MEXC_API_KEY;
    const secret = process.env.MEXC_API_SECRET;

    if (!key || !secret) {
      console.warn('[MEXC-CLIENT] API credentials not found in environment. Live trading disabled.');
      return false;
    }

    if (key.length < 20 || secret.length < 20) {
      console.warn('[MEXC-CLIENT] API credentials appear invalid. Live trading disabled.');
      return false;
    }

    this.apiKey = key;
    this.apiSecret = secret;
    this.initialized = true;

    console.log('[MEXC-CLIENT] Initialized successfully');
    console.log(`[MEXC-CLIENT] Live trading: ${this.safetyConfig.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`[MEXC-CLIENT] Max position: $${this.safetyConfig.maxPositionSizeUsdt}`);
    console.log(`[MEXC-CLIENT] Max exposure: $${this.safetyConfig.maxTotalExposureUsdt}`);
    console.log(`[MEXC-CLIENT] Max leverage: ${this.safetyConfig.maxLeverage}x`);

    return true;
  }

  /**
   * Check if client is ready for trading
   */
  isReady(): boolean {
    return this.initialized && this.apiKey !== null && this.apiSecret !== null;
  }

  /**
   * Check if live trading is currently allowed
   */
  canTrade(): { allowed: boolean; reason?: string } {
    if (!this.initialized) {
      return { allowed: false, reason: 'Client not initialized' };
    }
    if (this.safetyConfig.emergencyStop) {
      return { allowed: false, reason: 'Emergency stop is active' };
    }
    if (!this.safetyConfig.liveTradingEnabled) {
      return { allowed: false, reason: 'Live trading disabled in config' };
    }
    return { allowed: true };
  }

  /**
   * Generate signature for authenticated requests
   */
  private sign(queryString: string, timestamp: number): string {
    if (!this.apiSecret) throw new Error('API secret not initialized');

    const signPayload = `${this.apiKey}${timestamp}${queryString}`;
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(signPayload)
      .digest('hex');
  }

  /**
   * Make authenticated API request
   */
  private async authenticatedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API credentials not initialized');
    }

    const timestamp = Date.now();

    // Build query string
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      queryParams.append(key, String(value));
    }
    const queryString = queryParams.toString();

    // Generate signature
    const signature = this.sign(queryString, timestamp);

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'ApiKey': this.apiKey,
      'Request-Time': String(timestamp),
      'Signature': signature,
    };

    // Build URL
    const url = method === 'GET' && queryString
      ? `${MEXC_FUTURES_API}${endpoint}?${queryString}`
      : `${MEXC_FUTURES_API}${endpoint}`;

    const options: RequestInit = {
      method,
      headers,
    };

    if (method === 'POST' && queryString) {
      options.body = queryString;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok || (data && data.code && data.code !== 0)) {
      // NEVER log the actual error details that might contain sensitive info
      const safeError = data?.msg || `HTTP ${response.status}`;
      throw new Error(`MEXC API error: ${safeError}`);
    }

    return data as T;
  }

  /**
   * Get account information
   */
  async getAccountInfo(): Promise<AccountInfo> {
    if (!this.isReady()) {
      throw new Error('Client not initialized');
    }

    const response = await this.authenticatedRequest<{
      success: boolean;
      data: {
        availableBalance: number;
        equity: number;
        unrealised: number;
        positionMargin: number;
      };
    }>('GET', '/api/v1/private/account/asset/USDT');

    const positions = await this.getOpenPositions();

    return {
      availableBalance: response.data.availableBalance,
      totalBalance: response.data.equity,
      unrealizedPnl: response.data.unrealised,
      marginUsed: response.data.positionMargin,
      positions,
    };
  }

  /**
   * Get open positions
   */
  async getOpenPositions(): Promise<PositionInfo[]> {
    if (!this.isReady()) {
      throw new Error('Client not initialized');
    }

    const response = await this.authenticatedRequest<{
      success: boolean;
      data: Array<{
        symbol: string;
        positionType: number; // 1 = long, 2 = short
        holdVol: number;
        openAvgPrice: number;
        closeAvgPrice: number;
        im: number;
        unrealised: number;
        leverage: number;
        liquidatePrice: number;
      }>;
    }>('GET', '/api/v1/private/position/open_positions');

    if (!response.success || !Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .filter(p => p.holdVol > 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.positionType === 1 ? 'LONG' as const : 'SHORT' as const,
        quantity: p.holdVol,
        entryPrice: p.openAvgPrice,
        markPrice: p.closeAvgPrice,
        unrealizedPnl: p.unrealised,
        leverage: p.leverage,
        marginUsed: p.im,
        liquidationPrice: p.liquidatePrice,
      }));
  }

  /**
   * Validate order against safety limits
   */
  private validateOrder(order: FuturesOrder, currentPrice: number): { valid: boolean; reason?: string } {
    // Check emergency stop
    if (this.safetyConfig.emergencyStop) {
      return { valid: false, reason: 'Emergency stop active' };
    }

    // Check live trading enabled
    if (!this.safetyConfig.liveTradingEnabled) {
      return { valid: false, reason: 'Live trading disabled' };
    }

    // Check blacklist
    if (this.safetyConfig.blacklistedSymbols.has(order.symbol)) {
      return { valid: false, reason: `Symbol ${order.symbol} is blacklisted` };
    }

    // Check leverage
    if (order.leverage && order.leverage > this.safetyConfig.maxLeverage) {
      return { valid: false, reason: `Leverage ${order.leverage}x exceeds max ${this.safetyConfig.maxLeverage}x` };
    }

    // Check position size (rough estimate)
    const positionSizeUsdt = order.quantity * currentPrice;
    if (positionSizeUsdt > this.safetyConfig.maxPositionSizeUsdt) {
      return { valid: false, reason: `Position size $${positionSizeUsdt.toFixed(2)} exceeds max $${this.safetyConfig.maxPositionSizeUsdt}` };
    }

    return { valid: true };
  }

  /**
   * Set leverage for a symbol
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (!this.isReady()) {
      throw new Error('Client not initialized');
    }

    // Cap at max leverage
    const safeLeverage = Math.min(leverage, this.safetyConfig.maxLeverage);

    try {
      await this.authenticatedRequest('POST', '/api/v1/private/position/change_leverage', {
        symbol,
        leverage: safeLeverage,
      });
      return true;
    } catch (error) {
      console.error(`[MEXC-CLIENT] Failed to set leverage: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Place a market order
   * Returns order result (success/failure, never throws for trading errors)
   */
  async placeMarketOrder(
    symbol: string,
    side: 'long' | 'short',
    quantity: number,
    leverage: number,
    reduceOnly = false
  ): Promise<OrderResult> {
    // Safety checks
    const canTradeResult = this.canTrade();
    if (!canTradeResult.allowed) {
      return { success: false, error: canTradeResult.reason };
    }

    // Get current price for validation
    let currentPrice: number;
    try {
      const ticker = await this.authenticatedRequest<{
        success: boolean;
        data: { lastPrice: number };
      }>('GET', `/api/v1/contract/ticker?symbol=${symbol}`);
      currentPrice = ticker.data.lastPrice;
    } catch {
      return { success: false, error: 'Failed to get current price' };
    }

    // Map side to MEXC format
    // For opening: BUY = open long, SELL = open short
    // For closing (reduceOnly): BUY = close short, SELL = close long
    const orderSide: OrderSide = side === 'long' ? 'BUY' : 'SELL';

    const order: FuturesOrder = {
      symbol,
      side: reduceOnly ? (side === 'long' ? 'SELL' : 'BUY') : orderSide,
      type: 'MARKET',
      quantity,
      leverage,
      reduceOnly,
    };

    // Validate against safety limits
    const validation = this.validateOrder(order, currentPrice);
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    try {
      // Set leverage first
      if (!reduceOnly) {
        await this.setLeverage(symbol, leverage);
      }

      // Place the order
      // MEXC Futures order params:
      // openType: 1 = isolated, 2 = cross
      // type: 1 = limit, 2 = post-only, 3 = IOC, 4 = FOK, 5 = market
      // side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
      let mexcSide: number;
      if (reduceOnly) {
        mexcSide = side === 'long' ? 4 : 2; // close long = 4, close short = 2
      } else {
        mexcSide = side === 'long' ? 1 : 3; // open long = 1, open short = 3
      }

      const response = await this.authenticatedRequest<{
        success: boolean;
        data: string; // Order ID
      }>('POST', '/api/v1/private/order/submit', {
        symbol,
        side: mexcSide,
        type: 5, // Market order
        vol: quantity,
        openType: 1, // Isolated margin
        leverage,
      });

      if (response.success) {
        console.log(`[MEXC-CLIENT] Order placed: ${symbol} ${side.toUpperCase()} ${quantity} @ MARKET`);
        return {
          success: true,
          orderId: response.data,
          symbol,
          side: order.side,
          quantity,
          status: 'FILLED',
        };
      } else {
        return { success: false, error: 'Order rejected' };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Close a position
   */
  async closePosition(symbol: string, side: 'long' | 'short', quantity?: number): Promise<OrderResult> {
    const positions = await this.getOpenPositions();
    const position = positions.find(p =>
      p.symbol === symbol &&
      p.side === (side === 'long' ? 'LONG' : 'SHORT')
    );

    if (!position) {
      return { success: false, error: 'Position not found' };
    }

    const closeQuantity = quantity || position.quantity;
    return this.placeMarketOrder(symbol, side, closeQuantity, position.leverage, true);
  }

  /**
   * Emergency close all positions
   */
  async emergencyCloseAll(): Promise<{ closed: number; failed: number }> {
    console.warn('[MEXC-CLIENT] EMERGENCY CLOSE ALL POSITIONS');

    const positions = await this.getOpenPositions();
    let closed = 0;
    let failed = 0;

    for (const pos of positions) {
      try {
        const result = await this.closePosition(
          pos.symbol,
          pos.side === 'LONG' ? 'long' : 'short',
          pos.quantity
        );
        if (result.success) {
          closed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { closed, failed };
  }

  /**
   * Get safety configuration (for UI display)
   */
  getSafetyConfig(): SafetyConfig {
    return { ...this.safetyConfig };
  }

  /**
   * Update safety config at runtime
   */
  updateSafetyConfig(updates: Partial<SafetyConfig>): void {
    if (updates.emergencyStop !== undefined) {
      this.safetyConfig.emergencyStop = updates.emergencyStop;
      if (updates.emergencyStop) {
        console.warn('[MEXC-CLIENT] EMERGENCY STOP ACTIVATED');
      }
    }
    if (updates.liveTradingEnabled !== undefined) {
      this.safetyConfig.liveTradingEnabled = updates.liveTradingEnabled;
      console.log(`[MEXC-CLIENT] Live trading ${updates.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
    if (updates.maxPositionSizeUsdt !== undefined) {
      this.safetyConfig.maxPositionSizeUsdt = updates.maxPositionSizeUsdt;
    }
    if (updates.maxTotalExposureUsdt !== undefined) {
      this.safetyConfig.maxTotalExposureUsdt = updates.maxTotalExposureUsdt;
    }
    if (updates.maxLeverage !== undefined) {
      this.safetyConfig.maxLeverage = updates.maxLeverage;
    }
  }
}

// Singleton instance
let tradingClient: MexcTradingClient | null = null;

/**
 * Get the MEXC trading client instance
 */
export function getTradingClient(): MexcTradingClient {
  if (!tradingClient) {
    tradingClient = new MexcTradingClient();
  }
  return tradingClient;
}

/**
 * Initialize the trading client (call once at startup)
 */
export function initializeTradingClient(): boolean {
  const client = getTradingClient();
  return client.initialize();
}
