import { Routes } from '@angular/router';

/**
 * Recommendations — every trade card an analysis wrote, paged, and one page per card with
 * everything that followed from it.
 */
export const TRADE_RECOMMENDATIONS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/recommendations-page/recommendations-page.component').then(
        (m) => m.RecommendationsPageComponent,
      ),
  },
  {
    path: ':id',
    data: { breadcrumb: 'Detail' },
    loadComponent: () =>
      import('./pages/recommendation-detail-page/recommendation-detail-page.component').then(
        (m) => m.RecommendationDetailPageComponent,
      ),
  },
];
