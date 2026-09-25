import { describe, expect, it } from 'vitest';

import {
  closedTrades,
  extractStrategyReport,
  maxDrawdownWindow,
  maxRunupWindow,
  monthlyReturnsByYear,
  normalizeStrategyReport,
  openTrades,
  reportCurrency,
  toCamelCase,
} from './strategy-report.model';
import { strategyReportFixture, toPascalCaseKeys } from '../testing/strategy-report.fixture';

describe('toCamelCase (System.Text.Json policy)', () => {
  it.each([
    ['OpenPnL', 'openPnL'],
    ['OpenPnLPercent', 'openPnLPercent'],
    ['Cagr', 'cagr'],
    ['URLValue', 'urlValue'],
    ['ID', 'id'],
    ['MaxDrawdownPercentOfInitialCapital', 'maxDrawdownPercentOfInitialCapital'],
    ['openPnL', 'openPnL'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(toCamelCase(input)).toBe(expected);
  });
});

describe('normalizeStrategyReport', () => {
  it('reads the engine’s camelCase report into the typed model', () => {
    const r = normalizeStrategyReport(strategyReportFixture())!;
    expect(r).not.toBeNull();
    expect(r.meta.symbol).toBe('EURUSD');
    expect(r.meta.timeframe).toBe('60');
    expect(r.meta.useBarMagnifier).toBe(true);
    expect(r.meta.properties?.commissionType).toBe('CashPerOrder');
    expect(r.performance.all.netProfit).toBe(606.2);
    expect(r.performance.long.profitFactor).toBeNull();
    expect(r.performance.short.netProfit).toBe(-94.4);
    expect(r.equity.maxDrawdown).toBe(65.8);
    expect(r.returns.sharpeRatio).toBe(0.412);
    expect(r.capital.accountSizeRequired).toBe(412.45);
    expect(r.trades).toHaveLength(7);
    expect(r.trades[6].isOpen).toBe(true);
    expect(r.trades[6].exitTime).toBeNull();
    expect(r.trades[0].entrySignal).toBe('Breakout long');
    expect(r.trades[1].entrySignal).toBe('Short');
    expect(r.equityCurve).toHaveLength(19);
    expect(r.monthlyReturns).toHaveLength(13);
    expect(r.warnings).toHaveLength(1);
  });

  it('reads a PascalCase serialisation to the same model', () => {
    const camel = normalizeStrategyReport(strategyReportFixture());
    const pascal = normalizeStrategyReport(toPascalCaseKeys(strategyReportFixture()));
    expect(pascal).toEqual(camel);
  });

  it('accepts JSON text', () => {
    const r = normalizeStrategyReport(JSON.stringify(strategyReportFixture()));
    expect(r?.performance.all.totalClosedTrades).toBe(6);
  });

  it('is idempotent', () => {
    const once = normalizeStrategyReport(strategyReportFixture())!;
    expect(normalizeStrategyReport(once)).toEqual(once);
  });

  it('maps the serialiser’s named float literals to na, but leaves text alone', () => {
    const raw = strategyReportFixture();
    raw['returns']['sharpeRatio'] = 'NaN';
    raw['equity']['maxRunupPercent'] = 'Infinity';
    raw['equity']['maxDrawdownPercent'] = '-Infinity';
    raw['trades'][0]['entryId'] = 'NaN';
    raw['trades'][0]['entrySignal'] = 'NaN';
    const r = normalizeStrategyReport(raw)!;
    expect(r.returns.sharpeRatio).toBeNull();
    expect(r.equity.maxRunupPercent).toBeNull();
    expect(r.equity.maxDrawdownPercent).toBeNull();
    expect(r.trades[0].entryId).toBe('NaN');
    expect(r.trades[0].entrySignal).toBe('NaN');
  });

  it('fills missing sections instead of leaving undefined holes', () => {
    const r = normalizeStrategyReport({ performance: { all: { netProfit: 12 } } })!;
    expect(r.performance.all.netProfit).toBe(12);
    expect(r.performance.long.netProfit).toBeNull();
    expect(r.equity.maxDrawdown).toBeNull();
    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
    expect(r.meta.symbol).toBe('');
    expect(r.meta.properties).toBeNull();
  });

  it('drops malformed rows (a month outside 1–12, a curve point without time)', () => {
    const raw = strategyReportFixture();
    raw['monthlyReturns'].push({ year: 2026, month: 13, startEquity: 1, endEquity: 1 });
    raw['equityCurve'].push({ equity: 1 });
    const r = normalizeStrategyReport(raw)!;
    expect(r.monthlyReturns).toHaveLength(13);
    expect(r.equityCurve).toHaveLength(19);
  });

  it('rejects anything that is not a report', () => {
    expect(normalizeStrategyReport(null)).toBeNull();
    expect(normalizeStrategyReport('not json')).toBeNull();
    expect(normalizeStrategyReport([1, 2])).toBeNull();
    // The JSON-DSL BacktestResult a DSL backtest run stores.
    expect(normalizeStrategyReport({ TotalReturn: 1.2, WinRate: 0.5, Trades: [] })).toBeNull();
  });
});

describe('extractStrategyReport', () => {
  it('finds the report at the root of a run’s resultJson', () => {
    const r = extractStrategyReport(JSON.stringify(strategyReportFixture()));
    expect(r?.meta.symbol).toBe('EURUSD');
  });

  it('finds it one level down under a wrapper property, any casing', () => {
    expect(extractStrategyReport({ report: strategyReportFixture() })?.trades).toHaveLength(7);
    const pascal = JSON.stringify({
      TotalTrades: 6,
      StrategyReport: toPascalCaseKeys(strategyReportFixture()),
    });
    expect(extractStrategyReport(pascal)?.performance.all.netProfit).toBe(606.2);
  });

  it('returns null for a DSL run so the page keeps its DSL analytics', () => {
    const dsl = JSON.stringify({
      InitialBalance: 10000,
      FinalBalance: 10100,
      TotalReturn: 1,
      Trades: [{ Direction: 0, PnL: 100 }],
    });
    expect(extractStrategyReport(dsl)).toBeNull();
    expect(extractStrategyReport(null)).toBeNull();
    expect(extractStrategyReport('')).toBeNull();
  });
});

describe('derived views', () => {
  const r = normalizeStrategyReport(strategyReportFixture())!;

  it('splits closed and open trades', () => {
    expect(closedTrades(r)).toHaveLength(6);
    expect(openTrades(r).map((t) => t.number)).toEqual([7]);
  });

  it('uses the account currency, else the declared one, never NONE', () => {
    expect(reportCurrency(r)).toBe('USD');
    const none = normalizeStrategyReport({
      meta: { accountCurrency: '', properties: { currency: 'NONE' } },
      performance: { all: {} },
    })!;
    expect(reportCurrency(none)).toBe('');
  });

  it('pivots monthly returns into year rows with a compounded year total', () => {
    const years = monthlyReturnsByYear(r.monthlyReturns);
    expect(years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(years[0].months.every((m) => m !== null)).toBe(true);
    expect(years[0].yearReturnPercent).toBeCloseTo(6.062, 3);
    expect(years[1].months[0]?.returnPercent).toBe(0.33);
    expect(years[1].months.slice(1).every((m) => m === null)).toBe(true);
  });

  it('locates the largest close-to-close drawdown and run-up on the curve', () => {
    const dd = maxDrawdownWindow(r.equityCurve)!;
    expect(dd.fromIndex).toBe(8);
    expect(dd.toIndex).toBe(11);
    expect(dd.amount).toBeCloseTo(61.2, 6);
    const ru = maxRunupWindow(r.equityCurve)!;
    expect(ru.fromIndex).toBe(1);
    expect(ru.toIndex).toBe(18);
    expect(ru.amount).toBeCloseTo(641.6, 6);
  });

  it('reports no window on a curve that only rises', () => {
    const rising = [1, 2, 3].map((e, i) => ({ ...r.equityCurve[0], time: i, equity: e }));
    expect(maxDrawdownWindow(rising)).toBeNull();
    expect(maxRunupWindow(rising)?.amount).toBe(2);
  });
});
