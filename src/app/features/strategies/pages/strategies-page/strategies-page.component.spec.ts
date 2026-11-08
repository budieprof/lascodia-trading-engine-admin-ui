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
import { resolveJitResources } from '@shared/testing/jit-resources';

// Bulk-action handlers exist on the component class and are independent of
// the table render — they take rows + a clear callback. Driving them
// directly avoids the cost of mounting AG Grid and the realtime subscription.

describe('StrategiesPageComponent (bulk handlers)', () => {
  let cmp: StrategiesPageComponent;
  let strategiesService: { bulkUpdate: ReturnType<typeof vi.fn> };
  let notifications: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    // styleUrl: resolved for the JIT runner (it cannot load the .scss).
    await resolveJitResources();
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

describe('StrategiesPageComponent (create refusals, clone)', () => {
  let cmp: StrategiesPageComponent;
  let create: ReturnType<typeof vi.fn>;
  let notifications: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    // styleUrl: resolved for the JIT runner (it cannot load the .scss).
    await resolveJitResources();
    create = vi.fn();
    notifications = { success: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      imports: [StrategiesPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: StrategiesService, useValue: { create } },
        {
          provide: RiskProfilesService,
          useValue: {
            list: () => of({ status: true, data: { data: [] }, message: '', responseCode: '00' }),
          },
        },
        { provide: NotificationService, useValue: notifications },
      ],
    });
    cmp = TestBed.createComponent(StrategiesPageComponent).componentInstance;
    cmp.showCreateForm.set(true);
  });

  it('keeps the form open with the engine’s reason when a create is refused with 200', () => {
    create.mockReturnValue(
      of({
        status: false,
        message: 'A strategy with identical parameters already exists',
        responseCode: '-11',
        data: 0,
      }),
    );
    cmp.onCreate({ name: 'x', symbol: 'EURUSD', symbols: ['EURUSD'], strategyType: 'RuleBased' });
    expect(cmp.showCreateForm()).toBe(true);
    expect(cmp.createError()).toBe('A strategy with identical parameters already exists');
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it('closes and reports the new id on success', () => {
    create.mockReturnValue(
      of({ status: true, message: 'Successful', responseCode: '00', data: 99 }),
    );
    cmp.onCreate({ name: 'x', symbol: 'EURUSD', symbols: ['EURUSD'], strategyType: 'RuleBased' });
    expect(cmp.showCreateForm()).toBe(false);
    expect(notifications.success).toHaveBeenCalledWith('Strategy #99 created (Paused)');
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ symbols: expect.anything() }),
      { silent: true },
    );
  });

  it('bulk create sends one create per symbol and lists the failures', () => {
    create
      .mockReturnValueOnce(of({ status: true, data: 1 }))
      .mockReturnValueOnce(of({ status: false, message: 'duplicate' }));
    const script = '//@version=6\nstrategy("x")';
    cmp.onCreate({
      name: 'Rule',
      symbol: 'EURUSD',
      symbols: ['EURUSD', 'GBPUSD'],
      strategyType: 'RuleBased',
      scriptSource: script,
    });
    expect(create.mock.calls[0][0]).toMatchObject({ symbol: 'EURUSD', scriptSource: script });
    expect(create.mock.calls[1][0]).toMatchObject({ symbol: 'GBPUSD', scriptSource: script });
    expect('symbols' in create.mock.calls[0][0]).toBe(false);
    expect(notifications.error).toHaveBeenCalledWith('1 not created — GBPUSD: duplicate');
    expect(cmp.showCreateForm()).toBe(false);
  });

  it('opens the clone dialog from the row action', () => {
    const col = cmp.columns.find((c) => c.colId === 'actions')!;
    const button = document.createElement('button');
    button.setAttribute('data-action', 'clone');
    (col.onCellClicked as any)({ event: { target: button }, data: { id: 5 } });
    expect(cmp.cloneTarget()).toEqual({ id: 5 });
  });
});

describe('StrategiesPageComponent (Monitor accounts / unit)', () => {
  let cmp: StrategiesPageComponent;
  let getEquityCurve: ReturnType<typeof vi.fn>;

  const curve = (data: Record<string, unknown>) =>
    of({
      status: true,
      message: 'OK',
      responseCode: '00',
      data: {
        strategyId: 7,
        from: null,
        to: null,
        pointCount: 2,
        finalCumulativePnL: 0.5,
        points: [
          { closedAt: '2026-11-01T00:00:00Z', realizedPnL: 1.5, cumulativePnL: 1.5 },
          { closedAt: '2026-11-02T00:00:00Z', realizedPnL: -1, cumulativePnL: 0.5 },
        ],
        ...data,
      },
    });

  beforeEach(async () => {
    await resolveJitResources();
    getEquityCurve = vi.fn().mockReturnValue(curve({}));
    TestBed.configureTestingModule({
      imports: [StrategiesPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: StrategiesService, useValue: { getEquityCurve } },
        {
          provide: RiskProfilesService,
          useValue: {
            list: () => of({ status: true, data: { data: [] }, message: '', responseCode: '00' }),
          },
        },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    cmp = TestBed.createComponent(StrategiesPageComponent).componentInstance;
    cmp.selectedStrategyId.set(7);
  });

  it('asks for Paper / R and labels what the engine answered', () => {
    getEquityCurve.mockReturnValue(curve({ accountKind: 'Paper', unit: 'Currency' }));
    cmp.setMonitorAccountKind('Paper');
    expect(getEquityCurve).toHaveBeenLastCalledWith(7, { accountKind: 'Paper' });
    expect(cmp.monitorCurveAccountKind()).toBe('Paper');
    expect(cmp.monitorCurveMismatch()).toBeNull();
    expect(cmp.monitorTrades().length).toBe(2);

    getEquityCurve.mockReturnValue(curve({ accountKind: 'Paper', unit: 'R', truncated: true }));
    cmp.setMonitorUnit('R');
    expect(getEquityCurve).toHaveBeenLastCalledWith(7, { accountKind: 'Paper', unit: 'R' });
    expect(cmp.monitorCurveUnit()).toBe('R');
    expect(cmp.monitorCurveScope()).toContain('newest 5,000');
  });

  it('All / Currency sends the pre-option body, and an engine that ignores the options is called out', () => {
    cmp.setMonitorUnit('R'); // older engine: answer has no unit / accountKind
    expect(cmp.monitorCurveUnit()).toBe('Currency');
    expect(cmp.monitorCurveMismatch()).toContain('does not support');
    cmp.setMonitorUnit('Currency');
    expect(getEquityCurve).toHaveBeenLastCalledWith(7, {});
    expect(cmp.monitorCurveMismatch()).toBeNull();
  });
});
