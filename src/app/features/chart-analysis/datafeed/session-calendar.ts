import { parseSession } from '@features/scripting/pine/pine-inputs';
import { periodKey } from '../indicators/math';
import { timezoneOffsetMinutes } from '../workspace/layout-store.service';
import type { Bar } from './candle-feed.service';
import { resolutionMs, type TvResolution } from './resolution';
import { tradingDayMs } from './session-bars';

/**
 * A symbol's TRADING DAYS, for the code that groups bars by day — the session VWAP, the daily pivots,
 * the Day / Week / Month anchors, session and periodic volume profiles, TPO — and for a live price
 * that opens the next session-grid period before the engine has built it ({@link nextSessionPeriod}).
 *
 * A session-grid bar (2h … 1M) carries the engine's own open and close, and its trading day is read
 * off them (`tradingDayMs`, `tradingDateOf`). A stored-grid bar (1m … 1h) carries neither, yet an
 * indicator over it has to know which trading day it falls in: TradingView resets an FX session VWAP
 * at 17:00 New York, not at midnight UTC. That comes from the session the engine says the symbol
 * trades — `scripting/chart-bars`' `session` and `timeZone`, Pine's `syminfo.session` and
 * `syminfo.timezone`; FX `1700-1700:23456` in America/New_York — read with the console's Pine session
 * parser (`parseSession`) on its time-zone offsets (`timezoneOffsetMinutes`). A trading day is dated
 * by `tradingDayMs`, on the session's own clock: the date its session closes on. For FX, whose
 * 17:00 New York close is 21:00 or 22:00 UTC on the same date, that is the date the engine's bars
 * carry, so a stored-grid bar and the session-grid bar of the same session fall on the same day.
 *
 * Pure: no Angular, no HTTP; unit-tested directly.
 */

const MIN = 60_000;
const DAY = 86_400_000;
/** Instants a calendar remembers before it starts again (a long scroll-back is ~20k bars). */
const MEMO_LIMIT = 200_000;
/** Zones with no offset, answered without asking `Intl`. */
const UTC_ZONE = /^(?:etc\/)?(?:utc|uct|gmt|zulu|universal)$/i;

/** The session a symbol trades, as the engine reports it with its chart bars. */
export interface SessionSpec {
  /** A Pine session string, e.g. `1700-1700:23456` (day digits: 1 = Sunday … 7 = Saturday). */
  session: string;
  /** Its IANA time zone, e.g. `America/New_York`. */
  timeZone: string;
}

/** One trading day of a session. */
export interface TradingSession {
  /** Its date: 00:00 UTC of the day its session closes on. */
  day: number;
  /** Where the trading day begins and ends, UTC ms, [start, end) — for FX 17:00 to 17:00 New York. */
  start: number;
  end: number;
}

/** What code that groups bars by trading day needs of a {@link TradingCalendar}. */
export interface TradingDays {
  /** The trading day containing the instant `ms`: 00:00 UTC ms of its date. */
  dayOf(ms: number): number;
  /** The trading session containing the instant `ms`. */
  sessionAt(ms: number): TradingSession;
}

/**
 * The trading days of one session spec.
 *
 * A session that ends at or before the time it starts is OVERNIGHT, as in Pine: `1700-1700` opens at
 * 17:00 on the evening before its trading day and closes at 17:00 on it. Any other session's trading
 * day runs from midnight to midnight on its own clock (`0000-0000:1234567` in Etc/UTC: the UTC day).
 * Answers are remembered per instant, so the indicators' recompute on every tick costs a lookup per
 * bar rather than a time-zone conversion per trading day.
 */
export class TradingCalendar implements TradingDays {
  /** Minutes after midnight, on the session's clock, where a trading day begins. */
  private readonly boundaryMin: number;
  /** Pine day digits of the trading days (1 = Sunday); null: every day trades. */
  private readonly days: string | null;
  private readonly utc: boolean;
  private last: TradingSession | null = null;
  private readonly memo = new Map<number, number>();

  constructor(readonly spec: SessionSpec) {
    const parts = parseSession(spec.session);
    const start = minutesOf(parts.start);
    const end = minutesOf(parts.end);
    const overnight = start > end || (start === end && start !== 0);
    this.boundaryMin = overnight ? start : 0;
    this.days = parts.days;
    const zone = (spec.timeZone ?? '').trim();
    this.utc = !zone || UTC_ZONE.test(zone);
  }

  /** {@link TradingDays.dayOf}, remembered per instant; bound, so it can be handed on as a function. */
  readonly dayOf = (ms: number): number => {
    let day = this.memo.get(ms);
    if (day === undefined) {
      day = this.sessionAt(ms).day;
      if (this.memo.size >= MEMO_LIMIT) this.memo.clear();
      this.memo.set(ms, day);
    }
    return day;
  };

  sessionAt(ms: number): TradingSession {
    const last = this.last;
    if (last && ms >= last.start && ms < last.end) return last;
    let k = Math.floor((ms + this.offsetMs(ms) - this.boundaryMin * MIN) / DAY);
    let session = this.window(k);
    // `ms` is placed by its own offset, the window's edges by theirs: across a clock change that
    // falls on the boundary itself the two differ by the change. Step to the window that holds it.
    for (let i = 0; i < 2 && (ms < session.start || ms >= session.end); i++) {
      k += ms < session.start ? -1 : 1;
      session = this.window(k);
    }
    this.last = session;
    return session;
  }

  /** The session of the trading date `day` (00:00 UTC ms). */
  sessionOfDay(day: number): TradingSession {
    // A trading day that begins in the evening is dated by the next morning (see `window`).
    return this.window(Math.round(day / DAY) - (this.boundaryMin > 0 ? 1 : 0));
  }

  /** Whether the session trades on the date `day` (00:00 UTC ms): its weekday is one of its days. */
  isTradingDay(day: number): boolean {
    return !this.days || this.days.includes(String(new Date(day).getUTCDay() + 1));
  }

  /**
   * The k-th trading day since the epoch on the session's clock. Its date is `tradingDayMs`'s rule —
   * the date its session closes on — read on that clock, where wall-clock times are the numbers.
   */
  private window(k: number): TradingSession {
    const localStart = k * DAY + this.boundaryMin * MIN;
    return {
      day: tradingDayMs({ time: localStart, closeTime: localStart + DAY }),
      start: this.instantOf(localStart),
      end: this.instantOf(localStart + DAY),
    };
  }

  private offsetMs(ms: number): number {
    return this.utc ? 0 : timezoneOffsetMinutes(this.spec.timeZone, ms) * MIN;
  }

  /** A wall-clock time on the session's clock (as epoch ms) → the instant it names. */
  private instantOf(local: number): number {
    const guess = local - this.offsetMs(local);
    return local - this.offsetMs(guess);
  }
}

/** `HH:mm` → minutes after midnight. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * The session-grid period a live price at `nowMs` opens once the newest bar `last` has closed, laid
 * out as the engine lays it — so the chart draws the price at once, as TradingView opens a bar on its
 * period's first tick, instead of waiting for the engine's forming bar, which is folded from closed
 * M1 and does not exist in a period's first minute.
 *
 * <ul>
 *   <li>Within a trading week periods follow one another: the next opens where `last` closed.</li>
 *   <li>Across a shut market — the weekend — it opens with the session the price is in: Sunday 17:00
 *       New York, not Friday's close.</li>
 *   <li>It closes where the engine will close it: a 2h or 4h block one width on (cut at the session's
 *       end), a day with its session, a week or a month with the session of its last trading day.</li>
 * </ul>
 *
 * Null — the engine opens it — when the price is outside the session (a stray weekend tick), past the
 * period that would open (no price for a whole period: which one this is, the engine knows), or
 * `last` has no close.
 */
export function nextSessionPeriod(
  calendar: TradingCalendar,
  resolution: TvResolution,
  last: Pick<Bar, 'time' | 'closeTime'>,
  nowMs: number,
): { time: number; closeTime: number } | null {
  const lastClose = last.closeTime;
  if (lastClose === undefined || !Number.isFinite(lastClose) || nowMs < lastClose) return null;
  const session = calendar.sessionAt(nowMs);
  if (!calendar.isTradingDay(session.day)) return null;
  const time = Math.max(lastClose, session.start);
  const closeTime = periodClose(calendar, resolution, session, time);
  return closeTime !== null && nowMs < closeTime ? { time, closeTime } : null;
}

/** Where the period of `resolution` opening at `open`, in trading day `session`, closes. */
function periodClose(
  calendar: TradingCalendar,
  resolution: TvResolution,
  session: TradingSession,
  open: number,
): number | null {
  switch (resolution) {
    case '1D':
      return session.end;
    case '1W':
      return lastTradingDayEnd(calendar, session, 'Week');
    case '1M':
      return lastTradingDayEnd(calendar, session, 'Month');
    default: {
      const width = resolutionMs(resolution);
      return width === null ? null : Math.min(open + width, session.end);
    }
  }
}

/** The close of the last trading day in the week (Monday–Sunday) or month of `session`. */
function lastTradingDayEnd(
  calendar: TradingCalendar,
  session: TradingSession,
  period: 'Week' | 'Month',
): number {
  const key = periodKey(session.day, period);
  let last = session;
  // A month has at most 31 days after any of its own.
  for (let day = session.day + DAY, i = 0; i < 31; day += DAY, i++) {
    if (periodKey(day, period) !== key) break;
    if (calendar.isTradingDay(day)) last = calendar.sessionOfDay(day);
  }
  return last.end;
}
