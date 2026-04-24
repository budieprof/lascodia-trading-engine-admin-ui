import { Routes } from '@angular/router';
import { KillSwitchesPageComponent } from './pages/kill-switches-page/kill-switches-page.component';

export const KILL_SWITCHES_ROUTES: Routes = [
  { path: '', component: KillSwitchesPageComponent, data: { breadcrumb: 'Kill Switches' } },
];
