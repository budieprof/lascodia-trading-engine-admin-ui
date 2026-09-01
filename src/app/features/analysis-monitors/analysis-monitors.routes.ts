import { Routes } from '@angular/router';

/**
 * Operator cockpit for chat-created analysis monitors — fleet-wide visibility
 * and the control verbs (pause / resume / extend / fire / cancel) that the
 * anchor-scoped chat strip never had.
 */
export const ANALYSIS_MONITORS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Analysis Monitors' },
    loadComponent: () =>
      import('./pages/analysis-monitors-page/analysis-monitors-page.component').then(
        (m) => m.AnalysisMonitorsPageComponent,
      ),
  },
];
