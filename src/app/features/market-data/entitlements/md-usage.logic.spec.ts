import { describe, expect, it } from 'vitest';

import { usageSummary } from './md-usage.logic';
import type { MarketDataFeedCatalog, MarketDataUsageReport } from './md-entitlements.types';

const report: MarketDataUsageReport = {
  month: '2026-10',
  partial: true,
  generatedAtUtc: '2026-10-28T22:00:00Z',
  feeds: [
    {
      feedId: 'broker-ticks',
      feedName: 'Ticks',
      exchangeFeed: false,
      usage: 'display',
      distinctUsers: 1,
      distinctTenants: 1,
      accessCount: 65,
      daysWithAccess: 3,
    },
    {
      feedId: 'broker-ticks',
      feedName: 'Ticks',
      exchangeFeed: false,
      usage: 'nonDisplay',
      distinctUsers: 1,
      distinctTenants: 1,
      accessCount: 42,
      daysWithAccess: 3,
    },
    {
      feedId: 'broker-dom',
      feedName: 'DOM',
      exchangeFeed: false,
      usage: 'display',
      distinctUsers: 2,
      distinctTenants: 1,
      accessCount: 250,
      daysWithAccess: 4,
    },
  ],
  tenants: [
    {
      feedId: 'broker-ticks',
      usage: 'display',
      tenantId: 1,
      tenantSlug: 'house',
      tenantName: 'House',
      distinctUsers: 1,
      accessCount: 65,
      firstDayUtc: '',
      lastDayUtc: '',
    },
    {
      feedId: 'broker-dom',
      usage: 'display',
      tenantId: 1,
      tenantSlug: 'house',
      tenantName: 'House',
      distinctUsers: 1,
      accessCount: 250,
      firstDayUtc: '',
      lastDayUtc: '',
    },
  ],
};

const catalog = {
  defaultFeeds: ['broker-ticks', 'broker-dom'],
  houseAllFeeds: true,
  feeds: [
    { feedId: 'broker-ticks', name: 'Ticks', exchangeFeed: false, isDefault: true, sources: [] },
    { feedId: 'broker-dom', name: 'DOM', exchangeFeed: false, isDefault: true, sources: [] },
    { feedId: 'cme-l2', name: 'CME depth', exchangeFeed: true, isDefault: false, sources: [] },
  ],
} as MarketDataFeedCatalog;

describe('usageSummary', () => {
  it('totals the month and lists feeds nobody read', () => {
    const s = usageSummary(report, catalog);
    expect(s.reads).toBe(357);
    expect(s.displayReads).toBe(315);
    expect(s.nonDisplayReads).toBe(42);
    expect(s.exchangeReads).toBe(0);
    expect(s.feedsRead).toBe(2);
    expect(s.organisations).toBe(1);
    expect(s.peakUsers).toBe(2);
    expect(s.perFeed.map((p) => [p.feedId, p.reads])).toEqual([
      ['broker-dom', 250],
      ['broker-ticks', 107],
    ]);
    expect(s.perFeed[0].share).toBe(1);
    expect(s.unread.map((u) => u.feedId)).toEqual(['cme-l2']);
  });

  it('is all zero without a report', () => {
    const s = usageSummary(null, null);
    expect([s.reads, s.feedsRead, s.peakUsers, s.unread.length]).toEqual([0, 0, 0, 0]);
  });
});
