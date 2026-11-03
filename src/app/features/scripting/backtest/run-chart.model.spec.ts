import { describe, expect, it } from 'vitest';

import type { CandleDto } from '@core/api/api.types';
import { parseProvenance } from '../report/engine-run';
import { normalizeStrategyReport } from '../report/strategy-report.model';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import {
  candleChartData,
  chartReport,
  engineTimeframe,
  runWindow,
  scriptPlotsChartData,
  scriptPlotsRequest,
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

describe('scriptPlotsRequest', () => {
  const run = {
    strategyId: 1215,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromDate: '2025-11-03T00:00:00Z',
    toDate: '2026-11-03T00:00:00Z',
  };

  it('asks for the run’s warm-up + traded bars ending at its last bar, with its inputs', () => {
    const prov = parseProvenance({
      inputs: { a: 1, b: true, c: 'x', d: [1] },
      warmupBars: 1000,
      bars: 6243,
    });
    const req = scriptPlotsRequest(run, report, prov)!;
    expect(req).toEqual({
      strategyId: 1215,
      symbol: 'EURUSD',
      timeframe: '60',
      toUtc: new Date(report.meta.lastBarTimeClose as number).toISOString(),
      mode: 'backtest',
      inputs: { a: 1, b: true, c: 'x' },
      lastBars: 7243,
    });
  });

  it('runs over the window when the run’s bar counts are unknown or exceed the cap', () => {
    const window = runWindow(run, report);
    expect(scriptPlotsRequest(run, report, null)).toMatchObject({
      fromUtc: window.from,
      toUtc: window.to,
    });
    const huge = parseProvenance({ warmupBars: 1000, bars: 40_000 });
    expect(scriptPlotsRequest(run, report, huge)!.lastBars).toBeUndefined();
  });

  it('is null without a strategy', () => {
    expect(scriptPlotsRequest({ ...run, strategyId: 0 }, report, null)).toBeNull();
  });
});

describe('scriptPlotsChartData', () => {
  it('keeps the re-run’s bars and plots, and draws the stored run’s trades', () => {
    const t0 = report.trades[0].entryTime as number;
    const data = scriptPlotsChartData(
      {
        compile: null,
        bars: [{ t: t0, o: 1, h: 1, l: 1, c: 1, v: 1 }],
        outputs: null,
        report: null,
        trace: [],
        profile: [],
        runtimeError: null,
        elapsedMs: null,
      },
      report,
    )!;
    expect(data.bars).toHaveLength(1);
    expect(data.report?.trades.length).toBe(report.trades.length);
  });

  it('is null when the run returned no bars', () => {
    expect(
      scriptPlotsChartData(
        {
          compile: null,
          bars: [],
          outputs: null,
          report: null,
          trace: [],
          profile: [],
          runtimeError: null,
          elapsedMs: null,
        },
        report,
      ),
    ).toBeNull();
  });
});
