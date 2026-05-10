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
  {
    path: 'layer-skill',
    data: { breadcrumb: 'Layer Skill' },
    loadComponent: () =>
      import('./pages/layer-skill-page/layer-skill-page.component').then(
        (m) => m.LayerSkillPageComponent,
      ),
  },
  {
    path: 'trainer-skill',
    data: { breadcrumb: 'Trainer Skill' },
    loadComponent: () =>
      import('./pages/trainer-skill-page/trainer-skill-page.component').then(
        (m) => m.TrainerSkillPageComponent,
      ),
  },
  {
    path: 'drift',
    data: { breadcrumb: 'Catalogue Drift' },
    loadComponent: () =>
      import('./pages/drift-summary-page/drift-summary-page.component').then(
        (m) => m.DriftSummaryPageComponent,
      ),
  },
  {
    path: 'drift/history',
    data: { breadcrumb: 'Drift History' },
    loadComponent: () =>
      import('./pages/drift-history-page/drift-history-page.component').then(
        (m) => m.DriftHistoryPageComponent,
      ),
  },
];
