import { Routes } from '@angular/router';
import { StrategiesPageComponent } from './pages/strategies-page/strategies-page.component';
import { StrategyDetailPageComponent } from './pages/strategy-detail-page/strategy-detail-page.component';

export const STRATEGIES_ROUTES: Routes = [
  { path: '', component: StrategiesPageComponent, data: { breadcrumb: 'Strategies' } },
  { path: ':id', component: StrategyDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
