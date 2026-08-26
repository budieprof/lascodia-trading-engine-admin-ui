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

/** The login route itself — the one page that stashes a return target. */
const LOGIN_ROUTE = '/login';

/**
 * Routes that must never be captured as a return target.
 *
 * - `/login` would bounce the user straight back to the login page.
 * - `/account/change-password` is a forced interstitial owned by
 *   mustChangePasswordGuard; returning to it would strand a user who has
 *   already satisfied it.
 */
const NON_RETURNABLE = [LOGIN_ROUTE, '/account/change-password'];

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
 * Choose the return target to stash on /login for a session that just died.
 *
 * Normally that is simply the route the user was standing on. The wrinkle is
 * that a teardown is not one event. A page under a dead session usually has
 * several requests in flight — pollers, dashboard widgets, realtime top-ups —
 * and each one that fails its refresh calls logout() again. By the second call
 * the app is already sitting on `/login?returnUrl=/ea-instances/49`, which
 * {@link sanitizeReturnUrl} rightly refuses as a return target, and a redirect
 * built from that empty result REPLACES the query string. The URL captured a
 * moment earlier is gone, the user logs in, and lands on the dashboard — the
 * exact failure this module exists to prevent, reintroduced by its own retry.
 *
 * So when the current URL is our own login route, recover the target already
 * captured there and carry it forward, which makes repeat teardowns idempotent
 * (the redirect URL stops changing, so Angular ignores the re-navigation and
 * the login form the user is typing into survives too).
 *
 * The recovered value is re-sanitised rather than trusted: a hand-crafted
 * `/login?returnUrl=https://evil.example` gains nothing by passing through here.
 */
export function captureReturnUrl(currentUrl: string | null | undefined): string | null {
  const direct = sanitizeReturnUrl(currentUrl);
  if (direct) return direct;
  return sanitizeReturnUrl(readStashedReturnUrl(currentUrl));
}

/**
 * Read the `returnUrl` param back out of a URL string, but only when that URL
 * is the login route — we recover what WE stashed, not a same-named param
 * belonging to some other page.
 */
function readStashedReturnUrl(currentUrl: string | null | undefined): string | null {
  if (typeof currentUrl !== 'string') return null;

  const queryStart = currentUrl.indexOf('?');
  if (queryStart === -1) return null;
  if (currentUrl.slice(0, queryStart) !== LOGIN_ROUTE) return null;

  // Drop any fragment before parsing — `?a=1#frag` would otherwise fold the
  // fragment into the last param's value.
  const query = currentUrl.slice(queryStart + 1).split('#')[0];
  return new URLSearchParams(query).get(RETURN_URL_PARAM);
}

/**
 * Build the query-param bag for a /login redirect. Returns an empty object
 * when there is no usable target, so the caller can spread it unconditionally
 * and simply not add the param.
 */
export function returnUrlQueryParams(candidate: string | null | undefined): Record<string, string> {
  const safe = captureReturnUrl(candidate);
  return safe ? { [RETURN_URL_PARAM]: safe } : {};
}
