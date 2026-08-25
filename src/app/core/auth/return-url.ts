/**
 * Return-URL handling for session-expiry re-login.
 *
 * When a session dies under the user — token past its refresh grace window,
 * jti revoked, account deactivated — the app drops them on /login. Sending
 * them to /dashboard afterwards loses their place, which is worst precisely
 * where it hurts most: a deep page they had navigated to deliberately
 * (an EA instance, a conversation thread, a filtered signal list).
 *
 * The captured path travels as a `returnUrl` query param on /login, which is
 * the Angular idiom and survives a full reload of the login page.
 *
 * SECURITY: a query param is attacker-supplied input. Anyone can hand a user
 * a link to `/login?returnUrl=https://evil.example/harvest`, and if the app
 * navigates there after a successful login the user arrives at a hostile page
 * carrying the trust of having just authenticated. Every read goes through
 * {@link sanitizeReturnUrl}, which accepts only same-origin absolute paths.
 */

/** Where we land when there is no usable return URL. */
export const DEFAULT_POST_LOGIN_ROUTE = '/dashboard';

/** Query-param name carried on /login. */
export const RETURN_URL_PARAM = 'returnUrl';

/**
 * Routes that must never be captured as a return target.
 *
 * - `/login` would bounce the user straight back to the login page.
 * - `/account/change-password` is a forced interstitial owned by
 *   mustChangePasswordGuard; returning to it would strand a user who has
 *   already satisfied it.
 */
const NON_RETURNABLE = ['/login', '/account/change-password'];

/**
 * Reduce an untrusted candidate to a safe in-app path, or null.
 *
 * Accepts only a path that:
 *  - is a non-empty string within a sane length bound,
 *  - starts with a single `/` — rejecting `//evil.com` (protocol-relative,
 *    which browsers resolve to a DIFFERENT ORIGIN) and any bare or absolute
 *    URL such as `https://evil.com`,
 *  - contains no scheme separator or backslash, closing off `/\evil.com`
 *    and `/javascript:...` style payloads that some routers normalise,
 *  - is not itself a non-returnable route.
 */
export function sanitizeReturnUrl(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;

  const url = candidate.trim();
  if (url.length === 0 || url.length > 2048) return null;

  // Must be an absolute in-app path. A leading `//` is protocol-relative and
  // resolves off-origin, so it is rejected along with everything non-rooted.
  if (!url.startsWith('/') || url.startsWith('//')) return null;

  // Backslashes are normalised to `/` by some user agents, so `/\evil.com`
  // can become `//evil.com`. A colon would mean an embedded scheme.
  if (url.includes('\\') || url.includes(':')) return null;

  // Compare on the path only — a match must not be defeated by a query string
  // or fragment (`/login?x=1`).
  const path = url.split(/[?#]/)[0];
  if (NON_RETURNABLE.some((r) => path === r || path.startsWith(`${r}/`))) return null;

  return url;
}

/**
 * Build the query-param bag for a /login redirect. Returns an empty object
 * when the candidate is unusable, so the caller can spread it unconditionally
 * and simply not add the param.
 */
export function returnUrlQueryParams(candidate: string | null | undefined): Record<string, string> {
  const safe = sanitizeReturnUrl(candidate);
  return safe ? { [RETURN_URL_PARAM]: safe } : {};
}
