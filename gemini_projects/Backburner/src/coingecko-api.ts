/**
 * CoinGecko API Integration
 *
 * Fetches market cap data to filter out fake volume / low quality coins
 */

// Rate limiting for CoinGecko free tier (10-30 calls/min)
// Being more conservative to avoid rate limits during startup
const RATE_LIMIT_DELAY_MS = 6000; // ~10 calls/min - CoinGecko free tier is strict
let lastCallTime = 0;

interface CoinGeckoMarketData {
  id: string;
  symbol: string;
  name: string;
  market_cap: number;
  market_cap_rank: number | null;
  current_price: number;
  total_volume: number;
  circulating_supply: number | null;
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

// Cache for market data
const marketDataCache: Map<string, CoinGeckoMarketData> = new Map();
let marketDataCacheTime = 0;
const MARKET_DATA_CACHE_MS = 30 * 60 * 1000; // 30 minutes - market cap doesn't change fast

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
 * Fetch market data for top coins by market cap
 * Returns data for coins ranked by market cap
 */
async function fetchMarketData(page = 1, perPage = 250): Promise<CoinGeckoMarketData[]> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
  const response = await rateLimitedFetch(url);
  return response.json();
}

/**
 * Build a cache of market data for filtering
 * Fetches top coins by market cap with retry logic
 */
export async function buildMarketDataCache(onProgress?: (msg: string) => void): Promise<void> {
  const now = Date.now();

  // Return if cache is still valid
  if (marketDataCache.size > 0 && now - marketDataCacheTime < MARKET_DATA_CACHE_MS) {
    return;
  }

  onProgress?.('Fetching CoinGecko market data...');

  // Fetch top 1000 coins (4 pages of 250)
  for (let page = 1; page <= 4; page++) {
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        onProgress?.(`Fetching market data page ${page}/4...`);
        const data = await fetchMarketData(page, 250);

        for (const coin of data) {
          marketDataCache.set(coin.symbol.toLowerCase(), coin);
        }
        success = true;
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
        }
      }
    }
  }

  marketDataCacheTime = now;
  onProgress?.(`Cached market data for ${marketDataCache.size} coins`);
}

/**
 * Get market data for a symbol
 */
export function getMarketData(symbol: string): CoinGeckoMarketData | undefined {
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
