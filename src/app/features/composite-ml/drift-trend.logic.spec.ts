import { describe, expect, it } from 'vitest';

import type { CatalogueDriftHistoryDto } from '@core/api/api.types';
import { summariseTrends, toTrendSeries } from './drift-trend.logic';

const h = (key: string, pts: [string, number, number][]): CatalogueDriftHistoryDto => ({
  layerKey: key,
  symbol: null,
  timeframe: null,
  lookbackDays: 365,
  points: pts.map(([t, o, th]) => ({
    evaluatedAtUtc: t,
    observedCount: o,
    threshold: th,
    isWarm: o >= th,
  })),
});

describe('drift trend logic', () => {
  it('turns history into % of threshold, sorted, with the warm streak', () => {
    const s = toTrendSeries(
      h('Generator.IPW', [
        ['2026-10-02T00:00:00Z', 60, 30],
        ['2026-09-01T00:00:00Z', 10, 30],
        ['2026-09-20T00:00:00Z', 30, 30],
      ]),
    );
    expect(s.points.map((p) => p.pct)).toEqual([33.3, 100, 200]);
    expect(s.latestPct).toBe(200);
    expect(s.warmSinceUtc).toBe('2026-09-20T00:00:00Z');
    expect(s.scope).toBe('global');
  });

  it('summarises warm, cold and the nearest cold gate', () => {
    const sum = summariseTrends([
      toTrendSeries(h('A', [['2026-10-01T00:00:00Z', 60, 30]])),
      toTrendSeries(h('B', [['2026-09-01T00:00:00Z', 5, 10]])),
      toTrendSeries(h('C', [['2026-10-01T00:00:00Z', 0, 30]])),
    ]);
    expect(sum).toMatchObject({
      gates: 3,
      warm: 1,
      cold: 2,
      samples: 3,
      firstSampleUtc: '2026-09-01T00:00:00Z',
    });
    expect(sum.nearest).toEqual({ layerKey: 'B', pct: 50 });
  });
});
