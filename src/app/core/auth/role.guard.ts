import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService, Role } from './auth.service';
import { NotificationService } from '@core/notifications/notification.service';

/**
 * Route guard that checks the signed-in user carries at least one of the
 * supplied roles. Unlike `AuthService.hasPolicy`, this guard does NOT honour
 * the empty-roles dev escape hatch — pages wired here are admin-only and
 * bouncing a dev token away is the correct behaviour.
 *
 * Usage:
 *
 * ```ts
 * {
 *   path: 'kill-switches',
 *   canActivate: [requireRoles('Operator', 'Admin')],
 *   loadChildren: () => …,
 * }
 * ```
 *
 * Denied navigations land on `/dashboard` with a toast — a plain redirect is
 * cheaper than an intermediate "forbidden" page and matches how the engine
 * responds to unauthorized API calls (403 + JSON body).
 */
export function requireRoles(...roles: Role[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const notifications = inject(NotificationService);

    const mine = auth.roles();
    if (mine.some((r) => roles.includes(r as Role))) return true;

    notifications.error(
      `This page requires one of: ${roles.join(', ')}. Ask an Admin to grant the role.`,
    );
    return router.createUrlTree(['/dashboard']);
  };
}
