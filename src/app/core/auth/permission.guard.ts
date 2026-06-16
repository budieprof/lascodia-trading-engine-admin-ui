import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { NotificationService } from '@core/notifications/notification.service';

/**
 * Route guard that checks the signed-in user holds at least one of the supplied
 * permission keys (super admins always pass). Mirrors {@link requireRoles} but
 * gates on fine-grained permissions resolved from `GET /admin/auth/me`. The
 * engine is the authoritative enforcer — this guard is UX (don't route to a
 * page the user can't use).
 *
 * ```ts
 * { path: 'admin/users', canActivate: [requirePermission('users.manage')], … }
 * ```
 */
export function requirePermission(...permissions: string[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const notifications = inject(NotificationService);

    if (permissions.some((p) => auth.hasPermission(p))) return true;

    notifications.error(`This page requires permission: ${permissions.join(' or ')}.`);
    return router.createUrlTree(['/dashboard']);
  };
}
