import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { BrowserLocation } from '@core/browser/browser-location';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { bffSession } from '@core/testing/bff-fixtures';
import { approvalInterceptor } from './approval.interceptor';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { csrfInterceptor, isEngineUrl } from './csrf.interceptor';
import { errorInterceptor } from './error.interceptor';
import { IdleTimeoutService } from './idle-timeout.service';
import { STEP_UP_PENDING_KEY } from './step-up.service';

ensureTestBed();

const API = 'http://engine.test';
const ENGINE = `${API}/api/v1/lascodia-trading-engine`;

let configured = false;

function setup(bffAuth: boolean, routerUrl = '/iam/grants') {
  configured = true;
  const router = { url: routerUrl, navigate: vi.fn(() => Promise.resolve(true)), events: new Subject() };
  const browser = { assign: vi.fn(), currentPath: () => routerUrl };
  const notify = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([authInterceptor, csrfInterceptor, errorInterceptor, approvalInterceptor]),
      ),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: API, featureFlags: { bffAuth } } },
      { provide: Router, useValue: router },
      { provide: BrowserLocation, useValue: browser },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    ctl: TestBed.inject(HttpTestingController),
    auth: TestBed.inject(AuthService),
    router,
    browser,
    notify,
  };
}

async function signIn(t: ReturnType<typeof setup>, csrf = 'csrf-1') {
  const init = t.auth.initialize();
  t.ctl.expectOne(`${API}/bff/session`).flush(bffSession({ csrfToken: csrf }));
  await init;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  if (!configured) return;
  configured = false;
  TestBed.inject(IdleTimeoutService).stop();
  TestBed.inject(HttpTestingController).verify();
  TestBed.resetTestingModule();
});

describe('isEngineUrl', () => {
  it('accepts the configured base, or same-origin paths in a release', () => {
    expect(isEngineUrl(`${API}/bff/logout`, API)).toBe(true);
    expect(isEngineUrl('https://elsewhere.test/x', API)).toBe(false);
    expect(isEngineUrl('/api/v1/x', '')).toBe(true);
    expect(isEngineUrl('//evil.test/x', '')).toBe(false);
    expect(isEngineUrl('https://app.test/bff/x', '', 'https://app.test')).toBe(true);
    expect(isEngineUrl('https://evil.test/bff/x', '', 'https://app.test')).toBe(false);
  });
});

describe('CSRF interceptor', () => {
  it('adds X-CSRF-Token to unsafe engine requests only, and no bearer token at all', async () => {
    const t = setup(true);
    await signIn(t);

    t.http.post(`${ENGINE}/iam/grants`, { a: 1 }).subscribe();
    const post = t.ctl.expectOne(`${ENGINE}/iam/grants`);
    expect(post.request.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(post.request.headers.has('Authorization')).toBe(false);
    post.flush({ status: true });

    t.http.get(`${ENGINE}/iam/grants`).subscribe();
    const get = t.ctl.expectOne(`${ENGINE}/iam/grants`);
    expect(get.request.headers.has('X-CSRF-Token')).toBe(false);
    get.flush({ status: true });

    t.http.post('https://third-party.test/collect', {}).subscribe();
    const other = t.ctl.expectOne('https://third-party.test/collect');
    expect(other.request.headers.has('X-CSRF-Token')).toBe(false);
    other.flush({});
  });

  it('does nothing with bffAuth off (bearer token as before)', () => {
    sessionStorage.setItem('lascodia.auth.token', 'aaa.bbb.ccc');
    const t = setup(false);
    t.http.post(`${ENGINE}/order`, {}).subscribe();
    const req = t.ctl.expectOne(`${ENGINE}/order`);
    expect(req.request.headers.has('X-CSRF-Token')).toBe(false);
    expect(req.request.headers.get('Authorization')).toBe('Bearer aaa.bbb.ccc');
    req.flush({});
  });
});

describe('error interceptor — BFF', () => {
  it('re-reads the session and retries ONCE when the CSRF token went stale', async () => {
    const t = setup(true);
    await signIn(t, 'old');
    const done = firstValueFrom(t.http.post(`${ENGINE}/iam/teams`, { name: 'x' }));

    t.ctl
      .expectOne(`${ENGINE}/iam/teams`)
      .flush({ status: false, responseCode: '-403-csrf', message: 'stale' }, { status: 403, statusText: 'Forbidden' });
    await vi.waitFor(() => t.ctl.expectOne(`${API}/bff/session`).flush(bffSession({ csrfToken: 'new' })));
    let retry!: ReturnType<HttpTestingController['expectOne']>;
    await vi.waitFor(() => (retry = t.ctl.expectOne(`${ENGINE}/iam/teams`)));
    expect(retry.request.headers.get('X-CSRF-Token')).toBe('new');
    retry.flush({ status: true, data: 1 });
    await expect(done).resolves.toEqual({ status: true, data: 1 });
  });

  it('gives up after the one CSRF retry', async () => {
    const t = setup(true);
    await signIn(t, 'old');
    const done = firstValueFrom(t.http.post(`${ENGINE}/iam/teams`, {}));
    const refuse = { status: false, responseCode: '-403-csrf', message: 'stale' };
    t.ctl.expectOne(`${ENGINE}/iam/teams`).flush(refuse, { status: 403, statusText: 'Forbidden' });
    await vi.waitFor(() => t.ctl.expectOne(`${API}/bff/session`).flush(bffSession({ csrfToken: 'new' })));
    await vi.waitFor(() =>
      t.ctl.expectOne(`${ENGINE}/iam/teams`).flush(refuse, { status: 403, statusText: 'Forbidden' }),
    );
    await expect(done).rejects.toMatchObject({ status: 403 });
    expect(t.notify.error).toHaveBeenCalledWith('stale');
  });

  it('turns a step-up challenge into a step-up sign-in and remembers the action', async () => {
    const t = setup(true, '/iam/security');
    await signIn(t);
    const done = firstValueFrom(
      t.http.put(`${ENGINE}/iam/security-policy`, { mfaRequired: true }, { headers: { 'X-Lascodia-Actor': 'console' } }),
    );
    t.ctl.expectOne(`${ENGINE}/iam/security-policy`).flush(
      { status: false, responseCode: '-401-stepup', message: 'Confirm with MFA' },
      {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'WWW-Authenticate': 'Bearer error="insufficient_user_authentication", acr_values="mfa", max_age="300"' },
      },
    );
    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(t.browser.assign).toHaveBeenCalledWith(
      `${API}/bff/login?returnUrl=%2Fiam%2Fsecurity&acr=mfa`,
    );
    const pending = JSON.parse(sessionStorage.getItem(STEP_UP_PENDING_KEY)!);
    expect(pending).toMatchObject({
      method: 'PUT',
      url: `${ENGINE}/iam/security-policy`,
      body: JSON.stringify({ mfaRequired: true }),
      headers: { 'X-Lascodia-Actor': 'console' },
      label: 'PUT iam/security-policy',
      route: '/iam/security',
    });
    // Credentials are never stored for the replay.
    expect(pending.headers['X-CSRF-Token']).toBeUndefined();
    // The session itself is not torn down by a step-up.
    expect(t.auth.isAuthenticated()).toBe(true);
  });

  it('ends a dead session: back to /login with the route, one toast', async () => {
    const t = setup(true, '/orders');
    await signIn(t);
    const done = firstValueFrom(t.http.get(`${ENGINE}/order/1`));
    t.ctl.expectOne(`${ENGINE}/order/1`).flush({ status: false, responseCode: '-401' }, { status: 401, statusText: 'Unauthorized' });
    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(t.auth.isAuthenticated()).toBe(false);
    expect(t.router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/orders', reason: 'expired' },
    });
    expect(t.notify.error).toHaveBeenCalledTimes(1);
  });

  it('shows the engine’s reason for a 403 (e.g. read-only impersonation)', async () => {
    const t = setup(true);
    await signIn(t);
    const done = firstValueFrom(t.http.delete(`${ENGINE}/iam/teams/4`));
    t.ctl.expectOne(`${ENGINE}/iam/teams/4`).flush(
      { status: false, responseCode: '-403', message: 'You are viewing the console as another user, read-only.' },
      { status: 403, statusText: 'Forbidden' },
    );
    await expect(done).rejects.toMatchObject({ status: 403 });
    expect(t.notify.error).toHaveBeenCalledWith('You are viewing the console as another user, read-only.');
  });
});

describe('approval interceptor', () => {
  it('says a two-person action is waiting for approval', async () => {
    const t = setup(true);
    await signIn(t);
    const done = firstValueFrom(t.http.post(`${ENGINE}/admin/kill-switch/global`, {}));
    t.ctl.expectOne(`${ENGINE}/admin/kill-switch/global`).flush(
      { status: true, responseCode: '-202-approval', data: { approvalId: 41, expiresAtUtc: '2026-10-21T10:00:00Z' } },
      { status: 202, statusText: 'Accepted' },
    );
    await done;
    expect(t.notify.info).toHaveBeenCalledWith(expect.stringContaining('Sent for approval (request #41)'));
  });
});
