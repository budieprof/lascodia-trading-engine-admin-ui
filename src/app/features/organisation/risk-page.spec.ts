import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { Permission as P } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from './organisation-api.service';
import type { ScopedKillSwitchStatus } from './organisation.types';
import { RiskPageComponent } from './pages/risk-page.component';

ensureTestBed();

const off = (scope: string): ScopedKillSwitchStatus => ({
  enabled: false,
  reason: null,
  changedAt: null,
  changedBy: null,
  scope,
  haltedBy: null,
});

function apiStub() {
  return {
    tenantKillSwitch: vi.fn(() => of(off('Tenant'))),
    accountKillSwitch: vi.fn((id: number) =>
      id === 8 ? throwError(() => new HttpErrorResponse({ status: 500 })) : of(off('Account')),
    ),
    setTenantKillSwitch: vi.fn(() => of({ ...off('Tenant'), enabled: true })),
    setAccountKillSwitch: vi.fn(() => of(off('Account'))),
    flattenOrganisation: vi.fn(() => of(true)),
    flattenAccount: vi.fn(() => of(true)),
    effectiveConfig: vi.fn(() =>
      of({
        tenantId: 1,
        tradingAccountId: null,
        entries: [
          {
            key: 'TenantRisk:MaxOpenPositions',
            family: 'TenantRisk:MaxOpenPositions',
            description: 'd',
            value: '0',
            source: 'Default',
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
          },
        ],
      }),
    ),
  };
}

let api: ReturnType<typeof apiStub>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

function setup(permissions: string[], tenantName: string | null = 'Acme') {
  api = apiStub();
  notify = { error: vi.fn(), success: vi.fn() };
  const held = new Set(permissions);
  TestBed.configureTestingModule({
    providers: [
      { provide: OrganisationApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: AuthService,
        useValue: {
          hasPermission: (k: string) => held.has(k),
          activeTenant: signal(
            tenantName ? { id: 5, slug: 'acme', name: tenantName, kind: 'Customer' } : null,
          ),
        },
      },
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
            {
              id: 8,
              accountId: '1008',
              accountName: 'Eight',
              brokerServer: 'S',
              accountType: 'Demo',
              isPaper: false,
            },
          ]),
        },
      },
    ],
  });
}

afterEach(() => TestBed.resetTestingModule());

const page = () => {
  const p = TestBed.runInInjectionContext(() => new RiskPageComponent());
  TestBed.tick();
  return p;
};

describe('RiskPageComponent', () => {
  beforeEach(() =>
    setup([P.EngineKillswitch, P.EngineKillswitchRelease, P.PositionsFlatten, P.EngineConfig]),
  );

  it('reads the organisation’s switch, every account’s and the limits; a failed account read stays visible', () => {
    const p = page();
    expect(api.tenantKillSwitch).toHaveBeenCalledTimes(1);
    expect(api.accountKillSwitch).toHaveBeenCalledWith(7);
    expect(api.accountKillSwitch).toHaveBeenCalledWith(8);
    expect(p.accountRows().map((r) => [r.account.id, !!r.status, !!r.error])).toEqual([
      [7, true, false],
      [8, false, true],
    ]);
    expect(p.limitRows().map((e) => e.key)).toEqual(['TenantRisk:MaxOpenPositions']);
  });

  it('engages the organisation’s switch only with a reason', () => {
    const p = page();
    p.startSwitch('organisation', true);
    p.confirmSwitch();
    expect(api.setTenantKillSwitch).not.toHaveBeenCalled();
    expect(p.switching()).not.toBeNull();

    p.switchReason.set('  Broker outage ');
    p.confirmSwitch();
    expect(api.setTenantKillSwitch).toHaveBeenCalledWith(true, 'Broker outage');
    expect(p.switching()).toBeNull();
    expect(notify.success).toHaveBeenCalledWith("The organisation's kill switch engaged.");
  });

  it('a release sent for a second person’s approval is not reported as a failure', () => {
    const p = page();
    api.setAccountKillSwitch.mockReturnValueOnce(
      throwError(
        () =>
          new ApiError('-202-approval', 'Waiting', {
            data: { approvalId: 3, expiresAtUtc: 'x' },
            status: false,
            message: 'Waiting',
            responseCode: '-202-approval',
          }),
      ),
    );
    p.startSwitch('account', false, p.accounts()[0]);
    p.switchReason.set('Resume');
    p.confirmSwitch();
    expect(api.setAccountKillSwitch).toHaveBeenCalledWith(7, false, 'Resume');
    expect(notify.error).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('flattens the organisation only once its name and a reason are given', () => {
    const p = page();
    p.startFlatten('organisation');
    expect(p.flattening()?.phrase).toBe('Acme');
    p.flattenReason.set('Runaway strategy');
    p.typed.set('acm');
    p.confirmFlatten();
    expect(api.flattenOrganisation).not.toHaveBeenCalled();

    p.typed.set(' ACME ');
    expect(p.flattenReady()).toBe(true);
    p.confirmFlatten();
    expect(api.flattenOrganisation).toHaveBeenCalledWith('Runaway strategy');
    expect(p.flattening()).toBeNull();
  });

  it('flattens one account after typing its login; a refusal is reported', () => {
    const p = page();
    api.flattenAccount.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: {
              status: false,
              message: 'You may not flatten this account.',
              responseCode: '-403',
            },
          }),
      ),
    );
    p.startFlatten('account', p.accounts()[1]);
    expect(p.flattening()?.phrase).toBe('1008');
    p.flattenReason.set('r');
    p.typed.set('1008');
    p.confirmFlatten();
    expect(api.flattenAccount).toHaveBeenCalledWith(8, 'r');
    expect(notify.error).toHaveBeenCalledWith('You may not flatten this account.');
  });
});

describe('RiskPageComponent without kill-switch or settings keys', () => {
  beforeEach(() => setup([P.PositionsFlatten], null));

  it('reads nothing it may not, and still offers the flatten (typed phrase falls back)', () => {
    const p = page();
    expect(api.tenantKillSwitch).not.toHaveBeenCalled();
    expect(api.accountKillSwitch).not.toHaveBeenCalled();
    expect(api.effectiveConfig).not.toHaveBeenCalled();
    p.startFlatten('organisation');
    expect(p.flattening()?.phrase).toBe('FLATTEN');
  });
});
