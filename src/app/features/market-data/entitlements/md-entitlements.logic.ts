import type {
  EntitlementStatus,
  GrantDraft,
  GrantEntitlementBody,
  MarketDataEntitlementDto,
  UpdateEntitlementBody,
  UsageFeedRow,
} from './md-entitlements.types';

/** The fixed feeds, in the engine's order (`MdFeedCatalog.FixedFeeds`). */
export const FIXED_FEEDS = ['broker-ticks', 'broker-dom', 'cme-l2', 'cme-trades'] as const;

const PREFIXED = /^(?:venue|source):[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/;

/** The engine's rule (`MdFeedCatalog.IsValidFeedId`) on a normalised id. */
export function isValidFeedId(feedId: string): boolean {
  return (FIXED_FEEDS as readonly string[]).includes(feedId) || PREFIXED.test(feedId);
}

/** Trimmed, lower-cased. */
export function normaliseFeed(feedId: string | null | undefined): string {
  return (feedId ?? '').trim().toLowerCase();
}

/** A plan feed entry may also be a wildcard. */
export function isValidPlanEntry(entry: string): boolean {
  return entry === 'venue:*' || entry === 'source:*' || isValidFeedId(entry);
}

/** The entries of a plan's market-data feed list the engine would refuse ('' / null = every feed). */
export function invalidPlanFeeds(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const bad = raw
    .split(/[,\s;]+/)
    .map(normaliseFeed)
    .filter((f) => f && !isValidPlanEntry(f));
  return [...new Set(bad)];
}

/** "Every feed" or the list, for a plan row. */
export function planFeedsText(raw: string | null | undefined): string {
  return raw && raw.trim() ? raw.split(',').join(', ') : 'Every feed';
}

/** A blank grant form. */
export function emptyGrantDraft(tenantId: number | null = null): GrantDraft {
  return {
    tenantId,
    feedId: '',
    display: true,
    nonDisplay: false,
    validFrom: '',
    validTo: '',
    reason: '',
  };
}

/** The edit form of an existing grant. */
export function draftFromEntitlement(e: MarketDataEntitlementDto): GrantDraft {
  return {
    tenantId: e.tenantId,
    feedId: e.feedId,
    display: e.display,
    nonDisplay: e.nonDisplay,
    validFrom: e.validFromUtc ? e.validFromUtc.slice(0, 10) : '',
    validTo: e.validToUtc ? e.validToUtc.slice(0, 10) : '',
    reason: e.reason ?? '',
  };
}

/** `yyyy-mm-dd` → midnight UTC ISO; '' → null. */
export function dayToUtc(day: string): string | null {
  const d = day.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : null;
}

/** Problems before sending (`creating` = a new grant, which needs an organisation and a feed). */
export function grantErrors(d: GrantDraft, creating: boolean): string[] {
  const errors: string[] = [];
  if (creating) {
    if (!d.tenantId || d.tenantId <= 0) errors.push('Choose an organisation.');
    if (!isValidFeedId(normaliseFeed(d.feedId)))
      errors.push(
        'Choose a feed: broker-ticks, broker-dom, cme-l2, cme-trades, venue:<id> or source:<id>.',
      );
  }
  if (!d.display && !d.nonDisplay)
    errors.push('A licence covers display use, non-display use or both — choose at least one.');
  const from = dayToUtc(d.validFrom);
  const to = dayToUtc(d.validTo);
  if (d.validFrom.trim() && !from) errors.push('The start is a date (yyyy-mm-dd).');
  if (d.validTo.trim() && !to) errors.push('The end is a date (yyyy-mm-dd).');
  if (from && to && to <= from) errors.push('The licence must end after it starts.');
  if (!d.reason.trim())
    errors.push('Say why (the contract, order form or trial this licence comes from).');
  else if (d.reason.trim().length > 512) errors.push('The reason is at most 512 characters.');
  return errors;
}

export function grantBody(d: GrantDraft): GrantEntitlementBody {
  return {
    tenantId: d.tenantId ?? 0,
    feedId: normaliseFeed(d.feedId),
    display: d.display,
    nonDisplay: d.nonDisplay,
    validFromUtc: dayToUtc(d.validFrom),
    validToUtc: dayToUtc(d.validTo),
    reason: d.reason.trim(),
  };
}

export function updateBody(d: GrantDraft): UpdateEntitlementBody {
  const { display, nonDisplay, validFromUtc, validToUtc, reason } = grantBody(d);
  return { display, nonDisplay, validFromUtc, validToUtc, reason };
}

/** "Display + non-display", "Display only", "Non-display only". */
export function usagesText(e: Pick<MarketDataEntitlementDto, 'display' | 'nonDisplay'>): string {
  if (e.display && e.nonDisplay) return 'Display + non-display';
  if (e.display) return 'Display only';
  if (e.nonDisplay) return 'Non-display only';
  return 'None';
}

/** "Always", "From 2026-11-01", "Until 2027-01-01", "2026-11-01 → 2027-01-01". */
export function validityText(
  e: Pick<MarketDataEntitlementDto, 'validFromUtc' | 'validToUtc'>,
): string {
  const from = e.validFromUtc?.slice(0, 10);
  const to = e.validToUtc?.slice(0, 10);
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return 'No end';
}

/** Chip tone of a status. */
export function statusTone(status: EntitlementStatus): 'ok' | 'info' | 'warn' | 'bad' {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Scheduled':
      return 'info';
    case 'Expired':
      return 'warn';
    default:
      return 'bad';
  }
}

/** The list filtered by a search over organisation and feed. */
export function filterEntitlements(
  rows: readonly MarketDataEntitlementDto[],
  search: string,
): MarketDataEntitlementDto[] {
  const q = search.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) =>
    [r.tenantName, r.tenantSlug, r.feedId, r.feedName, String(r.tenantId)].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}

/** "Display" / "Non-display". */
export function usageLabel(usage: string): string {
  return usage === 'nonDisplay' ? 'Non-display' : 'Display';
}

/** Exchange feeds first (what a declaration is about), then the broker feeds. */
export function declarationOrder(rows: readonly UsageFeedRow[]): UsageFeedRow[] {
  return [...rows].sort((a, b) => Number(b.exchangeFeed) - Number(a.exchangeFeed));
}
