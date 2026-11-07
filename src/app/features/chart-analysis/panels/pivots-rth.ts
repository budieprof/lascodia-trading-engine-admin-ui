import type { SessionWindow } from '../indicators/sessions';
import { sessionDayOf } from '../indicators/sessions';
import type { Ohlc } from '../indicators/math';
import type { PeriodBar, PivotPeriod } from './pivots';

/**
 * Pivots from the REGULAR session only (UA06). The engine's session days for an exchange-listed instrument span its
 * extended hours (a NYSE CFD 04:00–20:00 New York), so the previous day's high / low / close include pre- and
 * post-market prints a floor trader's pivots leave out. This folds intraday bars whose open falls inside the
 * calendar's Regular windows into one bar per regular session (closing at its last bar's close), and those into weeks
 * (Monday-based) and months of regular sessions. Years are left to `yearBars` over the months. Pure.
 */

const DAY = 86_400_000;

/** One bar per regular-session occurrence (keyed by its local opening date), ascending; `closeTime` its last bar's end. */
export function regularSessionDays(
  bars: readonly Ohlc[],
  windows: readonly SessionWindow[],
  intervalMs: number,
): PeriodBar[] {
  const out: PeriodBar[] = [];
  let key: number | null = null;
  for (const b of bars) {
    let day: number | null = null;
    for (const w of windows) {
      day = sessionDayOf(b.time, w);
      if (day !== null) break;
    }
    if (day === null) continue;
    const tail = out[out.length - 1];
    if (tail && day === key) {
      tail.high = Math.max(tail.high, b.high);
      tail.low = Math.min(tail.low, b.low);
      tail.close = b.close;
      tail.volume += b.volume;
      tail.closeTime = b.time + intervalMs;
    } else {
      key = day;
      out.push({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        closeTime: b.time + intervalMs,
      });
    }
  }
  return out;
}

function periodKeyOf(dayStartMs: number, period: 'week' | 'month'): number {
  const d = new Date(dayStartMs);
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day - ((d.getUTCDay() + 6) % 7) * DAY;
}

/** Regular-session days grouped into weeks or months (by the UTC date of each session's open). */
export function foldRegularDays(days: readonly PeriodBar[], period: 'week' | 'month'): PeriodBar[] {
  const out: PeriodBar[] = [];
  let key: number | null = null;
  for (const d of days) {
    const k = periodKeyOf(d.time, period);
    const tail = out[out.length - 1];
    if (tail && k === key) {
      tail.high = Math.max(tail.high, d.high);
      tail.low = Math.min(tail.low, d.low);
      tail.close = d.close;
      tail.volume += d.volume;
    } else {
      key = k;
      // The week / month runs to the next one's start: between two sessions it is still the current period.
      const next =
        period === 'week'
          ? k + 7 * DAY
          : Date.UTC(new Date(k).getUTCFullYear(), new Date(k).getUTCMonth() + 1, 1);
      out.push({ ...d, closeTime: next });
    }
  }
  return out;
}

/**
 * The pivot period's bars on the regular session, or null where it cannot be built from the intraday bars held
 * (a year needs more history than the 15-minute frame keeps).
 */
export function regularPeriodBars(
  period: PivotPeriod,
  intraday: readonly Ohlc[],
  windows: readonly SessionWindow[],
  intervalMs: number,
): PeriodBar[] | null {
  if (!windows.length || !intraday.length || period === 'year') return null;
  const days = regularSessionDays(intraday, windows, intervalMs);
  if (!days.length) return null;
  if (period === 'day') return days;
  return foldRegularDays(days, period);
}
