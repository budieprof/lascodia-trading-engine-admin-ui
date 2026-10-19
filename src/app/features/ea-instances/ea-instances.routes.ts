import { Routes } from '@angular/router';
import { EAInstancesPageComponent } from './pages/ea-instances-page/ea-instances-page.component';

const loadDetail = () =>
  import('./pages/ea-detail-page/ea-detail-page.component').then((m) => m.EaDetailPageComponent);

export const EA_INSTANCES_ROUTES: Routes = [
  { path: '', component: EAInstancesPageComponent, data: { breadcrumb: 'EA Instances' } },
  // `:id` is a numeric row id or an instanceId (the engine's notification links use the latter).
  { path: ':id', data: { breadcrumb: 'EA Detail' }, loadComponent: loadDetail },
  // The notification feed links EA errors to `/ea-instances/{InstanceId}/logs`; without this
  // route the wildcard bounced them to the dashboard.
  {
    path: ':id/logs',
    data: { breadcrumb: 'EA Detail', focus: 'logs' },
    loadComponent: loadDetail,
  },
];
