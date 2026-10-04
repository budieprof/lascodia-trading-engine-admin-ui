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
 * Pure: no Angular, unit-tested directly.
 */
import { monthStartMs, weekStartMs } from '../datafeed/aggregate';
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
  /** Start of the period, UTC ms. */
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const DAY = 86_400_000;

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

/** Start of the period containing `ms`, in UTC. Weeks start on Sunday, as the chart's weekly bars do. */
export function periodStart(period: PivotPeriod, ms: number): number {
  switch (period) {
    case 'day':
      return Math.floor(ms / DAY) * DAY;
    case 'week':
      return weekStartMs(ms);
    case 'month':
      return monthStartMs(ms);
    case 'year':
      return Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
  }
}

/**
 * The completed period before the one containing `refMs`, folded from daily
 * bars, plus the open of the period containing `refMs` (Woodie needs it; null
 * when no daily bar of the current period has been stored yet).
 *
 * "The period containing `refMs`" is the period of the newest bar on screen, so
 * over a weekend the daily pivots are Thursday's — what TradingView shows for
 * Friday's session — and the monthly pivots in early October are September's.
 */
export function pivotInputs(
  daily: readonly Ohlc[],
  period: PivotPeriod,
  refMs: number,
): { prev: PeriodHloc; currentOpen: number | null } | null {
  const current = periodStart(period, refMs);
  let prevStart: number | null = null;
  for (const b of daily) {
    const s = periodStart(period, b.time);
    if (s < current && (prevStart === null || s > prevStart)) prevStart = s;
  }
  if (prevStart === null) return null;

  let prev: PeriodHloc | null = null;
  let currentOpen: number | null = null;
  for (const b of daily) {
    const s = periodStart(period, b.time);
    if (s === prevStart) {
      if (!prev) prev = { start: s, open: b.open, high: b.high, low: b.low, close: b.close };
      else {
        prev.high = Math.max(prev.high, b.high);
        prev.low = Math.min(prev.low, b.low);
        prev.close = b.close;
      }
    } else if (s === current && currentOpen === null) {
      currentOpen = b.open;
    }
  }
  return prev ? { prev, currentOpen } : null;
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

/** Human label for the period the pivots came from, e.g. "September 2026", "week of 27 Sep". */
export function periodLabel(period: PivotPeriod, start: number): string {
  const d = new Date(start);
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
