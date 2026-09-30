import { describe, expect, it } from 'vitest';

import { normalizeStrategyReport } from './strategy-report.model';
import {
  buildTradeColumns,
  exitLabel,
  filterTrades,
  tradeFilterCounts,
} from './report-trades-columns';
import { parseTradeOrigin, tradeOriginTitle, type TradeOrigin } from './trade-origin';
import { strategyReportFixture } from '../testing/strategy-report.fixture';

const trades = normalizeStrategyReport(strategyReportFixture())!.trades;

describe('List of trades columns', () => {
  const cols = buildTradeColumns('USD', 5);
  const byHeader = (h: string) => cols.find((c) => c.headerName === h)!;

  it('shows everything the Strategy Tester lists for a trade', () => {
    expect(cols.map((c) => c.headerName)).toEqual([
      '#',
      'Type',
      'Entry signal',
      'Entry time (UTC)',
      'Entry price',
      'Exit signal',
      'Exit time (UTC)',
      'Exit price',
      'Qty (units)',
      'Profit',
      'Cum. profit',
      'Run-up (MFE)',
      'Drawdown (MAE)',
      'Bars',
      'Commission',
    ]);
  });

  it('sizes trades in Pine units, not broker lots', () => {
    const qty = byHeader('Qty (units)');
    expect(qty.field).toBe('qty');
    expect(qty.headerTooltip).toContain('100,000 units is one standard FX lot');
    const format = qty.valueFormatter as (p: any) => string;
    expect(format({ value: 100_000 })).toBe('100,000');
  });

  it('is sortable and filterable column by column', () => {
    const numeric = cols.filter((c) => c.type === 'numericColumn');
    expect(numeric.every((c) => c.filter === 'agNumberColumnFilter')).toBe(true);
    expect(byHeader('Entry signal').filter).toBe('agTextColumnFilter');
  });

  it('flags open trades in the type and exit columns', () => {
    const type = byHeader('Type').cellRenderer as (p: any) => string;
    expect(type({ data: trades[6] })).toContain('Open');
    expect(type({ data: trades[0] })).not.toContain('Open');
    const exitTime = byHeader('Exit time (UTC)').valueFormatter as (p: any) => string;
    expect(exitTime({ data: trades[6], value: null })).toBe('Open');
  });

  it('prints profit with its percentage and colour class', () => {
    const profit = byHeader('Profit').cellRenderer as (p: any) => string;
    const html = profit({ data: trades[1] });
    expect(html).toContain('rpt-loss');
    expect(html).toContain('40.80 USD');
    expect(profit({ data: trades[4] })).toContain('+499.20 USD');
  });

  it('keeps script-supplied text out of HTML renderers', () => {
    // Signals come from the script: they render through the grid's text path, not a renderer.
    expect(byHeader('Entry signal').cellRenderer).toBeUndefined();
    expect(byHeader('Exit signal').cellRenderer).toBeUndefined();
  });

  it('has no Origin column unless the host knows each trade’s origin (backtests never do)', () => {
    expect(cols.some((c) => c.colId === 'origin')).toBe(false);
    expect(buildTradeColumns('USD', 5, null)).toHaveLength(cols.length);
  });
});

describe('Origin column (live session)', () => {
  const origins: Record<number, TradeOrigin | null> = { 1: 'warmup', 5: 'paper', 6: 'live' };
  const cols = buildTradeColumns('USD', 5, (t) => origins[t.number ?? -1] ?? null);
  const origin = cols.find((c) => c.colId === 'origin')!;

  it('follows the trade type', () => {
    expect(cols.map((c) => c.headerName).slice(0, 4)).toEqual([
      '#',
      'Type',
      'Origin',
      'Entry signal',
    ]);
    expect(origin.headerTooltip).toContain('historical replay');
  });

  it('badges each trade, with "—" for an unknown one', () => {
    const render = origin.cellRenderer as (p: any) => string;
    expect(render({ data: trades[0] })).toBe(
      '<span class="rpt-origin rpt-origin-warmup">Warm-up</span>',
    );
    expect(render({ data: trades[4] })).toContain('Paper');
    expect(render({ data: trades[5] })).toContain('rpt-origin-live');
    expect(render({ data: trades[1] })).toBe('—');
  });

  it('filters and searches on the badge text', () => {
    const value = origin.valueGetter as (p: any) => string;
    expect(value({ data: trades[0] })).toBe('Warm-up');
    expect(value({ data: trades[1] })).toBe('');
    expect(origin.filter).toBe('agTextColumnFilter');
    const tip = origin.tooltipValueGetter as (p: any) => string;
    expect(tip({ data: trades[0] })).toContain('not evidence');
  });
});

describe('trade origin', () => {
  it('reads the wire value in any casing, and nothing else', () => {
    expect(parseTradeOrigin('warmup')).toBe('warmup');
    expect(parseTradeOrigin('Warm-up')).toBe('warmup');
    expect(parseTradeOrigin('WarmUp')).toBe('warmup');
    expect(parseTradeOrigin('Paper')).toBe('paper');
    expect(parseTradeOrigin('LIVE')).toBe('live');
    expect(parseTradeOrigin('backtest')).toBeNull();
    expect(parseTradeOrigin(null)).toBeNull();
    expect(parseTradeOrigin(2)).toBeNull();
  });

  it('titles an unknown origin honestly', () => {
    expect(tradeOriginTitle('warmup')).toBe('Warm-up replay');
    expect(tradeOriginTitle(null)).toBe('Origin unknown');
  });
});

describe('trade filters', () => {
  it('counts each pill', () => {
    expect(tradeFilterCounts(trades)).toEqual({
      all: 7,
      long: 4,
      short: 3,
      winners: 4,
      losers: 2,
      open: 1,
    });
  });

  it('filters by side and outcome, never counting an open trade as a winner', () => {
    expect(filterTrades(trades, 'short').map((t) => t.number)).toEqual([2, 4, 6]);
    expect(filterTrades(trades, 'winners').map((t) => t.number)).toEqual([1, 3, 5, 6]);
    expect(filterTrades(trades, 'open').map((t) => t.number)).toEqual([7]);
    expect(filterTrades(trades, 'all')).toHaveLength(7);
  });

  it('labels exits with the bracket leg that filled', () => {
    expect(exitLabel(trades[0])).toBe('TP · take profit');
    expect(exitLabel(trades[4])).toBe('Trailing exit · trailing stop');
    expect(exitLabel(trades[5])).toBe('Close entry(s) order Short');
    expect(exitLabel(trades[6])).toBe('Open');
  });
});
