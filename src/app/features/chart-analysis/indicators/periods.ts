/**
 * Trading periods — the day, week and month a bar belongs to — shared by the indicator maths (`math.ts`) and the
 * profile engine (`profiles/profile-math.ts`). Its own module so the two can use each other without a cycle.
 */

const DAY_MS = 86_400_000;

/**
 * A bar's time → its trading day, as 00:00 UTC ms of the date. What every day-based study (session
 * VWAP, daily pivots, the Day / Week / Month anchors) counts in: the chart passes the symbol's own
 * trading days (`TradingCalendar.dayOf` — for FX, days that roll at 17:00 New York), and without one
 * a day is the UTC day ({@link utcDay}).
 */
export type DayOf = (time: number) => number;

/** The UTC day of `time`: the trading day of a symbol with no session of its own. */
export const utcDay: DayOf = (time) => Math.floor(time / DAY_MS) * DAY_MS;

export type AnchorPeriod = 'Day' | 'Week' | 'Month';

/**
 * Key of the trading day, week (Monday–Sunday) or month `time` falls in — the period of its trading
 * DATE (`dayOf`), as TradingView anchors them: an FX bar from Sunday 17:00 New York trades Monday, so
 * it opens Monday's week, and the session opening on 30 September at 17:00 New York is 1 October's,
 * so it opens October. With the default {@link utcDay}, calendar periods of the UTC day.
 */
export function periodKey(time: number, period: AnchorPeriod, dayOf: DayOf = utcDay): number {
  const day = Math.floor(dayOf(time) / DAY_MS);
  if (period === 'Week') return Math.floor((day + 3) / 7); // 1970-01-01 was a Thursday
  if (period === 'Month') {
    const d = new Date(day * DAY_MS);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  return day;
}
