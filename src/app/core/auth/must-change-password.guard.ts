import { inject } from '@angular/core';
import { CanActivateChildFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Forces a user flagged `mustChangePassword` to the change-password screen
 * across the entire protected app. Returns true when the flag is clear or the
 * target is already under `account/change-password` (so the user can actually
 * reach the form). Mirrors the engine's server-side enforcement — this is UX.
 */
export const mustChangePasswordGuard: CanActivateChildFn = (_childRoute, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.mustChangePassword()) return true;
  if (state.url.startsWith('/account/change-password')) return true;

  return router.createUrlTree(['/account/change-password']);
};
