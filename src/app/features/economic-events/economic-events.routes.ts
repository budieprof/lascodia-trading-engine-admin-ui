import { Routes } from '@angular/router';
import { EconomicEventsPageComponent } from './pages/economic-events-page/economic-events-page.component';

export const ECONOMIC_EVENTS_ROUTES: Routes = [
  { path: '', component: EconomicEventsPageComponent, data: { breadcrumb: 'Economic Events' } },
];
