import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';

import { StrategyDetailPageComponent } from './strategy-detail-page.component';
import { RealtimeService } from '@core/realtime/realtime.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { EMPTY, of } from 'rxjs';
import { StrategiesService } from '@core/services/strategies.service';

describe('StrategyDetailPageComponent (update refusals, route changes)', () => {
  let cmp: any;
  let svc: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    svc = {
      update: vi.fn(),
      getById: vi
        .fn()
        .mockImplementation((id: number) => of({ status: true, data: { id, name: `S${id}` } })),
    };
    TestBed.configureTestingModule({
      imports: [StrategyDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '1' } } } },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
        { provide: StrategiesService, useValue: svc },
      ],
    });
    cmp = TestBed.createComponent(StrategyDetailPageComponent).componentInstance;
    cmp.strategyId = 1;
  });

  it('keeps the edit form open with the reason when the engine refuses an update', () => {
    svc['update'].mockReturnValue(
      of({ status: false, message: 'Symbol cannot be changed', responseCode: '-11', data: false }),
    );
    cmp.showEditForm.set(true);
    cmp.onUpdate({ name: 'x' });
    expect(svc['update']).toHaveBeenCalledWith(1, { name: 'x' }, { silent: true });
    expect(cmp.showEditForm()).toBe(true);
    expect(cmp.updateError()).toBe('Symbol cannot be changed');
    expect(cmp.updateSaving()).toBe(false);
  });

  it('closes and re-reads the strategy after a successful update', () => {
    svc['update'].mockReturnValue(of({ status: true, data: true }));
    cmp.showEditForm.set(true);
    cmp.onUpdate({ name: 'x' });
    expect(cmp.showEditForm()).toBe(false);
    expect(svc['getById']).toHaveBeenCalledWith(1);
    expect(cmp.strategy()).toEqual({ id: 1, name: 'S1' });
  });

  it('switches to another strategy when the route id changes', () => {
    (cmp as any).loadLatestSnapshot = () => undefined;
    (cmp as any).loadWeekAgoSnapshot = () => undefined;
    (cmp as any).loadConfigRollups = () => undefined;
    cmp.showStrategy(1);
    cmp.showEditForm.set(true);
    cmp.cloneTarget.set({ id: 1 });
    cmp.showStrategy(9);
    expect(cmp.strategyId).toBe(9);
    expect(svc['getById']).toHaveBeenLastCalledWith(9);
    expect(cmp.strategy()).toEqual({ id: 9, name: 'S9' });
    expect(cmp.showEditForm()).toBe(false);
    expect(cmp.cloneTarget()).toBeNull();
  });
});
