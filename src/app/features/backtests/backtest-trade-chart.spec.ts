import { describe, expect, it } from 'vitest';
import { initialTimeframe } from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';
import type { ReportTrade } from '@features/scripting/report/strategy-report.model';
import {
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
