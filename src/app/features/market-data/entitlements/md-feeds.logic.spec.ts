import { describe, expect, it } from 'vitest';

import {
  accessLabel,
  declarationCounts,
  declarationHolders,
  feedHoldings,
  feedsOfFamily,
  groupByFamily,
  holdingLabel,
  liveSourcesPerFeed,
} from './md-feeds.logic';
import type { MarketDataEntitlementDto, MarketDataFeedCatalog } from './md-entitlements.types';

const catalog = {
  defaultFeeds: ['broker-ticks'],
  houseAllFeeds: true,
  feeds: [
    {
      feedId: 'broker-ticks',
      name: 'Ticks',
      exchangeFeed: false,
      isDefault: true,
      sources: ['mt5-a'],
    },
    {
      feedId: 'cme-l2',
      name: 'CME depth',
      exchangeFeed: true,
      isDefault: false,
      sources: ['cme-x', 'cme-y'],
      exchangeFamily: 'cme-group',
      exchangeFamilyName: 'CME Group',
    },
    {
      feedId: 'crypto:okx',
      name: 'OKX',
      exchangeFeed: true,
      isDefault: false,
      sources: ['crypto-okx'],
      exchangeFamily: 'crypto:okx',
      exchangeFamilyName: 'Crypto exchange okx',
    },
  ],
} as MarketDataFeedCatalog;

const grant = (feedId: string, status: string, tenantName: string) =>
  ({
    feedId,
    status,
    tenantName,
    tenantSlug: tenantName.toLowerCase(),
  }) as unknown as MarketDataEntitlementDto;

describe('feedHoldings', () => {
  it('says who holds each feed from defaults, House and live grants', () => {
    const rows = feedHoldings(
      catalog,
      [grant('cme-l2', 'Active', 'Acme'), grant('cme-l2', 'Revoked', 'Old')],
      new Set(['cme-x', 'crypto-okx']),
    );
    expect(rows.map((r) => r.holders)).toEqual([
      'Every organisation (default feed)',
      'House + 1 organisation by grant',
      'House only',
    ]);
    expect(rows[1].grantees).toEqual(['Acme']);
    expect(rows.map((r) => r.enabledSources)).toEqual([0, 1, 1]);
  });

  it('groups broker feeds first', () => {
    const groups = groupByFamily(feedHoldings(catalog, [], null));
    expect(groups.map((g) => g.name)).toEqual([
      'Broker feeds (MT5)',
      'CME Group',
      'Crypto exchange okx',
    ]);
    expect(groups[0].rows[0].enabledSources).toBeNull();
  });
});

describe('declarations', () => {
  it('counts by status', () => {
    expect(
      declarationCounts([{ status: 'Accepted' }, { status: 'Accepted' }, { status: 'Submitted' }]),
    ).toMatchObject({
      Accepted: 2,
      Submitted: 1,
      Rejected: 0,
    });
  });
  it('lists organisations with a real-time display grant of a declaration feed', () => {
    const cat = {
      ...catalog,
      feeds: catalog.feeds.map((f) => ({ ...f, requiresDeclaration: f.feedId === 'cme-l2' })),
    } as MarketDataFeedCatalog;
    const g = (over: object) =>
      ({
        ...grant('cme-l2', 'Active', 'Acme'),
        display: true,
        delayed: false,
        ...over,
      }) as MarketDataEntitlementDto;
    expect(
      declarationHolders(cat, [
        g({}),
        g({ tenantName: 'Late', delayed: true }),
        g({ tenantName: 'Bot', display: false }),
      ]),
    ).toEqual([{ tenant: 'Acme', feeds: ['cme-l2'] }]);
  });
});

describe('my feeds', () => {
  const f = (over: object) => ({
    feedId: 'cme-l2',
    name: 'CME',
    display: true,
    nonDisplay: true,
    validTo: null,
    source: 'house',
    ...over,
  });
  it('labels access and holding', () => {
    expect(accessLabel(f({}))).toBe('Real time · people and machines');
    expect(accessLabel(f({ delayMinutes: 15, nonDisplay: false }))).toBe(
      'Delayed 15 min · people only',
    );
    expect(holdingLabel('grant')).toBe('Granted licence');
  });
  it('counts live sources per feed and filters by family', () => {
    const m = liveSourcesPerFeed([
      { feeds: { ticks: 'broker-ticks', book: 'broker-dom' } },
      { feeds: { ticks: 'broker-ticks' } },
      { feeds: { ticks: 'crypto:okx', book: 'crypto:okx', trades: 'crypto:okx' } },
    ]);
    expect([m.get('broker-ticks'), m.get('crypto:okx'), m.get('cme-l2')]).toEqual([
      2,
      1,
      undefined,
    ]);
    expect(
      feedsOfFamily(
        [f({ exchangeFamily: 'cme-group' }), f({ feedId: 'x', exchangeFamily: null })],
        'cme-group',
      ).length,
    ).toBe(1);
  });
});
