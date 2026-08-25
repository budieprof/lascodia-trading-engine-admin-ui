import { Routes } from '@angular/router';
import { SignalsPageComponent } from './pages/signals-page/signals-page.component';
import { SignalDetailPageComponent } from './pages/signal-detail-page/signal-detail-page.component';

export const TRADE_SIGNALS_ROUTES: Routes = [
  { path: '', component: SignalsPageComponent },
  {
    path: 'feedback',
    data: { breadcrumb: 'Signal Exits' },
    loadComponent: () =>
      import('./pages/signal-feedback-page/signal-feedback-page.component').then(
        (m) => m.SignalFeedbackPageComponent,
      ),
  },
  // Must precede ':id' — a literal segment declared after a parameterised one is
  // unreachable, because ':id' matches 'internals' first and the detail page would
  // try to load a signal with that id.
  {
    path: 'internals',
    data: { breadcrumb: 'Internals' },
    loadComponent: () =>
      import('./pages/signal-internals-page/signal-internals-page.component').then(
        (m) => m.SignalInternalsPageComponent,
      ),
  },
  { path: ':id', component: SignalDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
