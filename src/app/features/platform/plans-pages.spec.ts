import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canSee, type AccessSubject } from '@core/auth/route-access';
import { Permission as P } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { PlanPageComponent } from '@features/iam/pages/plan-page.component';
import { UsageExportComponent } from './components/usage-export.component';
import { FleetPageComponent } from './pages/fleet-page.component';
import { PlansPageComponent } from './pages/plans-page.component';
import { PlansApiService } from './plans-api.service';
import type { FleetHealth, PlanDto, TenantUsage } from './plans.types';

ensureTestBed();

const trial: PlanDto = {
  id: 2,
  slug: 'trial',
  name: 'Trial',
  description: null,
  maxTradingAccounts: 2,
  maxActiveEaInstances: 4,
  maxMembers: 5,
  maxConcurrentResearchJobs: 2,
  maxStrategies: 10,
  maxScripts: 20,
  maxMonthlyLlmUsd: 10,
  logRetentionDays: 30,
  allowsSso: false,
  allowsScim: false,
  allowsPersonalAccessTokens: false,
  isDefault: true,
  isHousePlan: false,
  organisations: 3,
};

const quota403 = new HttpErrorResponse({
  status: 403,
  error: {
    status: false,
    message: 'engine text',
    responseCode: '-403-quota',
    data: { quota: 'feature', feature: 'sso', limit: 0, used: 0, plan: 'Trial' },
  },
});

function setup(api: Partial<Record<keyof PlansApiService, unknown>>) {
  const notify = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: PlansApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return notify;
}

afterEach(() => TestBed.resetTestingModule());

// ── Plans page ─────────────────────────────────────────────────────────

describe('PlansPageComponent', () => {
  let api: {
    plans: ReturnType<typeof vi.fn>;
    createPlan: ReturnType<typeof vi.fn>;
    updatePlan: ReturnType<typeof vi.fn>;
    deletePlan: ReturnType<typeof vi.fn>;
  };
  let notify: ReturnType<typeof setup>;

  beforeEach(() => {
    api = {
      plans: vi.fn(() => of([trial])),
      createPlan: vi.fn(() => of({ ...trial, id: 9, name: 'Pro', isDefault: false })),
      updatePlan: vi.fn(() => of(trial)),
      deletePlan: vi.fn(() => of(trial)),
    };
    notify = setup(api);
  });

  const page = () => TestBed.runInInjectionContext(() => new PlansPageComponent());

  it('loads the plans on open', () => {
    const p = page();
    expect(api.plans).toHaveBeenCalledTimes(1);
    expect(p.plans.value()).toEqual([trial]);
  });

  it('does not send a plan with problems', () => {
    const p = page();
    p.startCreate();
    p.patch({ slug: 'X', name: '' });
    p.save();
    expect(p.submitted()).toBe(true);
    expect(p.errors().length).toBeGreaterThan(0);
    expect(api.createPlan).not.toHaveBeenCalled();
  });

  it('creates a plan from the form (empty boxes = unlimited) and reloads', () => {
    const p = page();
    p.startCreate();
    p.patch({ slug: ' Pro ', name: 'Pro', allowsSso: true });
    p.setLimit('maxTradingAccounts', '10');
    p.setLimit('maxMembers', '');
    p.save();
    expect(api.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'pro',
        name: 'Pro',
        maxTradingAccounts: 10,
        maxMembers: null,
        allowsSso: true,
      }),
    );
    expect(p.editing()).toBeNull();
    expect(notify.success).toHaveBeenCalledWith('Plan Pro created.');
    expect(api.plans).toHaveBeenCalledTimes(2);
  });

  it('edits without the slug and keeps the default flagged as such', () => {
    const p = page();
    p.startEdit(trial);
    expect(p.editing()).toEqual({ id: 2, name: 'Trial', wasDefault: true });
    p.patch({ maxTradingAccounts: 3 });
    p.save();
    const [id, body] = api.updatePlan.mock.calls[0];
    expect(id).toBe(2);
    expect(body).not.toHaveProperty('slug');
    expect(body).toMatchObject({ maxTradingAccounts: 3, isDefault: true });
  });

  it("says why the engine refused, in the plan's own words for a quota refusal", () => {
    api.createPlan.mockReturnValueOnce(throwError(() => quota403));
    const p = page();
    p.startCreate();
    p.patch({ slug: 'pro', name: 'Pro' });
    p.save();
    expect(notify.error).toHaveBeenCalledWith(
      "Your organisation's plan (Trial) does not include single sign-on. Ask platform staff to move it to a plan that does.",
    );
    expect(p.busy()).toBe(false);
    expect(p.editing()).not.toBeNull();
  });

  it('deletes after confirmation', () => {
    const p = page();
    p.deleting.set({ ...trial, id: 9, isDefault: false, organisations: 0, name: 'Old' });
    p.remove();
    expect(api.deletePlan).toHaveBeenCalledWith(9);
    expect(p.deleting()).toBeNull();
    expect(notify.success).toHaveBeenCalledWith('Plan Old deleted.');
  });
});

// ── Fleet page ─────────────────────────────────────────────────────────

describe('FleetPageComponent', () => {
  const fleet: FleetHealth = {
    generatedAtUtc: '2026-10-20T09:00:00Z',
    heartbeatTimeoutSeconds: 60,
    sinceHours: 168,
    globalKillSwitchEngaged: false,
    organisations: [
      {
        tenantId: 1,
        slug: 'house',
        name: 'House',
        kind: 'House',
        status: 'Active',
        instances: 1,
        healthy: 1,
        stale: 0,
        disconnected: 0,
        killSwitches: [],
        needsAttention: false,
      },
      {
        tenantId: 7,
        slug: 'acme',
        name: 'Acme',
        kind: 'Customer',
        status: 'Active',
        instances: 2,
        healthy: 1,
        stale: 1,
        disconnected: 0,
        killSwitches: [],
        needsAttention: true,
      },
    ],
    instances: [
      {
        id: 1,
        instanceId: 'EA-H',
        tenantId: 1,
        tenantSlug: 'house',
        tradingAccountId: 30,
        accountLogin: '1',
        brokerServer: 'X',
        status: 'Active',
        health: 'Healthy',
        stateMachine: 'RUNNING',
        eaKillSwitchActive: false,
        eaVersion: '8.47.253',
        lastHeartbeatUtc: '2026-10-20T09:00:00Z',
        heartbeatAgeSeconds: 2,
        credentialOrigin: 'LegacyUpgrade',
        credentialLastUsedUtc: null,
      },
      {
        id: 2,
        instanceId: 'EA-1',
        tenantId: 7,
        tenantSlug: 'acme',
        tradingAccountId: 10,
        accountLogin: '5',
        brokerServer: 'X',
        status: 'Active',
        health: 'Healthy',
        stateMachine: 'RUNNING',
        eaKillSwitchActive: false,
        eaVersion: '8.47.253',
        lastHeartbeatUtc: '2026-10-20T09:00:00Z',
        heartbeatAgeSeconds: 2,
        credentialOrigin: 'Enrollment',
        credentialLastUsedUtc: null,
      },
      {
        id: 3,
        instanceId: 'EA-2',
        tenantId: 7,
        tenantSlug: 'acme',
        tradingAccountId: 10,
        accountLogin: '5',
        brokerServer: 'X',
        status: 'Active',
        health: 'Stale',
        stateMachine: 'RUNNING',
        eaKillSwitchActive: false,
        eaVersion: '8.47.253',
        lastHeartbeatUtc: '2026-10-20T08:00:00Z',
        heartbeatAgeSeconds: 3600,
        credentialOrigin: 'LegacyApiKey',
        credentialLastUsedUtc: null,
      },
    ],
  };

  it('loads the fleet for the chosen window, organisations needing attention first', () => {
    const api = { fleet: vi.fn(() => of(fleet)) };
    setup(api);
    const page = TestBed.runInInjectionContext(() => new FleetPageComponent());

    expect(api.fleet).toHaveBeenCalledWith(168);
    expect(page.organisations().map((o) => o.slug)).toEqual(['acme', 'house']);
    expect(page.rows().map((i) => i.instanceId)).toEqual(['EA-2', 'EA-1', 'EA-H']);

    page.toggleTenant(1);
    expect(page.rows().map((i) => i.instanceId)).toEqual(['EA-H']);
    page.toggleTenant(1);
    page.filter.set('stale');
    expect(page.rows().map((i) => i.instanceId)).toEqual(['EA-2']);

    page.sinceHours.set(24);
    page.fleet.reload();
    expect(api.fleet).toHaveBeenLastCalledWith(24);
  });

  it('shows why it could not load', () => {
    setup({
      fleet: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 403,
              error: {
                status: false,
                message: 'Only a platform staff member signed in as themselves can do this.',
                responseCode: '-403',
              },
            }),
        ),
      ),
    });
    const page = TestBed.runInInjectionContext(() => new FleetPageComponent());
    expect(page.fleet.error()).toBe(
      'Only a platform staff member signed in as themselves can do this.',
    );
  });
});

// ── The organisation's Plan & usage page ───────────────────────────────

describe('PlanPageComponent', () => {
  it("loads the acting organisation's usage", () => {
    const usage = { tenantId: 7, items: [] } as unknown as TenantUsage;
    const api = { myUsage: vi.fn(() => of(usage)) };
    setup(api);
    const page = TestBed.runInInjectionContext(() => new PlanPageComponent());
    expect(api.myUsage).toHaveBeenCalledTimes(1);
    expect(page.usage.value()).toBe(usage);
  });

  it('says plainly when the person may not see it', () => {
    setup({
      myUsage: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 400,
              error: {
                status: false,
                message: 'Choose an organisation first.',
                responseCode: '-11',
              },
            }),
        ),
      ),
    });
    const page = TestBed.runInInjectionContext(() => new PlanPageComponent());
    expect(page.usage.error()).toBe('Choose an organisation first.');
  });
});

// ── Monthly export ─────────────────────────────────────────────────────

describe('UsageExportComponent', () => {
  beforeEach(() => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it('offers last month first and downloads the chosen month', async () => {
    const api = {
      exportUsage: vi.fn(() =>
        of({ blob: new Blob(['x']), fileName: 'lascodia-usage-2026-09.csv' }),
      ),
    };
    const notify = setup(api);
    const c = TestBed.runInInjectionContext(() => new UsageExportComponent());
    c.month.set('2026-09');
    await c.download();
    expect(api.exportUsage).toHaveBeenCalledWith('2026-09');
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('Usage for September 2026 downloaded.');
    expect(c.busy()).toBe(false);
  });

  it("shows the engine's refusal from the error body, and nothing for an ended session", async () => {
    const body = new Blob([
      JSON.stringify({
        status: false,
        message: 'That month has not started yet.',
        responseCode: '-11',
      }),
    ]);
    const api = {
      exportUsage: vi.fn(() =>
        throwError(() => new HttpErrorResponse({ status: 400, error: body })),
      ),
    };
    const notify = setup(api);
    const c = TestBed.runInInjectionContext(() => new UsageExportComponent());
    await c.download();
    expect(notify.error).toHaveBeenCalledWith('That month has not started yet.');

    api.exportUsage.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
    notify.error.mockClear();
    await c.download();
    expect(notify.error).not.toHaveBeenCalled();
  });
});

// ── Who sees the pages ─────────────────────────────────────────────────

describe('plan pages in the route table', () => {
  const who = (keys: string[], over: Partial<AccessSubject> = {}): AccessSubject => ({
    hasPermission: (k) => keys.includes(k),
    bff: true,
    platformStaff: false,
    ...over,
  });

  it('Plans and Fleet health: platform staff with their key, in either sign-in mode', () => {
    expect(canSee('/platform/plans', who([P.PlatformPlansManage], { platformStaff: true }))).toBe(
      true,
    );
    expect(
      canSee('/platform/plans', who([P.PlatformPlansManage], { platformStaff: true, bff: false })),
    ).toBe(true);
    expect(canSee('/platform/plans', who([P.PlatformPlansManage]))).toBe(false);
    expect(canSee('/platform/plans', who([P.PlatformTenantsManage], { platformStaff: true }))).toBe(
      false,
    );
    expect(canSee('/platform/fleet', who([P.PlatformFleetRead], { platformStaff: true }))).toBe(
      true,
    );
    expect(canSee('/platform/fleet', who([P.AccessOperator], { platformStaff: true }))).toBe(false);
  });

  it('Plan & usage: anyone holding tenant.usage.read in the organisation', () => {
    expect(canSee('/iam/plan', who([P.TenantUsageRead]))).toBe(true);
    expect(canSee('/iam/plan', who([P.IamMembersRead]))).toBe(false);
  });
});
