import { Routes } from '@angular/router';
import { canAccessPath } from '@core/auth/can-access.guard';

/**
 * LLM observability + control feature. Surfaces the PRD-0001 narrative
 * layer (invocations ledger + lifecycle rationale feed) and the LLM
 * provider settings page in one feature module. The strategy-proposal
 * page lives under `/strategies/llm-proposals` for historical reasons —
 * sidebar groups them under one "LLM" heading.
 */
export const LLM_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'invocations' },
  {
    path: 'invocations',
    canActivate: [canAccessPath('llm/invocations')],
    data: { breadcrumb: 'Invocations' },
    loadComponent: () =>
      import('./pages/llm-invocations-page/llm-invocations-page.component').then(
        (m) => m.LlmInvocationsPageComponent,
      ),
  },
  {
    path: 'rationales',
    canActivate: [canAccessPath('llm/rationales')],
    data: { breadcrumb: 'Rationales' },
    loadComponent: () =>
      import('./pages/llm-rationales-page/llm-rationales-page.component').then(
        (m) => m.LlmRationalesPageComponent,
      ),
  },
  {
    path: 'settings',
    canActivate: [canAccessPath('llm/settings')],
    data: { breadcrumb: 'Settings' },
    loadComponent: () =>
      import('./pages/llm-settings-page/llm-settings-page.component').then(
        (m) => m.LlmSettingsPageComponent,
      ),
  },
];
