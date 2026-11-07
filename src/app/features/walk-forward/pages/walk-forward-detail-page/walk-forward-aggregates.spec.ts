import { describe, expect, it } from 'vitest';

import { pooledOos } from './walk-forward-aggregates';

const fold = (
  n: number,
  wr: number,
  pf: number,
  pnl?: number[],
): {
  OosTotalTrades: number;
  OosWinRate: number;
  OosProfitFactor: number;
  Trades?: { PnL: number }[];
} => ({
  OosTotalTrades: n,
  OosWinRate: wr,
  OosProfitFactor: pf,
  Trades: pnl?.map((PnL) => ({ PnL })),
});

describe('pooledOos (U05)', () => {
  it('pools the win rate by trades, not by fold', () => {
    // equal-weight mean would be (1.0 + 0.25) / 2 = 62.5 %; pooled is (2 + 50) / 202
    const a = pooledOos([fold(2, 1, 9999), fold(200, 0.25, 0.8)]);
    expect(a.totalTrades).toBe(202);
    expect(a.winRate).toBeCloseTo(52 / 202, 10);
  });

  it('pools the profit factor from the fold trade lists; a no-loss fold is not 9999', () => {
    const a = pooledOos([fold(2, 1, 9999, [5, 5]), fold(3, 1 / 3, 0.5, [10, -10, -10])]);
    expect(a.profitFactorBasis).toBe('pooled');
    expect(a.profitFactor).toBeCloseTo(20 / 20, 10);
  });

  it('returns Infinity when the pooled trades lost nothing', () => {
    const a = pooledOos([fold(2, 1, 9999, [1, 2])]);
    expect(a.profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it('falls back to the median fold PF (sentinels excluded) when trade lists are missing', () => {
    const a = pooledOos([
      fold(5, 0.4, 0.9),
      fold(5, 0.6, 1.5),
      fold(5, 1, 9999),
      fold(5, 0.5, 1.1),
    ]);
    expect(a.profitFactorBasis).toBe('median');
    expect(a.profitFactor).toBe(1.1);
  });

  it('is empty without trades', () => {
    expect(pooledOos([fold(0, 0, 0)])).toEqual({
      totalTrades: 0,
      winRate: null,
      profitFactor: null,
      profitFactorBasis: 'none',
    });
  });
});
