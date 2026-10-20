import { TestBed } from '@angular/core/testing';
import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { quotaRefusalOf } from '@core/plans/quota-refusal';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { PlansApiService } from './plans-api.service';
import { emptyPlanDraft } from './plans.logic';

ensureTestBed();

const BASE = 'http://engine.test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

describe('PlansApiService (engine Phase 7 wire)', () => {
  let api: PlansApiService;
  let ctl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    api = TestBed.inject(PlansApiService);
    ctl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    ctl.verify();
    TestBed.resetTestingModule();
  });

  it('lists plans quietly, with the session credentials', async () => {
    const p = firstValueFrom(api.plans());
    const req = ctl.expectOne(`${BASE}/platform/plans`);
    expect(req.request.method).toBe('GET');
    expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).toBe(true);
    expect(req.request.withCredentials).toBe(true);
    req.flush(ok([{ id: 2, slug: 'trial' }]));
    expect(await p).toEqual([{ id: 2, slug: 'trial' }]);
  });

  it('creates, updates and deletes plans', async () => {
    const body = { ...emptyPlanDraft(), slug: 'pro', name: 'Pro' };
    const created = firstValueFrom(api.createPlan(body));
    const post = ctl.expectOne(`${BASE}/platform/plans`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(body);
    post.flush(ok({ id: 9 }));
    expect(await created).toEqual({ id: 9 });

    const updated = firstValueFrom(api.updatePlan(9, { ...body, slug: undefined }));
    const put = ctl.expectOne(`${BASE}/platform/plans/9`);
    expect(put.request.method).toBe('PUT');
    put.flush(ok({ id: 9 }));
    await updated;

    const deleted = firstValueFrom(api.deletePlan(9));
    const del = ctl.expectOne(`${BASE}/platform/plans/9`);
    expect(del.request.method).toBe('DELETE');
    del.flush(ok({ id: 9 }));
    await deleted;
  });

  it('moves an organisation to a plan with a reason', async () => {
    const p = firstValueFrom(api.assignPlan(7001, 5, 'signed the order'));
    const req = ctl.expectOne(`${BASE}/platform/tenants/7001/plan`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ planId: 5, reason: 'signed the order' });
    req.flush(ok({ id: 7001, planId: 5, planName: 'Pro' }));
    expect((await p).planName).toBe('Pro');
  });

  it('reads own and staff usage from their endpoints', async () => {
    const mine = firstValueFrom(api.myUsage());
    ctl.expectOne(`${BASE}/tenant/usage`).flush(ok({ tenantId: 7001 }));
    expect((await mine).tenantId).toBe(7001);

    const staff = firstValueFrom(api.tenantUsage(8001));
    ctl.expectOne(`${BASE}/platform/tenants/8001/usage`).flush(ok({ tenantId: 8001 }));
    expect((await staff).tenantId).toBe(8001);
  });

  it('downloads the monthly export as a file named by the engine', async () => {
    const p = firstValueFrom(api.exportUsage('2026-09'));
    const req = ctl.expectOne((r) => r.url === `${BASE}/platform/usage/export`);
    expect(req.request.params.get('month')).toBe('2026-09');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).toBe(true);
    req.flush(new Blob(['month,tenant_id\r\n'], { type: 'text/csv' }), {
      headers: new HttpHeaders({ 'Content-Disposition': 'attachment; filename=lascodia-usage-2026-09.csv' }),
    });
    const file = await p;
    expect(file.fileName).toBe('lascodia-usage-2026-09.csv');
    expect(await file.blob.text()).toContain('tenant_id');
  });

  it('names the file itself when the engine does not', async () => {
    const p = firstValueFrom(api.exportUsage('2026-08'));
    ctl.expectOne((r) => r.url === `${BASE}/platform/usage/export`).flush(new Blob(['x']));
    expect((await p).fileName).toBe('lascodia-usage-2026-08.csv');
  });

  it('asks for the fleet with its window and organisation', async () => {
    const all = firstValueFrom(api.fleet(24));
    ctl.expectOne(`${BASE}/platform/fleet?sinceHours=24`).flush(ok({ instances: [] }));
    await all;

    const one = firstValueFrom(api.fleet(168, 7001));
    ctl.expectOne(`${BASE}/platform/fleet?sinceHours=168&tenantId=7001`).flush(ok({ instances: [] }));
    await one;
  });

  it('turns a refused envelope into an ApiError that keeps the quota refusal', async () => {
    const p = firstValueFrom(api.myUsage()).catch((e: unknown) => e);
    ctl.expectOne(`${BASE}/tenant/usage`).flush({
      status: false,
      message: 'No',
      responseCode: '-403-quota',
      data: { quota: 'members', limit: 5, used: 5, plan: 'Trial' },
    });
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect(quotaRefusalOf(err)?.limit).toBe(5);
  });
});
