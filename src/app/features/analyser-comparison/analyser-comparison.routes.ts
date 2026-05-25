import { Routes } from '@angular/router';

/**
 * Analyser Comparison — the A/B view between the LLM `market_analysis.spot`
 * analyser and the non-LLM Synthetic Analyser. The default route is the
 * comparison summary; the `/audit` child runs the look-ahead-bias audit
 * suite (T1–T5) for one (symbol, timeframe) on demand.
 */
export const ANALYSER_COMPARISON_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Analyser Comparison' },
    loadComponent: () =>
      import('./pages/analyser-comparison-page/analyser-comparison-page.component').then(
        (m) => m.AnalyserComparisonPageComponent,
      ),
  },
  {
    path: 'audit',
    data: { breadcrumb: 'Look-ahead Audit' },
    loadComponent: () =>
      import('./pages/look-ahead-audit-page/look-ahead-audit-page.component').then(
        (m) => m.LookAheadAuditPageComponent,
      ),
  },
];
