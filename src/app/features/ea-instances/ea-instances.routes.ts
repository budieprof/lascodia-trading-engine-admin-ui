import { Routes } from '@angular/router';
import { EAInstancesPageComponent } from './pages/ea-instances-page/ea-instances-page.component';

export const EA_INSTANCES_ROUTES: Routes = [
  { path: '', component: EAInstancesPageComponent, data: { breadcrumb: 'EA Instances' } },
];
