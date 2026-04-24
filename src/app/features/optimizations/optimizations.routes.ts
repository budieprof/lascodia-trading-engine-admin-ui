import { Routes } from '@angular/router';
import { OptimizationsPageComponent } from './pages/optimizations-page/optimizations-page.component';

export const OPTIMIZATIONS_ROUTES: Routes = [
  { path: '', component: OptimizationsPageComponent, data: { breadcrumb: 'Optimizations' } },
];
