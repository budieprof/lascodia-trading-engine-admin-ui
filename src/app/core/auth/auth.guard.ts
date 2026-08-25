import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { returnUrlQueryParams } from './return-url';

export const authGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }

  // Carry where they were trying to go so login can put them back there.
  // This is the path that fires when a session dies while the tab is idle:
  // the token is already gone by the time the user clicks anything, so the
  // guard — not the HTTP interceptor — is what redirects them.
  return router.createUrlTree(['/login'], {
    queryParams: returnUrlQueryParams(state.url),
  });
};
