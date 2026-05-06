import { Routes } from '@angular/router';
import { AutomationMonitorPageComponent } from './pages/monitor-page/monitor-page.component';

export const AUTOMATION_MONITOR_ROUTES: Routes = [
  {
    path: '',
    component: AutomationMonitorPageComponent,
    data: { breadcrumb: 'Automation Monitor' },
  },
];
