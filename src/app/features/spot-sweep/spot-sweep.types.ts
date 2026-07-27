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
  /**
   * Opt this pair into patient-hunter mode (needs the global hunterEnabled
   * master switch too). Hunter pairs only get recs for A-grade setups; for
   * forming setups the LLM arms a monitor (documented intent + trigger +
   * invalidation + expiry) and the signal is created when it fires.
   */
  hunter?: boolean;
}

export interface SpotSweepConfig {
  enabled: boolean;
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

  respectKillSwitch: boolean;
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
   * Trading sessions the sweep is active in. Empty = always-on (no session
   * restriction). Otherwise the worker parks whenever UTC time falls
   * outside every selected session window.
   */
  activeSessions: SweepSession[];
  /**
   * Daily signal blackout: while the local time (in blackoutTimezone) is
   * inside [blackoutStart, blackoutEnd) the sweep parks entirely — no LLM
   * analyses, no signal generation — overriding the session windows. An end
   * at or before the start wraps past midnight ("22:00"→"00:00" = 10 PM to
   * midnight). Operator-initiated Spot Analysis is unaffected.
   */
  blackoutEnabled: boolean;
  /** "HH:mm" local time in blackoutTimezone. */
  blackoutStart: string;
  /** "HH:mm" local time; <= start wraps past midnight. */
  blackoutEnd: string;
  /** IANA timezone id, e.g. "Africa/Lagos" (WAT) or "UTC". */
  blackoutTimezone: string;

  // ── Patient-hunter mode ────────────────────────────────────────────────
  /** Master switch; per-pair opt-in via {@link SweepPair.hunter}. */
  hunterEnabled: boolean;
  /** Fleet-wide cap on Active hunter monitors (arming requests over it are skipped). */
  hunterMaxActiveMonitors: number;
  /** Per-symbol cap on Active hunter monitors (e.g. one per direction). */
  hunterMaxActiveMonitorsPerSymbol: number;
  /** How many times a fired monitor's re-analysis may re-arm a successor ("keep waiting"). */
  hunterMaxRearmDepth: number;
  /** Skip the scheduled sweep for a hunter pair while one of its monitors is armed. */
  hunterSkipWhileArmed: boolean;
  /** Ceiling (hours) on monitor expiry the LLM may request; clamped to [1, this]. */
  hunterMaxExpiryHours: number;
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
  /** Hunter monitors armed today (UTC day). */
  monitorsArmed: number;
  /** Hunter monitors that fired today. */
  monitorsFired: number;
  /** Hunter monitors whose invalidation condition hit today. */
  monitorsInvalidated: number;
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
  /** Active patient-hunter watches (armed monitors), soonest expiry first. */
  hunterMonitors: HunterArmedMonitor[];
}

/** One armed hunter monitor surfaced on the sweep cockpit. */
export interface HunterArmedMonitor {
  monitorId: number;
  symbol: string;
  timeframe: string;
  /** 'Buy' | 'Sell' | null (direction-agnostic plan). */
  direction: string | null;
  /** Documented plan, truncated (~120 chars). */
  intent: string;
  /** ISO timestamp. */
  expiresAtUtc: string;
  rearmDepth: number;
  status: string;
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
  pairs: [],
  barPosition: 'closed',
  intervalSeconds: 60,
  signalExpirationSeconds: 3600,
  respectKillSwitch: true,
  entryPreference: 'Any',
  maxParallelAnalyses: 6,
  // Empty = always-on (no session restriction). Operators opt in by ticking
  // sessions on the cockpit; sessions overlap so e.g. picking London+NewYork
  // covers 08:00-22:00 UTC including the 13-16 overlap.
  activeSessions: [],
  // Daily blackout ships disabled; the window defaults mirror the operator's
  // "10 PM – 12 AM WAT" request so enabling is a single checkbox.
  blackoutEnabled: false,
  blackoutStart: '22:00',
  blackoutEnd: '00:00',
  blackoutTimezone: 'Africa/Lagos',
  // Patient hunter ships off; enabling is the master switch + per-pair opt-in.
  hunterEnabled: false,
  hunterMaxActiveMonitors: 20,
  hunterMaxActiveMonitorsPerSymbol: 2,
  hunterMaxRearmDepth: 1,
  hunterSkipWhileArmed: true,
  hunterMaxExpiryHours: 72,
};
