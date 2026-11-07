import { Routes } from '@angular/router';

/**
 * News Intelligence feature — visibility and control over the news sourcing,
 * classification and weighting module that feeds the spot-analysis prompt.
 *
 * Sub-pages (news-intel program, 2026-11-07) read only `access.operator` endpoints, so the parent
 * route's guard covers them; their writes are gated where they are offered.
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
  {
    path: 'coverage',
    data: { breadcrumb: 'Coverage' },
    loadComponent: () =>
      import('./pages/coverage-page.component').then((m) => m.NewsCoveragePageComponent),
  },
  {
    path: 'exposures',
    data: { breadcrumb: 'Exposures' },
    loadComponent: () =>
      import('./pages/exposures-page.component').then((m) => m.NewsExposuresPageComponent),
  },
  {
    path: 'sources',
    data: { breadcrumb: 'Sources' },
    loadComponent: () =>
      import('./pages/sources-page.component').then((m) => m.NewsSourcesPageComponent),
  },
  {
    path: 'calendar',
    data: { breadcrumb: 'Scheduled events' },
    loadComponent: () =>
      import('./pages/calendar-page.component').then((m) => m.NewsCalendarPageComponent),
  },
  {
    path: 'stories',
    data: { breadcrumb: 'Stories' },
    loadComponent: () =>
      import('./pages/stories-page.component').then((m) => m.NewsStoriesPageComponent),
  },
  {
    path: 'evals',
    data: { breadcrumb: 'Gold set & evals' },
    loadComponent: () =>
      import('./pages/evals-page.component').then((m) => m.NewsEvalsPageComponent),
  },
  {
    path: 'event-study',
    data: { breadcrumb: 'Event study' },
    loadComponent: () =>
      import('./pages/event-study-page.component').then((m) => m.NewsEventStudyPageComponent),
  },
  {
    path: 'risk',
    data: { breadcrumb: 'Risk use' },
    loadComponent: () => import('./pages/risk-page.component').then((m) => m.NewsRiskPageComponent),
  },
];
