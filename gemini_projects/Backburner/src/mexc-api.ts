import { MEXC_API, MEXC_INTERVAL, CANDLES_TO_FETCH } from './config.js';
import type { Candle, Timeframe, SymbolInfo, MEXCTickerResponse, MarketType } from './types.js';

// MEXC Futures API base URL
const MEXC_FUTURES_API = 'https://contract.mexc.com';

// Rate limiter to avoid hitting MEXC limits
class RateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private maxConcurrent: number;
  private minDelayMs: number;
  private lastRequestTime = 0;

  constructor(maxConcurrent = 10, minDelayMs = 100) {
    this.maxConcurrent = maxConcurrent;
    this.minDelayMs = minDelayMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        // Ensure minimum delay between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minDelayMs) {
          await sleep(this.minDelayMs - timeSinceLastRequest);
        }

        this.running++;
        this.lastRequestTime = Date.now();

        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          this.processQueue();
        }
      };

      if (this.running < this.maxConcurrent) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  private processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// MEXC allows ~20 requests/sec for public endpoints
// Being slightly conservative to avoid edge cases
const rateLimiter = new RateLimiter(15, 30);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch with retry logic
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      if (response.status === 429) {
        // Rate limited - back off more aggressively
        await sleep(2000 * (i + 1));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error as Error;
      await sleep(500 * (i + 1));
    }
  }

  throw lastError || new Error('Failed after retries');
}

// Get all available trading symbols from MEXC
export async function getExchangeInfo(): Promise<SymbolInfo[]> {
  const url = `${MEXC_API.BASE_URL}${MEXC_API.EXCHANGE_INFO}`;
  const response = await fetchWithRetry(url);
  const data = await response.json();

  return data.symbols.map((s: Record<string, unknown>) => ({
    symbol: s.symbol as string,
    baseAsset: s.baseAsset as string,
    quoteAsset: s.quoteAsset as string,
    status: s.status as string,
    isSpotTradingAllowed: s.isSpotTradingAllowed as boolean,
    isMarginTradingAllowed: s.isMarginTradingAllowed as boolean,
  }));
}

// Get 24hr ticker data for volume filtering
export async function get24hTickers(): Promise<MEXCTickerResponse[]> {
  const url = `${MEXC_API.BASE_URL}${MEXC_API.TICKER_24H}`;
  const response = await fetchWithRetry(url);
  return response.json();
}

// Get kline/candlestick data for a symbol
export async function getKlines(
  symbol: string,
  timeframe: Timeframe,
  limit = CANDLES_TO_FETCH
): Promise<Candle[]> {
  return rateLimiter.execute(async () => {
    const interval = MEXC_INTERVAL[timeframe];
    const url = `${MEXC_API.BASE_URL}${MEXC_API.KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    const response = await fetchWithRetry(url);
    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error(`Invalid kline response for ${symbol}`);
    }

    return data.map((k: (number | string)[]) => ({
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  });
}

// Get current price for a symbol
export async function getCurrentPrice(symbol: string): Promise<number> {
  return rateLimiter.execute(async () => {
    const url = `${MEXC_API.BASE_URL}${MEXC_API.TICKER_PRICE}?symbol=${symbol}`;
    const response = await fetchWithRetry(url);
    const data = await response.json();
    return parseFloat(data.price);
  });
}

// Batch fetch klines for multiple symbols
export async function batchGetKlines(
  symbols: string[],
  timeframe: Timeframe,
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  let completed = 0;

  const promises = symbols.map(async (symbol) => {
    try {
      const candles = await getKlines(symbol, timeframe);
      results.set(symbol, candles);
    } catch (error) {
      // Skip symbols that fail
      console.error(`Failed to fetch ${symbol}: ${(error as Error).message}`);
    } finally {
      completed++;
      if (onProgress) {
        onProgress(completed, symbols.length);
      }
    }
  });

  await Promise.all(promises);
  return results;
}

// ============= FUTURES API =============

export interface FuturesSymbolInfo {
  symbol: string;          // e.g., "BTC_USDT"
  displayName: string;     // e.g., "BTC_USDT PERPETUAL"
  baseCoin: string;        // e.g., "BTC"
  quoteCoin: string;       // e.g., "USDT"
  maxLeverage: number;     // e.g., 500
  state: number;           // 0 = active
}

export interface FuturesTickerInfo {
  symbol: string;
  lastPrice: number;
  volume24: number;        // 24h volume in contracts
  amount24: number;        // 24h volume in quote currency (USDT)
}

// Get all futures contracts from MEXC
export async function getFuturesContracts(): Promise<FuturesSymbolInfo[]> {
  const url = `${MEXC_FUTURES_API}/api/v1/contract/detail`;
  const response = await fetchWithRetry(url);
  const data = await response.json();

  if (!data.success || !Array.isArray(data.data)) {
    throw new Error('Invalid futures contract response');
  }

  return data.data
    .filter((c: Record<string, unknown>) => c.state === 0) // Only active contracts
    .map((c: Record<string, unknown>) => ({
      symbol: c.symbol as string,
      displayName: c.displayNameEn as string,
      baseCoin: c.baseCoin as string,
      quoteCoin: c.quoteCoin as string,
      maxLeverage: c.maxLeverage as number,
      state: c.state as number,
    }));
}

// Get futures ticker data for volume info
export async function getFuturesTickers(): Promise<FuturesTickerInfo[]> {
  const url = `${MEXC_FUTURES_API}/api/v1/contract/ticker`;
  const response = await fetchWithRetry(url);
  const data = await response.json();

  if (!data.success || !Array.isArray(data.data)) {
    throw new Error('Invalid futures ticker response');
  }

  return data.data.map((t: Record<string, unknown>) => ({
    symbol: t.symbol as string,
    lastPrice: t.lastPrice as number,
    volume24: t.volume24 as number,
    amount24: t.amount24 as number,
  }));
}

// Futures kline interval mapping (different from spot)
const FUTURES_INTERVAL: Record<Timeframe, string> = {
  '1m': 'Min1',
  '5m': 'Min5',
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
};

// Get futures klines
export async function getFuturesKlines(
  symbol: string,
  timeframe: Timeframe,
  limit = CANDLES_TO_FETCH
): Promise<Candle[]> {
  return rateLimiter.execute(async () => {
    const interval = FUTURES_INTERVAL[timeframe];
    const url = `${MEXC_FUTURES_API}/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`;

    const response = await fetchWithRetry(url);
    const data = await response.json();

    if (!data.success || !Array.isArray(data.data?.time)) {
      throw new Error(`Invalid futures kline response for ${symbol}`);
    }

    const klineData = data.data;
    const candles: Candle[] = [];

    for (let i = 0; i < klineData.time.length; i++) {
      candles.push({
        timestamp: klineData.time[i] * 1000, // Convert to milliseconds
        open: klineData.open[i],
        high: klineData.high[i],
        low: klineData.low[i],
        close: klineData.close[i],
        volume: klineData.vol[i],
      });
    }

    return candles;
  });
}

// Convert futures symbol to spot-like format for consistency
// BTC_USDT -> BTCUSDT
export function futuresSymbolToSpot(futuresSymbol: string): string {
  return futuresSymbol.replace('_', '');
}

// Convert spot symbol to futures format
// BTCUSDT -> BTC_USDT
export function spotSymbolToFutures(spotSymbol: string): string {
  return spotSymbol.replace(/USDT$/, '_USDT');
}
