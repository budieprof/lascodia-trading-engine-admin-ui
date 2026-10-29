import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { Permission as P } from '@core/auth/permissions.generated';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { ThemeService } from '@core/theme/theme.service';
import { OnboardingApiService } from './onboarding-api.service';
import { OnboardingLandingService } from './onboarding-landing.service';
import type { TenantOnboarding, TenantSignup } from './onboarding.types';
import { OnboardingPageComponent } from './pages/onboarding-page.component';
import { PlatformSignupsPageComponent } from './pages/platform-signups-page.component';
import { SignupPageComponent } from './pages/signup-page.component';

ensureTestBed();

const BASE = 'http://engine.test/api/v1/lascodia-trading-engine';

afterEach(() => TestBed.resetTestingModule());

const checklist: TenantOnboarding = {
  tenantId: 9001,
  name: 'Acme',
  createdAtUtc: '2026-10-20T09:00:00Z',
  selfServe: true,
  items: [
    {
      key: 'connect-terminal',
      title: 'Connect a terminal',
      description: 'd',
      done: false,
      detail: null,
      route: '/organisation/terminals',
      permission: P.AccountsConnect,
    },
    {
      key: 'invite-people',
      title: 'Invite people',
      description: 'd',
      done: true,
      detail: '2 people',
      route: '/iam/invitations',
      permission: P.IamInvitationsManage,
    },
  ],
  completed: 1,
  total: 2,
  landOnSignIn: true,
};

const pending: TenantSignup = {
  id: 3,
  email: 'alice@acme.example',
  displayName: 'Alice',
  organisationName: 'Acme',
  organisationSlug: 'acme',
  status: 'Pending',
  requiresApproval: true,
  requestedAtUtc: '2026-10-20T09:00:00Z',
  requestIp: '203.0.113.7',
  expiresAtUtc: '2026-11-03T09:00:00Z',
  expired: false,
  emailVerifiedAtUtc: '2026-10-20T10:00:00Z',
  verificationEmailsSent: 1,
  approvedAtUtc: null,
  rejectedAtUtc: null,
  decisionNote: null,
  tenantId: null,
  provisionedAtUtc: null,
};

// ── The API ────────────────────────────────────────────────────────────

describe('OnboardingApiService', () => {
  function api() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    return {
      api: TestBed.inject(OnboardingApiService),
      ctl: TestBed.inject(HttpTestingController),
    };
  }

  it('reads a 404 as "sign-up is not offered"', async () => {
    const { api: svc, ctl } = api();
    const done = firstValueFrom(svc.signupAvailability());
    ctl
      .expectOne(`${BASE}/onboarding/signup`)
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(await done).toBeNull();
    ctl.verify();
  });

  it('sends the sign-up and the staff decisions to their routes', async () => {
    const { api: svc, ctl } = api();
    const sent = firstValueFrom(
      svc.signUp({
        email: 'a@b.co',
        displayName: 'A',
        organisationName: 'Acme',
        organisationSlug: null,
      }),
    );
    ctl.expectOne({ method: 'POST', url: `${BASE}/onboarding/signup` }).flush(
      {
        status: true,
        responseCode: '00',
        message: 'ok',
        data: { message: 'Check your e-mail', requiresApproval: true, linkHours: 24 },
      },
      { status: 202, statusText: 'Accepted' },
    );
    expect((await sent).message).toBe('Check your e-mail');

    const rejected = firstValueFrom(svc.reject(3, 'spam'));
    const r = ctl.expectOne({ method: 'POST', url: `${BASE}/platform/signups/3/reject` });
    expect(r.request.body).toEqual({ note: 'spam' });
    r.flush({
      status: true,
      responseCode: '00',
      message: 'ok',
      data: { ...pending, status: 'Rejected' },
    });
    await rejected;

    const listed = firstValueFrom(svc.signups('Pending'));
    ctl
      .expectOne(`${BASE}/platform/signups?status=Pending`)
      .flush({ status: true, responseCode: '00', message: 'ok', data: [pending] });
    expect(await listed).toHaveLength(1);
    ctl.verify();
  });
});

// ── The public sign-up page ────────────────────────────────────────────

describe('SignupPageComponent', () => {
  function page(api: Partial<Record<keyof OnboardingApiService, unknown>>) {
    TestBed.configureTestingModule({
      providers: [
        { provide: OnboardingApiService, useValue: api },
        { provide: ThemeService, useValue: {} },
      ],
    });
    return TestBed.runInInjectionContext(() => new SignupPageComponent());
  }

  it('asks for access while sign-up is off', () => {
    const p = page({ signupAvailability: () => of(null) });
    expect(p.state()).toBe('request');
    expect(p.reason()).toBe('off');
  });

  it('asks for access while the engine cannot run sign-up', () => {
    const p = page({
      signupAvailability: () => of({ available: false, requiresApproval: true, linkHours: 24 }),
    });
    expect(p.state()).toBe('request');
    expect(p.reason()).toBe('unavailable');
  });

  it('asks for access while the engine cannot be reached', () => {
    const p = page({ signupAvailability: () => throwError(() => new Error('offline')) });
    expect(p.state()).toBe('request');
    expect(p.reason()).toBe('error');
  });

  it('checks the access request before opening the mail app', () => {
    const p = page({ signupAvailability: () => of(null) });
    p.sendRequest();
    expect(p.state()).toBe('request');
    expect(p.reqProblems()).toContain('Enter your name.');
    p.patch('name', 'Ada');
    p.patch('email', 'ada@example.com');
    p.patch('organisation', 'Ada Capital');
    expect(p.reqProblems()).toEqual([]);
  });

  it('checks the form, sends it and shows the e-mail message', () => {
    const signUp = vi.fn(() =>
      of({ message: 'Check your e-mail: …', requiresApproval: true, linkHours: 24 }),
    );
    const p = page({
      signupAvailability: () => of({ available: true, requiresApproval: true, linkHours: 24 }),
      signUp,
    });
    expect(p.state()).toBe('form');
    p.submit();
    expect(signUp).not.toHaveBeenCalled();
    expect(p.shownProblems().length).toBeGreaterThan(0);

    p.email.set('alice@acme.example');
    p.displayName.set('Alice');
    p.organisationName.set('Acme Trading');
    expect(p.suggestedSlug()).toBe('acme-trading');
    p.submit();
    expect(signUp).toHaveBeenCalledWith({
      email: 'alice@acme.example',
      displayName: 'Alice',
      organisationName: 'Acme Trading',
      organisationSlug: null,
    });
    expect(p.state()).toBe('sent');
    expect(p.result()?.message).toContain('Check your e-mail');
  });

  it('shows a refusal in plain words', () => {
    const limited = new HttpErrorResponse({
      status: 429,
      error: { status: false, responseCode: '-429', message: null },
    });
    const p = page({
      signupAvailability: () => of({ available: true, requiresApproval: false, linkHours: 24 }),
      signUp: () => throwError(() => limited),
    });
    p.email.set('alice@acme.example');
    p.displayName.set('Alice');
    p.organisationName.set('Acme');
    p.submit();
    expect(p.state()).toBe('form');
    expect(p.shownProblems()).toContain(
      'Too many sign-ups from here today. Please try again tomorrow.',
    );
  });
});

// ── The checklist and landing on it ────────────────────────────────────

describe('onboarding checklist', () => {
  function providers(
    api: Partial<Record<keyof OnboardingApiService, unknown>>,
    permissions: string[],
    url = '/dashboard',
  ) {
    const held = new Set(permissions);
    const router = {
      navigated: true,
      url,
      navigateByUrl: vi.fn(async () => true),
      events: new Subject(),
    };
    TestBed.configureTestingModule({
      providers: [
        // Context panels on these pages call other engine reads; they go to the testing backend and stay unanswered.
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
        { provide: OnboardingApiService, useValue: api },
        { provide: Router, useValue: router },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: signal(true).asReadonly(),
            hasPermission: (k: string) => held.has(k),
            canSeePath: (u: string) => u === '/iam/invitations',
          },
        },
      ],
    });
    return router;
  }

  it('lists the steps and links only to pages the person may open', () => {
    providers({ onboarding: () => of(checklist) }, [P.TenantUsageRead]);
    const p = TestBed.runInInjectionContext(() => new OnboardingPageComponent());
    expect(p.checklist.value()?.completed).toBe(1);
    expect(p.canOpen(checklist.items[0])).toBe(false);
    expect(p.canOpen(checklist.items[1])).toBe(true);
  });

  it('a new self-served organisation lands on its checklist from the default landing, once', async () => {
    const onboarding = vi.fn(() => of(checklist));
    const router = providers({ onboarding }, [P.TenantUsageRead]);
    const landing = TestBed.inject(OnboardingLandingService);
    expect(await landing.maybeLand()).toBe(true);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/onboarding');
    expect(await landing.maybeLand()).toBe(false);
    expect(onboarding).toHaveBeenCalledTimes(1);
  });

  it('never moves someone who went to a page, nor an organisation that is done', async () => {
    const elsewhere = providers(
      { onboarding: () => of(checklist) },
      [P.TenantUsageRead],
      '/orders',
    );
    expect(await TestBed.inject(OnboardingLandingService).maybeLand()).toBe(false);
    expect(elsewhere.navigateByUrl).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const done = providers({ onboarding: () => of({ ...checklist, landOnSignIn: false }) }, [
      P.TenantUsageRead,
    ]);
    expect(await TestBed.inject(OnboardingLandingService).maybeLand()).toBe(false);
    expect(done.navigateByUrl).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const noKey = providers({ onboarding: vi.fn() }, []);
    expect(await TestBed.inject(OnboardingLandingService).maybeLand()).toBe(false);
    expect(noKey.navigateByUrl).not.toHaveBeenCalled();
  });
});

// ── Platform: the approval queue ───────────────────────────────────────

describe('PlatformSignupsPageComponent', () => {
  function page(api: Partial<Record<keyof OnboardingApiService, unknown>>) {
    const notify = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        // Context panels on these pages call other engine reads; they go to the testing backend and stay unanswered.
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
        { provide: OnboardingApiService, useValue: api },
        { provide: NotificationService, useValue: notify },
      ],
    });
    return { p: TestBed.runInInjectionContext(() => new PlatformSignupsPageComponent()), notify };
  }

  const status = {
    enabled: true,
    available: false,
    requiresApproval: true,
    linkHours: 24,
    reasons: ['no SMTP'],
    pending: 1,
  };

  it('shows whether sign-up can run and why not', () => {
    const { p } = page({ signups: () => of([pending]), signupStatus: () => of(status) });
    expect(p.status.value()?.reasons).toEqual(['no SMTP']);
    expect(p.signups.value()).toHaveLength(1);
  });

  it('approves with an optional note, and turning down needs a reason', () => {
    const approve = vi.fn(() => of({ ...pending, status: 'Provisioned' as const, tenantId: 9 }));
    const reject = vi.fn(() => of({ ...pending, status: 'Rejected' as const }));
    const { p, notify } = page({
      signups: () => of([pending]),
      signupStatus: () => of(status),
      approve,
      reject,
    });

    p.open(pending, 'approve');
    p.confirm();
    expect(approve).toHaveBeenCalledWith(3, null);
    expect(notify.success).toHaveBeenCalledWith('Organisation created');

    p.open(pending, 'reject');
    p.note.set('Spam');
    p.confirm();
    expect(reject).toHaveBeenCalledWith(3, 'Spam');
  });
});
