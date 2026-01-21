/**
 * Focus Mode API Routes
 * Handles: focus state, enable/disable, config, notifications
 */

import { Router } from 'express';
import type { ServerContext } from '../server-context.js';

export function createFocusModeRouter(ctx: ServerContext): Router {
  const router = Router();
  const focusMode = ctx.focusModeManager;

  // Get focus mode state
  router.get('/', (req, res) => {
    res.json(focusMode.getState());
  });

  // Enable focus mode
  router.post('/enable', (req, res) => {
    focusMode.setEnabled(true);
    ctx.broadcastState();
    res.json({ success: true, enabled: true });
  });

  // Disable focus mode
  router.post('/disable', (req, res) => {
    focusMode.setEnabled(false);
    ctx.broadcastState();
    res.json({ success: true, enabled: false });
  });

  // Update focus mode config
  router.post('/config', (req, res) => {
    const { accountBalance, maxPositionSizePercent, leverage, targetBot, maxOpenPositions } = req.body;
    const config: any = {};

    if (accountBalance !== undefined) config.accountBalance = accountBalance;
    if (maxPositionSizePercent !== undefined) config.maxPositionSizePercent = maxPositionSizePercent;
    if (leverage !== undefined) config.leverage = leverage;
    if (maxOpenPositions !== undefined) config.maxOpenPositions = maxOpenPositions;

    // If target bot changed, clear all tracked positions and re-sync
    const currentConfig = focusMode.getConfig();
    if (targetBot !== undefined && targetBot !== currentConfig.targetBot) {
      config.targetBot = targetBot;
      focusMode.updateConfig(config);
      // Clear all positions and let sync re-import from new bot
      focusMode.clearAllPositions();
    } else {
      focusMode.updateConfig(config);
    }

    ctx.broadcastState();
    res.json({ success: true, config: focusMode.getConfig() });
  });

  // Test notification
  router.post('/test-notification', async (req, res) => {
    await focusMode.testNotification();
    res.json({ success: true });
  });

  // Clear closed positions
  router.post('/clear-closed', (req, res) => {
    focusMode.clearClosedPositions();
    ctx.broadcastState();
    res.json({ success: true });
  });

  return router;
}
