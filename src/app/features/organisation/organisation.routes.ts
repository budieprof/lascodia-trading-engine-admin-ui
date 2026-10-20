import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

/** The organisation console pages in sidebar order; `/organisation` opens the first one the person may see. */
const PAGES: AccessPath[] = ['organisation/terminals'];

/**
 * The organisation console (multi-tenancy Phase 7, c7-tenant): what an organisation administers of
 * its own — terminals and their credentials. Every page is gated by its read's key through the
 * route table; actions by their write's key.
 */
export const ORGANISATION_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return (
        PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('organisation/'.length) ?? '/dashboard'
      );
    },
  },
  {
    path: 'terminals',
    canActivate: [canAccessPath('organisation/terminals')],
    data: { breadcrumb: 'Connect a terminal' },
    loadComponent: () =>
      import('./pages/terminals-page.component').then((m) => m.TerminalsPageComponent),
  },
];
