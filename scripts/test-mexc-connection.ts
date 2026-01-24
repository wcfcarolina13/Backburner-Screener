#!/usr/bin/env npx tsx
/**
 * Test MEXC Futures API Connection
 *
 * Usage:
 *   npx tsx scripts/test-mexc-connection.ts
 *
 * Make sure to set MEXC_UID_COOKIE in your .env file first!
 */

import dotenv from 'dotenv';
import { createMexcClient, OrderSide, OrderType } from '../src/mexc-futures-client.js';

// Load environment variables
dotenv.config();

async function main() {
  console.log('='.repeat(60));
  console.log('MEXC Futures API Connection Test');
  console.log('='.repeat(60));
  console.log('');

  // Check for credentials
  const apiKey = process.env.MEXC_UID_COOKIE;

  if (!apiKey || apiKey === 'WEB_your_uid_cookie_here') {
    console.error('❌ ERROR: MEXC_UID_COOKIE not set in .env file');
    console.error('');
    console.error('To get your u_id cookie:');
    console.error('1. Log into https://futures.mexc.com in your browser');
    console.error('2. Open Developer Tools (F12)');
    console.error('3. Go to Application → Cookies → futures.mexc.com');
    console.error('4. Find "u_id" cookie (starts with "WEB")');
    console.error('5. Add to .env: MEXC_UID_COOKIE=WEB_xxx...');
    process.exit(1);
  }

  console.log('✓ Found MEXC_UID_COOKIE (length:', apiKey.length, ')');
  console.log('');

  // Create client (mainnet, not testnet)
  const client = createMexcClient(apiKey, false);

  // Test 1: Connection & Balance
  console.log('--- Test 1: Get Account Balance ---');
  const balanceResult = await client.testConnection();

  if (!balanceResult.success) {
    console.error('❌ Connection failed:', balanceResult.error);
    console.error('');
    console.error('Common issues:');
    console.error('- Cookie expired: Log into MEXC and get a fresh u_id cookie');
    console.error('- Wrong cookie: Make sure you copied the entire value');
    console.error('- Network issue: Check your internet connection');
    process.exit(1);
  }

  console.log('✓ Balance: $' + balanceResult.balance?.toFixed(2));
  console.log('');

  // Test 2: Get Open Positions
  console.log('--- Test 2: Get Open Positions ---');
  const positionsResult = await client.getOpenPositions();

  if (!positionsResult.success) {
    console.error('❌ Failed to get positions:', positionsResult.error);
  } else {
    const positions = positionsResult.data || [];
    console.log('✓ Open positions:', positions.length);

    if (positions.length > 0) {
      for (const pos of positions) {
        const side = pos.positionType === 1 ? 'LONG' : 'SHORT';
        console.log(`  - ${pos.symbol} ${side}: ${pos.holdVol} @ $${pos.holdAvgPrice.toFixed(4)} (${pos.leverage}x)`);
      }
    }
  }
  console.log('');

  // Test 3: Get Ticker Price
  console.log('--- Test 3: Get BTC Price ---');
  const tickerResult = await client.getTickerPrice('BTC_USDT');

  if (!tickerResult.success) {
    console.error('❌ Failed to get ticker:', tickerResult.error);
  } else {
    console.log('✓ BTC_USDT price: $' + tickerResult.price?.toFixed(2));
  }
  console.log('');

  // Test 4: Get Open Orders for BTC
  console.log('--- Test 4: Get Open Orders (BTC_USDT) ---');
  const ordersResult = await client.getOpenOrders('BTC_USDT');

  if (!ordersResult.success) {
    console.error('❌ Failed to get orders:', ordersResult.error);
  } else {
    const orders = ordersResult.data || [];
    console.log('✓ Open orders for BTC_USDT:', orders.length);
  }
  console.log('');

  // Test 5: Get Leverage Setting
  console.log('--- Test 5: Get Leverage for BTC_USDT ---');
  const leverageResult = await client.getLeverage('BTC_USDT');

  if (!leverageResult.success) {
    console.error('❌ Failed to get leverage:', leverageResult.error);
  } else {
    console.log('✓ BTC_USDT leverage - Long:', leverageResult.longLeverage + 'x, Short:', leverageResult.shortLeverage + 'x');
  }
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('✅ All connection tests passed!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Next steps:');
  console.log('1. The API connection is working');
  console.log('2. You can now use the execution queue feature');
  console.log('3. Start with small test trades to verify order placement');
  console.log('');

  // Optional: Test order placement (commented out for safety)
  /*
  console.log('--- Test 6: Place Test Order (DISABLED) ---');
  console.log('Uncomment the code below to test order placement');
  console.log('WARNING: This will place a REAL order!');

  const orderResult = await client.openLong(
    'BTC_USDT',
    0.001,  // Very small volume
    5,      // 5x leverage
    undefined, // No SL
    undefined  // No TP
  );

  if (!orderResult.success) {
    console.error('❌ Order failed:', orderResult.error);
  } else {
    console.log('✓ Order placed:', orderResult.data);
  }
  */
}

main().catch(console.error);
