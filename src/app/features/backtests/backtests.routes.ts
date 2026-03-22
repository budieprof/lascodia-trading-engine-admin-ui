import { Routes } from '@angular/router';
import { BacktestsPageComponent } from './pages/backtests-page/backtests-page.component';
import { BacktestDetailPageComponent } from './pages/backtest-detail-page/backtest-detail-page.component';

export const BACKTESTS_ROUTES: Routes = [
  { path: '', component: BacktestsPageComponent },
  { path: ':id', component: BacktestDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
