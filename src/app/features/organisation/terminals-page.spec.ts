import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TradingAccountDto } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from './organisation-api.service';
import type { EnrollmentToken, MachineCredential } from './organisation.types';
import { TerminalsPageComponent } from './pages/terminals-page.component';

ensureTestBed();

function apiStub() {
  return {
    enrollmentTokens: vi.fn(() => of([token])),
    machineCredentials: vi.fn(() => of([credential])),
    createEnrollmentToken: vi.fn(() =>
      of({
        id: 5,
        token: 'lsc_enr_new_secret',
        prefix: 'lsc_enr_new',
        kind: 'EaTerminal',
        tradingAccountId: 1,
        accountLogin: null,
        brokerServer: null,
        label: 'mac2',
        expiresAtUtc: '2026-10-21T08:00:00Z',
      }),
    ),
    revokeEnrollmentToken: vi.fn(() => of(true)),
    revokeCredential: vi.fn(() => of(true)),
    rotateCredential: vi.fn(() => of(true)),
  };
}

const token: EnrollmentToken = {
  id: 4,
  prefix: 'lsc_enr_ab12',
  kind: 'EaTerminal',
  label: 'mac2 EURUSD',
  tradingAccountId: null,
  accountLogin: null,
  brokerServer: null,
  createdBy: 'admin:1',
  createdAtUtc: '2026-10-20T08:00:00Z',
  expiresAtUtc: '2026-10-21T08:00:00Z',
  usedAtUtc: null,
  usedByCredentialId: null,
  revokedAtUtc: null,
  status: 'Pending',
};

const credential: MachineCredential = {
  id: 9,
  kind: 'EaTerminal',
  instanceId: 'LASC-9',
  tradingAccountId: 1,
  origin: 'LegacyUpgrade',
  createdBy: 'ea',
  createdAtUtc: '2026-10-20T08:00:00Z',
  lastUsedAtUtc: '2026-10-20T09:00:00Z',
  lastUsedIp: null,
  rotationRequestedAtUtc: null,
  rotationPending: false,
  replacesCredentialId: null,
  parentCredentialId: null,
  enrollmentTokenId: null,
  terminalFingerprint: null,
  revokedAtUtc: null,
  revokedReason: null,
  revokedBy: null,
};

describe('TerminalsPageComponent', () => {
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
                id: 1,
                accountId: '1001',
                accountName: 'Main',
                brokerServer: 'B-Demo',
                accountType: 'Demo',
                isPaper: false,
              } as TradingAccountDto,
            ]),
          },
        },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  const page = () => TestBed.runInInjectionContext(() => new TerminalsPageComponent());

  it('loads pending tokens and active credentials on open, grouped by account', () => {
    const p = page();
    expect(api.enrollmentTokens).toHaveBeenCalledWith(false);
    expect(api.machineCredentials).toHaveBeenCalledWith(false);
    expect(p.groups().map((g) => g.title)).toEqual(['Main · 1001 @ B-Demo (Demo)']);
  });

  it('asks for used/expired tokens and revoked credentials only when asked', () => {
    const p = page();
    p.toggleAllTokens(true);
    p.toggleRevoked(true);
    expect(api.enrollmentTokens).toHaveBeenLastCalledWith(true);
    expect(api.machineCredentials).toHaveBeenLastCalledWith(true);
  });

  it('does not send a draft with problems', () => {
    const p = page();
    p.create();
    expect(p.submitted()).toBe(true);
    expect(api.createEnrollmentToken).not.toHaveBeenCalled();
  });

  it('creates a token bound to an account and shows it once with the steps', () => {
    const p = page();
    p.patch({ label: ' mac2 ' });
    p.setBinding('account');
    p.patch({ tradingAccountId: 1 });
    p.create();
    expect(api.createEnrollmentToken).toHaveBeenCalledWith({
      kind: 'EaTerminal',
      label: 'mac2',
      tradingAccountId: 1,
    });
    expect(p.created()?.token).toBe('lsc_enr_new_secret');
    expect(
      p
        .steps()
        .map((s) => s.text)
        .join(' '),
    ).toContain('only connects Main');
    expect(p.draft().label).toBe('');
    expect(api.enrollmentTokens).toHaveBeenCalledTimes(2);
  });

  it('switching kind forgets the account binding', () => {
    const p = page();
    p.setBinding('login');
    p.patch({ accountLogin: '5', brokerServer: 'S' });
    p.setKind('Daemon');
    expect(p.draft()).toMatchObject({ kind: 'Daemon', binding: 'any', accountLogin: '' });
  });

  it('reports a refused create in the engine’s words, and stays quiet on a step-up', () => {
    const p = page();
    p.patch({ label: 'x' });
    api.createEnrollmentToken.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 404,
            error: { status: false, message: 'Trading account not found.', responseCode: '-14' },
          }),
      ),
    );
    p.create();
    expect(notify.error).toHaveBeenCalledWith('Trading account not found.');

    api.createEnrollmentToken.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 401 })),
    );
    p.create();
    expect(notify.error).toHaveBeenCalledTimes(1);
  });

  it('revokes a pending token after confirming', () => {
    const p = page();
    p.revokingToken.set(token);
    p.revokeToken();
    expect(api.revokeEnrollmentToken).toHaveBeenCalledWith(4);
    expect(p.revokingToken()).toBeNull();
    expect(notify.success).toHaveBeenCalled();
  });

  it('revokes a credential with the reason given, and rotates one', () => {
    const p = page();
    p.startRevoke(credential);
    p.revokeReason.set('  host retired  ');
    p.revokeCredential();
    expect(api.revokeCredential).toHaveBeenCalledWith(9, 'host retired');

    p.startRevoke(credential);
    p.revokeCredential();
    expect(api.revokeCredential).toHaveBeenLastCalledWith(9, null);

    p.rotating.set(credential);
    p.rotateCredential();
    expect(api.rotateCredential).toHaveBeenCalledWith(9);
    expect(p.rotating()).toBeNull();
  });
});
