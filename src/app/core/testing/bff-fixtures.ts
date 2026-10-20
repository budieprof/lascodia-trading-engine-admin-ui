import type { BffSession } from '@core/auth/bff.types';

/** A signed-in BFF session payload (contract C3.1) for specs. */
export function bffSession(over: Partial<BffSession> = {}): BffSession {
  return {
    user: { id: 12, username: 'ada', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    activeTenant: { id: 3, slug: 'acme', name: 'Acme', kind: 'Customer' },
    memberships: [
      { tenantId: 1, slug: 'house', name: 'House', status: 'Active' },
      { tenantId: 3, slug: 'acme', name: 'Acme', status: 'Active' },
    ],
    permissions: ['orders.read', 'iam.members.read'],
    isPlatformStaff: false,
    impersonation: null,
    csrfToken: 'csrf-1',
    mfa: { satisfied: true, authTimeUtc: new Date().toISOString() },
    sessionId: '77',
    expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    idleTimeoutSeconds: 3600,
    ...over,
  };
}

