import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { NAV_GROUPS } from '../../layout/sidebar/nav-items';
import { AuthService } from './auth.service';
import { canAccess, canAccessPath } from './can-access.guard';
import { LscCanDirective } from './can.directive';
import { Permission, isPermissionKey } from './permissions.generated';
import {
  ROUTE_ACCESS,
  canSee,
  landingFor,
  rulesFor,
  type AccessSubject,
} from './route-access';

ensureTestBed();

function who(perms: string[], opts: Partial<Pick<AccessSubject, 'bff' | 'platformStaff'>> = {}): AccessSubject {
  const set = new Set(perms);
  return { hasPermission: (k) => set.has(k), bff: opts.bff ?? false, platformStaff: opts.platformStaff ?? false };
}

describe('route table', () => {
  it('lists only keys the catalog knows', () => {
    for (const [path, r] of Object.entries(ROUTE_ACCESS)) {
      for (const k of r.anyOf) expect(isPermissionKey(k), `${path}: ${k}`).toBe(true);
    }
  });

  it('covers every sidebar item (an item not in the table would never show)', () => {
    for (const g of NAV_GROUPS) {
      for (const item of g.items) expect(rulesFor(item.route).length, item.route).toBeGreaterThan(0);
    }
  });

  it('applies a page’s parents too', () => {
    const trader = who([Permission.OrdersRead]);
    expect(canSee('/positions', trader)).toBe(true);
    expect(canSee('/positions/42', trader)).toBe(true);
    expect(canSee('/positions/deltas', trader)).toBe(false);
    expect(canSee('/positions/deltas', who([Permission.OrdersRead, Permission.AccessOperator]))).toBe(true);
    // The child's key alone is not enough: the parent's guard runs first.
    expect(canSee('/positions/deltas', who([Permission.AccessOperator]))).toBe(false);
  });

  it('refuses unknown pages and people without permissions', () => {
    expect(canSee('/no-such-page', who(Object.values(Permission)))).toBe(false);
    expect(canSee('/orders', who([]))).toBe(false);
    expect(canSee('/account/profile', who([]))).toBe(true);
  });

  it('keeps W3 pages to BFF sessions and the platform console to staff', () => {
    const admin = who([Permission.IamMembersRead, Permission.PlatformTenantsManage, Permission.PlatformImpersonate]);
    expect(canSee('/iam/members', admin)).toBe(false);
    expect(canSee('/iam/members', { ...admin, bff: true })).toBe(true);
    expect(canSee('/platform/organisations', admin)).toBe(false);
    expect(canSee('/platform/organisations', { ...admin, platformStaff: true })).toBe(true);
    expect(canSee('/platform/impersonation', { ...admin, platformStaff: true })).toBe(false);
    expect(canSee('/platform/impersonation', { ...admin, platformStaff: true, bff: true })).toBe(true);
  });

  it('lands people without the dashboard on their account', () => {
    expect(landingFor(who([Permission.AccessViewer]))).toBe('/dashboard');
    expect(landingFor(who([]))).toBe('/account/profile');
  });
});

describe('canAccess / canAccessPath guards', () => {
  afterEach(() => TestBed.resetTestingModule());

  function run(guard: ReturnType<typeof canAccess>, perms: string[], url = '/orders') {
    const notify = { error: vi.fn() };
    const set = new Set(perms);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: { accessSubject: () => ({ hasPermission: (k: string) => set.has(k), bff: false, platformStaff: false }) },
        },
        { provide: NotificationService, useValue: notify },
        { provide: Router, useValue: { createUrlTree: (c: string[]) => ({ redirectedTo: c[0] }) } },
      ],
    });
    const result = TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    );
    return { result: result as boolean | UrlTree | { redirectedTo: string }, notify };
  }

  it('lets a holder through', () => {
    expect(run(canAccess(Permission.OrdersRead), [Permission.OrdersRead]).result).toBe(true);
    expect(run(canAccessPath('orders'), [Permission.OrdersRead]).result).toBe(true);
  });

  it('sends anyone else to their landing page with a toast', () => {
    const { result, notify } = run(canAccessPath('kill-switches'), [Permission.AccessViewer], '/kill-switches');
    expect(result).toEqual({ redirectedTo: '/dashboard' });
    expect(notify.error).toHaveBeenCalledWith('You do not have access to that page.');
  });

  it('does not toast the default dashboard redirect', () => {
    const { result, notify } = run(canAccessPath('dashboard'), [], '/dashboard');
    expect(result).toEqual({ redirectedTo: '/account/profile' });
    expect(notify.error).not.toHaveBeenCalled();
  });
});

@Component({
  standalone: true,
  imports: [LscCanDirective],
  template: `
    <button id="grant" *lscCan="'iam.grants.manage'">Grant</button>
    <p id="either" *lscCan="['iam.members.read', 'roles.manage']; else none">Either</p>
    <ng-template #none><p id="none">No access</p></ng-template>
  `,
})
class HostComponent {}

describe('*lscCan', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows, hides and swaps as permissions change', async () => {
    const perms = signal<string[]>([]);
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: AuthService,
          useValue: {
            hasAnyPermission: (keys: readonly string[]) => keys.some((k) => perms().includes(k)),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    expect(el.querySelector('#grant')).toBeNull();
    expect(el.querySelector('#either')).toBeNull();
    expect(el.querySelector('#none')?.textContent).toBe('No access');

    perms.set(['iam.grants.manage', 'roles.manage']);
    await fixture.whenStable();
    expect(el.querySelector('#grant')?.textContent).toBe('Grant');
    expect(el.querySelector('#either')).not.toBeNull();
    expect(el.querySelector('#none')).toBeNull();

    perms.set([]);
    await fixture.whenStable();
    expect(el.querySelector('#grant')).toBeNull();
    expect(el.querySelector('#none')).not.toBeNull();
  });
});
