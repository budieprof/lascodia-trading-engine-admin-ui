import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { TemplatesPageComponent } from './templates-page.component';
import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { StrategyTemplateDto } from '@core/api/api.types';
import { EMPTY } from 'rxjs';

const TEMPLATE: StrategyTemplateDto = {
  id: 7,
  name: 'RSI dip',
  description: 'buy the dip',
  strategyType: 'RuleBased',
  parametersJson: '{"name":"x"}',
  riskProfileId: 3,
  riskOverridesJson: null,
  sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
  sessionFilterJson: null,
  regimeGateJson: null,
  multiTimeframeGateJson: null,
  appliedCount: 2,
  createdAt: '2026-09-01T00:00:00Z',
};

describe('TemplatesPageComponent (edit / delete)', () => {
  let cmp: any;
  let strategies: Record<string, ReturnType<typeof vi.fn>>;
  let notifications: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    strategies = {
      listTemplates: vi.fn().mockReturnValue(of({ status: true, data: [TEMPLATE] })),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      applyTemplate: vi.fn(),
    };
    notifications = { success: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      imports: [TemplatesPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: StrategiesService, useValue: strategies },
        {
          provide: RiskProfilesService,
          useValue: {
            list: () => of({ status: true, data: { data: [{ id: 3, name: 'Conservative' }] } }),
          },
        },
        { provide: AuditTrailService, useValue: { create: () => of({ status: true }) } },
        { provide: NotificationService, useValue: notifications },
        { provide: RealtimeService, useValue: { on: () => EMPTY } },
      ],
    });
    cmp = TestBed.createComponent(TemplatesPageComponent).componentInstance;
  });

  it('opens an editable copy of the template', () => {
    cmp.openEdit(TEMPLATE);
    expect(cmp.draft()).toMatchObject({
      name: 'RSI dip',
      strategyType: 'RuleBased',
      riskProfileId: 3,
      sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
      sessionFilterJson: '',
    });
    expect(cmp.draftIsDsl()).toBe(true);
  });

  it('blocks saving while a JSON field does not parse', () => {
    cmp.openEdit(TEMPLATE);
    cmp.patchDraft('sessionFilterJson', '{ nope');
    expect(cmp.draftJsonErrors()['sessionFilterJson']).toBeTruthy();
    expect(cmp.canSaveDraft()).toBe(false);
    cmp.patchDraft('sessionFilterJson', '');
    expect(cmp.canSaveDraft()).toBe(true);
  });

  it('PUTs the edited template and closes on success', () => {
    strategies['updateTemplate'].mockReturnValue(of({ status: true, data: true }));
    cmp.openEdit(TEMPLATE);
    cmp.patchDraft('name', 'RSI dip v2');
    cmp.patchDraft('riskProfileId', null);
    cmp.saveEdit();
    expect(strategies['updateTemplate']).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        name: 'RSI dip v2',
        strategyType: 'RuleBased',
        riskProfileId: null,
        sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
        sessionFilterJson: null,
      }),
      { silent: true },
    );
    expect(cmp.draft()).toBeNull();
    expect(notifications.success).toHaveBeenCalled();
  });

  it('keeps the dialog open with the engine’s reasons when the save is refused', () => {
    strategies['updateTemplate'].mockReturnValue(
      of({ status: false, message: "Template 'RSI dip v2' already exists.", responseCode: '-11' }),
    );
    cmp.openEdit(TEMPLATE);
    cmp.saveEdit();
    expect(cmp.draft()).not.toBeNull();
    expect(cmp.editErrors()).toEqual(["Template 'RSI dip v2' already exists."]);
  });

  it('shows validation errors from an HTTP 400', () => {
    strategies['updateTemplate'].mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { title: 'Validation Failed', errors: { Name: ['Name cannot be empty'] } },
          }),
      ),
    );
    cmp.openEdit(TEMPLATE);
    cmp.saveEdit();
    expect(cmp.editErrors()).toEqual(['Name: Name cannot be empty']);
  });

  it('deletes only after confirmation and reports a refusal in the dialog', () => {
    strategies['deleteTemplate'].mockReturnValue(
      of({ status: false, message: 'Template is in use' }),
    );
    cmp.askDelete(TEMPLATE);
    expect(strategies['deleteTemplate']).not.toHaveBeenCalled();
    expect(cmp.deleteMessage()).toContain("'RSI dip'");
    expect(cmp.deleteMessage()).toContain('applied 2 times');
    cmp.confirmDelete();
    expect(strategies['deleteTemplate']).toHaveBeenCalledWith(7, { silent: true });
    expect(cmp.deleting()).not.toBeNull();
    expect(cmp.deleteError()).toBe('Template is in use');

    strategies['deleteTemplate'].mockReturnValue(of({ status: true, data: true }));
    cmp.confirmDelete();
    expect(cmp.deleting()).toBeNull();
    expect(notifications.success).toHaveBeenCalledWith("Template 'RSI dip' deleted");
  });
});
