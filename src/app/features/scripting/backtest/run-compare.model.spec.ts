import { describe, expect, it } from 'vitest';

import {
  basketSummary,
  basketVerdict,
  compareMetrics,
  compareSetup,
  equityOverlayOptions,
  parseBasket,
  summarizeRun,
  type CompareRun,
} from './run-compare.model';
import { reportPalette } from '../report/report-charts';

function run(over: Partial<CompareRun> = {}): CompareRun {
  return {
    id: 1,
    strategyId: 41,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromDate: '2025-01-01T00:00:00Z',
    toDate: '2026-01-01T00:00:00Z',
    initialBalance: 10000,
    status: 'Completed',
    resultJson: null,
    errorMessage: null,
    startedAt: '2026-01-02T00:00:00Z',
    completedAt: '2026-01-02T00:05:00Z',
    totalTrades: 120,
    winRate: 0.45,
    profitFactor: 1.3,
    maxDrawdownPct: 8.5,
    sharpeRatio: 0.9,
    finalBalance: 11200,
    totalReturn: 12,
    ...over,
  } as CompareRun;
}

const script = (sourceHash: string, inputs: Record<string, unknown>) =>
  JSON.stringify({
    ExpectancyR: 0.18,
    Trades: [],
    script: { sourceHash, inputs, costModel: 'Snapshot', deep: false, barMagnifier: true },
  });

describe('parseBasket', () => {
  it('upper-cases, de-duplicates and leaves the strategy’s own market out', () => {
    expect(parseBasket('gbpusd, usdjpy;EURUSD  gbpusd\nAUDUSD', 'eurusd')).toEqual({
      symbols: ['GBPUSD', 'USDJPY', 'AUDUSD'],
      error: null,
    });
    expect(parseBasket('   ', 'EURUSD')).toEqual({ symbols: [], error: null });
  });

  it('refuses something that is not a symbol, and a basket too large', () => {
    expect(parseBasket('EUR/USD', 'EURUSD').error).toContain('"EUR/USD" is not a symbol');
    const many = Array.from({ length: 13 }, (_, i) => `SYM${i}`).join(' ');
    expect(parseBasket(many, 'EURUSD').error).toContain('at most 12');
  });
});

describe('summarizeRun', () => {
  it('reads the metrics, the engine R and provenance, and rebases the equity to its start', () => {
    const s = summarizeRun(
      run({
        symbolOverride: 'GBPUSD',
        symbol: 'GBPUSD',
        resultJson: script('abc', { len: 20 }),
        equityCurve: [
          { time: '2025-01-01T00:00:00Z', equity: 10000, drawdownPct: 0 },
          { time: '2025-06-01T00:00:00Z', equity: 10500, drawdownPct: 0 },
          { time: '2025-12-01T00:00:00Z', equity: 9800, drawdownPct: 6.7 },
        ],
      }),
    );
    expect(s.override).toBe(true);
    expect(s.expectancyR).toBe(0.18);
    expect(s.provenance!.sourceHash).toBe('abc');
    expect(s.equity.map((p) => +p.pct.toFixed(2))).toEqual([0, 5, -2]);
  });
});

describe('basket summary', () => {
  it('counts the markets that made money and takes the medians', () => {
    const rows = [
      summarizeRun(
        run({ id: 1, totalReturn: 12, resultJson: JSON.stringify({ ExpectancyR: 0.2 }) }),
      ),
      summarizeRun(
        run({
          id: 2,
          symbolOverride: 'GBPUSD',
          totalReturn: -4,
          resultJson: JSON.stringify({ ExpectancyR: -0.1 }),
        }),
      ),
      summarizeRun(
        run({
          id: 3,
          symbolOverride: 'USDJPY',
          totalReturn: 6,
          resultJson: JSON.stringify({ ExpectancyR: 0.05 }),
        }),
      ),
      summarizeRun(run({ id: 4, symbolOverride: 'AUDUSD', status: 'Running', totalReturn: null })),
    ];
    const s = basketSummary(rows);
    expect(s).toMatchObject({ runs: 4, completed: 3, profitable: 2, medianReturn: 6 });
    expect(s.medianExpectancyR).toBeCloseTo(0.05, 9);
    expect(basketVerdict(s, true)).toContain('2 of 3 markets');
  });

  it('calls out an edge that lives only on the strategy’s own market', () => {
    const s = { runs: 4, completed: 4, profitable: 1, medianReturn: -3, medianExpectancyR: -0.1 };
    expect(basketVerdict(s, true)).toContain('Only the strategy’s own market');
    expect(basketVerdict({ ...s, completed: 1 }, true)).toContain('Waiting');
    expect(basketVerdict({ ...s, profitable: 4 }, true)).toContain('the rules travel');
  });
});

describe('two-run comparison', () => {
  const a = summarizeRun(run({ id: 1, resultJson: script('aaa', { len: 20, mode: 'fast' }) }));
  const b = summarizeRun(
    run({
      id: 2,
      totalReturn: 15,
      maxDrawdownPct: 11,
      resultJson: script('bbb', { len: 30, mode: 'fast' }),
    }),
  );

  it('diffs the metrics and marks the better run per metric (lower drawdown is better)', () => {
    const rows = compareMetrics(a, b);
    const ret = rows.find((r) => r.label === 'Return')!;
    expect(ret).toMatchObject({ a: '+12.00%', b: '+15.00%', delta: '+3.00', better: 'b' });
    const dd = rows.find((r) => r.label === 'Max drawdown')!;
    expect(dd.better).toBe('a');
    expect(rows.find((r) => r.label === 'Trades')!.better).toBeNull();
  });

  it('shows how each was made: a different script and the inputs that differ', () => {
    const s = compareSetup(a, b);
    expect(s.sameScript).toBe(false);
    expect(s.inputDiffs).toEqual([{ id: 'len', run: '20', now: '30' }]);
    expect(s.rows.find((r) => r.label === 'Market')!.same).toBe(true);
    expect(s.rows.find((r) => r.label === 'Script')!.same).toBe(false);
  });

  it('overlays the two rebased equity curves, or nothing without them', () => {
    const palette = reportPalette('light');
    expect(equityOverlayOptions(a, b, palette)).toBeNull();
    const curve = [
      { time: '2025-01-01T00:00:00Z', equity: 100, drawdownPct: 0 },
      { time: '2025-02-01T00:00:00Z', equity: 110, drawdownPct: 0 },
    ];
    const ca = summarizeRun(run({ id: 1, equityCurve: curve }));
    const cb = summarizeRun(run({ id: 2, equityCurve: curve }));
    const options = equityOverlayOptions(ca, cb, palette)!;
    expect((options.series as unknown[]).length).toBe(2);
  });
});
