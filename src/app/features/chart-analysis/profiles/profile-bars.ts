/**
 * Which bars the profiles are built from (DR-I7 / DR-20).
 *
 * A volume profile spreads each bar's volume evenly over the bar's range, so its resolution is the bars': on H1 a
 * profile knows only that an hour's volume traded somewhere between its high and low. TradingView builds its profiles
 * from a LOWER timeframe for that reason; so does this chart. TPO needs it outright: a letter is one bracket (30
 * minutes) of trading, and an H1 bar cannot say which of its two brackets reached a price.
 *
 * Pure: no Angular; unit-tested directly.
 */
import { resolutionMs, type TvResolution } from '../datafeed/resolution';

/** The finer timeframes profiles can load, finest first. */
const CANDIDATES: readonly TvResolution[] = [
  '1',
  '5',
  '15',
  '30',
  '60',
  '240',
  '1D',
] as TvResolution[];

/** Most lower-timeframe bars one chart window loads (≈ 6 MB of bars; a few requests). */
export const PROFILE_BAR_BUDGET = 30_000;

/**
 * The lower timeframe to profile a chart window with: the finest one at least `minPerBar` times finer than the chart
 * whose bars over `spanMs` stay within `budget` — and, for TPO, no wider than its bracket. Null when there is none
 * (a 1-minute chart, or a window too long for anything finer): the profiles then use the chart's own bars.
 */
export function profileResolutionFor(
  chart: TvResolution,
  spanMs: number,
  opts: { budget?: number; maxMs?: number; minPerBar?: number } = {},
): TvResolution | null {
  const chartMs = resolutionMs(chart);
  if (!chartMs || !Number.isFinite(spanMs) || spanMs <= 0) return null;
  const budget = opts.budget ?? PROFILE_BAR_BUDGET;
  const perBar = opts.minPerBar ?? 4;
  for (const r of CANDIDATES) {
    const ms = resolutionMs(r);
    if (!ms || ms * perBar > chartMs) continue;
    if (opts.maxMs !== undefined && ms > opts.maxMs) continue;
    if (spanMs / ms <= budget) return r;
  }
  return null;
}

/**
 * Lower-timeframe bars up to where they end, then the chart's own bars after that — the bar still forming and any
 * closed since the finer ones were loaded — so the profile always reaches the last bar (coarsely at the very end,
 * until the next refresh) instead of stopping short of it.
 */
export function withChartTail<T extends { time: number }>(
  lower: readonly T[],
  chart: readonly T[],
): T[] {
  if (!lower.length) return [...chart];
  const coveredUntil = lower[lower.length - 1].time;
  // Chart bars that open after the last finer bar: the finer bars cover none of them.
  const tail = chart.filter((b) => b.time > coveredUntil);
  return tail.length ? [...lower, ...tail] : [...lower];
}

/**
 * A range of CHART bar indices (the time scale's visible logical range) → the same stretch of time as indices into
 * the finer `lower` bars: from the first visible chart bar's open to the last one's close.
 */
export function timeRangeIndices(
  lower: readonly { time: number }[],
  chart: readonly { time: number }[],
  range: { from: number; to: number },
): { from: number; to: number } {
  if (!chart.length || !lower.length) return { from: 0, to: -1 };
  const clamp = (i: number) => Math.max(0, Math.min(chart.length - 1, i));
  const t0 = chart[clamp(Math.floor(range.from))].time;
  const last = clamp(Math.ceil(range.to));
  const t1 = last + 1 < chart.length ? chart[last + 1].time : Number.POSITIVE_INFINITY;
  let from = lower.findIndex((b) => b.time >= t0);
  if (from < 0) from = lower.length;
  let to = lower.length - 1;
  while (to >= 0 && lower[to].time >= t1) to--;
  return { from, to };
}
