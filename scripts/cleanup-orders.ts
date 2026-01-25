#!/usr/bin/env npx tsx
/**
 * Cleanup orphaned plan orders on MEXC
 */

import dotenv from 'dotenv';
import { createMexcClient } from '../src/mexc-futures-client.js';

dotenv.config();

async function main() {
  const apiKey = process.env.MEXC_UID_COOKIE;
  if (!apiKey) {
    console.error('MEXC_UID_COOKIE not set');
    process.exit(1);
  }

  const client = createMexcClient(apiKey, false);

  console.log('='.repeat(60));
  console.log('MEXC Cleanup - Cancel All Plan Orders');
  console.log('='.repeat(60));
  console.log('');

  // First test connection
  const connResult = await client.testConnection();
  if (!connResult.success) {
    console.error('Connection failed:', connResult.error);
    process.exit(1);
  }
  console.log('Balance: $' + connResult.balance?.toFixed(2));
  console.log('');

  // Get symbols to check - common ones and any with open positions
  const symbols = ['DOGE_USDT', 'BTC_USDT', 'ETH_USDT'];

  // Also add symbols from open positions
  const posResult = await client.getOpenPositions();
  if (posResult.success && posResult.data) {
    for (const pos of posResult.data) {
      if (!symbols.includes(pos.symbol)) {
        symbols.push(pos.symbol);
      }
    }
  }

  console.log('Checking symbols:', symbols.join(', '));
  console.log('');

  let totalCancelled = 0;

  for (const symbol of symbols) {
    console.log(`--- ${symbol} ---`);

    // Try to cancel all plan orders for this symbol
    const cancelResult = await client.cancelAllPlanOrders(symbol);

    if (cancelResult.success) {
      console.log('✓ All plan orders cancelled');
      totalCancelled++;
    } else if (cancelResult.error?.includes('Not Found') || cancelResult.error?.includes('No orders')) {
      console.log('No orders to cancel');
    } else {
      console.log('Result:', cancelResult.error || 'OK');
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Cleanup complete');
  console.log('='.repeat(60));
}

main().catch(console.error);
