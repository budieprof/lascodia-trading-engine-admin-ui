import { describe, expect, it } from 'vitest';
import { initialTimeframe } from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';
import type { ReportTrade } from '@features/scripting/report/strategy-report.model';
import {
  chartableTimes,
  matchReportTrade,
  reportRowAsChartable,
  reportTradeAsChartable,
  researchTradeSelection,
  type ChartableTrade,
} from './backtest-trade-chart';

const runTrade: ChartableTrade = {
  Direction: 0,
  EntryPrice: 1.17297,
  ExitPrice: 1.16999,
  EntryTime: '2025-06-27T16:00:00Z',
  ExitTime: '2025-06-27T17:00:00Z',
  ExitReason: 0,
  StopLoss: 1.16999,
  TakeProfit: 1.17595,
};

describe('researchTradeSelection', () => {
  it('draws entry, SL/TP zones and the exit, read-only, on the run timeframe', () => {
    const s = researchTradeSelection(runTrade, {
      symbol: 'EURUSD',
      timeframe: 'H1',
      label: 'Backtest #1330 · trade #1',
    });
    expect(s.title).toBe('Backtest #1330 · trade #1 · EURUSD · Long · exited on stop loss');
    expect(s.direction).toBe('Buy');
    expect([s.stopLoss, s.takeProfit]).toEqual([1.16999, 1.17595]);
    expect([s.exitPrice, s.exitTime]).toEqual([1.16999, '2025-06-27T17:00:00Z']);
    expect(s.timeframe).toBe('H1');
    expect(s.action).toBeNull();
    expect(s.editable).toBeNull();
    expect(s.currentPrice).toBeNull();
  });

  it('draws no zones for a run recorded before SL/TP were kept', () => {
    const s = researchTradeSelection(
      { ...runTrade, StopLoss: undefined, TakeProfit: undefined },
      {
        symbol: 'EURUSD',
        timeframe: 'H1',
        label: 'x',
      },
    );
    expect([s.stopLoss, s.takeProfit]).toEqual([null, null]);
  });

  it('draws no exit for a trade that is still open — never one at the entry price', () => {
    for (const open of [
      { ...runTrade, ExitTime: null, ExitPrice: null },
      { ...runTrade, ExitTime: '', ExitPrice: runTrade.EntryPrice },
    ]) {
      const s = researchTradeSelection(open, { symbol: 'EURUSD', timeframe: 'H1', label: 'x' });
      expect([s.exitPrice, s.exitTime]).toEqual([null, null]);
      expect(s.title).toBe('x · EURUSD · Long · open');
      // No exit → the modal keeps the requested timeframe and its window runs to now.
      expect(initialTimeframe(s)).toBe('H1');
    }
  });

  it('frames a closed trade whose exit price is na without drawing a dot at a made-up price', () => {
    const s = researchTradeSelection(
      { ...runTrade, ExitPrice: null },
      { symbol: 'EURUSD', timeframe: 'H1', label: 'x' },
    );
    expect(s.exitTime).toBe('2025-06-27T17:00:00Z');
    expect(s.exitPrice).toBeNull();
  });
});

describe('reportTradeAsChartable', () => {
  const row = {
    number: 1,
    direction: 'long',
    entryTime: Date.parse('2025-06-27T16:00:00Z'),
    entryPrice: 1.17297,
    exitTime: Date.parse('2025-06-27T17:00:00Z'),
    exitPrice: 1.16999,
    exitLeg: 'StopLoss',
  } as unknown as ReportTrade;

  it("takes SL/TP from the run's matching fill", () => {
    const t = reportTradeAsChartable(row, [runTrade])!;
    expect([t.StopLoss, t.TakeProfit]).toEqual([1.16999, 1.17595]);
    expect(t.ExitReason).toBe(0);
    expect(t.EntryTime).toBe('2025-06-27T16:00:00.000Z');
  });

  it('never borrows levels from the other side or another time', () => {
    const other = [
      { ...runTrade, Direction: 1 },
      { ...runTrade, EntryTime: '2025-06-27T18:00:00Z' },
    ];
    const t = reportTradeAsChartable(row, other)!;
    expect([t.StopLoss, t.TakeProfit]).toEqual([null, null]);
  });

  it('charts a closed row exactly as before: exit from the row, SL/TP from the run', () => {
    const s = researchTradeSelection(reportTradeAsChartable(row, [runTrade])!, {
      symbol: 'EURUSD',
      timeframe: 'H1',
      label: 'Backtest #1330 · trade #1',
    });
    expect(s.title).toBe('Backtest #1330 · trade #1 · EURUSD · Long · exited on stop loss');
    expect([s.exitPrice, s.exitTime]).toEqual([1.16999, '2025-06-27T17:00:00.000Z']);
    expect([s.stopLoss, s.takeProfit]).toEqual([1.16999, 1.17595]);
  });

  it('leaves an open row with no exit anywhere open (no exit at the entry price)', () => {
    const open = { ...row, isOpen: true, exitTime: null, exitPrice: null, exitLeg: '' };
    const t = reportTradeAsChartable(open as ReportTrade, [])!;
    expect([t.ExitTime, t.ExitPrice]).toEqual([null, null]);
    const s = researchTradeSelection(t, { symbol: 'EURUSD', timeframe: 'H1', label: 'x' });
    expect([s.exitPrice, s.exitTime]).toEqual([null, null]);
  });

  it("takes an open row's exit from the run when the run closed it (end of data)", () => {
    const open = { ...row, isOpen: true, exitTime: null, exitPrice: null, exitLeg: '' };
    const t = reportTradeAsChartable(open as ReportTrade, [
      { ...runTrade, ExitReason: 2, ExitPrice: 1.171 },
    ])!;
    expect([t.ExitTime, t.ExitPrice]).toEqual(['2025-06-27T17:00:00Z', 1.171]);
  });
});

describe('matchReportTrade', () => {
  const row = {
    number: 4,
    direction: 'long',
    entryId: 'L',
    entryTime: Date.parse('2025-06-27T16:00:00Z'),
    exitTime: Date.parse('2025-06-27T19:00:00Z'),
  } as unknown as ReportTrade;

  it('prefers the piece of a partially closed trade that shares the exit', () => {
    const first = { ...runTrade, TakeProfit: 1.1 };
    const second = { ...runTrade, ExitTime: '2025-06-27T19:00:00Z', TakeProfit: 1.2 };
    expect(matchReportTrade(row, [first, second], chartableTimes)).toBe(second);
    // Without an exit to compare, the first entry match wins (the old behaviour).
    expect(matchReportTrade({ ...row, exitTime: null }, [first, second], chartableTimes)).toBe(
      first,
    );
  });

  it('never matches an unparseable time, the other side, or a row with no entry', () => {
    expect(matchReportTrade(row, [{ ...runTrade, EntryTime: 'garbage' }], chartableTimes)).toBe(
      undefined,
    );
    expect(matchReportTrade(row, [{ ...runTrade, Direction: 1 }], chartableTimes)).toBe(undefined);
    expect(matchReportTrade({ ...row, entryTime: null }, [runTrade], chartableTimes)).toBe(
      undefined,
    );
  });

  it('reportRowAsChartable returns null for a row without an entry', () => {
    expect(reportRowAsChartable({ ...row, entryPrice: null } as ReportTrade, runTrade)).toBeNull();
  });
});

describe('initialTimeframe', () => {
  it('opens on the requested timeframe when the trade fits', () => {
    expect(
      initialTimeframe({
        timeframe: 'H1',
        referenceTime: '2025-06-27T16:00:00Z',
        exitTime: '2025-06-27T17:00:00Z',
      }),
    ).toBe('H1');
  });

  it('steps up so a long trade keeps its exit on the chart', () => {
    // 68 H1 bars fits H1; ~40 days does not (960 bars) and must step to H4.
    expect(
      initialTimeframe({
        timeframe: 'H1',
        referenceTime: '2025-08-22T15:00:00Z',
        exitTime: '2025-08-27T11:00:00Z',
      }),
    ).toBe('H1');
    expect(
      initialTimeframe({
        timeframe: 'H1',
        referenceTime: '2025-01-01T00:00:00Z',
        exitTime: '2025-02-10T00:00:00Z',
      }),
    ).toBe('H4');
  });

  it('keeps M5 for positions and open trades', () => {
    expect(initialTimeframe({ referenceTime: '2025-01-01T00:00:00Z', exitTime: null })).toBe('M5');
  });
});
