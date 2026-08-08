import { Routes } from '@angular/router';

/**
 * CME Microstructure operator panel (engine ADR-0021/0022) — contract calendar, the decisive
 * real-vs-proxy experiment, and the shadow monitor. Lazy-loaded via `app.routes.ts`.
 */
export const CME_MICROSTRUCTURE_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'CME Microstructure' },
    loadComponent: () =>
      import('./pages/cme-microstructure-page/cme-microstructure-page.component').then(
        (m) => m.CmeMicrostructurePageComponent,
      ),
  },
];
