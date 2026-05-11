import { Routes } from '@angular/router';
import { PositionsPageComponent } from './pages/positions-page/positions-page.component';
import { PositionDetailPageComponent } from './pages/position-detail-page/position-detail-page.component';

export const POSITIONS_ROUTES: Routes = [
  { path: '', component: PositionsPageComponent, data: { breadcrumb: 'Positions' } },
  {
    path: 'deltas',
    data: { breadcrumb: 'Position Deltas' },
    loadComponent: () =>
      import('./pages/position-deltas-page/position-deltas-page.component').then(
        (m) => m.PositionDeltasPageComponent,
      ),
  },
  { path: ':id', component: PositionDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
