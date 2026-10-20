import type { AccessElevation, CreateTenantBody, TenantDto } from '@features/iam/iam.types';
import { MAX_ELEVATION_MINUTES } from '@features/iam/iam.types';

/** Slugs the engine reserves (mirror of t2-core `TenantSlug.Reserved`; the engine has the final say). */
const RESERVED = new Set(['house', 'platform', 'admin', 'api', 'system', 'root', 'public', 'internal', 'lascodia']);

/** Same rule as the engine's `TenantSlug.IsWellFormed`: 3–63 of a-z 0-9 -, starting and ending alphanumeric. */
export function slugErrors(slug: string): string[] {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(s)) {
    return ['Slug must be 3–63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.'];
  }
  if (RESERVED.has(s)) return ['That slug is reserved.'];
  return [];
}

/** Problems with a new organisation before it is sent. */
export function tenantErrors(b: CreateTenantBody): string[] {
  const errors = slugErrors(b.slug);
  if (!b.name.trim()) errors.push('Give the organisation a name.');
  else if (b.name.trim().length > 128) errors.push('Names are at most 128 characters.');
  if (b.kind !== 'Customer' && b.kind !== 'Canary') errors.push('An organisation is a Customer or a Canary.');
  return errors;
}

/** What may be done to an organisation's status. House is never suspended; Closed is final. */
export function tenantStatusAction(t: TenantDto): 'suspend' | 'reactivate' | null {
  if (t.kind === 'House' || t.status === 'Closed') return null;
  if (t.status === 'Active') return 'suspend';
  if (t.status === 'Suspended') return 'reactivate';
  return null;
}

/** Problems with an elevation request before it is sent (contract C3.5: minutes ≤ 240). */
export function elevationErrors(tenantId: number | null, reason: string, minutes: number, permissions: readonly string[]): string[] {
  const errors: string[] = [];
  if (!tenantId) errors.push('Choose the organisation.');
  if (reason.trim().length < 10) errors.push('Say why you need access (at least 10 characters) — it goes into that organisation’s audit log.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ELEVATION_MINUTES) {
    errors.push(`Access lasts 1–${MAX_ELEVATION_MINUTES} minutes.`);
  }
  if (permissions.length === 0) errors.push('Choose the permissions you need.');
  return errors;
}

/** Actions open to this person on an elevation. */
export function elevationActions(
  e: AccessElevation,
  myUserId: number | null,
  canApprove: boolean,
): { approve: boolean; end: boolean; open: boolean } {
  const mine = myUserId !== null && e.staffUserId === myUserId;
  return {
    approve: e.status === 'Pending' && canApprove && !mine,
    end: e.status === 'Active' || (e.status === 'Pending' && mine),
    open: e.status === 'Active' && mine,
  };
}
