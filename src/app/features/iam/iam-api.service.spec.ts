import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { IamApiService } from './iam-api.service';

ensureTestBed();

const BASE = 'http://engine.test/api/v1/lascodia-trading-engine';

describe('IamApiService (contract C3.5 wire mapping)', () => {
  let api: IamApiService;
  let ctl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    api = TestBed.inject(IamApiService);
    ctl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    ctl.verify();
    TestBed.resetTestingModule();
  });

  it('lists members, quietly (the page reports errors itself)', async () => {
    const p = firstValueFrom(api.members());
    const req = ctl.expectOne(`${BASE}/iam/members`);
    expect(req.request.method).toBe('GET');
    expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).toBe(true);
    expect(req.request.withCredentials).toBe(true);
    req.flush({ status: true, data: [{ userId: 1, username: 'ada', status: 'Active' }] });
    expect(await p).toEqual([{ userId: 1, username: 'ada', status: 'Active' }]);
  });

  it('changes status with PATCH {status} and removes with DELETE', async () => {
    const a = firstValueFrom(api.setMemberStatus(4, 'Suspended'));
    const patch = ctl.expectOne(`${BASE}/iam/members/4`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ status: 'Suspended' });
    patch.flush({ status: true, data: null });
    await expect(a).resolves.toBeNull();

    const b = firstValueFrom(api.removeMember(4));
    const del = ctl.expectOne(`${BASE}/iam/members/4`);
    expect(del.request.method).toBe('DELETE');
    del.flush({ status: true, data: null });
    await b;
  });

  it('turns a refusal envelope into an error carrying the engine message', async () => {
    const p = firstValueFrom(api.revokeGrant(9));
    ctl.expectOne(`${BASE}/iam/grants/9`).flush({ status: false, data: null, responseCode: '-11', message: 'Last owner' });
    await expect(p).rejects.toMatchObject({ code: '-11', message: 'Last owner' });
  });

  it('queries grants and explain with only the set fields', () => {
    api.grants({ principalType: 'Team', principalId: 3, scopeType: null }).subscribe();
    ctl.expectOne(`${BASE}/iam/grants?principalType=Team&principalId=3`).flush({ status: true, data: [] });

    api
      .explain({ principalType: 'User', principalId: 5, permission: 'orders.read', scopeType: 'TradingAccount', scopeId: 18 })
      .subscribe();
    ctl
      .expectOne(`${BASE}/iam/explain?principalType=User&principalId=5&permission=orders.read&scopeType=TradingAccount&scopeId=18`)
      .flush({ status: true, data: { allowed: true, via: [], missingReason: null } });
  });

  it('sends invitations, grants, tokens and elevations in the contract shape', () => {
    api.invite({ email: 'a@b.co', grants: [{ roleId: 2, scopeType: 'Tenant', scopeId: null }] }).subscribe();
    const inv = ctl.expectOne(`${BASE}/iam/invitations`);
    expect(inv.request.body).toEqual({ email: 'a@b.co', grants: [{ roleId: 2, scopeType: 'Tenant', scopeId: null }] });
    inv.flush({ status: true, data: { invitationId: 1, acceptUrl: null } });

    api
      .createGrant({ principalType: 'User', principalId: 5, roleId: 2, scopeType: 'AccountGroup', scopeId: 4, expiresAtUtc: null, reason: 'cover' })
      .subscribe();
    ctl.expectOne(`${BASE}/iam/grants`).flush({ status: true, data: null });

    api.createMyToken({ name: 'CI', permissions: ['orders.read'], expiresInDays: 30 }).subscribe();
    const tok = ctl.expectOne(`${BASE}/iam/me/tokens`);
    expect(tok.request.body).toEqual({ name: 'CI', permissions: ['orders.read'], expiresInDays: 30 });
    tok.flush({ status: true, data: { id: 1, token: 'lsc_pat_x', prefix: 'x', expiresAtUtc: '' } });

    api.requestElevation({ tenantId: 3, reason: 'incident 41', minutes: 60, permissions: ['orders.read'] }).subscribe();
    const el = ctl.expectOne(`${BASE}/platform/elevations`);
    expect(el.request.body).toEqual({ tenantId: 3, reason: 'incident 41', minutes: 60, permissions: ['orders.read'] });
    el.flush({ status: true, data: null });

    api.startImpersonation({ userId: 7, tenantId: 3, readOnly: true }).subscribe();
    const imp = ctl.expectOne(`${BASE}/platform/impersonation`);
    expect(imp.request.body).toEqual({ userId: 7, tenantId: 3, readOnly: true });
    imp.flush({ status: true, data: null });
  });

  it('maps t2-core tenant members to member rows', async () => {
    const p = firstValueFrom(api.tenantMembers(3));
    ctl.expectOne(`${BASE}/platform/tenants/3/members`).flush({
      status: true,
      data: [{ tenantId: 3, adminUserId: 12, username: 'ada', displayName: 'Ada', email: 'a@x', status: 'Active' }],
    });
    expect(await p).toEqual([{ userId: 12, username: 'ada', displayName: 'Ada', email: 'a@x', status: 'Active' }]);
  });

  it('falls back to an empty list for an unexpected list shape', async () => {
    const p = firstValueFrom(api.teams());
    ctl.expectOne(`${BASE}/iam/teams`).flush({ status: true, data: { pager: {} } });
    expect(await p).toEqual([]);
  });
});
