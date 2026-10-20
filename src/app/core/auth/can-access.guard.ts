import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { NotificationService } from '@core/notifications/notification.service';
import { AuthService } from './auth.service';
import type { PermissionKey } from './permissions.generated';
import {
  ROUTE_ACCESS,
  landingFor,
  satisfies,
  type AccessPath,
  type RouteRule,
} from './route-access';

function guard(r: RouteRule): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const who = auth.accessSubject();
    if (satisfies(r, who)) return true;

    const landing = landingFor(who);
    // The default redirect ('' → dashboard) is not something the person asked for: no toast then.
    if (!state.url.startsWith('/dashboard')) {
      inject(NotificationService).error('You do not have access to that page.');
    }
    return inject(Router).createUrlTree([landing]);
  };
}

/**
 * Route guard: the person holds at least one of the keys in the active organisation. The engine
 * remains the enforcer — this keeps people off pages whose every request would be refused.
 *
 * ```ts
 * { path: 'admin/users', canActivate: [canAccess(Permission.UsersManage)], … }
 * ```
 */
export function canAccess(...anyOf: PermissionKey[]): CanActivateFn {
  return guard({ anyOf });
}

/**
 * Route guard from the route table ({@link ROUTE_ACCESS}) — the same rule the sidebar uses to show
 * the page. Prefer this for any page that has a sidebar entry.
 */
export function canAccessPath(path: AccessPath): CanActivateFn {
  return guard(ROUTE_ACCESS[path]);
}
