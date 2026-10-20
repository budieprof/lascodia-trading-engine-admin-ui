import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CONFIG, type RuntimeConfig } from '@core/config/runtime-config';
import { BrowserLocation } from '@core/browser/browser-location';
import { appStorage } from '@core/storage/app-storage';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { bffSession as session } from '@core/testing/bff-fixtures';
import { AuthService, SIGNED_OUT_NOTE_KEY, isStepUpError } from './auth.service';
import { authModeFrom } from './auth-mode';
import { IdleTimeoutService } from './idle-timeout.service';

ensureTestBed();

const API = 'http://engine.test';

/** An unsigned JWT with the given claims (the console never validates signatures). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
}

const ROLE = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';

function setup(bffAuth: boolean, routerUrl = '/orders') {
  const router = {
    url: routerUrl,
    navigate: vi.fn(() => Promise.resolve(true)),
    events: new Subject(),
  };
  const browser = { assign: vi.fn(), currentPath: () => routerUrl };
  const config: RuntimeConfig = { apiBaseUrl: API, featureFlags: { bffAuth } };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: config },
      { provide: Router, useValue: router },
      { provide: BrowserLocation, useValue: browser },
    ],
  });
  const auth = TestBed.inject(AuthService);
  const http = TestBed.inject(HttpTestingController);
  return { auth, http, router, browser };
}

describe('authModeFrom (the bffAuth flag)', () => {
  it('is on only for an explicit true or { enabled: true }', () => {
    expect(authModeFrom({ featureFlags: { bffAuth: true } })).toBe('bff');
    expect(authModeFrom({ featureFlags: { bffAuth: { enabled: true, roles: ['x'] } } })).toBe('bff');
    expect(authModeFrom({ featureFlags: { bffAuth: false } })).toBe('legacy');
    expect(authModeFrom({ featureFlags: { bffAuth: 'true' } })).toBe('legacy');
    expect(authModeFrom({ featureFlags: {} })).toBe('legacy');
    expect(authModeFrom({})).toBe('legacy');
  });
});

describe('AuthService — legacy sign-in (bffAuth off)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('gives a role-only trading-account token the bundles of its roles', () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ tradingAccountId: '17', [ROLE]: ['Trader'] }));
    const { auth } = setup(false);
    expect(auth.mode).toBe('legacy');
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.hasPermission('orders.create')).toBe(true);
    expect(auth.hasPermission('orders.read')).toBe(true);
    expect(auth.hasPermission('users.manage')).toBe(false);
    expect(auth.hasPermission('access.operator')).toBe(false);
    expect(appStorage.namespace).toBe('lascodia.acct17.t1.');
  });

  it('gives a token without roles or permissions nothing (no "roleless = full access")', () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ sub: 'dev-user-1' }));
    const { auth } = setup(false);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.permissions()).toEqual([]);
    expect(auth.hasPermission('orders.read')).toBe(false);
    expect(auth.canSeePath('/orders')).toBe(false);
    // Personal pages stay open to anyone signed in.
    expect(auth.canSeePath('/account/profile')).toBe(true);
  });

  it('uses the permissions the engine reported for an admin user', () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ adminUserId: '7', [ROLE]: ['Admin'] }));
    sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(['orders.read', 'audit.read']));
    const { auth, http } = setup(false);
    http.expectOne(`${API}/api/v1/lascodia-trading-engine/admin/auth/me`).flush({
      status: true,
      data: { id: 7, username: 'ops', displayName: 'Ops', email: '', isSuperAdmin: false, mustChangePassword: false, roles: ['Admin'], permissions: ['orders.read', 'audit.read'] },
    });
    expect(auth.hasPermission('audit.read')).toBe(true);
    // The Admin ROLE claim does not grant anything the engine did not report.
    expect(auth.hasPermission('users.manage')).toBe(false);
    expect(appStorage.namespace).toBe('lascodia.u7.t1.');
  });

  it('loads a restored admin token’s permissions before the first route (initialize)', async () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ adminUserId: '7' }));
    const { auth, http } = setup(false);
    expect(auth.hasPermission('users.manage')).toBe(false);
    const done = auth.initialize();
    http.expectOne(`${API}/api/v1/lascodia-trading-engine/admin/auth/me`).flush({
      status: true,
      data: { id: 7, username: 'root', displayName: 'Root', email: '', isSuperAdmin: true, mustChangePassword: false, roles: [], permissions: [] },
    });
    await done;
    // A super admin holds everything, as the engine treats them.
    expect(auth.hasPermission('users.manage')).toBe(true);
  });

  it('keeps legacy token handling: bearer token readable, no CSRF header, no BFF calls', () => {
    const token = jwt({ adminUserId: '7' });
    sessionStorage.setItem('lascodia.auth.token', token);
    sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(['orders.read']));
    const { auth, http } = setup(false);
    http.expectOne(`${API}/api/v1/lascodia-trading-engine/admin/auth/me`).flush({ status: false, data: null });
    expect(auth.getToken()).toBe(token);
    expect(auth.csrfHeaders()).toEqual({});
    expect(auth.session()).toBeNull();
  });

  it('signs out locally and routes to /login', () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ tradingAccountId: '17', [ROLE]: ['Viewer'] }));
    const { auth, http, router } = setup(false);
    auth.logout();
    http.expectOne(`${API}/api/v1/lascodia-trading-engine/auth/logout`).flush({});
    expect(auth.isAuthenticated()).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: {} });
    expect(appStorage.namespace).toBeNull();
  });
});

describe('AuthService — BFF sign-in (bffAuth on)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    TestBed.inject(IdleTimeoutService).stop();
    TestBed.inject(HttpTestingController).verify();
  });

  it('settles the session before the first route and exposes it', async () => {
    sessionStorage.setItem('lascodia.auth.token', jwt({ adminUserId: '7' })); // legacy leftover
    const { auth, http } = setup(true);
    expect(sessionStorage.getItem('lascodia.auth.token')).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);

    const done = auth.initialize();
    const req = http.expectOne(`${API}/bff/session`);
    expect(req.request.withCredentials).toBe(true);
    req.flush(session());
    await done;

    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getToken()).toBeNull(); // the browser never holds a token
    expect(auth.user()?.firstName).toBe('Ada Lovelace');
    expect(auth.activeTenant()?.slug).toBe('acme');
    expect(auth.hasPermission('iam.members.read')).toBe(true);
    expect(auth.hasPermission('users.manage')).toBe(false);
    expect(auth.roles()).toEqual([]);
    expect(auth.csrfHeaders()).toEqual({ 'X-CSRF-Token': 'csrf-1' });
    expect(appStorage.namespace).toBe('lascodia.u12.t3.');
    expect(TestBed.inject(IdleTimeoutService).running).toBe(true);
  });

  it('treats 401 as signed out, and an unreachable engine as such', async () => {
    const { auth, http } = setup(true);
    let done = auth.initialize();
    http.expectOne(`${API}/bff/session`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await done;
    expect(auth.isAuthenticated()).toBe(false);
    expect(appStorage.namespace).toBeNull();

    done = auth.initialize();
    http.expectOne(`${API}/bff/session`).error(new ProgressEvent('error'));
    await done;
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('refuses a malformed session payload (fail closed)', async () => {
    const { auth, http } = setup(true);
    const done = auth.initialize();
    http.expectOne(`${API}/bff/session`).flush({ user: { id: 'x' } });
    await done;
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('starts sign-in at /bff/login with a sanitised return path', () => {
    const { auth, browser } = setup(true);
    auth.beginSignIn('/strategies/12?tab=live');
    expect(browser.assign).toHaveBeenLastCalledWith(
      `${API}/bff/login?returnUrl=%2Fstrategies%2F12%3Ftab%3Dlive`,
    );
    auth.beginSignIn('https://evil.example/x');
    expect(browser.assign).toHaveBeenLastCalledWith(`${API}/bff/login?returnUrl=%2Fdashboard`);
  });

  it('signs out through /bff/logout and follows the returned URL', async () => {
    const { auth, http, browser } = setup(true);
    const init = auth.initialize();
    http.expectOne(`${API}/bff/session`).flush(session());
    await init;

    auth.logout({ reason: 'idle' });
    const req = http.expectOne(`${API}/bff/logout`);
    expect(req.request.method).toBe('POST');
    req.flush({ logoutUrl: 'https://idp.example/end?x=1' });
    await vi.waitFor(() => expect(browser.assign).toHaveBeenCalledWith('https://idp.example/end?x=1'));
    expect(auth.isAuthenticated()).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(SIGNED_OUT_NOTE_KEY)!)).toEqual({
      reason: 'idle',
      returnUrl: '/orders',
    });
    expect(auth.takeSignedOutNote()).toEqual({ reason: 'idle', returnUrl: '/orders' });
    expect(sessionStorage.getItem(SIGNED_OUT_NOTE_KEY)).toBeNull();
  });

  it('a session that ended goes to /login with the route to come back to', async () => {
    const { auth, http, router } = setup(true, '/iam/members');
    const init = auth.initialize();
    http.expectOne(`${API}/bff/session`).flush(session());
    await init;
    auth.sessionEnded();
    auth.sessionEnded(); // a burst of 401s navigates once
    expect(auth.isAuthenticated()).toBe(false);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/iam/members', reason: 'expired' },
    });
  });
});

describe('isStepUpError', () => {
  it('recognises the C3.2 challenge by envelope code or WWW-Authenticate', () => {
    expect(isStepUpError({ status: 401, error: { responseCode: '-401-stepup' } })).toBe(true);
    expect(
      isStepUpError({
        status: 401,
        error: null,
        headers: { get: () => 'Bearer error="insufficient_user_authentication", acr_values="mfa"' },
      }),
    ).toBe(true);
    expect(isStepUpError({ status: 401, error: { responseCode: '-401' } })).toBe(false);
    expect(isStepUpError({ status: 403, error: { responseCode: '-401-stepup' } })).toBe(false);
    expect(isStepUpError(null)).toBe(false);
  });
});
