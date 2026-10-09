import type { Bar } from '../datafeed/candle-feed.service';
import { resolutionMs, type TvResolution } from '../datafeed/resolution';

/**
 * Bar Replay's position (CC-I4), pure.
 *
 * Replay is a view over the loaded bars: `index` whole bars are shown, and — with intrabar steps — `sub` of the
 * next bar's intrabar bars (M1 below a day) are folded into a bar still forming at the head. Stepping forward
 * reveals one intrabar bar at a time; the last one shows the bar itself (the stored bar, not the fold of its
 * minutes), and the bar is then closed.
 */
export interface ReplayCursor {
  /** Whole bars shown (≥ 1). The last one, `bars[index - 1]`, is the last CLOSED bar of the replay. */
  index: number;
  /**
   * Intrabar bars of `bars[index]` revealed (1 … n − 1) — that bar forms at the head; null: none, the head is the
   * last closed bar.
   */
  sub: number | null;
}

/** The resolution intrabar steps come from at `resolution`: 1m up to a day, 1h above it; null for a 1m chart. */
export function intrabarResolution(resolution: TvResolution): TvResolution | null {
  const ms = resolutionMs(resolution);
  if (ms === null || ms <= 60_000) return null;
  return ms <= 86_400_000 ? '1' : '60';
}

/** The exclusive end of `bars[i]`'s period: its own close, else the next bar's open, else its nominal width. */
export function barEndMs(bars: readonly Bar[], i: number, resolution: TvResolution): number {
  const bar = bars[i];
  const nominal = bar.closeTime ?? bar.time + (resolutionMs(resolution) ?? 60_000);
  const next = bars[i + 1]?.time;
  return next !== undefined && next < nominal ? next : nominal;
}

/** The intrabar bars of the period [`from`, `to`) out of ascending `minutes`. */
export function minutesIn(minutes: readonly Bar[], from: number, to: number): Bar[] {
  let lo = 0;
  let hi = minutes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (minutes[mid].time < from) lo = mid + 1;
    else hi = mid;
  }
  const out: Bar[] = [];
  for (let k = lo; k < minutes.length && minutes[k].time < to; k++) out.push(minutes[k]);
  return out;
}

/**
 * The bar forming at the head: `bar`'s open time (and close, when it has one) with the first `count` intrabar
 * bars folded in — their first open, highest high, lowest low, last close, summed volume; the recorded spread
 * of the last one.
 */
export function formingBar(bar: Bar, minutes: readonly Bar[], count: number): Bar {
  const part = minutes.slice(0, Math.max(1, Math.min(count, minutes.length)));
  const last = part[part.length - 1];
  const out: Bar = {
    time: bar.time,
    open: part[0].open,
    high: Math.max(...part.map((m) => m.high)),
    low: Math.min(...part.map((m) => m.low)),
    close: last.close,
    volume: part.reduce((s, m) => s + (Number.isFinite(m.volume) ? m.volume : 0), 0),
  };
  if (bar.closeTime !== undefined) out.closeTime = bar.closeTime;
  if (last.spreadPoints !== undefined) out.spreadPoints = last.spreadPoints;
  return out;
}

/** Looks up the intrabar bars of a bar by its open time; null when not loaded (or there are none). */
export type IntrabarLookup = (barTime: number) => readonly Bar[] | null;

/** Clamp a cursor to the bars held: at least one bar, at most all of them, a sub only where its bar exists. */
export function clampCursor(c: ReplayCursor, total: number): ReplayCursor {
  const index = Math.max(1, Math.min(Math.trunc(c.index), Math.max(1, total)));
  const sub = c.sub !== null && index < total && c.sub >= 1 ? Math.trunc(c.sub) : null;
  return { index, sub };
}

/** What the chart plots at `cursor`: the closed bars, then the bar forming at the head. */
export function replayView(bars: readonly Bar[], cursor: ReplayCursor, intrabar: IntrabarLookup): Bar[] {
  const c = clampCursor(cursor, bars.length);
  const shown = bars.slice(0, c.index);
  if (c.sub !== null) {
    const next = bars[c.index];
    const minutes = intrabar(next.time);
    if (minutes && minutes.length > c.sub) shown.push(formingBar(next, minutes, c.sub));
  }
  return shown;
}

/**
 * One step forward (`+1`) or back (`-1`). Forward with `intrabar` on: the next bar opens with its first intrabar
 * bar and grows one at a time — when its intrabar bars are known and there are at least two; else the whole bar
 * shows. Back: the forming bar loses its last intrabar bar (and goes when it had one), else the last closed bar
 * goes.
 */
export function stepCursor(
  c: ReplayCursor,
  dir: 1 | -1,
  bars: readonly Bar[],
  lookup: IntrabarLookup,
  intrabar: boolean,
): ReplayCursor {
  const cur = clampCursor(c, bars.length);
  if (dir > 0) {
    if (cur.index >= bars.length) return cur;
    const n = lookup(bars[cur.index].time)?.length ?? 0;
    if (cur.sub !== null) return cur.sub + 1 >= n ? { index: cur.index + 1, sub: null } : { index: cur.index, sub: cur.sub + 1 };
    return intrabar && n >= 2 ? { index: cur.index, sub: 1 } : { index: cur.index + 1, sub: null };
  }
  if (cur.sub !== null) return cur.sub > 1 ? { index: cur.index, sub: cur.sub - 1 } : { index: cur.index, sub: null };
  return { index: Math.max(1, cur.index - 1), sub: null };
}

/** Whether `a` is before `b`. */
export function cursorBefore(a: ReplayCursor, b: ReplayCursor): boolean {
  return a.index < b.index || (a.index === b.index && (a.sub ?? 0) < (b.sub ?? 0));
}

/**
 * The price units revealed going forward from `from` to `to`, in order — what a paper order sees happen: each
 * intrabar bar revealed, or each whole bar where its intrabar bars were not shown (the rest of a bar that was
 * forming at `from` is its remaining intrabar bars). Empty when `to` is not after `from`.
 */
export function revealedUnits(
  bars: readonly Bar[],
  from: ReplayCursor,
  to: ReplayCursor,
  lookup: IntrabarLookup,
): Bar[] {
  const a = clampCursor(from, bars.length);
  const b = clampCursor(to, bars.length);
  if (!cursorBefore(a, b)) return [];
  const out: Bar[] = [];
  for (let i = a.index; i <= b.index && i < bars.length; i++) {
    const startSub = i === a.index ? (a.sub ?? 0) : 0;
    // Through the end of bar i, unless it is the bar forming at `to`.
    const endSub = i === b.index ? b.sub : null;
    if (i === b.index && endSub === null) break;
    const minutes = lookup(bars[i].time);
    if (minutes && minutes.length) {
      const stop = endSub ?? minutes.length;
      for (let k = startSub; k < stop && k < minutes.length; k++) out.push(minutes[k]);
    } else if (startSub === 0 && endSub === null) {
      out.push(bars[i]);
    }
  }
  return out;
}

/** The index (whole bars shown) that puts the bar containing `timeMs` at the head; 1 when it is before the bars. */
export function indexAt(bars: readonly Bar[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}
