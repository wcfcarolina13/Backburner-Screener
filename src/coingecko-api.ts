/**
 * Market Cap API Integration
 *
 * Fetches market cap data to filter out fake volume / low quality coins
 *
 * Primary: CoinGecko API (best data, but blocks cloud provider IPs)
 * Fallback: CoinLore API (no API key required, no IP blocking)
 */

// Rate limiting for CoinGecko free tier (10-30 calls/min)
// Being more conservative to avoid rate limits during startup
const RATE_LIMIT_DELAY_MS = 6000; // ~10 calls/min - CoinGecko free tier is strict
let lastCallTime = 0;

// Unified market data interface (works with both CoinGecko and CoinLore)
interface MarketData {
  id: string;
  symbol: string;
  name: string;
  market_cap: number;
  market_cap_rank: number | null;
  current_price: number;
  total_volume: number;
  circulating_supply: number | null;
}

// CoinLore API response format
interface CoinLoreResponse {
  data: CoinLoreCoin[];
  info: {
    coins_num: number;
    time: number;
  };
}

interface CoinLoreCoin {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  price_usd: string;
  market_cap_usd: string;
  volume24: number;
  csupply: string;
}

interface CoinInfo {
  id: string;
  symbol: string;
  name: string;
}

// Cache for coin list (symbol -> id mapping)
let coinListCache: Map<string, CoinInfo> | null = null;
let coinListCacheTime = 0;
const COIN_LIST_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cache for market data (works with both APIs)
const marketDataCache: Map<string, MarketData> = new Map();
let marketDataCacheTime = 0;
const MARKET_DATA_CACHE_MS = 30 * 60 * 1000; // 30 minutes - market cap doesn't change fast

// Track if CoinGecko is available (cloud providers may be blocked)
let coingeckoAvailable = true;
let coingeckoFailureCount = 0;
const MAX_COINGECKO_FAILURES = 3; // After 3 failures, assume blocked

// Track which API is being used
let usingCoinLore = false;

/**
 * Rate-limited fetch wrapper
 */
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;

  if (timeSinceLastCall < RATE_LIMIT_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS - timeSinceLastCall));
  }

  lastCallTime = Date.now();

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

/**
 * Fetch the coin list for symbol -> id mapping
 */
async function fetchCoinList(): Promise<Map<string, CoinInfo>> {
  const now = Date.now();

  // Return cached if valid
  if (coinListCache && now - coinListCacheTime < COIN_LIST_CACHE_MS) {
    return coinListCache;
  }

  const response = await rateLimitedFetch('https://api.coingecko.com/api/v3/coins/list');
  const coins: CoinInfo[] = await response.json();

  // Build symbol -> coin map (lowercase symbols)
  const map = new Map<string, CoinInfo>();
  for (const coin of coins) {
    const symbol = coin.symbol.toLowerCase();
    // If multiple coins have same symbol, prefer the one with shorter id (usually the main one)
    const existing = map.get(symbol);
    if (!existing || coin.id.length < existing.id.length) {
      map.set(symbol, coin);
    }
  }

  coinListCache = map;
  coinListCacheTime = now;

  return map;
}

/**
 * Fetch market data for top coins by market cap (CoinGecko)
 * Returns data for coins ranked by market cap
 */
async function fetchCoinGeckoMarketData(page = 1, perPage = 250): Promise<MarketData[]> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
  const response = await rateLimitedFetch(url);
  return response.json();
}

/**
 * Fetch market data from CoinLore API (fallback)
 * No API key required, no IP blocking
 * https://www.coinlore.com/cryptocurrency-data-api
 */
async function fetchCoinLoreMarketData(start = 0, limit = 100): Promise<MarketData[]> {
  const url = `https://api.coinlore.net/api/tickers/?start=${start}&limit=${limit}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`CoinLore API error: ${response.status} ${response.statusText}`);
  }

  const data: CoinLoreResponse = await response.json();

  // Convert CoinLore format to our unified MarketData format
  return data.data.map(coin => ({
    id: coin.id,
    symbol: coin.symbol.toLowerCase(),
    name: coin.name,
    market_cap: parseFloat(coin.market_cap_usd) || 0,
    market_cap_rank: coin.rank,
    current_price: parseFloat(coin.price_usd) || 0,
    total_volume: coin.volume24 || 0,
    circulating_supply: parseFloat(coin.csupply) || null,
  }));
}

/**
 * Try to fetch market data from CoinLore (fallback API)
 * Returns true if successful, false otherwise
 */
async function tryFetchFromCoinLore(onProgress?: (msg: string) => void): Promise<boolean> {
  onProgress?.('Trying CoinLore API (fallback)...');

  try {
    // CoinLore returns 100 coins per request, fetch top 1000
    for (let i = 0; i < 10; i++) {
      onProgress?.(`Fetching CoinLore data ${i + 1}/10...`);
      const data = await fetchCoinLoreMarketData(i * 100, 100);

      if (data.length === 0) break; // No more data

      for (const coin of data) {
        marketDataCache.set(coin.symbol.toLowerCase(), coin);
      }

      // Small delay between requests (CoinLore recommends 1 req/sec)
      if (i < 9) await new Promise(r => setTimeout(r, 1000));
    }

    if (marketDataCache.size > 0) {
      usingCoinLore = true;
      console.log(`[CoinLore] Successfully cached ${marketDataCache.size} coins`);
      onProgress?.(`CoinLore: Cached market data for ${marketDataCache.size} coins`);
      return true;
    }
  } catch (error) {
    console.error('[CoinLore] Failed:', (error as Error).message);
  }

  return false;
}

/**
 * Build a cache of market data for filtering
 * Fetches top coins by market cap with retry logic
 *
 * Strategy:
 * 1. Try CoinGecko first (best data)
 * 2. If CoinGecko fails (likely IP blocked), try CoinLore
 * 3. If both fail, fall back to volume-only filtering
 */
export async function buildMarketDataCache(onProgress?: (msg: string) => void): Promise<void> {
  const now = Date.now();

  // Return if cache is still valid
  if (marketDataCache.size > 0 && now - marketDataCacheTime < MARKET_DATA_CACHE_MS) {
    return;
  }

  // If we're already using CoinLore (CoinGecko was blocked), refresh from CoinLore
  if (usingCoinLore) {
    const success = await tryFetchFromCoinLore(onProgress);
    if (success) {
      marketDataCacheTime = now;
    }
    return;
  }

  // If CoinGecko is known to be blocked, try CoinLore instead
  if (!coingeckoAvailable) {
    onProgress?.('CoinGecko unavailable - trying CoinLore fallback...');
    const success = await tryFetchFromCoinLore(onProgress);
    if (success) {
      marketDataCacheTime = now;
    } else {
      onProgress?.('Both APIs failed - using volume filter only');
    }
    return;
  }

  onProgress?.('Fetching CoinGecko market data...');

  let pagesSucceeded = 0;
  let pagesFailed = 0;

  // Fetch top 1000 coins (4 pages of 250)
  for (let page = 1; page <= 4; page++) {
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        onProgress?.(`Fetching market data page ${page}/4...`);
        const data = await fetchCoinGeckoMarketData(page, 250);

        for (const coin of data) {
          marketDataCache.set(coin.symbol.toLowerCase(), coin);
        }
        success = true;
        pagesSucceeded++;
        // Reset failure count on success
        coingeckoFailureCount = 0;
      } catch (error) {
        retries--;
        if (retries > 0) {
          // Wait longer before retry (exponential backoff)
          const waitTime = (4 - retries) * 10000; // 10s, 20s, 30s
          onProgress?.(`Rate limited, waiting ${waitTime / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          // All retries failed, continue with partial data
          console.error(`Failed to fetch page ${page} after retries`);
          pagesFailed++;
          coingeckoFailureCount++;
        }
      }
    }
  }

  // If ALL pages failed, try CoinLore as fallback
  if (pagesSucceeded === 0 && pagesFailed === 4) {
    coingeckoFailureCount = MAX_COINGECKO_FAILURES;
    coingeckoAvailable = false;
    console.error('[CoinGecko] All requests failed - likely IP blocked (common for cloud providers)');
    onProgress?.('CoinGecko blocked - trying CoinLore fallback...');

    const coinLoreSuccess = await tryFetchFromCoinLore(onProgress);
    if (coinLoreSuccess) {
      marketDataCacheTime = now;
    } else {
      onProgress?.('Both APIs failed - using volume filter only');
    }
    return;
  }

  // If we've had too many consecutive failures across refreshes, mark as unavailable
  if (coingeckoFailureCount >= MAX_COINGECKO_FAILURES) {
    coingeckoAvailable = false;
    console.error('[CoinGecko] Too many failures - marking as unavailable');
  }

  marketDataCacheTime = now;
  onProgress?.(`Cached market data for ${marketDataCache.size} coins`);
}

/**
 * Check if market cap data is available (from any source)
 * Returns true if CoinGecko or CoinLore provided data
 */
export function isMarketCapDataAvailable(): boolean {
  return marketDataCache.size > 0;
}

/**
 * Check if CoinGecko API is available
 * (Will be false on cloud providers that are IP blocked)
 * @deprecated Use isMarketCapDataAvailable() instead
 */
export function isCoinGeckoAvailable(): boolean {
  return coingeckoAvailable || usingCoinLore;
}

/**
 * Get market data for a symbol
 */
export function getMarketData(symbol: string): MarketData | undefined {
  // Remove USDT suffix and convert to lowercase
  const baseSymbol = symbol.replace(/USDT$/i, '').toLowerCase();
  return marketDataCache.get(baseSymbol);
}

/**
 * Get coin name for a symbol
 */
export function getCoinName(symbol: string): string | undefined {
  const data = getMarketData(symbol);
  return data?.name;
}

/**
 * Get market cap for a symbol
 */
export function getMarketCap(symbol: string): number | undefined {
  const data = getMarketData(symbol);
  return data?.market_cap;
}

/**
 * Get market cap rank for a symbol
 */
export function getMarketCapRank(symbol: string): number | undefined {
  const data = getMarketData(symbol);
  return data?.market_cap_rank ?? undefined;
}

/**
 * Check if a symbol has valid market cap data
 */
export function hasMarketCapData(symbol: string): boolean {
  return getMarketData(symbol) !== undefined;
}

/**
 * Format market cap for display
 */
export function formatMarketCap(marketCap: number): string {
  if (marketCap >= 1_000_000_000) {
    return `$${(marketCap / 1_000_000_000).toFixed(1)}B`;
  } else if (marketCap >= 1_000_000) {
    return `$${(marketCap / 1_000_000).toFixed(1)}M`;
  } else if (marketCap >= 1_000) {
    return `$${(marketCap / 1_000).toFixed(1)}K`;
  }
  return `$${marketCap.toFixed(0)}`;
}
