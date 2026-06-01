import type { Routes } from '@angular/router';

export const FLEET_HEALTH_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/fleet-health-page/fleet-health-page.component').then(
        (m) => m.FleetHealthPageComponent,
      ),
  },
];
