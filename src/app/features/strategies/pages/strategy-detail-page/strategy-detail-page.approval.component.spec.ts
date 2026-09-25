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

  it('takes the operator to the Execution tab from the editor or the script card', () => {
    cmp.openEdit();
    expect(cmp.showEditForm()).toBe(true);
    cmp.openExecutionTab();
    expect(cmp.showEditForm()).toBe(false);
    expect(cmp.activeTab()).toBe('execution');
  });
});
