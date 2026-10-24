import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

/** The prop pages in sidebar order; `/prop` opens the first one the person may see. */
const PAGES: AccessPath[] = ['prop/console', 'prop/me'];

/**
 * The prop-firm module (engine `docs/api/prop-module.md`): the firm console (breach feed and
 * leaderboard), programs, traders, enrolments with their dashboards, payouts, and the trader's own
 * "My challenge". Every page asks the engine first whether the organisation's plan includes the
 * module and shows the upgrade notice when it does not.
 */
export const PROP_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('prop/'.length) ?? '/dashboard';
    },
  },
  {
    path: 'console',
    canActivate: [canAccessPath('prop/console')],
    data: { breadcrumb: 'Firm console' },
    loadComponent: () =>
      import('./pages/prop-console-page.component').then((m) => m.PropConsolePageComponent),
  },
  {
    path: 'programs',
    canActivate: [canAccessPath('prop/programs')],
    data: { breadcrumb: 'Programs' },
    loadComponent: () =>
      import('./pages/prop-programs-page.component').then((m) => m.PropProgramsPageComponent),
  },
  {
    path: 'traders',
    canActivate: [canAccessPath('prop/traders')],
    data: { breadcrumb: 'Traders' },
    loadComponent: () =>
      import('./pages/prop-traders-page.component').then((m) => m.PropTradersPageComponent),
  },
  {
    path: 'enrollments',
    canActivate: [canAccessPath('prop/enrollments')],
    data: { breadcrumb: 'Enrolments' },
    loadComponent: () =>
      import('./pages/prop-enrollments-page.component').then((m) => m.PropEnrollmentsPageComponent),
  },
  {
    path: 'enrollments/:id',
    canActivate: [canAccessPath('prop/enrollments')],
    data: { breadcrumb: 'Dashboard' },
    loadComponent: () =>
      import('./pages/prop-dashboard-page.component').then((m) => m.PropDashboardPageComponent),
  },
  {
    path: 'payouts',
    canActivate: [canAccessPath('prop/payouts')],
    data: { breadcrumb: 'Payouts' },
    loadComponent: () =>
      import('./pages/prop-payouts-page.component').then((m) => m.PropPayoutsPageComponent),
  },
  {
    path: 'me',
    canActivate: [canAccessPath('prop/me')],
    data: { breadcrumb: 'My challenge' },
    loadComponent: () =>
      import('./pages/prop-me-page.component').then((m) => m.PropMePageComponent),
  },
];
