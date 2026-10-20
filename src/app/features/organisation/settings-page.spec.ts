import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { ConfigChangeDialogComponent } from './components/config-change-dialog.component';
import { OrganisationApiService, overrideResult } from './organisation-api.service';
import type { ConfigOverrides, EffectiveConfigEntry } from './organisation.types';
import { SettingsPageComponent } from './pages/settings-page.component';

ensureTestBed();

function apiStub() {
  return {
    effectiveConfig: vi.fn(() => of({ tenantId: 1, tradingAccountId: null, entries: [cap, fill] })),
    configOverrides: vi.fn(() => of(overrides)),
    setOverride: vi.fn(() =>
      of({
        id: 3,
        outcome: 'Applied',
        effectiveAt: null,
        pendingChangeId: null,
        breakGlass: false,
        message: 'ok',
      }),
    ),
    removeOverride: vi.fn(() =>
      of({
        id: 3,
        outcome: 'Removed',
        effectiveAt: null,
        pendingChangeId: null,
        breakGlass: false,
        message: 'ok',
      }),
    ),
    cancelPendingOverride: vi.fn(() =>
      of({
        id: 9,
        outcome: 'Removed',
        effectiveAt: null,
        pendingChangeId: null,
        breakGlass: false,
        message: 'ok',
      }),
    ),
  };
}

const cap: EffectiveConfigEntry = {
  key: 'TenantRisk:MaxOpenPositions',
  family: 'TenantRisk:MaxOpenPositions',
  description: 'Most open positions.',
  value: '10',
  source: 'Tenant',
  allowedLayers: ['Platform', 'Tenant'],
  valueKind: 'Int',
  allowedValues: [],
  min: 0,
  max: 100000,
  tightenOnly: true,
  riskSensitive: true,
  tightness: 'LowerIsTighterZeroUnlimited',
  inheritedValue: '0',
  secret: false,
  layers: [],
};

const fill: EffectiveConfigEntry = {
  ...cap,
  key: 'EA:FillMode',
  family: 'EA:FillMode',
  value: 'Market',
  source: 'Default',
  allowedLayers: ['Platform', 'Tenant', 'Account'],
  valueKind: 'Enum',
  allowedValues: ['Market', 'Limit'],
  min: null,
  max: null,
  tightenOnly: false,
  riskSensitive: false,
  tightness: 'None',
  inheritedValue: 'Market',
};

const overrides: ConfigOverrides = {
  overrides: [
    {
      id: 3,
      scopeType: 'Tenant',
      tradingAccountId: null,
      key: cap.key,
      value: '10',
      updatedBy: 'a',
      updatedAtUtc: '2026-10-20T08:00:00Z',
      reason: null,
    },
  ],
  pending: [],
};

let api: ReturnType<typeof apiStub>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = apiStub();
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: OrganisationApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: AccountScopeService,
        useValue: {
          accounts: signal([
            {
              id: 7,
              accountId: '1007',
              accountName: 'Seven',
              brokerServer: 'S',
              accountType: 'Demo',
              isPaper: false,
            },
          ]),
        },
      },
    ],
  });
});

afterEach(() => TestBed.resetTestingModule());

describe('SettingsPageComponent', () => {
  const page = () => TestBed.runInInjectionContext(() => new SettingsPageComponent());

  it('loads the organisation’s settings, grouped, and knows which it set itself', () => {
    const p = page();
    expect(api.effectiveConfig).toHaveBeenCalledWith(null);
    expect(api.configOverrides).toHaveBeenCalledWith(null);
    expect(p.groups().map((g) => g.name)).toEqual(['EA', 'TenantRisk']);
    expect(p.hasOwnValue(cap)).toBe(true);
    expect(p.hasOwnValue(fill)).toBe(false);
    expect(p.canSetHere(cap)).toBe(true);
  });

  it('switching to an account reads that account’s view; organisation-wide keys are not editable there', () => {
    const p = page();
    p.selectScope(7);
    expect(api.effectiveConfig).toHaveBeenLastCalledWith(7);
    expect(api.configOverrides).toHaveBeenLastCalledWith(7);
    expect(p.layer()).toBe('Account');
    expect(p.canSetHere(cap)).toBe(false);
    expect(p.layerHint(cap)).toBe('Organisation-wide');
    expect(p.canSetHere(fill)).toBe(true);
    expect(p.scopeName()).toContain('Seven');
  });

  it('reloads after a change the engine took, not after a cancel', () => {
    const p = page();
    p.editDone(false);
    expect(api.effectiveConfig).toHaveBeenCalledTimes(1);
    p.editDone(true);
    expect(api.effectiveConfig).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued change after confirming', () => {
    const p = page();
    p.cancelling.set({
      id: 9,
      scopeType: 'Tenant',
      tradingAccountId: null,
      key: cap.key,
      remove: false,
      newValue: '20',
      oldValue: '10',
      reason: 'r',
      requestedAt: '',
      effectiveAt: '',
    });
    p.cancelPending();
    expect(api.cancelPendingOverride).toHaveBeenCalledWith(9, null);
    expect(notify.success).toHaveBeenCalled();
  });
});

describe('ConfigChangeDialogComponent', () => {
  function dialog(
    entry: EffectiveConfigEntry,
    opts: { mode?: 'set' | 'remove'; account?: number } = {},
  ) {
    const d = TestBed.runInInjectionContext(() => new ConfigChangeDialogComponent());
    const closed: boolean[] = [];
    d.closed.subscribe((v) => closed.push(v));
    d.open({
      entry,
      mode: opts.mode ?? 'set',
      layer: opts.account ? 'Account' : 'Tenant',
      tradingAccountId: opts.account ?? null,
      scopeName: opts.account ? 'Seven' : 'The organisation',
    });
    return { d, closed };
  }

  it('prefills the current value and applies a tightening at once', () => {
    const { d, closed } = dialog(cap);
    expect(d.value()).toBe('10');
    d.value.set('5');
    expect(d.plan().governed).toBe(false);
    d.save();
    expect(api.setOverride).toHaveBeenCalledWith({ scopeType: 'Tenant', key: cap.key, value: '5' });
    expect(notify.success).toHaveBeenCalledWith(`${cap.key} saved.`);
    expect(closed).toEqual([true]);
    expect(d.entry()).toBeNull();
  });

  it('asks for a reason before sending a loosening, then offers break-glass', () => {
    const { d } = dialog(cap);
    d.value.set('20');
    expect(d.plan().governed).toBe(true);
    d.save();
    expect(api.setOverride).not.toHaveBeenCalled();
    expect(d.problems()[0]).toContain('Give a reason');

    d.reason.set('Desk asked for room');
    d.immediate.set(true);
    d.save();
    expect(api.setOverride).toHaveBeenCalledWith({
      scopeType: 'Tenant',
      key: cap.key,
      value: '20',
      reason: 'Desk asked for room',
      immediate: true,
    });
  });

  it('never sends a value looser than what a tighten-only key inherits', () => {
    const { d } = dialog({ ...cap, inheritedValue: '15' });
    d.value.set('20');
    d.reason.set('x');
    d.save();
    expect(d.problems()[0]).toContain('may only be tightened');
    expect(api.setOverride).not.toHaveBeenCalled();
  });

  it('a change sent for a second person’s approval closes the dialog without an error', () => {
    api.setOverride.mockReturnValueOnce(
      throwError(
        () =>
          new ApiError('-202-approval', 'Waiting for a second person', {
            data: { approvalId: 4, expiresAtUtc: '2026-10-21T00:00:00Z' },
            status: false,
            message: 'Waiting',
            responseCode: '-202-approval',
          }),
      ),
    );
    const { d, closed } = dialog(cap);
    d.value.set('20');
    d.reason.set('r');
    d.save();
    expect(closed).toEqual([true]);
    expect(d.error()).toBeNull();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('shows the engine’s refusal inline and keeps the dialog open; a step-up is not an error', () => {
    api.setOverride.mockReturnValueOnce(
      throwError(
        () =>
          new ApiError('-11', 'A reason is required.', {
            data: 0,
            status: false,
            message: 'A reason is required.',
            responseCode: '-11',
          }),
      ),
    );
    const { d, closed } = dialog(fill, { account: 7 });
    d.value.set('Limit');
    d.save();
    expect(api.setOverride).toHaveBeenCalledWith({
      scopeType: 'Account',
      tradingAccountId: 7,
      key: 'EA:FillMode',
      value: 'Limit',
    });
    expect(d.error()).toBe('A reason is required.');
    expect(closed).toEqual([]);

    api.setOverride.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
    d.save();
    expect(d.error()).toBeNull();
  });

  it('removes an own value with a reason when that loosens a risk key', () => {
    const { d, closed } = dialog(cap, { mode: 'remove' });
    expect(d.plan()).toMatchObject({ governed: true, after: '0' });
    d.save();
    expect(api.removeOverride).not.toHaveBeenCalled();
    d.reason.set('No limit needed');
    d.save();
    expect(api.removeOverride).toHaveBeenCalledWith({
      scopeType: 'Tenant',
      tradingAccountId: null,
      key: cap.key,
      reason: 'No limit needed',
      immediate: false,
    });
    expect(closed).toEqual([true]);
  });
});

describe('overrideResult', () => {
  it('reads the outcome fields of an accepted write', () => {
    expect(
      overrideResult({
        data: 12,
        status: true,
        message: 'Queued',
        responseCode: '00',
        outcome: 'QueuedForCoolingOff',
        effectiveAt: '2026-10-21T10:00:00Z',
        pendingChangeId: 12,
        breakGlass: false,
      }),
    ).toEqual({
      id: 12,
      outcome: 'QueuedForCoolingOff',
      effectiveAt: '2026-10-21T10:00:00Z',
      pendingChangeId: 12,
      breakGlass: false,
      message: 'Queued',
    });
  });

  it('turns a refusal, and a two-person answer, into an ApiError', () => {
    expect(() =>
      overrideResult({ data: 0, status: false, message: 'No', responseCode: '-11' }),
    ).toThrowError('No');
    try {
      overrideResult({ data: 0, status: false, message: 'Sent', responseCode: '-202-approval' });
    } catch (e) {
      expect((e as ApiError).isApprovalPending).toBe(true);
    }
  });
});
