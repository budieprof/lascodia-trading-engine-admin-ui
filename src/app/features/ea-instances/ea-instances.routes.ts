import { Routes } from '@angular/router';
import { EAInstancesPageComponent } from './pages/ea-instances-page/ea-instances-page.component';

export const EA_INSTANCES_ROUTES: Routes = [
  { path: '', component: EAInstancesPageComponent, data: { breadcrumb: 'EA Instances' } },
  {
    path: ':id',
    data: { breadcrumb: 'EA Detail' },
    loadComponent: () =>
      import('./pages/ea-detail-page/ea-detail-page.component').then(
        (m) => m.EaDetailPageComponent,
      ),
  },
];
