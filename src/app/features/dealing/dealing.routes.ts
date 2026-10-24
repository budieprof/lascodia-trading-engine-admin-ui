import type { Routes } from '@angular/router';

import { DealingFiltersStore } from './dealing-filters.store';

/** Broker dealing desk (enterprise program wave 2): `/dealing` and `/dealing/clients/:feedId/:login`. */
export const DEALING_ROUTES: Routes = [
  {
    path: '',
    providers: [DealingFiltersStore],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./pages/dealing-desk-page.component').then((m) => m.DealingDeskPageComponent),
      },
      {
        path: 'clients/:feedId/:login',
        data: { breadcrumb: 'Client' },
        loadComponent: () =>
          import('./pages/dealing-client-page.component').then((m) => m.DealingClientPageComponent),
      },
    ],
  },
];
