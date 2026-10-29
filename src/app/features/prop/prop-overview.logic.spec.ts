import { describe, expect, it } from 'vitest';

import {
  accountLabel,
  fitTally,
  fitVerdict,
  limitUse,
  overviewFromLists,
  runningCount,
  setupKind,
  setupRequirements,
  useTone,
  type AccountRow,
} from './prop-overview.logic';
import { defaultRules } from './prop.logic';
import type {
  PropEnrollment,
  PropOverview,
  PropProgram,
  PropReplay,
  PropTrader,
} from './prop.types';

const NOW = new Date('2026-10-28T12:00:00Z');

function account(id: number, patch: Partial<AccountRow> = {}): AccountRow {
  return {
    id,
    accountId: String(1000 + id),
    accountName: `Acc ${id}`,
    brokerServer: 'Demo',
    accountType: 'Demo',
    currency: 'USD',
    balance: 10_000,
    equity: 10_000,
    isActive: true,
    isPaper: false,
    lastSyncedAt: '2026-10-28T11:59:30Z',
    ...patch,
  };
}

function empty(patch: Partial<PropOverview> = {}): PropOverview {
  return {
    ...overviewFromLists({
      programs: [],
      traders: [],
      enrollments: [],
      payouts: [],
      accounts: [account(1), account(2, { lastSyncedAt: '2026-10-28T10:00:00Z' })],
      settings: {
        'Prop:Evaluation:Enabled': 'true',
        'Prop:Enforcement:Enabled': 'true',
        'Prop:Evaluation:IntervalSeconds': '15',
        'Prop:Evaluation:StaleAccountSeconds': '300',
        'Prop:Payouts:RequireDistinctApprover': 'true',
      },
      now: NOW,
    }),
    ...patch,
  };
}

function replay(patch: Partial<PropReplay>): PropReplay {
  return {
    outcome: 'Running',
    measuredFromUtc: null,
    measuredToUtc: null,
    points: 0,
    initialBalance: 0,
    endEquity: 0,
    endBalance: 0,
    decidedAtUtc: null,
    failedRule: null,
    failedValue: null,
    failedLimit: null,
    failedDetail: null,
    profitTargetReachedAtUtc: null,
    timeLimitEndsAtUtc: null,
    profitPct: 0,
    profitTargetPct: 10,
    worstDayLossPct: 0,
    worstDay: null,
    dailyLossLimitPct: 5,
    maxDrawdownFromInitialPct: 0,
    maxDrawdownFromPeakPct: 0,
    drawdownLimitPct: 10,
    drawdownMode: 'Static',
    tradingDays: 0,
    minTradingDays: 4,
    warnings: 0,
    days: [],
    curve: [],
    notes: [],
    ...patch,
  };
}

describe('overviewFromLists', () => {
  it('counts what is set up from real rows and judges freshness by the stale setting', () => {
    const o = empty();
    expect(o.source).toBe('lists');
    expect(o.activePrograms).toBe(0);
    expect(o.evaluationEnabled).toBe(true);
    expect(o.staleAccountSeconds).toBe(300);
    expect(o.accounts.map((a) => a.fresh)).toEqual([true, false]);
    expect(o.accounts[0].label).toBe('Acc 1 · 1001 @ Demo');
    expect(o.settings.map((s) => s.key)).toContain('Prop:Enforcement:Enabled');
    expect(o.breachesTotal).toBeNull();
    expect(o.equityReportsLastHour).toBeNull();
  });

  it('leaves out paper and inactive accounts and links running enrolments', () => {
    const programs = [{ id: 7, status: 'Active' } as PropProgram];
    const traders = [{ id: 3, isActive: true, adminUserId: 9 } as PropTrader];
    const enrollments = [
      {
        id: 11,
        tradingAccountId: 1,
        state: 'Active',
        programName: 'Ten K',
        lastEvaluatedAtUtc: '2026-10-28T11:59:00Z',
      },
      {
        id: 12,
        tradingAccountId: 2,
        state: 'Failed',
        programName: 'Ten K',
        lastEvaluatedAtUtc: null,
      },
    ] as PropEnrollment[];
    const o = overviewFromLists({
      programs,
      traders,
      enrollments,
      payouts: [],
      accounts: [
        account(1),
        account(2),
        account(3, { isPaper: true }),
        account(4, { isActive: false }),
      ],
      settings: {},
      now: NOW,
    });
    expect(o.accounts.map((a) => a.id)).toEqual([1, 2]);
    expect(o.accounts[0].runningEnrollmentId).toBe(11);
    expect(o.accounts[0].runningProgram).toBe('Ten K');
    expect(o.accounts[1].runningEnrollmentId).toBeNull();
    expect(runningCount(o)).toBe(1);
    expect(o.enrollmentsByState['Failed']).toBe(1);
    expect(o.linkedTraders).toBe(1);
    expect(o.lastEvaluatedAtUtc).toBe('2026-10-28T11:59:00Z');
    expect(o.evaluationEnabled).toBeNull();
  });
});

describe('setupRequirements / setupKind', () => {
  it('nothing created yet: waiting, with the switches on and the creation steps missing', () => {
    const o = empty();
    const reqs = setupRequirements(o);
    const byLabel = Object.fromEntries(reqs.map((r) => [r.label, r]));
    expect(byLabel['Rule evaluation switched on'].ok).toBe(true);
    expect(byLabel['Breaches halt the account'].ok).toBe(true);
    expect(byLabel['A challenge program defined'].ok).toBe(false);
    expect(byLabel['A trader registered'].ok).toBe(false);
    expect(byLabel['An account enrolled'].ok).toBe(false);
    expect(byLabel['An account enrolled'].detail).toContain(
      '2 active trading accounts could be enrolled',
    );
    expect(byLabel['Accounts report fresh balance and equity'].ok).toBe(false);
    expect(byLabel['Accounts report fresh balance and equity'].detail).toContain('1 of 2');
    // The lists cannot tell the EA equity report count: that step is left out.
    expect(reqs.some((r) => r.label.startsWith('Intraday'))).toBe(false);
    expect(setupKind(o)).toBe('waiting');
  });

  it('shows the EA equity-report step from the engine figures and reads the payout policy', () => {
    const o = empty({ source: 'engine', equityReportsLastHour: 0, payoutApprovalPolicy: false });
    const reqs = setupRequirements(o);
    const intraday = reqs.find((r) => r.label.startsWith('Intraday'))!;
    expect(intraday.ok).toBe(false);
    expect(intraday.detail).toContain('dip that recovers');
    expect(reqs.find((r) => r.label.startsWith('Payouts'))!.detail).toContain(
      'no four-eyes policy',
    );
  });

  it('partial, on and off', () => {
    expect(setupKind(empty({ activePrograms: 1 }))).toBe('partial');
    expect(
      setupKind(empty({ activePrograms: 1, traders: 1, enrollmentsByState: { Active: 1 } })),
    ).toBe('on');
    expect(setupKind(empty({ evaluationEnabled: false }))).toBe('off');
  });
});

describe('account fit words', () => {
  it('verdicts', () => {
    expect(fitVerdict(replay({ outcome: 'Passed', decidedAtUtc: '2026-10-20T03:00:00Z' }))).toEqual(
      {
        label: 'Would have passed on 2026-10-20',
        tone: 'ok',
      },
    );
    expect(
      fitVerdict(replay({ outcome: 'Failed', decidedAtUtc: '2026-10-21T03:00:00Z' })).tone,
    ).toBe('bad');
    expect(fitVerdict(replay({ outcome: 'Running' })).label).toBe('No decision yet');
    expect(fitVerdict(replay({ outcome: 'NoData' })).tone).toBe('');
  });

  it('limit use and tone', () => {
    expect(limitUse(2.5, 5)).toBe(50);
    expect(limitUse(1, null)).toBeNull();
    expect(useTone(50)).toBe('ok');
    expect(useTone(80)).toBe('warn');
    expect(useTone(100)).toBe('bad');
    expect(useTone(null)).toBe('');
  });

  it('tally', () => {
    const t = fitTally([
      { replay: replay({ outcome: 'Passed' }) },
      { replay: replay({ outcome: 'Failed' }) },
      { replay: replay({ outcome: 'Failed' }) },
      { replay: replay({ outcome: 'NoData' }) },
    ]);
    expect(t).toEqual({ Passed: 1, Failed: 2, Running: 0, NoData: 1 });
  });

  it('account label', () => {
    expect(accountLabel({ accountName: '', accountId: '42', brokerServer: 'X' })).toBe('42 @ X');
  });

  it('the editor default matches the engine preset the fit measures against', () => {
    // Engine PropRulePresets.FxTwoStep mirrors this; keep the two identical.
    const r = defaultRules();
    expect(r.phases.map((p) => p.profitTargetPct)).toEqual([10, 5, null]);
    expect(r.phases[0].maxDailyLossPct).toBe(5);
    expect(r.phases[0].maxOverallDrawdownPct).toBe(10);
    expect(r.phases[0].minTradingDays).toBe(4);
    expect(r.phases[0].timeLimitDays).toBe(30);
  });
});
