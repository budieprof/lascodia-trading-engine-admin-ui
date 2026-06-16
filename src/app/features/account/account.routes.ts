import { Routes } from '@angular/router';
import { ProfilePageComponent } from './pages/profile-page/profile-page.component';
import { ChangePasswordPageComponent } from './pages/change-password-page/change-password-page.component';

export const ACCOUNT_ROUTES: Routes = [
  { path: '', redirectTo: 'profile', pathMatch: 'full' },
  { path: 'profile', component: ProfilePageComponent, data: { breadcrumb: 'Profile' } },
  {
    path: 'change-password',
    component: ChangePasswordPageComponent,
    data: { breadcrumb: 'Change Password' },
  },
];
