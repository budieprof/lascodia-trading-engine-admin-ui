import { Routes } from '@angular/router';
import { SignalsPageComponent } from './pages/signals-page/signals-page.component';
import { SignalDetailPageComponent } from './pages/signal-detail-page/signal-detail-page.component';

export const TRADE_SIGNALS_ROUTES: Routes = [
  { path: '', component: SignalsPageComponent },
  { path: ':id', component: SignalDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
