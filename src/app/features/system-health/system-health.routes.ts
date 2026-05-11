import { Routes } from '@angular/router';
import { HealthPageComponent } from './pages/health-page/health-page.component';

export const SYSTEM_HEALTH_ROUTES: Routes = [
  { path: '', component: HealthPageComponent },
  {
    path: 'worker-override-knobs',
    data: { breadcrumb: 'Worker Override Knobs' },
    loadComponent: () =>
      import('./pages/worker-override-knobs-page/worker-override-knobs-page.component').then(
        (m) => m.WorkerOverrideKnobsPageComponent,
      ),
  },
];
