import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { BrowserLocation } from '@core/browser/browser-location';
import { NotificationService } from '@core/notifications/notification.service';
import { retryInterceptor } from '@core/api/retry.interceptor';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { bffSession } from '@core/testing/bff-fixtures';
import { AuthService } from './auth.service';
import { csrfInterceptor } from './csrf.interceptor';
import { errorInterceptor } from './error.interceptor';
import {
  EXPECTED_TENANT_HEADER,
  TENANT_CHANGED_CODE,
  expectedTenantInterceptor,
  isSameOriginEngineApi,
} from './expected-tenant.interceptor';
import { IdleTimeoutService } from './idle-timeout.service';
import {
  SessionSyncService,
  TENANT_CHANGED_NOTICE,
  TENANT_CHANGED_RELOAD_DELAY_MS,
} from './session-sync.service';

ensureTestBed();

const API_PATH = '/api/v1/lascodia-trading-engine';
let configured = false;

function setup(apiBaseUrl = '') {
  configured = true;
  const browser = { assign: vi.fn(), reload: vi.fn(), currentPath: () => '/orders' };
  const notify = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      // The production order (app.config.ts): error wraps expected-tenant wraps retry.
      provideHttpClient(
        withInterceptors([csrfInterceptor, errorInterceptor, expectedTenantInterceptor, retryInterceptor]),
      ),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl, featureFlags: { bffAuth: true } } },
      {
        provide: Router,
        useValue: { url: '/orders', navigate: vi.fn(() => Promise.resolve(true)), events: new Subject() },
      },
      { provide: BrowserLocation, useValue: browser },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    ctl: TestBed.inject(HttpTestingController),
    auth: TestBed.inject(AuthService),
    sync: TestBed.inject(SessionSyncService),
    browser,
    notify,
  };
}

async function signIn(t: ReturnType<typeof setup>, base = '') {
  const init = t.auth.initialize();
  t.ctl.expectOne(`${base}/bff/session`).flush(bffSession());
  await init;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  if (!configured) return;
  configured = false;
  TestBed.inject(IdleTimeoutService).stop();
  TestBed.inject(HttpTestingController).verify();
  TestBed.resetTestingModule();
});

describe('isSameOriginEngineApi', () => {
  const origin = 'https://app.test';
  it('accepts same-origin /api/ calls only, never /bff/* or another origin', () => {
    expect(isSameOriginEngineApi('/api/v1/x', '', origin)).toBe(true);
    expect(isSameOriginEngineApi('https://app.test/api/v1/x', '', origin)).toBe(true);
    expect(isSameOriginEngineApi('https://app.test/api/v1/x', 'https://app.test', origin)).toBe(true);
    expect(isSameOriginEngineApi('/bff/session', '', origin)).toBe(false);
    expect(isSameOriginEngineApi('/config.json', '', origin)).toBe(false);
    expect(isSameOriginEngineApi('http://localhost:5081/api/v1/x', 'http://localhost:5081', origin)).toBe(false);
    expect(isSameOriginEngineApi('https://evil.test/api/v1/x', '', origin)).toBe(false);
    expect(isSameOriginEngineApi('/api/v1/x', '', undefined)).toBe(false);
  });
});

describe('expected-tenant interceptor (review A3)', () => {
  it('sends the active organisation on every same-origin engine API call', async () => {
    const t = setup();
    await signIn(t);

    t.http.post(`${API_PATH}/order`, { a: 1 }).subscribe();
    t.http.get(`${API_PATH}/order/1`).subscribe();
    for (const r of [t.ctl.expectOne(`${API_PATH}/order`), t.ctl.expectOne(`${API_PATH}/order/1`)]) {
      expect(r.request.headers.get(EXPECTED_TENANT_HEADER)).toBe('3');
      r.flush({ status: true, data: null });
    }
  });

  it('leaves /bff/* session calls alone', async () => {
    const t = setup();
    await signIn(t);
    t.http.post('/bff/ws-ticket', {}).subscribe();
    const r = t.ctl.expectOne('/bff/ws-ticket');
    expect(r.request.headers.has(EXPECTED_TENANT_HEADER)).toBe(false);
    r.flush({ ticket: 'x' });
  });

  it('sends nothing before a tenant is known, and nothing cross-origin', async () => {
    const t = setup('http://engine.test');
    t.http.get(`http://engine.test${API_PATH}/x`).subscribe();
    const before = t.ctl.expectOne(`http://engine.test${API_PATH}/x`);
    expect(before.request.headers.has(EXPECTED_TENANT_HEADER)).toBe(false);
    before.flush({ status: true });

    await signIn(t, 'http://engine.test');
    t.http.get(`http://engine.test${API_PATH}/y`).subscribe();
    const after = t.ctl.expectOne(`http://engine.test${API_PATH}/y`);
    expect(after.request.headers.has(EXPECTED_TENANT_HEADER)).toBe(false);
    after.flush({ status: true });
  });

  it('on 409 -409-tenant-changed: one notice, no error toast, then a reload', async () => {
    const t = setup();
    await signIn(t);
    vi.useFakeTimers();
    const errors: unknown[] = [];
    t.http.post(`${API_PATH}/order`, {}).subscribe({ error: (e) => errors.push(e) });
    t.http.post(`${API_PATH}/order/2`, {}).subscribe({ error: (e) => errors.push(e) });
    const body = { status: false, responseCode: TENANT_CHANGED_CODE, message: 'changed', data: null };
    t.ctl.expectOne(`${API_PATH}/order`).flush(body, { status: 409, statusText: 'Conflict' });
    t.ctl.expectOne(`${API_PATH}/order/2`).flush(body, { status: 409, statusText: 'Conflict' });

    expect(errors).toHaveLength(2);
    expect(t.notify.warning).toHaveBeenCalledTimes(1);
    expect(t.notify.warning).toHaveBeenCalledWith(TENANT_CHANGED_NOTICE);
    expect(t.notify.error).not.toHaveBeenCalled();
    expect(t.browser.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TENANT_CHANGED_RELOAD_DELAY_MS);
    expect(t.browser.reload).toHaveBeenCalledTimes(1);
  });

  it('an ordinary 409 is still an ordinary error', async () => {
    const t = setup();
    await signIn(t);
    t.http.post(`${API_PATH}/order`, {}).subscribe({ error: () => undefined });
    t.ctl
      .expectOne(`${API_PATH}/order`)
      .flush({ status: false, responseCode: '-409', message: 'Duplicate.' }, { status: 409, statusText: 'Conflict' });
    expect(t.notify.warning).not.toHaveBeenCalled();
    expect(t.notify.error).toHaveBeenCalledWith('Duplicate.');
  });
});

describe('retry sits inside the error interceptor (review A7)', () => {
  it('a GET retried on 503 toasts once, after the last attempt', async () => {
    const t = setup();
    await signIn(t);
    vi.useFakeTimers();
    t.http.get(`${API_PATH}/x`).subscribe({ error: () => undefined });
    t.ctl.expectOne(`${API_PATH}/x`).flush(null, { status: 503, statusText: 'Unavailable' });
    expect(t.notify.error).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    t.ctl.expectOne(`${API_PATH}/x`).flush(null, { status: 503, statusText: 'Unavailable' });
    expect(t.notify.error).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    const last = t.ctl.expectOne(`${API_PATH}/x`);
    expect(last.request.headers.get(EXPECTED_TENANT_HEADER)).toBe('3');
    last.flush(null, { status: 503, statusText: 'Unavailable' });
    expect(t.notify.error).toHaveBeenCalledTimes(1);
  });
});

describe('SessionSyncService (cross-tab)', () => {
  it('reloads when another tab switched to a different organisation, not to the same one', async () => {
    const t = setup();
    await signIn(t);
    vi.useFakeTimers();
    t.sync.receive({ type: 'tenant-switched', tenantId: 3, userId: 12 });
    vi.advanceTimersByTime(TENANT_CHANGED_RELOAD_DELAY_MS);
    expect(t.browser.reload).not.toHaveBeenCalled();

    t.sync.receive({ type: 'tenant-switched', tenantId: 1, userId: 12 });
    expect(t.notify.warning).toHaveBeenCalledWith(TENANT_CHANGED_NOTICE);
    vi.advanceTimersByTime(TENANT_CHANGED_RELOAD_DELAY_MS);
    expect(t.browser.reload).toHaveBeenCalledTimes(1);
  });

  it('goes to the sign-in page when another tab signed out', async () => {
    const t = setup();
    await signIn(t);
    t.sync.receive({ type: 'signed-out' });
    expect(t.browser.assign).toHaveBeenCalledWith('/login');
    expect(t.auth.isAuthenticated()).toBe(false);
  });

  it('ignores junk and messages on a signed-out tab', () => {
    const t = setup();
    t.sync.receive(null);
    t.sync.receive({ type: 'tenant-switched', tenantId: 9 });
    t.sync.receive({ type: 'signed-out' });
    expect(t.browser.assign).not.toHaveBeenCalled();
    expect(t.browser.reload).not.toHaveBeenCalled();
  });

  it('switching organisation tells the other tabs', async () => {
    const t = setup();
    await signIn(t);
    const announce = vi.spyOn(t.sync, 'announceTenantSwitch');
    const done = t.auth.switchTenant(1);
    t.ctl
      .expectOne('/bff/switch-tenant')
      .flush(bffSession({ activeTenant: { id: 1, slug: 'house', name: 'House', kind: 'House' } }));
    await expect(done).resolves.toBe('switched');
    expect(announce).toHaveBeenCalledWith(1, 12);
  });
});
