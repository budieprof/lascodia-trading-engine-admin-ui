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

/** `/algo-engineer/operations` — the live fleet view. Its own bundle: the scorecard is a table of
 *  history, this is a polling board, and neither should pull the other in. */
export const ALGO_ENGINEER_OPERATIONS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/operations-page/operations-page.component').then(
        (m) => m.AlgoEngineerOperationsPageComponent,
      ),
  },
];
