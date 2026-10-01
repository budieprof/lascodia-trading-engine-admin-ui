/**
 * Performance tiles and seasonals — pure maths over DAILY bars (ascending,
 * `time` = bar open in ms UTC). Kept out of the components so they are tested
 * directly.
 */

export interface DailyBar {
  time: number;
  open: number;
  close: number;
}

export type PerformancePeriod = '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y';

export interface PerformanceTile {
  period: PerformancePeriod;
  /** % change from the reference close to the latest close; null when history does not reach back. */
  pct: number | null;
  /** Time (ms) of the reference bar used, for the tooltip. */
  fromTime: number | null;
}

export const PERFORMANCE_PERIODS: readonly PerformancePeriod[] = ['1W', '1M', '3M', '6M', 'YTD', '1Y'];

/** Calendar anchor for a period, relative to `t` (ms UTC). */
export function periodAnchor(period: PerformancePeriod, t: number): number {
  const d = new Date(t);
  switch (period) {
    case '1W':
      return t - 7 * 86_400_000;
    case '1M':
    case '3M':
    case '6M':
    case '1Y': {
      const months = period === '1M' ? 1 : period === '3M' ? 3 : period === '6M' ? 6 : 12;
      const a = new Date(d);
      a.setUTCMonth(a.getUTCMonth() - months);
      return a.getTime();
    }
    case 'YTD':
      // The last close of the previous year: any bar opening before Jan 1.
      return Date.UTC(d.getUTCFullYear(), 0, 1) - 1;
  }
}

/** Index of the last bar whose open is at or before `t`; -1 when none. Bars ascending. */
export function lastIndexAtOrBefore(bars: readonly DailyBar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function pctChange(from: number, to: number): number | null {
  return Number.isFinite(from) && Number.isFinite(to) && from !== 0 ? ((to - from) / from) * 100 : null;
}

/**
 * The six TradingView-style tiles. The latest bar's close is "now"; each tile
 * compares it with the close of the last bar at or before the period's anchor.
 * A period whose anchor predates the first bar is null (never the change since
 * the first bar — that would mislabel a shorter span as the full period).
 */
export function performanceTiles(bars: readonly DailyBar[]): PerformanceTile[] {
  if (bars.length === 0) return PERFORMANCE_PERIODS.map((period) => ({ period, pct: null, fromTime: null }));
  const latest = bars[bars.length - 1];
  return PERFORMANCE_PERIODS.map((period) => {
    const anchor = periodAnchor(period, latest.time);
    if (anchor < bars[0].time) return { period, pct: null, fromTime: null };
    const i = lastIndexAtOrBefore(bars, anchor);
    if (i < 0 || i === bars.length - 1) return { period, pct: null, fromTime: null };
    return { period, pct: pctChange(bars[i].close, latest.close), fromTime: bars[i].time };
  });
}

// ── Seasonals ───────────────────────────────────────────────────────────────

export interface SeasonalPoint {
  /** Day of year, 0-based (Jan 1 = 0), UTC. */
  day: number;
  /** Cumulative % change since the year's base close. */
  pct: number;
}

export interface SeasonalYear {
  year: number;
  points: SeasonalPoint[];
}

export function dayOfYear(t: number): number {
  const d = new Date(t);
  return Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
}

/**
 * Year-over-year cumulative % lines, aligned on day-of-year so years overlay.
 * Each year's base is the previous year's last close when the data holds it,
 * else the year's first open. Returns the latest year and `priorYears` before
 * it, newest first; years without bars are omitted.
 */
export function seasonalYears(bars: readonly DailyBar[], priorYears = 2): SeasonalYear[] {
  if (bars.length === 0) return [];
  const latestYear = new Date(bars[bars.length - 1].time).getUTCFullYear();
  const out: SeasonalYear[] = [];
  for (let year = latestYear; year >= latestYear - priorYears; year--) {
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const inYear = bars.filter((b) => b.time >= start && b.time < end);
    if (inYear.length === 0) continue;
    const prevIdx = lastIndexAtOrBefore(bars, start - 1);
    const base = prevIdx >= 0 ? bars[prevIdx].close : inYear[0].open;
    const points: SeasonalPoint[] = [];
    for (const b of inYear) {
      const pct = pctChange(base, b.close);
      if (pct !== null) points.push({ day: dayOfYear(b.time), pct });
    }
    out.push({ year, points });
  }
  return out;
}
