import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { StrategyDetailPageComponent } from './strategy-detail-page.component';
import { RealtimeService } from '@core/realtime/realtime.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyDto } from '@core/api/api.types';

// The detail page's lifecycle actions: Activate (whose refusal for a Draft points at "Submit for
// approval"), Pause, the approval dialog's wiring and the way to the Execution tab. Drives the
// component's handlers; the dialog itself is covered by its own spec.

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const DRAFT = {
  id: 41,
  name: 'Pine EMA',
  status: 'Paused',
  lifecycleStage: 'Draft',
  strategyType: 'RuleBased',
} as StrategyDto;

describe('StrategyDetailPageComponent (approval and activation)', () => {
  let cmp: StrategyDetailPageComponent;
  let http: HttpTestingController;
  let notify: Record<string, ReturnType<typeof vi.fn>>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    TestBed.configureTestingModule({
      imports: [StrategyDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '41' } } } },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
        { provide: NotificationService, useValue: notify },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    cmp = TestBed.createComponent(StrategyDetailPageComponent).componentInstance;
    (cmp as any).strategyId = 41;
    cmp.strategy.set(DRAFT);
    reload = vi.fn();
    (cmp as any).loadStrategy = reload;
  });

  afterEach(() => http.verify());

  it('points a refused Draft activation at "Submit for approval" — toast and inline banner', () => {
    cmp.onActivate();
    http.expectOne(`${BASE}/strategy/41/activate`).flush({
      status: false,
      data: null,
      message:
        'Strategy must reach Approved lifecycle stage before activation. Current stage: Draft',
      responseCode: '-11',
    });
    expect(notify['success']).not.toHaveBeenCalled();
    expect(notify['error']).toHaveBeenCalledWith(expect.stringContaining('Submit for approval'));
    expect(cmp.activationHint()).toContain('Submit for approval');
    // The page keeps its strategy (the engine's refusal is not a strategy).
    expect(cmp.strategy()).toBe(DRAFT);
    expect(cmp.actionLoading()).toBe(false);
  });

  it('re-reads the strategy after an activation — the engine answers "Activated", not the strategy', () => {
    cmp.strategy.set({ ...DRAFT, lifecycleStage: 'Approved' });
    cmp.onActivate();
    http
      .expectOne(`${BASE}/strategy/41/activate`)
      .flush({ status: true, data: 'Activated', message: 'Successful', responseCode: '00' });
    expect(notify['success']).toHaveBeenCalledWith('Strategy activated');
    expect(reload).toHaveBeenCalled();
    expect(typeof cmp.strategy()).toBe('object');
    expect(cmp.activationHint()).toBeNull();
  });

  it('re-reads the strategy after a pause and reports a refused one', () => {
    cmp.onPause();
    http
      .expectOne(`${BASE}/strategy/41/pause`)
      .flush({ status: true, data: 'Paused', message: 'Successful', responseCode: '00' });
    expect(reload).toHaveBeenCalledTimes(1);
    cmp.onPause();
    http
      .expectOne(`${BASE}/strategy/41/pause`)
      .flush({ status: false, data: null, message: 'Strategy not found', responseCode: '-14' });
    expect(notify['error']).toHaveBeenCalledWith('Strategy not found');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('opens the approval dialog for the Draft and re-reads it when a verdict lands', () => {
    cmp.activationHint.set('x');
    cmp.openApproval();
    expect(cmp.approvalTarget()).toBe(DRAFT);
    expect(cmp.activationHint()).toBeNull();
    cmp.onApprovalChanged(99); // another strategy's evaluation (the page moved on)
    expect(reload).not.toHaveBeenCalled();
    cmp.onApprovalChanged(41);
    expect(reload).toHaveBeenCalledTimes(1);
    cmp.openPromotionHistory();
    expect(cmp.approvalTarget()).toBeNull();
    expect(cmp.activeTab()).toBe('promotion');
  });

  it('offers the paper-only stage to a Paused Draft script — not to a rules strategy', () => {
    expect(cmp.canStartPaperTrading()).toBe(false); // DRAFT is a rules strategy
    cmp.strategy.set({ ...DRAFT, authoringMode: 'Script' } as StrategyDto);
    expect(cmp.isScript()).toBe(true);
    expect(cmp.canStartPaperTrading()).toBe(true);
    expect(cmp.canSubmitForApproval()).toBe(true);
    expect(cmp.isPaperOnlyStage()).toBe(false);

    cmp.strategy.set({
      ...DRAFT,
      authoringMode: 'Script',
      lifecycleStage: 'PaperTrading',
    } as StrategyDto);
    expect(cmp.canStartPaperTrading()).toBe(false);
    expect(cmp.isPaperOnlyStage()).toBe(true);
    // Submitted for approval from its paper stage.
    expect(cmp.canSubmitForApproval()).toBe(true);

    cmp.strategy.set({ ...DRAFT, authoringMode: 'Script', status: 'Active' } as StrategyDto);
    expect(cmp.canStartPaperTrading()).toBe(false);
    cmp.strategy.set({
      ...DRAFT,
      authoringMode: 'Script',
      lifecycleStage: 'Approved',
    } as StrategyDto);
    expect(cmp.canStartPaperTrading()).toBe(false);
    expect(cmp.canSubmitForApproval()).toBe(false);
  });

  it('starts and stops paper trading, re-reading the strategy, and shows a refusal', () => {
    cmp.strategy.set({ ...DRAFT, authoringMode: 'Script' } as StrategyDto);
    cmp.onStartPaperTrading();
    http
      .expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/strategy/41/start-paper-trading`)
      .flush({ status: true, data: 'PaperTrading', message: 'Paper trading.', responseCode: '00' });
    expect(notify['success']).toHaveBeenCalledWith(expect.stringContaining('Paper trading'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(cmp.actionLoading()).toBe(false);

    cmp.onStopPaperTrading();
    http
      .expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/strategy/41/stop-paper-trading`)
      .flush({
        status: true,
        data: 'Draft',
        message: 'Stopped paper trading.',
        responseCode: '00',
      });
    expect(reload).toHaveBeenCalledTimes(2);

    cmp.onStartPaperTrading();
    http.expectOne(`${BASE}/strategy/41/start-paper-trading`).flush({
      status: false,
      data: null,
      message: 'Strategy 41 still holds 1 open position it opened.',
      responseCode: '-11',
    });
    expect(notify['error']).toHaveBeenCalledWith(
      'Strategy 41 still holds 1 open position it opened.',
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('points a paper-trading script whose activation is refused at "Submit for approval"', () => {
    cmp.strategy.set({
      ...DRAFT,
      authoringMode: 'Script',
      lifecycleStage: 'PaperTrading',
    } as StrategyDto);
    cmp.onActivate();
    http.expectOne(`${BASE}/strategy/41/activate`).flush({
      status: false,
      data: null,
      message: 'Strategy 41 is paper trading (the paper-only stage) and cannot be activated yet.',
      responseCode: '-11',
    });
    expect(cmp.activationHint()).toContain('Submit for approval');
  });

  it('keeps the page and says why when the engine refuses a delete (D131)', () => {
    const navigate = vi.spyOn((cmp as any).router, 'navigate');
    cmp.showDeleteConfirm.set(true);
    cmp.onDelete();
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/strategy/41`)
      .flush({
        status: false,
        data: null,
        message: 'Strategy 41 is a script strategy that still holds 1 open position.',
        responseCode: '-11',
      });
    expect(notify['success']).not.toHaveBeenCalled();
    expect(notify['error']).toHaveBeenCalledWith(
      'Strategy 41 is a script strategy that still holds 1 open position.',
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(cmp.deleteLoading()).toBe(false);

    cmp.onDelete();
    http
      .expectOne(`${BASE}/strategy/41`)
      .flush({ status: true, data: null, message: 'Successful', responseCode: '00' });
    expect(notify['success']).toHaveBeenCalledWith('Strategy deleted');
    expect(navigate).toHaveBeenCalledWith(['/strategies']);
  });

  it('takes the operator to the Execution tab from the editor or the script card', () => {
    cmp.openEdit();
    expect(cmp.showEditForm()).toBe(true);
    cmp.openExecutionTab();
    expect(cmp.showEditForm()).toBe(false);
    expect(cmp.activeTab()).toBe('execution');
  });
});
