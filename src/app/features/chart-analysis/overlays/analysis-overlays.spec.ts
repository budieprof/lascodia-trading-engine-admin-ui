import { describe, expect, it } from 'vitest';
import { profileWithValueArea, supportResistance, estimatedDelta } from './analysis-overlays';
import type { Ohlc } from '../indicators/math';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

function bar(i: number, o: number, h: number, l: number, c: number, v = 1000): Ohlc {
  return { time: T0 + i * HOUR, open: o, high: h, low: l, close: c, volume: v };
}

describe('profileWithValueArea', () => {
  it('returns null when there is nothing to profile', () => {
    expect(profileWithValueArea([])).toBeNull();
    // All volume zero: a profile of nothing is not a profile.
    expect(profileWithValueArea([bar(0, 1, 2, 1, 1.5, 0)])).toBeNull();
  });

  it('puts the POC where the volume actually is', () => {
    // 20 quiet bars around 1.10, then heavy trade at 1.20.
    const bars = [
      ...Array.from({ length: 20 }, (_, i) => bar(i, 1.1, 1.105, 1.095, 1.1, 100)),
      ...Array.from({ length: 5 }, (_, i) => bar(20 + i, 1.2, 1.205, 1.195, 1.2, 5000)),
    ];
    const r = profileWithValueArea(bars, 40)!;
    expect(r.poc).toBeGreaterThan(1.19);
    expect(r.poc).toBeLessThan(1.21);
  });

  it('brackets the POC with the value area', () => {
    const bars = Array.from({ length: 40 }, (_, i) =>
      bar(i, 1.1 + i * 0.001, 1.102 + i * 0.001, 1.098 + i * 0.001, 1.1 + i * 0.001, 500),
    );
    const r = profileWithValueArea(bars, 30)!;
    expect(r.valueAreaLow).toBeLessThanOrEqual(r.poc);
    expect(r.valueAreaHigh).toBeGreaterThanOrEqual(r.poc);
  });

  it('spreads volume across the bar range, not at the close', () => {
    // One wide bar closing at its high. If volume were dumped at the close the lowest bin
    // would be empty; spreading puts volume all the way down. The two implementations this
    // app briefly had disagreed on exactly this.
    const r = profileWithValueArea([bar(0, 1.0, 1.1, 1.0, 1.1, 1000)], 10)!;
    expect(r.bins[0].volume).toBeGreaterThan(0);
  });
});

describe('supportResistance', () => {
  /** A zig-zag that revisits 1.2000 and 1.1000 repeatedly. */
  const zigzag: Ohlc[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    for (const [o, h, l, c] of [
      [1.15, 1.16, 1.14, 1.155],
      [1.155, 1.2, 1.15, 1.19], // touches 1.2000
      [1.19, 1.195, 1.17, 1.175],
      [1.175, 1.18, 1.1, 1.11], // touches 1.1000
      [1.11, 1.13, 1.105, 1.125],
    ] as const) {
      zigzag.push(bar(zigzag.length, o, h, l, c));
    }
  }

  it('says nothing when there are too few bars to form a pivot', () => {
    expect(supportResistance(zigzag.slice(0, 4))).toEqual([]);
  });

  it('finds the repeatedly-tested levels', () => {
    const levels = supportResistance(zigzag, { lookback: 2, toleranceAtr: 0.6 });
    expect(levels.length).toBeGreaterThan(0);
    const near = (target: number) => levels.some((l) => Math.abs(l.price - target) < 0.01);
    expect(near(1.2) || near(1.1)).toBe(true);
  });

  it('labels a level above the last close as resistance and below as support', () => {
    const levels = supportResistance(zigzag, { lookback: 2, toleranceAtr: 0.6 });
    const close = zigzag[zigzag.length - 1].close;
    for (const l of levels) {
      expect(l.kind).toBe(l.price >= close ? 'resistance' : 'support');
    }
  });

  it('counts repeated touches and bounds strength to 0..1', () => {
    const levels = supportResistance(zigzag, { lookback: 2, toleranceAtr: 0.6, minTouches: 2 });
    for (const l of levels) {
      expect(l.touches).toBeGreaterThanOrEqual(2);
      expect(l.strength).toBeGreaterThan(0);
      expect(l.strength).toBeLessThanOrEqual(1);
    }
  });

  it('honours the max', () => {
    expect(
      supportResistance(zigzag, { lookback: 1, toleranceAtr: 0.2, max: 3 }).length,
    ).toBeLessThanOrEqual(3);
  });

  it('returns nothing on a flat series rather than inventing levels', () => {
    // No range means no ATR, so there is no scale to cluster on. A fixed tolerance here
    // would produce confident levels out of a straight line.
    const flat = Array.from({ length: 60 }, (_, i) => bar(i, 1.1, 1.1, 1.1, 1.1));
    expect(supportResistance(flat)).toEqual([]);
  });

  it('is sorted strongest first', () => {
    const levels = supportResistance(zigzag, { lookback: 2, toleranceAtr: 0.6, minTouches: 1 });
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i - 1].strength).toBeGreaterThanOrEqual(levels[i].strength);
    }
  });
});

describe('estimatedDelta', () => {
  it('is positive when a bar closes on its high, negative on its low', () => {
    const [up] = estimatedDelta([bar(0, 1.0, 1.1, 1.0, 1.1, 1000)]);
    const [down] = estimatedDelta([bar(0, 1.1, 1.1, 1.0, 1.0, 1000)]);
    expect(up.delta).toBeCloseTo(1000, 6);
    expect(down.delta).toBeCloseTo(-1000, 6);
  });

  it('is zero when a bar closes mid-range', () => {
    const [mid] = estimatedDelta([bar(0, 1.0, 1.1, 1.0, 1.05, 1000)]);
    expect(mid.delta).toBeCloseTo(0, 6);
  });

  it('treats a zero-range bar as balanced instead of dividing by zero', () => {
    const [flat] = estimatedDelta([bar(0, 1.1, 1.1, 1.1, 1.1, 500)]);
    expect(flat.delta).toBe(0);
    expect(Number.isFinite(flat.delta)).toBe(true);
  });

  it('accumulates', () => {
    const out = estimatedDelta([bar(0, 1.0, 1.1, 1.0, 1.1, 100), bar(1, 1.1, 1.1, 1.0, 1.0, 40)]);
    expect(out[0].cumulative).toBeCloseTo(100, 6);
    expect(out[1].cumulative).toBeCloseTo(60, 6);
  });

  it('keeps one entry per bar, in order', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1, 1.01, 0.99, 1.005));
    const out = estimatedDelta(bars);
    expect(out).toHaveLength(10);
    expect(out.map((d) => d.time)).toEqual(bars.map((b) => b.time));
  });
});

describe('supportResistance clustering width', () => {
  /**
   * The bug this pins: clustering used to chain off the LAST pivot added, so each new pivot
   * only had to be within tolerance of its neighbour. A dense run of pivots then merged into
   * one cluster of unbounded width — on real EURUSD hourly bars that produced a "level" with
   * 94 touches spanning most of the range, which is not a level, it is a busy zone with a
   * price tag on it.
   */
  it('keeps every cluster inside the tolerance, however dense the pivots', () => {
    // A staircase: each swing is a little higher than the last, so consecutive pivots are
    // always close together while the whole run covers a wide band.
    const bars: Ohlc[] = [];
    for (let i = 0; i < 120; i++) {
      const base = 1.1 + i * 0.0004;
      const swing = i % 2 === 0 ? 1 : -1;
      bars.push(
        bar(
          bars.length,
          base,
          base + 0.0008 * (swing > 0 ? 1 : 0.2),
          base - 0.0008 * (swing > 0 ? 0.2 : 1),
          base,
        ),
      );
    }
    const levels = supportResistance(bars, {
      lookback: 1,
      toleranceAtr: 0.5,
      max: 50,
      minTouches: 1,
    });
    expect(levels.length).toBeGreaterThan(1);

    // No single level should have swallowed a large share of every pivot.
    const totalTouches = levels.reduce((s, l) => s + l.touches, 0);
    const biggest = Math.max(...levels.map((l) => l.touches));
    expect(biggest).toBeLessThan(totalTouches * 0.6);
  });

  it('still merges pivots that genuinely sit at the same price', () => {
    const bars: Ohlc[] = [];
    for (let i = 0; i < 60; i++) {
      // Repeatedly tags 1.2000 from below.
      const up = i % 4 === 1;
      bars.push(
        up ? bar(bars.length, 1.19, 1.2, 1.188, 1.195) : bar(bars.length, 1.19, 1.192, 1.18, 1.185),
      );
    }
    const levels = supportResistance(bars, { lookback: 1, toleranceAtr: 0.5, minTouches: 2 });
    expect(levels.some((l) => Math.abs(l.price - 1.2) < 0.002)).toBe(true);
  });
});
