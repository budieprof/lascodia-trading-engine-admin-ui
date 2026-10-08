import type { Bar } from '../datafeed/candle-feed.service';

/**
 * The bars the chart plots, kept up to date from the newest bar that changed rather than rebuilt per
 * tick (CC-I1). A live price replaces the newest bar; a minute resync or the engine's session tail
 * replaces the last few; scroll-back prepends history. Only the last two leave everything before
 * them as it was, and only they may be applied as a tail.
 *
 * Pure: no chart, no Angular.
 */

/** Whether two bars are the same bar with the same prices. */
export function sameBar(a: Bar, b: Bar): boolean {
  return (
    a === b ||
    (a.time === b.time &&
      a.open === b.open &&
      a.high === b.high &&
      a.low === b.low &&
      a.close === b.close &&
      a.volume === b.volume &&
      a.closeTime === b.closeTime)
  );
}

/**
 * The first index at which `next` differs from `prev` (`next.length` when it only adds bars, the
 * shorter length when one ends early). By reference first — a tick keeps every older bar object — and
 * by value where a resync rebuilt them.
 */
export function firstChangedBar(prev: readonly Bar[], next: readonly Bar[]): number {
  const common = Math.min(prev.length, next.length);
  let i = 0;
  while (i < common && sameBar(prev[i], next[i])) i++;
  return i;
}

/** Whether `next` starts earlier than `prev` — history loaded on the left. */
export function isPrepend(prev: readonly Bar[], next: readonly Bar[]): boolean {
  return prev.length > 0 && next.length > 0 && next[0].time < prev[0].time;
}

/**
 * Heikin-Ashi bars of `raw`, reusing `prev` (the Heikin-Ashi bars of the series before it changed)
 * up to `from`: each Heikin-Ashi open is the previous Heikin-Ashi bar's midpoint, so the bars before
 * the first change are unchanged and the rest follow from the last of them.
 *
 * Close is the bar's own average; open is the running average of the PREVIOUS HA bar, so the series
 * is recursive and cannot be computed per bar in isolation.
 */
export function heikinAshiFrom(raw: readonly Bar[], prev: readonly Bar[], from: number): Bar[] {
  const start = Math.max(0, Math.min(from, prev.length, raw.length));
  const out = prev.slice(0, start);
  for (let i = start; i < raw.length; i++) {
    const b = raw[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: b.time,
      open,
      close,
      high: Math.max(b.high, open, close),
      low: Math.min(b.low, open, close),
      volume: b.volume,
    });
  }
  return out;
}

/**
 * `bars` with every time moved into the display time zone (`shiftMs` of the bar's own instant),
 * reusing `prev` — the same bars shifted before they changed — up to `from`.
 */
export function shiftedFrom(
  bars: readonly Bar[],
  prev: readonly Bar[],
  from: number,
  shiftMs: ((utcMs: number) => number) | null,
): Bar[] {
  if (!shiftMs) return bars as Bar[];
  const start = Math.max(0, Math.min(from, prev.length, bars.length));
  const out = prev.slice(0, start);
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    out.push({ ...b, time: b.time + shiftMs(b.time) });
  }
  return out;
}

/** Index of the plotted bar at `time` (ms), or -1 — a binary search; bars are ascending. */
export function indexAtTime(bars: readonly { time: number }[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
