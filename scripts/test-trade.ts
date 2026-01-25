#!/usr/bin/env npx tsx
/**
 * Execute a test trade on MEXC
 */

import dotenv from 'dotenv';
import { createMexcClient, OrderSide, OrderType } from '../src/mexc-futures-client.js';

dotenv.config();

async function main() {
  const apiKey = process.env.MEXC_UID_COOKIE;
  if (!apiKey) {
    console.error('MEXC_UID_COOKIE not set');
    process.exit(1);
  }

  const client = createMexcClient(apiKey, false);

  console.log('='.repeat(60));
  console.log('MEXC Test Trade - DOGE_USDT LONG');
  console.log('='.repeat(60));
  console.log('');

  // First, set leverage to 2x for safety
  console.log('Setting leverage to 2x...');
  const leverageResult = await client.setSymbolLeverage('DOGE_USDT', 2, 'long', 'isolated');
  if (!leverageResult.success) {
    console.error('Failed to set leverage:', leverageResult.error);
    // Continue anyway, it might already be set
  } else {
    console.log('✓ Leverage set to 2x');
  }

  // Get current price
  const priceResult = await client.getTickerPrice('DOGE_USDT');
  console.log('Current DOGE price:', priceResult.price);

  // Place a market long order
  console.log('');
  console.log('Placing order...');
  console.log('  Symbol: DOGE_USDT');
  console.log('  Side: LONG (Open)');
  console.log('  Type: MARKET');
  console.log('  Volume: 1 contract (100 DOGE ≈ $' + ((priceResult.price || 0.124) * 100).toFixed(2) + ')');
  console.log('  Leverage: 2x');
  console.log('  Margin: ~$' + (((priceResult.price || 0.124) * 100) / 2).toFixed(2));
  console.log('');

  const orderResult = await client.createOrder({
    symbol: 'DOGE_USDT',
    side: OrderSide.OPEN_LONG,
    type: OrderType.MARKET,
    vol: 1,
    leverage: 2,
    openType: 1, // isolated
  });

  if (orderResult.success) {
    console.log('✅ ORDER PLACED SUCCESSFULLY!');
    console.log('Order data:', JSON.stringify(orderResult.data, null, 2));
  } else {
    console.error('❌ ORDER FAILED:', orderResult.error);
  }

  // Check positions
  console.log('');
  console.log('Checking positions...');
  const positionsResult = await client.getOpenPositions();
  if (positionsResult.success && positionsResult.data) {
    const dogePos = positionsResult.data.find(p => p.symbol === 'DOGE_USDT');
    if (dogePos) {
      console.log('✓ DOGE position found:');
      console.log('  Volume:', dogePos.holdVol);
      console.log('  Entry price:', dogePos.holdAvgPrice);
      console.log('  Leverage:', dogePos.leverage + 'x');
    } else {
      console.log('No DOGE position found (might take a moment to appear)');
    }
  }

  // Check balance after
  const balanceResult = await client.getUsdtBalance();
  console.log('');
  console.log('Balance after trade:', '$' + (balanceResult.balance || 0).toFixed(2));
}

main().catch(console.error);
