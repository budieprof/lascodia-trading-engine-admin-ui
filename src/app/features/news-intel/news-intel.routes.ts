import { Routes } from '@angular/router';

/**
 * News Intelligence feature — visibility and control over the news sourcing,
 * classification and weighting module that feeds the spot-analysis prompt.
 */
export const NEWS_INTEL_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    data: { breadcrumb: 'News Intelligence' },
    loadComponent: () =>
      import('./pages/news-intel-page/news-intel-page.component').then(
        (m) => m.NewsIntelPageComponent,
      ),
  },
];
