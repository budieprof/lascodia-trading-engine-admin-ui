import { Routes } from '@angular/router';

export const AUTO_TUNE_ROUTES: Routes = [
  {
    path: '',
    data: { breadcrumb: 'Auto-Tune Proposals' },
    loadComponent: () =>
      import('./pages/proposals-page/proposals-page.component').then(
        (m) => m.AutoTuneProposalsPageComponent,
      ),
  },
  {
    path: 'auto-apply',
    data: { breadcrumb: 'Auto-Apply Config' },
    loadComponent: () =>
      import('./pages/auto-apply-config-page/auto-apply-config-page.component').then(
        (m) => m.AutoApplyConfigPageComponent,
      ),
  },
];
