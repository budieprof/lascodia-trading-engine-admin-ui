import { describe, expect, it } from 'vitest';

import type { ExecutionQualityLogDto } from '@core/api/api.types';

import type { ScriptLiveClosedTrade } from '../api/scripting-api.types';
import { reportPalette } from '../report/report-charts';
import {
  buildOverlayOptions,
  cumulativeVsExpected,
  divergenceMarkers,
  expectationOf,
  overlayVerdict,
  rollingSlippage,
  stageTimeline,
} from './live-vs-backtest';

/** A long trade risking 0.0010 from 1.1000; exit sets its R. */
function trade(
  origin: 'paper' | 'live' | 'warmup',
  r: number,
  exitMs: number,
): ScriptLiveClosedTrade {
  return {
    tradeKey: exitMs,
    entryId: 'L',
    direction: 'long',
    qty: 1,
    lots: 0.01,
    entryPrice: 1.1,
    entryTimeMs: exitMs - 10,
    exitPrice: 1.1 + r * 0.001,
    exitTimeMs: exitMs,
    exitLeg: '',
    exitComment: '',
    profit: r,
    stopLoss: 1.099,
    takeProfit: null,
    origin,
  };
}

describe('expectationOf', () => {
  it('takes the mean and sample sd of the backtest R', () => {
    const e = expectationOf({
      backtestRunId: 7,
      rValues: [1, -1, 2, 0],
      fromDate: null,
      toDate: null,
    })!;
    expect(e.meanR).toBeCloseTo(0.5, 10);
    expect(e.sdR).toBeCloseTo(Math.sqrt(5 / 3), 10);
    expect(e.trades).toBe(4);
  });
  it('is null without any R', () => {
    expect(
      expectationOf({ backtestRunId: 7, rValues: [], fromDate: null, toDate: null }),
    ).toBeNull();
  });
});

describe('cumulativeVsExpected (U09)', () => {
  const e = { backtestRunId: 1, trades: 100, meanR: 0.2, sdR: 1 };

  it('cumulates one origin in close order, with expected = mean × n and σ√n bands', () => {
    const trades = [
      trade('live', 1, 300),
      trade('live', -1, 100),
      trade('paper', 5, 200),
      trade('warmup', 9, 50),
    ];
    const out = cumulativeVsExpected(trades, 'live', e);
    expect(out.closed).toBe(2);
    expect(out.points.map((p) => p.realised.toFixed(6))).toEqual(['-1.000000', '0.000000']);
    expect(out.points[1].expected).toBeCloseTo(0.4, 10);
    expect(out.points[1].band1![0]).toBeCloseTo(0.4 - Math.sqrt(2), 10);
    expect(out.points[1].band2![1]).toBeCloseTo(0.4 + 2 * Math.sqrt(2), 10);
  });

  it('skips trades without a stop and draws no band without an expectation', () => {
    const noStop = { ...trade('paper', 1, 10), stopLoss: null };
    const out = cumulativeVsExpected([noStop, trade('paper', 1, 20)], 'paper', null);
    expect(out.closed).toBe(2);
    expect(out.withR).toBe(1);
    expect(out.points[0].expected).toBeNull();
    expect(out.points[0].band1).toBeNull();
  });

  it('says where the realised line sits in words', () => {
    const inside = cumulativeVsExpected([trade('live', 0.2, 1)], 'live', e).points;
    expect(overlayVerdict(inside)).toContain('inside the 1σ band');
    const outside = cumulativeVsExpected([trade('live', -5, 1)], 'live', e).points;
    expect(overlayVerdict(outside)).toContain('outside the 2σ band');
    expect(
      overlayVerdict(cumulativeVsExpected([trade('live', 1, 1)], 'live', null).points),
    ).toBeNull();
  });

  it('builds no chart without session trades', () => {
    expect(
      buildOverlayOptions([{ origin: 'live', points: [] }], [], [], reportPalette('light')),
    ).toBeNull();
  });
});

describe('rollingSlippage', () => {
  const row = (i: number, pips: number): ExecutionQualityLogDto =>
    ({
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      slippagePips: pips,
    }) as ExecutionQualityLogDto;

  it('needs five fills before the first median and orders fills by time', () => {
    const rows = [row(5, 5), row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(6, 100)];
    const out = rollingSlippage(rows, 20);
    expect(out).toHaveLength(2);
    expect(out[0].median).toBe(3); // 1..5
    expect(out[1].median).toBe(3.5); // 1..5,100
  });
});

describe('stageTimeline + divergence markers', () => {
  it('orders milestones from stored records and leaves out what has none', () => {
    const m = stageTimeline({
      backtest: {
        id: 4,
        completedAt: '2026-01-02T00:00:00Z',
        fromDate: '2024-01-01T00:00:00',
        toDate: '2025-12-31T00:00:00',
      },
      walkForward: null,
      trades: [trade('paper', 1, Date.UTC(2026, 1, 1)), trade('live', 1, Date.UTC(2026, 2, 1))],
      lifecycleStage: 'Active',
      lifecycleStageEnteredAt: '2026-02-20T00:00:00Z',
    });
    expect(m.map((x) => x.stage)).toEqual(['backtest', 'paper', 'current', 'live']);
    expect(m[0].detail).toContain('2024-01-01');
  });

  it('reads divergence times as UTC and keeps the kind', () => {
    const d = divergenceMarkers([
      {
        timeUtc: '2026-03-01T10:00:00',
        accountId: null,
        kind: 'BarRevised',
        detail: 'late candle',
      },
      { timeUtc: 'nonsense', accountId: null, kind: 'X', detail: '' },
    ]);
    expect(d).toEqual([
      { time: Date.UTC(2026, 2, 1, 10), kind: 'BarRevised', detail: 'late candle' },
    ]);
  });
});
