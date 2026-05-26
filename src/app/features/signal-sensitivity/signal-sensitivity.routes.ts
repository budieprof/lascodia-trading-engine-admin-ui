import { Routes } from '@angular/router';

/**
 * Signal Sensitivity Analysis — what-if replay of historic TradeSignal rows
 * against actual subsequent candles, with operator-tunable TP/SL multipliers
 * + a TP sweep curve.
 */
export const SIGNAL_SENSITIVITY_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Signal Sensitivity' },
    loadComponent: () =>
      import('./pages/signal-sensitivity-page/signal-sensitivity-page.component').then(
        (m) => m.SignalSensitivityPageComponent,
      ),
  },
];
