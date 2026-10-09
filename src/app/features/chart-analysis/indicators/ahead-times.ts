/**
 * The open times (UTC ms) of the bars still to come after the last one — where a study's values PAST the last bar
 * are drawn (Ichimoku's leading spans, the Alligator's shifted lines; DR-11, DR-I4).
 *
 * The bars ahead open only while the market trades, exactly as the chart counts upcoming events past its last bar
 * (`logicalAtMs`): one bar width apart inside a session, the next session's open across a closed market — so the
 * cloud's 25th bar after Friday's close lands on Tuesday, not on Saturday, and the next real bar opens at the time
 * its value was drawn at (the chart then updates that row in place instead of re-sending the series).
 *
 * Pure: no Angular; unit-tested directly.
 */
import type { TradingCalendar } from '../datafeed/session-calendar';

const DAY = 86_400_000;

/** What of a {@link TradingCalendar} the projection reads. */
export type AheadCalendar = Pick<TradingCalendar, 'sessionAt' | 'isTradingDay'>;

/**
 * `count` open times after `last`, `stepMs` apart on the calendar's trading time. `last.closeTime` (the session
 * grid's own close) is where the next bar opens when known; else `last.time + stepMs`. A week or a month (`stepMs`
 * of 7 days or more) steps on the calendar, not the session.
 */
export function aheadTimes(
  last: { time: number; closeTime?: number },
  stepMs: number,
  count: number,
  calendar: AheadCalendar | null,
): number[] {
  const out: number[] = [];
  if (count <= 0 || !Number.isFinite(stepMs) || stepMs <= 0) return out;
  const calendarSteps = stepMs >= 7 * DAY;
  const next = (t: number): number => {
    if (stepMs < 28 * DAY) return t + stepMs;
    const d = new Date(t);
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
    );
  };
  let t =
    last.closeTime !== undefined && Number.isFinite(last.closeTime)
      ? last.closeTime
      : next(last.time);
  for (let k = 0; k < count; k++) {
    if (calendar && !calendarSteps) t = tradingInstant(calendar, t);
    out.push(t);
    t = next(t);
  }
  return out;
}

/** `t`, or the open of the first trading session after it when the market is shut at `t`. */
function tradingInstant(calendar: AheadCalendar, t: number): number {
  for (let i = 0; i < 14; i++) {
    const s = calendar.sessionAt(t);
    if (calendar.isTradingDay(s.day) && t < s.end) return Math.max(t, s.start);
    t = Math.max(s.end, t + 60_000);
  }
  return t;
}
