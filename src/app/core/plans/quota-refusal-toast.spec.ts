import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { BrowserLocation } from '@core/browser/browser-location';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { bffSession } from '@core/testing/bff-fixtures';
import { approvalInterceptor } from '@core/auth/approval.interceptor';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { AuthService } from '@core/auth/auth.service';
import { csrfInterceptor } from '@core/auth/csrf.interceptor';
import { errorInterceptor } from '@core/auth/error.interceptor';
import { IdleTimeoutService } from '@core/auth/idle-timeout.service';
import { QUOTA_RESPONSE_CODE } from './quota-refusal';

ensureTestBed();

const API = 'http://engine.test';
const ENGINE = `${API}/api/v1/lascodia-trading-engine`;

const quotaBody = {
  status: false,
  message: 'engine sentence',
  responseCode: QUOTA_RESPONSE_CODE,
  data: {
    quota: 'tradingAccounts',
    limit: 2,
    used: 2,
    requested: 1,
    plan: 'Trial',
    planSlug: 'trial',
  },
};
const QUOTA_TEXT =
  "Your organisation's plan (Trial) allows 2 trading accounts; 2 are in use. Free one up, or ask platform staff for a larger plan.";

let configured = false;

function setup(bffAuth: boolean) {
  configured = true;
  const notify = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([authInterceptor, csrfInterceptor, errorInterceptor, approvalInterceptor]),
      ),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: API, featureFlags: { bffAuth } } },
      {
        provide: Router,
        useValue: {
          url: '/trading-accounts',
          navigate: vi.fn(() => Promise.resolve(true)),
          events: new Subject(),
        },
      },
      {
        provide: BrowserLocation,
        useValue: { assign: vi.fn(), currentPath: () => '/trading-accounts' },
      },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    ctl: TestBed.inject(HttpTestingController),
    auth: TestBed.inject(AuthService),
    notify,
  };
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

describe('a plan quota refusal (-403-quota) is explained, not called a permission problem', () => {
  it('with console sessions (bffAuth on)', async () => {
    const t = setup(true);
    const init = t.auth.initialize();
    t.ctl.expectOne(`${API}/bff/session`).flush(bffSession({ csrfToken: 'c' }));
    await init;

    t.http.post(`${ENGINE}/trading-account`, {}).subscribe({ error: () => undefined });
    t.ctl
      .expectOne(`${ENGINE}/trading-account`)
      .flush(quotaBody, { status: 403, statusText: 'Forbidden' });
    expect(t.notify.error).toHaveBeenCalledWith(QUOTA_TEXT);

    // An ordinary refusal keeps the engine's reason.
    t.notify.error.mockClear();
    t.http.post(`${ENGINE}/order`, {}).subscribe({ error: () => undefined });
    t.ctl
      .expectOne(`${ENGINE}/order`)
      .flush(
        { status: false, message: 'You need orders.create.', responseCode: '-403' },
        { status: 403, statusText: 'Forbidden' },
      );
    expect(t.notify.error).toHaveBeenCalledWith('You need orders.create.');
  });

  it('with the legacy sign-in (bffAuth off)', () => {
    sessionStorage.setItem('lascodia.auth.token', 'aaa.bbb.ccc');
    const t = setup(false);

    t.http.post(`${ENGINE}/trading-account`, {}).subscribe({ error: () => undefined });
    t.ctl
      .expectOne(`${ENGINE}/trading-account`)
      .flush(quotaBody, { status: 403, statusText: 'Forbidden' });
    expect(t.notify.error).toHaveBeenCalledWith(QUOTA_TEXT);

    t.notify.error.mockClear();
    t.http.post(`${ENGINE}/order`, {}).subscribe({ error: () => undefined });
    t.ctl
      .expectOne(`${ENGINE}/order`)
      .flush(
        { status: false, message: 'x', responseCode: '-403' },
        { status: 403, statusText: 'Forbidden' },
      );
    expect(t.notify.error).toHaveBeenCalledWith(
      'You do not have permission to perform this action.',
    );
  });
});
