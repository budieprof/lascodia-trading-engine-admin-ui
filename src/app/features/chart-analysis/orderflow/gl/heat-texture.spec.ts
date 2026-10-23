import { BookTimeline } from '@core/realtime/md-book';
import type { MdBookEventWire } from '@core/realtime/marketdata.types';
import { loadMdFixture } from '@core/realtime/testing/md-fixture';
import { FakeHeatSurface, heatLutBytes, quadVertices } from './heat-gl';
import { PRICE_SLABS, heatQuads, timeAtX } from './heat-layout';
import {
  HeatFolder,
  STALE_BOOK_MS,
  bookLevelStep,
  bookPriceRange,
  heatSpecFor,
  quoteColumns,
  timeSegments,
  type HeatTextureSpec,
} from './heat-texture';
import { TickRing } from '@core/realtime/md-rings';

const fx = loadMdFixture();

/** Reference: per column, the max over the column's span of each row's summed size (book folded event by event). */
function reference(events: readonly MdBookEventWire[], spec: HeatTextureSpec): Float32Array {
  const out = new Float32Array(spec.cols * spec.rows);
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let known = false;
  let lastT = -Infinity;
  const sums = () => {
    const m = new Map<number, number>();
    for (const side of [bids, asks])
      for (const [p, s] of side) {
        const r = Math.round((p - spec.p0) / spec.rowStep);
        m.set(r, (m.get(r) ?? 0) + s);
      }
    return m;
  };
  const take = (c: number) => {
    if (!known) return;
    for (const [r, v] of sums())
      if (r >= 0 && r < spec.rows && v > out[c * spec.rows + r]) out[c * spec.rows + r] = v;
  };
  let i = 0;
  for (let c = 0; c < spec.cols; c++) {
    const start = spec.t0 + c * spec.colMs;
    const end = start + spec.colMs;
    while (i < events.length && events[i].t < start) apply(events[i++]);
    if (known && start - lastT <= STALE_BOOK_MS) take(c);
    while (i < events.length && events[i].t < end) {
      apply(events[i++]);
      take(c);
    }
  }
  return out;
  function apply(e: MdBookEventWire) {
    if (e.k === 'S') {
      bids.clear();
      asks.clear();
      known = true;
    } else if (!known) return;
    for (const [p, s] of e.b) {
      if (s > 0) bids.set(p, s);
      else bids.delete(p);
    }
    for (const [p, s] of e.a) {
      if (s > 0) asks.set(p, s);
      else asks.delete(p);
    }
    lastT = e.t;
  }
}

function specOver(events: readonly MdBookEventWire[], cols: number): HeatTextureSpec {
  const tl = new BookTimeline();
  tl.appendAll(events);
  const range = bookPriceRange(tl)!;
  return heatSpecFor({
    fromUtc: events[0].t,
    toUtc: events[events.length - 1].t + 1,
    widthPx: cols,
    pLow: range.lo,
    pHigh: range.hi,
    levelStep: bookLevelStep(events, 0.00001),
    pricePerPx: null,
  })!;
}

describe('HeatFolder', () => {
  it('folds every recorded book event: each cell = the largest size in its row during its column', () => {
    for (const cols of [7, 64, 400]) {
      const spec = specOver(fx.book, cols);
      const tl = new BookTimeline();
      tl.appendAll(fx.book);
      const f = new HeatFolder(spec, tl);
      f.advanceTo(spec.t0 + spec.cols * spec.colMs);
      const ref = reference(fx.book, spec);
      expect(Array.from(f.data)).toEqual(Array.from(ref));
      expect(f.outOfRange).toBe(0);
      expect(f.robustMax()).toBeGreaterThan(0);
    }
  });

  it('folding live in small steps gives the same grid as one pass', () => {
    const spec = specOver(fx.book, 120);
    const tlA = new BookTimeline();
    tlA.appendAll(fx.book);
    const one = new HeatFolder(spec, tlA);
    one.advanceTo(Infinity);
    // Live: events arrive in hub-sized batches and the folder is advanced to "now" after each.
    const tlB = new BookTimeline();
    const live = new HeatFolder(spec, tlB);
    for (let i = 0; i < fx.book.length; i += 7) {
      tlB.appendAll(fx.book.slice(i, i + 7));
      live.advanceTo(fx.book[Math.min(fx.book.length - 1, i + 6)].t + 0.5);
    }
    live.advanceTo(Infinity);
    expect(Array.from(live.data)).toEqual(Array.from(one.data));
    expect(Array.from(live.bestBid)).toEqual(Array.from(one.bestBid));
  });

  it('leaves columns empty before the first snapshot and after the feed went silent', () => {
    const first = fx.book.findIndex((e) => e.k === 'S');
    expect(first).toBe(0);
    const orphan: MdBookEventWire = { ...fx.book[1], t: fx.book[0].t - 5_000 };
    const silent = STALE_BOOK_MS + 30_000;
    const later = fx.book
      .slice(1, 5)
      .map((e, k) => ({ ...e, k: 'D' as const, t: fx.book[0].t + silent + k }));
    const events = [orphan, fx.book[0], ...later];
    const spec: HeatTextureSpec = {
      ...specOver(fx.book, 10),
      t0: orphan.t,
      colMs: 1_000,
      cols: Math.ceil((silent + 10_000) / 1_000),
    };
    const tl = new BookTimeline();
    tl.appendAll(events);
    const f = new HeatFolder(spec, tl);
    f.advanceTo(Infinity);
    const colSum = (c: number) =>
      f.data.subarray(c * spec.rows, (c + 1) * spec.rows).reduce((a, b) => a + b, 0);
    expect(colSum(0)).toBe(0); // only the orphan delta: unknown book
    expect(colSum(5)).toBeGreaterThan(0); // the snapshot
    expect(colSum(5 + Math.floor(STALE_BOOK_MS / 1000) + 5)).toBe(0); // silent > 65 s
    expect(colSum(f.colOf(later[0].t))).toBeGreaterThan(0); // deltas on the (known, old) book light it again
  });

  it('reports dirty columns for partial uploads', () => {
    const spec = specOver(fx.book, 50);
    const tl = new BookTimeline();
    const f = new HeatFolder(spec, tl);
    const gl = new FakeHeatSurface();
    tl.appendAll(fx.book.slice(0, 40));
    f.advanceTo(fx.book[39].t + 1);
    gl.sync(f);
    expect(gl.uploads[0]).toMatchObject({ full: true });
    tl.appendAll(fx.book.slice(40, 60));
    f.advanceTo(fx.book[59].t + 1);
    gl.sync(f);
    expect(gl.uploads[1].full).toBe(false);
    expect(gl.uploads[1].from).toBeGreaterThanOrEqual(f.colOf(fx.book[39].t));
    expect(gl.uploads[1].to).toBe(f.colOf(fx.book[59].t));
  });

  it('answers the painted cell under a time and price', () => {
    const spec = specOver(fx.book, 50);
    const tl = new BookTimeline();
    tl.appendAll(fx.book);
    const f = new HeatFolder(spec, tl);
    f.advanceTo(Infinity);
    const [p, s] = fx.book[0].b[0];
    const cell = f.cellAt(fx.book[0].t, p)!;
    expect(cell.price).toBeCloseTo(p, 8);
    expect(cell.size).toBeGreaterThanOrEqual(s);
    expect(f.cellAt(spec.t0 - 10, p)).toBeNull();
  });
});

describe('heat spec + layout', () => {
  it('sizes rows to the book step, coarser when a pixel holds several, and caps them', () => {
    const s = heatSpecFor({
      fromUtc: 0,
      toUtc: 60_000,
      widthPx: 600,
      pLow: 1.1,
      pHigh: 1.101,
      levelStep: 0.00001,
      pricePerPx: null,
    })!;
    expect(s.cols).toBe(600);
    expect(s.colMs).toBe(100);
    expect(s.rowStep).toBeCloseTo(0.00001, 10);
    const coarse = heatSpecFor({
      fromUtc: 0,
      toUtc: 60_000,
      widthPx: 600,
      pLow: 1.1,
      pHigh: 1.101,
      levelStep: 0.00001,
      pricePerPx: 0.000035,
    })!;
    expect(coarse.rowStep).toBeCloseTo(0.00004, 10);
    const wide = heatSpecFor({
      fromUtc: 0,
      toUtc: 60_000,
      widthPx: 600,
      pLow: 1,
      pHigh: 1.5,
      levelStep: 0.00001,
      pricePerPx: null,
    })!;
    expect(wide.rows).toBeLessThanOrEqual(2_048);
  });

  it('splits the time axis at session gaps', () => {
    const m = 60_000;
    const bars = [0, m, 2 * m, 10 * m, 11 * m];
    expect(timeSegments(bars, m, 0, 12 * m)).toEqual([
      { t0: 0, t1: 3 * m },
      { t0: 10 * m, t1: 12 * m },
    ]);
    expect(timeSegments([], m, 5, 10)).toEqual([{ t0: 5, t1: 10 }]);
  });

  it('builds one quad per run and price slab, mapped to texture coordinates, and inverts x', () => {
    const spec: HeatTextureSpec = { t0: 0, colMs: 10, cols: 100, p0: 1, rowStep: 0.001, rows: 64 };
    const xAt = (t: number) => t / 2; // 1000 ms → 500 px
    const yAt = (p: number) => 1000 - (p - 1) * 10_000;
    const quads = heatQuads(spec, [{ t0: 0, t1: 1000 }], xAt, yAt, 800, 1000);
    expect(quads).toHaveLength(PRICE_SLABS);
    expect(quads[0]).toMatchObject({ x0: 0, x1: 500, c0: 0, c1: 100, r0: 0 });
    expect(quads[0].y0).toBeCloseTo(1005, 6);
    expect(quadVertices(quads)).toHaveLength(PRICE_SLABS * 24);
    expect(timeAtX([{ t0: 0, t1: 1000 }], xAt, 250)).toBe(500);
    expect(timeAtX([{ t0: 0, t1: 1000 }], xAt, 900)).toBeNull();
  });

  it('takes the last quote of each column from the tick ring', () => {
    const r = new TickRing();
    r.pushColumns(fx.ticks);
    const spec = { t0: fx.ticks.t[0], colMs: 1_000, cols: 20 };
    const q = quoteColumns(r, spec);
    const lastInFirst = fx.ticks.t.filter((t) => t < spec.t0 + 1000).length - 1;
    expect(q.bid[0]).toBe(fx.ticks.b[lastInFirst]);
  });

  it('builds the colour LUT from the canvas ramp', () => {
    const lut = heatLutBytes();
    expect(lut).toHaveLength(1024);
    expect(lut[3]).toBe(Math.round(0.12 * 255));
    expect(lut[255 * 4 + 3]).toBe(Math.round(0.95 * 255));
  });
});
