import type {
  MarketDataEntitlementDto,
  MarketDataFeedCatalog,
  MarketDataFeedDto,
} from './md-entitlements.types';

/** One catalog feed with who holds it today (pages program). */
export interface FeedHolding {
  feed: MarketDataFeedDto;
  /** Registry sources behind the feed that are enabled (null = the registry could not be read). */
  enabledSources: number | null;
  /** Organisations holding a live grant (status Active or Scheduled), by name. */
  grantees: string[];
  /** "Every organisation" / "House only" / "House + 2 organisations" — plain words. */
  holders: string;
}

const LIVE = new Set(['Active', 'Scheduled']);

export function feedHoldings(
  catalog: MarketDataFeedCatalog | null,
  grants: readonly MarketDataEntitlementDto[],
  enabledSourceIds: ReadonlySet<string> | null,
): FeedHolding[] {
  if (!catalog) return [];
  return catalog.feeds.map((feed) => {
    const grantees = [
      ...new Set(
        grants
          .filter((g) => g.feedId === feed.feedId && LIVE.has(g.status))
          .map((g) => g.tenantName || g.tenantSlug),
      ),
    ].sort();
    const isDefault = feed.isDefault || catalog.defaultFeeds.includes(feed.feedId);
    let holders: string;
    if (isDefault) holders = 'Every organisation (default feed)';
    else if (grantees.length)
      holders = `${catalog.houseAllFeeds ? 'House + ' : ''}${grantees.length} organisation${grantees.length === 1 ? '' : 's'} by grant`;
    else holders = catalog.houseAllFeeds ? 'House only' : 'Nobody';
    return {
      feed,
      enabledSources: enabledSourceIds
        ? feed.sources.filter((s) => enabledSourceIds.has(s)).length
        : null,
      grantees,
      holders,
    };
  });
}

/** Feeds grouped by licensor for display: broker feeds first, then each exchange family. */
export function groupByFamily(
  rows: FeedHolding[],
): { family: string; name: string; rows: FeedHolding[] }[] {
  const groups = new Map<string, { family: string; name: string; rows: FeedHolding[] }>();
  for (const r of rows) {
    const family = r.feed.exchangeFamily ?? (r.feed.exchangeFeed ? r.feed.feedId : 'broker');
    const name = r.feed.exchangeFamilyName ?? (family === 'broker' ? 'Broker feeds (MT5)' : family);
    const g = groups.get(family) ?? { family, name, rows: [] };
    g.rows.push(r);
    groups.set(family, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.family === 'broker') - Number(a.family === 'broker') || a.name.localeCompare(b.name),
  );
}

/** Declarations per status, plus the live ones (accepted and not expired). */
export interface DeclarationCounts {
  Submitted: number;
  Accepted: number;
  Rejected: number;
  Superseded: number;
  Withdrawn: number;
}

export function declarationCounts(rows: readonly { status: string }[]): DeclarationCounts {
  const out: DeclarationCounts = {
    Submitted: 0,
    Accepted: 0,
    Rejected: 0,
    Superseded: 0,
    Withdrawn: 0,
  };
  for (const r of rows) if (r.status in out) out[r.status as keyof DeclarationCounts]++;
  return out;
}

/**
 * Organisations that must have their people declare: holders of a live, REAL-TIME (not delayed-only) grant of a feed
 * whose catalog entry requires a declaration. House is exempt when the engine says so.
 */
export function declarationHolders(
  catalog: MarketDataFeedCatalog | null,
  grants: readonly MarketDataEntitlementDto[],
): { tenant: string; feeds: string[] }[] {
  const needs = new Set(
    (catalog?.feeds ?? []).filter((f) => f.requiresDeclaration).map((f) => f.feedId),
  );
  const by = new Map<string, string[]>();
  for (const g of grants) {
    if (!needs.has(g.feedId) || !LIVE.has(g.status) || g.delayed || !g.display) continue;
    const t = g.tenantName || g.tenantSlug;
    by.set(t, [...(by.get(t) ?? []), g.feedId]);
  }
  return [...by.entries()]
    .map(([tenant, feeds]) => ({ tenant, feeds }))
    .sort((a, b) => a.tenant.localeCompare(b.tenant));
}

/** One feed of `GET md/entitlements/me` with the fields the engine adds beyond the core type (WS8). */
export interface MyFeedRow {
  feedId: string;
  name: string;
  display: boolean;
  nonDisplay: boolean;
  validTo: string | null;
  source: string;
  delayMinutes?: number;
  declarationRequired?: boolean;
  exchangeFamily?: string | null;
}

/** How the organisation holds a feed, in plain words. */
export function holdingLabel(source: string): string {
  switch (source) {
    case 'house':
      return 'Platform (House reads every feed)';
    case 'default':
      return 'Default feed (every organisation)';
    case 'grant':
      return 'Granted licence';
    default:
      return source;
  }
}

/** "Real time" / "Delayed 15 min" / "Machines only". */
export function accessLabel(f: MyFeedRow): string {
  const timing = (f.delayMinutes ?? 0) > 0 ? `Delayed ${f.delayMinutes} min` : 'Real time';
  if (f.display && f.nonDisplay) return `${timing} · people and machines`;
  if (f.display) return `${timing} · people only`;
  if (f.nonDisplay) return `${timing} · machines only`;
  return 'No use';
}

/**
 * The organisation's feeds with how many readable sources are live behind each (`GET md/sources` lists only enabled
 * sources the caller may read, each with its kind → feed map).
 */
export function liveSourcesPerFeed(
  sources: readonly { feeds?: Record<string, string> | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sources)
    for (const feed of new Set(Object.values(s.feeds ?? {})))
      out.set(feed, (out.get(feed) ?? 0) + 1);
  return out;
}

/** Feeds of one exchange family the organisation reads. */
export function feedsOfFamily(feeds: readonly MyFeedRow[], family: string): MyFeedRow[] {
  return feeds.filter((f) => f.exchangeFamily === family);
}
