import { Routes } from '@angular/router';

import { PortfolioBacktestDetailPageComponent } from './portfolio-backtest-detail-page.component';
import { PortfolioBacktestsPageComponent } from './portfolio-backtests-page.component';

/** Portfolio backtests (BT-I12 / BX-5): the runs and the new-run form, and one run's findings. */
export const PORTFOLIO_BACKTEST_ROUTES: Routes = [
  { path: '', component: PortfolioBacktestsPageComponent },
  { path: ':id', component: PortfolioBacktestDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
