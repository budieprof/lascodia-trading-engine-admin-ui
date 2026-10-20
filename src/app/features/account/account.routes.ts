import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import { ProfilePageComponent } from './pages/profile-page/profile-page.component';
import { ChangePasswordPageComponent } from './pages/change-password-page/change-password-page.component';

/** With BFF sign-in passwords live at the identity provider; the profile page links there. */
const legacySignInOnly = () =>
  inject(AuthService).mode === 'legacy' || inject(Router).createUrlTree(['/account/profile']);

export const ACCOUNT_ROUTES: Routes = [
  { path: '', redirectTo: 'profile', pathMatch: 'full' },
  { path: 'profile', component: ProfilePageComponent, data: { breadcrumb: 'Profile' } },
  {
    path: 'change-password',
    canActivate: [legacySignInOnly],
    component: ChangePasswordPageComponent,
    data: { breadcrumb: 'Change Password' },
  },
  {
    path: 'sessions',
    canActivate: [canAccessPath('account/sessions')],
    data: { breadcrumb: 'Sessions & devices' },
    loadComponent: () =>
      import('./pages/sessions-page/sessions-page.component').then((m) => m.SessionsPageComponent),
  },
  {
    path: 'tokens',
    canActivate: [canAccessPath('account/tokens')],
    data: { breadcrumb: 'Access tokens' },
    loadComponent: () =>
      import('./pages/tokens-page/tokens-page.component').then((m) => m.TokensPageComponent),
  },
];
