import {
  MdSourceStream,
  type MdBookListener,
  type MdFrameListener,
} from '@core/realtime/marketdata-stream';
import type { MdWatch } from '@core/realtime/marketdata-stream.service';
import type { MdHistory, MdHistoryRequest } from '@core/realtime/marketdata.types';
import { loadMdFixture } from '@core/realtime/testing/md-fixture';
import { TradeRing } from '@core/realtime/md-rings';
import {
  StreamHeatmap,
  pickHistorySource,
  streamHeatFits,
  streamWindowFor,
} from './stream-heatmap';
import { MAX_BUBBLES, bubbleAt, bubbleRadius, placeBubbles, TradeFeed } from './trade-bubbles';
import { streamHoverText } from './heatmap-primitive';

const fx = loadMdFixture();
const T0 = fx.book[0].t;
const T1 = fx.book[fx.book.length - 1].t;
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeWatch() {
  const book = new Set<MdBookListener>();
  const frames = new Set<MdFrameListener>();
  let released = false;
  const w: MdWatch = {
    symbol: 'EURUSD',
    version: (() => 0) as unknown as MdWatch['version'],
    status: (() => null) as unknown as MdWatch['status'],
    streams: () => [],
    stream: () => null,
    onFrame: (l) => (frames.add(l), () => frames.delete(l)),
    onBook: (l) => (book.add(l), () => book.delete(l)),
    release: () => (released = true),
  };
  return { w, book, frames, released: () => released };
}

function harness(answer: (r: MdHistoryRequest) => MdHistory) {
  let now = T1 + 1;
  const calls: MdHistoryRequest[] = [];
  const watches: ReturnType<typeof fakeWatch>[] = [];
  let changed = 0;
  const heat = new StreamHeatmap({
    history: async (r) => {
      calls.push(r);
      return answer(r);
    },
    watch: () => {
      const f = fakeWatch();
      watches.push(f);
      return f.w;
    },
    now: () => now,
    point: () => 0.00001,
    changed: () => changed++,
  });
  return { heat, calls, watches, setNow: (t: number) => (now = t), changed: () => changed };
}

const fullAnswer = (r: MdHistoryRequest): MdHistory => ({
  sources: [
    {
      sourceId: fx.sourceId,
      book: fx.book.filter((e) => e.t >= r.from && e.t < r.to),
      ticks: fx.ticks,
    },
  ],
  truncated: false,
  message: null,
});

describe('stream heatmap window rules', () => {
  it('widens the view by a margin, caps at now / the head, and refuses windows past the 2 h book cap', () => {
    expect(
      streamWindowFor(
        { fromUtc: 100_000, toUtc: 200_000, widthPx: 500, pricePerPx: null },
        1_000_000,
      ),
    ).toEqual({
      fromUtc: 75_000,
      toUtc: 225_000,
    });
    expect(
      streamWindowFor(
        { fromUtc: 100_000, toUtc: 200_000, widthPx: 500, pricePerPx: null },
        150_000,
      )!.toUtc,
    ).toBe(150_000);
    expect(streamHeatFits({ fromUtc: 0, toUtc: 80 * 60_000 })).toBe(true);
    expect(streamHeatFits({ fromUtc: 0, toUtc: 100 * 60_000 })).toBe(false);
  });

  it('picks the requested source, else the one with the most book', () => {
    const a = { sourceId: 'a', book: [fx.book[0]] };
    const b = { sourceId: 'b', book: fx.book.slice(0, 3) };
    expect(pickHistorySource([a, b], null)!.sourceId).toBe('b');
    expect(pickHistorySource([a, b], 'a')!.sourceId).toBe('a');
    expect(pickHistorySource([a, b], 'c')).toBeNull();
    expect(pickHistorySource([{ sourceId: 'x' }], null)).toBeNull();
  });
});

describe('StreamHeatmap', () => {
  const view = { fromUtc: T0, toUtc: T1, widthPx: 320, pricePerPx: null };

  it('reads the window from md/history, folds it at the zoom, and answers the exact book on hover', async () => {
    const h = harness(fullAnswer);
    h.heat.update({ symbol: 'eurusd', sourceId: null, view, head: null, live: false });
    expect(h.heat.state.kind).toBe('loading');
    await flush();
    expect(h.calls[0]).toMatchObject({ symbol: 'EURUSD', kinds: ['book', 'ticks'] });
    expect(h.calls[0].sourceIds).toBeUndefined();
    const layer = h.heat.layer()!;
    expect(layer.sourceId).toBe(fx.sourceId);
    expect(layer.timeline.length).toBe(fx.book.length);
    expect(layer.robustMax).toBeGreaterThan(0);
    // Columns ≈ px over the fetched window (view ± 25 %).
    expect(layer.folder.spec.cols).toBeGreaterThan(300);
    // Hover at the time of the 10th event, at its first bid level: the size the book held then.
    const e = fx.book[10];
    const book = layer.timeline.at(e.t);
    const [p] = book.bidLevels()[0];
    const lines = streamHoverText(layer, 'MetaQuotes-Demo DOM', e.t, p, 5)!;
    expect(lines[0]).toBe(`MetaQuotes-Demo DOM · ${p.toFixed(5)}`);
    expect(lines[1]).toMatch(/resting \(size as reported\) at \d\d:\d\d:\d\d\.\d{3} UTC/);
    expect(lines.at(-1)).toMatch(/^Best /);
  });

  it('does not refetch for a small pan, re-folds on a zoom, refetches outside the window', async () => {
    const h = harness(fullAnswer);
    h.heat.update({ symbol: 'EURUSD', sourceId: null, view, head: null, live: false });
    await flush();
    const first = h.heat.layer()!.folder;
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: null,
      view: { ...view, fromUtc: T0 + 500, toUtc: T1 + 500 },
      head: null,
      live: false,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.heat.layer()!.folder).toBe(first);
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: null,
      view: { ...view, widthPx: 1200 },
      head: null,
      live: false,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.heat.layer()!.folder).not.toBe(first);
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: null,
      view: { ...view, fromUtc: T0 - 60_000, toUtc: T1 - 60_000 },
      head: null,
      live: false,
    });
    expect(h.calls).toHaveLength(2);
  });

  it('live: appends the hub book events and ticks to the timeline and folds them as time passes', async () => {
    const early = (r: MdHistoryRequest): MdHistory => ({
      sources: [
        {
          sourceId: fx.sourceId,
          book: fx.book.slice(0, 60).filter((e) => e.t < r.to),
          ticks: { t: [], b: [], a: [] },
        },
      ],
      truncated: false,
      message: null,
    });
    const h = harness(early);
    h.setNow(fx.book[59].t + 1);
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: fx.sourceId,
      view: { ...view, toUtc: fx.book[59].t },
      head: null,
      live: true,
    });
    await flush();
    expect(h.watches).toHaveLength(1);
    const w = h.watches[0];
    const stream = new MdSourceStream('EURUSD', fx.sourceId);
    for (const l of w.book) l(stream, fx.book.slice(60, 100), false);
    for (const l of w.frames)
      l({ symbol: 'EURUSD', sourceId: fx.sourceId, ticks: fx.ticks }, stream);
    h.setNow(fx.book[99].t + 1);
    const layer = h.heat.layer()!;
    expect(layer.live).toBe(true);
    expect(layer.timeline.length).toBe(100);
    expect(layer.ticks.size).toBe(fx.ticks.t.length);
    expect(layer.foldedTo).toBe(fx.book[99].t + 1);
    const c = layer.folder.colOf(fx.book[99].t);
    expect(
      layer.folder.data
        .subarray(c * layer.folder.spec.rows, (c + 1) * layer.folder.spec.rows)
        .some((v) => v > 0),
    ).toBe(true);
    // Leaving the live edge releases the hub watch.
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: fx.sourceId,
      view: { ...view, toUtc: fx.book[59].t },
      head: null,
      live: false,
    });
    expect(w.released()).toBe(true);
  });

  it('replay: folds only to the head, and moving the head back re-folds without a fetch', async () => {
    const h = harness(fullAnswer);
    const head = fx.book[80].t;
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: null,
      view: { ...view, toUtc: head },
      head,
      live: true,
    });
    await flush();
    expect(h.watches).toHaveLength(0);
    expect(h.calls[0].to).toBeLessThanOrEqual(head);
    const l1 = h.heat.layer()!;
    expect(l1.foldedTo).toBe(head);
    const back = fx.book[40].t;
    h.heat.update({
      symbol: 'EURUSD',
      sourceId: null,
      view: { ...view, toUtc: head },
      head: back,
      live: true,
    });
    const l2 = h.heat.layer()!;
    expect(h.calls).toHaveLength(1);
    expect(l2.foldedTo).toBe(back);
    const after = l2.folder.colOf(back) + 2;
    if (after < l2.folder.spec.cols)
      expect(
        l2.folder.data
          .subarray(after * l2.folder.spec.rows, (after + 1) * l2.folder.spec.rows)
          .every((v) => v === 0),
      ).toBe(true);
  });

  it('says why when the window holds no book', async () => {
    const h = harness(() => ({ sources: [], truncated: false, denied: ['cme-l2'], message: null }));
    h.heat.update({ symbol: 'EURUSD', sourceId: null, view, head: null, live: false });
    await flush();
    expect(h.heat.state).toEqual({
      kind: 'error',
      message: 'no book stored for EURUSD in this window (not entitled to cme-l2)',
    });
    expect(h.heat.layer()).toBeNull();
  });
});

describe('trade bubbles', () => {
  // Trades are only ever recorded venue data; these are the C3 SHAPE with sizes chosen to exercise the maths.
  const ring = new TradeRing(64);
  ring.pushColumns({
    t: [10, 20, 30, 40],
    p: [1.1, 1.2, 1.3, 1.4],
    s: [1, 4, 100, 9],
    side: ['B', 'S', '', 'B'],
  });

  it('sizes by area against the reference max', () => {
    expect(bubbleRadius(100, 100)).toBe(18);
    expect(bubbleRadius(25, 100)).toBe(9);
    expect(bubbleRadius(0, 100)).toBe(2);
  });

  it('places trades in the window above the minimum, large ones painted last, and hit-tests them', () => {
    const placed = placeBubbles(
      ring,
      0,
      35,
      2,
      100,
      (t) => t * 10,
      (p) => p * 100,
      1000,
      1000,
    );
    expect(placed.map((b) => b.size)).toEqual([4, 100]);
    expect(placed.map((b) => b.side)).toEqual([-1, 0]);
    expect(bubbleAt(placed, 300, 130)!.size).toBe(100);
    expect(bubbleAt(placed, 900, 900)).toBeNull();
    expect(MAX_BUBBLES).toBeGreaterThan(1000);
  });

  it('TradeFeed reads the window and appends live trade frames', async () => {
    const watches: ReturnType<typeof fakeWatch>[] = [];
    let changed = 0;
    const feed = new TradeFeed({
      history: async () => ({
        sources: [
          { sourceId: 'cme-6e', trades: { t: [1, 2], p: [1.1, 1.1], s: [3, 5], side: ['B', 'S'] } },
        ],
        truncated: false,
        message: null,
      }),
      watch: () => {
        const f = fakeWatch();
        watches.push(f);
        return f.w;
      },
      now: () => 1000,
      changed: () => changed++,
    });
    feed.update({
      symbol: 'EURUSD',
      sourceId: 'cme-6e',
      fromUtc: 0,
      toUtc: 1000,
      head: null,
      live: true,
    });
    await flush();
    expect(feed.ring.size).toBe(2);
    expect(feed.state.kind).toBe('ready');
    for (const l of watches[0].frames)
      l(
        { symbol: 'EURUSD', sourceId: 'cme-6e', trades: { t: [3], p: [1.2], s: [7], side: ['S'] } },
        new MdSourceStream('EURUSD', 'cme-6e'),
      );
    expect(feed.ring.size).toBe(3);
    expect(changed).toBeGreaterThan(1);
  });
});
