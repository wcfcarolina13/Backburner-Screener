#!/usr/bin/env npx tsx
/**
 * Test Stop-Loss, Take-Profit, and Position Close on MEXC
 *
 * Tests:
 * 1. Get current DOGE position
 * 2. Set a stop-loss
 * 3. Set a take-profit
 * 4. Adjust the stop-loss
 * 5. Close the position
 */

import dotenv from 'dotenv';
import { createMexcClient, OrderSide } from '../src/mexc-futures-client.js';

dotenv.config();

async function main() {
  const apiKey = process.env.MEXC_UID_COOKIE;
  if (!apiKey) {
    console.error('MEXC_UID_COOKIE not set');
    process.exit(1);
  }

  const client = createMexcClient(apiKey, false);

  console.log('='.repeat(60));
  console.log('MEXC SL/TP & Close Test - DOGE_USDT');
  console.log('='.repeat(60));
  console.log('');

  // Step 1: Get position info
  console.log('--- Step 1: Get DOGE Position ---');
  const posResult = await client.getPosition('DOGE_USDT');

  if (!posResult.success || !posResult.data) {
    console.error('❌ No DOGE position found:', posResult.error);
    console.log('You need an open DOGE_USDT position to run this test.');
    process.exit(1);
  }

  const position = posResult.data;
  console.log('✓ Position found:');
  console.log('  ID:', position.positionId);
  console.log('  Type:', position.positionType === 1 ? 'LONG' : 'SHORT');
  console.log('  Volume:', position.holdVol);
  console.log('  Entry Price:', position.holdAvgPrice);
  console.log('  Leverage:', position.leverage + 'x');
  console.log('  Liquidation Price:', position.liquidatePrice);
  console.log('');

  // Get current price
  const priceResult = await client.getTickerPrice('DOGE_USDT');
  const currentPrice = priceResult.price || position.holdAvgPrice;
  console.log('Current DOGE price:', currentPrice.toFixed(5));
  console.log('');

  // Calculate SL/TP prices (for a LONG position)
  // Stop-loss: 2% below entry
  // Take-profit: 5% above entry
  const isLong = position.positionType === 1;
  const entryPrice = position.holdAvgPrice;

  let stopLossPrice: number;
  let takeProfitPrice: number;

  if (isLong) {
    stopLossPrice = entryPrice * 0.98; // 2% below entry
    takeProfitPrice = entryPrice * 1.05; // 5% above entry
  } else {
    stopLossPrice = entryPrice * 1.02; // 2% above entry for shorts
    takeProfitPrice = entryPrice * 0.95; // 5% below entry for shorts
  }

  // Step 2: Set Stop-Loss
  console.log('--- Step 2: Set Stop-Loss ---');
  console.log('Stop-loss price:', stopLossPrice.toFixed(5));

  const slResult = await client.setStopLoss('DOGE_USDT', stopLossPrice);

  if (slResult.success) {
    console.log('✅ Stop-loss set successfully!');
    console.log('Data:', JSON.stringify(slResult.data, null, 2));
  } else {
    console.error('❌ Failed to set stop-loss:', slResult.error);
    console.log('Trying alternative approach...');

    // Try direct stop order creation
    const directResult = await client.createStopOrder({
      symbol: 'DOGE_USDT',
      positionId: position.positionId,
      triggerPrice: stopLossPrice,
      vol: position.holdVol,
      side: isLong ? OrderSide.CLOSE_LONG : OrderSide.CLOSE_SHORT,
      isStopLoss: true,
    });

    if (directResult.success) {
      console.log('✅ Stop-loss set via direct method!');
      console.log('Data:', JSON.stringify(directResult.data, null, 2));
    } else {
      console.error('❌ Direct method also failed:', directResult.error);
    }
  }
  console.log('');

  // Step 3: Set Take-Profit
  console.log('--- Step 3: Set Take-Profit ---');
  console.log('Take-profit price:', takeProfitPrice.toFixed(5));

  const tpResult = await client.setTakeProfit('DOGE_USDT', takeProfitPrice);

  if (tpResult.success) {
    console.log('✅ Take-profit set successfully!');
    console.log('Data:', JSON.stringify(tpResult.data, null, 2));
  } else {
    console.error('❌ Failed to set take-profit:', tpResult.error);
  }
  console.log('');

  // Step 4: Check plan orders
  console.log('--- Step 4: Check Plan Orders ---');
  const planOrdersResult = await client.getPlanOrders('DOGE_USDT');
  if (planOrdersResult.success) {
    console.log('✓ Plan orders:', planOrdersResult.data?.length || 0);
    if (planOrdersResult.data && planOrdersResult.data.length > 0) {
      for (const order of planOrdersResult.data) {
        console.log('  - Order ID:', order.id);
        console.log('    Trigger:', order.triggerPrice);
        console.log('    TriggerType:', order.triggerType === 1 ? '>=' : '<=');
        console.log('    Vol:', order.vol);
      }
    }
  } else {
    console.error('Failed to get plan orders:', planOrdersResult.error);
  }
  console.log('');

  // Step 5: Adjust stop-loss (cancel old, create new at tighter price)
  console.log('--- Step 5: Adjust Stop-Loss (tighten to 1%) ---');
  const tighterSL = isLong ? entryPrice * 0.99 : entryPrice * 1.01;
  console.log('New stop-loss price:', tighterSL.toFixed(5));

  // Cancel old SL orders (those with triggerType=2 for longs, which means <= trigger)
  if (planOrdersResult.success && planOrdersResult.data && planOrdersResult.data.length > 0) {
    for (const order of planOrdersResult.data) {
      // For a long position, SL has triggerType=2 (<=)
      const isSL = isLong ? order.triggerType === 2 : order.triggerType === 1;
      if (isSL && order.id) {
        console.log('Cancelling old SL order:', order.id);
        const cancelResult = await client.cancelPlanOrder(order.id.toString());
        console.log('Cancel result:', cancelResult.success ? 'OK' : cancelResult.error);
      }
    }
  }

  // Create new SL with tighter price
  const newSlResult = await client.setStopLoss('DOGE_USDT', tighterSL);
  if (newSlResult.success) {
    console.log('✅ Created new stop-loss at:', tighterSL.toFixed(5));
  } else {
    console.error('❌ Failed to adjust stop-loss:', newSlResult.error);
  }
  console.log('');

  // Step 6: Ask before closing
  console.log('--- Step 6: Close Position ---');
  console.log('');
  console.log('⚠️  WARNING: This will close your DOGE position!');
  console.log('Position: ' + position.holdVol + ' contracts @ ' + position.holdAvgPrice);
  console.log('');
  console.log('To close the position, run with --close flag');
  console.log('  npx tsx scripts/test-sltp.ts --close');
  console.log('');

  if (process.argv.includes('--close')) {
    console.log('Closing position...');
    const closeResult = await client.closeLong('DOGE_USDT', position.holdVol);

    if (closeResult.success) {
      console.log('✅ Position closed successfully!');
      console.log('Data:', JSON.stringify(closeResult.data, null, 2));
    } else {
      console.error('❌ Failed to close position:', closeResult.error);
    }

    // Check balance after
    const balanceResult = await client.getUsdtBalance();
    console.log('');
    console.log('Final balance:', '$' + (balanceResult.balance || 0).toFixed(2));
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Test complete');
  console.log('='.repeat(60));
}

main().catch(console.error);
