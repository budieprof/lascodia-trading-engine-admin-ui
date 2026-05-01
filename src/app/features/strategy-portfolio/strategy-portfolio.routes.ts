import { Routes } from '@angular/router';
import { StrategyPortfolioPageComponent } from './pages/strategy-portfolio-page/strategy-portfolio-page.component';

export const STRATEGY_PORTFOLIO_ROUTES: Routes = [
  {
    path: '',
    component: StrategyPortfolioPageComponent,
    data: { breadcrumb: 'Strategy Portfolio' },
  },
];
