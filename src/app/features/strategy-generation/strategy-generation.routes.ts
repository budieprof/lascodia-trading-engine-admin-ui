import { Routes } from '@angular/router';
import { StrategyGenerationCyclesPageComponent } from './pages/strategy-generation-cycles-page/strategy-generation-cycles-page.component';

export const STRATEGY_GENERATION_ROUTES: Routes = [
  {
    path: '',
    component: StrategyGenerationCyclesPageComponent,
    data: { breadcrumb: 'Strategy Generation' },
  },
];
