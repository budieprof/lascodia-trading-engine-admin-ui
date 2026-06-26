import { Routes } from '@angular/router';

/** Fleet-wide stop-loss change audit — every SL move, every source. */
export const SL_AUDIT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'SL Audit' },
    loadComponent: () =>
      import('./pages/sl-audit-page/sl-audit-page.component').then((m) => m.SlAuditPageComponent),
  },
];
