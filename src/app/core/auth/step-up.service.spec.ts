import { TestBed } from '@angular/core/testing';
import { HttpHeaders, HttpRequest, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { BrowserLocation } from '@core/browser/browser-location';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { bffSession } from '@core/testing/bff-fixtures';
import { AuthService } from './auth.service';
import { STEP_UP_REPLAY } from './http-context';
import { IdleTimeoutService } from './idle-timeout.service';
import {
  STEP_UP_PENDING_KEY,
  STEP_UP_PENDING_TTL_MS,
  StepUpService,
  describe as describeRequest,
  mfaIsFresh,
  pendingFor,
  type PendingStepUp,
} from './step-up.service';

ensureTestBed();

const API = 'http://engine.test';
const ENGINE = `${API}/api/v1/lascodia-trading-engine`;

describe('pendingFor', () => {
  it('keeps method, URL, JSON body and non-credential headers', () => {
    const req = new HttpRequest('POST', `${ENGINE}/iam/grants`, { roleId: 3 }, {
      headers: new HttpHeaders({
        'X-CSRF-Token': 'secret',
        Authorization: 'Bearer x',
        'X-Lascodia-Actor': 'console',
      }),
    });
    const p = pendingFor(req, '/iam/grants', 1000)!;
    expect(p).toEqual({
      method: 'POST',
      url: `${ENGINE}/iam/grants`,
      body: '{"roleId":3}',
      headers: { 'X-Lascodia-Actor': 'console' },
      route: '/iam/grants',
      label: 'POST iam/grants',
      createdAt: 1000,
    });
  });

  it('refuses bodies it cannot replay faithfully', () => {
    const form = new FormData();
    form.append('f', 'x');
    expect(pendingFor(new HttpRequest('POST', `${ENGINE}/x`, form), '/')).toBeNull();
    expect(pendingFor(new HttpRequest('POST', `${ENGINE}/x`, new Blob(['x'])), '/')).toBeNull();
  });

  it('describes requests plainly', () => {
    expect(describeRequest('delete', '/api/v1/lascodia-trading-engine/iam/grants/4?x=1')).toBe(
      'DELETE iam/grants/4',
    );
    expect(describeRequest('POST', 'https://app.test/bff/switch-tenant')).toBe('POST bff/switch-tenant');
  });
});

describe('mfaIsFresh', () => {
  it('needs a second factor within the last 300 s', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(mfaIsFresh({ satisfied: true, authTimeUtc: '2026-10-20T09:56:00Z' }, now)).toBe(true);
    expect(mfaIsFresh({ satisfied: true, authTimeUtc: '2026-10-20T09:54:59Z' }, now)).toBe(false);
    expect(mfaIsFresh({ satisfied: false, authTimeUtc: '2026-10-20T09:59:00Z' }, now)).toBe(false);
    expect(mfaIsFresh({ satisfied: true, authTimeUtc: 'garbage' }, now)).toBe(false);
    expect(mfaIsFresh(null, now)).toBe(false);
  });
});

describe('StepUpService', () => {
  let configured = false;

  async function setup(mfaAgoMs: number) {
    configured = true;
    const notify = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() };
    const browser = { assign: vi.fn(), currentPath: () => '/iam/security' };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: API, featureFlags: { bffAuth: true } } },
        { provide: Router, useValue: { url: '/iam/security', navigate: vi.fn(), events: new Subject() } },
        { provide: BrowserLocation, useValue: browser },
        { provide: NotificationService, useValue: notify },
      ],
    });
    const auth = TestBed.inject(AuthService);
    const ctl = TestBed.inject(HttpTestingController);
    const init = auth.initialize();
    ctl.expectOne(`${API}/bff/session`).flush(
      bffSession({ mfa: { satisfied: true, authTimeUtc: new Date(Date.now() - mfaAgoMs).toISOString() } }),
    );
    await init;
    return { stepUp: TestBed.inject(StepUpService), ctl, notify, browser };
  }

  function stash(over: Partial<PendingStepUp> = {}) {
    const record: PendingStepUp = {
      method: 'PUT',
      url: `${ENGINE}/iam/security-policy`,
      body: '{"mfaRequired":true}',
      headers: { 'X-Lascodia-Actor': 'console' },
      route: '/iam/security',
      label: 'PUT iam/security-policy',
      createdAt: Date.now() - 30_000,
      ...over,
    };
    sessionStorage.setItem(STEP_UP_PENDING_KEY, JSON.stringify(record));
    return record;
  }

  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    if (!configured) return;
    configured = false;
    TestBed.inject(IdleTimeoutService).stop();
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('offers the refused action after a fresh second factor, and replays it on one click', async () => {
    const { stepUp, ctl, notify } = await setup(20_000);
    const record = stash();
    stepUp.restore();
    expect(stepUp.pending()).toEqual(record);

    const done = stepUp.retry();
    const req = ctl.expectOne(`${ENGINE}/iam/security-policy`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ mfaRequired: true });
    expect(req.request.headers.get('X-Lascodia-Actor')).toBe('console');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.context.get(STEP_UP_REPLAY)).toBe(true);
    req.flush({ status: true });
    await expect(done).resolves.toBe(true);
    expect(notify.success).toHaveBeenCalled();
    expect(stepUp.pending()).toBeNull();
    expect(sessionStorage.getItem(STEP_UP_PENDING_KEY)).toBeNull();
  });

  it('reports a step-up that came back without a fresh second factor, and replays nothing', async () => {
    const { stepUp } = await setup(30 * 60_000);
    stash();
    stepUp.restore();
    expect(stepUp.pending()).toBeNull();
    expect(stepUp.failed()?.label).toBe('PUT iam/security-policy');
    expect(sessionStorage.getItem(STEP_UP_PENDING_KEY)).toBeNull();
  });

  it('drops a stale record, and one aimed anywhere but the engine', async () => {
    const { stepUp } = await setup(10_000);
    stash({ createdAt: Date.now() - STEP_UP_PENDING_TTL_MS - 1 });
    stepUp.restore();
    expect(stepUp.pending()).toBeNull();
    expect(stepUp.failed()).toBeNull();

    stash({ url: 'https://evil.test/steal' });
    stepUp.restore();
    expect(stepUp.pending()).toBeNull();
    expect(sessionStorage.getItem(STEP_UP_PENDING_KEY)).toBeNull();
  });

  it('a replay that is challenged again does not loop', async () => {
    const { stepUp, notify, browser } = await setup(10_000);
    const req = new HttpRequest('PUT', `${ENGINE}/iam/sso`, {}).clone({
      context: new HttpRequest('GET', '/').context.set(STEP_UP_REPLAY, true),
    });
    stepUp.challenge(req);
    expect(browser.assign).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalled();
  });

  it('"Confirm with MFA" starts a step-up for the current page without a pending action', async () => {
    const { stepUp, browser } = await setup(10 * 60_000);
    expect(stepUp.isFresh()).toBe(false);
    stepUp.confirmWithMfa();
    expect(browser.assign).toHaveBeenCalledWith(`${API}/bff/login?returnUrl=%2Fiam%2Fsecurity&acr=mfa`);
    expect(sessionStorage.getItem(STEP_UP_PENDING_KEY)).toBeNull();
  });
});
