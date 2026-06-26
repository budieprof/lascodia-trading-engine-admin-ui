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
};
