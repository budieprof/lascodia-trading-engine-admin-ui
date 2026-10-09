import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import {
  RECONCILE_POLL_LIMIT_MS,
  ScriptParityPanelComponent,
} from './script-parity-panel.component';
import { ANALYST_PERMISSION } from '../shared/permissions';
import { MINUS } from '../report/report-format';

declareSignalIo(ScriptParityPanelComponent, { inputs: ['strategyId', 'accountNames'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const summaryUrl = (days = 30) => `${BASE}/strategy/41/parity/summary?days=${days}`;
const SESSIONS_URL = `${BASE}/strategy/41/parity/sessions`;
const QUEUE_URL = `${BASE}/strategy/41/parity/reconcile`;
const runUrl = (id: number) => `${BASE}/strategy/41/parity/reconcile/${id}`;
const POLL_MS = 5_000;

const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const refused = (responseCode: string, message: string) => ({
  data: null,
  status: false,
  message,
  responseCode,
});

const dist = (mean: number | null, n = 10, positiveShare: number | null = 0.8) => ({
  n,
  mean,
  median: mean,
  p10: mean,
  p90: mean,
  min: mean,
  max: mean,
  positiveShare,
});

function summary(drift: Record<string, unknown> = {}) {
  return {
    strategyId: 41,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromUtc: '2026-09-09T00:00:00Z',
    toUtc: '2026-10-09T00:00:00Z',
    windowDays: 30,
    pipSize: 0.0001,
    currentScriptRevision: 'abcdef0123456789',
    sessions: 2,
    trades: {
      total: 13,
      closed: 12,
      live: 11,
      paper: 2,
      exitsOnly: 0,
      catchUp: 1,
      signalSent: 11,
      notSent: 0,
      paperBlocked: 0,
      failed: 0,
    },
    live: {
      emulatorTrades: 11,
      tradesSent: 11,
      tradesFilled: 10,
      tradesMissed: 1,
      accountFills: 10,
      closedRoundTrips: 10,
      expectedR: dist(0.8),
      realisedR: dist(0.5),
      rGap: dist(-0.3, 10, 0.1),
      entrySlippagePips: dist(1.2),
      entrySlippagePipsLong: dist(1.4),
      entrySlippagePipsShort: dist(1.0),
      exitSlippagePips: dist(0.6),
      exitSlippagePipsLong: dist(0.5),
      exitSlippagePipsShort: dist(0.7),
      entryLatencyMs: dist(850),
      exitLatencyMs: dist(2_400),
    },
    paper: { trades: 2, closed: 2, expectedR: dist(1.1, 2) },
    drift: {
      status: 'drifting',
      reasons: [
        'The accounts’ realised R trails the emulator’s by 0.30 R per trade on average over 10 closed trades (limit 0.15 R).',
      ],
      minTrades: 10,
      maxRGapPerTrade: 0.15,
      maxSlippagePips: 1,
      alertActive: false,
      alertLastTriggeredAtUtc: null,
      ...drift,
    },
  };
}

function session(id: number, lastReconcileRunId: number | null = null) {
  return {
    id,
    scriptRevision: 'abcdef0123456789',
    isCurrentRevision: true,
    symbol: 'EURUSD',
    timeframe: 'H1',
    warmupFromUtc: '2026-08-01T00:00:00Z',
    liveFromUtc: id === 9 ? '2026-10-01T08:00:00Z' : '2026-09-01T08:00:00Z',
    startedAtUtc: '2026-09-01T07:59:00Z',
    lastStartedAtUtc: '2026-09-01T07:59:00Z',
    restarts: 0,
    stoppedAtUtc: null,
    endedAtUtc: id === 9 ? null : '2026-10-01T07:59:00Z',
    endReason: null,
    trades: 3,
    liveTrades: 3,
    paperTrades: 0,
    lastReconcileRunId,
  };
}

function reconcile(runId: number, status: string, completed = status === 'completed') {
  return {
    backtestRunId: runId,
    sessionId: 9,
    status,
    error: status === 'failed' ? 'No candles' : null,
    queuedAtUtc: '2026-10-08T10:00:00Z',
    completedAtUtc: completed ? '2026-10-08T10:03:00Z' : null,
    session: {
      scriptRevision: 'abcdef0123456789',
      isCurrentRevision: true,
      warmupFromUtc: '2026-08-01T00:00:00Z',
      liveFromUtc: '2026-10-01T08:00:00Z',
      endedAtUtc: null,
      stoppedAtUtc: null,
      restarts: 0,
    },
    fromUtc: '2026-08-01T00:00:00Z',
    toUtc: '2026-10-08T10:00:00Z',
    compareFromUtc: '2026-10-01T08:00:00Z',
    compareToUtc: '2026-10-08T10:00:00Z',
    pipSize: 0.0001,
    matchToleranceBars: 1,
    summary: completed
      ? {
          backtestTrades: 2,
          sessionTrades: 2,
          matched: 1,
          missing: 1,
          extra: 1,
          matchedWithAccounts: 1,
          entrySlippagePips: dist(0.5, 1),
          exitSlippagePips: dist(0.2, 1),
          rDifference: dist(-0.01, 1),
          accountEntrySlippagePips: dist(1.5, 1),
          accountExitSlippagePips: dist(1, 1),
          accountRDifference: dist(-0.05, 1),
        }
      : null,
    pairs: completed
      ? [
          {
            status: 'matched',
            direction: 'long',
            entryId: 'L',
            backtest: {
              entryTimeUtc: '2026-10-02T09:00:00Z',
              entryPrice: 1.1,
              exitTimeUtc: '2026-10-02T15:00:00Z',
              exitPrice: 1.105,
              lots: 1,
              initialStopPrice: 1.095,
              r: 1,
            },
            session: {
              entryTimeUtc: '2026-10-02T09:00:00Z',
              entryPrice: 1.10005,
              exitTimeUtc: '2026-10-02T15:00:00Z',
              exitPrice: 1.10498,
              lots: 1,
              initialStopPrice: 1.095,
              r: 0.99,
              mode: 'live',
              outcome: 'SignalSent',
              tradeKey: 3,
              signalId: 501,
              exitKind: 'TakeProfit',
            },
            accounts: [
              {
                accountId: 27,
                orderId: 900,
                positionId: 77,
                orderStatus: 'Filled',
                lots: 0.5,
                entryPrice: 1.10015,
                entryTimeUtc: '2026-10-02T09:00:02Z',
                exitPrice: 1.1049,
                exitTimeUtc: '2026-10-02T15:00:03Z',
                entrySlippagePips: 1.5,
                exitSlippagePips: 1,
                rDifference: -0.05,
              },
            ],
            entrySlippagePips: 0.5,
            exitSlippagePips: 0.2,
            rDifference: -0.01,
            note: null,
          },
          {
            status: 'missing',
            direction: 'short',
            entryId: 'S',
            backtest: {
              entryTimeUtc: '2026-10-03T11:00:00Z',
              entryPrice: 1.11,
              exitTimeUtc: '2026-10-03T14:00:00Z',
              exitPrice: 1.108,
              lots: 1,
              initialStopPrice: 1.112,
              r: 1,
            },
            session: null,
            accounts: [],
            entrySlippagePips: null,
            exitSlippagePips: null,
            rDifference: null,
            note: 'The session was not running then.',
          },
          {
            status: 'extra',
            direction: 'long',
            entryId: 'L',
            backtest: null,
            session: {
              entryTimeUtc: '2026-10-04T09:00:00Z',
              entryPrice: 1.104,
              exitTimeUtc: null,
              exitPrice: null,
              lots: 1,
              initialStopPrice: null,
              r: null,
              mode: 'live',
            },
            accounts: [],
            entrySlippagePips: null,
            exitSlippagePips: null,
            rDifference: null,
            note: null,
          },
        ]
      : [],
    notes: completed ? ['The backtest warms up from its own start, not the session’s.'] : [],
  };
}

describe('ScriptParityPanelComponent (BT-I3 / PE-I2)', () => {
  let fixture: ComponentFixture<ScriptParityPanelComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let canAnalyse: boolean;
  const asked: string[] = [];

  const text = () => el.textContent!.replace(/\s+/g, ' ');
  const reconcileButton = () =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      /Reconcil|Queueing/.test(b.textContent ?? ''),
    )!;
  const selects = () => [...el.querySelectorAll<HTMLSelectElement>('select')];
  /** The value next to a fact's label (the counts are `dt` / `dd` pairs). */
  const fact = (label: string) => {
    const dt = [...el.querySelectorAll('dt')].find((d) => d.textContent!.trim() === label);
    return dt?.nextElementSibling?.textContent!.replace(/\s+/g, ' ').trim();
  };

  function render(): void {
    fixture = TestBed.createComponent(ScriptParityPanelComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.componentRef.setInput('accountNames', new Map([['27', 'Exness Real 27']]));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  /** Renders and answers the first summary and sessions reads. */
  function load(sessions: unknown[] = [], payload: unknown = summary()): void {
    render();
    http.expectOne(summaryUrl()).flush(ok(payload));
    http.expectOne(SESSIONS_URL).flush(ok(sessions));
    fixture.detectChanges();
  }

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    canAnalyse = true;
    asked.length = 0;
    TestBed.configureTestingModule({
      imports: [ScriptParityPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (p: string) => {
              asked.push(p);
              return canAnalyse;
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture?.destroy();
    vi.useRealTimers();
  });

  it('shows the alarm’s verdict, the counts and the live fills against the emulator', () => {
    load();
    expect(text()).toContain('Live fills drift from the emulator');
    expect(text()).toContain('trails the emulator’s by 0.30 R per trade');
    expect(fact('Emulator trades')).toBe('13 (11 live · 2 paper)');
    expect(fact('Sent to the accounts')).toBe('11');
    expect(fact('Filled by an account')).toBe('10');
    expect(fact('Sent but never filled')).toBe('1');
    expect(fact('Not sent')).toBe('0');
    expect(fact('Opened while catching up')).toBe('1');

    const rows = [...el.querySelectorAll('table.stats tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((c) => c.textContent!.trim()),
    );
    expect(rows[0]).toEqual([
      'Entry slippage',
      '10',
      '1.2 pips worse',
      '1.2 pips worse',
      '1.2 pips worse',
      '80%',
    ]);
    expect(rows.find((r) => r[0] === 'R gap')!.slice(2, 3)).toEqual([`${MINUS}0.30 R`]);
    // A "worse" share is claimed for slippage only.
    expect(rows.find((r) => r[0] === 'R gap')!.at(-1)).toBe('—');
    expect(rows.find((r) => r[0] === 'Exit latency')![2]).toBe('2.4 s');
    expect(text()).toContain('Paper: 2 trades (2 closed), +1.10 R per trade.');
    expect(text()).toContain('No live or paper session has been recorded yet.');
  });

  it('refetches the summary for another window', () => {
    load();
    choose(selects()[0], '90');
    http.expectOne(summaryUrl(90)).flush(ok(summary({ status: 'ok', reasons: [] })));
    fixture.detectChanges();
    expect(text()).toContain('Live fills match the emulator within the limits');
    expect(selects()[0].value).toBe('90');
  });

  it('offers a retry when the summary fails, and keeps the last one on a later failure', () => {
    render();
    http.expectOne(summaryUrl()).flush('boom', { status: 502, statusText: 'Bad Gateway' });
    http.expectOne(SESSIONS_URL).flush(ok([]));
    fixture.detectChanges();
    expect(el.querySelector('.error[role="alert"]')).not.toBeNull();

    el.querySelector<HTMLButtonElement>('.error .btn')!.click();
    http.expectOne(summaryUrl()).flush(ok(summary()));
    fixture.detectChanges();
    expect(text()).toContain('Live fills drift from the emulator');

    el.querySelector<HTMLButtonElement>('.block-head .btn')!.click();
    http.expectOne(summaryUrl()).flush('down', { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(text()).toContain('Live fills drift from the emulator');
    expect(text()).toContain('The last refresh failed');
  });

  it('shows the newest session’s last reconcile: matched, backtest-only and session-only trades', async () => {
    load([session(9, 7001), session(8)]);
    http.expectOne(runUrl(7001)).flush(ok(reconcile(7001, 'completed')));
    fixture.detectChanges();

    expect(selects()[1].value).toBe('9');
    expect(text()).toContain('Backtest #7001 finished 2026-10-08 10:03 UTC.');
    expect(fact('Matched')).toBe('1');
    expect(fact('Backtest only')).toBe('1');
    expect(fact('Session only')).toBe('1');
    expect(fact('Session vs backtest (mean)')).toBe(
      `entries 0.5 pips worse, exits 0.2 pips worse, ${MINUS}0.01 R per trade`,
    );
    expect(fact('Accounts vs backtest (mean)')).toBe(
      `entries 1.5 pips worse, exits 1.0 pip worse, ${MINUS}0.05 R per trade`,
    );
    const rows = [...el.querySelectorAll('table.pairs tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['matched', 'missing', 'extra']);
    expect(rows[0].textContent).toContain('0.5 pips worse');
    expect(rows[0].textContent).toContain(
      `Exness Real 27 (#27): 1.10015 → 1.10490 (in 1.5 pips worse, out 1.0 pip worse, ${MINUS}0.05 R vs the backtest)`,
    );
    expect(rows[1].textContent).toContain('Backtest only');
    expect(rows[1].textContent).toContain('The session was not running then.');
    expect(rows[2].textContent).toContain('1.10400 → open · live');
    expect(el.querySelector('details.fold')!.textContent).toContain('warms up from its own start');

    // A finished reconcile is read once.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    http.expectNone(runUrl(7001));
  });

  it('queues a reconcile of the chosen session and follows it until the backtest finishes', async () => {
    load([session(9), session(8)]);
    expect(text()).not.toContain('Backtest #');
    choose(selects()[1], '8');

    reconcileButton().click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === QUEUE_URL);
    expect(post.request.body).toEqual({ sessionId: 8 });
    post.flush(
      ok({
        backtestRunId: 7002,
        sessionId: 8,
        status: 'queued',
        alreadyQueued: false,
        fromUtc: '2026-07-01T00:00:00Z',
        toUtc: '2026-10-01T07:59:00Z',
        compareFromUtc: '2026-09-01T08:00:00Z',
        deep: false,
        notes: [],
      }),
    );
    http.expectOne(runUrl(7002)).flush(ok(reconcile(7002, 'queued')));
    http.expectOne(SESSIONS_URL).flush(ok([session(9), session(8, 7002)]));
    fixture.detectChanges();

    expect(text()).toContain('Queued backtest #7002, 2026-07-01 00:00 to 2026-10-01 07:59 UTC.');
    expect(text()).toContain('Backtest #7002 is queued.');
    expect(reconcileButton().disabled).toBe(true);
    expect(reconcileButton().textContent).toContain('Reconciling…');
    expect(selects()[1].value).toBe('8');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    http.expectOne(runUrl(7002)).flush(ok(reconcile(7002, 'running')));
    fixture.detectChanges();
    expect(text()).toContain('Backtest #7002 is running.');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    http.expectOne(runUrl(7002)).flush(ok(reconcile(7002, 'completed')));
    fixture.detectChanges();
    expect(text()).toContain('Backtest #7002 finished');
    expect(el.querySelectorAll('table.pairs tbody tr')).toHaveLength(3);
    expect(reconcileButton().disabled).toBe(false);

    // Finished: no further reads.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    http.expectNone(runUrl(7002));
  });

  it('follows a reconcile that is already queued instead of queueing another', () => {
    load([session(9)]);
    reconcileButton().click();
    const post = http.expectOne(QUEUE_URL);
    expect(post.request.body).toEqual({ sessionId: 9 });
    post.flush(
      ok({
        backtestRunId: 7003,
        sessionId: 9,
        status: 'running',
        alreadyQueued: true,
        fromUtc: '2026-08-01T00:00:00Z',
        toUtc: '2026-10-08T10:00:00Z',
        compareFromUtc: '2026-10-01T08:00:00Z',
        deep: true,
        notes: [],
      }),
    );
    http.expectOne(runUrl(7003)).flush(ok(reconcile(7003, 'running')));
    http.expectOne(SESSIONS_URL).flush(ok([session(9, 7003)]));
    fixture.detectChanges();
    expect(text()).toContain(
      "This session's reconcile is already running: following backtest #7003.",
    );
    expect(text()).toContain('Backtest #7003 is running.');
  });

  it('shows the engine’s reason when it refuses to queue, and stops polling a refused run', async () => {
    load([session(9, 7004)]);
    http.expectOne(runUrl(7004)).flush(refused('-14', 'Backtest run 7004 is not a reconcile.'));
    fixture.detectChanges();
    expect(el.querySelector('.error-text')!.textContent).toContain(
      'Backtest run 7004 is not a reconcile.',
    );
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    http.expectNone(runUrl(7004));

    reconcileButton().click();
    http.expectOne(QUEUE_URL).flush(refused('-11', 'The session has no bars to backtest yet.'));
    fixture.detectChanges();
    expect(text()).toContain('The session has no bars to backtest yet.');
    expect(reconcileButton().disabled).toBe(false);
  });

  it('needs the analyst permission to queue a reconcile', () => {
    canAnalyse = false;
    load([session(9)]);
    expect(asked).toContain(ANALYST_PERMISSION);
    expect(reconcileButton().disabled).toBe(true);
    expect(text()).toContain('queueing one needs the analyst permission');
    reconcileButton().click();
    http.expectNone(QUEUE_URL);
  });

  it('stops polling after the limit, and Refresh looks again', async () => {
    load([session(9, 7005)]);
    http.expectOne(runUrl(7005)).flush(ok(reconcile(7005, 'queued')));
    fixture.detectChanges();

    vi.setSystemTime(Date.now() + RECONCILE_POLL_LIMIT_MS + 1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    http.expectNone(runUrl(7005));
    fixture.detectChanges();
    expect(text()).toContain('Still not finished after 30 minutes');
    expect(reconcileButton().disabled).toBe(false);

    el.querySelector<HTMLButtonElement>('.block-head .btn')!.click();
    http.expectOne(summaryUrl()).flush(ok(summary()));
    http.expectOne(runUrl(7005)).flush(ok(reconcile(7005, 'completed')));
    fixture.detectChanges();
    expect(text()).not.toContain('Still not finished');
    expect(text()).toContain('Backtest #7005 finished');
  });
});
