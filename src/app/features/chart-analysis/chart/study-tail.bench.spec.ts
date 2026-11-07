import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import type { Maybe } from '../indicators/math';
import { indicatorById } from '../indicators/registry';
import { plotColorAt, plotColors } from '../indicators/study-settings';
import { firstChangedValue, ohlcOf } from './chart-rows';
import { StudyBarsMirror, StudyTailEngine } from './study-tail';

/**
 * US01 benchmark: the study work of ONE tick on a 20 000-bar chart with 10 studies, before (every
 * study over the whole history, as the chart did) and after (the tail path). Prints the numbers;
 * asserts only a wide margin so a slow CI machine cannot flake it.
 */

const N = 20_000;
const STUDIES: { id: string; params: Record<string, number | string> }[] = [
  { id: 'sma', params: { length: 20, source: 'close' } },
  { id: 'ema', params: { length: 50, source: 'close' } },
  { id: 'bollinger', params: { length: 20, mult: 2, source: 'close' } },
  { id: 'vwap', params: {} },
  { id: 'rsi', params: { length: 14, source: 'close' } },
  { id: 'macd', params: { fast: 12, slow: 26, signal: 9, source: 'close' } },
  { id: 'atr', params: { length: 14 } },
  { id: 'volume', params: { length: 20, measure: 'Volume' } },
  { id: 'stochastic', params: { length: 14, smoothK: 1, smoothD: 3 } },
  { id: 'obv', params: {} },
];

function history(): Bar[] {
  const bars: Bar[] = [];
  let p = 1.1;
  for (let i = 0; i < N; i++) {
    const o = p;
    const c = o + Math.sin(i * 0.37) * 0.0005 + Math.cos(i * 0.011) * 0.0003;
    bars.push({
      time: Date.UTC(2024, 0, 1) + i * 60_000,
      open: o,
      high: Math.max(o, c) + 0.0002,
      low: Math.min(o, c) - 0.0002,
      close: c,
      volume: 100 + (i % 37),
    });
    p = c;
  }
  return bars;
}

const tick = (bars: Bar[], k: number): Bar[] => {
  const last = bars[bars.length - 1];
  const close = last.close + (k % 2 ? 0.00001 : -0.00001);
  return [
    ...bars.slice(0, -1),
    { ...last, close, high: Math.max(last.high, close), low: Math.min(last.low, close), volume: last.volume + 1 },
  ];
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('US01 benchmark (20k bars × 10 studies, one tick)', () => {
  it('the tail path is far cheaper than the full recompute', () => {
    const TICKS = 40;
    let bars = history();
    const defs = STUDIES.map((s) => ({ ...s, def: indicatorById(s.id)! }));

    // Before: the bars copied for the maths, every study over all of them, every plot diffed, colours redone.
    const prev = new Map<string, Maybe[]>();
    const full: number[] = [];
    for (let k = 0; k < TICKS; k++) {
      bars = tick(bars, k);
      const t0 = performance.now();
      const ohlc = ohlcOf(bars);
      const utc = bars.map((b) => b.time);
      for (const s of defs) {
        const out = s.def.compute(ohlc, s.params, { utcTimes: utc });
        for (const plot of s.def.plots) {
          const values = out[plot.key] ?? [];
          firstChangedValue(prev.get(`${s.id}.${plot.key}`) ?? [], values);
          prev.set(`${s.id}.${plot.key}`, values);
          if (plot.colorBy) plotColors(plot.colorBy, values, bars);
        }
      }
      full.push(performance.now() - t0);
    }

    // After: the mirror makes the newest bar, each study steps it from its checkpoint, the tail is coloured.
    const mirror = new StudyBarsMirror();
    const engine = new StudyTailEngine();
    mirror.update(bars, bars, 0);
    for (const [n, s] of defs.entries()) engine.compute(`${n}`, s.id, s.params, mirror.ohlc);
    const tail: number[] = [];
    for (let k = 0; k < TICKS; k++) {
      bars = tick(bars, k);
      const t0 = performance.now();
      const from = bars.length - 1;
      mirror.update(bars, bars, from);
      engine.barsChanged(from);
      for (const [n, s] of defs.entries()) {
        const r = engine.compute(`${n}`, s.id, s.params, mirror.ohlc, { utcTimes: mirror.utcTimes })!;
        for (const plot of s.def.plots) {
          const values = r.values[plot.key];
          if (plot.colorBy)
            for (let i = r.from; i < values.length; i++) plotColorAt(plot.colorBy, values, bars, i);
        }
      }
      tail.push(performance.now() - t0);
    }

    const before = median(full);
    const after = median(tail);
    console.log(
      `US01 benchmark: ${N} bars × ${STUDIES.length} studies, per tick median — full recompute ${before.toFixed(2)} ms, ` +
        `tail path ${after.toFixed(3)} ms (${(before / after).toFixed(0)}× less)`,
    );
    expect(after * 5).toBeLessThan(before);
  });
});
