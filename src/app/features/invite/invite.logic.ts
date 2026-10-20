import type { BffMembership } from '@core/auth/bff.types';

/** An invitation token as it may appear in a link (base64url / hex; bounded). */
export function isPlausibleInviteToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(token);
}

/** Organisations that became available by accepting (active now, not active before). */
export function newlyActive(
  before: readonly BffMembership[],
  after: readonly BffMembership[],
): BffMembership[] {
  const was = new Set(before.filter((m) => m.status === 'Active').map((m) => m.tenantId));
  return after.filter((m) => m.status === 'Active' && !was.has(m.tenantId));
}
