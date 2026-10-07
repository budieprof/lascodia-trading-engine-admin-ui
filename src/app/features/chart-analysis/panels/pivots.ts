/**
 * Pivot points as TradingView's Technicals page shows them: five methods, R3…S3,
 * computed from the PREVIOUS completed period's high / low / close.
 *
 * The formulas were checked against a TradingView screenshot (EURUSD, 1 day,
 * 2026-10-04): every one of its 27 printed levels reproduces to the fifth
 * decimal from one set of inputs — see panels.spec.ts. Two details that only
 * fall out of that check:
 * - Woodie's pivot uses the CURRENT period's open, (H + L + 2·Ocur) / 4, not the
 *   previous close. In FX the two differ by a pip or two, which is exactly the
 *   size of the error a close-based Woodie shows.
 * - DM picks its X by the previous period's close against its OPEN.
 *
 * The periods themselves are the engine's (`scripting/chart-bars`): session days that roll at 17:00
 * New York — where TradingView, and the FX market, end a day — Monday–Friday weeks and calendar
 * months of trading days, each bar with its own open and close. Nothing here works out where a
 * period starts or ends; years are the engine's months grouped by the year they close in.
 *
 * Pure: no Angular, unit-tested directly.
 */
import { tradingDayMs } from '../datafeed/session-bars';
import type { Ohlc } from '../indicators/math';

export type PivotPeriod = 'day' | 'week' | 'month' | 'year';
export type PivotMethod = 'classic' | 'fibonacci' | 'camarilla' | 'woodie' | 'dm';

export const PIVOT_METHODS: readonly { id: PivotMethod; label: string }[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'fibonacci', label: 'Fibonacci' },
  { id: 'camarilla', label: 'Camarilla' },
  { id: 'woodie', label: 'Woodie' },
  { id: 'dm', label: 'DM' },
];

export const PIVOT_ROWS = ['R3', 'R2', 'R1', 'P', 'S1', 'S2', 'S3'] as const;
export type PivotRow = (typeof PIVOT_ROWS)[number];
/** One method's levels; DM defines only R1, P and S1, the rest are null. */
export type PivotLevels = Record<PivotRow, number | null>;

export interface PeriodHloc {
  /** The period's open, UTC ms. */
  start: number;
  /** The period's exclusive close, UTC ms, when the engine sent one. */
  closeTime?: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** One period of the pivots' timeframe as the engine built it: a session day, a week, a month, a year. */
export interface PeriodBar extends Ohlc {
  /** The period's exclusive close (`scripting/chart-bars` `tc`). */
  closeTime?: number;
}

/**
 * The pivot period for a chart resolution — TradingView's "Auto" rule: up to
 * 15 minutes uses daily pivots, anything else intraday weekly, daily bars
 * monthly, and weekly / monthly bars yearly.
 */
export function pivotPeriodFor(resolution: string): PivotPeriod {
  if (resolution === '1D') return 'month';
  if (resolution === '1W' || resolution === '1M') return 'year';
  const minutes = Number(resolution);
  return Number.isFinite(minutes) && minutes <= 15 ? 'day' : 'week';
}

/**
 * The engine's months folded into years — the one period the engine has no timeframe for. A month
 * belongs to the year it closes in (its trading days' year): January's bar opens on the evening of
 * 31 December, and by its open it would land in the year before.
 */
export function yearBars(months: readonly PeriodBar[]): PeriodBar[] {
  const out: PeriodBar[] = [];
  let year: number | null = null;
  for (const m of months) {
    const y = new Date(tradingDayMs(m)).getUTCFullYear();
    const tail = out[out.length - 1];
    if (tail && y === year) {
      tail.high = Math.max(tail.high, m.high);
      tail.low = Math.min(tail.low, m.low);
      tail.close = m.close;
      tail.volume += m.volume;
      tail.closeTime = m.closeTime;
    } else {
      year = y;
      out.push({ ...m });
    }
  }
  return out;
}

/** The engine's bars for the pivots of `period`: its days, weeks and months; years folded from the months. */
export function pivotPeriodBars(
  period: PivotPeriod,
  bars: {
    daily: readonly PeriodBar[];
    weekly: readonly PeriodBar[];
    monthly: readonly PeriodBar[];
  },
): readonly PeriodBar[] {
  switch (period) {
    case 'day':
      return bars.daily;
    case 'week':
      return bars.weekly;
    case 'month':
      return bars.monthly;
    case 'year':
      return yearBars(bars.monthly);
  }
}

/**
 * The completed period before the one containing `refMs`, and the open of the one containing it
 * (Woodie needs it; null when `refMs` is past the newest period's close — no bar of the current
 * period yet).
 *
 * `periods` are the pivot period's own bars, ascending (`pivotPeriodBars`). "The period containing
 * `refMs`" is the period of the newest bar on screen, so over a weekend the daily pivots are
 * Thursday's — what TradingView shows for Friday's session — and the monthly pivots in early October
 * are September's. The chart's bars and these are on the same grid, so a period opens with its
 * first chart bar: `refMs` at a period's open is in that period.
 */
export function pivotInputs(
  periods: readonly PeriodBar[],
  refMs: number,
): { prev: PeriodHloc; currentOpen: number | null } | null {
  // The newest period opening at or before refMs.
  let i = -1;
  for (let k = periods.length - 1; k >= 0; k--) {
    if (periods[k].time <= refMs) {
      i = k;
      break;
    }
  }
  if (i < 0) return null;
  const at = periods[i];
  const containsRef = at.closeTime === undefined || refMs < at.closeTime;
  const prevBar = containsRef ? periods[i - 1] : at;
  if (!prevBar) return null;
  const prev: PeriodHloc = {
    start: prevBar.time,
    open: prevBar.open,
    high: prevBar.high,
    low: prevBar.low,
    close: prevBar.close,
  };
  if (prevBar.closeTime !== undefined) prev.closeTime = prevBar.closeTime;
  return { prev, currentOpen: containsRef ? at.open : null };
}

/** All five methods' levels for one previous period. `currentOpen` null → Woodie falls back to the close. */
export function pivotLevels(
  prev: PeriodHloc,
  currentOpen: number | null,
): Record<PivotMethod, PivotLevels> {
  const { open: o, high: h, low: l, close: c } = prev;
  const r = h - l;
  const p = (h + l + c) / 3;
  const w = (h + l + 2 * (currentOpen ?? c)) / 4;
  const x = c < o ? h + 2 * l + c : c > o ? 2 * h + l + c : h + l + 2 * c;
  return {
    classic: {
      R3: p + 2 * r,
      R2: p + r,
      R1: 2 * p - l,
      P: p,
      S1: 2 * p - h,
      S2: p - r,
      S3: p - 2 * r,
    },
    fibonacci: {
      R3: p + r,
      R2: p + 0.618 * r,
      R1: p + 0.382 * r,
      P: p,
      S1: p - 0.382 * r,
      S2: p - 0.618 * r,
      S3: p - r,
    },
    camarilla: {
      R3: c + (r * 1.1) / 4,
      R2: c + (r * 1.1) / 6,
      R1: c + (r * 1.1) / 12,
      P: p,
      S1: c - (r * 1.1) / 12,
      S2: c - (r * 1.1) / 6,
      S3: c - (r * 1.1) / 4,
    },
    woodie: {
      R3: h + 2 * (w - l),
      R2: w + r,
      R1: 2 * w - l,
      P: w,
      S1: 2 * w - h,
      S2: w - r,
      S3: l - 2 * (h - w),
    },
    dm: { R3: null, R2: null, R1: x / 2 - l, P: x / 4, S1: x / 2 - h, S2: null, S3: null },
  };
}

/**
 * For one method, the nearest level above `price` and the nearest at or below
 * it — the resistance and support the price is trading between.
 */
export function bracket(
  levels: PivotLevels,
  price: number,
): { above: PivotRow | null; below: PivotRow | null } {
  let above: PivotRow | null = null;
  let below: PivotRow | null = null;
  for (const row of PIVOT_ROWS) {
    const v = levels[row];
    if (v === null) continue;
    if (v > price && (above === null || v < levels[above]!)) above = row;
    if (v <= price && (below === null || v > levels[below]!)) below = row;
  }
  return { above, below };
}

/**
 * Human label for the period the pivots came from, e.g. "Thu 1 Oct", "week of 27 Sep",
 * "September 2026". Days, months and years are named by the trading day they close on — Thursday's
 * session opens on Wednesday evening, September's on the last evening of August; a week by the date
 * it opens (Sunday's evening session).
 */
export function periodLabel(
  period: PivotPeriod,
  p: Pick<PeriodHloc, 'start' | 'closeTime'>,
): string {
  const d = new Date(
    period === 'week' ? p.start : tradingDayMs({ time: p.start, closeTime: p.closeTime }),
  );
  switch (period) {
    case 'day':
      return d.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    case 'week':
      return `week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
    case 'month':
      return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    case 'year':
      return String(d.getUTCFullYear());
  }
}
