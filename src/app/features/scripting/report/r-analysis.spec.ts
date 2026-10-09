import { describe, expect, it } from 'vitest';

import {
  bootstrapMeanInterval,
  deflatedSharpe,
  priceR,
  probit,
  rHistogram,
  rSampleFromEngineTrades,
  rSampleFromReport,
  summarizeR,
} from './r-analysis';
import type { ReportTrade, StrategyReport } from './strategy-report.model';

function trade(over: Partial<ReportTrade>): ReportTrade {
  return {
    number: 1,
    isOpen: false,
    direction: 'long',
    entryId: '',
    entrySignal: '',
    entryTime: null,
    entryBarIndex: null,
    entryPrice: 1.1,
    exitId: '',
    exitSignal: '',
    exitTime: null,
    exitBarIndex: null,
    exitPrice: 1.11,
    exitLeg: '',
    qty: 1,
    positionValue: null,
    profit: null,
    profitPercent: null,
    cumulativeProfit: null,
    cumulativeProfitPercent: null,
    runUp: null,
    runUpPercent: null,
    drawdown: null,
    drawdownPercent: null,
    barsHeld: null,
    commission: null,
    initialStopPrice: null,
    rMultiple: null,
    ...over,
  };
}

const report = (trades: ReportTrade[]) => ({ trades }) as unknown as StrategyReport;

describe('priceR', () => {
  it('measures the move against the distance to the entry stop, both sides', () => {
    expect(priceR('long', 1.1, 1.12, 1.09)).toBeCloseTo(2, 9);
    expect(priceR('long', 1.1, 1.095, 1.09)).toBeCloseTo(-0.5, 9);
    expect(priceR('short', 1.1, 1.08, 1.11)).toBeCloseTo(2, 9);
    expect(priceR('Short', 1.1, 1.11, 1.11)).toBeCloseTo(-1, 9);
  });

  it('has no R without a stop on the losing side', () => {
    expect(priceR('long', 1.1, 1.12, null)).toBeNull();
    expect(priceR('long', 1.1, 1.12, 1.1)).toBeNull();
    expect(priceR('long', 1.1, 1.12, 1.15)).toBeNull();
    expect(priceR('short', 1.1, 1.05, 1.08)).toBeNull();
  });
});

describe('R samples', () => {
  it('uses the report’s own R when it carries it (C6), closed trades only', () => {
    const s = rSampleFromReport(
      report([
        trade({ rMultiple: 1.5 }),
        trade({ rMultiple: -1 }),
        trade({ rMultiple: null, initialStopPrice: 1.09 }),
        trade({ isOpen: true, rMultiple: 3 }),
      ]),
    );
    expect(s).toEqual({ values: [1.5, -1], basis: 'reported', closed: 3 });
  });

  it('falls back to the price R of trades with an initial stop', () => {
    const s = rSampleFromReport(
      report([trade({ initialStopPrice: 1.09 }), trade({ initialStopPrice: null })]),
    );
    expect(s.basis).toBe('price');
    expect(s.values).toHaveLength(1);
    expect(s.values[0]).toBeCloseTo(1, 9);
    expect(s.closed).toBe(2);
  });

  it('has none when no trade carries a stop', () => {
    expect(rSampleFromReport(report([trade({})]))).toEqual({ values: [], basis: null, closed: 1 });
  });

  it('reads the engine trade list: RMultiple, else PnL ÷ RiskedAmount', () => {
    const s = rSampleFromEngineTrades([
      { RMultiple: 2 },
      { PnL: -50, RiskedAmount: 100 },
      { PnL: 20, RiskedAmount: null },
      { rMultiple: 0.5 },
      null,
    ]);
    expect(s).toEqual({ values: [2, -0.5, 0.5], basis: 'engine', closed: 5 });
  });
});

describe('summarizeR', () => {
  it('summarises expectancy, spread and the Sharpe in R', () => {
    const s = summarizeR([2, -1, -1, 3, -1])!;
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(0.4, 9);
    expect(s.median).toBe(-1);
    // Squared deviations from 0.4 sum to 15.2: variance 15.2 / 4.
    expect(s.stdev).toBeCloseTo(Math.sqrt(3.8), 9);
    expect(s.sharpe).toBeCloseTo(0.4 / Math.sqrt(3.8), 9);
    expect(s.tStat).toBeCloseTo((0.4 / Math.sqrt(3.8)) * Math.sqrt(5), 9);
    expect(s.sqn).toBeCloseTo(s.tStat!, 9);
    expect(s.winRate).toBeCloseTo(0.4, 9);
    expect(s.avgWin).toBe(2.5);
    expect(s.avgLoss).toBe(-1);
    expect([s.best, s.worst]).toEqual([3, -1]);
  });

  it('caps the SQN’s n at 100', () => {
    const values = Array.from({ length: 400 }, (_, i) => (i % 2 ? 1.2 : -1));
    const s = summarizeR(values)!;
    expect(s.sqn! / s.tStat!).toBeCloseTo(Math.sqrt(100 / 400), 9);
  });

  it('leaves the spread undefined for one trade, and the ratios for no variation', () => {
    expect(summarizeR([1])!.stdev).toBeNull();
    const flat = summarizeR([1, 1, 1])!;
    expect(flat.stdev).toBe(0);
    expect(flat.sharpe).toBeNull();
    expect(summarizeR([])).toBeNull();
  });
});

describe('bootstrapMeanInterval', () => {
  const sample = Array.from({ length: 60 }, (_, i) => [2, -1, -1, 1.5, -1, 0.5][i % 6]);

  it('brackets the mean and is the same every time for the same sample', () => {
    const a = bootstrapMeanInterval(sample)!;
    const b = bootstrapMeanInterval(sample)!;
    expect(a).toEqual(b);
    const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
    expect(a.low).toBeLessThan(mean);
    expect(a.high).toBeGreaterThan(mean);
    expect(a.level).toBe(0.95);
  });

  it('narrows as the sample grows', () => {
    const small = bootstrapMeanInterval(sample.slice(0, 12))!;
    const large = bootstrapMeanInterval([...sample, ...sample, ...sample, ...sample])!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('collapses on a constant sample and needs two trades', () => {
    const flat = bootstrapMeanInterval([0.5, 0.5, 0.5])!;
    expect([flat.low, flat.high]).toEqual([0.5, 0.5]);
    expect(bootstrapMeanInterval([1])).toBeNull();
  });
});

describe('rHistogram', () => {
  it('bins every trade once, with open bins beyond −3R and +6R', () => {
    const values = [-4, -1, -1, -0.2, 0, 0.3, 1.9, 2, 7.5];
    const bins = rHistogram(values);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(values.length);
    expect(bins[0]).toMatchObject({ from: null, to: -3, count: 1, label: '< −3R' });
    expect(bins[bins.length - 1]).toMatchObject({ from: 6, to: null, count: 1, label: '≥ 6R' });
  });

  it('uses quarter-R bins for a tight sample, edges inclusive below', () => {
    const bins = rHistogram([-1, -1, -0.75, 0.25, 0.5]);
    expect(bins[0]).toMatchObject({ from: -1, to: -0.75, count: 2, losing: true });
    expect(bins.find((b) => b.from === -0.75)!.count).toBe(1);
    expect(bins.find((b) => b.from === 0.25)!.label).toBe('0.25 to 0.5R');
    expect(bins.find((b) => b.from === 0.5)!.count).toBe(1);
  });

  it('is empty without trades', () => {
    expect(rHistogram([])).toEqual([]);
  });
});

describe('deflated Sharpe (the promotion gate’s formula)', () => {
  it('uses the engine’s probit', () => {
    expect(probit(0.5)).toBeCloseTo(0, 9);
    expect(probit(0.975)).toBeCloseTo(1.9599639845, 6);
    expect(probit(0.9)).toBeCloseTo(1.2815515655, 6);
    expect(probit(0.01)).toBeCloseTo(-2.326347874, 6);
  });

  it('matches the gate on reference values', () => {
    // Reference: Python statistics.NormalDist().inv_cdf with the gate's formula.
    expect(deflatedSharpe(0.2, 10, 100)).toBeCloseTo(0.4254016987, 5);
    expect(deflatedSharpe(0.35, 50, 40)).toBeCloseTo(-0.0627087313, 5);
    // The gate counts at least two trials, and needs two trades.
    expect(deflatedSharpe(0.1, 1, 30)).toBeCloseTo(0.0279672132, 5);
    expect(deflatedSharpe(0.5, 2, 1)).toBe(0);
  });
});
