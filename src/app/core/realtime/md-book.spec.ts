import { BookState, BookTimeline, CHECKPOINT_EVERY } from './md-book';
import { TickRing, TradeRing } from './md-rings';
import type { MdBookEventWire, MdLevel } from './marketdata.types';
import { loadMdFixture } from './testing/md-fixture';

const fixture = loadMdFixture();

const events = fixture.book;

/** An independent fold (the engine's BookFold rules), for comparison. */
function refFold(evs: readonly MdBookEventWire[], upTo: number): { b: Map<number, number>; a: Map<number, number>; known: boolean } {
  const b = new Map<number, number>();
  const a = new Map<number, number>();
  let known = false;
  for (const e of evs) {
    if (e.t > upTo) break;
    if (e.k === 'S') {
      b.clear();
      a.clear();
      known = true;
    } else if (!known) continue;
    for (const [p, s] of e.b) (s > 0 ? b.set(p, s) : b.delete(p));
    for (const [p, s] of e.a) (s > 0 ? a.set(p, s) : a.delete(p));
  }
  return { b, a, known };
}

describe('BookState', () => {
  it('applies a snapshot then deltas with absolute sizes; size 0 removes', () => {
    const s = new BookState();
    s.apply({ t: 1, k: 'S', b: [[1.1, 5], [1.09, 3]], a: [[1.11, 4]] });
    s.apply({ t: 2, k: 'D', b: [[1.1, 0], [1.095, 7]], a: [[1.11, 9], [1.12, 1]] });
    expect(s.bidLevels()).toEqual([[1.095, 7], [1.09, 3]]);
    expect(s.askLevels()).toEqual([[1.11, 9], [1.12, 1]]);
    expect(s.bestBid()).toBe(1.095);
    expect(s.bestAsk()).toBe(1.11);
    expect(s.t).toBe(2);
    expect(s.toKeyframe(3)).toEqual({ t: 3, b: [[1.095, 7], [1.09, 3]], a: [[1.11, 9], [1.12, 1]] });
  });

  it('refuses a delta on an unknown book and counts it', () => {
    const s = new BookState();
    expect(s.apply({ t: 1, k: 'D', b: [[1.1, 5]], a: [] })).toBe(false);
    expect(s.known).toBe(false);
    expect(s.orphanDeltas).toBe(1);
    expect(s.bestBid()).toBeNull();
  });

  it('matches an independent fold over the recorded EURUSD book', () => {
    const s = new BookState();
    for (const e of events) s.apply(e);
    const ref = refFold(events, Infinity);
    expect(new Map(s.bidLevels())).toEqual(ref.b);
    expect(new Map(s.askLevels())).toEqual(ref.a);
    // Best bid below best ask on the real book.
    expect(s.bestBid()!).toBeLessThan(s.bestAsk()!);
  });
});

describe('BookTimeline', () => {
  it('answers the book at any instant, equal to a fold from the start, in any order of questions', () => {
    // Replicate the recorded events past a few checkpoints (times shifted, so they stay ascending).
    const span = events[events.length - 1].t - events[0].t + 1;
    const long: MdBookEventWire[] = [];
    for (let r = 0; r < 4; r++) for (const e of events) long.push({ ...e, t: e.t + r * span });
    expect(long.length).toBeGreaterThan(CHECKPOINT_EVERY * 2);
    const tl = new BookTimeline();
    tl.appendAll(long);
    const probes = [long[0].t - 1, long[3].t, long[300].t, long[599].t, long[17].t + 1, long[450].t, long[long.length - 1].t + 5];
    for (const t of probes) {
      const got = tl.at(t);
      const ref = refFold(long, t);
      expect(got.known).toBe(ref.known);
      expect(new Map(got.bidLevels() as MdLevel[])).toEqual(ref.b);
      expect(new Map(got.askLevels() as MdLevel[])).toEqual(ref.a);
    }
  });

  it('starts from a keyframe and drops events older than the newest', () => {
    const tl = new BookTimeline({ t: 10, b: [[1.1, 1]], a: [[1.2, 1]] });
    expect(tl.at(10).bestBid()).toBe(1.1);
    expect(tl.append({ t: 11, k: 'D', b: [[1.15, 2]], a: [] })).toBe(true);
    expect(tl.append({ t: 9, k: 'D', b: [[1.0, 2]], a: [] })).toBe(false);
    expect(tl.droppedOutOfOrder).toBe(1);
    expect(tl.at(11).bestBid()).toBe(1.15);
    expect(tl.head.bestBid()).toBe(1.15);
    expect(tl.firstTime).toBe(10);
    expect(tl.lastTime).toBe(11);
  });
});

describe('rings', () => {
  it('keeps the newest ticks, in order, and slices by time', () => {
    const r = new TickRing(4);
    for (let i = 0; i < 6; i++) r.push(100 + i, 1 + i / 100, 1.0001 + i / 100);
    expect(r.size).toBe(4);
    expect(r.timeAt(0)).toBe(102);
    expect(r.timeAt(3)).toBe(105);
    expect(r.push(104, 1, 1)).toBe(false);
    expect(r.lowerBound(104)).toBe(2);
    expect(r.slice(103, 105).t).toEqual([103, 104]);
    expect(r.last()).toEqual({ t: 105, bid: 1.05, ask: 1.0501 });
  });

  it('takes recorded C1 columns', () => {
    const r = new TickRing();
    const kept = r.pushColumns(fixture.ticks);
    expect(kept).toBe(fixture.ticks.t.length);
    expect(r.bidAt(0)).toBe(fixture.ticks.b[0]);
  });

  it('stores trade sides as codes', () => {
    const r = new TradeRing(8);
    r.pushColumns({ t: [1, 2, 3], p: [1.1, 1.2, 1.3], s: [5, 6, 7], side: ['B', 'S', ''] });
    expect([r.sideAt(0), r.sideAt(1), r.sideAt(2)]).toEqual([1, -1, 0]);
    expect(r.sizeAt(2)).toBe(7);
  });
});
