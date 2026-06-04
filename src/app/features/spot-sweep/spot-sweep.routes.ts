import { Routes } from '@angular/router';

/**
 * Spot Sweep feature — the cockpit for the autonomous spot-analysis loop
 * (config + live monitor). See docs/SPOT_SWEEP_PLAN.md.
 */
export const SPOT_SWEEP_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Spot Sweep' },
    loadComponent: () =>
      import('./pages/spot-sweep-page/spot-sweep-page.component').then(
        (m) => m.SpotSweepPageComponent,
      ),
  },
];
