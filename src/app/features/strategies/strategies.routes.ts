import { Routes } from '@angular/router';
import { StrategiesPageComponent } from './pages/strategies-page/strategies-page.component';
import { StrategyDetailPageComponent } from './pages/strategy-detail-page/strategy-detail-page.component';
import { StrategyAnalyticsPageComponent } from './pages/strategy-analytics-page/strategy-analytics-page.component';
import { StrategiesComparePageComponent } from './pages/strategies-compare-page/strategies-compare-page.component';

export const STRATEGIES_ROUTES: Routes = [
  { path: '', component: StrategiesPageComponent, data: { breadcrumb: 'Strategies' } },
  // PRD FR-3.5: the allocation-weights surface lives at /strategy-portfolio
  // (Operator-gated, combines allocation + FWER report). Anyone hitting the
  // PRD-canonical /strategies/allocation URL — saved bookmark, command-palette
  // entry, doc link — is redirected to the real page rather than 404'ing.
  { path: 'allocation', redirectTo: '/strategy-portfolio', pathMatch: 'full' },
  {
    path: 'compare',
    component: StrategiesComparePageComponent,
    data: { breadcrumb: 'Compare' },
  },
  {
    path: 'llm-proposals',
    data: { breadcrumb: 'LLM Proposals' },
    loadComponent: () =>
      import('./pages/llm-proposals-page/llm-proposals-page.component').then(
        (m) => m.LlmProposalsPageComponent,
      ),
  },
  {
    path: 'rejections',
    data: { breadcrumb: 'Rejection Summary' },
    loadComponent: () =>
      import('./pages/rejection-summary-page/rejection-summary-page.component').then(
        (m) => m.RejectionSummaryPageComponent,
      ),
  },
  {
    path: 'templates',
    data: { breadcrumb: 'Templates' },
    loadComponent: () =>
      import('./pages/templates-page/templates-page.component').then(
        (m) => m.TemplatesPageComponent,
      ),
  },
  {
    path: ':id/analytics',
    component: StrategyAnalyticsPageComponent,
    data: { breadcrumb: 'Analytics' },
  },
  { path: ':id', component: StrategyDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
