import { describe, expect, it } from 'vitest';

import { normalizeStrategyReport } from './strategy-report.model';
import {
  CAPITAL_GROUPS,
  PERFORMANCE_GROUPS,
  RISK_RETURNS_GROUPS,
  TRADES_ANALYSIS_GROUPS,
  formatMetricPercent,
  formatMetricValue,
  metricToneClass,
} from './report-sections';
import { MINUS } from './report-format';
import { strategyReportFixture } from '../testing/strategy-report.fixture';

const report = normalizeStrategyReport(strategyReportFixture())!;

describe('PERFORMANCE_GROUPS', () => {
  it('covers every field of the report’s performance section', () => {
    const covered = new Set<string>();
    for (const g of PERFORMANCE_GROUPS) {
      for (const row of g.rows) {
        if (row.field) covered.add(row.field);
        if (row.percentField) covered.add(row.percentField);
      }
    }
    const missing = Object.keys(report.performance.all).filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });

  it('reads each row from the split it is given', () => {
    const net = PERFORMANCE_GROUPS[0].rows.find((r) => r.label === 'Net profit')!;
    expect(net.value(report.performance.all)).toBe(606.2);
    expect(net.value(report.performance.short)).toBe(-94.4);
    expect(net.percent!(report.performance.long)).toBe(7.006);
  });
});

describe('TRADES_ANALYSIS_GROUPS', () => {
  it('derives the largest winner / loser shares of gross profit / loss', () => {
    const rows = TRADES_ANALYSIS_GROUPS.flatMap((g) => g.rows);
    const winShare = rows.find((r) => r.label === 'Largest winner as % of gross profit')!;
    const lossShare = rows.find((r) => r.label === 'Largest loser as % of gross loss')!;
    expect(winShare.value(report.performance.all)).toBeCloseTo((499.2 / 707.8) * 100, 6);
    expect(lossShare.value(report.performance.all)).toBeCloseTo((60.8 / 101.6) * 100, 6);
    // No losing longs: the share is na, not 0% or NaN.
    expect(lossShare.value(report.performance.long)).toBeNull();
  });
});

describe('RISK_RETURNS_GROUPS / CAPITAL_GROUPS', () => {
  it('read the returns, equity and capital sections', () => {
    const rows = [...RISK_RETURNS_GROUPS, ...CAPITAL_GROUPS].flatMap((g) => g.rows);
    const by = (label: string) => rows.find((r) => r.label === label)!.value(report);
    expect(by('CAGR')).toBe(6.2851);
    expect(by('Sharpe ratio')).toBe(0.412);
    expect(by('Sortino ratio')).toBe(1.874);
    expect(by('Max equity drawdown (intrabar)')).toBe(65.8);
    expect(by('Max drawdown (close-to-close)')).toBe(60.8);
    expect(by('Run-up periods')).toBe(5);
    expect(by('Account size required')).toBe(412.45);
    expect(by('Margin calls')).toBe(0);
    expect(by('Margin for longs')).toBe(3.33);
  });
});

describe('formatting', () => {
  const grossLoss = PERFORMANCE_GROUPS[0].rows.find((r) => r.label === 'Gross loss')!;
  const net = PERFORMANCE_GROUPS[0].rows.find((r) => r.label === 'Net profit')!;
  const pf = PERFORMANCE_GROUPS[0].rows.find((r) => r.label === 'Profit factor')!;

  it('prints loss magnitudes as losses', () => {
    expect(formatMetricValue(grossLoss, 101.6, 'USD')).toBe(`${MINUS}101.60 USD`);
    expect(formatMetricPercent(grossLoss, 1.016)).toBe(`${MINUS}1.02%`);
  });

  it('signs gains and losses and colours them by sign', () => {
    expect(formatMetricValue(net, 606.2, 'USD')).toBe('+606.20 USD');
    expect(formatMetricValue(net, -94.4, 'USD')).toBe(`${MINUS}94.40 USD`);
    expect(metricToneClass(net, 606.2)).toBe('gain');
    expect(metricToneClass(net, -94.4)).toBe('loss');
    expect(metricToneClass(net, 0)).toBe('');
    expect(metricToneClass(grossLoss, 101.6)).toBe('loss');
  });

  it('prints na as a dash, never "null" or "NaN"', () => {
    expect(formatMetricValue(pf, null, 'USD')).toBe('—');
    expect(formatMetricPercent(net, null)).toBe('');
    expect(metricToneClass(net, null)).toBe('');
  });

  it('uses three decimals for ratios', () => {
    expect(formatMetricValue(pf, 6.9665, '')).toBe('6.967');
  });

  it('prints Pine quantities in units, never lots', () => {
    const maxHeld = PERFORMANCE_GROUPS[0].rows.find((r) => r.label === 'Max contracts held')!;
    const liquidated = CAPITAL_GROUPS.flatMap((g) => g.rows).find(
      (r) => r.label === 'Liquidated quantity',
    )!;
    expect(maxHeld.kind).toBe('units');
    expect(formatMetricValue(maxHeld, 100_000, 'USD')).toBe('100,000 units');
    expect(formatMetricValue(liquidated, 1, 'USD')).toBe('1 unit');
    expect(formatMetricValue(liquidated, null, 'USD')).toBe('—');
  });
});
