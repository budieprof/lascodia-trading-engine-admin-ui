import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { returnUrlQueryParams } from './return-url';

/** Query param `/bff/callback` appends to the return path when a sign-in did not complete. */
export const SIGNIN_ERROR_PARAM = 'signin_error';

/**
 * Splits `signin_error` off a URL: the return path must not carry it back (it would show the error
 * again after the next successful sign-in), but the login page must show it.
 */
export function splitSignInError(url: string): { url: string; error: string | null } {
  const q = url.indexOf('?');
  if (q === -1) return { url, error: null };
  const hashAt = url.indexOf('#', q);
  const path = url.slice(0, q);
  const query = url.slice(q + 1, hashAt === -1 ? undefined : hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const params = new URLSearchParams(query);
  const error = params.get(SIGNIN_ERROR_PARAM);
  if (error === null) return { url, error: null };
  params.delete(SIGNIN_ERROR_PARAM);
  const rest = params.toString();
  return { url: `${path}${rest ? `?${rest}` : ''}${hash}`, error: error.slice(0, 64) };
}

export const authGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }

  // Carry where they were trying to go so login can put them back there.
  // This is the path that fires when a session dies while the tab is idle:
  // the token is already gone by the time the user clicks anything, so the
  // guard — not the HTTP interceptor — is what redirects them. A BFF sign-in
  // that failed comes back here too, with `signin_error` for the login page.
  const { url, error } = splitSignInError(state.url);
  return router.createUrlTree(['/login'], {
    queryParams: {
      ...returnUrlQueryParams(url),
      ...(error ? { [SIGNIN_ERROR_PARAM]: error } : {}),
    },
  });
};
