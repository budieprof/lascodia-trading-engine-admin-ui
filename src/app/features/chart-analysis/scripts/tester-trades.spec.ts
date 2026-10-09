import { describe, expect, it } from 'vitest';

import {
  backtestTimeframeOf,
  deepBacktestRequest,
  formatPrice,
  orderTrades,
  rowWindow,
} from './tester-trades';

describe('Strategy Tester helpers (PC-I5, PC-12)', () => {
  it('renders a window of rows around the view', () => {
    expect(rowWindow(1000, 0, 300, 30, 10)).toEqual({ start: 0, end: 20, offset: 0, total: 30000 });
    expect(rowWindow(1000, 3000, 300, 30, 10)).toEqual({
      start: 90,
      end: 120,
      offset: 2700,
      total: 30000,
    });
    expect(rowWindow(5, 0, 300, 30, 10)).toEqual({ start: 0, end: 5, offset: 0, total: 150 });
    expect(rowWindow(0, 0, 300, 30, 10).end).toBe(0);
  });

  it('prints a price at the symbol’s precision', () => {
    expect(formatPrice(1.0876543, 5)).toBe('1.08765');
    expect(formatPrice(147.2, 3)).toBe('147.200');
    expect(formatPrice(null, 5)).toBe('—');
    expect(formatPrice(Number.NaN, 5)).toBe('—');
  });

  it('orders the trades by number, newest first on request', () => {
    const t = (number: number) => ({ number }) as never;
    expect(orderTrades([t(2), t(1), t(3)], false).map((x: { number: number }) => x.number)).toEqual([1, 2, 3]);
    expect(orderTrades([t(2), t(1), t(3)], true).map((x: { number: number }) => x.number)).toEqual([3, 2, 1]);
  });

  it('a backtest timeframe is one of the six stored ones, served as stored', () => {
    expect(backtestTimeframeOf('60')).toBe('H1');
    expect(backtestTimeframeOf('15')).toBe('M15');
    expect(backtestTimeframeOf('1')).toBe('M1');
    // Folded, or on the session grid: none.
    expect(backtestTimeframeOf('30')).toBeNull();
    expect(backtestTimeframeOf('240')).toBeNull();
    expect(backtestTimeframeOf('1D')).toBeNull();
  });

  it('builds the deep backtest request: overrides only where the chart differs', () => {
    const target = {
      strategyId: 7,
      strategySymbol: 'EURUSD',
      strategyTimeframe: 'H1',
      chartSymbol: 'eurusd',
      chartTimeframe: 'H1' as const,
    };
    expect(deepBacktestRequest(target, { fromDate: '2025-01-01', toDate: '2025-06-01' }, {})).toEqual({
      strategyId: 7,
      symbol: 'EURUSD',
      timeframe: 'H1',
      fromDate: '2025-01-01',
      toDate: '2025-06-01',
      deep: true,
    });
    // A chart timeframe that is no backtest timeframe runs the strategy's own.
    const own = deepBacktestRequest(
      { ...target, chartSymbol: 'GBPUSD', chartTimeframe: null },
      { fromDate: '2025-01-01', toDate: '2025-06-01' },
      { len: 3 },
    );
    expect(own).toMatchObject({ symbolOverride: 'GBPUSD', inputs: { len: 3 } });
    expect('timeframeOverride' in (own as object)).toBe(false);
    expect(deepBacktestRequest(target, { fromDate: '', toDate: '2025-06-01' }, {})).toBe(
      'Choose a start and an end date.',
    );
  });
});
