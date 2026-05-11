import { Routes } from '@angular/router';
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
];
