import { Routes } from '@angular/router';

/** The documentation portal (engine enterprise onboarding): guides and the API reference. */
export const DOCS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/docs-home.component').then((m) => m.DocsHomeComponent),
  },
  {
    path: 'api',
    data: { breadcrumb: 'API reference' },
    loadComponent: () =>
      import('./pages/api-reference-page.component').then((m) => m.ApiReferencePageComponent),
  },
  {
    path: ':slug',
    data: { breadcrumb: 'Guide' },
    loadComponent: () => import('./pages/docs-page.component').then((m) => m.DocsPageComponent),
  },
];
