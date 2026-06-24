import { Routes } from '@angular/router';

/**
 * Viability Gates cockpit — operator surface for the 7 structural-conviction
 * gates (E4e..E4j + E4h).  Lazy-loaded via `app.routes.ts`.
 */
export const VIABILITY_GATES_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Viability Gates' },
    loadComponent: () =>
      import('./pages/viability-gates-page/viability-gates-page.component').then(
        (m) => m.ViabilityGatesPageComponent,
      ),
  },
];
