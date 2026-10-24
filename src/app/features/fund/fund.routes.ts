import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

/** The fund pages in sidebar order; `/fund` opens the first one the person may see. */
const PAGES: AccessPath[] = ['fund/performance', 'fund/best-execution', 'fund/compliance'];

/** The fund module (enterprise program): performance statements, best-execution evidence, compliance exports. */
export const FUND_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('fund/'.length) ?? '/dashboard';
    },
  },
  {
    path: 'performance',
    canActivate: [canAccessPath('fund/performance')],
    data: { breadcrumb: 'Performance statements' },
    loadComponent: () =>
      import('./pages/performance-page.component').then((m) => m.PerformancePageComponent),
  },
  {
    path: 'best-execution',
    canActivate: [canAccessPath('fund/best-execution')],
    data: { breadcrumb: 'Best execution' },
    loadComponent: () =>
      import('./pages/best-execution-page.component').then((m) => m.BestExecutionPageComponent),
  },
  {
    path: 'compliance',
    canActivate: [canAccessPath('fund/compliance')],
    data: { breadcrumb: 'Compliance exports' },
    loadComponent: () =>
      import('./pages/compliance-page.component').then((m) => m.CompliancePageComponent),
  },
];
