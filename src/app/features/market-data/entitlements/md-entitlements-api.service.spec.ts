import { TestBed } from '@angular/core/testing';
import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { MarketDataEntitlementsApiService } from './md-entitlements-api.service';

ensureTestBed();

const BASE = 'http://engine.test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

describe('MarketDataEntitlementsApiService (engine C6 wire)', () => {
  let api: MarketDataEntitlementsApiService;
  let ctl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    api = TestBed.inject(MarketDataEntitlementsApiService);
    ctl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    ctl.verify();
    TestBed.resetTestingModule();
  });

  it('lists grants quietly, with filters only when set', async () => {
    const all = firstValueFrom(api.list());
    const req = ctl.expectOne(`${BASE}/admin/md/entitlements`);
    expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).toBe(true);
    req.flush(ok(null));
    expect(await all).toEqual([]);

    const some = firstValueFrom(
      api.list({ tenantId: 7001, feedId: 'cme-l2', includeRevoked: true }),
    );
    ctl
      .expectOne(`${BASE}/admin/md/entitlements?tenantId=7001&feedId=cme-l2&includeRevoked=true`)
      .flush(ok([{ id: 1 }]));
    expect(await some).toEqual([{ id: 1 }]);
  });

  it('grants, changes and revokes with a reason; a refusal carries the engine reason', async () => {
    const body = {
      tenantId: 7001,
      feedId: 'cme-l2',
      display: true,
      nonDisplay: false,
      validFromUtc: null,
      validToUtc: null,
      reason: 'order form',
    };
    const granted = firstValueFrom(api.grant(body));
    const post = ctl.expectOne(`${BASE}/admin/md/entitlements`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(body);
    post.flush({
      status: false,
      responseCode: '-11',
      message: "The plan of 'tenant-a' (trial) does not include the 'cme-l2' feed.",
      data: null,
    });
    await expect(granted).rejects.toBeInstanceOf(ApiError);

    const updated = firstValueFrom(
      api.update(4, {
        display: true,
        nonDisplay: true,
        validFromUtc: null,
        validToUtc: null,
        reason: 'x',
      }),
    );
    const put = ctl.expectOne(`${BASE}/admin/md/entitlements/4`);
    expect(put.request.method).toBe('PUT');
    put.flush(ok({ id: 4 }));
    await updated;

    const revoked = firstValueFrom(api.revoke(4, 'contract ended'));
    const del = ctl.expectOne(`${BASE}/admin/md/entitlements/4?reason=contract+ended`);
    expect(del.request.method).toBe('DELETE');
    del.flush(ok({ id: 4, status: 'Revoked' }));
    expect((await revoked).status).toBe('Revoked');
  });

  it('reads the feed catalog and the monthly report, and downloads the CSV with its file name', async () => {
    const feeds = firstValueFrom(api.feeds());
    ctl
      .expectOne(`${BASE}/admin/md/feeds`)
      .flush(ok({ feeds: [], defaultFeeds: ['broker-ticks'], houseAllFeeds: true }));
    expect((await feeds).houseAllFeeds).toBe(true);

    const report = firstValueFrom(api.usage('2026-10'));
    ctl
      .expectOne(`${BASE}/admin/md/usage?month=2026-10`)
      .flush(ok({ month: '2026-10', feeds: [], tenants: [], partial: true }));
    expect((await report).partial).toBe(true);

    const file = firstValueFrom(api.exportUsage('2026-09', 'users'));
    const req = ctl.expectOne((r) => r.url === `${BASE}/admin/md/usage/export`);
    expect(req.request.params.get('month')).toBe('2026-09');
    expect(req.request.params.get('detail')).toBe('users');
    expect(req.request.withCredentials).toBe(true);
    req.flush(new Blob(['month,feed_id\r\n']), {
      headers: new HttpHeaders({
        'Content-Disposition': 'attachment; filename=lascodia-marketdata-usage-2026-09-users.csv',
      }),
    });
    expect((await file).fileName).toBe('lascodia-marketdata-usage-2026-09-users.csv');
  });
});
