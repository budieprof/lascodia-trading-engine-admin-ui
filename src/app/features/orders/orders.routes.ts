import { Routes } from '@angular/router';
import { OrdersPageComponent } from './pages/orders-page/orders-page.component';
import { OrderDetailPageComponent } from './pages/order-detail-page/order-detail-page.component';
import { REMOUNT_ON_PARAM_CHANGE } from '@core/routing/remount-on-param-change.strategy';

export const ORDERS_ROUTES: Routes = [
  {
    path: '',
    component: OrdersPageComponent,
    data: { breadcrumb: 'Orders' },
  },
  {
    path: ':id',
    component: OrderDetailPageComponent,
    data: { breadcrumb: 'Detail', [REMOUNT_ON_PARAM_CHANGE]: true },
  },
];
