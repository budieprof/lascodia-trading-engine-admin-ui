import { Routes } from '@angular/router';

/**
 * Spread-Reactive subsystem — opt-in SL widening per (TradingAccount, Symbol)
 * during elevated-spread windows.  Phase 1: config; Phase 2: live state
 * dashboard.
 */
export const SPREAD_REACTIVE_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Spread-Reactive' },
    loadComponent: () =>
      import('./pages/spread-reactive-page/spread-reactive-page.component').then(
        (m) => m.SpreadReactivePageComponent,
      ),
  },
];
