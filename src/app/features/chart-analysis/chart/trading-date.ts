import {
  TickMarkType,
  defaultHorzScaleBehavior,
  type InternalHorzScaleItem,
  type Mutable,
  type TimeScalePoint,
  type UTCTimestamp,
} from 'lightweight-charts';
import { tradingDayMs } from '../datafeed/session-bars';

/**
 * Bars labelled by TRADING DATE — the display side of the session grid.
 *
 * A 1D, 1W or 1M bar opens at 17:00 New York the evening before its first trading day (21:00 or
 * 22:00 UTC), and that open is its `time`: scripts, `barcolor()` and drawings find it by that
 * instant, so the data keeps it. What the chart PRINTS for these bars is the trading date instead,
 * as TradingView does — Tuesday's candle reads Tuesday, not "Mon 21:00". A trading date is a
 * calendar date, so it carries no clock time and no display time zone. 2h and 4h keep their clock
 * times (in the chart's time zone).
 *
 * The date comes from the bar's own open and close — the engine's calendar, not the client's:
 * - 1D: the date its session closes on, the UTC date of `closeTime − 1 ms` (`tradingDayMs`);
 * - 1W: its first trading day, the date of `time + 12 h` (the week opens on Sunday evening);
 * - 1M: its last trading day, `closeTime − 1 ms` — of which only the month is printed.
 * Without a close, the date of `time + 12 h`.
 */

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whether bars of `resolution` are labelled by trading date (1D, 1W, 1M) rather than by clock time. */
export function labelsByTradingDate(resolution: string): boolean {
  return resolution === '1D' || resolution === '1W' || resolution === '1M';
}

/**
 * The trading date a bar is labelled with, as 00:00 UTC of that date — null on a resolution
 * labelled by clock time.
 */
export function tradingDateOf(
  bar: { time: number; closeTime?: number },
  resolution: string,
): number | null {
  if (!labelsByTradingDate(resolution)) return null;
  // A week is named by its first trading day: the date of its first session, whatever its close.
  return tradingDayMs(resolution === '1W' ? { time: bar.time } : bar);
}

/** A trading date as the chart prints it: "Tue 6 Oct 2026" (1D), "5 Oct 2026" (1W), "Oct 2026" (1M). */
export function formatTradingDate(dateMs: number, resolution: string): string {
  const d = new Date(dateMs);
  const month = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (resolution === '1M') return month;
  const date = `${d.getUTCDate()} ${month}`;
  return resolution === '1W' ? date : `${WEEKDAYS[d.getUTCDay()]} ${date}`;
}

/** A bar's trading-date label, or null when its resolution is labelled by clock time. */
export function tradingDateLabel(
  bar: { time: number; closeTime?: number },
  resolution: string,
): string | null {
  const date = tradingDateOf(bar, resolution);
  return date === null ? null : formatTradingDate(date, resolution);
}

/**
 * A time-axis tick on a trading date: the year at a year's first bar, the month at a month's, the
 * day of the month otherwise (a clock-time tick, which trading dates do not produce, reads as a day).
 */
export function tradingDateTick(dateMs: number, tickMarkType: TickMarkType): string {
  const d = new Date(dateMs);
  if (tickMarkType === TickMarkType.Year) return String(d.getUTCFullYear());
  if (tickMarkType === TickMarkType.Month) return MONTHS[d.getUTCMonth()];
  return String(d.getUTCDate());
}

/**
 * Each bar's trading date by the time it is plotted at (seconds, after `shiftMs` — the display time
 * zone's shift): what the time axis, the crosshair and the legend look a plotted time up in. Empty on
 * a resolution labelled by clock time.
 */
export function tradingDatesByPlottedTime(
  bars: readonly { time: number; closeTime?: number }[],
  resolution: string,
  shiftMs: (utcMs: number) => number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!labelsByTradingDate(resolution)) return out;
  for (const b of bars) {
    const date = tradingDateOf(b, resolution);
    if (date !== null) out.set(Math.floor((b.time + shiftMs(b.time)) / 1000), date);
  }
  return out;
}

/** Where a time scale finds the trading dates it labels with. */
export interface TradingDateSource {
  /** The trading date (00:00 UTC ms) of the bar plotted at `seconds`; null on a clock-time chart. */
  dateAt(seconds: number): number | null;
  /** The chart's resolution, for the label's form. */
  resolution(): string;
}

/**
 * Lightweight Charts' own time scale, with two things taken from the trading date on 1D/1W/1M:
 *
 * - **which bar starts a year, a month or a day** (the tick marks' weights). The library weighs a
 *   tick by the calendar date of the instant it is given — the open, the evening before — so it put
 *   "Oct" on the second session of October and "2027" on February's bar;
 * - **the crosshair's time label**, which has no formatter of its own that could fall back to the
 *   library's for 2h and 4h.
 *
 * The tick labels themselves come from the chart's `tickMarkFormatter` ({@link tradingDateTick}).
 * Everything else — and every other resolution — is the library's.
 */
export class TradingDateTimeScale extends defaultHorzScaleBehavior() {
  source: TradingDateSource | null = null;

  override fillWeightsForPoints(
    points: readonly Mutable<TimeScalePoint>[],
    startIndex: number,
  ): void {
    const source = this.source;
    if (!source || points.length === 0 || !labelsByTradingDate(source.resolution())) {
      super.fillWeightsForPoints(points, startIndex);
      return;
    }
    // The library's weighing, on the trading dates instead of the opens.
    const onDates = points.map((p) => {
      const date = source.dateAt(this.key(p.time));
      return date === null
        ? { ...p }
        : { ...p, time: this.convertHorzItemToInternal((date / 1000) as UTCTimestamp) };
    });
    super.fillWeightsForPoints(onDates, startIndex);
    for (let i = 0; i < points.length; i++) points[i].timeWeight = onDates[i].timeWeight;
  }

  override formatHorzItem(item: InternalHorzScaleItem): string {
    const source = this.source;
    const date = source?.dateAt(this.key(item)) ?? null;
    return date === null || !source
      ? super.formatHorzItem(item)
      : formatTradingDate(date, source.resolution());
  }
}
