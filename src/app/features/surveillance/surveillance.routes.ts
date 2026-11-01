import { Routes } from '@angular/router';

import { canAccessPath } from '@core/auth/can-access.guard';

/** Trade surveillance (gaps program): the alerts and their review, and the settings / job status page. */
export const SURVEILLANCE_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Alerts' },
    loadComponent: () =>
      import('./pages/surveillance-alerts-page.component').then((m) => m.SurveillanceAlertsPageComponent),
  },
  {
    path: 'settings',
    canActivate: [canAccessPath('surveillance/settings')],
    data: { breadcrumb: 'Settings' },
    loadComponent: () =>
      import('./pages/surveillance-settings-page.component').then((m) => m.SurveillanceSettingsPageComponent),
  },
];
