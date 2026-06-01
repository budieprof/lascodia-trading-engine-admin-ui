import { Routes } from '@angular/router';

export const SIGNAL_REJECTIONS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/rejections-dashboard-page/rejections-dashboard-page.component').then(
        (m) => m.RejectionsDashboardPageComponent,
      ),
  },
];
