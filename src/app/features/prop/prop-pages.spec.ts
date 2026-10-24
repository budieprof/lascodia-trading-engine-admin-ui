import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { PropGateComponent } from './components/prop-gate.component';
import { PropConsolePageComponent } from './pages/prop-console-page.component';
import { PropEnrollmentsPageComponent } from './pages/prop-enrollments-page.component';
import { PropPayoutsPageComponent } from './pages/prop-payouts-page.component';
import { PropApiService } from './prop-api.service';
import type { PropBreach, PropEnrollment, PropPayout } from './prop.types';

ensureTestBed();

const breach = (id: number): PropBreach => ({
  id,
  enrollmentId: 7,
  tradingAccountId: 101,
  accountLabel: 'Challenge A',
  traderId: 1,
  traderName: 'Ada',
  rule: 'MaxDailyLoss',
  severity: 'Breach',
  value: 600,
  limit: 500,
  occurredAtUtc: '2026-10-05T05:00:00Z',
  detail: 'x',
});

const enrollment = (over: Partial<PropEnrollment> = {}): PropEnrollment => ({
  id: 7,
  tradingAccountId: 101,
  accountLabel: 'Challenge A',
  traderId: 1,
  traderName: 'Ada',
  programId: 3,
  programName: '10k',
  programVersion: 1,
  phaseIndex: 2,
  phaseName: 'Funded',
  phaseKind: 'Funded',
  state: 'Funded',
  startedAtUtc: '2026-09-01T00:00:00Z',
  endedAtUtc: null,
  initialBalance: 10000,
  lastBalance: 10500,
  lastEquity: 10500,
  profitPct: 5,
  tradingDays: 4,
  failedRule: null,
  failedValue: null,
  failedLimit: null,
  failedAtUtc: null,
  failedDetail: null,
  passedAtUtc: null,
  haltRequired: false,
  haltAppliedAtUtc: null,
  haltLastError: null,
  lastEvaluatedAtUtc: null,
  lastDataAtUtc: null,
  previousEnrollmentId: null,
  canAdvance: false,
  note: null,
  ...over,
});

let api: Record<string, ReturnType<typeof vi.fn>>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

function setup(available = true) {
  api = {
    status: vi.fn(() =>
      of({
        available,
        plan: available ? null : 'Trial',
        message: available ? null : 'Your plan (Trial) does not include the prop-firm module.',
      }),
    ),
    breaches: vi.fn(() => of([breach(2), breach(1)])),
    leaderboard: vi.fn(() => of([])),
    programs: vi.fn(() => of([])),
    traders: vi.fn(() => of([])),
    accounts: vi.fn(() => of([{ id: 101, label: 'Challenge A', balance: 10000 }])),
    enrollments: vi.fn(() => of([enrollment()])),
    enrol: vi.fn(() => of(enrollment({ state: 'Active', phaseKind: 'Evaluation' }))),
    withdraw: vi.fn(() => of(enrollment({ state: 'Withdrawn' }))),
    payouts: vi.fn(() => of([])),
    preparePayout: vi.fn((body: { preview: boolean }) =>
      of({ id: body.preview ? 0 : 9, netPayout: 400, grossProfit: 500 } as PropPayout),
    ),
    approvePayout: vi.fn(() => of({} as PropPayout)),
    rejectPayout: vi.fn(() => of({} as PropPayout)),
  };
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: PropApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap({}),
            paramMap: convertToParamMap({ id: '7' }),
          },
        },
      },
    ],
  });
}

afterEach(() => TestBed.resetTestingModule());

describe('the prop module gate', () => {
  it('shows the upgrade notice and never says ready when the plan lacks the module', async () => {
    setup(false);
    const gate = TestBed.runInInjectionContext(() => new PropGateComponent());
    const ready = vi.fn();
    gate.ready.subscribe(ready);
    await Promise.resolve();
    expect(gate.state()).toBe('unavailable');
    expect(gate.status()?.message).toContain('Trial');
    expect(ready).not.toHaveBeenCalled();
  });

  it('says ready once when it is available', async () => {
    setup(true);
    const gate = TestBed.runInInjectionContext(() => new PropGateComponent());
    const ready = vi.fn();
    gate.ready.subscribe(ready);
    await Promise.resolve();
    expect(gate.state()).toBe('available');
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('a failed check is an error, not an upgrade notice', () => {
    setup(true);
    api['status'].mockReturnValue(throwError(() => new Error('down')));
    const gate = TestBed.runInInjectionContext(() => new PropGateComponent());
    expect(gate.state()).toBe('error');
  });
});

describe('PropConsolePageComponent', () => {
  beforeEach(() => setup());

  it('loads the feed and then asks only for newer events', () => {
    const page = TestBed.runInInjectionContext(() => new PropConsolePageComponent());
    page.start();
    expect(page.feed().map((b) => b.id)).toEqual([2, 1]);
    expect(api['breaches']).toHaveBeenLastCalledWith(null);
    api['breaches'].mockReturnValue(of([breach(3)]));
    page.pollFeed();
    expect(api['breaches']).toHaveBeenLastCalledWith(2);
    expect(page.feed().map((b) => b.id)).toEqual([3, 2, 1]);
    expect(api['leaderboard']).toHaveBeenCalledTimes(2); // a new breach refreshes the board
  });
});

describe('PropEnrollmentsPageComponent', () => {
  beforeEach(() => setup());

  it('needs the account, trader and program before enrolling', () => {
    const page = TestBed.runInInjectionContext(() => new PropEnrollmentsPageComponent());
    page.openEnrol();
    page.confirm();
    expect(api['enrol']).not.toHaveBeenCalled();
    expect(page.error()).toContain('Choose');

    page.dialog.set({
      kind: 'enrol',
      accountId: 101,
      traderId: 1,
      programId: 3,
      phaseIndex: 0,
      initial: '-5',
      note: '',
    });
    page.confirm();
    expect(page.error()).toContain('positive');

    page.dialog.set({
      kind: 'enrol',
      accountId: 101,
      traderId: 1,
      programId: 3,
      phaseIndex: 0,
      initial: '',
      note: ' ',
    });
    page.confirm();
    expect(api['enrol']).toHaveBeenCalledWith({
      tradingAccountId: 101,
      traderId: 1,
      programId: 3,
      phaseIndex: 0,
      initialBalance: null,
      note: null,
    });
    expect(page.dialog()).toBeNull();
  });
});

describe('PropPayoutsPageComponent', () => {
  beforeEach(() => setup());

  it('previews before preparing and sends UTC day bounds and the deductions', () => {
    const page = TestBed.runInInjectionContext(() => new PropPayoutsPageComponent());
    page.openPrepare();
    page.draft.set({
      enrollmentId: 7,
      from: '2026-09-01',
      to: '2026-10-01',
      deductions: [{ label: 'Fee', amount: '50' }],
      note: '',
    });
    page.prepare(true);
    expect(api['preparePayout']).toHaveBeenCalledWith({
      enrollmentId: 7,
      periodStartUtc: '2026-09-01T00:00:00.000Z',
      periodEndUtc: '2026-10-01T00:00:00.000Z',
      deductions: [{ label: 'Fee', amount: 50 }],
      note: null,
      preview: true,
    });
    expect(page.preview()?.netPayout).toBe(400);
    expect(page.draft()).not.toBeNull();

    page.prepare(false);
    expect(page.draft()).toBeNull();
    expect(notify.success).toHaveBeenCalled();
  });

  it('refuses a deduction without a label', () => {
    const page = TestBed.runInInjectionContext(() => new PropPayoutsPageComponent());
    page.openPrepare();
    page.draft.set({
      enrollmentId: 7,
      from: '2026-09-01',
      to: '2026-10-01',
      deductions: [{ label: '', amount: '5' }],
      note: '',
    });
    page.prepare(true);
    expect(api['preparePayout']).not.toHaveBeenCalled();
    expect(page.error()).toContain('label');
  });

  it('a rejection carries its reason', () => {
    const page = TestBed.runInInjectionContext(() => new PropPayoutsPageComponent());
    page.deciding.set({ payout: { id: 9 } as PropPayout, approve: false, note: 'Fees missing' });
    page.decide();
    expect(api['rejectPayout']).toHaveBeenCalledWith(9, 'Fees missing');
  });
});
