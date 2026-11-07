import { describe, expect, it } from 'vitest';
import type { Maybe, Ohlc } from '../indicators/math';
import { indicatorById, type IndicatorContext } from '../indicators/registry';
import { QUOTE_NOTIONAL } from '../indicators/volume-labels';
import { StudyBarsMirror, StudyTailEngine, TAIL_KERNELS } from './study-tail';

/** A small seeded PRNG (mulberry32): the same random sequences on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const H1 = 3_600_000;

/** A random walk with flat stretches, equal closes, zero volumes and an occasional zero price. */
function makeBar(r: () => number, time: number, prev: number): Ohlc {
  const flat = r() < 0.05;
  const open = flat ? prev : prev + (r() - 0.5) * 0.002;
  const close = flat ? prev : r() < 0.1 ? open : open + (r() - 0.5) * 0.002;
  const high = flat ? prev : Math.max(open, close) + r() * 0.001;
  const low = flat ? prev : Math.min(open, close) - r() * 0.001;
  const volume = r() < 0.08 ? 0 : Math.floor(r() * 500);
  return { time, open, high, low, close, volume };
}

/** A tick on the newest bar: close moves, the range widens, the volume grows. */
function tick(r: () => number, b: Ohlc): Ohlc {
  const close = b.close + (r() - 0.5) * 0.001;
  return {
    ...b,
    close,
    high: Math.max(b.high, close),
    low: Math.min(b.low, close),
    volume: b.volume + Math.floor(r() * 5),
  };
}

const same = (a: Maybe | undefined, b: Maybe | undefined): boolean =>
  (a === null || a === undefined) && (b === null || b === undefined) ? true : Object.is(a, b);

function expectIdentical(id: string, got: Record<string, Maybe[]>, want: Record<string, Maybe[]>, step: number): void {
  for (const key of Object.keys(want)) {
    const g = got[key];
    const w = want[key];
    expect(g?.length, `${id}.${key} length at step ${step}`).toBe(w.length);
    for (let i = 0; i < w.length; i++) {
      if (!same(g[i], w[i])) {
        throw new Error(`${id}.${key}[${i}] at step ${step}: tail ${g[i]} ≠ full ${w[i]}`);
      }
    }
  }
}

/** Every kernel over a spread of inputs (sources, short and long lengths, smoothings). */
const CASES: { id: string; params: Record<string, number | string>; ctx?: IndicatorContext }[] = [
  { id: 'sma', params: { length: 20, source: 'close' } },
  { id: 'sma', params: { length: 3, source: 'hlc3' } },
  { id: 'ema', params: { length: 20, source: 'close' } },
  { id: 'ema', params: { length: 1, source: 'ohlc4' } },
  { id: 'wma', params: { length: 9, source: 'hl2' } },
  { id: 'bollinger', params: { length: 20, mult: 2, source: 'close' } },
  { id: 'bollinger', params: { length: 5, mult: 1.5, source: 'open' } },
  { id: 'vwap', params: {} },
  {
    id: 'vwap',
    params: {},
    // A trading day that rolls at 21:00 UTC (17:00 New York in summer).
    ctx: { tradingDay: (t: number) => Math.floor((t + 3 * H1) / 86_400_000) * 86_400_000 },
  },
  { id: 'rsi', params: { length: 14, source: 'close' } },
  { id: 'rsi', params: { length: 2, source: 'low' } },
  { id: 'macd', params: { fast: 12, slow: 26, signal: 9, source: 'close' } },
  { id: 'macd', params: { fast: 5, slow: 3, signal: 1, source: 'high' } },
  { id: 'atr', params: { length: 14 } },
  { id: 'volume', params: { length: 20, measure: 'Volume' } },
  { id: 'volume', params: { length: 5, measure: QUOTE_NOTIONAL }, ctx: { volumeKind: 'base' } },
  { id: 'volume', params: { length: 5, measure: QUOTE_NOTIONAL }, ctx: { volumeKind: 'tick' } },
  { id: 'obv', params: {} },
  { id: 'stochastic', params: { length: 14, smoothK: 1, smoothD: 3 } },
  { id: 'stochastic', params: { length: 5, smoothK: 3, smoothD: 3 } },
  { id: 'stochastic', params: { length: 3, smoothK: 2, smoothD: 1 } },
  { id: 'donchian', params: { length: 20 } },
  { id: 'momentum', params: { length: 10, source: 'close' } },
  { id: 'roc', params: { length: 9, source: 'close' } },
];

describe('US01 study tail path', () => {
  it('has a case for every kernel', () => {
    const covered = new Set(CASES.map((c) => c.id));
    for (const id of Object.keys(TAIL_KERNELS)) expect(covered.has(id), id).toBe(true);
  });

  it('every kernel equals the full computation to the last bit over random tick sequences', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      let bars: Ohlc[] = [];
      let t = Date.UTC(2026, 0, 5);
      let price = r() < 0.2 ? 0.0001 : 1.1;
      // Start anywhere from no bars to a few hundred (warm-up edges included).
      const start = Math.floor(r() * 300);
      for (let i = 0; i < start; i++) {
        const b = makeBar(r, t, price);
        bars.push(b);
        price = b.close;
        t += H1;
      }
      const engine = new StudyTailEngine();
      for (let step = 0; step < 220; step++) {
        const roll = r();
        let from: number;
        if (roll < 0.6 && bars.length) {
          // A tick on the forming bar.
          from = bars.length - 1;
          bars = [...bars.slice(0, -1), tick(r, bars[bars.length - 1])];
        } else if (roll < 0.85) {
          // A new bar opens.
          from = bars.length;
          const b = makeBar(r, t, bars[bars.length - 1]?.close ?? price);
          t += H1;
          bars = [...bars, b];
        } else if (roll < 0.93 && bars.length >= 2) {
          // A resync rewrites the last two bars.
          from = bars.length - 2;
          bars = [...bars.slice(0, -2), tick(r, bars[bars.length - 2]), tick(r, bars[bars.length - 1])];
        } else if (roll < 0.97 && bars.length >= 1) {
          // Replay stepping back: the newest bar taken off.
          from = bars.length - 1;
          bars = bars.slice(0, -1);
        } else {
          // A deeper rewrite (history reloaded): everything from somewhere in the middle.
          from = Math.floor(r() * bars.length);
          bars = [...bars.slice(0, from), ...bars.slice(from).map((b) => tick(r, b))];
        }
        engine.barsChanged(from);
        for (const [n, c] of CASES.entries()) {
          const key = `${n}:${c.id}`;
          const got = engine.compute(key, c.id, c.params, bars, c.ctx);
          expect(got, key).not.toBeNull();
          const want = indicatorById(c.id)!.compute(bars, c.params, c.ctx);
          expectIdentical(key, got!.values, want, step);
          // Nothing before `from` was rewritten: the caller may write from there on.
          expect(got!.from).toBeLessThanOrEqual(Math.min(from, bars.length));
        }
      }
    }
  });

  it('resumes from the checkpoint on a tick (one bar of work), and starts over on a deeper change', () => {
    const r = rng(99);
    const bars: Ohlc[] = [];
    for (let i = 0; i < 500; i++) bars.push(makeBar(r, i * H1, 1.1));
    const engine = new StudyTailEngine();
    expect(engine.compute('k', 'ema', { length: 20 }, bars)!.from).toBe(0);
    engine.barsChanged(499);
    expect(engine.compute('k', 'ema', { length: 20 }, bars)!.from).toBe(499);
    engine.barsChanged(100);
    expect(engine.compute('k', 'ema', { length: 20 }, bars)!.from).toBe(0);
  });

  it('leaves inputs it does not cover, and studies without a kernel, to the full computation', () => {
    const engine = new StudyTailEngine();
    expect(engine.compute('a', 'sma', { length: 2.5 }, [])).toBeNull();
    expect(engine.compute('b', 'ichimoku', {}, [])).toBeNull();
    expect(engine.covers('sma', { length: 20 })).toBe(true);
  });

  it('mirrors the plotted bars from the first change, reusing the bars before it', () => {
    const mirror = new StudyBarsMirror();
    const plotted = [0, 1, 2].map((i) => ({ time: i, open: 1, high: 2, low: 0, close: 1, volume: i }));
    const utc = plotted.map((b) => ({ ...b, time: b.time + 10 }));
    mirror.update(plotted, utc, 0);
    const first = mirror.ohlc;
    expect(mirror.utcTimes).toEqual([10, 11, 12]);
    const next = [...plotted.slice(0, 2), { ...plotted[2], close: 1.5 }];
    mirror.update(next, utc, 2);
    expect(mirror.ohlc).not.toBe(first);
    expect(mirror.ohlc[0]).toBe(first[0]);
    expect(mirror.ohlc[2].close).toBe(1.5);
  });
});
