import type { MdHistory, MdHistoryRequest } from '@core/realtime/marketdata.types';
import { loadMdFixture } from '@core/realtime/testing/md-fixture';
import type { Bar } from '../datafeed/candle-feed.service';
import { ReplayController } from './replay-controller';
import {
  CHUNK_MS,
  TickReplay,
  TickTape,
  footprintRowsFromTape,
  formingBarFromTicks,
  tickReplayView,
} from './tick-replay';

const fx = loadMdFixture();
const T0 = Math.min(fx.book[0].t, fx.ticks.t[0]);
const T1 = Math.max(fx.book[fx.book.length - 1].t, fx.ticks.t[fx.ticks.t.length - 1]);
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The recorded fixture as md/history would answer a window of it (keyframe = the book folded before `from`). */
function recorded(r: MdHistoryRequest): MdHistory {
  const before = fx.book.filter((e) => e.t < r.from);
  let keyframe = null;
  if (before.length) {
    const b = new Map<number, number>();
    const a = new Map<number, number>();
    for (const e of before) {
      if (e.k === 'S') {
        b.clear();
        a.clear();
      }
      for (const [p, s] of e.b) {
        if (s > 0) b.set(p, s);
        else b.delete(p);
      }
      for (const [p, s] of e.a) {
        if (s > 0) a.set(p, s);
        else a.delete(p);
      }
    }
    keyframe = { t: r.from, b: [...b] as [number, number][], a: [...a] as [number, number][] };
  }
  const idx = fx.ticks.t
    .map((t, i) => [t, i] as const)
    .filter(([t]) => t >= r.from && t < r.to)
    .map(([, i]) => i);
  return {
    sources: [
      {
        sourceId: fx.sourceId,
        keyframe,
        book: fx.book.filter((e) => e.t >= r.from && e.t < r.to),
        ticks: {
          t: idx.map((i) => fx.ticks.t[i]),
          b: idx.map((i) => fx.ticks.b[i]),
          a: idx.map((i) => fx.ticks.a[i]),
        },
      },
    ],
    truncated: false,
    message: null,
  };
}

function harness(now = T1 + 1) {
  const frames: ((t: number) => void)[] = [];
  let wall = 0;
  const calls: MdHistoryRequest[] = [];
  const moves: [number, number][] = [];
  const tr = new TickReplay({
    history: async (r) => {
      calls.push(r);
      return recorded(r);
    },
    symbol: () => 'EURUSD',
    sourceId: () => null,
    now: () => now,
    raf: (cb) => frames.push(cb),
    caf: () => undefined,
    wall: () => wall,
    moved: (a, b) => moves.push([a, b]),
  });
  return {
    tr,
    calls,
    moves,
    /** Run one animation frame `ms` of wall time later. */
    frame(ms: number) {
      wall += ms;
      const f = frames.shift();
      f?.(wall);
    },
  };
}

describe('TickTape', () => {
  it('finds the next / previous event across ticks and book, and the last tick at an instant', () => {
    const tape = new TickTape(T0);
    tape.append({ ticks: fx.ticks, book: fx.book }, T1 + 1);
    const all = [...new Set([...fx.ticks.t, ...fx.book.map((e) => e.t)])].sort((a, b) => a - b);
    let t = T0 - 1;
    const walked: number[] = [];
    for (let i = 0; i < 40; i++) {
      const n = tape.nextEventAfter(t)!;
      walked.push(n);
      t = n;
    }
    expect(walked).toEqual(all.slice(0, 40));
    expect(tape.prevEventBefore(walked[10])).toBe(walked[9]);
    const q = tape.lastTick(fx.ticks.t[5]);
    expect(q).toEqual({ t: fx.ticks.t[5], bid: fx.ticks.b[5], ask: fx.ticks.a[5] });
    expect(tape.ticksIn(fx.ticks.t[2], fx.ticks.t[4]).map((x) => x.t)).toEqual([
      fx.ticks.t[3],
      fx.ticks.t[4],
    ]);
  });

  it('folds the forming bar from bid ticks; a bar with no tick yet is not drawn', () => {
    const tape = new TickTape(T0);
    tape.append({ ticks: fx.ticks }, T1 + 1);
    const bar: Bar = { time: fx.ticks.t[0], open: 9, high: 9, low: 9, close: 9, volume: 0 };
    const head = fx.ticks.t[9];
    const f = formingBarFromTicks(bar, tape, head)!;
    const bids = fx.ticks.b.slice(0, 10);
    expect(f).toMatchObject({
      open: bids[0],
      close: bids[9],
      high: Math.max(...bids),
      low: Math.min(...bids),
      volume: 10,
    });
    const bars: Bar[] = [
      { time: fx.ticks.t[0] - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      bar,
      { time: fx.ticks.t[0] + 60_000, open: 2, high: 2, low: 2, close: 2, volume: 1 },
    ];
    const view = tickReplayView(bars, head, (i) => bars[i].time + 60_000, tape);
    expect(view).toHaveLength(2);
    expect(view[1].close).toBe(bids[9]);
    expect(
      tickReplayView(bars, bars[1].time + 60_000, (i) => bars[i].time + 60_000, tape),
    ).toHaveLength(2);
  });
});

describe('footprint from the tape', () => {
  it('counts the tick rule over mids at bid prices, carrying direction through unchanged mids and into the window', () => {
    const tape = new TickTape(T0);
    tape.append({ ticks: fx.ticks }, T1 + 1);
    const from = fx.ticks.t[10];
    const to = fx.ticks.t[60];
    // Reference, written out plainly.
    let last: number | null = null;
    let dir = 0;
    const ref = new Map<number, { up: number; down: number }>();
    fx.ticks.t.forEach((t, i) => {
      const mid = (fx.ticks.b[i] + fx.ticks.a[i]) / 2;
      let d = 0;
      if (last !== null) d = mid > last ? 1 : mid < last ? -1 : dir;
      if (d !== 0) dir = d;
      last = mid;
      if (t < from || t > to || d === 0) return;
      const r = ref.get(fx.ticks.b[i]) ?? { up: 0, down: 0 };
      if (d > 0) r.up++;
      else r.down++;
      ref.set(fx.ticks.b[i], r);
    });
    const rows = footprintRowsFromTape(tape, from, to);
    expect(new Map(rows.map((r) => [r.price, { up: r.up, down: r.down }]))).toEqual(ref);
    expect(rows.reduce((n, r) => n + r.up + r.down, 0)).toBeGreaterThan(0);
  });
});

describe('TickReplay', () => {
  it('loads the window from md/history with the keyframe, then steps event by event', async () => {
    const h = harness();
    const start = fx.book[20].t + 0.5;
    await h.tr.start(start);
    expect(h.calls[0]).toMatchObject({ symbol: 'EURUSD', from: start, kinds: ['ticks', 'book'] });
    expect(h.calls[0].to).toBe(Math.min(start + CHUNK_MS, T1 + 1));
    expect(h.tr.tape!.sourceId).toBe(fx.sourceId);
    // The book at the start is the keyframe: known, not empty.
    expect(h.tr.tape!.bookAt(start).known).toBe(true);
    h.tr.step(1);
    const first = h.tr.clock!;
    expect(first).toBeGreaterThan(start);
    h.tr.step(1);
    expect(h.tr.clock!).toBeGreaterThan(first);
    h.tr.step(-1);
    expect(h.tr.clock).toBe(first);
    expect(h.moves.at(-1)).toEqual([h.moves.at(-2)![1], first]);
  });

  it('plays at speed × wall time on animation frames and never passes the present', async () => {
    const h = harness(T0 + 5_000);
    await h.tr.start(T0);
    h.tr.setSpeed(10);
    h.tr.play();
    h.frame(100); // 100 ms × 10 = 1 s of market time
    expect(h.tr.clock).toBe(T0 + 1_000);
    h.frame(100);
    expect(h.tr.clock).toBe(T0 + 2_000);
    h.tr.setSpeed(100);
    h.frame(100);
    expect(h.tr.clock).toBe(T0 + 5_000);
    expect(h.tr.playing()).toBe(false);
    expect(h.tr.note()).toBe('Replay reached the present.');
  });
});

describe('ReplayController tick mode', () => {
  it('moves the head through ticks, folds the forming bar, and fills paper trades on the recorded bid / ask', async () => {
    const calls: MdHistoryRequest[] = [];
    // Bars: 10 s bars around the recording (only their times matter; the head bar is folded from ticks).
    const bars: Bar[] = Array.from({ length: 6 }, (_, i) => ({
      time: T0 - 10_000 + i * 10_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const rc = new ReplayController({
      bars: () => bars,
      resolution: () => '1S' as never,
      digits: () => 5,
      symbolFacts: () => ({ pipSize: 0.0001, contractSize: 100_000 }),
      fetchIntrabar: async () => [],
      tickData: {
        history: async (r) => {
          calls.push(r);
          return recorded(r);
        },
        symbol: () => 'EURUSD',
        sourceId: () => null,
        now: () => T1 + 1,
      },
    });
    rc.start(1);
    rc.setTickMode(true);
    await flush();
    await flush();
    expect(rc.tickMode()).toBe(true);
    expect(calls).toHaveLength(1);
    // Step to the 5th tick.
    while ((rc.tick!.clock ?? 0) < fx.ticks.t[4]) rc.tick!.step(1);
    const head = rc.tickHead()!;
    expect(head).toBe(fx.ticks.t[4]);
    const unit = rc.headUnit()!;
    expect(unit.close).toBe(fx.ticks.b[4]);
    expect(unit.spread).toBeCloseTo(fx.ticks.a[4] - fx.ticks.b[4], 10);
    // Buy at the recorded ask with a 0.1-pip target: the first later tick whose bid reaches it closes it there.
    expect(rc.place('buy', 1, null, 0.1)).toBeNull();
    const trade = rc.trades()[0];
    expect(trade.entry).toBeCloseTo(fx.ticks.a[4], 10);
    const target = trade.target!;
    const hitIdx = fx.ticks.b.findIndex((b, i) => i > 4 && b >= target);
    for (let i = 0; i < 400 && rc.trades()[0].exit === undefined; i++) rc.tick!.step(1);
    if (hitIdx > 0) {
      expect(rc.trades()[0].reason).toBe('target');
      expect(rc.trades()[0].closedAt).toBe(fx.ticks.t[hitIdx]);
    }
    // The chart's last bar is the one forming at the head, from ticks.
    const view = rc.view();
    expect(view.at(-1)!.time).toBeLessThanOrEqual(rc.tickHead()!);
    // Leaving tick mode goes back to whole bars at the bar reached.
    rc.setTickMode(false);
    expect(rc.tickHead()).toBeNull();
    expect(rc.cursor().sub).toBeNull();
  });
});
