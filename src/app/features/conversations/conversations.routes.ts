import { Routes } from '@angular/router';

export const CONVERSATIONS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'Conversations' },
    loadComponent: () =>
      import('./pages/conversations-page/conversations-page.component').then(
        (m) => m.ConversationsPageComponent,
      ),
  },
];
