import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  AnalyzeSignalSensitivityResultDto,
  PagedData,
  ResponseData,
  Timeframe,
} from '@core/api/api.types';

/**
 * Request shape for `POST /llm-backtest/{id}/sensitivity-analysis`. The route
 * id is authoritative; this body carries the sweep + filter knobs. Same DTO
 * shape the signal-sensitivity page consumes for its result block so the UI
 * can reuse the heatmap + cohort-table components.
 */
export interface AnalyzeBacktestSensitivityRequest {
  /** Optional case-insensitive symbol filter; empty / null = all symbols in the run. */
  symbols?: string[];
  /** Direction filter (Buy / Sell as strings). Empty / null = both. */
  directions?: ('Buy' | 'Sell')[];
  /** Operator's chosen TP multiplier for the KPI aggregate. Default 1.0. */
  tpMultiplier?: number;
  /** Operator's chosen SL multiplier for the KPI aggregate. Default 1.0. */
  slMultiplier?: number;
  /** TP-multiplier sweep values for the heatmap rows. Default [0.5, 0.75, 1.0, 1.25, 1.5]. */
  tpSweepValues?: number[];
  /** SL-multiplier sweep values for the heatmap columns. Default [0.5, 0.75, 1.0, 1.5, 2.0]. */
  slSweepValues?: number[];
  /** Cap per-rec detail rows. Default 200. */
  signalDetailCap?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Enums — mirror C# Domain.Enums.* + Backtest.Models.*. Numeric values match
// the server-side enum integer to keep JSON payloads compatible whether the
// server is configured with default ints or string converters.
// ──────────────────────────────────────────────────────────────────────────

export enum BacktestStatus {
  Pending = 0,
  Running = 1,
  Completed = 2,
  Failed = 3,
  Cancelled = 4,
}

export const BacktestStatusName: Record<BacktestStatus, string> = {
  [BacktestStatus.Pending]: 'Pending',
  [BacktestStatus.Running]: 'Running',
  [BacktestStatus.Completed]: 'Completed',
  [BacktestStatus.Failed]: 'Failed',
  [BacktestStatus.Cancelled]: 'Cancelled',
};

export enum GridSampling {
  EveryBarClose = 0,
  EveryNthBar = 1,
  ExplicitTimestamps = 2,
}

export enum BacktestModelTier {
  Spot = 0,
  Macro = 1,
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2 — Guard-threshold sweep enum + UI metadata. Mirrors the C#
// `LascodiaTradingEngine.Application.Common.Trading.GuardKnob` enum. The
// integer values are wire-stable; the metadata is UI-only (display label,
// default value from `ViabilityGateConfig.Default`, a free-text unit hint
// and a sensible min/max range for the launch-form number inputs).
// ──────────────────────────────────────────────────────────────────────────

export enum GuardKnob {
  MinConfidence = 0,
  MinRewardRisk = 1,
  MinStopAtrFraction = 2,
  EntryBandAtrFraction = 3,
  ReachAtrFraction = 4,
  HardReachAtrFraction = 5,
  TpNamedLevelBufferAtrFraction = 6,
  SlMagnetBufferAtrFraction = 7,
  EntryMagnetBufferAtrFraction = 8,
  WarningAckedConfidenceCap = 9,
  RrCeiling = 10,
  RrCeilingTpEnvelopeFraction = 11,
  CounterContextVwapAtrFraction = 12,
  CounterContextCumDeltaMultiple = 13,
  StaleSnapshotMaxAgeMinutes = 14,
}

/** Per-knob UI metadata: display name + production default + unit hint + UI input range. */
export interface GuardKnobMeta {
  knob: GuardKnob;
  displayName: string;
  defaultValue: number;
  unit: string;
  min: number;
  max: number;
}

/**
 * Per-`GuardKnob` UI metadata. Defaults mirror
 * `ViabilityGateConfig.Default` byte-for-byte. `min`/`max` are UI-side
 * hints for the launch-form number inputs — the server also enforces a
 * 32-value cap on the expansion, so sliders/inputs don't try to enforce
 * the same.
 */
export const GUARD_KNOB_META: Readonly<Record<GuardKnob, GuardKnobMeta>> = {
  [GuardKnob.MinConfidence]: {
    knob: GuardKnob.MinConfidence,
    displayName: 'Min confidence',
    defaultValue: 0.55,
    unit: 'ratio (0..1)',
    min: 0,
    max: 1,
  },
  [GuardKnob.MinRewardRisk]: {
    knob: GuardKnob.MinRewardRisk,
    displayName: 'Min reward / risk',
    defaultValue: 1.2,
    unit: 'ratio',
    min: 0,
    max: 10,
  },
  [GuardKnob.MinStopAtrFraction]: {
    knob: GuardKnob.MinStopAtrFraction,
    displayName: 'Min SL distance (× ATR)',
    defaultValue: 0.8,
    unit: 'ATR fraction',
    min: 0,
    max: 5,
  },
  [GuardKnob.EntryBandAtrFraction]: {
    knob: GuardKnob.EntryBandAtrFraction,
    displayName: 'Entry band (× ATR)',
    defaultValue: 0.5,
    unit: 'ATR fraction',
    min: 0,
    max: 5,
  },
  [GuardKnob.ReachAtrFraction]: {
    knob: GuardKnob.ReachAtrFraction,
    displayName: 'TP soft reach (× TTL·ATR)',
    defaultValue: 0.7,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.HardReachAtrFraction]: {
    knob: GuardKnob.HardReachAtrFraction,
    displayName: 'TP hard reach (× TTL·ATR)',
    defaultValue: 0.55,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.TpNamedLevelBufferAtrFraction]: {
    knob: GuardKnob.TpNamedLevelBufferAtrFraction,
    displayName: 'TP named-level buffer (× ATR)',
    defaultValue: 0.2,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.SlMagnetBufferAtrFraction]: {
    knob: GuardKnob.SlMagnetBufferAtrFraction,
    displayName: 'SL magnet buffer (× ATR)',
    defaultValue: 0.3,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.EntryMagnetBufferAtrFraction]: {
    knob: GuardKnob.EntryMagnetBufferAtrFraction,
    displayName: 'Entry magnet buffer (× ATR)',
    defaultValue: 0.3,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.WarningAckedConfidenceCap]: {
    knob: GuardKnob.WarningAckedConfidenceCap,
    displayName: 'Warning-acked confidence cap',
    defaultValue: 0.55,
    unit: 'ratio (0..1)',
    min: 0,
    max: 1,
  },
  [GuardKnob.RrCeiling]: {
    knob: GuardKnob.RrCeiling,
    displayName: 'R:R ceiling (stretched TP)',
    defaultValue: 4.0,
    unit: 'ratio',
    min: 1,
    max: 20,
  },
  [GuardKnob.RrCeilingTpEnvelopeFraction]: {
    knob: GuardKnob.RrCeilingTpEnvelopeFraction,
    displayName: 'R:R ceiling TP envelope fraction',
    defaultValue: 0.8,
    unit: 'ATR fraction',
    min: 0,
    max: 3,
  },
  [GuardKnob.CounterContextVwapAtrFraction]: {
    knob: GuardKnob.CounterContextVwapAtrFraction,
    displayName: 'Counter-context VWAP distance (× ATR)',
    defaultValue: 1.5,
    unit: 'ATR fraction',
    min: 0,
    max: 10,
  },
  [GuardKnob.CounterContextCumDeltaMultiple]: {
    knob: GuardKnob.CounterContextCumDeltaMultiple,
    displayName: 'Counter-context cum-delta multiple',
    defaultValue: 2.0,
    unit: 'ratio',
    min: 0,
    max: 10,
  },
  [GuardKnob.StaleSnapshotMaxAgeMinutes]: {
    knob: GuardKnob.StaleSnapshotMaxAgeMinutes,
    displayName: 'Stale snapshot max age',
    defaultValue: 5,
    unit: 'minutes',
    min: 0,
    max: 60,
  },
};

/** Hard cap on sweep expansion — mirrors `BacktestSweepSpec.MaxValuesPerSweep`. */
export const SWEEP_MAX_VALUES = 32;

// ──────────────────────────────────────────────────────────────────────────
// Wire-format DTOs (mirror C# DTOs in
// LascodiaTradingEngine.Application.Backtest.*). Field casing follows the
// admin UI's camelCase wire contract — ASP.NET's JsonSerializer is configured
// to emit camelCase, so a C# `TotalPoints` arrives as `totalPoints`.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Operator-supplied grid spec sent to /llm-backtest (create) and
 * /llm-backtest/estimate-cost. Drives the (symbol × timeframe × asOfUtc)
 * expansion the worker fans out over.
 */
export interface BacktestGridSpec {
  symbols: string[];
  timeframes: Timeframe[];
  /** ISO timestamp (UTC). Inclusive. */
  windowStartUtc: string;
  /** ISO timestamp (UTC). Exclusive. */
  windowEndUtc: string;
  sampling: GridSampling;
  /** Required when `sampling === EveryNthBar`. */
  everyNthBar?: number | null;
  /** Required + non-empty when `sampling === ExplicitTimestamps`. ISO strings. */
  explicitTimestamps?: string[] | null;
  /** Hard cap on expanded grid points (default 1000, max 1000). */
  maxPoints?: number | null;
  /** Hard cap on estimated spend in USD (default 50, max 500). */
  maxTokenBudgetUsd?: number | null;
  /** When true, the worker skips the LLM call (free smoke-test). */
  dryRun: boolean;
  /** Optional override of `AnalyzeMarketCommand.SpotAnalysisPromptVersion`. */
  promptVersionOverride?: string | null;
  /** Free-text operator tag persisted on `LlmBacktestRun.Note`. */
  note?: string | null;
  /**
   * Phase 2 — optional guard-threshold sweep block. When set, the worker
   * evaluates the same cached LLM response through N viability-gate
   * configs (one per knob value in the sweep range) and persists the
   * per-knob viability/outcome tally on each point row alongside the
   * base-config result. Sweep cost is $0 incremental — the LLM call is
   * shared across every knob value.
   */
  sweep?: BacktestSweepSpec | null;
  /**
   * Phase 3 — optional multi-sample stability mode. When > 1, every grid
   * point makes N independent LLM calls (sample 0 may reuse the cache,
   * samples 1..N-1 bypass it). Costs N× a single-sample run for cache-miss
   * cells. Mutually exclusive with {@link sweep} — the backend validator
   * rejects payloads that set both.
   *
   * Valid range: 2..10. Null / unset / `1` = single-sample (legacy) mode.
   */
  sampleCount?: number | null;
  /**
   * Optional order-style preference threaded through to the LLM prompt and
   * post-LLM filter. Accepted values: `"Stop"` (prefer breakout entries),
   * `"Limit"` (prefer pullback entries), `"Any"` / null (no preference).
   * Mirrors the live spot-sweep `entryPreference` knob. When set to Stop or
   * Limit, the backtest cache is namespaced with a `+bias=X` suffix on the
   * effective prompt version so bias variants don't pool incorrectly.
   */
  entryBias?: 'Any' | 'Stop' | 'Limit' | null;
}

/**
 * Phase 2 — guard-threshold sweep specification embedded in
 * {@link BacktestGridSpec.sweep}. Inclusive `startValue..endValue`
 * stepped by `stepValue`. The expansion is capped at
 * {@link SWEEP_MAX_VALUES} (32) values server-side; the launch form
 * rejects locally as well so the cost preview stays honest.
 */
export interface BacktestSweepSpec {
  knob: GuardKnob;
  startValue: number;
  endValue: number;
  stepValue: number;
}

export interface CreateLlmBacktestRunRequest {
  name?: string | null;
  spec: BacktestGridSpec;
}

export interface CreateLlmBacktestRunResult {
  id: number;
  totalPoints: number;
  estimatedCostUsd: number;
}

export interface EstimateBacktestCostRequest {
  spec: BacktestGridSpec;
}

export interface BacktestCostEstimate {
  totalPoints: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  maxTokenBudgetUsd: number;
  fitsBudget: boolean;
}

// Per-run summary blob (LlmBacktestRun.SummaryJson). Mirrors the
// BacktestRunSummaryDto in `LlmBacktestWorker.cs`. The server emits this
// only once a run reaches a terminal state, hence the optionality on the
// detail DTO.
export interface BacktestOutcomeCounts {
  hitTP: number;
  hitSL: number;
  expiredPositive: number;
  expiredNegative: number;
  expiredFlat: number;
  entryNotReached: number;
  noCandlesInWindow: number;
}

export interface SymbolCohort {
  symbol: string;
  count: number;
  hitRate: number;
  expectedR: number;
  meanMfePips: number;
  meanMaePips: number;
}

export interface RegimeCohort {
  regime: string | null;
  count: number;
  hitRate: number;
  expectedR: number;
}

/**
 * Phase 4 (P4.2) — per-direction cohort row (Buy / Sell). Mirrors the C#
 * `LlmBacktestWorker.DirectionCohort` record. Helps spot a directional bias
 * in the LLM's output.
 */
export interface DirectionCohort {
  direction: 'Buy' | 'Sell' | string;
  count: number;
  hitRate: number;
  expectedR: number;
  meanMfePips: number;
  meanMaePips: number;
}

/**
 * Phase 4 (P4.2) — per-time-of-day cohort row keyed on AsOfUtc.Hour. Four
 * disjoint FX-session-aligned bins; the server emits these rows in the
 * temporal flow Asia → London → LondonNYOverlap → NewYorkLate.
 */
export interface TimeOfDayCohort {
  bin: 'Asia' | 'London' | 'LondonNYOverlap' | 'NewYorkLate' | string;
  count: number;
  hitRate: number;
  expectedR: number;
  meanMfePips: number;
  meanMaePips: number;
}

/**
 * Phase 4 (P4.2) — per-confidence-bucket cohort row. Half-open bins on
 * `[0.55, 0.65)`, `[0.65, 0.75)`, `[0.75, 0.85)`, and `[0.85, 1.00]`.
 * Sub-floor confidences (< 0.55) are filtered upstream by the viability
 * gate and don't appear here.
 */
export interface ConfidenceBucketCohort {
  bucket: '0.55-0.65' | '0.65-0.75' | '0.75-0.85' | '0.85+' | string;
  count: number;
  hitRate: number;
  expectedR: number;
  meanMfePips: number;
  meanMaePips: number;
}

export interface BacktestRunSummary {
  totalRecommendations: number;
  viableCount: number;
  rejectedByGateCount: number;
  bypassedCount: number;
  outcomes: BacktestOutcomeCounts;
  hitRate: number;
  expectedR: number;
  perSymbol: SymbolCohort[];
  perRegime: RegimeCohort[];
  rejectionReasonCounts: Record<string, number>;
  cacheHitRatio: number;
  actualCostUsd: number;
  /**
   * Phase 2 — present only on sweep-mode runs. Contains the per-knob-value
   * metric curve aggregated across every processed point. Mirrors the C#
   * `LlmBacktestWorker.BacktestSweepCurve` record.
   */
  sweepCurve?: BacktestSweepCurve | null;
  /**
   * Phase 4 (P4.2) — per-direction (Buy / Sell) outcome cohort. Empty when
   * the run had zero viable recs; absent on older serialised payloads.
   */
  perDirection?: DirectionCohort[];
  /**
   * Phase 4 (P4.2) — per-time-of-day cohort (4 FX-session bins). Empty when
   * the run had zero viable recs; absent on older serialised payloads.
   */
  perTimeOfDay?: TimeOfDayCohort[];
  /**
   * Phase 4 (P4.2) — per-confidence-bucket cohort. Empty when the run had
   * zero viable recs; absent on older serialised payloads.
   */
  perConfidenceBucket?: ConfidenceBucketCohort[];
  /**
   * Phase 3 — present only on multi-sample runs (`BacktestGridSpec.sampleCount > 1`).
   * Aggregates the per-point {@link MultiSampleStats} into headline
   * mean-of-mean / mean-of-stddev metrics. Mirrors C#
   * `LlmBacktestWorker.MultiSampleStability`.
   */
  stability?: MultiSampleStability | null;
}

/**
 * Phase 3 — multi-sample stability summary. Present on
 * {@link BacktestRunSummary.stability} for runs that requested
 * {@link BacktestGridSpec.sampleCount} > 1.
 *
 * The headline metric is {@link meanOfStdDevHitRates}: average per-point
 * population stddev of the hit rate across the N samples. A value near
 * zero = the LLM produces near-identical setups on every draw; a larger
 * value = high stochasticity, single-sample results should be treated as
 * point estimates with non-trivial variance.
 */
export interface MultiSampleStability {
  /** N (the `sampleCount` the operator chose). */
  samplesPerPoint: number;
  /** Count of points that emitted a non-null per-point stats blob. */
  pointsWithMultiSample: number;
  /** Average of the per-point mean hit-rate. */
  meanOfMeanHitRates: number;
  /** Average of the per-point hit-rate population stddev — the headline. */
  meanOfStdDevHitRates: number;
  meanOfMeanExpectedRs: number;
  meanOfStdDevExpectedRs: number;
  meanOfMeanViableCount: number;
  meanOfStdDevViableCount: number;
}

/**
 * Phase 3 — one entry inside a point's `multiSampleResultsJson`. The
 * persisted shape is JSON-stringified so consumers must `JSON.parse`
 * before iterating; this interface is the parsed-form contract.
 */
export interface MultiSampleResult {
  /** Zero-based sample index (0 = base sample). */
  sampleIndex: number;
  viable: number;
  rejected: number;
  bypassed: number;
  outcomes: BacktestOutcomeCounts;
  hitRate: number;
  expectedR: number;
}

/**
 * Phase 3 — parsed shape of a point's `multiSampleStatsJson`. Computed
 * with population stddev (divide by N, not N-1) — N is small (2..10) and
 * the operator wants the raw spread of THESE draws, not a population-
 * inference estimator.
 */
export interface MultiSampleStats {
  samples: number;
  meanHitRate: number;
  stdDevHitRate: number;
  meanExpectedR: number;
  stdDevExpectedR: number;
  meanViableCount: number;
  stdDevViableCount: number;
}

/** One point on the sweep curve — see C# `LlmBacktestWorker.SweepCurvePoint`. */
export interface SweepCurvePoint {
  knobValue: number;
  totalRecs: number;
  viable: number;
  rejected: number;
  hitRate: number;
  expectedR: number;
  hitTp: number;
  hitSl: number;
  expiredPositive: number;
  expiredNegative: number;
}

/**
 * Aggregated curve for a guard-threshold sweep — embedded inside
 * {@link BacktestRunSummary.sweepCurve} on sweep-mode runs and returned
 * standalone by `GET /llm-backtest/{id}/sweep-curve` via
 * {@link BacktestSweepCurve}.
 */
export interface BacktestSweepCurve {
  knob: GuardKnob;
  defaultValue: number;
  curve: SweepCurvePoint[];
}

export interface LlmBacktestRunSummary {
  id: number;
  name: string;
  createdAt: string;
  createdBy: string | null;
  status: BacktestStatus;
  promptVersion: string;
  modelTier: BacktestModelTier;
  totalPoints: number;
  completedPoints: number;
  cacheHits: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  startedAt: string | null;
  completedAt: string | null;
  note: string | null;
  progress: number | null;

  // Phase 4 dense-index additions — grid scope + outcome rollups projected
  // by the server from GridSpecJson / SummaryJson, so the index doesn't
  // need a per-row fetch to render symbols, mode badges, hit-rate etc.
  symbols: string[];
  timeframes: Timeframe[];
  windowStartUtc: string | null;
  windowEndUtc: string | null;
  dryRun: boolean;
  sweepKnob: string | null;
  sweepValueCount: number | null;
  sampleCount: number | null;
  totalRecommendations: number | null;
  viableCount: number | null;
  rejectedByGateCount: number | null;
  hitRate: number | null;
  expectedR: number | null;
  cacheHitRatio: number | null;
}

export interface LlmBacktestRun extends LlmBacktestRunSummary {
  errorMessage: string | null;
  gridSpec: BacktestGridSpec | null;
  /** Server returns `null` until the worker writes a terminal summary. */
  summary: BacktestRunSummary | null;
  /**
   * Live-aggregated summary computed from already-persisted points,
   * populated by the server on every detail-page fetch while the run is in
   * flight. Bounded to runs with ≤ 500 completed points. Drops to `null`
   * once `summary` is filled. The detail page uses `summary ?? liveSummary`
   * so summary cards / outcomes pie / per-cohort tables update every 5 s
   * during a run.
   */
  liveSummary: BacktestRunSummary | null;
}

export interface ListRunsRequest {
  currentPage?: number;
  itemCountPerPage?: number;
  /** Case-insensitive enum name (e.g. "Running"). */
  statusFilter?: string | null;
}

export interface MarketAnalysisRecommendation {
  action: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;
  rationale: string;
  originalTakeProfit?: number | null;
  orderType?: string | null;
  entryVsMid?: string | null;
  tpToNearestOpposingLevelPips?: number | null;
  slToNearestMagnetPips?: number | null;
  namedOpposingLevel?: string | null;
  namedNearSideMagnet?: string | null;
  acknowledgedWarnings?: string[] | null;
  /** v11 thin-framework — context-aware geometry adjustments applied by
   *  TradeSpecComputer (noise-band SL bumper, liquidity-wall SL push,
   *  reach-aware TP cap, counter-trend TP haircut, post-adjustment TP
   *  re-widen). Empty / null when the LLM's geometry was sound; rendered
   *  as badges on the detail page. */
  appliedAdjustments?: string[] | null;
}

export interface BacktestRejectedRecommendation {
  recommendation: MarketAnalysisRecommendation;
  reasonCode: string;
  reasonDetail: string;
}

export interface BacktestPointOutcome {
  status: string;
  exitPrice: number | null;
  exitAt: string | null;
  fillAt: string | null;
  mfePips: number | null;
  maePips: number | null;
  pnlPips: number | null;
  barsToExit: number | null;
}

export interface LlmBacktestPoint {
  id: number;
  llmBacktestRunId: number;
  symbol: string;
  timeframe: Timeframe;
  asOfUtc: string;
  snapshotHash: string;
  llmInvocationId: number | null;
  backtestLlmCacheId: number | null;
  createdAt: string;
  dryRun: boolean;
  rawRecommendations: MarketAnalysisRecommendation[];
  viable: MarketAnalysisRecommendation[];
  rejected: BacktestRejectedRecommendation[];
  bypassed: BacktestRejectedRecommendation[];
  outcomes: BacktestPointOutcome[];
  /**
   * Phase 3 — JSON-stringified `MultiSampleResult[]`. Populated only on
   * multi-sample runs. Parse with `JSON.parse(...) as MultiSampleResult[]`
   * before iterating; null / undefined on single-sample runs.
   */
  multiSampleResultsJson?: string | null;
  /**
   * Phase 3 — JSON-stringified `MultiSampleStats`. Populated only on
   * multi-sample runs. Parse with `JSON.parse(...) as MultiSampleStats`.
   */
  multiSampleStatsJson?: string | null;
}

export interface GetPointsRequest {
  backtestRunId: number;
  currentPage?: number;
  itemCountPerPage?: number;
  symbolFilter?: string | null;
  outcomeFilter?: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2 — paired-run comparison DTOs. Mirrors
// `CompareLlmBacktestRunsResultDto` + companions in the engine. Convention:
// `left` = baseline, `right` = candidate; deltas are `right - left` so a
// positive delta means the candidate is higher on that metric.
// ──────────────────────────────────────────────────────────────────────────

export interface CompareLlmBacktestRunsRequest {
  leftRunId: number;
  rightRunId: number;
}

/** One side of the comparison header — both metadata + the full summary blob. */
export interface LlmBacktestRunComparisonSide {
  runId: number;
  name: string;
  status: BacktestStatus;
  promptVersion: string;
  modelTier: BacktestModelTier;
  totalPoints: number;
  completedPoints: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  cacheHitRatio: number;
  startedAt: string | null;
  completedAt: string | null;
  summary: BacktestRunSummary | null;
}

/** Right-minus-left deltas on every numeric metric. */
export interface BacktestComparisonDelta {
  totalRecommendationsDelta: number;
  viableCountDelta: number;
  rejectedByGateCountDelta: number;
  bypassedCountDelta: number;
  hitRateDelta: number;
  expectedRDelta: number;
  cacheHitRatioDelta: number;
  actualCostUsdDelta: number;
  hitTpDelta: number;
  hitSlDelta: number;
  expiredPositiveDelta: number;
  expiredNegativeDelta: number;
  expiredFlatDelta: number;
  entryNotReachedDelta: number;
}

/** Per-symbol delta row — only present when BOTH runs have data for the symbol. */
export interface PerSymbolComparison {
  symbol: string;
  leftCount: number;
  rightCount: number;
  leftHitRate: number;
  rightHitRate: number;
  hitRateDelta: number;
  leftExpectedR: number;
  rightExpectedR: number;
  expectedRDelta: number;
}

export interface CompareLlmBacktestRunsResult {
  left: LlmBacktestRunComparisonSide;
  right: LlmBacktestRunComparisonSide;
  delta: BacktestComparisonDelta;
  perSymbol: PerSymbolComparison[];
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2 — per-(Symbol, Timeframe) cost attribution. Cache hits are
// invocations reused from prior runs ($0 incremental cost); cache misses
// are invocations created by THIS run (counted as cost).
// ──────────────────────────────────────────────────────────────────────────

export interface CostAttributionRow {
  symbol: string;
  timeframe: Timeframe;
  pointCount: number;
  llmCalls: number;
  cacheHits: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  costPerPointUsd: number;
}

export interface BacktestCostAttribution {
  runId: number;
  totalPoints: number;
  totalLlmCalls: number;
  totalCacheHits: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheHitRatio: number;
  byPair: CostAttributionRow[];
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 4 — Rolling-window budget guard (P4.1). Sibling of the per-run
// `MaxTokenBudgetUsd` cap — caps cumulative cross-run spend in a rolling
// daily + weekly window so a runaway sweep / multi-sample batch can't burn
// $200+ unintentionally. The launch form fetches the snapshot once on
// init and renders Daily / Weekly progress bars next to the cost estimate.
// ──────────────────────────────────────────────────────────────────────────

/**
 * One rolling-window's spend / cap row. Rendered as a progress bar
 * (green > 30% remaining, amber 10–30%, red < 10%); replaced by a "cap
 * disabled" pill when {@link enabled} is false.
 */
export interface BacktestBudgetWindow {
  spentUsd: number;
  /** Operator-tuned cap. Zero when disabled. */
  capUsd: number;
  /** `capUsd - spentUsd`, floored at 0. Zero when disabled (sentinel). */
  remainingUsd: number;
  /** True when {@link capUsd} > 0 — i.e. the cap is configured. */
  enabled: boolean;
  /** ISO timestamp (UTC). Start of today / start of week. */
  windowStartUtc: string;
  /** ISO timestamp (UTC). Now, at the moment the snapshot was taken. */
  windowEndUtc: string;
}

/**
 * Composite spend / cap snapshot for the daily + weekly rolling windows.
 * Returned by GET /llm-backtest/budget.
 */
export interface BacktestBudgetStatus {
  daily: BacktestBudgetWindow;
  weekly: BacktestBudgetWindow;
}

// ──────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────

/**
 * Data-access client for `/llm-backtest/*`. Mirrors the pattern in
 * `llm.service.ts`: every method returns the raw `ResponseData<T>` envelope so
 * callers can branch on `.status` / `.message` (the existing pages don't use
 * the envelope-unwrapping helper for consistency with the rest of the codebase).
 *
 * Backs four pages:
 *  - llm-backtest-index-page (list + cancel + compare CTA)
 *  - llm-backtest-detail-page (get + points + cancel + cost-attribution + sweep curve)
 *  - llm-backtest-new-page (estimate + create + sweep block)
 *  - llm-backtest-compare-page (Phase 2 — paired run comparison)
 */
@Injectable({ providedIn: 'root' })
export class LlmBacktestService {
  private readonly api = inject(ApiService);

  /** Launch a new run. Returns `{id, totalPoints, estimatedCostUsd}` on success. */
  createRun(
    req: CreateLlmBacktestRunRequest,
  ): Observable<ResponseData<CreateLlmBacktestRunResult>> {
    return this.api.post(`/llm-backtest`, req);
  }

  /** Pre-flight cost preview. Cheap — debounce the launch form's calls to it. */
  estimateCost(req: EstimateBacktestCostRequest): Observable<ResponseData<BacktestCostEstimate>> {
    return this.api.post(`/llm-backtest/estimate-cost`, req);
  }

  /** Single run by id — drives the detail page. */
  getRun(id: number): Observable<ResponseData<LlmBacktestRun>> {
    return this.api.get(`/llm-backtest/${id}`);
  }

  /** Paged list of runs (newest-first). */
  listRuns(req: ListRunsRequest): Observable<ResponseData<PagedData<LlmBacktestRunSummary>>> {
    return this.api.post(`/llm-backtest/list`, req);
  }

  /** Paged per-point drill-down inside a run. */
  getPoints(req: GetPointsRequest): Observable<ResponseData<PagedData<LlmBacktestPoint>>> {
    return this.api.post(`/llm-backtest/points`, req);
  }

  /** Cancel a Pending/Running run. Idempotent server-side. */
  cancelRun(id: number): Observable<ResponseData<boolean>> {
    return this.api.post(`/llm-backtest/${id}/cancel`, {});
  }

  // ── Phase 2 endpoints ────────────────────────────────────────────────────

  /**
   * Paired side-by-side comparison of two completed runs.
   * Server returns deltas as `right - left`; the compare page picks colour
   * + arrow direction per metric (HitRate/ExpectedR up = good, HitSL/Cost
   * down = good).
   */
  compareRuns(
    req: CompareLlmBacktestRunsRequest,
  ): Observable<ResponseData<CompareLlmBacktestRunsResult>> {
    return this.api.post(`/llm-backtest/compare`, req);
  }

  /** Per-(Symbol, Timeframe) LLM spend attribution for a single run. */
  getCostAttribution(runId: number): Observable<ResponseData<BacktestCostAttribution>> {
    return this.api.get(`/llm-backtest/${runId}/cost-attribution`);
  }

  /**
   * Standalone sweep curve fetch. The run's summary already includes
   * `summary.sweepCurve`; this endpoint is the recommended way to pull
   * the curve because it surfaces specific 4xx codes when the run is
   * still in progress / not a sweep, rather than silently returning null.
   */
  getSweepCurve(runId: number): Observable<ResponseData<BacktestSweepCurve>> {
    return this.api.get(`/llm-backtest/${runId}/sweep-curve`);
  }

  /**
   * Phase 4 — Rolling-window backtest spend status. Drives the launch
   * form's "Remaining budget" panel. Both windows share the same DTO
   * shape; the form renders two rows (Daily, Weekly).
   */
  getBudgetStatus(): Observable<ResponseData<BacktestBudgetStatus>> {
    return this.api.get(`/llm-backtest/budget`);
  }

  /**
   * Replay this completed run's viable recommendations through a TP/SL
   * sensitivity sweep. Response is the SAME DTO the live signal-sensitivity
   * page consumes (heatmap + cohort breakdowns + hold-time / R-multiple
   * distributions + streaks + risk metrics + per-rec detail), so the
   * backtest detail card reuses those rendering components.
   *
   * P&L on the response is in PIPS, not currency — backtest replays don't
   * carry lot sizing, so values are pip-normalized for cross-pair
   * comparability.
   */
  analyzeSensitivity(
    runId: number,
    request: AnalyzeBacktestSensitivityRequest = {},
  ): Observable<ResponseData<AnalyzeSignalSensitivityResultDto>> {
    return this.api.post(`/llm-backtest/${runId}/sensitivity-analysis`, request);
  }
}
