import { describe, expect, it } from 'vitest';

import type { TradingAccountDto } from '@core/api/api.types';
import type { MachineCredential } from './organisation.types';
import {
  accountLabel,
  accountRefs,
  boundTo,
  credentialState,
  emptyEnrollmentDraft,
  enrollmentBody,
  enrollmentErrors,
  enrollmentSteps,
  groupCredentials,
  sinceText,
} from './terminals.logic';

const account = (id: number, over: Partial<TradingAccountDto> = {}): TradingAccountDto =>
  ({
    id,
    accountId: String(1000 + id),
    accountName: `Acct ${id}`,
    brokerServer: 'Broker-Demo',
    accountType: 'Demo',
    isPaper: false,
    ...over,
  }) as TradingAccountDto;

const cred = (id: number, over: Partial<MachineCredential> = {}): MachineCredential => ({
  id,
  kind: 'EaTerminal',
  instanceId: `LASC-${id}`,
  tradingAccountId: 1,
  origin: 'Enrollment',
  createdBy: 'admin:1',
  createdAtUtc: '2026-10-20T08:00:00Z',
  lastUsedAtUtc: '2026-10-20T09:00:00Z',
  lastUsedIp: '10.0.0.2',
  rotationRequestedAtUtc: null,
  rotationPending: false,
  replacesCredentialId: null,
  parentCredentialId: null,
  enrollmentTokenId: 3,
  terminalFingerprint: null,
  revokedAtUtc: null,
  revokedReason: null,
  revokedBy: null,
  ...over,
});

describe('enrollment draft', () => {
  it('needs a label', () => {
    expect(enrollmentErrors(emptyEnrollmentDraft())).toEqual([
      'Give the token a label, e.g. the host and chart it is for.',
    ]);
  });

  it('needs the account when bound to one, and both login and server when bound to a login', () => {
    const d = { ...emptyEnrollmentDraft(), label: 'mac2' };
    expect(enrollmentErrors({ ...d, binding: 'account' })).toEqual([
      'Choose the account the terminal trades.',
    ]);
    expect(enrollmentErrors({ ...d, binding: 'login', accountLogin: '123' })).toEqual([
      'Enter both the broker login and the broker server.',
    ]);
    expect(
      enrollmentErrors({ ...d, binding: 'login', accountLogin: '123', brokerServer: 'X-Demo' }),
    ).toEqual([]);
  });

  it('rejects over-long fields', () => {
    const errs = enrollmentErrors({
      ...emptyEnrollmentDraft(),
      label: 'x'.repeat(129),
      binding: 'login',
      accountLogin: '1'.repeat(101),
      brokerServer: 's'.repeat(201),
    });
    expect(errs).toHaveLength(3);
  });

  it('sends only what the binding needs, trimmed', () => {
    const base = { ...emptyEnrollmentDraft(), label: '  mac2 chart  ' };
    expect(enrollmentBody(base)).toEqual({ kind: 'EaTerminal', label: 'mac2 chart' });
    expect(enrollmentBody({ ...base, binding: 'account', tradingAccountId: 7 })).toEqual({
      kind: 'EaTerminal',
      label: 'mac2 chart',
      tradingAccountId: 7,
    });
    expect(
      enrollmentBody({ ...base, binding: 'login', accountLogin: ' 42 ', brokerServer: ' S ' }),
    ).toEqual({ kind: 'EaTerminal', label: 'mac2 chart', accountLogin: '42', brokerServer: 'S' });
  });

  it('never binds a daemon token to an account', () => {
    const d = {
      ...emptyEnrollmentDraft('Daemon'),
      label: 'host',
      binding: 'account' as const,
      tradingAccountId: 7,
    };
    expect(enrollmentErrors(d)).toEqual([]);
    expect(enrollmentBody(d)).toEqual({ kind: 'Daemon', label: 'host' });
  });
});

describe('accounts and bindings', () => {
  it('labels an account by name, login and server, and an unknown one by id', () => {
    const [a] = accountRefs([account(3)]);
    expect(accountLabel(a)).toBe('Acct 3 · 1003 @ Broker-Demo (Demo)');
    expect(accountLabel(undefined, 9)).toBe('Account #9');
    expect(accountLabel({ ...a, isPaper: true })).toContain('(Paper)');
  });

  it('says what a token connects', () => {
    const map = new Map(accountRefs([account(3)]).map((a) => [a.id, a]));
    const t = {
      kind: 'EaTerminal',
      tradingAccountId: null,
      accountLogin: null,
      brokerServer: null,
    };
    expect(boundTo(t, map)).toBe('Any account of this organisation');
    expect(boundTo({ ...t, tradingAccountId: 3 }, map)).toContain('Acct 3');
    expect(boundTo({ ...t, accountLogin: '55', brokerServer: 'B' }, map)).toBe('Login 55 @ B');
    expect(boundTo({ ...t, kind: 'Daemon' }, map)).toBe('A supervisor daemon');
  });
});

describe('credentials', () => {
  it('groups by account in id order, unknown accounts after, daemons last, newest first', () => {
    const accounts = accountRefs([account(2), account(1)]);
    const groups = groupCredentials(
      [
        cred(1, { tradingAccountId: 2 }),
        cred(2, { kind: 'Daemon', tradingAccountId: null }),
        cred(3, { tradingAccountId: 99 }),
        cred(4, { tradingAccountId: 1 }),
        cred(5, { tradingAccountId: 2 }),
      ],
      accounts,
    );
    expect(groups.map((g) => g.key)).toEqual(['account:1', 'account:2', 'account:99', 'daemons']);
    expect(groups[1].credentials.map((c) => c.id)).toEqual([5, 1]);
    expect(groups[2].title).toBe('Account #99');
    expect(groups[3].title).toBe('Supervisor daemons');
  });

  it('describes the state', () => {
    expect(credentialState(cred(1)).label).toBe('Active');
    expect(credentialState(cred(1, { lastUsedAtUtc: null })).label).toBe('Not used yet');
    expect(credentialState(cred(1, { rotationRequestedAtUtc: 'x' })).label).toBe(
      'Rotation requested',
    );
    expect(credentialState(cred(1, { rotationPending: true })).label).toBe('New secret handed out');
    expect(credentialState(cred(1, { revokedAtUtc: 'x', revokedReason: 'revoked' }))).toEqual({
      label: 'Revoked',
      tone: 'bad',
    });
    expect(credentialState(cred(1, { revokedAtUtc: 'x', revokedReason: 'replaced' })).label).toBe(
      'Replaced',
    );
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(sinceText(null, now)).toBe('never');
    expect(sinceText('2026-10-20T11:59:30Z', now)).toBe('just now');
    expect(sinceText('2026-10-20T11:55:00Z', now)).toBe('5 min ago');
    expect(sinceText('2026-10-20T09:00:00Z', now)).toBe('3 h ago');
    expect(sinceText('2026-10-17T12:00:00Z', now)).toBe('3 days ago');
    expect(sinceText('garbage', now)).toBe('—');
  });
});

describe('instructions', () => {
  const created = { token: 'lsc_enr_abcd1234_secret', expiresAtUtc: '2026-10-21T12:00:00Z' };

  it('tells an EA where the token goes, and what it is bound to', () => {
    const steps = enrollmentSteps({ ...created, kind: 'EaTerminal' }, 'Acct 3');
    const text = steps.map((s) => s.text).join(' ');
    expect(text).toContain('InpEnrollmentToken');
    expect(text).toContain('8.47.253');
    expect(text).toContain('only connects Acct 3');
    // The token itself is shown once, by the copy box above the steps.
    expect(steps.some((s) => s.code?.includes(created.token))).toBe(false);
  });

  it('gives a supervisor the yaml line and the restart, and says to remove it after', () => {
    const steps = enrollmentSteps({ ...created, kind: 'Daemon' });
    expect(steps[0].code).toBe(`enrollment_token: "${created.token}"`);
    expect(steps[1].code).toContain('launchctl kickstart');
    expect(steps.map((s) => s.text).join(' ')).toContain('Remove enrollment_token');
  });
});
