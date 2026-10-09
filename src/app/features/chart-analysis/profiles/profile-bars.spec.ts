import { describe, expect, it } from 'vitest';
import type { TvResolution } from '../datafeed/resolution';
import { profileResolutionFor, timeRangeIndices, withChartTail } from './profile-bars';

const H = 3_600_000;
const DAY = 24 * H;

describe('profileResolutionFor (DR-I7)', () => {
  it('profiles an H1 chart of 1,500 bars from M5', () => {
    expect(profileResolutionFor('60' as TvResolution, 1500 * H)).toBe('5');
  });

  it('steps up when the window is too long for the budget', () => {
    expect(profileResolutionFor('240' as TvResolution, 1500 * 4 * H)).toBe('15');
    expect(profileResolutionFor('1D' as TvResolution, 1500 * DAY)).toBe('240');
  });

  it('a 1-minute chart has nothing finer: its own bars', () => {
    expect(profileResolutionFor('1' as TvResolution, 1500 * 60_000)).toBeNull();
  });

  it('TPO needs bars no wider than its bracket, or none at all (DR-20)', () => {
    expect(profileResolutionFor('60' as TvResolution, 1500 * H, { maxMs: 30 * 60_000 })).toBe('5');
    expect(
      profileResolutionFor('1D' as TvResolution, 1500 * DAY, { maxMs: 30 * 60_000 }),
    ).toBeNull();
  });
});

describe('withChartTail', () => {
  it('appends the chart bars the finer ones do not reach (the bar still forming)', () => {
    const lower = [0, 5, 10, 55].map((m) => ({ time: m * 60_000 }));
    const chart = [{ time: 0 }, { time: H }, { time: 2 * H }];
    expect(withChartTail(lower, chart).map((b) => b.time)).toEqual(
      [0, 5, 10, 55].map((m) => m * 60_000).concat([H, 2 * H]),
    );
    expect(withChartTail([], chart)).toEqual(chart);
  });
});

describe('timeRangeIndices', () => {
  it('maps visible chart bars to the finer bars inside them', () => {
    const chart = [0, 1, 2, 3].map((i) => ({ time: i * H }));
    const lower = Array.from({ length: 48 }, (_, i) => ({ time: i * 5 * 60_000 })); // 4 hours of M5
    expect(timeRangeIndices(lower, chart, { from: 1, to: 2 })).toEqual({ from: 12, to: 35 });
    expect(timeRangeIndices(lower, chart, { from: -5, to: 10 })).toEqual({ from: 0, to: 47 });
  });
});
