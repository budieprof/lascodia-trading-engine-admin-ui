import { describe, expect, it } from 'vitest';

import { digitsFor, foldTicks, recordedClock, recordedWindow } from './demo.logic';
import type { DemoBar } from './demo.types';

const bar = (t: number, c: number, recordedT = t - 1_000 * 60_000): DemoBar => ({
  t, o: c, h: c, l: c, c, ticks: 1, recordedT, loopStart: false, forming: true,
});

describe('demo', () => {
  it('updates the forming bar and opens the next minute from replayed quotes', () => {
    const bars = [bar(60_000, 1.1)];
    const shift = 1_000 * 60_000;
    const touched = foldTicks(bars, {
      t: [60_500, 61_000, 120_100],
      rt: [60_500 - shift, 61_000 - shift, 120_100 - shift],
      b: [1.2, 1.05, 1.15],
    });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ h: 1.2, l: 1.05, c: 1.05, ticks: 3, forming: false });
    expect(bars[1]).toMatchObject({ t: 120_000, o: 1.15, forming: true, loopStart: false });
    expect(touched.map((b) => b.t)).toEqual([60_000, 120_000]);
  });

  it('marks the loop seam and ignores quotes older than the last bar', () => {
    const bars = [bar(600_000, 1.1, 500_000)];
    foldTicks(bars, { t: [5_000, 660_000], rt: [0, 0], b: [9, 1.3] });
    expect(bars).toHaveLength(2);
    expect(bars[1].loopStart).toBe(true);
    expect(bars[0].c).toBe(1.1);
  });

  it('labels the recorded window and clock in UTC', () => {
    expect(recordedWindow({ recordedFromMs: Date.UTC(2026, 9, 21, 8), recordedToMs: Date.UTC(2026, 9, 21, 10) })).toBe(
      '2026-10-21 08:00–10:00 UTC',
    );
    expect(recordedWindow({ recordedFromMs: null, recordedToMs: null })).toBe('not chosen yet');
    expect(recordedClock(Date.UTC(2026, 9, 21, 8, 43, 12))).toBe('recorded 08:43:12 UTC');
    expect(digitsFor('USDJPY')).toBe(3);
    expect(digitsFor('EURUSD')).toBe(5);
  });
});
