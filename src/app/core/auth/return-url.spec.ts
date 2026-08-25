import { describe, expect, it } from 'vitest';
import {
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
