import { describe, expect, it } from 'vitest';

import {
  ago,
  countBy,
  auditActionLabel,
  auditActorLabel,
  bytes,
  mergeTrail,
  plural,
  type TrailEvent,
} from './admin-context.logic';

function ev(id: number, action = 'iam.grant.created'): TrailEvent {
  return {
    id,
    occurredAtUtc: '2026-10-28T10:00:00Z',
    actorId: 'admin-user:1',
    actorDisplay: null,
    action,
    resourceType: null,
    resourceId: null,
    outcome: 'Succeeded',
    reason: null,
    tenantId: 1,
  };
}

describe('auditActionLabel', () => {
  it('uses the known wording', () => {
    expect(auditActionLabel('platform.ea_release.published')).toBe('EA build published');
  });
  it('derives words from an unknown key, dropping the area', () => {
    expect(auditActionLabel('platform.elevation.approved')).toBe('Elevation approved');
    expect(auditActionLabel('iam.team_member.added')).toBe('Team member added');
  });
  it('keeps a two-part key whole', () => {
    expect(auditActionLabel('auth.logout')).toBe('Signed out');
    expect(auditActionLabel('access.denied')).toBe('Access denied');
  });
});

describe('auditActorLabel', () => {
  it('prefers the display name', () => {
    expect(auditActorLabel({ actorId: 'admin-user:1', actorDisplay: ' Super Admin ' })).toBe(
      'Super Admin',
    );
  });
  it('words a namespaced id', () => {
    expect(auditActorLabel({ actorId: 'admin-user:5', actorDisplay: null })).toBe('User #5');
    expect(auditActorLabel({ actorId: 'system:sealer', actorDisplay: null })).toBe('The engine');
    expect(auditActorLabel({ actorId: 'weird', actorDisplay: null })).toBe('weird');
  });
});

describe('mergeTrail', () => {
  it('merges pages newest first without duplicates and caps the count', () => {
    const out = mergeTrail([[ev(5), ev(3)], [ev(4), ev(5)], [ev(1)]], 3);
    expect(out.map((e) => e.id)).toEqual([5, 4, 3]);
  });
  it('handles no pages', () => {
    expect(mergeTrail([], 5)).toEqual([]);
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  it('words past and future times', () => {
    expect(ago('2026-10-28T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-10-28T11:30:00Z', now)).toBe('30 min ago');
    expect(ago('2026-10-28T07:00:00Z', now)).toBe('5 h ago');
    expect(ago('2026-10-27T12:00:00Z', now)).toBe('1 day ago');
    expect(ago('2026-10-30T12:00:00Z', now)).toBe('in 2 days');
  });
  it('says — for nothing', () => {
    expect(ago(null, now)).toBe('—');
    expect(ago('nonsense', now)).toBe('—');
  });
});

describe('plural / bytes', () => {
  it('pluralises', () => {
    expect(plural(0, 'team')).toBe('0 teams');
    expect(plural(1, 'team')).toBe('1 team');
    expect(plural(2, 'policy', 'policies')).toBe('2 policies');
  });
  it('formats sizes', () => {
    expect(bytes(2_210_436)).toBe('2.1 MB');
    expect(bytes(2048)).toBe('2 KB');
    expect(bytes(null)).toBe('—');
  });
});

describe('countBy', () => {
  it('counts per key', () => {
    expect(countBy(['a', 'b', 'a'], (x) => x)).toEqual({ a: 2, b: 1 });
    expect(countBy([], (x: string) => x)).toEqual({});
  });
});
