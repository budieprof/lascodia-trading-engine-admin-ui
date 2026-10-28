import { describe, expect, it } from 'vitest';

import {
  accessRequestMailto,
  accessRequestProblems,
  canDecide,
  isPlausibleEmail,
  isValidSlug,
  progressText,
  signupProblems,
  signupRefusal,
  signupStatusLabel,
  signupTone,
  slugFrom,
} from './onboarding.logic';
import type { TenantSignup } from './onboarding.types';

function signup(over: Partial<TenantSignup> = {}): TenantSignup {
  return {
    id: 1,
    email: 'alice@acme.example',
    displayName: 'Alice',
    organisationName: 'Acme',
    organisationSlug: 'acme',
    status: 'Pending',
    requiresApproval: true,
    requestedAtUtc: '2026-10-20T09:00:00Z',
    requestIp: '203.0.113.7',
    expiresAtUtc: '2026-11-03T09:00:00Z',
    expired: false,
    emailVerifiedAtUtc: null,
    verificationEmailsSent: 1,
    approvedAtUtc: null,
    rejectedAtUtc: null,
    decisionNote: null,
    tenantId: null,
    provisionedAtUtc: null,
    ...over,
  };
}

describe('handles', () => {
  // The same cases as the engine's TenantSignupTests.A_handle_is_made_from_the_organisations_name.
  it.each([
    ['Acme Trading, Ltd.', 'acme-trading-ltd'],
    ['  ÉLAN  ', 'lan'],
    ['House', 'house-org'],
    ['AB', 'ab-org'],
  ])('%s → %s', (name, slug) => {
    expect(slugFrom(name)).toBe(slug);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('refuses reserved and malformed handles', () => {
    expect(isValidSlug('house')).toBe(false);
    expect(isValidSlug('-acme')).toBe(false);
    expect(isValidSlug('ac')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
  });
});

describe('the form', () => {
  it('checks addresses like the engine', () => {
    expect(isPlausibleEmail('alice@example.com')).toBe(true);
    expect(isPlausibleEmail('alice@localhost')).toBe(false);
    expect(isPlausibleEmail('alice@@example.com')).toBe(false);
    expect(isPlausibleEmail('al ice@example.com')).toBe(false);
    expect(isPlausibleEmail('@example.com')).toBe(false);
  });

  it('lists what is missing', () => {
    expect(
      signupProblems({
        email: 'a@b.co',
        displayName: 'A',
        organisationName: 'Acme',
        organisationSlug: null,
      }),
    ).toEqual([]);
    expect(
      signupProblems({
        email: 'nope',
        displayName: ' ',
        organisationName: 'A',
        organisationSlug: 'House',
      }),
    ).toHaveLength(4);
  });

  it('turns refusals into plain words', () => {
    expect(signupRefusal('-429', null)).toContain('tomorrow');
    expect(signupRefusal('-503', null)).toContain('not available');
    expect(signupRefusal('-409', "The handle 'acme' is taken; choose another.")).toContain('taken');
  });
});

describe('the approval queue', () => {
  it('labels each state, verified or not', () => {
    expect(signupStatusLabel(signup())).toBe('Waiting for e-mail verification');
    expect(signupStatusLabel(signup({ emailVerifiedAtUtc: '2026-10-20T10:00:00Z' }))).toBe(
      'Verified — waiting for approval',
    );
    expect(signupStatusLabel(signup({ status: 'Provisioned', tenantId: 9 }))).toBe(
      'Organisation created',
    );
    expect(signupStatusLabel(signup({ expired: true }))).toContain('Lapsed');
    expect(signupTone(signup({ status: 'Rejected' }))).toBe('bad');
    expect(signupTone(signup({ emailVerifiedAtUtc: 'x' }))).toBe('info');
  });

  it('decides only open requests; approves only pending ones', () => {
    expect(canDecide(signup())).toEqual({ approve: true, reject: true });
    expect(canDecide(signup({ status: 'Approved' }))).toEqual({ approve: false, reject: true });
    expect(canDecide(signup({ status: 'Provisioned' }))).toEqual({ approve: false, reject: false });
    expect(canDecide(signup({ expired: true }))).toEqual({ approve: false, reject: false });
  });

  it('says how far along the checklist is', () => {
    expect(progressText(1, 4)).toBe('1 of 4 done');
    expect(progressText(4, 4)).toBe('All done');
  });

  it('checks and composes an access request', () => {
    const blank = { name: '', email: '', organisation: '', role: '', terminals: '', message: '' };
    expect(accessRequestProblems(blank)).toHaveLength(3);
    const req = {
      ...blank,
      name: ' Ada ',
      email: 'ada@example.com',
      organisation: 'Ada & Co',
      role: 'A prop firm',
    };
    expect(accessRequestProblems(req)).toEqual([]);
    const href = accessRequestMailto('sales@example.com', req);
    expect(href).toMatch(
      /^mailto:sales@example\.com\?subject=Access%20request%3A%20Ada%20%26%20Co&body=/,
    );
    const body = decodeURIComponent(href.split('&body=')[1]);
    expect(body).toContain('Name: Ada\r\n');
    expect(body).toContain('I am: A prop firm');
    expect(body).not.toContain('terminals');
  });
});
