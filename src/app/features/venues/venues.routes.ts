import { Routes } from '@angular/router';

import { canAccessPath } from '@core/auth/can-access.guard';

/** `/connections` (multi-asset WS7 7.7): execution accounts, write-only credentials, adapter health, drift. */
export const CONNECTIONS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/connections-page.component').then((m) => m.ConnectionsPageComponent),
  },
  {
    path: 'drift',
    canActivate: [canAccessPath('connections/drift')],
    data: { breadcrumb: 'Reconciliation drift' },
    loadComponent: () =>
      import('./pages/reconciliation-page.component').then((m) => m.ReconciliationPageComponent),
  },
];

/** `/reference/*` (multi-asset WS7 7.10): exchange reference data — fee schedules and margin requirements. */
export const REFERENCE_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'fee-schedules' },
  {
    path: 'fee-schedules',
    canActivate: [canAccessPath('reference/fee-schedules')],
    data: { breadcrumb: 'Fee schedules' },
    loadComponent: () =>
      import('./pages/fee-schedules-page.component').then((m) => m.FeeSchedulesPageComponent),
  },
  {
    path: 'margin-requirements',
    canActivate: [canAccessPath('reference/margin-requirements')],
    data: { breadcrumb: 'Margin requirements' },
    loadComponent: () =>
      import('./pages/margin-requirements-page.component').then(
        (m) => m.MarginRequirementsPageComponent,
      ),
  },
];
