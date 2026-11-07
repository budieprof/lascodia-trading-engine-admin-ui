import { describe, expect, it } from 'vitest';
import { addCoverage, coverageOf, serveFromCache } from './bar-cache';

const bars = (...t: number[]) => t.map((time) => ({ time }));

describe('bar cache coverage (UD03: never serve a gap)', () => {
  it('a fetch covers from its oldest bar to its `to`; a live one only to its newest bar', () => {
    expect(coverageOf(bars(10, 20, 30), { toMs: 35, live: false, reachedStart: false })).toEqual({
      from: 10,
      to: 35,
    });
    expect(coverageOf(bars(10, 20, 30), { toMs: 99, live: true, reachedStart: false })).toEqual({
      from: 10,
      to: 30,
    });
    expect(coverageOf(bars(10, 20), { toMs: 25, live: false, reachedStart: true })).toEqual({
      from: -Infinity,
      to: 25,
    });
    expect(
      coverageOf(bars(10, 20), { toMs: 25, live: false, reachedStart: false, oldestPartial: true }),
    ).toEqual({
      from: 11,
      to: 25,
    });
  });

  it('spans join only when they overlap or touch', () => {
    const a = addCoverage([], { from: 100, to: 200 });
    expect(addCoverage(a, { from: 50, to: 99 })).toEqual([{ from: 50, to: 200 }]);
    expect(addCoverage(a, { from: 300, to: 400 })).toEqual([
      { from: 100, to: 200 },
      { from: 300, to: 400 },
    ]);
  });

  it('serves only inside one span, with the full count, never across a gap', () => {
    const cached = bars(100, 110, 120, 300, 310, 320);
    const spans = [
      { from: 100, to: 120 },
      { from: 300, to: 320 },
    ];
    // Inside the newer span with enough bars.
    expect(serveFromCache(cached, spans, 250, 320, 3)?.map((b) => b.time)).toEqual([300, 310, 320]);
    // Asks for more than the span holds: the gap 120..300 must be fetched (before: served with one bar).
    expect(serveFromCache(cached, spans, 0, 320, 4)).toBeNull();
    // Between the spans: not held.
    expect(serveFromCache(cached, spans, 0, 200, 1)).toBeNull();
    // A span that reaches the start of history answers short.
    expect(serveFromCache(bars(5, 6), [{ from: -Infinity, to: 10 }], 0, 10, 50)?.length).toBe(2);
    // `from` trims.
    expect(serveFromCache(cached, spans, 310, 320, 3)?.map((b) => b.time)).toEqual([310, 320]);
  });
});
