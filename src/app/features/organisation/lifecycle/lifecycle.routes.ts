import { Routes } from '@angular/router';

import { canAccessPath } from '@core/auth/can-access.guard';

/**
 * An organisation's life cycle (multi-tenancy Phase 7, c7-lifecycle): its console look, taking its data out
 * and closing it. Children of `/organisation` — the organisation console (c7-tenant) lists them beside its
 * own pages. Each page is gated by its read's key through the route table; actions by their write's key.
 */
export const ORGANISATION_LIFECYCLE_ROUTES: Routes = [
  {
    path: 'branding',
    canActivate: [canAccessPath('organisation/branding')],
    data: { breadcrumb: 'Branding' },
    loadComponent: () =>
      import('./pages/branding-page.component').then((m) => m.BrandingPageComponent),
  },
  {
    path: 'data-export',
    canActivate: [canAccessPath('organisation/data-export')],
    data: { breadcrumb: 'Export your data' },
    loadComponent: () =>
      import('./pages/data-export-page.component').then((m) => m.DataExportPageComponent),
  },
  {
    path: 'close',
    canActivate: [canAccessPath('organisation/close')],
    data: { breadcrumb: 'Close the organisation' },
    loadComponent: () =>
      import('./pages/close-organisation-page.component').then(
        (m) => m.CloseOrganisationPageComponent,
      ),
  },
];
