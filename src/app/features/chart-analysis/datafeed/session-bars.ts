import type { Bar, SessionBar } from './candle-feed.service';
import { resolutionSource, type TvResolution } from './resolution';

/**
 * The client side of the session grid (2h, 4h, 1D, 1W, 1M — see `resolution.ts`): what the chart
 * does with bars the engine laid out. Pure — no Angular, no HTTP — so every rule is tested directly.
 *
 * The one rule behind all of it: the engine knows the calendar — where 17:00 New York falls in UTC
 * this week, that Friday's close is followed by Sunday's open, which day has no session — and puts
 * it into every bar as `time` (the open) and `closeTime` (the exclusive close). The client compares
 * instants with those two and never computes a period boundary of its own.
 */

const DAY = 86_400_000;

/** The most bars one `scripting/chart-bars` request may ask for. */
export const MAX_CHART_BARS = 20_000;

/** Whether `bar`'s period contains `nowMs`: [open, close). False for a bar without a close. */
export function isCurrentPeriod(bar: Bar | undefined, nowMs: number): boolean {
  const close = bar?.closeTime;
  return (
    !!bar && close !== undefined && Number.isFinite(close) && nowMs >= bar.time && nowMs < close
  );
}

/** What a live price does to a session-grid series (see {@link applySessionTick}). */
export type SessionTick =
  /** The newest bar is the current period: here it is with the price applied. */
  | { kind: 'update'; bars: Bar[] }
  /**
   * The newest bar's period is over and the price opened the next one, as TradingView opens a bar on
   * its period's first tick: open = high = low = close = the price, over the period `nextPeriod`
   * laid out. The engine builds its forming bar from closed M1, so it has none in a period's first
   * minute; its own replaces this one at the next resync ({@link mergeSessionTail}).
   */
  | { kind: 'open'; bars: Bar[] }
  /**
   * The newest bar's period is over, and where the next one opens is the engine's to say — after a
   * gap the chart cannot lay out, or with no calendar to lay it out by — so the chart asks for the
   * newest bars rather than invent it.
   */
  | { kind: 'rollover' }
  /** Nothing to do: no bars, no close to compare with, or a clock behind the newest bar's open. */
  | { kind: 'ignore' };

/**
 * A live price on a session-grid series at `nowMs` (the engine's clock): it moves the newest bar
 * while `nowMs` is before that bar's close. From its close on, it opens the next period's bar when
 * `nextPeriod` can say where that period lies (`nextSessionPeriod`, from the symbol's session), and
 * asks for a rollover when it cannot.
 */
export function applySessionTick(
  bars: readonly Bar[],
  price: number,
  nowMs: number,
  nextPeriod?: (last: Bar, nowMs: number) => { time: number; closeTime: number } | null,
): SessionTick {
  const last = bars[bars.length - 1];
  const close = last?.closeTime;
  if (!last || close === undefined || !Number.isFinite(close) || nowMs < last.time) {
    return { kind: 'ignore' };
  }
  if (nowMs >= close) {
    const next = nextPeriod?.(last, nowMs) ?? null;
    if (!next || next.time < close) return { kind: 'rollover' };
    const opened: Bar = {
      time: next.time,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      closeTime: next.closeTime,
    };
    return { kind: 'open', bars: [...bars, opened] };
  }
  const updated: Bar = {
    ...last,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
    close: price,
  };
  return { kind: 'update', bars: [...bars.slice(0, -1), updated] };
}

/**
 * The newest bars from the engine laid over the chart's.
 *
 * <ul>
 *   <li>Bars before the tail's first stay as they are: the tail says nothing about them.</li>
 *   <li>Within the tail, the engine's bars are the truth: a period the chart holds is replaced, one it
 *       does not is added (a period that opened since — Monday's after a weekend gap, whenever the
 *       engine had one to give), and one the engine no longer has is dropped.</li>
 *   <li>Except the CLOSE of the period still forming, when `liveClose` says ticks moved it since the
 *       last merge: a tick is newer than the engine's forming bar, which is folded from closed M1 and
 *       trails by up to a minute. Its high and low widen to take in both. Without ticks since, the
 *       engine's close is the newer one and wins.</li>
 *   <li>A bar the chart holds after the tail's last is kept: the period a live price opened before
 *       the engine had a bar for it ({@link applySessionTick}) — nothing on screen disappears because
 *       a request came back short. Unless it opens inside the engine's forming period: the engine
 *       laid that period out otherwise, and its bar is the truth.</li>
 * </ul>
 */
export function mergeSessionTail(
  held: readonly Bar[],
  tail: readonly SessionBar[],
  liveClose: boolean,
): Bar[] {
  if (tail.length === 0) return held.slice();
  const first = tail[0].time;
  const newest = tail[tail.length - 1];
  const last = newest.time;
  const formingClose = newest.forming ? (newest.closeTime ?? last) : last;
  const heldByTime = new Map(held.map((b) => [b.time, b]));
  const merged = tail.map((t): Bar => {
    const bar = asBar(t);
    const h = heldByTime.get(t.time);
    if (!t.forming || !h) return bar;
    return {
      ...bar,
      high: Math.max(bar.high, h.high),
      low: Math.min(bar.low, h.low),
      close: liveClose ? h.close : bar.close,
      volume: Math.max(bar.volume, h.volume),
    };
  });
  return [
    ...held.filter((b) => b.time < first),
    ...merged,
    ...held.filter((b) => b.time > last && b.time >= formingClose),
  ];
}

/** A session bar as the chart holds it: the period's open and close, without the request-time flag. */
export function asBar(b: SessionBar): Bar {
  const bar: Bar = {
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  };
  if (b.closeTime !== undefined && Number.isFinite(b.closeTime)) bar.closeTime = b.closeTime;
  return bar;
}

/**
 * How many of the newest bars to ask for so the answer reaches back to `sinceMs` (the open of the
 * newest bar the chart holds) and re-reads the one before it too — the period that just closed may
 * have been built before its last minute was stored. Nominal widths over-count across a weekend,
 * which costs a few bars, never a gap.
 */
export function tailCount(resolution: TvResolution, sinceMs: number, nowMs: number): number {
  const src = resolutionSource(resolution);
  const width = src?.kind === 'session' ? src.nominalMs : DAY;
  const gap = Math.ceil(Math.max(0, nowMs - sinceMs) / width);
  return Math.min(MAX_CHART_BARS, Math.max(3, gap + 2));
}

/**
 * The trading day of a session-grid bar: 00:00 UTC of the date its period CLOSES on. A FX session
 * closes at 17:00 New York — 21:00 or 22:00 UTC, the same date — so Tuesday's session, which opens
 * Monday 21:00 UTC, is Tuesday; a month's bar, which closes with its last trading day, is in its own
 * month and year even when it opens on the last evening of the one before (January's opens
 * 31 December). Read off the engine's `closeTime`, not a calendar. A bar without one: the date of its
 * open + 12 h — the evening open's next day, the session's own. (Any instant's trading day, a
 * stored-grid bar's included, comes from the symbol's session by the same rule: `TradingCalendar`.)
 */
export function tradingDayMs(bar: Pick<Bar, 'time' | 'closeTime'>): number {
  const close = bar.closeTime;
  const ref =
    close !== undefined && Number.isFinite(close) && close > bar.time
      ? close - 1
      : bar.time + DAY / 2;
  return Math.floor(ref / DAY) * DAY;
}

/**
 * The bars of the newest bar's day, for a "today" figure (open, range, change). On the session grid
 * (bars with a close): the bars that close on the newest bar's trading day — every 2h and 4h block
 * of a 17:00 New York session closes on that session's date, so this is the session, opening the
 * evening before; on 1D, the session bar itself. On the stored grid (1m … 1h): the newest bar's
 * trading day by the symbol's session (`dayOf`, a `TradingCalendar`'s) — the same session — or,
 * for a symbol without one, the UTC day.
 */
export function currentDayBars<T extends Pick<Bar, 'time' | 'closeTime'>>(
  bars: readonly T[],
  dayOf?: (ms: number) => number,
): T[] {
  const last = bars[bars.length - 1];
  if (!last) return [];
  const dayOfBar =
    last.closeTime !== undefined ? tradingDayMs : dayOf ? (b: T) => dayOf(b.time) : null;
  if (!dayOfBar) {
    const dayStart = Math.floor(last.time / DAY) * DAY;
    return bars.filter((b) => b.time >= dayStart);
  }
  const day = dayOfBar(last);
  let i = bars.length - 1;
  while (i > 0 && dayOfBar(bars[i - 1]) === day) i--;
  return bars.slice(i);
}

/** How long to wait before asking again when the engine had no next period yet. */
export const ROLLOVER_RETRY_MS = 15_000;
/** …and once it has stayed shut that long (a weekend, a quiet broker), how long between asks. */
export const ROLLOVER_SLOW_RETRY_MS = 60_000;
/** Fast asks per bar before slowing down: covers a period's first minute, when the engine has none. */
const FAST_RETRIES = 8;

/**
 * When a tick lands after the newest bar's close, the chart asks the engine for the newest bars —
 * the engine opens the next period, it knows when. One request per bar change: the first tick past a
 * bar's close asks; ticks while that request is in flight do not; and if the engine had nothing newer
 * (it builds a forming bar from closed M1, so a period's first minute has none; or it is the weekend)
 * the next tick may ask again only after {@link ROLLOVER_RETRY_MS} — {@link ROLLOVER_SLOW_RETRY_MS}
 * once that has failed {@link FAST_RETRIES} times — so a stream of ticks after the close never turns
 * into a stream of requests. A new newest bar (the `key` changes) starts afresh.
 */
export class SessionRollover {
  private state: { key: string; attempts: number; nextAt: number; inFlight: boolean } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A tick past the close of bar `key`: whether to ask now. A `true` must be followed by {@link done}. */
  request(key: string): boolean {
    if (this.state?.key !== key) {
      this.state = { key, attempts: 0, nextAt: 0, inFlight: false };
    }
    const s = this.state;
    if (s.inFlight || this.now() < s.nextAt) return false;
    s.inFlight = true;
    s.attempts++;
    return true;
  }

  /** The request for bar `key` is over (whatever it brought). */
  done(key: string): void {
    const s = this.state;
    if (!s || s.key !== key) return;
    s.inFlight = false;
    s.nextAt =
      this.now() + (s.attempts < FAST_RETRIES ? ROLLOVER_RETRY_MS : ROLLOVER_SLOW_RETRY_MS);
  }

  /** Forget everything (a symbol or timeframe switch). */
  reset(): void {
    this.state = null;
  }
}
