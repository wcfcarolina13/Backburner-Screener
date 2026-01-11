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

// =============================================================================
// TRAILING STOP MANAGEMENT
// =============================================================================

/**
 * Trailing Stop Modes:
 *
 * Mode 1: NATIVE - Use MEXC's native trailing stop (activation + callback rate)
 *         Pros: Simple, handled by exchange, no API polling needed
 *         Cons: Different behavior than our discrete levels, limited customization
 *
 * Mode 2: MANUAL - Manually manage stop-loss orders via API
 *         Pros: Exact replication of our discrete level logic
 *         Cons: Requires polling, more API calls, potential latency issues
 *
 * Mode 3: HYBRID - Use our logic for decisions, MEXC native for execution
 *         Pros: Best of both - our strategy logic with exchange execution
 *         Cons: More complex, requires Mode 1 to be working
 */
export type TrailingStopMode = 'native' | 'manual' | 'hybrid';

export interface TrailingStopConfig {
  mode: TrailingStopMode;

  // Mode 1 (Native MEXC) parameters
  native?: {
    activationPercent: number;  // ROI% to activate trailing (e.g., 10 = 10% ROI)
    callbackPercent: number;    // Callback rate (e.g., 1 = 1% retracement)
    priceType: 'last' | 'fair' | 'index';  // Price source for trigger
  };

  // Mode 2 (Manual) parameters
  manual?: {
    levels: Array<{
      triggerRoiPercent: number;  // ROI% to advance to this level
      stopRoiPercent: number;     // Stop ROI% at this level
    }>;
    pollIntervalMs: number;       // How often to check prices
  };

  // Mode 3 (Hybrid) uses both - our logic decides, native executes
  hybrid?: {
    useNativeExecution: boolean;  // Use MEXC native trailing once activated
    fallbackToManual: boolean;    // Fall back to manual if native fails
  };

  // Initial stop loss (used by all modes)
  initialStopRoiPercent: number;  // Initial stop before any trailing (e.g., -20)
}

export interface StopOrderInfo {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  stopPrice: number;
  quantity: number;
  status: 'active' | 'triggered' | 'cancelled';
  type: 'stop_loss' | 'trailing_stop';
  createdAt: number;
}

export interface TrailingStopState {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  leverage: number;

  // Trailing state
  isActivated: boolean;
  currentLevel: number;       // For manual mode - discrete level
  peakPrice: number;          // Highest price since entry (longs)
  troughPrice: number;        // Lowest price since entry (shorts)
  currentStopPrice: number;
  stopOrderId?: string;       // Active stop order on exchange

  // Configuration used
  mode: TrailingStopMode;
  config: TrailingStopConfig;
}

/**
 * Trailing Stop Manager - handles all three modes
 */
export class TrailingStopManager {
  private client: MexcTradingClient;
  private activeStops: Map<string, TrailingStopState> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private defaultConfig: TrailingStopConfig;

  constructor(client: MexcTradingClient, defaultConfig?: TrailingStopConfig) {
    this.client = client;
    this.defaultConfig = defaultConfig || {
      mode: 'manual',
      manual: {
        levels: [
          { triggerRoiPercent: 10, stopRoiPercent: 0 },    // Level 1: at 10% ROI, stop at breakeven
          { triggerRoiPercent: 20, stopRoiPercent: 10 },   // Level 2: at 20% ROI, stop at 10%
          { triggerRoiPercent: 30, stopRoiPercent: 20 },   // Level 3: at 30% ROI, stop at 20%
          { triggerRoiPercent: 40, stopRoiPercent: 30 },   // Level 4: at 40% ROI, stop at 30%
          { triggerRoiPercent: 50, stopRoiPercent: 40 },   // Level 5: at 50% ROI, stop at 40%
        ],
        pollIntervalMs: 5000,
      },
      initialStopRoiPercent: -20,
    };
  }

  /**
   * Create a trailing stop for a position
   */
  async createTrailingStop(
    positionId: string,
    symbol: string,
    side: 'long' | 'short',
    entryPrice: number,
    quantity: number,
    leverage: number,
    config?: Partial<TrailingStopConfig>
  ): Promise<TrailingStopState> {
    const finalConfig = { ...this.defaultConfig, ...config };
    const mode = finalConfig.mode;

    // Calculate initial stop price
    const initialStopPrice = this.calculateStopPrice(
      entryPrice,
      side,
      finalConfig.initialStopRoiPercent,
      leverage
    );

    const state: TrailingStopState = {
      positionId,
      symbol,
      side,
      entryPrice,
      currentPrice: entryPrice,
      quantity,
      leverage,
      isActivated: false,
      currentLevel: 0,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      currentStopPrice: initialStopPrice,
      mode,
      config: finalConfig,
    };

    // Create the initial stop order on exchange
    if (this.client.isReady() && this.client.canTrade().allowed) {
      const stopOrderId = await this.placeStopOrder(symbol, side, initialStopPrice, quantity);
      if (stopOrderId) {
        state.stopOrderId = stopOrderId;
      }
    }

    this.activeStops.set(positionId, state);

    console.log(`[TRAILING-MGR] Created ${mode} trailing stop for ${symbol} ${side.toUpperCase()}`);
    console.log(`  Entry: ${entryPrice.toPrecision(5)} | Initial Stop: ${initialStopPrice.toPrecision(5)}`);

    // Start polling if using manual mode and not already polling
    if (mode === 'manual' && !this.pollInterval) {
      this.startPolling(finalConfig.manual?.pollIntervalMs || 5000);
    }

    return state;
  }

  /**
   * Update trailing stop with new price
   */
  async updatePrice(positionId: string, currentPrice: number): Promise<void> {
    const state = this.activeStops.get(positionId);
    if (!state) return;

    state.currentPrice = currentPrice;

    // Update peak/trough
    if (state.side === 'long' && currentPrice > state.peakPrice) {
      state.peakPrice = currentPrice;
    } else if (state.side === 'short' && currentPrice < state.troughPrice) {
      state.troughPrice = currentPrice;
    }

    // Calculate current ROI
    const roi = this.calculateRoi(state.entryPrice, currentPrice, state.side, state.leverage);

    // Handle based on mode
    switch (state.mode) {
      case 'native':
        await this.handleNativeMode(state, roi);
        break;
      case 'manual':
        await this.handleManualMode(state, roi);
        break;
      case 'hybrid':
        await this.handleHybridMode(state, roi);
        break;
    }
  }

  /**
   * Handle native MEXC trailing stop mode
   */
  private async handleNativeMode(state: TrailingStopState, roi: number): Promise<void> {
    const nativeConfig = state.config.native;
    if (!nativeConfig) return;

    // Check if we should activate the trailing stop
    if (!state.isActivated && roi >= nativeConfig.activationPercent) {
      state.isActivated = true;
      console.log(`[TRAILING-MGR] Native trailing activated for ${state.symbol} at ${roi.toFixed(1)}% ROI`);

      // Cancel existing stop and place native trailing stop
      if (state.stopOrderId) {
        await this.cancelStopOrder(state.symbol, state.stopOrderId);
      }

      // Place native trailing stop order
      // NOTE: This is scaffolding - actual MEXC trailing stop API call would go here
      // when the API documentation becomes available
      const trailingOrderId = await this.placeNativeTrailingStop(
        state.symbol,
        state.side,
        state.quantity,
        nativeConfig.callbackPercent,
        nativeConfig.priceType
      );

      if (trailingOrderId) {
        state.stopOrderId = trailingOrderId;
      }
    }
  }

  /**
   * Handle manual trailing stop mode (replicates our discrete levels)
   */
  private async handleManualMode(state: TrailingStopState, roi: number): Promise<void> {
    const manualConfig = state.config.manual;
    if (!manualConfig) return;

    // Check if we've hit a new level
    const levels = manualConfig.levels;
    let newLevel = state.currentLevel;
    let newStopRoi = state.config.initialStopRoiPercent;

    for (let i = 0; i < levels.length; i++) {
      if (roi >= levels[i].triggerRoiPercent) {
        newLevel = i + 1;
        newStopRoi = levels[i].stopRoiPercent;
      }
    }

    // If level advanced, update stop
    if (newLevel > state.currentLevel) {
      state.currentLevel = newLevel;
      const newStopPrice = this.calculateStopPrice(
        state.entryPrice,
        state.side,
        newStopRoi,
        state.leverage
      );

      // Only update if new stop is better (higher for longs, lower for shorts)
      const shouldUpdate = state.side === 'long'
        ? newStopPrice > state.currentStopPrice
        : newStopPrice < state.currentStopPrice;

      if (shouldUpdate) {
        console.log(`[TRAILING-MGR] Level ${newLevel} reached for ${state.symbol} | ROI: ${roi.toFixed(1)}% | New stop: ${newStopPrice.toPrecision(5)}`);

        // Update stop order on exchange
        if (state.stopOrderId) {
          await this.modifyStopOrder(state.symbol, state.stopOrderId, newStopPrice);
        } else {
          const newOrderId = await this.placeStopOrder(state.symbol, state.side, newStopPrice, state.quantity);
          if (newOrderId) {
            state.stopOrderId = newOrderId;
          }
        }

        state.currentStopPrice = newStopPrice;
        state.isActivated = true;
      }
    }
  }

  /**
   * Handle hybrid mode - our logic, MEXC execution
   */
  private async handleHybridMode(state: TrailingStopState, roi: number): Promise<void> {
    const hybridConfig = state.config.hybrid;
    const nativeConfig = state.config.native;

    if (!hybridConfig || !nativeConfig) return;

    // Use our discrete level logic to decide when to activate
    if (!state.isActivated && roi >= nativeConfig.activationPercent) {
      state.isActivated = true;

      if (hybridConfig.useNativeExecution) {
        // Switch to native trailing for execution
        console.log(`[TRAILING-MGR] Hybrid mode: activating native trailing for ${state.symbol}`);

        if (state.stopOrderId) {
          await this.cancelStopOrder(state.symbol, state.stopOrderId);
        }

        const trailingOrderId = await this.placeNativeTrailingStop(
          state.symbol,
          state.side,
          state.quantity,
          nativeConfig.callbackPercent,
          nativeConfig.priceType
        );

        if (trailingOrderId) {
          state.stopOrderId = trailingOrderId;
        } else if (hybridConfig.fallbackToManual) {
          // Fall back to manual mode
          console.log(`[TRAILING-MGR] Native trailing failed, falling back to manual`);
          state.mode = 'manual';
          await this.handleManualMode(state, roi);
        }
      }
    }
  }

  /**
   * Calculate stop price from ROI percentage
   */
  private calculateStopPrice(
    entryPrice: number,
    side: 'long' | 'short',
    roiPercent: number,
    leverage: number
  ): number {
    // ROI% = (price change %) * leverage
    // price change % = ROI% / leverage
    const priceChangePercent = roiPercent / leverage / 100;

    if (side === 'long') {
      return entryPrice * (1 + priceChangePercent);
    } else {
      return entryPrice * (1 - priceChangePercent);
    }
  }

  /**
   * Calculate ROI from prices
   */
  private calculateRoi(
    entryPrice: number,
    currentPrice: number,
    side: 'long' | 'short',
    leverage: number
  ): number {
    const priceChange = side === 'long'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;

    return priceChange * leverage * 100;
  }

  /**
   * Place a stop-loss order on MEXC
   * Returns order ID or null if failed
   */
  private async placeStopOrder(
    symbol: string,
    side: 'long' | 'short',
    stopPrice: number,
    quantity: number
  ): Promise<string | null> {
    if (!this.client.isReady() || !this.client.canTrade().allowed) {
      console.log(`[TRAILING-MGR] Cannot place stop order - client not ready or trading disabled`);
      return null;
    }

    try {
      // MEXC stop order endpoint: POST /api/v1/private/stoporder/create
      // This is scaffolding - actual implementation depends on MEXC API response format
      console.log(`[TRAILING-MGR] Would place stop order: ${symbol} ${side} @ ${stopPrice.toPrecision(5)}`);

      // TODO: Implement actual API call when ready
      // const response = await this.client.authenticatedRequest('POST', '/api/v1/private/stoporder/create', {
      //   symbol,
      //   stopLossPrice: stopPrice,
      //   vol: quantity,
      //   side: side === 'long' ? 4 : 2,  // close long = 4, close short = 2
      // });
      // return response.data.stopOrderId;

      return `mock-stop-${Date.now()}`;  // Mock for now
    } catch (error) {
      console.error(`[TRAILING-MGR] Failed to place stop order: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Modify an existing stop order price
   */
  private async modifyStopOrder(
    symbol: string,
    orderId: string,
    newStopPrice: number
  ): Promise<boolean> {
    if (!this.client.isReady() || !this.client.canTrade().allowed) {
      return false;
    }

    try {
      // MEXC endpoint: POST /api/v1/private/stoporder/change_price
      console.log(`[TRAILING-MGR] Would modify stop order ${orderId} to ${newStopPrice.toPrecision(5)}`);

      // TODO: Implement actual API call
      // await this.client.authenticatedRequest('POST', '/api/v1/private/stoporder/change_price', {
      //   orderId,
      //   stopLossPrice: newStopPrice,
      // });

      return true;
    } catch (error) {
      console.error(`[TRAILING-MGR] Failed to modify stop order: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Cancel a stop order
   */
  private async cancelStopOrder(symbol: string, orderId: string): Promise<boolean> {
    if (!this.client.isReady()) {
      return false;
    }

    try {
      // MEXC endpoint: POST /api/v1/private/stoporder/cancel
      console.log(`[TRAILING-MGR] Would cancel stop order ${orderId}`);

      // TODO: Implement actual API call
      // await this.client.authenticatedRequest('POST', '/api/v1/private/stoporder/cancel', {
      //   stopPlanOrderId: orderId,
      // });

      return true;
    } catch (error) {
      console.error(`[TRAILING-MGR] Failed to cancel stop order: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Place a native MEXC trailing stop order
   * NOTE: This is scaffolding - actual API parameters TBD based on MEXC documentation
   */
  private async placeNativeTrailingStop(
    symbol: string,
    side: 'long' | 'short',
    quantity: number,
    callbackPercent: number,
    priceType: 'last' | 'fair' | 'index'
  ): Promise<string | null> {
    if (!this.client.isReady() || !this.client.canTrade().allowed) {
      return null;
    }

    try {
      // MEXC trailing stop endpoint - exact parameters TBD
      // Expected parameters based on UI research:
      // - symbol
      // - side (close direction)
      // - vol (quantity)
      // - callbackRate or variance (trailing distance)
      // - activationPrice (optional)
      // - priceType (1=last, 2=fair, 3=index)

      console.log(`[TRAILING-MGR] Would place native trailing stop: ${symbol} ${side} | ${callbackPercent}% callback`);

      // TODO: Implement when API documentation available
      // const priceTypeMap = { last: 1, fair: 2, index: 3 };
      // const response = await this.client.authenticatedRequest('POST', '/api/v1/private/trackorder/submit', {
      //   symbol,
      //   side: side === 'long' ? 4 : 2,
      //   vol: quantity,
      //   callbackRate: callbackPercent,
      //   priceType: priceTypeMap[priceType],
      // });
      // return response.data.trackOrderId;

      return `mock-trailing-${Date.now()}`;  // Mock for now
    } catch (error) {
      console.error(`[TRAILING-MGR] Failed to place native trailing stop: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Start polling for price updates (manual mode)
   */
  private startPolling(intervalMs: number): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      for (const [positionId, state] of this.activeStops) {
        if (state.mode !== 'manual') continue;

        try {
          // Fetch current price
          // In real implementation, would batch these or use websocket
          // For now this is scaffolding
          // const ticker = await this.client.getTicker(state.symbol);
          // await this.updatePrice(positionId, ticker.lastPrice);
        } catch (error) {
          // Ignore price fetch errors in polling
        }
      }
    }, intervalMs);

    console.log(`[TRAILING-MGR] Started polling every ${intervalMs}ms`);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log(`[TRAILING-MGR] Stopped polling`);
    }
  }

  /**
   * Remove a trailing stop (position closed)
   */
  async removeTrailingStop(positionId: string): Promise<void> {
    const state = this.activeStops.get(positionId);
    if (!state) return;

    // Cancel any active stop order
    if (state.stopOrderId) {
      await this.cancelStopOrder(state.symbol, state.stopOrderId);
    }

    this.activeStops.delete(positionId);
    console.log(`[TRAILING-MGR] Removed trailing stop for position ${positionId}`);

    // Stop polling if no more active stops in manual mode
    const hasManualStops = Array.from(this.activeStops.values()).some(s => s.mode === 'manual');
    if (!hasManualStops && this.pollInterval) {
      this.stopPolling();
    }
  }

  /**
   * Get all active trailing stop states
   */
  getActiveStops(): TrailingStopState[] {
    return Array.from(this.activeStops.values());
  }

  /**
   * Get state for a specific position
   */
  getStopState(positionId: string): TrailingStopState | undefined {
    return this.activeStops.get(positionId);
  }
}

// Singleton trailing stop manager
let trailingStopManager: TrailingStopManager | null = null;

/**
 * Get the trailing stop manager instance
 */
export function getTrailingStopManager(): TrailingStopManager {
  if (!trailingStopManager) {
    const client = getTradingClient();
    trailingStopManager = new TrailingStopManager(client);
  }
  return trailingStopManager;
}
