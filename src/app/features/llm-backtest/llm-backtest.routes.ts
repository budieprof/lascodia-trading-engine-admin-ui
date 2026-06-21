import { Routes } from '@angular/router';
import { requirePermission } from '@core/auth/permission.guard';

/**
 * LLM Analysis Backtest feature routes. Permission gating uses the same
 * `llmbacktest.view` key the server checks on the read endpoints — the
 * launch + cancel actions live on more-specific permissions (`llmbacktest.launch`,
 * `llmbacktest.cancel`) but the route guard only protects navigation.
 * The buttons themselves remain visible; the server is the authoritative
 * enforcer (`HasPermission` filter on each endpoint).
 */
export const LLM_BACKTEST_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'LLM Backtest' },
    canActivate: [requirePermission('llmbacktest.view')],
    loadComponent: () =>
      import('./pages/llm-backtest-index-page/llm-backtest-index-page.component').then(
        (m) => m.LlmBacktestIndexPageComponent,
      ),
  },
  {
    path: 'new',
    data: { breadcrumb: 'New' },
    canActivate: [requirePermission('llmbacktest.view')],
    loadComponent: () =>
      import('./pages/llm-backtest-new-page/llm-backtest-new-page.component').then(
        (m) => m.LlmBacktestNewPageComponent,
      ),
  },
  {
    path: 'compare',
    data: { breadcrumb: 'Compare runs' },
    canActivate: [requirePermission('llmbacktest.view')],
    loadComponent: () =>
      import('./pages/llm-backtest-compare-page/llm-backtest-compare-page.component').then(
        (m) => m.LlmBacktestComparePageComponent,
      ),
  },
  {
    path: ':id',
    data: { breadcrumb: 'Detail' },
    canActivate: [requirePermission('llmbacktest.view')],
    loadComponent: () =>
      import('./pages/llm-backtest-detail-page/llm-backtest-detail-page.component').then(
        (m) => m.LlmBacktestDetailPageComponent,
      ),
  },
];
