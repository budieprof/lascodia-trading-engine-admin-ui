import { Routes } from '@angular/router';
import { StrategiesPageComponent } from './pages/strategies-page/strategies-page.component';
import { StrategyDetailPageComponent } from './pages/strategy-detail-page/strategy-detail-page.component';
import { StrategyAnalyticsPageComponent } from './pages/strategy-analytics-page/strategy-analytics-page.component';
import { StrategiesComparePageComponent } from './pages/strategies-compare-page/strategies-compare-page.component';

export const STRATEGIES_ROUTES: Routes = [
  { path: '', component: StrategiesPageComponent, data: { breadcrumb: 'Strategies' } },
  {
    path: 'compare',
    component: StrategiesComparePageComponent,
    data: { breadcrumb: 'Compare' },
  },
  {
    path: ':id/analytics',
    component: StrategyAnalyticsPageComponent,
    data: { breadcrumb: 'Analytics' },
  },
  { path: ':id', component: StrategyDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
