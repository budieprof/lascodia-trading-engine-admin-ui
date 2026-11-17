import { Routes } from '@angular/router';
import { AccountsPageComponent } from './pages/accounts-page/accounts-page.component';
import { AccountDetailPageComponent } from './pages/account-detail-page/account-detail-page.component';
import { REMOUNT_ON_PARAM_CHANGE } from '@core/routing/remount-on-param-change.strategy';

export const TRADING_ACCOUNTS_ROUTES: Routes = [
  { path: '', component: AccountsPageComponent },
  {
    path: ':id',
    component: AccountDetailPageComponent,
    data: { breadcrumb: 'Detail', [REMOUNT_ON_PARAM_CHANGE]: true },
  },
];
