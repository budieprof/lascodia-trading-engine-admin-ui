import { describe, expect, it } from 'vitest';

import { normalizeStrategyReport } from './strategy-report.model';
import {
  buildEquityChartOptions,
  buildProfitDistributionOptions,
  contrastRatio,
  heatCellColors,
  profitHistogram,
  reportPalette,
  underwaterPercent,
  withAlpha,
} from './report-charts';
import { strategyReportFixture } from '../testing/strategy-report.fixture';

const report = normalizeStrategyReport(strategyReportFixture())!;
const light = reportPalette('light');

describe('buildEquityChartOptions', () => {
  const opts = buildEquityChartOptions(report, light, 'USD') as any;

  it('stacks equity, drawdown and position as separate panels on one time axis', () => {
    expect(opts.grid).toHaveLength(3);
    expect(opts.xAxis.map((a: any) => a.type)).toEqual(['time', 'time', 'time']);
    expect(opts.yAxis.map((a: any) => a.gridIndex)).toEqual([0, 1, 2]);
    expect(opts.axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
  });

  it('never puts two units on one axis', () => {
    const byAxis = new Map<number, string[]>();
    for (const s of opts.series) {
      byAxis.set(s.yAxisIndex, [...(byAxis.get(s.yAxisIndex) ?? []), s.name]);
    }
    expect(byAxis.get(0)).toEqual(['Equity', 'Buy & hold']);
    expect(byAxis.get(1)).toEqual(['Drawdown']);
    expect(byAxis.get(2)).toEqual(['Position']);
  });

  it('plots the curve as [time, value] pairs, drawdown below zero and position as a step', () => {
    const equity = opts.series.find((s: any) => s.name === 'Equity');
    const dd = opts.series.find((s: any) => s.name === 'Drawdown');
    const pos = opts.series.find((s: any) => s.name === 'Position');
    expect(equity.data).toHaveLength(19);
    expect(equity.data[0]).toEqual([report.equityCurve[0].time, 10_000]);
    expect(Math.max(...dd.data.map((d: any) => d[1]))).toBeLessThanOrEqual(0);
    expect(pos.step).toBe('end');
    expect(pos.data[4][1]).toBe(-10_000);
  });

  it('shades the largest drawdown and pins the largest run-up', () => {
    const equity = opts.series.find((s: any) => s.name === 'Equity');
    const [[from, to]] = equity.markArea.data;
    expect(from.xAxis).toBe(report.equityCurve[8].time);
    expect(to.xAxis).toBe(report.equityCurve[11].time);
    expect(equity.markPoint.data[0].coord).toEqual([report.equityCurve[18].time, 10_641.2]);
  });

  it('lists every panel’s value for the hovered bar in one tooltip', () => {
    const html: string = opts.tooltip.formatter([{ dataIndex: 10 }]);
    expect(html).toContain('Equity');
    expect(html).toContain('Buy &amp; hold');
    expect(html).toContain('Drawdown');
    expect(html).toContain('Position');
    expect(html).toContain('10,099.80 USD');
  });

  it('reads the position panel in Pine units, with compact axis ticks', () => {
    const axis = opts.yAxis[2];
    expect(axis.name).toBe('Position (units)');
    expect(axis.axisLabel.formatter(100_000)).toBe('100K');
    expect(axis.axisLabel.formatter(-1_500_000)).toBe('-1.5M');
    const html: string = opts.tooltip.formatter([{ dataIndex: 4 }]);
    expect(html).toContain('−10,000 units');
  });

  it('returns null below two points so the card shows an empty state', () => {
    const single = { ...report, equityCurve: report.equityCurve.slice(0, 1) };
    expect(buildEquityChartOptions(single, light, 'USD')).toBeNull();
  });

  it('hides the buy & hold series when the engine sent none', () => {
    const noBh = {
      ...report,
      equityCurve: report.equityCurve.map((p) => ({ ...p, buyHoldEquity: null })),
    };
    const o = buildEquityChartOptions(noBh, light, 'USD') as any;
    expect(o.series.map((s: any) => s.name)).toEqual(['Equity', 'Drawdown', 'Position']);
    expect(o.legend.show).toBe(false);
  });
});

describe('underwaterPercent', () => {
  it('uses the engine’s percentage, negated', () => {
    expect(underwaterPercent({ ...report.equityCurve[10] })).toBeLessThan(0);
    expect(underwaterPercent({ ...report.equityCurve[0] })).toBe(0);
  });

  it('derives it from money when the percentage is missing', () => {
    const p = { ...report.equityCurve[10], drawdownPercent: null, equity: 90, drawdown: 10 };
    expect(underwaterPercent(p)).toBeCloseTo(-10, 6);
  });
});

describe('profit distribution', () => {
  it('bins closed trades without mixing winners and losers in one bar', () => {
    const bins = profitHistogram(report.trades);
    expect(bins.reduce((n, b) => n + b.count, 0)).toBe(6);
    expect(bins.some((b) => b.from < 0 && b.to > 0)).toBe(false);
  });

  it('colours losing bins with the loss pole and winning bins with the gain pole', () => {
    const o = buildProfitDistributionOptions(report, light, 'USD') as any;
    const colors = new Set(o.series[0].data.map((d: any) => d.itemStyle.color));
    expect(colors).toEqual(new Set([light.lossPole, light.gainPole]));
    expect(o.series[0].barMaxWidth).toBeLessThanOrEqual(24);
  });

  it('needs at least three closed trades', () => {
    const two = { ...report, trades: report.trades.slice(0, 2) };
    expect(buildProfitDistributionOptions(two, light, 'USD')).toBeNull();
  });
});

describe('heatCellColors', () => {
  it('is diverging: gains on the gain pole, losses on the loss pole, zero neutral', () => {
    expect(heatCellColors(2, 4, light)!.background).toBe(withAlpha(light.gainPole, 0.485));
    expect(heatCellColors(-4, 4, light)!.background).toBe(withAlpha(light.lossPole, 0.85));
    expect(heatCellColors(0, 4, light)!.background).toBe('transparent');
    expect(heatCellColors(null, 4, light)).toBeNull();
  });

  it('picks the ink with the higher contrast on the rendered fill', () => {
    for (const theme of ['light', 'dark'] as const) {
      const p = reportPalette(theme);
      for (const v of [-10, -3, -0.2, 0.2, 3, 10]) {
        const c = heatCellColors(v, 10, p)!;
        expect([p.inkOnLight, p.inkOnDark]).toContain(c.color);
      }
    }
    // A saturated loss cell in light mode takes white ink.
    expect(heatCellColors(-10, 10, light)!.color).toBe(light.inkOnDark);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  });
});
