import { describe, expect, it } from 'vitest';

import {
  dayToUtc,
  declarationOrder,
  draftFromEntitlement,
  emptyGrantDraft,
  filterEntitlements,
  grantBody,
  grantErrors,
  invalidPlanFeeds,
  isValidFeedId,
  planFeedsText,
  statusTone,
  updateBody,
  usagesText,
  validityText,
} from './md-entitlements.logic';
import type { MarketDataEntitlementDto, UsageFeedRow } from './md-entitlements.types';

const row = (over: Partial<MarketDataEntitlementDto> = {}): MarketDataEntitlementDto => ({
  id: 1,
  tenantId: 7001,
  tenantSlug: 'tenant-a',
  tenantName: 'Tenant A',
  feedId: 'cme-l2',
  feedName: 'CME futures depth (MBP-10 book)',
  display: true,
  nonDisplay: false,
  validFromUtc: null,
  validToUtc: '2027-01-01T00:00:00Z',
  reason: 'Order form 114',
  grantedBy: 'admin-user:5',
  updatedBy: null,
  createdAtUtc: '2026-10-23T12:00:00Z',
  updatedAtUtc: null,
  revokedAtUtc: null,
  status: 'Active',
  outsidePlan: false,
  ...over,
});

describe('feed ids (the engine rule)', () => {
  it('accepts the fixed feeds and prefixed slugs only', () => {
    for (const ok of [
      'broker-ticks',
      'broker-dom',
      'cme-l2',
      'cme-trades',
      'venue:lmax',
      'source:cme-old',
      'venue:a.b_c-1',
    ])
      expect(isValidFeedId(ok)).toBe(true);
    for (const bad of ['cme', 'venue:', 'venue:LMAX', 'venue:*', 'broker-ticks;x', ''])
      expect(isValidFeedId(bad)).toBe(false);
  });

  it('checks a plan feed list, wildcards allowed, blank = every feed', () => {
    expect(invalidPlanFeeds(' broker-ticks, VENUE:*  source:* cme-l2')).toEqual([]);
    expect(invalidPlanFeeds('broker-ticks, nope, nope, venue:')).toEqual(['nope', 'venue:']);
    expect(invalidPlanFeeds(null)).toEqual([]);
    expect(planFeedsText(null)).toBe('Every feed');
    expect(planFeedsText('broker-ticks,broker-dom')).toBe('broker-ticks, broker-dom');
  });
});

describe('grant form', () => {
  it('needs an organisation, a feed, a usage and a reason; the end after the start', () => {
    const ok = { ...emptyGrantDraft(7001), feedId: ' CME-L2 ', reason: 'Order form 114' };
    expect(grantErrors(ok, true)).toEqual([]);
    expect(grantErrors({ ...ok, tenantId: null }, true)).toEqual(['Choose an organisation.']);
    expect(grantErrors({ ...ok, feedId: 'cme' }, true)[0]).toContain('Choose a feed');
    expect(grantErrors({ ...ok, feedId: 'cme' }, false)).toEqual([]); // the feed is not edited
    expect(grantErrors({ ...ok, display: false }, true)[0]).toContain('at least one');
    expect(grantErrors({ ...ok, validFrom: '2027-01-01', validTo: '2026-12-01' }, true)).toEqual([
      'The licence must end after it starts.',
    ]);
    expect(grantErrors({ ...ok, reason: ' ' }, true)[0]).toContain('Say why');
  });

  it('sends normalised ids and UTC midnights', () => {
    const d = {
      ...emptyGrantDraft(7001),
      feedId: ' CME-L2 ',
      nonDisplay: true,
      validTo: '2027-01-01',
      reason: ' x ',
    };
    expect(grantBody(d)).toEqual({
      tenantId: 7001,
      feedId: 'cme-l2',
      display: true,
      nonDisplay: true,
      delayed: false,
      validFromUtc: null,
      validToUtc: '2027-01-01T00:00:00Z',
      reason: 'x',
    });
    expect(updateBody(d)).toEqual({
      display: true,
      nonDisplay: true,
      delayed: false,
      validFromUtc: null,
      validToUtc: '2027-01-01T00:00:00Z',
      reason: 'x',
    });
    expect(dayToUtc('2026-13')).toBeNull();
  });

  it('edits a grant as days', () => {
    const d = draftFromEntitlement(row({ validFromUtc: '2026-11-01T00:00:00Z' }));
    expect(d).toMatchObject({
      tenantId: 7001,
      feedId: 'cme-l2',
      validFrom: '2026-11-01',
      validTo: '2027-01-01',
    });
  });
});

describe('display', () => {
  it('says the usages, the validity and the status tone', () => {
    expect(usagesText(row())).toBe('Display only');
    expect(usagesText(row({ nonDisplay: true }))).toBe('Display + non-display');
    expect(usagesText(row({ display: false, nonDisplay: true }))).toBe('Non-display only');
    expect(validityText(row())).toBe('Until 2027-01-01');
    expect(validityText(row({ validToUtc: null }))).toBe('No end');
    expect(validityText(row({ validFromUtc: '2026-11-01T00:00:00Z' }))).toBe(
      '2026-11-01 → 2027-01-01',
    );
    expect(['Active', 'Scheduled', 'Expired', 'Revoked'].map(statusTone)).toEqual([
      'ok',
      'info',
      'warn',
      'bad',
    ]);
  });

  it('filters by organisation or feed and puts exchange feeds first in the report', () => {
    const rows = [
      row(),
      row({
        id: 2,
        tenantName: 'Beta',
        tenantSlug: 'beta',
        feedId: 'venue:lmax',
        feedName: 'FX venue lmax',
      }),
    ];
    expect(filterEntitlements(rows, 'BETA').map((r) => r.id)).toEqual([2]);
    expect(filterEntitlements(rows, 'cme').map((r) => r.id)).toEqual([1]);
    expect(filterEntitlements(rows, ' ').length).toBe(2);

    const feed = (feedId: string, exchangeFeed: boolean): UsageFeedRow => ({
      feedId,
      feedName: feedId,
      exchangeFeed,
      usage: 'display',
      distinctUsers: 1,
      distinctTenants: 1,
      accessCount: 1,
      daysWithAccess: 1,
    });
    expect(
      declarationOrder([feed('broker-dom', false), feed('cme-l2', true)]).map((f) => f.feedId),
    ).toEqual(['cme-l2', 'broker-dom']);
  });
});
