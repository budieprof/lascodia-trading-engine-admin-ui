import { Routes } from '@angular/router';

import { canAccessPath } from '@core/auth/can-access.guard';
import { MarketDataPageComponent } from './pages/market-data-page/market-data-page.component';

export const MARKET_DATA_ROUTES: Routes = [
  { path: '', component: MarketDataPageComponent },
  {
    path: 'order-book',
    data: { breadcrumb: 'Order Book' },
    loadComponent: () =>
      import('./pages/order-book-page/order-book-page.component').then(
        (m) => m.OrderBookPageComponent,
      ),
  },
  {
    // Market-data entitlements (engine C6): platform staff grant feeds per organisation.
    path: 'entitlements',
    canActivate: [canAccessPath('market-data/entitlements')],
    data: { breadcrumb: 'Entitlements' },
    loadComponent: () =>
      import('./entitlements/pages/entitlements-page.component').then(
        (m) => m.MarketDataEntitlementsPageComponent,
      ),
  },
  {
    // The market-data source registry (engine C7): platform staff enable sources and set their writers.
    path: 'sources',
    canActivate: [canAccessPath('market-data/sources')],
    data: { breadcrumb: 'Sources' },
    loadComponent: () =>
      import('./sources/pages/md-sources-page.component').then(
        (m) => m.MarketDataSourcesPageComponent,
      ),
  },
  {
    // The exchange usage report (engine C6): who read which feed in a month.
    path: 'usage',
    canActivate: [canAccessPath('market-data/usage')],
    data: { breadcrumb: 'Usage' },
    loadComponent: () =>
      import('./entitlements/pages/usage-page.component').then(
        (m) => m.MarketDataUsagePageComponent,
      ),
  },
  {
    path: 'coverage',
    data: { breadcrumb: 'Candle Coverage' },
    loadComponent: () =>
      import('./pages/coverage-page/coverage-page.component').then((m) => m.CoveragePageComponent),
  },
];
