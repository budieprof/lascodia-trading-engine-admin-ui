import { Routes } from '@angular/router';
import { canAccess } from '@core/auth/can-access.guard';
import { Permission } from '@core/auth/permissions.generated';

/**
 * Prompt-templates feature routes. Every page requires the
 * `prompttemplate.view` permission; the edit / promote actions check
 * `prompttemplate.edit` / `prompttemplate.promote` at the button level so
 * a Viewer can still drill in and read the prompt body.
 *
 * Path order matters — the diff route is declared BEFORE the `:id` route
 * so `'/prompt-templates/diff'` doesn't get treated as id=NaN.
 */
export const PROMPT_TEMPLATES_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    // Must match app.routes' label exactly: the breadcrumb builder only
    // collapses parent + empty-child crumbs when label AND url are equal, and
    // the case mismatch produced "Prompt Templates › Prompt templates".
    data: { breadcrumb: 'Prompt Templates' },
    canActivate: [canAccess(Permission.PrompttemplateView)],
    loadComponent: () =>
      import('./pages/prompt-templates-list-page/prompt-templates-list-page.component').then(
        (m) => m.PromptTemplatesListPageComponent,
      ),
  },
  {
    path: 'diff',
    data: { breadcrumb: 'Diff' },
    canActivate: [canAccess(Permission.PrompttemplateView)],
    loadComponent: () =>
      import('./pages/prompt-template-diff-page/prompt-template-diff-page.component').then(
        (m) => m.PromptTemplateDiffPageComponent,
      ),
  },
  {
    path: ':id',
    data: { breadcrumb: 'Editor' },
    canActivate: [canAccess(Permission.PrompttemplateView)],
    loadComponent: () =>
      import('./pages/prompt-template-editor-page/prompt-template-editor-page.component').then(
        (m) => m.PromptTemplateEditorPageComponent,
      ),
  },
];
