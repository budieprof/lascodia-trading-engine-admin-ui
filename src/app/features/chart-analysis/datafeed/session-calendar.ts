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
 * `syminfo.timezone`; FX `1700-1700:23456` in America/New_York — read period by period
 * (`parseSessionPeriods`) on its time-zone offsets (`timezoneOffsetMinutes`), less the holidays, early closes and
 * breaks the engine reports with the bars (C1 `closures`). A trading day is dated
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
  /**
   * A Pine session string: one or more periods and the trading days, e.g. `1700-1700:23456` (FX) or
   * `0400-0930,0930-1600,1600-2000:23456` (a NYSE CFD's extended hours; day digits: 1 = Sunday … 7 = Saturday).
   */
  session: string;
  /** Its IANA time zone, e.g. `America/New_York`. */
  timeZone: string;
  /**
   * The calendar's closures inside the windows the engine answered for (contract C1 `closures`): holidays, early
   * closes and daily breaks. Absent or empty for fx-24x5 and 24x7 — and from an engine before C1.
   */
  closures?: readonly SessionClosure[];
}

/** A stretch of time a session does not trade although its weekly hours say it does (C1 `closures`). */
export interface SessionClosure {
  fromMs: number;
  toMs: number;
  kind: 'Holiday' | 'EarlyClose' | 'Break' | string;
  label: string;
}

/** One trading day of a session. */
export interface TradingSession {
  /** Its date: 00:00 UTC of the day its session closes on. */
  day: number;
  /** Where the trading day begins and ends, UTC ms, [start, end) — for FX 17:00 to 17:00 New York. */
  start: number;
  end: number;
}

/**
 * One trading period of a trading day, UTC ms, [open, close): a period of the session string with the day's closures
 * taken out. `anchor` is where the period's bars are laid from (its open in the session string — Pine starts intraday
 * bars at each period's open and every bar width after it, the last cut at the close).
 */
export interface TradingPeriod {
  open: number;
  close: number;
  anchor: number;
}

/** What code that groups bars by trading day needs of a {@link TradingCalendar}. */
export interface TradingDays {
  /** The trading day containing the instant `ms`: 00:00 UTC ms of its date. */
  dayOf(ms: number): number;
  /** The trading session containing the instant `ms`. */
  sessionAt(ms: number): TradingSession;
}

/** A Pine session string read into minutes: every period (open, length) and the trading-day digits. */
export interface SessionPeriods {
  /** Each period's open (minutes after midnight on the session's clock) and its length in minutes (1 … 1440). */
  periods: { open: number; length: number }[];
  /** Pine day digits of the trading days; null: every day trades. */
  days: string | null;
}

/**
 * Reads `HHMM-HHMM[,HHMM-HHMM…][:digits]` (and `24x7`). A period whose close is at or before its open runs overnight
 * (`1700-1700` is 24 hours from 17:00); `0000-0000` is the whole day. Unreadable → the whole day, every day.
 */
export function parseSessionPeriods(value: string | null | undefined): SessionPeriods {
  const v = (value ?? '').trim();
  const whole: SessionPeriods = { periods: [{ open: 0, length: 1440 }], days: null };
  if (!v || /^24x7$/i.test(v)) return whole;
  const [hours, digits] = v.split(':');
  const periods: { open: number; length: number }[] = [];
  for (const part of hours.split(',')) {
    const m = /^\s*(\d{2})(\d{2})-(\d{2})(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const open = (Number(m[1]) % 24) * 60 + Number(m[2]);
    const close = (Number(m[3]) % 24) * 60 + Number(m[4]);
    const length = close > open ? close - open : close + 1440 - open;
    periods.push({ open, length: Math.min(1440, length) });
  }
  if (!periods.length) return whole;
  const d = /^[1-7]+$/.test((digits ?? '').trim()) ? digits.trim() : null;
  return { periods, days: d };
}

/**
 * The trading days of one session spec — the session the ENGINE reports with the symbol's chart bars (multi-asset chart
 * program UD01: the engine is the authority; the client no longer derives a session of its own from a calendar).
 *
 * A session with a period that ends at or before the time it starts is OVERNIGHT, as in Pine: `1700-1700` opens at
 * 17:00 on the evening before its trading day and closes at 17:00 on it. Any other session's trading day runs from
 * midnight to midnight on its own clock (`0000-0000:1234567` in Etc/UTC: the UTC day). Within the day only its periods
 * trade (`0400-0930,0930-1600,1600-2000`: 04:00 to 20:00), less the closures the engine reported (a holiday leaves
 * none, an early close cuts the day short). Answers are remembered per instant, so the indicators' recompute on every
 * tick costs a lookup per bar rather than a time-zone conversion per trading day.
 */
export class TradingCalendar implements TradingDays {
  /** Minutes after midnight, on the session's clock, where a trading day begins. */
  private readonly boundaryMin: number;
  /** Pine day digits of the trading days (1 = Sunday); null: every day trades. */
  private readonly days: string | null;
  /** The periods as offsets from the trading day's start, in minutes. */
  private readonly offsets: { from: number; length: number }[];
  private readonly closures: readonly SessionClosure[];
  private readonly utc: boolean;
  private last: TradingSession | null = null;
  private readonly memo = new Map<number, number>();
  private readonly periodMemo = new Map<number, TradingPeriod[]>();

  constructor(readonly spec: SessionSpec) {
    const parsed = parseSessionPeriods(spec.session);
    const overnight = parsed.periods.find(
      (p) => p.open + p.length > 1440 || (p.length === 1440 && p.open !== 0),
    );
    this.boundaryMin = overnight ? overnight.open : 0;
    this.days = parsed.days;
    this.offsets = parsed.periods
      .map((p) => ({ from: (p.open - this.boundaryMin + 1440) % 1440, length: p.length }))
      .sort((a, b) => a.from - b.from);
    this.closures = (spec.closures ?? []).filter(
      (c) => Number.isFinite(c.fromMs) && Number.isFinite(c.toMs) && c.toMs > c.fromMs,
    );
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

  /**
   * Whether the session trades on the date `day` (00:00 UTC ms): its weekday is one of its days, and the engine's
   * closures (a holiday) leave some of it open.
   */
  isTradingDay(day: number): boolean {
    if (this.days && !this.days.includes(String(new Date(day).getUTCDay() + 1))) return false;
    return this.closures.length === 0 || this.periodsOf(this.sessionOfDay(day)).length > 0;
  }

  /** The trading periods of `session` (one of this calendar's), closures taken out; ascending. */
  periodsOf(session: TradingSession): TradingPeriod[] {
    const held = this.periodMemo.get(session.start);
    if (held) return held;
    const localStart = session.start + this.offsetMs(session.start);
    const periods: TradingPeriod[] = [];
    for (const o of this.offsets) {
      const anchor = this.instantOf(localStart + o.from * MIN);
      const close = this.instantOf(localStart + (o.from + o.length) * MIN);
      for (const piece of subtract({ open: anchor, close }, this.closures))
        periods.push({ ...piece, anchor });
    }
    periods.sort((a, b) => a.open - b.open);
    if (this.periodMemo.size >= 4096) this.periodMemo.clear();
    this.periodMemo.set(session.start, periods);
    return periods;
  }

  /** The trading period containing `ms`, or null outside every one (the session is shut). */
  periodAt(ms: number): TradingPeriod | null {
    const session = this.sessionAt(ms);
    if (this.days && !this.days.includes(String(new Date(session.day).getUTCDay() + 1)))
      return null;
    return this.periodsOf(session).find((p) => ms >= p.open && ms < p.close) ?? null;
  }

  /** Where `session`'s trading begins and ends (first period's open, last period's close); null: it does not trade. */
  tradingBounds(session: TradingSession): { open: number; close: number } | null {
    const periods = this.periodsOf(session);
    return periods.length
      ? { open: periods[0].open, close: periods[periods.length - 1].close }
      : null;
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

/** `span` less every closure overlapping it: the pieces that still trade (none for a holiday). */
function subtract(
  span: { open: number; close: number },
  closures: readonly SessionClosure[],
): { open: number; close: number }[] {
  let pieces = [span];
  for (const c of closures) {
    if (c.toMs <= span.open || c.fromMs >= span.close) continue;
    const next: { open: number; close: number }[] = [];
    for (const p of pieces) {
      if (c.toMs <= p.open || c.fromMs >= p.close) {
        next.push(p);
        continue;
      }
      if (c.fromMs > p.open) next.push({ open: p.open, close: c.fromMs });
      if (c.toMs < p.close) next.push({ open: c.toMs, close: p.close });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Trading time between two instants (ms): the part of [`fromMs`, `toMs`) that falls in the
 * calendar's trading periods — a Saturday, a holiday or the time between two periods adds nothing. What the chart
 * counts bars by when it places an upcoming event after its last bar (CC-I2): the bars still to come open only while
 * the market trades. Bounded to a few hundred trading days.
 */
export function tradingMsBetween(
  calendar: TradingDays &
    Pick<TradingCalendar, 'isTradingDay'> &
    Partial<Pick<TradingCalendar, 'periodsOf'>>,
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  let cursor = fromMs;
  for (let i = 0; i < 400 && cursor < toMs; i++) {
    const s = calendar.sessionAt(cursor);
    if (calendar.isTradingDay(s.day)) {
      const spans = calendar.periodsOf ? calendar.periodsOf(s) : [{ open: s.start, close: s.end }];
      for (const p of spans)
        total += Math.max(0, Math.min(toMs, p.close) - Math.max(cursor, p.open));
    }
    // Sessions follow one another; never stand still on a malformed one.
    cursor = Math.max(s.end, cursor + 60_000);
  }
  return total;
}

/**
 * The session-grid period a live price at `nowMs` opens once the newest bar `last` has closed, laid
 * out as the engine lays it — so the chart draws the price at once, as TradingView opens a bar on its
 * period's first tick, instead of waiting for the engine's forming bar, which is folded from closed
 * M1 and does not exist in a period's first minute.
 *
 * <ul>
 *   <li>Intraday: the bar of the trading period the price is in — from the period's open every bar width, the last
 *       cut at the period's close (Pine's layout; FX's one period is the whole 17:00 New York day). Within a period
 *       bars follow one another: the next opens where `last` closed.</li>
 *   <li>Across a shut market — the weekend, a holiday, the night between two sessions — it opens with the period the
 *       price is in: Sunday 17:00 New York, not Friday's close.</li>
 *   <li>A day opens and closes with its trading (first period's open, last period's close); a week or a month closes
 *       with its last trading day.</li>
 * </ul>
 *
 * Null — the engine opens it — when the price is outside every trading period (a stray weekend tick, a holiday),
 * past the period that would open (no price for a whole period: which one this is, the engine knows), or `last` has no
 * close.
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
  if (resolution === '1D' || resolution === '1W' || resolution === '1M') {
    const bounds = calendar.tradingBounds(session);
    if (!bounds || nowMs < bounds.open || nowMs >= bounds.close) return null;
    const time = Math.max(lastClose, bounds.open);
    const closeTime =
      resolution === '1D'
        ? bounds.close
        : lastTradingDayEnd(calendar, session, resolution === '1W' ? 'Week' : 'Month');
    return nowMs < closeTime ? { time, closeTime } : null;
  }
  const width = resolutionMs(resolution);
  const period = calendar.periodAt(nowMs);
  if (width === null || !period) return null;
  const open = Math.max(
    period.open,
    period.anchor + Math.floor((nowMs - period.anchor) / width) * width,
  );
  const closeTime = Math.min(
    period.anchor + (Math.floor((open - period.anchor) / width) + 1) * width,
    period.close,
  );
  // The bar after `last`, or the period's first after a shut market — any other is a bar the engine must place.
  if (open !== Math.max(lastClose, period.open)) return null;
  return nowMs < closeTime ? { time: open, closeTime } : null;
}

/** The close of the trading in the last trading day of the week (Monday–Sunday) or month of `session`. */
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
  return calendar.tradingBounds(last)?.close ?? last.end;
}
