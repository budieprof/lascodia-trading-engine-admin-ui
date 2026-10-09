import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { InputOverridesEditorComponent } from '../../shared/input-overrides-editor.component';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import { PortfolioBacktestFormComponent } from './portfolio-backtest-form.component';
import { PORTFOLIO_POLL_MS, PortfolioBacktestsPageComponent } from './portfolio-backtests-page.component';

declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });
declareSignalIo(PortfolioBacktestFormComponent, { outputs: ['queued'] });
declareSignalIo(InputOverridesEditorComponent, {
  inputs: ['inputs', 'baseline', 'disabled'],
  outputs: ['overridesChange', 'validityChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function summary(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `2 members: EURUSD H1, GBPUSD H1`,
    status: 'Completed',
    fromDate: '2026-01-01T00:00:00Z',
    toDate: '2026-06-01T00:00:00Z',
    accountCurrency: 'USD',
    initialBalance: 20_000,
    leverage: 30,
    memberCount: 2,
    stage: null,
    errorMessage: null,
    failedMemberIndex: null,
    queuedBy: 'analyst',
    queuedAt: '2026-10-09T08:00:00Z',
    executionStartedAt: '2026-10-09T08:00:05Z',
    completedAt: '2026-10-09T08:01:00Z',
    cancelRequested: false,
    finalBalance: 19_721.68,
    netProfit: -278.32,
    totalReturnPct: -1.39,
    maxDrawdownPct: 2.17,
    totalTrades: 121,
    refusedEntries: 73,
    costModelKey: 'k',
    ...over,
  };
}

describe('PortfolioBacktestsPageComponent (BT-I12)', () => {
  let fixture: ComponentFixture<PortfolioBacktestsPageComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let analyst = true;
  const confirm = vi.fn(async () => true);

  function create(): void {
    TestBed.configureTestingModule({
      imports: [PortfolioBacktestsPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: AuthService, useValue: { hasPermission: () => analyst } },
        { provide: ScriptDialogService, useValue: { confirm } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PortfolioBacktestsPageComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const list = () => http.expectOne(`${BASE}/portfolio-backtest?limit=50`);
  /** The form's pickers (strategies, symbols, accounts, profiles): answered empty. */
  const answerPickers = () => {
    for (const r of http.match((req) => !req.url.includes('/portfolio-backtest'))) r.flush(ok({ data: [], pager: {} }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    analyst = true;
    confirm.mockClear();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('lists the runs with their figures and re-reads while one is going', async () => {
    create();
    list().flush(ok([summary(2, { status: 'Running', stage: 'Bar 1,200 of 8,000', netProfit: null }), summary(1)]));
    await settle();
    fixture.detectChanges();
    const rows = el.querySelectorAll('tr[data-run]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Bar 1,200 of 8,000');
    expect(rows[1].textContent).toContain('−278.32 USD');
    expect(rows[1].textContent).toContain('73');
    expect(el.textContent).toContain('Updating while a run is going');

    vi.advanceTimersByTime(PORTFOLIO_POLL_MS);
    list().flush(ok([summary(2), summary(1)]));
    await settle();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Updating while a run is going');
  });

  it('queues a run with the form and shows the engine’s refusal in its own words', async () => {
    create();
    list().flush(ok([]));
    await settle();
    fixture.detectChanges();
    (el.querySelector('[data-testid="pf-new"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    answerPickers();
    await settle();

    const form = fixture.debugElement.query(By.directive(PortfolioBacktestFormComponent))
      .componentInstance as PortfolioBacktestFormComponent;
    form.set({ fromDate: '2026-01-01', toDate: '2026-06-01', leverage: 30, legsOverride: 1 });
    const [a, b] = form.draft().members;
    form.patch(a.uid, { strategyId: 7 });
    form.setKind(b.uid, 'source');
    form.patch(b.uid, { pineSource: 'strategy("Mine")', symbol: 'gbpusd' });
    fixture.detectChanges();

    const queue = el.querySelector('[data-testid="pf-queue"]') as HTMLButtonElement;
    queue.click();
    await settle();
    let req = http.expectOne(`${BASE}/portfolio-backtest`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      fromDate: '2026-01-01T00:00:00Z',
      toDate: '2026-06-01T00:00:00Z',
      leverage: 30,
      maxSameDirectionCurrencyLegs: 1,
      members: [{ strategyId: 7 }, { pineSource: 'strategy("Mine")', symbol: 'GBPUSD', timeframe: 'H1' }],
    });
    req.flush({
      data: 0,
      status: false,
      message: 'Member 2 (Mine): Script does not compile.',
      responseCode: '-11',
    });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-engine-error"]')?.textContent).toContain(
      'Member 2 (Mine): Script does not compile.',
    );

    queue.click();
    await settle();
    req = http.expectOne(`${BASE}/portfolio-backtest`);
    req.flush(ok(42));
    await settle();
    list().flush(ok([summary(42, { status: 'Queued', completedAt: null })]));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-queued"]')?.textContent).toContain('#42');
    expect(el.querySelector('app-portfolio-backtest-form')).toBeNull();
    vi.advanceTimersByTime(PORTFOLIO_POLL_MS);
    list().flush(ok([summary(42)]));
    await settle();
  });

  it('does not send a form with problems and says what is missing', async () => {
    create();
    list().flush(ok([]));
    await settle();
    fixture.detectChanges();
    (el.querySelector('[data-testid="pf-new"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    answerPickers();
    await settle();
    (el.querySelector('[data-testid="pf-queue"]') as HTMLButtonElement).click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-problems"]')?.textContent).toContain(
      'Member 1: choose a script strategy.',
    );
    http.expectNone(`${BASE}/portfolio-backtest`);
  });

  it('holds back the form and the actions without the analyst permission', async () => {
    analyst = false;
    create();
    list().flush(ok([summary(1)]));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-new"]')).toBeNull();
    expect(el.querySelector('[data-testid="pf-delete-1"]')).toBeNull();
  });

  it('cancels a running run and deletes a finished one after asking', async () => {
    create();
    list().flush(ok([summary(2, { status: 'Running' }), summary(1)]));
    await settle();
    fixture.detectChanges();
    (el.querySelector('[data-testid="pf-cancel-2"]') as HTMLButtonElement).click();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    const cancel = http.expectOne(`${BASE}/portfolio-backtest/2/cancel`);
    expect(cancel.request.method).toBe('POST');
    cancel.flush(ok(true));
    await settle();
    list().flush(ok([summary(2, { status: 'Cancelled' }), summary(1)]));
    await settle();
    fixture.detectChanges();

    (el.querySelector('[data-testid="pf-delete-1"]') as HTMLButtonElement).click();
    await settle();
    const del = http.expectOne(`${BASE}/portfolio-backtest/1`);
    expect(del.request.method).toBe('DELETE');
    del.flush({ data: false, status: false, message: 'Cancel the portfolio backtest before deleting it.', responseCode: '-11' });
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Cancel the portfolio backtest before deleting it.');
  });
});
