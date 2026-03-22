import { Routes } from '@angular/router';
import { OrdersPageComponent } from './pages/orders-page/orders-page.component';
import { OrderDetailPageComponent } from './pages/order-detail-page/order-detail-page.component';

export const ORDERS_ROUTES: Routes = [
  {
    path: '',
    component: OrdersPageComponent,
    data: { breadcrumb: 'Orders' },
  },
  {
    path: ':id',
    component: OrderDetailPageComponent,
    data: { breadcrumb: 'Detail' },
  },
];
