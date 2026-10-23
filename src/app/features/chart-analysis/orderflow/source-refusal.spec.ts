import { describe, expect, it } from 'vitest';

import type { MyMarketDataEntitlements } from '@core/market-data/md-entitlements.service';
import { sourceRefusal } from './orderflow-feed';

const me = (over: Partial<MyMarketDataEntitlements>): MyMarketDataEntitlements => ({
  tenantId: 7,
  feeds: [],
  allFeeds: false,
  planFeeds: null,
  degraded: false,
  ...over,
});
const cme = { feeds: { book: 'cme-l2', trades: 'cme-trades' } };

describe('source picker entitlements (C6)', () => {
  it('names the feeds of a source the organisation may not view', () => {
    const m = me({ feeds: [{ feedId: 'cme-l2', name: 'CME depth', display: true, nonDisplay: false, validTo: null, source: 'grant' }] });
    expect(sourceRefusal(cme, m)).toBe('not entitled to cme-trades');
  });

  it('refuses nothing for House (every feed) or while the entitlements are unknown', () => {
    expect(sourceRefusal(cme, me({ allFeeds: true }))).toBeNull();
    expect(sourceRefusal(cme, null)).toBeNull();
  });

  it('a non-display-only licence does not let people view the feed', () => {
    const m = me({
      feeds: [
        { feedId: 'cme-l2', name: '', display: false, nonDisplay: true, validTo: null, source: 'grant' },
        { feedId: 'cme-trades', name: '', display: true, nonDisplay: true, validTo: null, source: 'grant' },
      ],
    });
    expect(sourceRefusal(cme, m)).toBe('not entitled to cme-l2');
  });
});
