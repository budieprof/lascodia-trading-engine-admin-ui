import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { LifecycleApiService } from './lifecycle-api.service';

ensureTestBed();

const BASE = 'http://engine.test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

describe('LifecycleApiService (engine Phase 7 wire)', () => {
  let api: LifecycleApiService;
  let ctl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    api = TestBed.inject(LifecycleApiService);
    ctl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    ctl.verify();
    TestBed.resetTestingModule();
  });

  it('reads the branding quietly with the session credentials', async () => {
    const done = firstValueFrom(api.branding());
    const req = ctl.expectOne(`${BASE}/tenant/branding`);
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).toBe(true);
    req.flush(ok({ tenantId: 7, displayName: 'Acme', isCustomised: false }));
    expect((await done).displayName).toBe('Acme');
  });

  it('uploads an image as multipart field "file" to its kind', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    const done = firstValueFrom(api.uploadImage('logo', file));
    const req = ctl.expectOne(`${BASE}/tenant/branding/logo`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body instanceof FormData).toBe(true);
    expect((req.request.body as FormData).get('file')).toBeTruthy();
    req.flush(ok({ tenantId: 7, displayName: 'Acme', isCustomised: true }));
    expect((await done).isCustomised).toBe(true);
  });

  it('asks for an export and a single-use link, and turns the link into a full URL', async () => {
    const asked = firstValueFrom(api.requestExport());
    ctl
      .expectOne({ method: 'POST', url: `${BASE}/tenant/exports` })
      .flush(ok({ id: 3, status: 'Queued' }));
    expect((await asked).id).toBe(3);

    const link = firstValueFrom(api.downloadLink(3));
    ctl
      .expectOne({ method: 'POST', url: `${BASE}/tenant/exports/3/download-link` })
      .flush(ok({ url: 'tenant/exports/download/lsc_dl_x', expiresAtUtc: '2026-10-20T09:10:00Z' }));
    expect(api.absolute((await link).url)).toBe(`${BASE}/tenant/exports/download/lsc_dl_x`);
  });

  it('a refusal arrives as an ApiError with the engine message', async () => {
    const done = firstValueFrom(api.requestExport()).catch((e: unknown) => e);
    ctl.expectOne(`${BASE}/tenant/exports`).flush({
      status: false,
      responseCode: '-409',
      message: 'Export #2 is still being prepared',
      data: null,
    });
    const err = (await done) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('still being prepared');
  });

  it('close returns the raw envelope so a second-Owner approval (202) is not a failure', async () => {
    const done = firstValueFrom(api.close({ confirmSlug: 'acme', reason: 'leaving' }));
    const req = ctl.expectOne({ method: 'POST', url: `${BASE}/tenant/closure` });
    expect(req.request.body).toEqual({ confirmSlug: 'acme', reason: 'leaving' });
    req.flush(
      {
        status: false,
        responseCode: '-202-approval',
        message: 'needs a second Owner',
        data: { closure: null, approvalId: 4, expiresAtUtc: 'x' },
      },
      { status: 202, statusText: 'Accepted' },
    );
    expect((await done).responseCode).toBe('-202-approval');
  });

  it('platform staff reopen, plan and confirm by organisation id', async () => {
    const reopened = firstValueFrom(api.reopen(7001, 'changed mind'));
    const r = ctl.expectOne({ method: 'POST', url: `${BASE}/platform/closures/7001/reopen` });
    expect(r.request.body).toEqual({ reason: 'changed mind' });
    r.flush(ok({ id: 1, status: 'Reopened' }));
    await reopened;

    const planned = firstValueFrom(api.planPurge(7001));
    ctl
      .expectOne({ method: 'POST', url: `${BASE}/platform/closures/7001/purge-plan` })
      .flush(ok({ canRun: true }));
    await planned;

    const purged = firstValueFrom(api.schedulePurge(7001, 'acme'));
    const p = ctl.expectOne({ method: 'POST', url: `${BASE}/platform/closures/7001/purge` });
    expect(p.request.body).toEqual({ confirmSlug: 'acme' });
    p.flush(ok({ id: 1, status: 'PurgeScheduled' }));
    await purged;
  });
});
