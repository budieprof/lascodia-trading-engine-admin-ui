import { describe, expect, it } from 'vitest';
import {
  captureReturnUrl,
  DEFAULT_POST_LOGIN_ROUTE,
  RETURN_URL_PARAM,
  returnUrlQueryParams,
  sanitizeReturnUrl,
} from './return-url';

describe('sanitizeReturnUrl', () => {
  describe('accepts in-app paths', () => {
    it.each([
      '/dashboard',
      '/ea-instances',
      '/ea-instances/49',
      '/conversations/19140',
      '/signals?status=pending&symbol=EURUSD',
      '/news-intel#gbp',
      '/a/deeply/nested/route',
    ])('keeps %s', (url) => {
      expect(sanitizeReturnUrl(url)).toBe(url);
    });

    it('trims surrounding whitespace', () => {
      expect(sanitizeReturnUrl('  /dashboard  ')).toBe('/dashboard');
    });
  });

  describe('rejects off-origin targets', () => {
    // The param is attacker-supplied: anyone can send an operator a link to
    // /login?returnUrl=<hostile>. Navigating there after a successful login
    // delivers the user to that page with the trust of having just
    // authenticated, so each of these must fall back to the default route.
    it.each([
      ['protocol-relative', '//evil.example/harvest'],
      ['protocol-relative with path', '//evil.example'],
      ['absolute https', 'https://evil.example'],
      ['absolute http', 'http://evil.example/x'],
      ['scheme-ish', 'javascript:alert(1)'],
      ['embedded scheme after slash', '/redirect?next=https://evil.example'],
      ['backslash escape', '/\\evil.example'],
      ['bare host', 'evil.example/path'],
      ['relative', 'dashboard'],
      ['empty', ''],
      ['whitespace only', '   '],
    ])('rejects %s', (_label, url) => {
      expect(sanitizeReturnUrl(url)).toBeNull();
    });

    it('rejects an over-long value', () => {
      expect(sanitizeReturnUrl(`/${'a'.repeat(4000)}`)).toBeNull();
    });
  });

  describe('rejects non-returnable routes', () => {
    // Returning to /login would bounce straight back to the login page;
    // returning to the forced change-password interstitial would strand a
    // user who has already satisfied it.
    it.each([
      '/login',
      '/login?returnUrl=/dashboard',
      '/account/change-password',
      '/account/change-password?forced=1',
    ])('rejects %s', (url) => {
      expect(sanitizeReturnUrl(url)).toBeNull();
    });

    it('does not reject a route that merely starts with the same text', () => {
      // /logins is a different route from /login and must survive.
      expect(sanitizeReturnUrl('/logins')).toBe('/logins');
    });
  });

  describe('handles non-string input', () => {
    it.each([null, undefined])('rejects %s', (value) => {
      expect(sanitizeReturnUrl(value)).toBeNull();
    });
  });
});

describe('captureReturnUrl', () => {
  it('captures the route the user was standing on', () => {
    expect(captureReturnUrl('/ea-instances/49')).toBe('/ea-instances/49');
  });

  describe('survives a repeated teardown', () => {
    // A dead session takes down every request in flight, not just one, so
    // logout() runs several times. The later runs see /login as the current
    // URL; if they resolved to "no target" the redirect would replace the
    // query string and wipe the target captured by the first run.
    it('recovers a target already stashed on /login', () => {
      expect(captureReturnUrl('/login?returnUrl=%2Fea-instances%2F49')).toBe('/ea-instances/49');
    });

    it('is idempotent — re-capturing yields the same target', () => {
      const first = captureReturnUrl('/signals?status=pending');
      const second = captureReturnUrl(`/login?${RETURN_URL_PARAM}=${encodeURIComponent(first!)}`);
      expect(second).toBe(first);
    });

    it('keeps the returnUrl param across repeated redirects', () => {
      const first = returnUrlQueryParams('/conversations/19140');
      const second = returnUrlQueryParams(
        `/login?returnUrl=${encodeURIComponent('/conversations/19140')}`,
      );
      expect(second).toEqual(first);
    });

    it('preserves a target carrying its own query string', () => {
      const target = '/signals?status=pending&symbol=EURUSD';
      expect(captureReturnUrl(`/login?returnUrl=${encodeURIComponent(target)}`)).toBe(target);
    });

    it('ignores a fragment on the login URL itself', () => {
      expect(captureReturnUrl('/login?returnUrl=%2Fdashboard#top')).toBe('/dashboard');
    });
  });

  describe('does not trust the recovered value', () => {
    // The stash is readable and writable by anyone who can hand the user a
    // link, so recovery re-runs the same sanitisation as first capture.
    it.each([
      ['absolute url', '/login?returnUrl=https%3A%2F%2Fevil.example'],
      ['protocol-relative', '/login?returnUrl=%2F%2Fevil.example'],
      ['nested login', '/login?returnUrl=%2Flogin'],
      ['empty param', '/login?returnUrl='],
    ])('rejects %s', (_label, url) => {
      expect(captureReturnUrl(url)).toBeNull();
    });

    it('only reads the stash from the login route', () => {
      // Another page may legitimately use a `returnUrl` param of its own; it
      // is not ours to promote into a post-login destination. The page URL
      // itself is the capture, and it is returnable on its own merits.
      expect(captureReturnUrl('/wizard?returnUrl=%2Fdashboard')).toBe(
        '/wizard?returnUrl=%2Fdashboard',
      );
    });
  });

  it('has nothing to recover from a bare /login', () => {
    expect(captureReturnUrl('/login')).toBeNull();
  });

  it.each([null, undefined])('rejects %s', (value) => {
    expect(captureReturnUrl(value)).toBeNull();
  });
});

describe('returnUrlQueryParams', () => {
  it('emits the param for a safe path', () => {
    expect(returnUrlQueryParams('/ea-instances/49')).toEqual({
      [RETURN_URL_PARAM]: '/ea-instances/49',
    });
  });

  it('emits nothing for an unsafe path, so /login stays clean', () => {
    expect(returnUrlQueryParams('//evil.example')).toEqual({});
  });

  it('emits nothing when there is no candidate', () => {
    expect(returnUrlQueryParams(null)).toEqual({});
  });

  it('emits nothing when the user was already on /login', () => {
    expect(returnUrlQueryParams('/login')).toEqual({});
  });
});

describe('DEFAULT_POST_LOGIN_ROUTE', () => {
  it('is a safe in-app path', () => {
    expect(sanitizeReturnUrl(DEFAULT_POST_LOGIN_ROUTE)).toBe(DEFAULT_POST_LOGIN_ROUTE);
  });
});
