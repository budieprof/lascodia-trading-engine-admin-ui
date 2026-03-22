import { Routes } from '@angular/router';
import { WalkForwardPageComponent } from './pages/walk-forward-page/walk-forward-page.component';
import { WalkForwardDetailPageComponent } from './pages/walk-forward-detail-page/walk-forward-detail-page.component';

export const WALK_FORWARD_ROUTES: Routes = [
  { path: '', component: WalkForwardPageComponent },
  { path: ':id', component: WalkForwardDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
