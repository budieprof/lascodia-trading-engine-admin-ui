import { Routes } from '@angular/router';
import { WorkerHealthPageComponent } from './pages/worker-health-page/worker-health-page.component';

export const WORKER_HEALTH_ROUTES: Routes = [
  { path: '', component: WorkerHealthPageComponent, data: { breadcrumb: 'Worker Health' } },
];
