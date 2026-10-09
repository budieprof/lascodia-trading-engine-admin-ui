import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import {
  AUTO_FIB_RATIOS,
  autoFib,
  higherTimeframe,
  htfLevels,
  scoredTrendlines,
} from './auto-analysis';

const H = 3_600_000;
const bar = (i: number, h: number, l: number, c = (h + l) / 2): Ohlc => ({
  time: i * H,
  open: c,
  high: h,
  low: l,
  close: c,
  volume: 100,
});

/**
 * A falling market with three lower highs on one straight line (bars 20, 40, 60: 1.1000, 1.0960, 1.0920 — 0.0002
 * a bar) and small bars elsewhere, well under it.
 */
function fallingWedge(): Ohlc[] {
  const bars: Ohlc[] = [];
  for (let i = 0; i < 90; i++) {
    const line = 1.104 - 0.0002 * i;
    bars.push(bar(i, line - 0.0012, line - 0.0022));
  }
  for (const i of [20, 40, 60]) {
    const line = 1.104 - 0.0002 * i;
    bars[i] = bar(i, line, line - 0.0022, line - 0.0015);
  }
  return bars;
}

describe('auto analysis (DR-I11)', () => {
  it('fits the resistance through the three lower highs and scores it by its touches', () => {
    const lines = scoredTrendlines(fallingWedge(), { depth: 5 });
    const res = lines.filter((l) => l.kind === 'resistance');
    expect(res.length).toBeGreaterThan(0);
    const best = res[0];
    expect(best.touches).toBe(3);
    expect(best.a.index).toBe(20);
    expect(best.slope).toBeCloseTo(-0.0002, 9);
    expect(best.score).toBeGreaterThan(3);
  });

  it('drops a line a close has broken', () => {
    const bars = fallingWedge();
    // A close well above the line after the third touch breaks it.
    bars[75] = bar(75, 1.1, 1.088, 1.099);
    const res = scoredTrendlines(bars, { depth: 5 }).filter((l) => l.kind === 'resistance');
    expect(res.some((l) => l.a.index === 20 && l.touches === 3)).toBe(false);
  });

  it('takes the levels of the timeframe at least four times the chart’s', () => {
    expect(higherTimeframe('60')).toBe('240');
    expect(higherTimeframe('15')).toBe('60');
    expect(higherTimeframe('240')).toBe('1D');
    expect(higherTimeframe('1')).toBe('5');
    expect(higherTimeframe('1W')).toBeNull();
    const htf = htfLevels(fallingWedge(), '4h');
    expect(htf.every((l) => l.timeframe === '4h')).toBe(true);
  });

  it('draws the Fib of the last zig-zag leg: 0 at its end, 1 at its start', () => {
    const bars: Ohlc[] = [];
    // Up from 1.0000 to 1.0300 (bar 30), then down to 1.0150 (bar 45), then a small bounce.
    for (let i = 0; i <= 30; i++) bars.push(bar(i, 1 + 0.001 * i + 0.0002, 1 + 0.001 * i - 0.0002));
    for (let i = 31; i <= 45; i++)
      bars.push(bar(i, 1.03 - 0.001 * (i - 30) + 0.0002, 1.03 - 0.001 * (i - 30) - 0.0002));
    for (let i = 46; i <= 50; i++) bars.push(bar(i, 1.0152, 1.0149));
    const fib = autoFib(bars, 1)!;
    expect(fib).not.toBeNull();
    expect(fib.from.price).toBeCloseTo(1.0302, 9);
    expect(fib.to.price).toBeCloseTo(1.0148, 9);
    expect(fib.levels.map((l) => l.ratio)).toEqual([...AUTO_FIB_RATIOS]);
    expect(fib.levels[0].price).toBeCloseTo(1.0148, 9);
    expect(fib.levels[6].price).toBeCloseTo(1.0302, 9);
    expect(fib.levels.find((l) => l.ratio === 0.5)!.price).toBeCloseTo((1.0302 + 1.0148) / 2, 9);
    expect(autoFib(bars.slice(0, 10), 1)).toBeNull();
  });
});
