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

/** Trailing-24h firing + ghost-outcome breakdown for one gate. */
export interface ViabilityGateFiringStats {
  todayRejectionCount: number;
  todayAdvisoryCount: number;
  ghostResolvedCount: number;
  ghostWouldHaveWon: number;
  ghostWouldHaveLost: number;
  ghostEntryNotReached: number;
  ghostWouldHaveExpired: number;
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
}

export interface UpdateViabilityGateThresholdItem {
  key: string;
  value: number;
}

/** Mode picker options — used by the UI dropdown. */
export const VIABILITY_GATE_MODES: ViabilityGateMode[] = ['Enforce', 'Advisory', 'Off'];
