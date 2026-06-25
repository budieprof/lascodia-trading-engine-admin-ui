import { Routes } from '@angular/router';

export const PENDING_SIGNAL_RECS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/pending-signal-recs-page/pending-signal-recs-page.component').then(
        (m) => m.PendingSignalRecsPageComponent,
      ),
  },
];
