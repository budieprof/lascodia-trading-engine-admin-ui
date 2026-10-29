import type { MarketDataFeedCatalog, MarketDataUsageReport } from './md-entitlements.types';

/** The usage month in figures (pages program): totals, split, and the catalog feeds nobody read. */
export interface UsageSummary {
  reads: number;
  displayReads: number;
  nonDisplayReads: number;
  exchangeReads: number;
  feedsRead: number;
  organisations: number;
  /** Highest distinct-user count of any one feed (a person reading two feeds counts once per feed). */
  peakUsers: number;
  /** Reads per feed, both uses together, most read first — for the bar list. */
  perFeed: { feedId: string; feedName: string; reads: number; share: number }[];
  /** Catalog feeds with no read this month. */
  unread: { feedId: string; name: string; exchangeFeed: boolean }[];
}

export function usageSummary(
  r: MarketDataUsageReport | null,
  catalog: MarketDataFeedCatalog | null,
): UsageSummary {
  const feeds = r?.feeds ?? [];
  const per = new Map<string, { feedId: string; feedName: string; reads: number }>();
  for (const f of feeds) {
    const row = per.get(f.feedId) ?? { feedId: f.feedId, feedName: f.feedName, reads: 0 };
    row.reads += f.accessCount;
    per.set(f.feedId, row);
  }
  const reads = feeds.reduce((a, f) => a + f.accessCount, 0);
  const max = Math.max(1, ...[...per.values()].map((p) => p.reads));
  return {
    reads,
    displayReads: feeds.filter((f) => f.usage === 'display').reduce((a, f) => a + f.accessCount, 0),
    nonDisplayReads: feeds
      .filter((f) => f.usage !== 'display')
      .reduce((a, f) => a + f.accessCount, 0),
    exchangeReads: feeds.filter((f) => f.exchangeFeed).reduce((a, f) => a + f.accessCount, 0),
    feedsRead: per.size,
    organisations: new Set((r?.tenants ?? []).map((t) => t.tenantId)).size,
    peakUsers: Math.max(0, ...feeds.map((f) => f.distinctUsers)),
    perFeed: [...per.values()]
      .sort((a, b) => b.reads - a.reads)
      .map((p) => ({ ...p, share: p.reads / max })),
    unread: (catalog?.feeds ?? [])
      .filter((f) => !per.has(f.feedId))
      .map((f) => ({ feedId: f.feedId, name: f.name, exchangeFeed: f.exchangeFeed })),
  };
}
