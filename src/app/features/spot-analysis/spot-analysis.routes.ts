import { Routes } from '@angular/router';

/**
 * Spot Analysis feature — the dense report of every LLM `market_analysis.spot`
 * run with its recommendations, generated signals, and attributed trade P&L.
 */
export const SPOT_ANALYSIS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Spot Analysis' },
    loadComponent: () =>
      import('./pages/spot-analysis-report-page/spot-analysis-report-page.component').then(
        (m) => m.SpotAnalysisReportPageComponent,
      ),
  },
];
