/**
 * Execution Bridge API Routes
 *
 * Provides dashboard controls for the execution bridge:
 * - Mode switching (dry_run, shadow, live)
 * - Position management
 * - Emergency controls
 * - Stats and monitoring
 */

import { Router, Request, Response } from 'express';
import {
  ExecutionBridge,
  createSpotOnlyBridge,
  createFuturesBridge,
  createLiveBridge,
  type ExecutionBridgeConfig,
  type ExecutionMode,
  type TradingMode,
} from '../execution-bridge.js';

// Singleton bridge instance
let bridge: ExecutionBridge | null = null;
let bridgeInitialized = false;

/**
 * Get or create the execution bridge
 */
export function getExecutionBridge(): ExecutionBridge | null {
  return bridge;
}

/**
 * Initialize the bridge with given config
 */
export async function initializeBridge(
  tradingMode: TradingMode,
  balance: number
): Promise<ExecutionBridge> {
  // Destroy existing bridge if any
  if (bridge) {
    bridge.destroy();
  }

  // Create appropriate bridge
  bridge = tradingMode === 'spot'
    ? createSpotOnlyBridge(balance)
    : createFuturesBridge(balance);

  await bridge.initialize();
  bridgeInitialized = true;

  return bridge;
}

/**
 * Create the execution router
 */
export function createExecutionRouter(): Router {
  const router = Router();

  // ============= Status =============

  /**
   * GET /api/execution/status
   * Get current bridge status and stats
   */
  router.get('/status', (req: Request, res: Response) => {
    if (!bridge) {
      res.json({
        initialized: false,
        message: 'Execution bridge not initialized. Use POST /api/execution/init to initialize.',
      });
      return;
    }

    res.json({
      initialized: true,
      config: bridge.getConfig(),
      stats: bridge.getStats(),
      botStats: bridge.getBotStats(),
      regime: bridge.getCurrentRegime(),
      balance: bridge.getBalance(),
      openPositions: bridge.getOpenPositions().length,
    });
  });

  // ============= Initialization =============

  /**
   * POST /api/execution/init
   * Initialize the execution bridge
   *
   * Body: {
   *   tradingMode: 'spot' | 'futures',
   *   balance: number,
   *   botType?: 'baseline' | 'aggressive' | 'conservative' | 'contrarian'
   * }
   */
  router.post('/init', async (req: Request, res: Response) => {
    try {
      const { tradingMode = 'spot', balance = 2000, botType = 'aggressive' } = req.body;

      if (tradingMode !== 'spot' && tradingMode !== 'futures') {
        res.status(400).json({ error: 'Invalid tradingMode. Use "spot" or "futures".' });
        return;
      }

      // Destroy existing
      if (bridge) {
        bridge.destroy();
      }

      // Create new bridge
      const config: Partial<ExecutionBridgeConfig> = {
        mode: 'dry_run', // Always start in dry_run
        tradingMode,
        botType,
        spotOnly: tradingMode === 'spot',
        longOnly: tradingMode === 'spot',
      };

      bridge = new ExecutionBridge(config);
      await bridge.initialize();
      bridgeInitialized = true;

      res.json({
        success: true,
        message: `Execution bridge initialized in ${tradingMode} mode with ${botType} bot`,
        config: bridge.getConfig(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // ============= Mode Control =============

  /**
   * POST /api/execution/mode
   * Change execution mode
   *
   * Body: { mode: 'dry_run' | 'shadow' | 'live' }
   *
   * WARNING: Switching to 'live' will execute real trades!
   */
  router.post('/mode', async (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const { mode } = req.body;

    if (!['dry_run', 'shadow', 'live'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Use "dry_run", "shadow", or "live".' });
      return;
    }

    // Require confirmation for live mode
    if (mode === 'live') {
      const { confirmLive } = req.body;
      if (confirmLive !== 'I_UNDERSTAND_THIS_USES_REAL_MONEY') {
        res.status(400).json({
          error: 'Live mode requires confirmation.',
          hint: 'Include confirmLive: "I_UNDERSTAND_THIS_USES_REAL_MONEY" in request body',
        });
        return;
      }
    }

    // Update config - note: this requires re-initialization
    // For now, we'll need to destroy and recreate
    const currentConfig = bridge.getConfig();
    bridge.destroy();

    bridge = new ExecutionBridge({
      ...currentConfig,
      mode: mode as ExecutionMode,
    });
    await bridge.initialize();

    res.json({
      success: true,
      mode: bridge.getConfig().mode,
      warning: mode === 'live' ? 'LIVE TRADING IS NOW ACTIVE!' : undefined,
    });
  });

  // ============= Position Management =============

  /**
   * GET /api/execution/positions
   * Get all open positions
   */
  router.get('/positions', (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    res.json({
      positions: bridge.getOpenPositions(),
      count: bridge.getOpenPositions().length,
    });
  });

  /**
   * POST /api/execution/close/:positionId
   * Force close a specific position
   */
  router.post('/close/:positionId', async (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const { positionId } = req.params;
    const { reason = 'manual_close' } = req.body;

    const trade = await bridge.forceClose(positionId, reason);

    if (trade) {
      res.json({
        success: true,
        trade,
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }
  });

  /**
   * POST /api/execution/close-all
   * Emergency close all positions
   */
  router.post('/close-all', async (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const { confirm } = req.body;
    if (confirm !== 'CLOSE_ALL_NOW') {
      res.status(400).json({
        error: 'Confirmation required',
        hint: 'Include confirm: "CLOSE_ALL_NOW" in request body',
      });
      return;
    }

    const result = await bridge.emergencyCloseAll();

    res.json({
      success: true,
      ...result,
    });
  });

  // ============= Trade History =============

  /**
   * GET /api/execution/trades
   * Get recent executed trades
   */
  router.get('/trades', (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const trades = bridge.getExecutedTrades(limit);

    res.json({
      trades,
      count: trades.length,
    });
  });

  // ============= Stats =============

  /**
   * GET /api/execution/stats
   * Get bridge and bot statistics
   */
  router.get('/stats', (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    res.json({
      bridge: bridge.getStats(),
      bot: bridge.getBotStats(),
    });
  });

  // ============= Reconciliation =============

  /**
   * POST /api/execution/reconcile
   * Manually trigger position reconciliation
   */
  router.post('/reconcile', async (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const result = await bridge.reconcile();

    res.json({
      success: true,
      ...result,
    });
  });

  // ============= Config =============

  /**
   * GET /api/execution/config
   * Get current configuration
   */
  router.get('/config', (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    res.json(bridge.getConfig());
  });

  /**
   * PATCH /api/execution/config
   * Update configuration (limited fields)
   */
  router.patch('/config', async (req: Request, res: Response) => {
    if (!bridge) {
      res.status(400).json({ error: 'Bridge not initialized' });
      return;
    }

    const allowedFields = [
      'maxConcurrentPositions',
      'maxDailyTrades',
      'maxPositionSizeUsd',
      'maxTotalExposureUsd',
      'maxLossPerDayUsd',
    ];

    const updates: Partial<ExecutionBridgeConfig> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (updates as any)[field] = req.body[field];
      }
    }

    // Recreate bridge with updated config
    const currentConfig = bridge.getConfig();
    bridge.destroy();

    bridge = new ExecutionBridge({
      ...currentConfig,
      ...updates,
    });
    await bridge.initialize();

    res.json({
      success: true,
      config: bridge.getConfig(),
    });
  });

  return router;
}

export default createExecutionRouter;
