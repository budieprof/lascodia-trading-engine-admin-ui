import { signal, type Provider } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';

/**
 * A signed-in person holding exactly `permissions`, for component specs. Since the "no roles = full
 * access" fallback is gone, a spec that renders operator or analyst controls must say the viewer
 * holds those permissions — a spec without a session sees what a real person without permissions
 * would see: nothing privileged.
 */
export function provideAuthWithPermissions(...permissions: string[]): Provider {
  const held = new Set(permissions);
  const has = (key: string) => held.has(key);
  const fake: Partial<Record<keyof AuthService, unknown>> = {
    mode: 'legacy',
    isAuthenticated: signal(true).asReadonly(),
    user: signal({ passportId: '1', firstName: 'Test', lastName: 'User', email: 'test@example.com' }).asReadonly(),
    roles: signal<readonly string[]>([]).asReadonly(),
    permissions: signal<readonly string[]>([...held]).asReadonly(),
    session: signal(null).asReadonly(),
    token: signal(null).asReadonly(),
    isSuperAdmin: signal(false).asReadonly(),
    mustChangePassword: signal(false).asReadonly(),
    activeTenant: signal(null).asReadonly(),
    memberships: signal([]).asReadonly(),
    impersonation: signal(null).asReadonly(),
    isPlatformStaff: signal(false).asReadonly(),
    hasPermission: has,
    hasAnyPermission: (keys: readonly string[]) => keys.length === 0 || keys.some(has),
    canSeePath: () => true,
    getToken: () => null,
    csrfHeaders: () => ({}),
  };
  return { provide: AuthService, useValue: fake };
}
