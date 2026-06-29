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
  /**
   * How long a signal created by this sweep stays Pending before the
   * engine auto-expires it. Mirrors the standard `TradeSignal.ExpiresAt`
   * semantics — once a signal hits this age unfilled it cancels (and any
   * open position derived from it closes at market).
   *
   * Stored in seconds to match {@link intervalSeconds}. Range: 60 s
   * (1 min — only useful for sub-bar scalps) to 86 400 s (24 h —
   * matches the engine's TTL ceiling for SpotAnalysis signals).
   * Default 3 600 (1 h), a reasonable fit for the H1 timeframe most
   * sweeps run on.
   */
  signalExpirationSeconds: number;
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
  /**
   * Per-symbol cap on (open positions + pending orders). When > 0, the sweep
   * skips a symbol whose current exposure count meets this cap. Default 0 =
   * no cap (legacy behaviour). When the matching boolean toggles above are
   * true the ANY-check fires first and this cap is unreachable — set the
   * relevant toggle to false to use the cap as the binding constraint.
   * Range [0, 50].
   */
  maxPendingPositionsPerSymbol: number;

  // Hard caps — hitting any one parks the loop with an idleReason
  maxConcurrentSweepPositions: number;
  maxNewOrdersPerDay: number;
  maxDailyLlmCostUsd: number;
  /** Per-trade risk ceiling (lots; engine may map to a RiskProfile). */
  maxRiskPerTrade: number;

  respectKillSwitch: boolean;
  /** Skip analysis when no in-scope account can open a new position. */
  skipWhenInsufficientMargin: boolean;
  /**
   * When on, cap the number of signals generated per tick to the sum of
   * per-account headroom (slot_room ∧ margin_room) across the selected
   * active accounts, AND distribute auto-approved orders across those
   * accounts (most-headroom-first) instead of routing everything to a
   * single picked account. Strictly stronger than
   * {@link skipWhenInsufficientMargin}; opt-in default off.
   */
  limitSignalsToAccountCapacity: boolean;
  /**
   * Per-trade margin estimate (USD) used by
   * {@link limitSignalsToAccountCapacity} to compute
   * `margin_room = floor(MarginAvailable / EstimatedMarginPerTrade)`.
   * Coarse heuristic — set near the average margin you observe a sweep
   * order lock. Range [1, 10000]; default 50.
   */
  estimatedMarginPerTrade: number;
  /**
   * Bias the auto-approve router AGAINST accounts whose open book is
   * already skewed in the same direction as the signal being placed.
   * Range [0, 1]; 0 disables (legacy headroom-only routing). Penalty =
   * `max(0, skew) × weight`, where `skew = (sameDir − oppositeDir) /
   * max(1, sameDir + oppositeDir)`. Default 0.5: a 100% same-direction
   * account loses half its effective headroom; a 50/50 split account
   * is unaffected. Only consulted when
   * {@link limitSignalsToAccountCapacity} is on.
   */
  directionSkewPenaltyWeight: number;
  /**
   * When on, drop any pair from this tick's eligible list whose scoped
   * broker accounts are ALL currently in elevated-spread state per the
   * spread-reactive subsystem. Saves LLM cost during NY-close / news /
   * weekend gap windows. When at least one scoped account is still in
   * normal spread, analysis proceeds — the order routes to the calm
   * account. Default off — opt-in to preserve legacy behaviour.
   */
  suspendOnHighSpread: boolean;
  /** Entry-style bias for the LLM: 'Any' | 'Stop' (prefer breakout) | 'Limit'
   *  (prefer pullback). */
  entryPreference: EntryPreference;
  /**
   * Max pair analyses the worker may run in parallel within a single tick.
   * The worker fans out across every eligible pair each tick; this caps
   * concurrent LLM calls. 1 = legacy "one pair per tick" mode; default 6
   * is a good balance against LLM provider rate limits; > 10 will usually
   * hit them.
   */
  maxParallelAnalyses: number;
  /**
   * How long a pair stays excluded after an analysis returned no trade
   * signal (LLM Hold). Avoids paying for repeat calls on a symbol whose
   * structure won't have changed inside the same bar. Set to 0 to disable;
   * default 1800 (30 min). A signal-producing analysis clears any prior
   * cooldown on that pair.
   */
  holdCooldownSeconds: number;
  /**
   * Trading sessions the sweep is active in. Empty = always-on (no session
   * restriction). Otherwise the worker parks whenever UTC time falls
   * outside every selected session window.
   */
  activeSessions: SweepSession[];
}

export type SweepSession = 'Sydney' | 'Tokyo' | 'London' | 'NewYork';
export const ALL_SWEEP_SESSIONS: SweepSession[] = ['Sydney', 'Tokyo', 'London', 'NewYork'];

export type EntryPreference = 'Any' | 'Stop' | 'Limit';

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
  /**
   * ISO timestamp at which the worker's current sleep expires and the next
   * tick fires. Set during Cooldown (and parked Idle); null while actively
   * analysing. Drives the cockpit's per-second countdown — UI shows
   * `(nextRunAt - now)`.
   */
  nextRunAt: string | null;
  lastResult: SweepLastResult | null;
  today: SweepTodayCounters;
  killSwitchActive: boolean;
  eligibleCount: number;
  excludedCount: number;
  /** Pairs currently in the Hold cooldown — analysed recently, returned no signal. */
  holdCooldowns: SweepHoldCooldown[];
  /**
   * Pairs the worker skipped this tick because they failed the eligibility
   * check (open position / pending order / pending signal / no EA coverage).
   * Hold-cooldown'd pairs are not included here — those are in
   * {@link holdCooldowns}.
   */
  excludedPairs: SweepExcludedPair[];
}

/** One per-pair Hold cooldown entry surfaced to the cockpit. */
export interface SweepHoldCooldown {
  symbol: string;
  timeframe: string;
  /** ISO timestamp of when the worker stamped the cooldown. */
  placedAtUtc: string;
  /** ISO timestamp of when the worker will re-analyse this pair. */
  expiresAtUtc: string;
}

/** One per-pair exclusion entry surfaced to the cockpit. */
export interface SweepExcludedPair {
  symbol: string;
  timeframe: string;
  /** Short operator-facing label, e.g. "Open position", "No EA coverage". */
  reason: string;
}

/** One past sweep cycle, for the history table. */
export interface SweepHistoryItem {
  id: number;
  /** ISO timestamp the analysis ran. */
  at: string;
  symbol: string;
  timeframe: string;
  /** SignalCreated | NoSignal | GateRejected | Skipped */
  outcome: string;
  confidence: number | null;
  signalId: number | null;
  orderId: number | null;
  autoApproved: boolean;
  mode: SweepMode;
  costUsd: number;
}

/** Sensible defaults for a fresh config (Phase 1 — Paper, no auto-order). */
export const DEFAULT_SWEEP_CONFIG: SpotSweepConfig = {
  enabled: false,
  mode: 'Paper',
  pairs: [],
  barPosition: 'closed',
  intervalSeconds: 60,
  signalExpirationSeconds: 3600,
  accountScope: ALL_ACTIVE_SCOPE,
  autoApprove: false,
  minConfidence: 0.7,
  excludeOpenPosition: true,
  excludePendingOrder: true,
  maxPendingPositionsPerSymbol: 0,
  excludePendingSignal: true,
  requireActiveEaCoverage: true,
  maxConcurrentSweepPositions: 3,
  maxNewOrdersPerDay: 10,
  maxDailyLlmCostUsd: 5,
  maxRiskPerTrade: 0.1,
  respectKillSwitch: true,
  skipWhenInsufficientMargin: true,
  limitSignalsToAccountCapacity: false,
  estimatedMarginPerTrade: 50,
  directionSkewPenaltyWeight: 0.5,
  suspendOnHighSpread: false,
  entryPreference: 'Any',
  maxParallelAnalyses: 6,
  holdCooldownSeconds: 1800,
  // Empty = always-on (no session restriction). Operators opt in by ticking
  // sessions on the cockpit; sessions overlap so e.g. picking London+NewYork
  // covers 08:00-22:00 UTC including the 13-16 overlap.
  activeSessions: [],
};
