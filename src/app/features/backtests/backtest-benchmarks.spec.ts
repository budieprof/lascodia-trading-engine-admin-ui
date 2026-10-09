import { describe, expect, it } from 'vitest';
import { backtestBenchmarksOf, summarizeBenchmarks } from './backtest-benchmarks';

// Shape the engine writes (BacktestBenchmarks, PascalCase like the rest of ResultJson).
const wire = {
  Trades: [],
  Benchmarks: {
    BuyAndHoldPriceReturnPct: 4.25,
    BuyAndHoldCarryPct: -1.5,
    CarryAdjustedBuyAndHoldReturnPct: 2.75,
    CarryNights: 312,
    RandomEntry: {
      Samples: 1000,
      Seed: 42,
      Trades: 48,
      TradesWithoutR: 2,
      StrategySumR: 14.2,
      RandomMedianSumR: -3.1,
      RandomP5SumR: -12.4,
      RandomP95SumR: 7.9,
      ShareAtLeastStrategy: 0.004,
    },
    Notes: ['  Carry priced at each bar close.  ', ''],
  },
};

describe('backtestBenchmarksOf', () => {
  it('reads the engine’s Benchmarks object', () => {
    const b = backtestBenchmarksOf(JSON.stringify(wire))!;
    expect(b.buyAndHoldPriceReturnPct).toBe(4.25);
    expect(b.buyAndHoldCarryPct).toBe(-1.5);
    expect(b.carryAdjustedBuyAndHoldReturnPct).toBe(2.75);
    expect(b.carryNights).toBe(312);
    expect(b.randomEntry).toMatchObject({
      samples: 1000,
      trades: 48,
      tradesWithoutR: 2,
      strategySumR: 14.2,
    });
    expect(b.notes).toEqual(['Carry priced at each bar close.']);
  });

  it('tolerates camelCase and nulls the parts the run could not measure', () => {
    const b = backtestBenchmarksOf(
      JSON.stringify({
        benchmarks: {
          buyAndHoldPriceReturnPct: -2,
          buyAndHoldCarryPct: null,
          carryAdjustedBuyAndHoldReturnPct: null,
          carryNights: 0,
          randomEntry: null,
          notes: ['Random entries: only 6 trades with a stop (need 10).'],
        },
      }),
    )!;
    expect(b.buyAndHoldCarryPct).toBeNull();
    expect(b.carryAdjustedBuyAndHoldReturnPct).toBeNull();
    expect(b.randomEntry).toBeNull();
    expect(b.notes).toHaveLength(1);
  });

  it('is null for older runs, rule-engine runs and bad JSON', () => {
    expect(backtestBenchmarksOf(null)).toBeNull();
    expect(backtestBenchmarksOf('{"Trades":[]}')).toBeNull();
    expect(backtestBenchmarksOf('{"Benchmarks":null}')).toBeNull();
    expect(backtestBenchmarksOf('not json')).toBeNull();
  });
});

describe('summarizeBenchmarks', () => {
  it('compares the run with holding and with random entries', () => {
    const v = summarizeBenchmarks(backtestBenchmarksOf(JSON.stringify(wire))!, 6.5);
    expect(v.buyAndHold.comparison).toBe(
      'The run returned +6.50%, 3.75 points more than holding a long with its swap (+2.75%).',
    );
    const r = v.random!;
    expect(r.tone).toBe('beats');
    expect(r.verdict).toContain('above 95% of random entries');
    expect(r.verdict).toContain('only 0.4% reached it');
    expect(r.detail).toContain('1,000 random runs (seed 42) re-entered 48 trades');
    expect(r.detail).toContain('2 trades without a stop left out');
    // The run is the right end of the shared axis; the band sits inside it.
    expect(r.axis.run).toBe(100);
    expect(r.axis.p5).toBe(0);
    expect(r.axis.p95).toBeGreaterThan(r.axis.median);
  });

  it('says when the run sits inside the random range or below it', () => {
    const base = backtestBenchmarksOf(JSON.stringify(wire))!;
    const inside = summarizeBenchmarks(
      {
        ...base,
        randomEntry: { ...base.randomEntry!, strategySumR: 1.0, shareAtLeastStrategy: 0.3 },
      },
      null,
    );
    expect(inside.random!.tone).toBe('inside');
    expect(inside.random!.verdict).toContain('beat 70% of random entries');
    expect(inside.buyAndHold.comparison).toBeNull();

    const below = summarizeBenchmarks(
      {
        ...base,
        randomEntry: { ...base.randomEntry!, strategySumR: -20, shareAtLeastStrategy: 1 },
      },
      null,
    );
    expect(below.random!.tone).toBe('below');
    expect(below.random!.verdict).toContain('did worse than chance');
  });

  it('compares with the price return alone when the run modelled no swap', () => {
    const b = backtestBenchmarksOf(
      JSON.stringify({ Benchmarks: { BuyAndHoldPriceReturnPct: 3, CarryNights: 0, Notes: [] } }),
    )!;
    expect(summarizeBenchmarks(b, 1).buyAndHold.comparison).toBe(
      'The run returned +1.00%, 2.00 points less than holding a long (+3.00%).',
    );
  });
});
