import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { StrategiesPageComponent } from './strategies-page.component';
import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { of } from 'rxjs';
import type { StrategyDto } from '@core/api/api.types';

// Bulk-action handlers exist on the component class and are independent of
// the table render — they take rows + a clear callback. Driving them
// directly avoids the cost of mounting AG Grid and the realtime subscription.

describe('StrategiesPageComponent (bulk handlers)', () => {
  let cmp: StrategiesPageComponent;
  let strategiesService: { bulkUpdate: ReturnType<typeof vi.fn> };
  let notifications: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    strategiesService = {
      bulkUpdate: vi.fn().mockReturnValue(
        of({
          status: true,
          data: { updatedCount: 2, skippedCount: 0, updatedIds: [1, 2], skippedReasons: [] },
          message: 'OK',
          responseCode: '00',
        }),
      ),
    };
    notifications = { success: vi.fn(), error: vi.fn() };

    TestBed.configureTestingModule({
      imports: [StrategiesPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: StrategiesService, useValue: strategiesService },
        {
          provide: RiskProfilesService,
          useValue: {
            list: () => of({ status: true, data: { data: [] }, message: '', responseCode: '00' }),
          },
        },
        { provide: NotificationService, useValue: notifications },
      ],
    });
    const fixture = TestBed.createComponent(StrategiesPageComponent);
    cmp = fixture.componentInstance;
    // Spoof confirm() so unit tests don't open a native dialog.
    (globalThis as any).confirm = () => true;
  });

  const rows: StrategyDto[] = [{ id: 1 } as StrategyDto, { id: 2 } as StrategyDto];

  it('does not dispatch when no rows selected', () => {
    cmp.bulkApply('Activate', [], () => {});
    expect(strategiesService.bulkUpdate).not.toHaveBeenCalled();
  });

  it('does not dispatch while a previous call is in flight', () => {
    cmp.bulkBusy.set(true);
    cmp.bulkApply('Activate', rows, () => {});
    expect(strategiesService.bulkUpdate).not.toHaveBeenCalled();
  });

  it('dispatches Activate with the selected ids', () => {
    cmp.bulkApply('Activate', rows, () => {});
    expect(strategiesService.bulkUpdate).toHaveBeenCalledWith({
      strategyIds: [1, 2],
      action: 'Activate',
    });
  });

  it('dispatches Pause with the selected ids', () => {
    cmp.bulkApply('Pause', rows, () => {});
    expect(strategiesService.bulkUpdate).toHaveBeenCalledWith({
      strategyIds: [1, 2],
      action: 'Pause',
    });
  });

  it('clears bulkBusy and notifies success on completion', () => {
    const clear = vi.fn();
    cmp.bulkApply('Activate', rows, clear);
    expect(cmp.bulkBusy()).toBe(false);
    expect(notifications.success).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });

  it('passes RiskProfileId through onRiskPickerSelect', () => {
    cmp.pickerSelectedRows.set(rows);
    cmp.onRiskPickerSelect(42);
    expect(strategiesService.bulkUpdate).toHaveBeenCalledWith({
      strategyIds: [1, 2],
      action: 'SetRiskProfile',
      riskProfileId: 42,
    });
  });

  it('closes the risk picker after dispatch', () => {
    cmp.showRiskPicker.set(true);
    cmp.pickerSelectedRows.set(rows);
    cmp.onRiskPickerSelect(42);
    expect(cmp.showRiskPicker()).toBe(false);
    expect(cmp.pickerSelectedRows()).toEqual([]);
  });
});
