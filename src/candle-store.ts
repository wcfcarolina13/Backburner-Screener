/**
 * Candle Store - Historical OHLCV data storage and retrieval
 *
 * Stores candles locally for backtesting, with on-demand fetching for gaps.
 * Storage format: /data/candles/{symbol}/{timeframe}.json
 */

import fs from 'fs';
import path from 'path';
import { Candle, Timeframe } from './types.js';
import { getKlines, getFuturesKlines } from './mexc-api.js';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface CandleFile {
  symbol: string;
  timeframe: string;
  marketType: 'spot' | 'futures';
  candles: Candle[];
  lastUpdated: number;
}

/**
 * Get the file path for a symbol/timeframe combination
 */
function getCandleFilePath(symbol: string, timeframe: string, marketType: 'spot' | 'futures'): string {
  const symbolDir = path.join(DATA_DIR, symbol);
  if (!fs.existsSync(symbolDir)) {
    fs.mkdirSync(symbolDir, { recursive: true });
  }
  return path.join(symbolDir, `${timeframe}-${marketType}.json`);
}

/**
 * Load candles from file
 */
function loadCandleFile(symbol: string, timeframe: string, marketType: 'spot' | 'futures'): CandleFile | null {
  const filePath = getCandleFilePath(symbol, timeframe, marketType);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as CandleFile;
  } catch (error) {
    console.error(`[CandleStore] Error loading ${filePath}:`, error);
    return null;
  }
}

/**
 * Save candles to file
 */
function saveCandleFile(file: CandleFile): void {
  const filePath = getCandleFilePath(file.symbol, file.timeframe, file.marketType);
  try {
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
  } catch (error) {
    console.error(`[CandleStore] Error saving ${filePath}:`, error);
  }
}

/**
 * Merge new candles into existing array, removing duplicates and sorting by timestamp
 */
function mergeCandles(existing: Candle[], newCandles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();

  // Add existing candles
  for (const c of existing) {
    map.set(c.timestamp, c);
  }

  // Add/update with new candles
  for (const c of newCandles) {
    map.set(c.timestamp, c);
  }

  // Sort by timestamp
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Store candles for a symbol/timeframe (called during live operation)
 */
export function storeCandles(
  symbol: string,
  timeframe: string,
  marketType: 'spot' | 'futures',
  candles: Candle[]
): void {
  if (candles.length === 0) return;

  const existing = loadCandleFile(symbol, timeframe, marketType);

  const merged = existing
    ? mergeCandles(existing.candles, candles)
    : candles.sort((a, b) => a.timestamp - b.timestamp);

  const file: CandleFile = {
    symbol,
    timeframe,
    marketType,
    candles: merged,
    lastUpdated: Date.now()
  };

  saveCandleFile(file);
}

/**
 * Get candles for a time range from local storage
 * Returns empty array if no data available
 * If futures requested but not found, falls back to spot data
 */
export function getStoredCandles(
  symbol: string,
  timeframe: string,
  marketType: 'spot' | 'futures',
  startTime?: number,
  endTime?: number
): Candle[] {
  // Try requested market type first
  let file = loadCandleFile(symbol, timeframe, marketType);

  // Fallback: if futures not found, try spot (many "futures" trades use spot-only symbols)
  if (!file && marketType === 'futures') {
    file = loadCandleFile(symbol, timeframe, 'spot');
  }

  if (!file) return [];

  let candles = file.candles;

  if (startTime !== undefined) {
    candles = candles.filter(c => c.timestamp >= startTime);
  }
  if (endTime !== undefined) {
    candles = candles.filter(c => c.timestamp <= endTime);
  }

  return candles;
}

/**
 * Get candles, fetching from API if needed
 * Falls back to spot if futures unavailable
 */
export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  marketType: 'spot' | 'futures',
  startTime: number,
  endTime: number
): Promise<Candle[]> {
  // First check local storage (already includes futures->spot fallback)
  const stored = getStoredCandles(symbol, timeframe, marketType, startTime, endTime);

  // Check if we have sufficient coverage
  const hasStart = stored.length > 0 && stored[0].timestamp <= startTime;
  const hasEnd = stored.length > 0 && stored[stored.length - 1].timestamp >= endTime;

  if (hasStart && hasEnd) {
    return stored;
  }

  // If we have some data but not enough, just return what we have (don't spam API)
  if (stored.length > 50) {
    return stored;
  }

  // Fetch from API - try futures first, then spot as fallback
  if (marketType === 'futures') {
    try {
      const fetched = await getFuturesKlines(symbol, timeframe, 500);
      if (fetched.length > 0) {
        storeCandles(symbol, timeframe, 'futures', fetched);
        return fetched.filter(c => c.timestamp >= startTime && c.timestamp <= endTime);
      }
    } catch (error) {
      // Futures failed, try spot
    }

    // Fallback to spot
    try {
      const fetched = await getKlines(symbol, timeframe, 500);
      if (fetched.length > 0) {
        storeCandles(symbol, timeframe, 'spot', fetched);
        return fetched.filter(c => c.timestamp >= startTime && c.timestamp <= endTime);
      }
    } catch (error) {
      return stored;
    }
  }

  // Spot market
  try {
    const fetched = await getKlines(symbol, timeframe, 500);
    storeCandles(symbol, timeframe, 'spot', fetched);
    return fetched.filter(c => c.timestamp >= startTime && c.timestamp <= endTime);
  } catch (error) {
    return stored;
  }
}

/**
 * Get all symbols we have candle data for
 */
export function getStoredSymbols(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter(f => {
    const stat = fs.statSync(path.join(DATA_DIR, f));
    return stat.isDirectory();
  });
}

/**
 * Get info about stored data for a symbol
 */
export function getSymbolInfo(symbol: string): { timeframe: string; marketType: string; count: number; start: number; end: number }[] {
  const symbolDir = path.join(DATA_DIR, symbol);
  if (!fs.existsSync(symbolDir)) return [];

  const files = fs.readdirSync(symbolDir).filter(f => f.endsWith('.json'));
  const info: { timeframe: string; marketType: string; count: number; start: number; end: number }[] = [];

  for (const file of files) {
    try {
      const match = file.match(/^(.+)-(spot|futures)\.json$/);
      if (!match) continue;

      const [, timeframe, marketType] = match;
      const data = JSON.parse(fs.readFileSync(path.join(symbolDir, file), 'utf-8')) as CandleFile;

      if (data.candles.length > 0) {
        info.push({
          timeframe,
          marketType,
          count: data.candles.length,
          start: data.candles[0].timestamp,
          end: data.candles[data.candles.length - 1].timestamp
        });
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return info;
}

/**
 * Timeframe to milliseconds
 */
export function timeframeToMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '1D': 24 * 60 * 60 * 1000  // Alternate format
  };
  return map[timeframe] || 5 * 60 * 1000; // Default to 5m
}

/**
 * Get candles for a specific entry time and duration after
 * Useful for backtesting - get candles from entry until exit
 */
export async function getCandlesFromEntry(
  symbol: string,
  timeframe: Timeframe,
  marketType: 'spot' | 'futures',
  entryTime: number,
  durationMs: number = 7 * 24 * 60 * 60 * 1000 // Default 7 days
): Promise<Candle[]> {
  const endTime = entryTime + durationMs;
  return getCandles(symbol, timeframe, marketType, entryTime, endTime);
}
