/**
 * TradingView resolution ↔ where the chart's bars come from.
 *
 * Two sources:
 *
 * - **stored** — `market-data/candle/list`. The engine's `Timeframe` enum stores exactly six
 *   values — M1, M5, M15, H1, H4, D1 — and `GetCandlesQueryHandler` answers anything else with
 *   responseCode `-11` ("not stored by the engine"). These sit on the UTC epoch grid, which up to an
 *   hour is also the FX session grid (17:00 New York is 21:00 or 22:00 UTC, an hour edge either way),
 *   so 1m … 1h — and 30m folded from M15 (`aggregate.ts`) — are the bars a Pine run computes on.
 * - **session** — `scripting/chart-bars`. 2h, 4h, 1D, 1W and 1M are NOT on the UTC grid: the engine
 *   lays them out on the symbol's session (FX: days roll at 17:00 New York, weeks are Monday–Friday
 *   sessions, DST moves every UTC open, the weekend leaves a gap). Its stored H4 and D1 roll at UTC
 *   midnight, so drawn from those the chart's bars sat on a different grid from the bars its scripts
 *   run on — and the scripts' outputs, placed by bar time, found no bar to sit on. Every bar from
 *   this source carries its own close, so the client never works out where one of these periods
 *   starts or ends.
 *
 * Getting this wrong is not a visible error: the library asks for a resolution, `getBars` returns
 * nothing useful, and the chart spins forever. So the rule is that `SUPPORTED_RESOLUTIONS` is DERIVED
 * from this table rather than written out by hand — a resolution cannot be offered unless it has a
 * source here.
 */

/** The six timeframes the engine actually persists. */
export type EngineTimeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

/** A TradingView resolution string, e.g. `1`, `60`, `1D`, `1W`. */
export type TvResolution = string;

export type ResolutionSource =
  | {
      kind: 'stored';
      /** The stored timeframe to fetch. */
      timeframe: EngineTimeframe;
      /** How many source bars make one target bar; 1 = served as stored. */
      aggregate: number;
    }
  | {
      kind: 'session';
      /**
       * The nominal width of one bar, for sizing a window or a step — never for placing a bar: the
       * session grid's periods are not fixed widths (DST, weekends, months).
       */
      nominalMs: number;
    };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Every resolution the chart may offer, and where its bars come from. The aggregation source is
 * deliberately the CLOSEST stored timeframe (M30 from M15, not from M1) so a wide window ships the
 * fewest rows.
 */
export const RESOLUTION_SOURCES: Readonly<Record<TvResolution, ResolutionSource>> = {
  '1': { kind: 'stored', timeframe: 'M1', aggregate: 1 },
  '5': { kind: 'stored', timeframe: 'M5', aggregate: 1 },
  '15': { kind: 'stored', timeframe: 'M15', aggregate: 1 },
  '30': { kind: 'stored', timeframe: 'M15', aggregate: 2 },
  '60': { kind: 'stored', timeframe: 'H1', aggregate: 1 },
  '120': { kind: 'session', nominalMs: 2 * HOUR },
  '240': { kind: 'session', nominalMs: 4 * HOUR },
  '1D': { kind: 'session', nominalMs: DAY },
  '1W': { kind: 'session', nominalMs: 7 * DAY },
  '1M': { kind: 'session', nominalMs: 31 * DAY },
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

/** Whether `resolution`'s bars come from the engine's session grid (`scripting/chart-bars`). */
export function isSessionResolution(resolution: TvResolution): boolean {
  return resolutionSource(resolution)?.kind === 'session';
}

/** Milliseconds per bar for the stored timeframes. */
const TIMEFRAME_MS: Readonly<Record<EngineTimeframe, number>> = {
  M1: MINUTE,
  M5: 5 * MINUTE,
  M15: 15 * MINUTE,
  H1: HOUR,
  H4: 4 * HOUR,
  D1: DAY,
};

export function timeframeMs(timeframe: EngineTimeframe): number {
  return TIMEFRAME_MS[timeframe];
}

/**
 * Width of one bar at `resolution`, in ms — exact on the stored grid, nominal on the session grid
 * (a month as 31 days). Callers that size a fetch window or a pan with it over-fetch rather than
 * assume the arithmetic is exact; nothing may place a bar with it. `null` for an unknown resolution.
 */
export function resolutionMs(resolution: TvResolution): number | null {
  const src = resolutionSource(resolution);
  if (!src) return null;
  return src.kind === 'session' ? src.nominalMs : TIMEFRAME_MS[src.timeframe] * src.aggregate;
}

/**
 * How many SOURCE rows are needed to build `count` bars at `resolution`: the aggregation factor on
 * the stored grid; the session grid's bars come built, one per bar.
 */
export function sourceBarsNeeded(resolution: TvResolution, count: number): number {
  const src = resolutionSource(resolution);
  if (!src || src.kind === 'session') return count;
  return count * src.aggregate;
}
