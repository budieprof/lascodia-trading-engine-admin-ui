import { Routes } from '@angular/router';
import { EngineOverviewPageComponent } from './pages/engine-overview-page/engine-overview-page.component';

export const ENGINE_OVERVIEW_ROUTES: Routes = [
  {
    path: '',
    component: EngineOverviewPageComponent,
    data: { breadcrumb: 'Engine Overview' },
  },
];
