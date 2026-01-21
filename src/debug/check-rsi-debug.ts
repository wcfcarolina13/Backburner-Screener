import { getKlines } from './mexc-api.js';
import { calculateRSI, getCurrentRSI } from './indicators.js';

async function check() {
  // Get PONKE 15m klines
  const klines = await getKlines('PONKEUSDT', '15m', 100);
  console.log('PONKE 15m candles received:', klines.length);
  console.log('Kline sample:', JSON.stringify(klines[0], null, 2));

  console.log('\nLast 5 candles:');
  for (const k of klines.slice(-5)) {
    const time = new Date(k.timestamp).toISOString();
    console.log(`  ${time} O:${k.open} H:${k.high} L:${k.low} C:${k.close}`);
  }

  // calculateRSI expects Candle[] and returns RSIResult[]
  const rsiResults = calculateRSI(klines, 14);

  console.log('\nRSI (14) values (last 10):');
  for (let i = Math.max(0, rsiResults.length - 10); i < rsiResults.length; i++) {
    const r = rsiResults[i];
    const time = new Date(r.timestamp).toISOString();
    console.log(`  ${time}: RSI = ${r.value.toFixed(2)}`);
  }

  const currentRSI = getCurrentRSI(klines, 14);
  console.log(`\nCurrent RSI: ${currentRSI?.toFixed(2)}`);
  console.log(`Oversold (<30)? ${currentRSI && currentRSI < 30 ? 'YES' : 'NO'}`);
}

check().catch(console.error);
