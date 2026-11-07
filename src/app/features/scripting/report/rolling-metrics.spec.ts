import { describe, expect, it } from 'vitest';

import { reportPalette } from './report-charts';
import { buildRollingROptions, rollingR, rPointsFromReport, type RPoint } from './rolling-metrics';
import type { ReportTrade, StrategyReport } from './strategy-report.model';

const pts = (rs: number[]): RPoint[] => rs.map((r, i) => ({ time: 1_000 * (i + 1), r }));

describe('rollingR (U08)', () => {
  it('is empty until a full window exists', () => {
    expect(rollingR(pts([1, 2]), 3)).toEqual([]);
  });

  it('computes the window mean and sample-sd Sharpe by hand', () => {
    // windows of 3 over [1, -1, 2, 0]: [1,-1,2] mean 2/3 sd √(7/3); [-1,2,0] mean 1/3 sd √(7/3)
    const out = rollingR(pts([1, -1, 2, 0]), 3);
    expect(out).toHaveLength(2);
    expect(out[0].trade).toBe(3);
    expect(out[0].time).toBe(3_000);
    expect(out[0].expectancy).toBeCloseTo(2 / 3, 10);
    expect(out[0].sharpe).toBeCloseTo(2 / 3 / Math.sqrt(7 / 3), 10);
    expect(out[1].expectancy).toBeCloseTo(1 / 3, 10);
    expect(out[1].sharpe).toBeCloseTo(1 / 3 / Math.sqrt(7 / 3), 10);
  });

  it('leaves the Sharpe undefined when R never varies in the window', () => {
    const out = rollingR(pts([1, 1, 1]), 3);
    expect(out[0].sharpe).toBeNull();
    expect(out[0].expectancy).toBe(1);
  });

  it('chart options are null below two points and stack two panels otherwise', () => {
    const palette = reportPalette('light');
    expect(buildRollingROptions(rollingR(pts([1, 2, 3]), 3), 3, palette)).toBeNull();
    const opts = buildRollingROptions(rollingR(pts([1, 2, 3, -1]), 3), 3, palette) as {
      series: unknown[];
      grid: unknown[];
    };
    expect(opts.series).toHaveLength(2);
    expect(opts.grid).toHaveLength(2);
  });
});

describe('rPointsFromReport', () => {
  const t = (over: Partial<ReportTrade>): ReportTrade =>
    ({
      isOpen: false,
      direction: 'long',
      entryPrice: 1.1,
      exitPrice: 1.11,
      initialStopPrice: null,
      rMultiple: null,
      entryTime: 1,
      exitTime: 2,
      ...over,
    }) as ReportTrade;

  it('prefers the reported R, falls back to the price R against the stop and skips trades without one', () => {
    const report = {
      trades: [
        t({ rMultiple: 1.5, exitTime: 30 }),
        t({ initialStopPrice: 1.09, exitTime: 10 }), // +1R by price
        t({ exitTime: 20 }), // no stop: no R
        t({ isOpen: true, rMultiple: 3 }), // open: never counted
      ],
    } as unknown as StrategyReport;
    const { points, closed } = rPointsFromReport(report);
    expect(closed).toBe(3);
    expect(points.map((p) => p.time)).toEqual([10, 30]);
    expect(points[0].r).toBeCloseTo(1, 6);
    expect(points[1].r).toBe(1.5);
  });
});
