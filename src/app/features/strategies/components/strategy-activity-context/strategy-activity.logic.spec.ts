import { describe, expect, it } from 'vitest';
import {
  activityHeadline,
  activityReasons,
  type StrategyActivityFacts,
} from './strategy-activity.logic';

const base: StrategyActivityFacts = {
  id: 1213,
  name: 'Probe',
  symbol: 'XAUUSD',
  timeframe: 'M5',
  status: 'Paused',
  lifecycleStage: 'Draft',
  pauseReason: null,
  isScript: true,
  accountBindingCount: 0,
  lastSignalAt: null,
  backtestCount: 3,
  newestBacktest: { id: 4800, symbol: 'DE40', trades: 0, completedAt: '2026-10-18T22:05:59Z' },
  ownMarketBacktestId: null,
  ownMarketBacktestReturnPct: null,
  walkForwardRunId: null,
  walkForwardOosScore: null,
  lastGate: null,
  rejectionTotal: 0,
  worstRejectionStage: null,
  worstRejectionReason: null,
};

describe('strategy activity reasons', () => {
  it('explains a paused, never-submitted script draft with a no-trade backtest', () => {
    const titles = activityReasons(base).map((r) => r.title);
    expect(titles).toEqual([
      'Paused',
      'Draft — not approved',
      'No account binding',
      'Its newest backtest closed no trade',
      'No completed backtest on its own market (XAUUSD M5)',
      'Never submitted for approval',
    ]);
    expect(activityHeadline(base)).toBe('Not trading: a paused draft');
  });

  it('separates a rejection from an attempt that reached no verdict', () => {
    const rejected = activityReasons({
      ...base,
      lastGate: {
        outcome: 'Rejected',
        passed: false,
        isVerdict: true,
        failureSummary: 'cpcv: 0.2 < 0.5',
        at: 'x',
      },
    });
    expect(rejected.find((r) => r.title === 'Last promotion attempt was rejected')?.detail).toBe(
      'cpcv: 0.2 < 0.5',
    );
    const timedOut = activityReasons({
      ...base,
      lastGate: {
        outcome: 'TimedOut',
        passed: false,
        isVerdict: false,
        failureSummary: null,
        at: 'x',
      },
    });
    expect(
      timedOut.some((r) => r.title.startsWith('Last promotion attempt reached no verdict')),
    ).toBe(true);
    expect(timedOut.some((r) => r.title === 'Last promotion attempt was rejected')).toBe(false);
  });

  it('points an Active strategy without signals at its rejections or its conditions', () => {
    const active = {
      ...base,
      status: 'Active',
      lifecycleStage: 'Active',
      isScript: false,
      ownMarketBacktestId: 1,
      newestBacktest: null,
    };
    expect(
      activityReasons({ ...active, rejectionTotal: 11, worstRejectionStage: 'Expiry' })[0].title,
    ).toBe('Signals were rejected (11)');
    expect(activityReasons(active)[0].title).toBe('Active, conditions not met yet');
    expect(activityReasons({ ...active, lastSignalAt: '2026-10-28T00:00:00Z' })[0].tone).toBe('ok');
    expect(activityHeadline({ ...active, lastSignalAt: null })).toBe('Active — no signal yet');
  });

  it('says an approved paused strategy paper-trades', () => {
    const r = activityReasons({
      ...base,
      lifecycleStage: 'Approved',
      isScript: false,
      ownMarketBacktestId: 9,
      newestBacktest: null,
    });
    expect(r[0].detail).toContain('paper executions');
    expect(r.some((x) => x.title === 'Approved, waiting to be activated')).toBe(true);
  });
});
