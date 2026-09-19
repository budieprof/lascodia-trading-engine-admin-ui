/**
 * TradingView resolution ↔ engine timeframe mapping.
 *
 * The engine's `Timeframe` enum stores exactly six values — M1, M5, M15, H1,
 * H4, D1 — and `GetCandlesQueryHandler` answers anything else with responseCode
 * `-11` ("not stored by the engine"). TradingView's resolution vocabulary is
 * wider, so every resolution we advertise must either map to a stored timeframe
 * or be built by aggregating one (see `aggregate.ts`).
 *
 * Getting this wrong is not a visible error: the library asks for a resolution,
 * `getBars` returns nothing useful, and the chart spins forever. So the rule is
 * that `SUPPORTED_RESOLUTIONS` is DERIVED from this table rather than written
 * out by hand — a resolution cannot be offered unless it has a source here.
 */

/** The six timeframes the engine actually persists. */
export type EngineTimeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

/** A TradingView resolution string, e.g. `1`, `60`, `1D`, `1W`. */
export type TvResolution = string;

export interface ResolutionSource {
  /** The stored timeframe to fetch. */
  timeframe: EngineTimeframe;
  /**
   * How many source bars make one target bar, or `'week'` / `'month'` for
   * calendar buckets whose width is not a fixed multiple.
   */
  aggregate: number | 'week' | 'month';
}

/**
 * Every resolution the chart may offer, and where its bars come from.
 *
 * `aggregate: 1` means "served directly by the engine". Anything else is built
 * client-side from the named timeframe. The aggregation sources are deliberately
 * the CLOSEST stored timeframe (M30 from M15, not from M1) so a wide window
 * ships the fewest rows.
 */
export const RESOLUTION_SOURCES: Readonly<Record<TvResolution, ResolutionSource>> = {
  '1': { timeframe: 'M1', aggregate: 1 },
  '5': { timeframe: 'M5', aggregate: 1 },
  '15': { timeframe: 'M15', aggregate: 1 },
  '30': { timeframe: 'M15', aggregate: 2 },
  '60': { timeframe: 'H1', aggregate: 1 },
  '240': { timeframe: 'H4', aggregate: 1 },
  '1D': { timeframe: 'D1', aggregate: 1 },
  '1W': { timeframe: 'D1', aggregate: 'week' },
  '1M': { timeframe: 'D1', aggregate: 'month' },
} as const;

/** Resolutions to hand the library in `onReady`. Derived — never hand-written. */
export const SUPPORTED_RESOLUTIONS: readonly TvResolution[] = Object.keys(
  RESOLUTION_SOURCES,
) as TvResolution[];

export function resolutionSource(resolution: TvResolution): ResolutionSource | null {
  return RESOLUTION_SOURCES[resolution] ?? null;
}

export function isSupportedResolution(resolution: TvResolution): boolean {
  return resolution in RESOLUTION_SOURCES;
}

/** Milliseconds per bar for the stored timeframes. */
const TIMEFRAME_MS: Readonly<Record<EngineTimeframe, number>> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

export function timeframeMs(timeframe: EngineTimeframe): number {
  return TIMEFRAME_MS[timeframe];
}

/**
 * Width of one bar at `resolution`, in ms.
 *
 * Week and month are not fixed widths; callers that need to size a fetch window
 * should use the approximations here and then over-fetch rather than assume the
 * arithmetic is exact. `null` means "not a fixed width" for callers that care.
 */
export function resolutionMs(resolution: TvResolution): number | null {
  const src = resolutionSource(resolution);
  if (!src) return null;
  if (src.aggregate === 'week') return 7 * TIMEFRAME_MS.D1;
  if (src.aggregate === 'month') return 31 * TIMEFRAME_MS.D1;
  return TIMEFRAME_MS[src.timeframe] * src.aggregate;
}

/**
 * How many SOURCE bars are needed to build `count` bars at `resolution`.
 *
 * Over-estimates for the calendar buckets on purpose: a month needs at most 31
 * daily bars and a week at most 7, and asking for a few rows too many costs one
 * page while asking for too few costs a visible short chart.
 */
export function sourceBarsNeeded(resolution: TvResolution, count: number): number {
  const src = resolutionSource(resolution);
  if (!src) return count;
  if (src.aggregate === 'week') return count * 7;
  if (src.aggregate === 'month') return count * 31;
  return count * src.aggregate;
}
