import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { Permission as P } from '@core/auth/permissions.generated';
import { canSee, type AccessSubject } from '@core/auth/route-access';
import { TenantBrandingService } from '@core/branding/tenant-branding.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { LifecycleApiService, NAVIGATE_TO } from './lifecycle-api.service';
import type {
  TenantBranding,
  TenantClosure,
  TenantClosureState,
  TenantDataExport,
  TenantPurgePlan,
} from './lifecycle.types';
import { BrandingPageComponent } from './pages/branding-page.component';
import { CloseOrganisationPageComponent } from './pages/close-organisation-page.component';
import { DataExportPageComponent } from './pages/data-export-page.component';
import { PlatformClosuresPageComponent } from './pages/platform-closures-page.component';

ensureTestBed();

const branding: TenantBranding = {
  tenantId: 7001,
  displayName: 'Acme',
  customDisplayName: null,
  primaryColor: null,
  logo: null,
  favicon: null,
  isCustomised: false,
  updatedAtUtc: null,
  updatedBy: null,
};

const ready: TenantDataExport = {
  id: 5,
  status: 'Ready',
  requestedBy: 'admin-user:7',
  requestedAtUtc: '2026-10-20T08:00:00Z',
  startedAtUtc: null,
  completedAtUtc: '2026-10-20T08:02:00Z',
  expiresAtUtc: '2026-10-27T08:02:00Z',
  sizeBytes: 4096,
  sha256: 'abc',
  tableCount: 4,
  rowCount: 40,
  failureReason: null,
  downloadCount: 0,
  lastDownloadedAtUtc: null,
  canDownload: true,
};

const closable: TenantClosureState = {
  tenantId: 7001,
  slug: 'acme',
  name: 'Acme',
  status: 'Active',
  isHouse: false,
  openPositions: 0,
  workingOrders: 0,
  owners: 1,
  needsSecondOwner: false,
  graceDays: 30,
  activeMachineCredentials: 1,
  members: 2,
  canClose: true,
  blockers: [],
};

const plan: TenantPurgePlan = {
  tenantId: 7001,
  slug: 'acme',
  name: 'Acme',
  generatedAtUtc: '2026-11-20T00:00:00Z',
  canRun: true,
  rows: 10,
  steps: [],
  tablesVisited: 140,
  cascades: [],
  blockers: [],
  auditEventsKept: 3,
  people: [],
  identityProviderOrganizationId: null,
  identityProviderEnabled: true,
  notes: [],
};

function closure(over: Partial<TenantClosure> = {}): TenantClosure {
  return {
    id: 1,
    tenantId: 7001,
    slug: 'acme',
    name: 'Acme',
    status: 'Closed',
    reason: 'leaving',
    requestedBy: 'admin-user:7',
    approvedBy: null,
    closedAtUtc: '2026-10-20T09:00:00Z',
    graceEndsAtUtc: '2026-11-19T09:00:00Z',
    effects: { machineCredentialsRevoked: 1 },
    reopenedAtUtc: null,
    reopenedBy: null,
    reopenReason: null,
    plannedAtUtc: null,
    plan: null,
    purgeRequestedAtUtc: null,
    purgeRequestedBy: null,
    purgeStartedAtUtc: null,
    purgeCompletedAtUtc: null,
    purgeReport: null,
    purgeError: null,
    canReopen: true,
    canSchedulePurge: false,
    ...over,
  };
}

function setup(api: Partial<Record<keyof LifecycleApiService, unknown>>, permissions: string[]) {
  const notify = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };
  const held = new Set(permissions);
  const auth = {
    mode: 'bff',
    isAuthenticated: signal(true).asReadonly(),
    hasPermission: (k: string) => held.has(k),
    canSeePath: () => true,
    logout: vi.fn(),
  };
  const applied = { refresh: vi.fn(async () => undefined) };
  const navigate = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      // Context panels on these pages call other engine reads; they go to the testing backend and stay unanswered.
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      {
        provide: LifecycleApiService,
        useValue: {
          absolute: (u: string) => `http://engine.test/api/v1/lascodia-trading-engine/${u}`,
          ...api,
        },
      },
      { provide: NotificationService, useValue: notify },
      { provide: AuthService, useValue: auth },
      { provide: TenantBrandingService, useValue: applied },
      { provide: NAVIGATE_TO, useValue: navigate },
    ],
  });
  return { notify, auth, applied, navigate };
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

// ── Route table ──────────────────────────────────────────────────────────

describe('lifecycle routes', () => {
  const who = (...keys: string[]): AccessSubject => ({
    hasPermission: (k) => keys.includes(k),
    bff: true,
    platformStaff: false,
  });
  const staff = (...keys: string[]): AccessSubject => ({
    hasPermission: (k) => keys.includes(k),
    bff: true,
    platformStaff: true,
  });

  it('gates each page by its read key', () => {
    expect(canSee('/organisation/branding', who(P.TenantBrandingRead))).toBe(true);
    expect(canSee('/organisation/data-export', who(P.TenantBrandingRead))).toBe(false);
    expect(canSee('/organisation/data-export', who(P.TenantDataExport))).toBe(true);
    expect(canSee('/organisation/close', who(P.TenantClose))).toBe(true);
    expect(canSee('/organisation/close', who(P.TenantDataExport))).toBe(false);
    expect(canSee('/onboarding', who(P.TenantUsageRead))).toBe(true);
  });

  it('keeps the platform pages to staff', () => {
    expect(canSee('/platform/closures', who(P.PlatformTenantsManage))).toBe(false);
    expect(canSee('/platform/closures', staff(P.PlatformTenantsPurge))).toBe(true);
    expect(canSee('/platform/signups', staff(P.PlatformTenantsManage))).toBe(true);
  });
});

// ── Branding ─────────────────────────────────────────────────────────────

describe('BrandingPageComponent', () => {
  it('saves the name and colour, then re-applies the look', () => {
    const updateBranding = vi.fn(() =>
      of({
        ...branding,
        customDisplayName: 'Acme Desk',
        displayName: 'Acme Desk',
        primaryColor: '#1f6feb',
        isCustomised: true,
      }),
    );
    const { notify, applied } = setup(
      { branding: vi.fn(() => of(branding)), updateBranding, imageBlob: vi.fn(async () => null) },
      [P.TenantBrandingRead, P.TenantBrandingManage],
    );
    const page = TestBed.runInInjectionContext(() => new BrandingPageComponent());
    expect(page.canManage()).toBe(true);
    page.displayName.set(' Acme Desk ');
    page.colour.set('#1F6FEB');
    page.saveNameAndColour();
    expect(updateBranding).toHaveBeenCalledWith({
      displayName: 'Acme Desk',
      primaryColor: '#1F6FEB',
    });
    expect(notify.success).toHaveBeenCalled();
    expect(applied.refresh).toHaveBeenCalled();
    expect(page.branding.value()?.isCustomised).toBe(true);
  });

  it('refuses a wrong file before sending it', () => {
    const uploadImage = vi.fn();
    const { notify } = setup(
      { branding: vi.fn(() => of(branding)), uploadImage, imageBlob: vi.fn(async () => null) },
      [P.TenantBrandingRead, P.TenantBrandingManage],
    );
    const page = TestBed.runInInjectionContext(() => new BrandingPageComponent());
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    const input = { files: [file], value: 'x' } as unknown as HTMLInputElement;
    page.upload('logo', { target: input } as unknown as Event);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('PNG'));
  });

  it('shows the engine refusal of an upload in plain words', () => {
    const refusal = new HttpErrorResponse({
      status: 400,
      error: {
        status: false,
        responseCode: '-11',
        message: 'The logo is 4000×100 pixels; each side must be 16–2048 pixels.',
      },
    });
    const { notify } = setup(
      {
        branding: vi.fn(() => of(branding)),
        uploadImage: vi.fn(() => throwError(() => refusal)),
        imageBlob: vi.fn(async () => null),
      },
      [P.TenantBrandingRead, P.TenantBrandingManage],
    );
    const page = TestBed.runInInjectionContext(() => new BrandingPageComponent());
    const input = {
      files: [new File([new Uint8Array(10)], 'wide.png', { type: 'image/png' })],
      value: '',
    } as unknown as HTMLInputElement;
    page.upload('logo', { target: input } as unknown as Event);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('16–2048 pixels'));
  });

  it('is read-only without tenant.branding.manage', () => {
    setup({ branding: vi.fn(() => of(branding)), imageBlob: vi.fn(async () => null) }, [
      P.TenantBrandingRead,
    ]);
    const page = TestBed.runInInjectionContext(() => new BrandingPageComponent());
    expect(page.canManage()).toBe(false);
  });
});

// ── Data export ──────────────────────────────────────────────────────────

describe('DataExportPageComponent', () => {
  it('asks for an export and lists it first', () => {
    const queued: TenantDataExport = {
      ...ready,
      id: 6,
      status: 'Queued',
      canDownload: false,
      sizeBytes: null,
    };
    const requestExport = vi.fn(() => of(queued));
    const { notify } = setup({ exports: vi.fn(() => of([ready])), requestExport }, [
      P.TenantDataExport,
    ]);
    const page = TestBed.runInInjectionContext(() => new DataExportPageComponent());
    expect(page.inProgress()).toBeNull();
    page.request();
    expect(requestExport).toHaveBeenCalledTimes(1);
    expect(page.exports.value()[0].id).toBe(6);
    expect(page.inProgress()?.id).toBe(6);
    expect(notify.success).toHaveBeenCalled();
  });

  it('a download makes a single-use link and sends the browser to it', () => {
    const downloadLink = vi.fn(() =>
      of({ url: 'tenant/exports/download/lsc_dl_abc', expiresAtUtc: '2026-10-20T09:10:00Z' }),
    );
    const { navigate } = setup({ exports: vi.fn(() => of([ready])), downloadLink }, [
      P.TenantDataExport,
    ]);
    const page = TestBed.runInInjectionContext(() => new DataExportPageComponent());
    page.download(ready);
    expect(downloadLink).toHaveBeenCalledWith(5);
    expect(navigate).toHaveBeenCalledWith(
      'http://engine.test/api/v1/lascodia-trading-engine/tenant/exports/download/lsc_dl_abc',
    );
  });

  it('says why an export was refused (one at a time)', () => {
    const busy = new HttpErrorResponse({
      status: 409,
      error: {
        status: false,
        responseCode: '-409',
        message: 'Export #5 is still being prepared; ask again when it is ready.',
      },
    });
    const { notify } = setup(
      { exports: vi.fn(() => of([])), requestExport: vi.fn(() => throwError(() => busy)) },
      [P.TenantDataExport],
    );
    const page = TestBed.runInInjectionContext(() => new DataExportPageComponent());
    page.request();
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('still being prepared'));
  });
});

// ── Closing ──────────────────────────────────────────────────────────────

describe('CloseOrganisationPageComponent', () => {
  it('only lets the close go with the handle typed and a reason', () => {
    const close = vi.fn();
    setup({ closureState: vi.fn(() => of(closable)), close }, [P.TenantClose]);
    const page = TestBed.runInInjectionContext(() => new CloseOrganisationPageComponent());
    page.typed.set('acm');
    page.reason.set('moving on');
    expect(page.confirmOk()).toBe(false);
    page.close();
    expect(close).not.toHaveBeenCalled();
  });

  it('closed: says so and signs out', () => {
    vi.useFakeTimers();
    const c = closure();
    const close = vi.fn(() =>
      of({
        status: true,
        responseCode: '00',
        message: 'closed',
        data: { closure: c, approvalId: null, expiresAtUtc: null },
      }),
    );
    const { auth, notify } = setup({ closureState: vi.fn(() => of(closable)), close }, [
      P.TenantClose,
    ]);
    const page = TestBed.runInInjectionContext(() => new CloseOrganisationPageComponent());
    page.typed.set('acme');
    page.reason.set('moving on');
    page.close();
    expect(close).toHaveBeenCalledWith({ confirmSlug: 'acme', reason: 'moving on' });
    expect(page.closed()).toEqual(c);
    expect(notify.success).toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(auth.logout).toHaveBeenCalled();
  });

  it('held for a second Owner: not a failure, nothing closed', () => {
    const close = vi.fn(() =>
      of({
        status: false,
        responseCode: '-202-approval',
        message: 'needs a second Owner',
        data: { closure: null, approvalId: 9, expiresAtUtc: 'x' },
      }),
    );
    const { notify, auth } = setup(
      { closureState: vi.fn(() => of({ ...closable, owners: 2, needsSecondOwner: true })), close },
      [P.TenantClose],
    );
    const page = TestBed.runInInjectionContext(() => new CloseOrganisationPageComponent());
    page.open.set(true);
    page.typed.set('acme');
    page.reason.set('moving on');
    page.close();
    expect(page.closed()).toBeNull();
    expect(page.open()).toBe(false);
    expect(notify.error).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('open positions: the refusal is shown', () => {
    const refusal = new HttpErrorResponse({
      status: 409,
      error: {
        status: false,
        responseCode: '-409',
        message: 'The organisation still has 1 open position(s)',
      },
    });
    const { notify } = setup(
      { closureState: vi.fn(() => of(closable)), close: vi.fn(() => throwError(() => refusal)) },
      [P.TenantClose],
    );
    const page = TestBed.runInInjectionContext(() => new CloseOrganisationPageComponent());
    page.typed.set('acme');
    page.reason.set('x');
    page.close();
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('open position'));
  });
});

// ── Platform: closed organisations ───────────────────────────────────────

describe('PlatformClosuresPageComponent', () => {
  it('reopens with a reason', () => {
    const reopen = vi.fn(() => of(closure({ status: 'Reopened', canReopen: false })));
    const c = closure();
    setup({ closures: vi.fn(() => of([c])), closure: vi.fn(() => of(c)), reopen }, [
      P.PlatformTenantsManage,
    ]);
    const page = TestBed.runInInjectionContext(() => new PlatformClosuresPageComponent());
    page.select(c);
    page.openDialog('reopen');
    page.text.set('owner changed their mind');
    page.reopen(c);
    expect(reopen).toHaveBeenCalledWith(7001, 'owner changed their mind');
    expect(page.selected()?.status).toBe('Reopened');
  });

  it('confirms a deletion only with a runnable plan after the grace period and the handle typed', () => {
    const c = closure({ canSchedulePurge: true, plan });
    const schedulePurge = vi.fn(() => of(closure({ status: 'PurgeScheduled' })));
    setup({ closures: vi.fn(() => of([c])), closure: vi.fn(() => of(c)), schedulePurge }, [
      P.PlatformTenantsPurge,
    ]);
    const page = TestBed.runInInjectionContext(() => new PlatformClosuresPageComponent());
    page.select(c);
    page.openDialog('purge');
    page.text.set('wrong');
    page.schedulePurge(c);
    expect(schedulePurge).not.toHaveBeenCalled();
    page.text.set('acme');
    expect(page.purgeOk()).toBe(true);
    page.schedulePurge(c);
    expect(schedulePurge).toHaveBeenCalledWith(7001, 'acme');
  });
});
