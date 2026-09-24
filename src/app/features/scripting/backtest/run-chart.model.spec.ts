import { describe, expect, it } from 'vitest';

import type { CandleDto } from '@core/api/api.types';
import { normalizeStrategyReport } from '../report/strategy-report.model';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import {
  candleChartData,
  chartReport,
  engineTimeframe,
  runWindow,
  storedRunChartData,
  tradesBefore,
} from './run-chart.model';

const report = normalizeStrategyReport(strategyReportFixture())!;
const H = 3_600_000;

function candle(ms: number, close = 1.1): CandleDto {
  return {
    id: ms,
    symbol: 'EURUSD',
    timeframe: 'H1',
    open: close,
    high: close + 0.001,
    low: close - 0.001,
    close,
    volume: 10,
    timestamp: new Date(ms).toISOString(),
    isClosed: true,
  };
}

describe('run chart model', () => {
  it('maps engine and Pine timeframe spellings to the stored timeframes', () => {
    expect(engineTimeframe('60')).toBe('H1');
    expect(engineTimeframe('240')).toBe('H4');
    expect(engineTimeframe('1D')).toBe('D1');
    expect(engineTimeframe('15')).toBe('M15');
    expect(engineTimeframe('M5')).toBe('M5');
    expect(engineTimeframe('H1')).toBe('H1');
    expect(engineTimeframe('30')).toBeNull(); // not stored by the engine
    expect(engineTimeframe(null)).toBeNull();
  });

  it('places trades by time — bar indices count from the run’s first bar, not the chart’s', () => {
    const r = chartReport(report)!;
    const trades = r['trades'] as { entryBarIndex: unknown; entryTime: number }[];
    expect(trades).toHaveLength(report.trades.length);
    expect(trades.every((t) => t.entryBarIndex === null)).toBe(true);
    expect(trades[0].entryTime).toBe(report.trades[0].entryTime);
    expect(chartReport(null)).toBeNull();
  });

  it('charts candles ascending with the report’s trades, leaving out trades closed before them', () => {
    const lastTrade = report.trades[report.trades.length - 1];
    const start = (lastTrade.entryTime as number) - 5 * H;
    // Newest-first, as the candle store answers.
    const candles = Array.from({ length: 10 }, (_, i) => candle(start + (9 - i) * H));
    const data = candleChartData(candles, report)!;
    expect(data.bars.map((b) => b.t)).toEqual(Array.from({ length: 10 }, (_, i) => start + i * H));
    // Only the open trade (entered inside the window) survives; the closed ones ended before it.
    expect(data.report?.trades.map((t) => t.number)).toEqual([lastTrade.number]);
    expect(tradesBefore(report, start)).toBe(report.trades.length - 1);
    expect(candleChartData([], report)).toBeNull();
  });

  it('uses the run’s own bars when resultJson carries them, in either top-level casing', () => {
    const bars = [
      { t: 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
      { t: 1_000 + H, o: 1.5, h: 2, l: 1, c: 1.8, v: 1 },
    ];
    const camel = storedRunChartData(JSON.stringify({ report: {}, bars }), report);
    expect(camel?.bars).toHaveLength(2);
    expect(camel?.report?.trades).toHaveLength(report.trades.length);
    const pascal = storedRunChartData(JSON.stringify({ Report: {}, Bars: bars }), null);
    expect(pascal?.bars).toHaveLength(2);
    // A bare report (no bars) is not a chart.
    expect(storedRunChartData(JSON.stringify(strategyReportFixture()), report)).toBeNull();
    expect(storedRunChartData('not json', report)).toBeNull();
  });

  it('bounds the candle window by the report’s first/last bar, else by the run’s dates', () => {
    const run = { fromDate: '2024-01-01T00:00:00Z', toDate: '2024-06-01T00:00:00Z' };
    expect(runWindow(run, report)).toEqual({
      from: new Date(report.meta.firstBarTime as number).toISOString(),
      to: new Date(report.meta.lastBarTimeClose as number).toISOString(),
    });
    expect(runWindow(run, null)).toEqual({ from: run.fromDate, to: run.toDate });
  });
});
