/**
 * Spread-reactive subsystem: opt-in stop-loss widening per
 * `(TradingAccount, Symbol)` when broker spread spikes (NY close, news,
 * weekend gaps).  All knobs are hot-reloadable EngineConfig keys —
 * changes take effect on the worker's next tick (≤ LoopIntervalSeconds).
 */
export interface SpreadReactiveConfig {
  /** Master switch.  Off → worker observes spread but takes no bump/revert action. */
  enabled: boolean;
  /** Rolling-window size (minutes) used as the spread-baseline horizon. */
  baselineWindowMinutes: number;
  /** Minimum samples in the window before condition classification starts. */
  minSamplesBeforeTrigger: number;
  /** Multiple of baseline at which the condition flips to Elevated. */
  spreadMultiplier: number;
  /** Multiple of current spread used as the SL widening amount (in price units). */
  cushionMultiplier: number;
  /** Multiple of baseline at or below which a sample counts as "calm" for revert hysteresis. */
  revertRatio: number;
  /** Number of consecutive calm samples required before the worker reverts an active bump. */
  consecutiveCalmSamplesToRevert: number;
  /** Hard cap on the bump distance, expressed in pips (converted to price units via CurrencyPair.PipSize). */
  maxBumpDistancePips: number;
  /** Telemetry freshness floor.  Older-than-this → pair is "stale", bumps freeze in place. */
  telemetryFreshnessSeconds: number;
  /** Worker tick interval (seconds). */
  loopIntervalSeconds: number;
  /** Master switch for auto-capture of persistent floor baselines. */
  floorAutoCaptureEnabled: boolean;
  /** Consecutive calm samples required before a floor is captured / lower candidate staged. */
  floorMinCalmSamplesToCapture: number;
  /** Minutes a lower candidate must hold before being promoted to the active floor. */
  floorPromotionWindowMinutes: number;
  /** Master switch for the daily pre-emptive SL-widening pass. */
  preEmptiveEnabled: boolean;
  /** UTC hour (0-23) at which the daily pre-emption fires. 20 = 9pm WAT. */
  preEmptiveTriggerHourUtc: number;
  /** Hours a pre-emptive bump is immune from the normal hysteresis revert. */
  preEmptiveProtectionHours: number;
}

/** Coarse classification of the current spread state for an account+symbol. */
export type SpreadCondition = 'Warming' | 'Normal' | 'Elevated';

/**
 * Snapshot of the live spread state for one `(TradingAccount, Symbol)`
 * pair.  Returned by `/spread-reactive/state` — in-memory on the engine,
 * cheap to poll.
 */
export interface SpreadStateEntry {
  tradingAccountId: number;
  symbol: string;
  currentSpread: number;
  baseline: number;
  sampleCount: number;
  condition: SpreadCondition;
  /** ISO timestamp of the most recent observation. */
  lastSampleAt: string;
  /** ISO timestamp the condition last flipped to Elevated; null if never. */
  lastTriggerAt: string | null;
  /** ISO timestamp the condition last returned to Normal; null if never. */
  lastNormalAt: string | null;
  /** Run-length of samples currently satisfying the revert ratio. */
  consecutiveCalmSamples: number;
  /** Persistent floor value used for classification — null when no floor yet (pair stands down). */
  floorBaseline: number | null;
  floorSource: 'AutoCapture' | 'OperatorOverride' | null;
  floorObservedAt: string | null;
  sampleCountAtFloor: number | null;
  lowerCandidate: number | null;
  lowerCandidateObservedAt: string | null;
}

/**
 * Persistent floor-baseline row.  One per `(TradingAccount, Symbol)` pair.
 * The floor is the immutable anchor the worker uses for Elevated/Normal
 * classification — its persistence is what protects against the rolling-
 * median drift problem during long spread regimes and weekend reopens.
 */
export interface SpreadBaselineFloor {
  id: number;
  tradingAccountId: number;
  symbol: string;
  floorBaseline: number;
  floorObservedAt: string;
  sampleCountAtFloor: number;
  lowerCandidate: number | null;
  lowerCandidateObservedAt: string | null;
  lastUpdatedAt: string;
  source: 'AutoCapture' | 'OperatorOverride';
  setByAdminUserId: number | null;
  setByAdminUsername: string | null;
  note: string | null;
}

/** Body for `PUT /spread-reactive/floors` — operator override upsert. */
export interface UpsertSpreadBaselineFloorRequest {
  tradingAccountId: number;
  symbol: string;
  floorBaseline: number;
  note?: string | null;
}

/** Sensible defaults — match the engine's worker defaults. */
export const DEFAULT_SPREAD_REACTIVE_CONFIG: SpreadReactiveConfig = {
  enabled: false,
  baselineWindowMinutes: 60,
  minSamplesBeforeTrigger: 30,
  spreadMultiplier: 3.0,
  cushionMultiplier: 3.0,
  revertRatio: 1.5,
  consecutiveCalmSamplesToRevert: 10,
  maxBumpDistancePips: 30,
  telemetryFreshnessSeconds: 120,
  loopIntervalSeconds: 10,
  floorAutoCaptureEnabled: true,
  floorMinCalmSamplesToCapture: 30,
  floorPromotionWindowMinutes: 60,
  preEmptiveEnabled: false,
  preEmptiveTriggerHourUtc: 20,
  preEmptiveProtectionHours: 4,
};
