import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  compareSeriesPoints,
  comparePanes,
  compareSymbolsOf,
  compareTitle,
  restoredCompare,
  specProblem,
  type CompareSeriesSpec,
} from './compare-series';

const H = 3_600_000;
const bars = (closes: (number | null)[]): Bar[] =>
  closes.flatMap((c, i) => (c === null ? [] : [{ time: i * H, open: c, high: c, low: c, close: c, volume: 1 }]));
const data: Record<string, Bar[]> = {
  EURUSD: bars([1.1, 1.12, 1.21]),
  GBPUSD: bars([1.25, null, 1.3]),
  USDJPY: bars([150, 151, 147]),
};
const barsOf = (s: string) => data[s];
const spec = (over: Partial<CompareSeriesSpec>): CompareSeriesSpec => ({
  id: 'x',
  kind: 'compare',
  symbols: ['GBPUSD'],
  color: '#FF6D00',
  ...over,
});

describe('compare overlays and synthetic series (CC-I12)', () => {
  it('a compare series is the other symbol’s closes, on the price pane (the percent scale rebases it)', () => {
    const [pane] = comparePanes([spec({})], barsOf, () => 5);
    expect(pane).toMatchObject({ uid: 'compare:x', target: 'price', stepped: false });
    expect(pane.lines[0].points).toEqual([
      { time: 0, value: 1.25 },
      { time: 2 * H, value: 1.3 },
    ]);
  });

  it('ratio and spread run on the bars both legs have', () => {
    expect(compareSeriesPoints(spec({ kind: 'ratio', symbols: ['EURUSD', 'GBPUSD'] }), barsOf).map((p) => p.time)).toEqual([0, 2 * H]);
    const spread = compareSeriesPoints(spec({ kind: 'spread', symbols: ['EURUSD', 'GBPUSD'], mult: 2 }), barsOf);
    expect(spread[0].value).toBeCloseTo(1.1 - 2.5, 12);
  });

  it('a basket rebases each member to 100 at the first common bar and weights them', () => {
    const b = compareSeriesPoints(spec({ kind: 'basket', symbols: ['EURUSD', 'USDJPY'], weights: [3, 1] }), barsOf);
    expect(b[0].value).toBeCloseTo(100, 12);
    // EURUSD +10 %, USDJPY −2 %: (3 × 110 + 98) / 4.
    expect(b[2].value).toBeCloseTo((3 * 110 + 98) / 4, 9);
  });

  it('draws nothing it cannot compute, and says why a spec is incomplete', () => {
    expect(compareSeriesPoints(spec({ symbols: ['AUDUSD'] }), barsOf)).toEqual([]);
    expect(specProblem(spec({ kind: 'ratio', symbols: ['EURUSD', 'EURUSD'] }))).toMatch(/two different/);
    expect(specProblem(spec({ kind: 'basket', symbols: ['EURUSD'] }))).toMatch(/at least two/);
    expect(specProblem(spec({ kind: 'basket', symbols: ['EURUSD', 'GBPUSD'], weights: [1, 0] }))).toMatch(/above 0/);
  });

  it('names series and lists the symbols they need beside the chart’s own', () => {
    expect(compareTitle(spec({ kind: 'spread', symbols: ['EURUSD', 'GBPUSD'], mult: 1.2 }))).toBe('EURUSD − 1.2 × GBPUSD');
    expect(compareTitle(spec({ kind: 'ratio', symbols: ['EURUSD', 'GBPUSD'] }))).toBe('EURUSD ÷ GBPUSD');
    expect(
      compareSymbolsOf([spec({}), spec({ kind: 'ratio', symbols: ['EURUSD', 'USDJPY'] })], 'eurusd'),
    ).toEqual(['GBPUSD', 'USDJPY']);
  });

  it('restores a saved set, dropping what is malformed', () => {
    expect(
      restoredCompare([
        spec({}),
        { kind: 'nope', symbols: ['A'] },
        spec({ kind: 'ratio', symbols: ['EURUSD'] }),
        { ...spec({}), color: 'red', symbols: ['usdjpy'] },
      ]),
    ).toEqual([spec({}), { ...spec({}), color: '#AB47BC', symbols: ['USDJPY'] }]);
    expect(restoredCompare(undefined)).toEqual([]);
  });
});
