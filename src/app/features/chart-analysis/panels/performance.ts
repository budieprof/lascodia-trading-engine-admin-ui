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

export const PERFORMANCE_PERIODS: readonly PerformancePeriod[] = [
  '1W',
  '1M',
  '3M',
  '6M',
  'YTD',
  '1Y',
];

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
  return Number.isFinite(from) && Number.isFinite(to) && from !== 0
    ? ((to - from) / from) * 100
    : null;
}

/**
 * The six TradingView-style tiles. The latest bar's close is "now"; each tile
 * compares it with the close of the last bar at or before the period's anchor.
 * A period whose anchor predates the first bar is null (never the change since
 * the first bar — that would mislabel a shorter span as the full period).
 */
export function performanceTiles(bars: readonly DailyBar[]): PerformanceTile[] {
  if (bars.length === 0)
    return PERFORMANCE_PERIODS.map((period) => ({ period, pct: null, fromTime: null }));
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
 * The calendar date's place on a 365-day axis (UA04): 1 March is day 59 every year. A leap year's 29 February shares
 * 28 February's slot and every later day moves back one — `dayOfYear` put a leap year a day ahead of every other year
 * from March on (and its 31 December at 365, off the axis).
 */
export function seasonalDay(t: number): number {
  const day = dayOfYear(t);
  const year = new Date(t).getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap && day >= 59 ? day - 1 : day;
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
  // UA04: each year's bars found by binary search and read once — it filtered the whole history per year.
  for (let year = latestYear; year >= latestYear - priorYears; year--) {
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const prevIdx = lastIndexAtOrBefore(bars, start - 1);
    const first = prevIdx + 1;
    if (first >= bars.length || bars[first].time >= end) continue;
    const base = prevIdx >= 0 ? bars[prevIdx].close : bars[first].open;
    const points: SeasonalPoint[] = [];
    for (let i = first; i < bars.length && bars[i].time < end; i++) {
      const pct = pctChange(base, bars[i].close);
      if (pct !== null) points.push({ day: seasonalDay(bars[i].time), pct });
    }
    out.push({ year, points });
  }
  return out;
}

/** The year history starts in (the oldest bar's), or null without bars. */
export function firstYearOf(bars: readonly DailyBar[]): number | null {
  return bars.length ? new Date(bars[0].time).getUTCFullYear() : null;
}

/**
 * The year ranges worth offering (UA04): those the history covers (`3 years` needs four years of bars: three prior
 * and the current), then "All" labelled with the year it starts — never "All (2011+)" on a symbol with ten days. `all`
 * is how many prior years "All" asks for.
 */
export function seasonalRanges(
  latestYear: number | null,
  firstYear: number | null,
  all = 30,
): { years: number; label: string }[] {
  const out = [3, 5, 10]
    .filter((y) => latestYear === null || firstYear === null || latestYear - firstYear >= y)
    .map((years) => ({ years, label: `${years} years` }));
  out.push({ years: all, label: firstYear !== null ? `All (${firstYear}+)` : 'All' });
  return out;
}

/**
 * Seasonal line colours by age, TradingView's: the current year blue, then
 * green, orange, cyan, crimson, amber… Keyed on age, not year, so "last year"
 * is always green in both the panel and the full view.
 */
export const SEASONAL_COLORS = [
  '#2962ff',
  '#4caf50',
  '#ff9800',
  '#00bcd4',
  '#e91e63',
  '#fbc02d',
  '#9c27b0',
  '#795548',
  '#607d8b',
  '#3f51b5',
  '#009688',
  '#f44336',
  '#8bc34a',
  '#ff5722',
  '#00acc1',
  '#ad1457',
];

export function seasonalColor(latestYear: number, year: number): string {
  const age = Math.max(0, latestYear - year);
  return SEASONAL_COLORS[age % SEASONAL_COLORS.length];
}

/** A year's cumulative % on `day`: its last point at or before that day, or null before its first. */
export function pctOnDay(yr: SeasonalYear, day: number): number | null {
  let out: number | null = null;
  for (const p of yr.points) {
    if (p.day > day) break;
    out = p.pct;
  }
  return out;
}

/**
 * The average path of `years` (TradingView's "Average"): for each day, the mean
 * of every year's cumulative % on that day. Days before every year has a point
 * are skipped, so the line never averages a partial set.
 */
export function seasonalAverage(years: readonly SeasonalYear[]): SeasonalPoint[] {
  if (!years.length) return [];
  const out: SeasonalPoint[] = [];
  for (let day = 0; day <= 365; day++) {
    const vals = years.map((y) => pctOnDay(y, day));
    if (vals.some((v) => v === null)) continue;
    out.push({ day, pct: (vals as number[]).reduce((a, b) => a + b, 0) / vals.length });
  }
  return out;
}
