import { Routes } from '@angular/router';

/**
 * Patient Trader feature — the cockpit for the generation-only discretionary agent: what it
 * currently thinks, what it has planned or passed on, and whether its reads are any good.
 */
export const PATIENT_TRADER_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Patient Trader' },
    loadComponent: () =>
      import('./pages/patient-trader-page/patient-trader-page.component').then(
        (m) => m.PatientTraderPageComponent,
      ),
  },
];
