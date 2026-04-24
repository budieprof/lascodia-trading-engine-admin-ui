// Minimal JWT payload decoder for reading role/account claims client-side.
// Does NOT validate the signature — that's the API's job — so callers must
// treat the returned object as informational only.

export interface JwtPayload {
  // Standard claim names we care about.
  sub?: string;
  jti?: string;
  exp?: number;
  iat?: number;
  // Application-specific claims.
  tradingAccountId?: string;
  accountType?: string;
  // Microsoft .NET bakes role claims into the long URL below; JWTs also often
  // carry a plain `role` or `roles` claim, so we read all three.
  role?: string | string[];
  roles?: string | string[];
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'?: string | string[];
  [k: string]: unknown;
}

/**
 * Decodes the payload segment of a JWT. Returns `null` for malformed tokens.
 * Safe to call with an untrusted string — never throws.
 */
export function decodeJwt(token: string | null): JwtPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (payload.length % 4)) % 4);
    const json = atob(payload + padding);
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Extracts the union of role claims from a decoded payload. Returns an empty
 * list when no role claim is present — callers should then decide whether to
 * treat missing roles as "no access" (strict mode) or "full access" (legacy
 * dev-token mode).
 */
export function rolesFromPayload(payload: JwtPayload | null): string[] {
  if (!payload) return [];
  const raw = [
    payload.role,
    payload.roles,
    payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'],
  ];
  const flat: string[] = [];
  for (const r of raw) {
    if (!r) continue;
    if (Array.isArray(r)) flat.push(...r);
    else flat.push(r);
  }
  return Array.from(new Set(flat.filter((s) => typeof s === 'string' && s.length > 0)));
}
