# MexcPositionService - Design Document

## Problem Statement

The current MEXC integration has fragmented state management across 5+ modules:
- `mexc-futures-client.ts` - Low-level API calls
- `mexc-trailing-manager.ts` - Trailing stop logic + position tracking
- `web-server.ts` - Queue management, reconciliation, execution
- `turso-db.ts` - Persistence
- Various in-memory maps (`mexcExecutionQueue`, `mexcMirrorTracker`, etc.)

This fragmentation causes:
1. **Duplicate orders** - Multiple code paths create SLs without coordination
2. **Lost positions** - State can disagree between memory, Turso, and MEXC
3. **Race conditions** - No single source of truth for position state
4. **Hard to debug** - Logs scattered across modules

## Goals

1. **Single source of truth** for all MEXC position state
2. **Explicit state machine** for position lifecycle
3. **One entry point** for all position operations
4. **Atomic operations** that can't leave positions in inconsistent states
5. **Backward compatible** - existing code continues to work during migration

## Non-Goals (for v1)

- Rewriting the screener or signal detection
- Changing paper bot architecture
- Modifying the dashboard UI
- Optimizing MEXC API performance

---

## Position Lifecycle State Machine

```
                    ┌─────────────┐
                    │   SIGNAL    │  (from bot/screener)
                    └──────┬──────┘
                           │ addToQueue()
                           ▼
                    ┌─────────────┐
                    │   QUEUED    │  (waiting for execution)
                    └──────┬──────┘
                           │ execute()
                           ▼
                    ┌─────────────┐
         ┌─────────│  EXECUTING  │  (order sent to MEXC)
         │         └──────┬──────┘
         │                │ onFillConfirmed()
         │ onFillFailed() ▼
         │         ┌─────────────┐
         │         │    OPEN     │  (position active, SL set)
         │         └──────┬──────┘
         │                │ onTrailActivated()
         │                ▼
         │         ┌─────────────┐
         │         │  TRAILING   │  (trailing stop active)
         │         └──────┬──────┘
         │                │ onCloseDetected()
         │                ▼
         │         ┌─────────────┐
         └────────►│   CLOSED    │  (position closed, logged)
                   └─────────────┘
```

Each state transition is:
- Logged to console with timestamp
- Persisted to Turso (if configured)
- Validated (can't skip states)

---

## Core Interface

```typescript
interface MexcPosition {
  // Identity
  id: string;                    // Unique ID (botId-symbol-timestamp)
  symbol: string;                // e.g., "BTC_USDT"

  // State
  state: PositionState;
  stateChangedAt: number;

  // Entry
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  volume: number;                // In contracts
  leverage: number;
  marginUsed: number;            // In USD

  // Stop Loss
  currentStopPrice: number;
  planOrderId: string;
  planOrderCreatedAt: number;

  // Trailing
  trailActivated: boolean;
  trailActivatedAt?: number;
  highestRoePct: number;
  highestPrice: number;
  lowestPrice: number;

  // Exit (filled when closed)
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  realizedPnl?: number;
  realizedPnlPct?: number;

  // Metadata
  botId: string;
  signalSource: string;          // 'backburner' | 'golden-pocket' | 'manual'
  entryQuadrant?: string;
  entryBias?: string;
}

type PositionState =
  | 'queued'
  | 'executing'
  | 'open'
  | 'trailing'
  | 'closing'
  | 'closed'
  | 'failed';
```

---

## Service API

```typescript
class MexcPositionService {
  // === Singleton ===
  static getInstance(): MexcPositionService;

  // === Queue Operations ===
  addToQueue(params: QueueParams): MexcPosition;
  getQueuedPositions(): MexcPosition[];
  removeFromQueue(id: string): void;

  // === Execution ===
  async execute(id: string): Promise<ExecutionResult>;
  async executeAll(): Promise<ExecutionResult[]>;

  // === Position Management ===
  getPosition(symbol: string): MexcPosition | undefined;
  getAllPositions(): MexcPosition[];
  getPositionsByState(state: PositionState): MexcPosition[];

  // === Stop Loss ===
  async updateStopLoss(symbol: string, newPrice: number): Promise<boolean>;
  async activateTrailing(symbol: string): Promise<void>;

  // === Close Detection ===
  async checkForCloses(): Promise<string[]>;  // Returns symbols that closed
  async confirmClose(symbol: string, exitData: ExitData): Promise<void>;

  // === Reconciliation ===
  async reconcileWithMexc(): Promise<ReconcileResult>;
  async reconcileWithTurso(): Promise<void>;

  // === Events ===
  on(event: 'stateChange', handler: (pos: MexcPosition, oldState: PositionState) => void): void;
  on(event: 'slUpdated', handler: (pos: MexcPosition, oldPrice: number) => void): void;
  on(event: 'closed', handler: (pos: MexcPosition) => void): void;
}
```

---

## Migration Strategy

### Phase 1: Wrap Existing Code (Safe)
1. Create `MexcPositionService` as a facade
2. Internally delegate to existing `trailingManager`, `mexcExecutionQueue`, etc.
3. Add logging at service boundary
4. **No behavior changes** - just consolidation

### Phase 2: State Machine
1. Add `state` field to positions
2. Validate state transitions
3. Log all transitions
4. Existing code still works, just with better observability

### Phase 3: Migrate Callers (Incremental)
1. Update `web-server.ts` queue operations → use service
2. Update trailing manager calls → use service
3. Update reconciliation → use service
4. Each migration is a separate PR, can be reverted

### Phase 4: Simplify Internals
1. Remove redundant in-memory maps
2. Consolidate Turso persistence
3. Single polling loop for all state checks

---

## Key Invariants (Enforced by Service)

1. **One position per symbol** - Can't have two positions in same symbol
2. **One SL per position** - Before creating SL, always cancel existing
3. **State transitions are sequential** - Can't go from QUEUED to TRAILING
4. **Closed positions are immutable** - Once closed, state can't change
5. **All MEXC calls go through service** - No direct client calls from web-server

---

## Files to Create/Modify

### New Files
- `src/mexc-position-service.ts` - The service itself
- `src/mexc-position-types.ts` - Type definitions
- `tests/mexc-position-service.test.ts` - Unit tests

### Files to Modify (Phase 3)
- `src/web-server.ts` - Replace direct queue/trailing calls
- `src/mexc-trailing-manager.ts` - Becomes internal to service
- `src/turso-db.ts` - Add position-specific queries

### Files Unchanged
- `src/mexc-futures-client.ts` - Low-level API stays as-is
- `src/screener.ts` - Signal detection unchanged
- `src/experimental-shadow-bots.ts` - Paper bots unchanged

---

## Rollback Plan

Since Phase 1 is just a wrapper:
- Delete `mexc-position-service.ts`
- Remove imports from `web-server.ts`
- Everything reverts to current behavior

---

## Success Metrics

After full migration:
- [ ] Zero duplicate plan orders (currently: 56 for 13 positions)
- [ ] Zero "position is unprotected" warnings
- [ ] Zero state disagreements between memory/Turso/MEXC
- [ ] All state transitions logged with timestamps
- [ ] Can reconstruct position history from logs alone

---

## Open Questions

1. Should paper bots use the same service? (Probably not for v1)
2. How to handle MEXC API failures? (Retry with backoff?)
3. Should we store full position history or just current state?
4. Rate limiting - global queue or per-operation?

---

## Next Steps

1. [ ] Review this design doc
2. [ ] Create `mexc-position-types.ts` with interfaces
3. [ ] Create `mexc-position-service.ts` Phase 1 (wrapper)
4. [ ] Add logging at service boundary
5. [ ] Test that existing behavior is unchanged
