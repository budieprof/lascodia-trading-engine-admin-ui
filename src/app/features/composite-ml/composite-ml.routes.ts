import { Routes } from '@angular/router';

export const COMPOSITE_ML_ROUTES: Routes = [
  {
    path: '',
    data: { breadcrumb: 'CompositeML' },
    loadComponent: () =>
      import('./pages/active-policies-page/active-policies-page.component').then(
        (m) => m.ActivePoliciesPageComponent,
      ),
  },
  {
    path: 'layer-health',
    data: { breadcrumb: 'Layer Health' },
    loadComponent: () =>
      import('./pages/layer-health-page/layer-health-page.component').then(
        (m) => m.LayerHealthPageComponent,
      ),
  },
  {
    path: 'snapshot/:id',
    data: { breadcrumb: 'Snapshot' },
    loadComponent: () =>
      import('./pages/snapshot-detail-page/snapshot-detail-page.component').then(
        (m) => m.SnapshotDetailPageComponent,
      ),
  },
  {
    path: 'diff',
    data: { breadcrumb: 'Policy Diff' },
    loadComponent: () =>
      import('./pages/diff-page/diff-page.component').then((m) => m.DiffPageComponent),
  },
];
