import { describe, expect, it } from 'vitest';
import { previousPeriodLevels } from './prev-period-levels';
import { indicatorById } from './registry';

const H = 3_600_000;
const bar = (h: number, high: number, low: number, close: number) => ({
  time: h * H,
  open: close,
  high,
  low,
  close,
  volume: 1,
});

describe('previous day / week levels (UA08)', () => {
  it('each day carries the previous complete day; the first (maybe partial) day never counts', () => {
    const bars = [
      bar(20, 5, 4, 4.5),
      bar(30, 10, 8, 9),
      bar(40, 11, 7, 10),
      bar(50, 12, 9, 11),
      bar(70, 13, 10, 12),
    ];
    const r = previousPeriodLevels(bars, 'Day');
    // UTC days: 0 (h20), 1 (h30, h40), 2 (h50), 2 (h70 is day 2 too? 70h = day 2 22:00).
    expect(r.high).toEqual([null, null, null, 11, 11]);
    expect(r.low).toEqual([null, null, null, 7, 7]);
    expect(r.close).toEqual([null, null, null, 10, 10]);
  });

  it('is in the registry as an overlay on the trading days', () => {
    const def = indicatorById('prev-period-levels')!;
    expect(def.target).toBe('overlay');
    const out = def.compute(
      [bar(0, 1, 1, 1), bar(30, 2, 2, 2), bar(50, 3, 3, 3)],
      { period: 'Day' },
      {},
    );
    expect(out['high']).toEqual([null, null, 2]);
  });
});
