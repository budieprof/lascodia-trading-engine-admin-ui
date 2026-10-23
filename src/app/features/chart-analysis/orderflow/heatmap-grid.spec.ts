import { describe, expect, it } from 'vitest';

import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import {
  HEAT_LUT,
  buildHeatGrid,
  clipHeatGrid,
  foldLiveSnapshot,
  formatBucket,
  heatCellAt,
  heatColor,
  heatIntensity,
  heatNeedsFetch,
  heatWindowFor,
  levelStep,
  percentile,
  robustMaxOf,
} from './heatmap-grid';
import type { OrderBookHeatmapDto } from './orderflow.types';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function dto(over: Partial<OrderBookHeatmapDto> = {}): OrderBookHeatmapDto {
  return {
    symbol: 'EURUSD',
    fromUtc: iso(T0),
    toUtc: iso(T0 + 10 * MIN),
    bucketSeconds: 60,
    oldestAvailableUtc: '2026-10-16T08:00:00Z',
    sourceInstanceIds: ['LASC-1'],
    columns: [
      {
        t: iso(T0),
        capturedAtUtc: iso(T0 + 50_000),
        bid: 1.1,
        ask: 1.10002,
        bids: [
          [1.1, 1_000_000],
          [1.09999, 2_000_000],
        ],
        asks: [
          [1.10002, 500_000],
          [1.10003, 3_000_000],
        ],
      },
      // Bucket 1 has no snapshot: omitted by the engine, so it is a gap here too.
      {
        t: iso(T0 + 2 * MIN),
        capturedAtUtc: iso(T0 + 2 * MIN + 40_000),
        bid: 1.10001,
        ask: 1.10003,
        bids: [[1.10001, 4_000_000]],
        asks: [[1.10003, 1_000_000]],
      },
    ],
    maxLevelVolume: 4_000_000,
    ...over,
  };
}

const snap = (over: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot => ({
  id: 9,
  symbol: 'EURUSD',
  bidPrice: 1.10002,
  askPrice: 1.10004,
  bidVolume: 1,
  askVolume: 1,
  spreadPoints: 2,
  levelsJson: JSON.stringify({ bids: [{ P: 1.10002, V: 700_000 }], asks: [{ P: 1.10004, V: 900_000 }] }),
  instanceId: 'LASC-1',
  capturedAt: iso(T0 + 2 * MIN + 55_000),
  ...over,
});

describe('heatmap grid (OF-1)', () => {
  it('bins levels onto the broker ladder and keeps omitted buckets empty', () => {
    const g = buildHeatGrid(dto(), 0.00001);
    expect(g.rowStep).toBeCloseTo(0.00001, 10);
    expect(g.columns).toHaveLength(2);
    expect(g.columns[0].t).toBe(T0);
    expect(g.columns[0].end).toBe(T0 + MIN);
    // The second column is the bucket at +2 min; nothing is drawn over +1 min (never carried forward).
    expect(g.columns[1].t).toBe(T0 + 2 * MIN);
    expect(heatCellAt(g, T0 + MIN + 30_000, 1.1)).toBeNull();
    expect(Array.from(g.columns[0].volumes)).toEqual([2_000_000, 1_000_000, 500_000, 3_000_000]);
    expect(g.oldestAvailableUtc).toBe(Date.parse('2026-10-16T08:00:00Z'));
  });

  it('sums levels that land in one row when the ladder is coarser than a point', () => {
    const g = buildHeatGrid(
      dto({
        columns: [
          {
            t: iso(T0),
            capturedAtUtc: iso(T0),
            bid: 1.1,
            ask: 1.1001,
            bids: [
              [1.1, 1],
              [1.0999, 2],
              [1.0998, 3],
            ],
            asks: [
              [1.1001, 4],
              [1.10011, 5],
            ],
          },
        ],
      }),
      0.00001,
    );
    // Gaps 0.0001 ×3 and 0.00001 ×1: the median ladder step is 0.0001, and 1.10011 rounds into 1.1001's row.
    expect(g.rowStep).toBeCloseTo(0.0001, 10);
    const cell = heatCellAt(g, T0 + 1, 1.1001);
    expect(cell?.volume).toBe(9);
  });

  it('level step: median gap, snapped to whole points, never finer than a point', () => {
    expect(levelStep([1.1, 1.10001, 1.10002, 1.10005], 0.00001)).toBeCloseTo(0.00001, 10);
    expect(levelStep([1.1], 0.00001)).toBe(0.00001);
    expect(levelStep([150.1, 150.12, 150.14], 0.001)).toBeCloseTo(0.02, 10);
  });

  it('robust max is the 98th percentile, so one outsized wall does not wash the map out', () => {
    const vols = Array.from({ length: 99 }, (_, i) => i + 1);
    expect(percentile(vols, 0.98)).toBe(98);
    const g = buildHeatGrid(
      dto({
        columns: [
          {
            t: iso(T0),
            capturedAtUtc: iso(T0),
            bid: 1,
            ask: 1,
            bids: vols.map((v, i) => [1 + i * 0.00001, v] as [number, number]),
            asks: [[2, 1_000_000_000]],
          },
        ],
      }),
      0.00001,
    );
    expect(robustMaxOf(g.columns)).toBe(98);
    expect(g.robustMax).toBeLessThan(1_000_000_000);
    expect(percentile([], 0.98)).toBe(0);
  });

  it('log intensity: zero is empty, the robust max saturates, a pulled level fades', () => {
    expect(heatIntensity(0, 100)).toBe(0);
    expect(heatIntensity(100, 100)).toBe(1);
    expect(heatIntensity(10_000, 100)).toBe(1);
    const half = heatIntensity(10, 100);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(heatIntensity(1, 100)).toBeLessThan(half);
    expect(heatColor(0)).toMatch(/^rgba\(20,40,110,0\.120\)$/);
    expect(heatColor(1)).toMatch(/^rgba\(255,90,40,0\.950\)$/);
    expect(HEAT_LUT).toHaveLength(256);
  });

  it('folds the live book into its bucket: replaces the newest column, or opens the next', () => {
    const g = buildHeatGrid(dto(), 0.00001);
    const same = foldLiveSnapshot(g, snap());
    expect(same.columns).toHaveLength(2);
    expect(same.columns[1].capturedAt).toBe(T0 + 2 * MIN + 55_000);
    expect(same.robustMax).toBe(g.robustMax);
    const next = foldLiveSnapshot(g, snap({ capturedAt: iso(T0 + 3 * MIN + 5_000) }));
    expect(next.columns).toHaveLength(3);
    expect(next.columns[2].t).toBe(T0 + 3 * MIN);
    // Older than the newest column, another symbol, or top-of-book only: unchanged.
    expect(foldLiveSnapshot(g, snap({ capturedAt: iso(T0 + 2 * MIN + 1_000) }))).toBe(g);
    expect(foldLiveSnapshot(g, snap({ symbol: 'GBPUSD' }))).toBe(g);
    expect(foldLiveSnapshot(g, snap({ levelsJson: null }))).toBe(g);
    // A new instance is named as a source.
    expect(foldLiveSnapshot(g, snap({ instanceId: 'LASC-2' })).sources).toEqual(['LASC-1', 'LASC-2']);
  });

  it('replay clipping: nothing at or after the head, the spanning column ends there', () => {
    const g = buildHeatGrid(dto(), 0.00001);
    const clipped = clipHeatGrid(g, T0 + 2 * MIN + 45_000);
    expect(clipped.columns).toHaveLength(2);
    expect(clipped.columns[1].end).toBe(T0 + 2 * MIN + 45_000);
    // A snapshot captured after the head inside its own bucket is the future.
    const early = clipHeatGrid(g, T0 + 2 * MIN + 30_000);
    expect(early.columns).toHaveLength(1);
    expect(clipHeatGrid(g, T0 + 30_000).columns).toHaveLength(0);
    expect(clipHeatGrid(g, null)).toBe(g);
  });

  it('fetch window: widened, capped at now and the oldest snapshot, ~3 px per bucket, at most 800', () => {
    const view = { fromUtc: T0, toUtc: T0 + 100 * MIN, widthPx: 900 };
    const w = heatWindowFor('EURUSD', view, T0 + 100 * MIN, null)!;
    expect(w.fromUtc).toBe(T0 - 25 * MIN);
    expect(w.toUtc).toBe(T0 + 100 * MIN);
    expect(w.buckets).toBe(Math.round((900 * 1.25) / 3));
    const wide = heatWindowFor('EURUSD', { ...view, widthPx: 5000 }, T0 + 1000 * MIN, null)!;
    expect(wide.buckets).toBe(800);
    const held = heatWindowFor('EURUSD', view, T0 + 1000 * MIN, T0 + 10 * MIN)!;
    expect(held.fromUtc).toBe(T0 + 10 * MIN);
    expect(heatWindowFor('EURUSD', view, T0 + 1000 * MIN, T0 + 500 * MIN)).toBeNull();
  });

  it('refetches on a pan off the window, a big zoom, or another symbol — not on a small pan', () => {
    const a = { symbol: 'EURUSD', fromUtc: T0, toUtc: T0 + 150 * MIN, buckets: 150 };
    expect(heatNeedsFetch(null, a)).toBe(true);
    expect(heatNeedsFetch(a, { ...a, fromUtc: T0 + 5 * MIN, toUtc: T0 + 150 * MIN, buckets: 145 })).toBe(false);
    expect(heatNeedsFetch(a, { ...a, fromUtc: T0 - 60 * MIN, toUtc: T0 + 90 * MIN })).toBe(true);
    expect(heatNeedsFetch(a, { ...a, buckets: 50 })).toBe(true);
    expect(heatNeedsFetch(a, { ...a, symbol: 'GBPUSD' })).toBe(true);
    expect(heatNeedsFetch(a, null)).toBe(false);
  });

  it('bucket labels', () => {
    expect(formatBucket(30_000)).toBe('30 s');
    expect(formatBucket(5 * MIN)).toBe('5 min');
    expect(formatBucket(3 * 60 * MIN)).toBe('3 h');
  });
});
