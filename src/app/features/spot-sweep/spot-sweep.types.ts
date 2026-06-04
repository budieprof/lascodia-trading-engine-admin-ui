/**
 * Spot Sweep DTOs — mirror of the planned engine contract
 * (`/market-data/spot-sweep/*`). These live feature-local until the engine
 * ships the endpoints; at that point regenerate `api.types.ts` via
 * `npm run codegen:api` and re-point the service at the generated shapes.
 *
 * See docs/SPOT_SWEEP_PLAN.md §4.
 */

export type SweepMode = 'Paper' | 'Live';
export type SweepBarPosition = 'closed' | 'mid_25' | 'mid_50' | 'mid_75';
export type SweepPhase = 'Idle' | 'Analyzing' | 'Cooldown';

/** Sentinel meaning "every active account in scope". */
export const ALL_ACTIVE_SCOPE = 'AllActive' as const;

export interface SweepPair {
  /** Canonical symbol, e.g. "EURUSD". */
  symbol: string;
  /** Timeframe code, e.g. "H1". */
  timeframe: string;
}

export interface SpotSweepConfig {
  enabled: boolean;
  mode: SweepMode;
  pairs: SweepPair[];
  barPosition: SweepBarPosition;
  /** Pause between consecutive analyses (one analysis is ever in flight). */
  intervalSeconds: number;
  /** Explicit account ids, or the all-active sentinel. */
  accountScope: number[] | typeof ALL_ACTIVE_SCOPE;

  // Automation
  autoApprove: boolean;
  /** 0..1 — below this the signal stays Pending instead of auto-trading. */
  minConfidence: number;

  // Eligibility exclusions (a symbol is skipped when any enabled rule matches)
  excludeOpenPosition: boolean;
  excludePendingOrder: boolean;
  excludePendingSignal: boolean;
  requireActiveEaCoverage: boolean;

  // Hard caps — hitting any one parks the loop with an idleReason
  maxConcurrentSweepPositions: number;
  maxNewOrdersPerDay: number;
  maxDailyLlmCostUsd: number;
  /** Per-trade risk ceiling (lots; engine may map to a RiskProfile). */
  maxRiskPerTrade: number;

  respectKillSwitch: boolean;
}

export interface SweepLastResult {
  symbol: string;
  outcome: string;
  signalId: number | null;
  orderId: number | null;
  autoApproved: boolean;
  costUsd: number;
  /** ISO timestamp. */
  at: string;
}

export interface SweepTodayCounters {
  analyses: number;
  signalsCreated: number;
  ordersPlaced: number;
  autoApproved: number;
  manualPending: number;
  gateRejected: number;
  costUsd: number;
}

export interface SpotSweepStatus {
  running: boolean;
  phase: SweepPhase;
  /** Why the loop is parked, when phase is Idle. */
  idleReason: string | null;
  currentSymbol: string | null;
  /** ISO timestamp of the current analysis start. */
  startedAt: string | null;
  nextEligibleSymbol: string | null;
  lastResult: SweepLastResult | null;
  today: SweepTodayCounters;
  killSwitchActive: boolean;
  eligibleCount: number;
  excludedCount: number;
}

/** Sensible defaults for a fresh config (Phase 1 — Paper, no auto-order). */
export const DEFAULT_SWEEP_CONFIG: SpotSweepConfig = {
  enabled: false,
  mode: 'Paper',
  pairs: [],
  barPosition: 'closed',
  intervalSeconds: 60,
  accountScope: ALL_ACTIVE_SCOPE,
  autoApprove: false,
  minConfidence: 0.7,
  excludeOpenPosition: true,
  excludePendingOrder: true,
  excludePendingSignal: true,
  requireActiveEaCoverage: true,
  maxConcurrentSweepPositions: 3,
  maxNewOrdersPerDay: 10,
  maxDailyLlmCostUsd: 5,
  maxRiskPerTrade: 0.1,
  respectKillSwitch: true,
};
