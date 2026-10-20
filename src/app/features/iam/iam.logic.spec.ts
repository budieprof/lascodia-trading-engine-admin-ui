import { describe, expect, it } from 'vitest';

import type { PermissionDefinition } from '@core/auth/permissions.generated';
import {
  canDecide,
  describeDevice,
  checkCidr,
  errorText,
  filterMembers,
  grantErrors,
  groupCatalog,
  invitationErrors,
  localToUtc,
  nextMemberStatus,
  parseAllowlist,
  roleErrors,
  scopeLabel,
  securityPolicyErrors,
  ssoErrors,
  staleGrantIds,
  toggled,
  tokenErrors,
  unknownKeys,
  unscopeableIn,
} from './iam.logic';
import { queryString, rows } from './iam-api.service';
import type { ApprovalRequest, IamMember, IamRole } from './iam.types';

const def = (key: string, category: string, over: Partial<PermissionDefinition> = {}): PermissionDefinition => ({
  key,
  category,
  description: key,
  scopeable: true,
  stepUp: false,
  twoPerson: false,
  deprecated: false,
  ...over,
});

describe('checkCidr (security policy allow-list)', () => {
  it('accepts IPv4 and IPv6 networks and single hosts', () => {
    expect(checkCidr('203.0.113.0/24')).toEqual({ ok: true, value: '203.0.113.0/24' });
    expect(checkCidr(' 198.51.100.7 ')).toEqual({ ok: true, value: '198.51.100.7/32' });
    expect(checkCidr('2001:db8::/32')).toEqual({ ok: true, value: '2001:db8::/32' });
    expect(checkCidr('::1')).toEqual({ ok: true, value: '::1/128' });
    expect(checkCidr('::ffff:192.0.2.0/120')).toEqual({ ok: true, value: '::ffff:192.0.2.0/120' });
    expect(checkCidr('0.0.0.0/0').ok).toBe(true);
  });

  it('refuses malformed input in plain words', () => {
    expect(checkCidr('')).toMatchObject({ ok: false });
    expect(checkCidr('256.1.1.1')).toMatchObject({ ok: false, error: expect.stringContaining('not an IP') });
    expect(checkCidr('10.0.0.1/33')).toMatchObject({ ok: false, error: expect.stringContaining('0–32') });
    expect(checkCidr('10.0.0.0/8/1')).toMatchObject({ ok: false });
    expect(checkCidr('010.0.0.1')).toMatchObject({ ok: false });
    expect(checkCidr('2001:db8:::1')).toMatchObject({ ok: false });
    expect(checkCidr('1:2:3:4:5:6:7:8:9')).toMatchObject({ ok: false });
    expect(checkCidr('example.com')).toMatchObject({ ok: false });
  });

  it('refuses host bits and suggests the network meant', () => {
    expect(checkCidr('10.0.0.5/8')).toEqual({
      ok: false,
      error: '"10.0.0.5/8" has host bits set — did you mean 10.0.0.0/8?',
    });
    expect(checkCidr('2001:db8::1/64')).toEqual({
      ok: false,
      error: '"2001:db8::1/64" has host bits set — did you mean 2001:db8::/64?',
    });
  });

  it('parses a list, dropping duplicates and collecting every error', () => {
    expect(parseAllowlist('10.0.0.0/8\n10.0.0.0/8, 192.168.1.1\n\nnope')).toEqual({
      entries: ['10.0.0.0/8', '192.168.1.1/32'],
      errors: ['"nope" is not an IP address.'],
    });
  });
});

describe('securityPolicyErrors', () => {
  const ok = { mfaRequired: true, sessionIdleMinutes: 60, sessionAbsoluteHours: 12, ipAllowlist: [] };
  it('accepts sane lifetimes', () => expect(securityPolicyErrors(ok)).toEqual([]));
  it('refuses zero, fractions and an idle timeout longer than the session', () => {
    expect(securityPolicyErrors({ ...ok, sessionIdleMinutes: 0 })).toHaveLength(1);
    expect(securityPolicyErrors({ ...ok, sessionAbsoluteHours: 1.5 })).toHaveLength(1);
    expect(securityPolicyErrors({ ...ok, sessionIdleMinutes: 121, sessionAbsoluteHours: 2 })).toEqual([
      'The idle timeout cannot be longer than the whole session.',
    ]);
  });
});

describe('catalog grouping', () => {
  const catalog = [
    def('orders.read', 'Orders'),
    def('access.viewer', 'Access tier', { deprecated: true }),
    def('orders.create', 'Orders'),
    def('access.admin', 'Access tier', { deprecated: true }),
    def('audit.read', 'Audit', { scopeable: false }),
  ];

  it('groups by category with keys sorted', () => {
    expect(groupCatalog(catalog).map((g) => [g.category, g.permissions.map((p) => p.key)])).toEqual([
      ['Access tier', ['access.admin', 'access.viewer']],
      ['Audit', ['audit.read']],
      ['Orders', ['orders.create', 'orders.read']],
    ]);
  });

  it('keeps keys the console does not know visible', () => {
    expect(unknownKeys(['orders.read', 'zeta.new', 'alpha.new'], catalog)).toEqual(['alpha.new', 'zeta.new']);
  });

  it('flags role permissions that only apply organisation-wide', () => {
    const role = { id: 1, name: 'Auditor', permissions: ['audit.read', 'orders.read'], isSystem: false } as IamRole;
    expect(unscopeableIn(role, 'TradingAccount', catalog)).toEqual(['audit.read']);
    expect(unscopeableIn(role, 'Tenant', catalog)).toEqual([]);
    expect(unscopeableIn(null, 'Strategy', catalog)).toEqual([]);
  });
});

describe('roleErrors', () => {
  const existing = [{ id: 1, name: 'Desk Lead', permissions: [], isSystem: false } as IamRole];
  it('needs a unique name and at least one permission', () => {
    expect(roleErrors('', [], existing, null)).toEqual(['Give the role a name.', 'Choose at least one permission.']);
    expect(roleErrors('desk lead', ['orders.read'], existing, null)).toEqual([
      'A role called "desk lead" already exists in this organisation.',
    ]);
    expect(roleErrors('Desk Lead', ['orders.read'], existing, 1)).toEqual([]);
  });
});

describe('grants', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const draft = { principalId: 4, roleId: 2, scopeType: 'Tenant' as const, scopeId: null, expiresLocal: '', reason: '' };

  it('labels scopes plainly', () => {
    expect(scopeLabel('Tenant', null)).toBe('Whole organisation');
    expect(scopeLabel('TradingAccount', 18, 'IC Markets 18')).toBe('Trading account IC Markets 18');
    expect(scopeLabel('Strategy', 9)).toBe('Strategy #9');
  });

  it('validates who, what, where and when', () => {
    expect(grantErrors(draft, now)).toEqual([]);
    expect(grantErrors({ ...draft, principalId: null, roleId: null }, now)).toEqual([
      'Choose who gets the role.',
      'Choose a role.',
    ]);
    expect(grantErrors({ ...draft, scopeType: 'AccountGroup' }, now)).toEqual(['Choose what the role applies to.']);
    expect(grantErrors({ ...draft, expiresLocal: '2026-10-19T10:00' }, now)).toEqual([
      'The expiry must be in the future.',
    ]);
  });

  it('converts a local expiry to UTC', () => {
    expect(localToUtc('')).toBeNull();
    expect(localToUtc('2026-12-01T09:30')).toBe(new Date('2026-12-01T09:30').toISOString());
  });
});

describe('invitations', () => {
  it('needs an address and complete role rows', () => {
    expect(invitationErrors('ada@example.com', [{ roleId: 2, scopeType: 'Tenant', scopeId: null }])).toEqual([]);
    expect(invitationErrors('nope', [])).toEqual([
      'Enter the e-mail address of the person to invite.',
      'Give the person at least one role.',
    ]);
    expect(invitationErrors('a@b.co', [{ roleId: 0, scopeType: 'TradingAccount', scopeId: null }])).toEqual([
      'Role 1: choose a role.',
      'Role 1: choose what it applies to.',
    ]);
  });
});

describe('members', () => {
  const members = [
    { userId: 2, username: 'zed', displayName: 'Zed', email: 'zed@x.io', status: 'Active' },
    { userId: 1, username: 'ada', displayName: 'Ada', email: 'ada@x.io', status: 'Suspended' },
  ] as IamMember[];

  it('offers the right status change', () => {
    expect(nextMemberStatus('Active')).toEqual({ to: 'Suspended', label: 'Suspend' });
    expect(nextMemberStatus('Suspended')).toEqual({ to: 'Active', label: 'Reactivate' });
    expect(nextMemberStatus('Invited')).toBeNull();
  });

  it('filters by name, username or e-mail', () => {
    expect(filterMembers(members, '').map((m) => m.username)).toEqual(['ada', 'zed']);
    expect(filterMembers(members, 'ZED@').map((m) => m.username)).toEqual(['zed']);
  });
});

describe('access review and tokens', () => {
  it('selects every stale grant and toggles selections', () => {
    const entries = [
      { grantId: 1, stale: true },
      { grantId: 2, stale: false },
      { grantId: 3, stale: true },
    ] as never[];
    expect(staleGrantIds(entries)).toEqual([1, 3]);
    expect([...toggled(new Set([1, 3]), 3)]).toEqual([1]);
    expect([...toggled(new Set([1]), 2)]).toEqual([1, 2]);
  });

  it('keeps a token within what the session holds', () => {
    const held = new Set(['orders.read', 'signals.read']);
    expect(tokenErrors('CI export', ['orders.read'], 30, held)).toEqual([]);
    expect(tokenErrors(' ', [], 0, held)).toEqual([
      'Name the token after what will use it.',
      'Choose at least one permission.',
      'A token lasts 1–365 days.',
    ]);
    expect(tokenErrors('x', ['orders.read', 'users.manage'], 400, held)).toEqual([
      'You do not hold: users.manage.',
      'A token lasts 1–365 days.',
    ]);
  });
});

describe('API helpers', () => {
  it('reads any list shape', () => {
    expect(rows([1, 2])).toEqual([1, 2]);
    expect(rows({ data: [3] })).toEqual([3]);
    expect(rows({ items: [4] })).toEqual([4]);
    expect(rows(null)).toEqual([]);
    expect(rows({ pager: {} })).toEqual([]);
  });

  it('builds query strings from set fields only', () => {
    expect(queryString({ principalType: 'User', principalId: 4, scopeId: null, x: '' })).toBe(
      '?principalType=User&principalId=4',
    );
    expect(queryString({})).toBe('');
  });

  it('prefers the engine’s message for errors', () => {
    expect(errorText({ error: { message: 'Last owner' } }, 'x')).toBe('Last owner');
    expect(errorText({ message: 'Http failure response for …' }, 'Could not save.')).toBe('Could not save.');
    expect(errorText(null, 'fallback')).toBe('fallback');
  });
});

describe('ssoErrors', () => {
  const oidc = {
    protocol: 'oidc' as const,
    displayName: 'Acme Okta',
    issuerOrMetadataUrl: 'https://acme.okta.com',
    clientId: 'console',
    clientSecret: 's3cret',
    domains: ['acme.com'],
    enabled: true,
  };
  it('accepts a complete OIDC connection, and a stored secret left blank', () => {
    expect(ssoErrors(oidc, false)).toEqual([]);
    expect(ssoErrors({ ...oidc, clientSecret: null }, true)).toEqual([]);
  });
  it('needs https, a client id and secret for OIDC, and real domains when switched on', () => {
    expect(ssoErrors({ ...oidc, issuerOrMetadataUrl: 'http://acme.okta.com' }, false)).toEqual([
      'The issuer / metadata URL must use https.',
    ]);
    expect(ssoErrors({ ...oidc, clientId: '', clientSecret: null }, false)).toEqual([
      'Enter the client id the identity provider gave you.',
      'Enter the client secret.',
    ]);
    expect(ssoErrors({ ...oidc, domains: [] }, false)).toEqual([
      'Add at least one e-mail domain to route to this connection.',
    ]);
    expect(ssoErrors({ ...oidc, domains: ['not a domain'] }, false)).toEqual(['Not e-mail domains: not a domain.']);
  });
  it('does not ask SAML for a client id or secret', () => {
    expect(
      ssoErrors({ ...oidc, protocol: 'saml', clientId: '', clientSecret: null, issuerOrMetadataUrl: 'https://idp/metadata' }, false),
    ).toEqual([]);
  });
});

describe('canDecide (two-person approvals)', () => {
  const r = { id: 1, actionKey: 'engine.killswitch.release', status: 'Pending', requestedByUserId: 7, expiresAtUtc: new Date(Date.now() + 3600_000).toISOString() } as ApprovalRequest;
  it('lets another person decide a pending request', () => expect(canDecide(r, 8)).toEqual({ ok: true, why: '' }));
  it('never lets the requester approve their own', () => expect(canDecide(r, 7).ok).toBe(false));
  it('refuses decided or expired requests', () => {
    expect(canDecide({ ...r, status: 'Approved' }, 8).ok).toBe(false);
    expect(canDecide({ ...r, expiresAtUtc: '2020-01-01T00:00:00Z' }, 8).ok).toBe(false);
  });
});

describe('describeDevice', () => {
  it('names browser and platform', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0')).toBe('Edge on Windows');
    expect(describeDevice('curl/8.4.0')).toBe('curl/8.4.0');
    expect(describeDevice(null)).toBe('Unknown device');
  });
});
