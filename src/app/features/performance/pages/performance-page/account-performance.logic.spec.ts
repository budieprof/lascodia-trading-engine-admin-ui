import { describe, expect, it } from 'vitest';
import type { AccountPerformanceSeriesDto } from '@core/services/performance.service';
import {
  accountTotals,
  extremeDays,
  growthOf100,
  meaningfulSlices,
} from './account-performance.logic';

function acct(p: Partial<AccountPerformanceSeriesDto>): AccountPerformanceSeriesDto {
  return {
    tradingAccountId: 1,
    accountName: 'A',
    accountLogin: '1',
    brokerName: 'B',
    accountType: 'Demo',
    currency: 'USD',
    isActive: true,
    isPaper: false,
    startEquity: 100,
    endEquity: 110,
    equityChange: 10,
    compoundedReturn: 0.1,
    realizedPnl: 5,
    executionCosts: 1,
    trades: 4,
    winRate: 0.5,
    sharpeRatio30d: 1,
    sortinoRatio30d: 1,
    calmarRatio30d: 1,
    lastDate: '2026-10-27T00:00:00Z',
    daily: [],
    ...p,
  };
}

describe('account performance logic', () => {
  it('weights win rate by trades and return by starting equity', () => {
    const t = accountTotals([
      acct({ trades: 4, winRate: 0.5, startEquity: 100, compoundedReturn: 0.1 }),
      acct({
        tradingAccountId: 2,
        trades: 0,
        winRate: null,
        startEquity: 300,
        compoundedReturn: -0.1,
        isActive: false,
      }),
    ]);
    expect(t.accounts).toBe(2);
    expect(t.activeAccounts).toBe(1);
    expect(t.winRate).toBe(0.5);
    expect(t.weightedReturn).toBeCloseTo(-0.05, 10); // (100×0.1 + 300×−0.1) / 400
    expect(t.currency).toBe('USD');
    expect(t.endEquity).toBe(220);
  });

  it('reports a mixed-currency book as currency null and no trades as win rate null', () => {
    const t = accountTotals([
      acct({ trades: 0, winRate: null }),
      acct({ currency: 'EUR', trades: 0, winRate: null }),
    ]);
    expect(t.currency).toBeNull();
    expect(t.winRate).toBeNull();
  });

  it('compounds daily returns into a growth-of-100 line', () => {
    const g = growthOf100(
      acct({
        daily: [
          {
            date: 'd1',
            startEquity: 0,
            endEquity: 0,
            realizedPnl: 0,
            dailyReturn: 0.1,
            executionCosts: 0,
            trades: 0,
          },
          {
            date: 'd2',
            startEquity: 0,
            endEquity: 0,
            realizedPnl: 0,
            dailyReturn: -0.1,
            executionCosts: 0,
            trades: 0,
          },
        ],
      }),
    );
    expect(g).toEqual([
      ['d1', 110],
      ['d2', 99],
    ]);
  });

  it('drops empty slices and finds the extreme days', () => {
    expect(
      meaningfulSlices([
        {
          key: 'a',
          strategyId: 1,
          label: 'a',
          realizedPnl: 0,
          executionCosts: 0,
          pnl: 0,
          trades: 0,
          wins: 0,
          accounts: 1,
        },
        {
          key: 'b',
          strategyId: 2,
          label: 'b',
          realizedPnl: 0,
          executionCosts: 0.7,
          pnl: -0.7,
          trades: 0,
          wins: 0,
          accounts: 1,
        },
      ]).map((s) => s.key),
    ).toEqual(['b']);
    const e = extremeDays([
      acct({
        accountName: 'X',
        daily: [
          {
            date: 'd1',
            startEquity: 0,
            endEquity: 0,
            realizedPnl: 0,
            dailyReturn: 0.02,
            executionCosts: 0,
            trades: 0,
          },
          {
            date: 'd2',
            startEquity: 0,
            endEquity: 0,
            realizedPnl: 0,
            dailyReturn: -0.03,
            executionCosts: 0,
            trades: 0,
          },
        ],
      }),
    ]);
    expect(e.best?.date).toBe('d1');
    expect(e.worst?.ret).toBe(-0.03);
  });
});
