import { Routes } from '@angular/router';
import { BrokersPageComponent } from './pages/brokers-page/brokers-page.component';
import { BrokerDetailPageComponent } from './pages/broker-detail-page/broker-detail-page.component';

export const BROKERS_ROUTES: Routes = [
  { path: '', component: BrokersPageComponent },
  { path: ':id', component: BrokerDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
