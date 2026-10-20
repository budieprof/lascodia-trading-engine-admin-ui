import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AUDIT_FILTERS,
  type AuditFilters,
  activeAuditFilterCount,
  actorLabel,
  aggregateCount,
  auditJsonDiff,
  auditQueryParams,
  outcomeTone,
  resourceLabel,
  toQueryString,
  validateAuditFilters,
  verificationBadge,
} from './audit-log.filters';
import type { AuditChainVerification } from './audit-log.types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const f = (patch: Partial<AuditFilters>): AuditFilters => ({ ...DEFAULT_AUDIT_FILTERS, ...patch });

describe('auditQueryParams', () => {
  it('sends only the default 7-day window when nothing else is set', () => {
    expect(auditQueryParams(DEFAULT_AUDIT_FILTERS, NOW)).toEqual({
      from: '2026-10-13T12:00:00.000Z',
    });
  });

  it('turns each preset into a "from" relative to now, and "all" into no time bound', () => {
    expect(auditQueryParams(f({ range: '1h' }), NOW)['from']).toBe('2026-10-20T11:00:00.000Z');
    expect(auditQueryParams(f({ range: '24h' }), NOW)['from']).toBe('2026-10-19T12:00:00.000Z');
    expect(auditQueryParams(f({ range: 'all' }), NOW)).toEqual({});
  });

  it('sends a custom range as UTC instants of the local inputs', () => {
    const params = auditQueryParams(f({ range: 'custom', from: '2026-10-01T09:30', to: '2026-10-02T09:30' }), NOW);
    expect(params['from']).toBe(new Date('2026-10-01T09:30').toISOString());
    expect(params['to']).toBe(new Date('2026-10-02T09:30').toISOString());
  });

  it('sends every set filter by its API name, trimmed, and leaves blanks out', () => {
    const params = auditQueryParams(
      f({
        range: 'all',
        actor: ' admin-user:5 ',
        actorType: 'User',
        action: 'iam.role.',
        category: 'Access',
        outcome: 'Denied',
        resourceType: 'Role',
        resourceId: '7',
        tenantId: '1',
      }),
      NOW,
    );
    expect(params).toEqual({
      actor: 'admin-user:5',
      actorType: 'User',
      action: 'iam.role.',
      category: 'Access',
      outcome: 'Denied',
      resourceType: 'Role',
      resourceId: '7',
      tenantId: '1',
    });
  });
});

describe('toQueryString', () => {
  it('encodes values and skips null, undefined and empty ones', () => {
    expect(toQueryString({ action: 'auth.', actor: 'a b&c', beforeId: null, limit: 50, x: undefined, y: '' })).toBe(
      '?action=auth.&actor=a%20b%26c&limit=50',
    );
    expect(toQueryString({})).toBe('');
  });
});

describe('validateAuditFilters', () => {
  it('accepts the defaults', () => expect(validateAuditFilters(DEFAULT_AUDIT_FILTERS)).toBeNull());

  it('refuses a tenant that is not a whole number', () => {
    expect(validateAuditFilters(f({ tenantId: 'abc' }))).toMatch(/whole number/);
    expect(validateAuditFilters(f({ tenantId: '-1' }))).toMatch(/whole number/);
    expect(validateAuditFilters(f({ tenantId: ' 12 ' }))).toBeNull();
  });

  it('needs at least one bound for a custom range, in the right order', () => {
    expect(validateAuditFilters(f({ range: 'custom' }))).toMatch(/start or an end/);
    expect(
      validateAuditFilters(f({ range: 'custom', from: '2026-10-02T00:00', to: '2026-10-01T00:00' })),
    ).toMatch(/before the end/);
    expect(validateAuditFilters(f({ range: 'custom', from: '2026-10-01T00:00' }))).toBeNull();
  });
});

describe('activeAuditFilterCount', () => {
  it('counts the filters that differ from the defaults', () => {
    expect(activeAuditFilterCount(DEFAULT_AUDIT_FILTERS)).toBe(0);
    expect(activeAuditFilterCount(f({ range: '24h', outcome: 'Denied', actor: '  ' }))).toBe(2);
  });
});

describe('auditJsonDiff', () => {
  it('lists added, removed and changed leaves by path, and hides unchanged ones', () => {
    const rows = auditJsonDiff(
      { name: 'Desk', description: 'old', permissions: ['orders.read'], gone: 1 },
      { name: 'Desk', description: 'new', permissions: ['orders.read', 'signals.read'], added: ['signals.read'] },
    );
    expect(rows).toEqual([
      { path: 'added', before: null, after: '["signals.read"]', change: 'added' },
      { path: 'description', before: 'old', after: 'new', change: 'changed' },
      { path: 'gone', before: '1', after: null, change: 'removed' },
      { path: 'permissions', before: '["orders.read"]', after: '["orders.read","signals.read"]', change: 'changed' },
    ]);
  });

  it('walks nested objects and can include unchanged leaves', () => {
    const rows = auditJsonDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }, true);
    expect(rows.map((r) => [r.path, r.change])).toEqual([
      ['a.b', 'same'],
      ['a.c', 'changed'],
    ]);
  });

  it('handles a missing side and bare values', () => {
    expect(auditJsonDiff(null, { value: '***SET' })).toEqual([
      { path: 'value', before: null, after: '***SET', change: 'added' },
    ]);
    expect(auditJsonDiff(undefined, undefined)).toEqual([]);
    expect(auditJsonDiff('x', 'y')).toEqual([{ path: '(value)', before: 'x', after: 'y', change: 'changed' }]);
  });

  it('keeps a JSON null distinct from a missing field', () => {
    expect(auditJsonDiff({ v: null }, {})).toEqual([{ path: 'v', before: 'null', after: null, change: 'removed' }]);
  });
});

describe('labels', () => {
  it('maps outcomes to tones', () => {
    expect(outcomeTone('Succeeded')).toBe('positive');
    expect(outcomeTone('Denied')).toBe('warning');
    expect(outcomeTone('Failed')).toBe('negative');
  });

  it('shows the actor name with its id, or the id alone', () => {
    expect(actorLabel({ actorDisplay: 'alice', actorId: 'admin-user:5' })).toBe('alice (admin-user:5)');
    expect(actorLabel({ actorDisplay: null, actorId: 'anonymous' })).toBe('anonymous');
  });

  it('shows the resource type and id', () => {
    expect(resourceLabel({ resourceType: 'Role', resourceId: '7' })).toBe('Role 7');
    expect(resourceLabel({ resourceType: null, resourceId: null })).toBe('—');
    expect(resourceLabel({ resourceType: 'AuditLog', resourceId: null })).toBe('AuditLog');
  });

  it('reads the occurrence count of an aggregated row only', () => {
    expect(aggregateCount({ after: { aggregate: { count: 12 } } })).toBe(12);
    expect(aggregateCount({ after: { value: 1 } })).toBeNull();
    expect(aggregateCount({ after: null })).toBeNull();
  });
});

describe('verificationBadge', () => {
  const ok: AuditChainVerification = {
    fromId: 1,
    toId: 10,
    rowsChecked: 10,
    sealedRowsVerified: 9,
    pendingUnsealed: 1,
    intact: true,
    firstBrokenLink: null,
    anchorId: null,
    truncated: false,
    nextFromId: null,
  };

  it('says "not verified" before any check, and "verifying" while one runs', () => {
    expect(verificationBadge(null, 'the whole log').tone).toBe('unknown');
    expect(verificationBadge(ok, 'the whole log', true).tone).toBe('running');
  });

  it('says what an intact check covered, including unsealed newest events', () => {
    const badge = verificationBadge(ok, 'the newest 5,000 events');
    expect(badge.tone).toBe('ok');
    expect(badge.label).toBe('Chain intact');
    expect(badge.detail).toContain('9 sealed events in the newest 5,000 events');
    expect(badge.detail).toContain('1 newest not sealed yet');
  });

  it('names the first broken link', () => {
    const badge = verificationBadge(
      { ...ok, intact: false, firstBrokenLink: { eventId: 7, problem: 'hash_mismatch', detail: 'Row 7 was changed.' } },
      'the whole log',
    );
    expect(badge.tone).toBe('broken');
    expect(badge.label).toBe('Chain broken at #7');
    expect(badge.detail).toBe('Row 7 was changed.');
  });

  it('never claims more than it checked', () => {
    expect(verificationBadge({ ...ok, truncated: true }, 'x').detail).toContain('stopped early');
    expect(verificationBadge({ ...ok, rowsChecked: 0, sealedRowsVerified: 0, pendingUnsealed: 0 }, 'x').label).toBe(
      'Nothing to verify',
    );
  });
});
