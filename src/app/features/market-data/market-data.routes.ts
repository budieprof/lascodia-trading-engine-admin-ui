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
    // Subscriber declarations (engine WS8 8.2): a person's professional / non-professional status per exchange.
    path: 'declarations',
    canActivate: [canAccessPath('market-data/declarations')],
    data: { breadcrumb: 'Subscriber declarations' },
    loadComponent: () =>
      import('./entitlements/pages/declarations-page.component').then(
        (m) => m.MarketDataDeclarationsPageComponent,
      ),
  },
  {
    // Staff review of every organisation's subscriber declarations (engine WS8 8.2).
    path: 'declarations-review',
    canActivate: [canAccessPath('market-data/declarations-review')],
    data: { breadcrumb: 'Declarations review' },
    loadComponent: () =>
      import('./entitlements/pages/declarations-review-page.component').then(
        (m) => m.MarketDataDeclarationsReviewPageComponent,
      ),
  },
  {
    // The non-FX instrument candle builder's state (multi-asset md-candles; WS7 7.10).
    path: 'instrument-candles',
    canActivate: [canAccessPath('market-data/instrument-candles')],
    data: { breadcrumb: 'Instrument candles' },
    loadComponent: () =>
      import('@features/venues/pages/instrument-candles-page.component').then(
        (m) => m.InstrumentCandlesPageComponent,
      ),
  },
  {
    path: 'coverage',
    data: { breadcrumb: 'Candle Coverage' },
    loadComponent: () =>
      import('./pages/coverage-page/coverage-page.component').then((m) => m.CoveragePageComponent),
  },
];
