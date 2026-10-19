/**
 * Type contracts for the Viability Gates cockpit — operator surface for the
 * structural-conviction gates (E4e..E4j + E4h) the engine runs after the
 * confidence gate.  Mirrors the backend's `ViabilityGateDto` /
 * `ViabilityGateThresholdDto` / `UpdateViabilityGateRequest` shapes one-to-one.
 *
 * The engine emits a stable per-gate `Name` (e.g. `CounterTrendBelowFloor`)
 * which the PUT endpoint accepts as the path segment; the `ModeKey` /
 * threshold `Key` strings are the raw `EngineConfig:` rows the backend
 * writes through `UpsertEngineConfigCommand`.
 */

/** Per-gate runtime mode — keep in sync with the backend `ViabilityGateMode` enum. */
export type ViabilityGateMode = 'Enforce' | 'Advisory' | 'Off';

/** Widget hint the UI uses to pick a label suffix + input formatting. */
export type GateThresholdKind =
  | 'Decimal'
  | 'Confidence'
  | 'Percent'
  | 'Ratio'
  | 'Pips'
  | 'AbsoluteVolume'
  | 'Integer';

/** One tunable knob on a viability gate (one EngineConfig row). */
export interface ViabilityGateThreshold {
  /** EngineConfig row key (also the PUT payload `Key`). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Currently-configured value (decimal). */
  value: number;
  /** Compile-time default (shown as a "reset" hint). */
  defaultValue: number;
  /** Min for client-side validation (server enforces independently). */
  minValue: number;
  /** Max for client-side validation. */
  maxValue: number;
  /** UI hint for input widget + label suffix. */
  kind: GateThresholdKind;
  /** Optional descriptive help text (operator tooltip). */
  helpText?: string | null;
}

/**
 * Firing + ghost-outcome breakdown for one gate. The two halves cover DIFFERENT
 * windows: `today*` counts are the trailing 24h (from `statsWindowStartUtc`); every
 * `ghost*` count and both averages are cumulative — every rejected / advisory signal
 * the GhostOutcomeWorker ever resolved for this gate (engine GetViabilityGatesQuery).
 */
export interface ViabilityGateFiringStats {
  todayRejectionCount: number;
  todayAdvisoryCount: number;
  /** Every resolved ghost row (all time), including {@link ghostUnresolvable}. */
  ghostResolvedCount: number;
  ghostWouldHaveWon: number;
  ghostWouldHaveLost: number;
  ghostEntryNotReached: number;
  ghostWouldHaveExpired: number;
  /**
   * Resolved as `Unresolvable` (no candles to walk) — the part of `ghostResolvedCount` the four
   * outcome counts above do not cover. Engine field since 2026-10-19; the page used to derive it.
   */
  ghostUnresolvable: number;
  /** Null when WouldHaveWon subset is empty. */
  avgWinPips: number | null;
  /** Null when WouldHaveLost subset is empty (negative number when present). */
  avgLossPips: number | null;
}

/** One viability gate — the UI renders one card per item. */
export interface ViabilityGate {
  /** Stable name — PUT path segment. */
  name: string;
  displayName: string;
  description: string;
  mode: ViabilityGateMode;
  modeKey: string;
  thresholds: ViabilityGateThreshold[];
  stats: ViabilityGateFiringStats;
}

/** GET response envelope (top-level list + window cutoff). */
export interface ViabilityGatesList {
  gates: ViabilityGate[];
  /** UTC ISO timestamp the trailing-24h stats window begins at. */
  statsWindowStartUtc: string;
}

/** PUT body — supply only the parts you want to change. */
export interface UpdateViabilityGateRequest {
  mode?: ViabilityGateMode | null;
  thresholds?: UpdateViabilityGateThresholdItem[] | null;
  /**
   * Why this change is being made. REQUIRED for risk-LOOSENING mode changes
   * (Enforce→Advisory/Off) — the engine's governance layer queues those for
   * a 24h cooling-off period and refuses them without a reason.
   */
  reason?: string | null;
  /** Break-glass: apply a risk-loosening change immediately (requires `reason`). */
  immediate?: boolean;
}

export interface UpdateViabilityGateThresholdItem {
  key: string;
  value: number;
}

/**
 * Result of a gate update. `message` carries the governance outcome when a
 * risk-loosening change was QUEUED for cooling-off instead of applied —
 * the UI must surface it so the operator doesn't read the unchanged mode
 * as a failed save.
 */
export interface UpdateViabilityGateResult {
  written: number;
  message: string | null;
}

/**
 * One entry of the engine's cooling-off queue (`GET config/pending`). A
 * risk-loosening gate change saved with a reason but without "apply
 * immediately" lands here instead of in EngineConfig, so the card keeps showing
 * the old mode until `effectiveAt` — the page lists the queued change on its card.
 */
export interface PendingConfigChange {
  id: number;
  key: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  requestedAt: string;
  effectiveAt: string;
  status: string | null;
}

/** Mode picker options — used by the UI dropdown. */
export const VIABILITY_GATE_MODES: ViabilityGateMode[] = ['Enforce', 'Advisory', 'Off'];

/**
 * Ghost-outcome worker config — operator-tunable knobs controlling the
 * cadence + scope of the rejected-signal replay.  Mirrors the backend
 * `GhostOutcomeConfigDto`; defaults are emitted so the UI can render a
 * "default X" hint and a Revert action.
 */
export interface GhostOutcomeConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  walkWindowHours: number;
  lookbackHours: number;
  maxSignalsPerCycle: number;
  minSignalAgeSeconds: number;

  pollIntervalSecondsDefault: number;
  walkWindowHoursDefault: number;
  lookbackHoursDefault: number;
  maxSignalsPerCycleDefault: number;
  minSignalAgeSecondsDefault: number;
}

/** PUT body — supply only the knobs you want to change. */
export interface UpdateGhostOutcomeConfigRequest {
  enabled?: boolean | null;
  pollIntervalSeconds?: number | null;
  walkWindowHours?: number | null;
  lookbackHours?: number | null;
  maxSignalsPerCycle?: number | null;
  minSignalAgeSeconds?: number | null;
}
