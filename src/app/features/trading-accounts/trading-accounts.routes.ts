import { Routes } from '@angular/router';
import { AccountsPageComponent } from './pages/accounts-page/accounts-page.component';
import { AccountDetailPageComponent } from './pages/account-detail-page/account-detail-page.component';

export const TRADING_ACCOUNTS_ROUTES: Routes = [
  { path: '', component: AccountsPageComponent },
  { path: ':id', component: AccountDetailPageComponent, data: { breadcrumb: 'Detail' } },
];
