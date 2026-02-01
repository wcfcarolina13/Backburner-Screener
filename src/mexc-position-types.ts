/**
 * MEXC Position Service - Type Definitions
 *
 * Central type definitions for the unified position management system.
 * These types represent the "source of truth" for position state.
 */

// ============= Position State Machine =============

export type PositionState =
  | 'queued'      // In queue, waiting for execution
  | 'executing'   // Order sent to MEXC, awaiting confirmation
  | 'open'        // Position active, initial SL set
  | 'trailing'    // Trailing stop activated
  | 'closing'     // Close detected, awaiting confirmation
  | 'closed'      // Position closed, logged to Turso
  | 'failed';     // Execution failed

// Valid state transitions
export const VALID_TRANSITIONS: Record<PositionState, PositionState[]> = {
  queued: ['executing', 'failed'],
  executing: ['open', 'failed'],
  open: ['trailing', 'closing', 'closed'],
  trailing: ['closing', 'closed'],
  closing: ['closed'],
  closed: [],  // Terminal state
  failed: [],  // Terminal state
};

// ============= Core Position Interface =============

export interface MexcPosition {
  // === Identity ===
  id: string;                    // Unique ID: `${botId}-${symbol}-${timestamp}`
  symbol: string;                // Futures symbol, e.g., "BTC_USDT"

  // === State ===
  state: PositionState;
  stateHistory: StateTransition[];

  // === Entry ===
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  volume: number;                // In contracts (not USD)
  leverage: number;
  marginUsed: number;            // USD value of margin

  // === Stop Loss ===
  initialStopPrice: number;      // Original SL at entry
  currentStopPrice: number;      // Current SL (may have trailed)
  planOrderId: string;           // MEXC plan order ID for SL
  planOrderCreatedAt: number;

  // === Trailing ===
  trailActivated: boolean;
  trailActivatedAt?: number;
  trailTriggerPct: number;       // ROE% at which trail activates
  trailStepPct: number;          // Current trail step (may be profit-tiered)
  highestRoePct: number;
  highestPrice: number;
  lowestPrice: number;

  // === Exit (populated when closed) ===
  exitPrice?: number;
  exitTime?: number;
  exitReason?: ExitReason;
  realizedPnl?: number;
  realizedPnlPct?: number;

  // === Metadata ===
  botId: string;
  signalSource: SignalSource;
  entryQuadrant?: string;
  entryBias?: string;
  executionMode: 'live' | 'shadow';

  // === Timestamps ===
  createdAt: number;
  updatedAt: number;
}

export interface StateTransition {
  from: PositionState;
  to: PositionState;
  timestamp: number;
  reason?: string;
}

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'manual'
  | 'liquidation'
  | 'external'       // Closed outside our system
  | 'insurance_be'   // Insurance breakeven
  | 'historical';    // Imported from history

export type SignalSource =
  | 'backburner'
  | 'golden-pocket'
  | 'focus-mode'
  | 'manual'
  | 'reconciled';    // Adopted orphan position

// ============= Queue Types =============

export interface QueueParams {
  symbol: string;               // Spot symbol, e.g., "BTCUSDT"
  direction: 'long' | 'short';
  botId: string;
  signalSource: SignalSource;

  // Optional - will use defaults if not provided
  leverage?: number;
  marginUsd?: number;           // Position size in USD
  stopLossPct?: number;         // ROE% for initial SL
  takeProfitPct?: number;       // ROE% for TP (0 = no TP)

  // Metadata
  entryQuadrant?: string;
  entryBias?: string;
  signalRsi?: number;
  impulsePercent?: number;
}

export interface ExecutionResult {
  success: boolean;
  position?: MexcPosition;
  error?: string;
  orderId?: string;
}

// ============= Reconciliation Types =============

export interface ReconcileResult {
  // Positions that exist on MEXC but not tracked
  adopted: string[];

  // Positions we tracked but MEXC doesn't have (closed externally)
  closedExternally: string[];

  // Positions with mismatched state (e.g., different SL price)
  corrected: string[];

  // Errors encountered
  errors: Array<{ symbol: string; error: string }>;
}

// ============= Event Types =============

export type PositionEvent =
  | { type: 'stateChange'; position: MexcPosition; oldState: PositionState; newState: PositionState }
  | { type: 'slUpdated'; position: MexcPosition; oldPrice: number; newPrice: number }
  | { type: 'trailActivated'; position: MexcPosition }
  | { type: 'closed'; position: MexcPosition }
  | { type: 'error'; symbol: string; error: string };

export type PositionEventHandler = (event: PositionEvent) => void;

// ============= Service Configuration =============

export interface PositionServiceConfig {
  // Execution
  defaultLeverage: number;
  defaultMarginUsd: number;
  maxMarginUsd: number;
  maxLeverage: number;

  // Stop Loss
  defaultInitialStopPct: number;  // ROE%
  trailTriggerPct: number;        // ROE% to activate trailing
  trailStepPct: number;           // Default trail step

  // Profit-tiered trailing
  useProfitTieredTrail: boolean;
  profitTiers: Array<{ minRoePct: number; trailStepPct: number }>;

  // Timing
  gracePeriodsMs: number;         // Before checking if position closed
  minSlModifyIntervalMs: number;  // Throttle SL modifications
  planOrderRenewalDays: number;   // Renew SL before expiry

  // Mode
  executionMode: 'live' | 'shadow';
  autoExecute: boolean;
}

// ============= Helper Functions =============

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: PositionState, to: PositionState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Check if a position is in a terminal state
 */
export function isTerminalState(state: PositionState): boolean {
  return state === 'closed' || state === 'failed';
}

/**
 * Generate a unique position ID
 */
export function generatePositionId(botId: string, symbol: string): string {
  return `${botId}-${symbol}-${Date.now()}`;
}

/**
 * Convert spot symbol to futures symbol
 * BTCUSDT -> BTC_USDT
 */
export function spotToFuturesSymbol(spotSymbol: string): string {
  // Remove USDT suffix and add _USDT
  const base = spotSymbol.replace(/USDT$/i, '');
  return `${base}_USDT`;
}

/**
 * Convert futures symbol to spot symbol
 * BTC_USDT -> BTCUSDT
 */
export function futuresToSpotSymbol(futuresSymbol: string): string {
  return futuresSymbol.replace('_', '');
}
