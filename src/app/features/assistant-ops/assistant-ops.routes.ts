import { Routes } from '@angular/router';

/** `/assistant` — the admin assistant's health and lessons (engine `AssistantOpsController`). */
export const ASSISTANT_OPS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/assistant-ops-page.component').then((m) => m.AssistantOpsPageComponent),
  },
];
