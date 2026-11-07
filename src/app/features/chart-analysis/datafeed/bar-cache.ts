/**
 * The bar cache's bookkeeping (multi-asset chart program UD03): which stretches of a series the cache HOLDS, so it never
 * serves a gap. Pure.
 *
 * Before: the cache served any window whose oldest cached bar was before `from` and that held at least ONE bar
 * (`Math.min(countBack, 1)`), and merged every fetch into one list — two loads that did not touch (a deep link to
 * March, then today) made a cache that answered "March to today" with everything in between missing, and a window
 * ending now came back with the newest bar as it was when first fetched. Now each fetch records the span it covers;
 * spans join only when they overlap or touch; a window is served only from inside one span, with its full count (or the
 * span reaching the start of history); and a span never claims anything after the newest bar a live fetch saw.
 */

/** One stretch the cache holds completely: every bar whose open is in [from, to] is cached. */
export interface Coverage {
  from: number;
  to: number;
}

/** What one fetch covered. */
export function coverageOf(
  bars: readonly { time: number }[],
  opts: {
    /** The fetch's `to` (inclusive). */
    toMs: number;
    /** The fetch asked up to now: nothing after its newest bar is known. */
    live: boolean;
    /** The engine returned fewer rows than asked: nothing older exists. */
    reachedStart: boolean;
    /** The oldest bar may be partial (a client-side fold whose first bucket lacks earlier source rows). */
    oldestPartial?: boolean;
  },
): Coverage | null {
  if (bars.length === 0) return opts.reachedStart ? { from: -Infinity, to: opts.toMs } : null;
  const oldest = bars[0].time;
  const newest = bars[bars.length - 1].time;
  const from = opts.reachedStart ? -Infinity : opts.oldestPartial ? oldest + 1 : oldest;
  const to = opts.live ? newest : opts.toMs;
  return to >= from ? { from, to } : null;
}

/** `spans` with `next` added: spans that overlap or touch (1 ms apart) join; the result is sorted and disjoint. */
export function addCoverage(spans: readonly Coverage[], next: Coverage | null): Coverage[] {
  if (!next) return spans.slice();
  const all = [...spans, next].sort((a, b) => a.from - b.from);
  const out: Coverage[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/**
 * The cached answer to "at least the last `countBack` bars at or before `toMs`, those from `fromMs` on" (every held bar
 * of the window) — or null when the cache
 * cannot answer it without a gap: `toMs` is outside every span, the span holds fewer than `countBack` bars before
 * `toMs` without reaching the start of history, or the answer is empty (the fetch decides "no data").
 */
export function serveFromCache<T extends { time: number }>(
  bars: readonly T[],
  spans: readonly Coverage[],
  fromMs: number,
  toMs: number,
  countBack: number,
): T[] | null {
  const span = spans.find((s) => s.from <= toMs && toMs <= s.to);
  if (!span) return null;
  const inSpan = bars.filter((b) => b.time >= span.from && b.time <= toMs);
  const want = Math.max(1, Math.round(countBack));
  if (inSpan.length < want && span.from !== -Infinity) return null;
  // At least `countBack` (as a fetch answers), and every held bar of the window from `fromMs` on.
  const answer = inSpan.filter((b) => b.time >= fromMs);
  return answer.length ? answer : null;
}
