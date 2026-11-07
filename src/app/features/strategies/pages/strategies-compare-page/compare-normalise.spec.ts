import { describe, expect, it } from 'vitest';

import {
  backtestSteps,
  correlationPairs,
  dailyCorrelation,
  liveSteps,
  normalise,
  type CompareStep,
} from './compare-normalise';

const DAY = 86_400_000;
const at = (d: number) => Date.UTC(2026, 0, 1) + d * DAY + 3_600_000;

describe('normalise (U11)', () => {
  it('cumulates in time order and measures the drawdown from 0 in the same unit', () => {
    const s = normalise(
      1,
      [
        { time: at(2), value: -2 },
        { time: at(1), value: 3 },
        { time: at(3), value: 1 },
      ],
      'x',
    );
    expect(s.curve.map((p) => p[1])).toEqual([3, 1, 2]);
    expect(s.total).toBe(2);
    expect(s.maxDrawdown).toBe(2);
    // A curve that starts by losing draws down from 0.
    expect(normalise(1, [{ time: 1, value: -1.5 }], 'x').maxDrawdown).toBe(1.5);
  });
});

describe('backtestSteps', () => {
  const trades = [
    { ExitTime: '2026-01-02T10:00:00', PnL: 50, RiskedAmount: 25 },
    { ExitTime: '2026-01-03T10:00:00', PnL: -20, RMultiple: -1 },
    { ExitTime: '2026-01-04T10:00:00', PnL: 10 }, // no R
    { PnL: 10 }, // no time
  ];

  it('reads R from RMultiple or PnL ÷ RiskedAmount and skips trades without one', () => {
    const { steps, considered } = backtestSteps(trades, 'r', 10_000);
    expect(considered).toBe(4);
    expect(steps.map((s) => s.value)).toEqual([2, -1]);
  });

  it('reads % of initial capital, simple (not compounded)', () => {
    const { steps } = backtestSteps(trades, 'pct', 10_000);
    expect(steps.map((s) => s.value)).toEqual([0.5, -0.2, 0.1]);
    expect(backtestSteps(trades, 'pct', 0).steps).toEqual([]);
  });

  it('reads live points as UTC times', () => {
    expect(liveSteps([{ closedAt: '2026-01-01T00:00:00', realizedPnL: 5 }])).toEqual([
      { time: Date.UTC(2026, 0, 1), value: 5 },
    ]);
  });
});

describe('dailyCorrelation', () => {
  const series = (f: (d: number) => number, days = 20): CompareStep[] =>
    Array.from({ length: days }, (_, d) => ({ time: at(d), value: f(d) }));

  it('is +1 for proportional daily results and −1 for opposed ones over the shared days', () => {
    const a = series((d) => (d % 3) - 1);
    expect(
      dailyCorrelation(
        a,
        series((d) => 2 * ((d % 3) - 1)),
      )!.rho,
    ).toBeCloseTo(1, 10);
    expect(
      dailyCorrelation(
        a,
        series((d) => 1 - (d % 3)),
      )!.rho,
    ).toBeCloseTo(-1, 10);
  });

  it('needs ten shared days and some variation', () => {
    expect(
      dailyCorrelation(
        series(() => 1, 5),
        series(() => 1, 5),
      ),
    ).toBeNull();
    expect(
      dailyCorrelation(
        series(() => 1),
        series((d) => d),
      ),
    ).toBeNull();
  });

  it('lists every pair once', () => {
    const s = [1, 2, 3].map((id) =>
      normalise(
        id,
        series((d) => (d * id) % 5),
        '',
      ),
    );
    expect(correlationPairs(s).map((p) => `${p.a}-${p.b}`)).toEqual(['1-2', '1-3', '2-3']);
  });
});
