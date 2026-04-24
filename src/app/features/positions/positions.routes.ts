import { Routes } from '@angular/router';
import { PositionsPageComponent } from './pages/positions-page/positions-page.component';
import { PositionDetailPageComponent } from './pages/position-detail-page/position-detail-page.component';

export const POSITIONS_ROUTES: Routes = [
  { path: '', component: PositionsPageComponent, data: { breadcrumb: 'Positions' } },
  { path: ':id', component: PositionDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
