/**
 * Settings API Routes
 * Handles: daily-reset, notification-settings, investment-amount
 */

import { Router } from 'express';
import type { ServerContext } from '../server-context.js';

export function createSettingsRouter(ctx: ServerContext): Router {
  const router = Router();

  // Daily Reset Settings
  router.get('/daily-reset', (req, res) => {
    res.json({
      enabled: ctx.settings.dailyResetEnabled,
      lastResetDate: ctx.settings.lastResetDate,
      currentDate: ctx.getCurrentDateString(),
    });
  });

  router.post('/daily-reset', (req, res) => {
    const { enabled, triggerNow } = req.body;

    // Update setting if provided
    if (typeof enabled === 'boolean') {
      ctx.settings.dailyResetEnabled = enabled;
      ctx.saveSettings();
      console.log(`[SETTINGS] Daily reset ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    // Trigger immediate reset if requested
    if (triggerNow === true) {
      ctx.resetAllBots();
      ctx.broadcastState();
    }

    res.json({
      success: true,
      enabled: ctx.settings.dailyResetEnabled,
      lastResetDate: ctx.settings.lastResetDate,
    });
  });

  // Notification & Sound Settings
  router.get('/notification-settings', (req, res) => {
    res.json({
      notificationsEnabled: ctx.settings.notificationsEnabled,
      soundEnabled: ctx.settings.soundEnabled,
    });
  });

  router.post('/notification-settings', (req, res) => {
    const { notificationsEnabled, soundEnabled } = req.body;

    if (typeof notificationsEnabled === 'boolean') {
      ctx.settings.notificationsEnabled = notificationsEnabled;
      console.log(`[SETTINGS] Notifications ${notificationsEnabled ? 'ENABLED' : 'DISABLED'}`);
    }

    if (typeof soundEnabled === 'boolean') {
      ctx.settings.soundEnabled = soundEnabled;
      console.log(`[SETTINGS] Sound ${soundEnabled ? 'ENABLED' : 'DISABLED'}`);
    }

    ctx.saveSettings();

    res.json({
      success: true,
      notificationsEnabled: ctx.settings.notificationsEnabled,
      soundEnabled: ctx.settings.soundEnabled,
    });
  });

  // Investment Amount
  router.get('/investment-amount', (req, res) => {
    res.json({
      amount: ctx.settings.investmentAmount,
    });
  });

  router.post('/investment-amount', (req, res) => {
    const { amount, resetBots } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount - must be a positive number' });
      return;
    }

    // Update all bots with the new initial balance
    ctx.updateAllBotsInitialBalance(amount);

    // Optionally reset all bots to start fresh with the new balance
    let botsReset = false;
    if (resetBots === true) {
      ctx.resetAllBots();
      ctx.broadcastState();
      botsReset = true;
    }

    res.json({
      success: true,
      amount: ctx.settings.investmentAmount,
      botsReset,
    });
  });

  return router;
}
