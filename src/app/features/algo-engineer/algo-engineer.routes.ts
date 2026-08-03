import { Routes } from '@angular/router';

export const ALGO_ENGINEER_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/scorecard-page/scorecard-page.component').then(
        (m) => m.AlgoEngineerScorecardPageComponent,
      ),
  },
];
