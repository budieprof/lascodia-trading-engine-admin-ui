import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

const PAGES: AccessPath[] = [
  'platform/organisations',
  'platform/plans',
  'platform/fleet',
  'platform/billing',
  'platform/elevations',
  'platform/impersonation',
  'platform/signups',
  'platform/closures',
];

/** Platform console (U3.6): platform staff only (`/bff/session` → isPlatformStaff). */
export const PLATFORM_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('platform/'.length) ?? '/dashboard';
    },
  },
  {
    path: 'organisations',
    canActivate: [canAccessPath('platform/organisations')],
    data: { breadcrumb: 'Organisations' },
    loadComponent: () =>
      import('./pages/organisations-page.component').then((m) => m.OrganisationsPageComponent),
  },
  {
    // Plans and quotas (multi-tenancy Phase 7).
    path: 'plans',
    canActivate: [canAccessPath('platform/plans')],
    data: { breadcrumb: 'Plans' },
    loadComponent: () => import('./pages/plans-page.component').then((m) => m.PlansPageComponent),
  },
  {
    // Every organisation's EA fleet (multi-tenancy Phase 7).
    path: 'fleet',
    canActivate: [canAccessPath('platform/fleet')],
    data: { breadcrumb: 'Fleet health' },
    loadComponent: () => import('./pages/fleet-page.component').then((m) => m.FleetPageComponent),
  },
  {
    // Price books, invoices and every organisation's metered usage (enterprise program billing-metering).
    path: 'billing',
    canActivate: [canAccessPath('platform/billing')],
    data: { breadcrumb: 'Billing' },
    loadComponent: () =>
      import('@features/billing/pages/platform-billing-page.component').then(
        (m) => m.PlatformBillingPageComponent,
      ),
  },
  {
    path: 'elevations',
    canActivate: [canAccessPath('platform/elevations')],
    data: { breadcrumb: 'Elevated access' },
    loadComponent: () =>
      import('./pages/elevations-page.component').then((m) => m.ElevationsPageComponent),
  },
  {
    // Self-serve sign-ups and their approval (multi-tenancy Phase 7, c7-lifecycle).
    path: 'signups',
    canActivate: [canAccessPath('platform/signups')],
    data: { breadcrumb: 'Sign-ups' },
    loadComponent: () =>
      import('@features/onboarding/pages/platform-signups-page.component').then(
        (m) => m.PlatformSignupsPageComponent,
      ),
  },
  {
    // Closed organisations: reopening, the deletion plan and the deletion (multi-tenancy Phase 7, c7-lifecycle).
    path: 'closures',
    canActivate: [canAccessPath('platform/closures')],
    data: { breadcrumb: 'Closed organisations' },
    loadComponent: () =>
      import('@features/organisation/lifecycle/pages/platform-closures-page.component').then(
        (m) => m.PlatformClosuresPageComponent,
      ),
  },
  {
    path: 'impersonation',
    canActivate: [canAccessPath('platform/impersonation')],
    data: { breadcrumb: 'Impersonation' },
    loadComponent: () =>
      import('./pages/impersonation-page.component').then((m) => m.ImpersonationPageComponent),
  },
];
