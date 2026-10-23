/**
 * Market-data entitlements and the exchange usage report (engine market-data program, contract C6 —
 * `docs/api/marketdata-entitlements.md` in the engine repo). Platform staff only.
 */

/** `Active`, `Scheduled` (starts later), `Expired`, `Revoked`. */
export type EntitlementStatus = 'Active' | 'Scheduled' | 'Expired' | 'Revoked' | string;

/** `GET admin/md/entitlements` row (and every write's answer). */
export interface MarketDataEntitlementDto {
  id: number;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  feedId: string;
  feedName: string;
  /** People may view it. */
  display: boolean;
  /** Machines and algorithms may consume it. */
  nonDisplay: boolean;
  validFromUtc: string | null;
  validToUtc: string | null;
  reason: string | null;
  grantedBy: string | null;
  updatedBy: string | null;
  createdAtUtc: string;
  updatedAtUtc: string | null;
  revokedAtUtc: string | null;
  status: EntitlementStatus;
  /** The organisation's current plan does not include the feed: not served until it does. */
  outsidePlan: boolean;
}

/** `POST admin/md/entitlements`. */
export interface GrantEntitlementBody {
  tenantId: number;
  feedId: string;
  display: boolean;
  nonDisplay: boolean;
  validFromUtc: string | null;
  validToUtc: string | null;
  reason: string;
}

/** `PUT admin/md/entitlements/{id}`. */
export interface UpdateEntitlementBody {
  display: boolean;
  nonDisplay: boolean;
  validFromUtc: string | null;
  validToUtc: string | null;
  reason: string;
}

/** `GET admin/md/feeds` row. */
export interface MarketDataFeedDto {
  feedId: string;
  name: string;
  /** A licensed exchange or venue feed (CME, venues) rather than broker data. */
  exchangeFeed: boolean;
  /** Every organisation has it without a grant (within its plan). */
  isDefault: boolean;
  /** Registry sources whose data the feed guards. */
  sources: string[];
}

/** `GET admin/md/feeds`. */
export interface MarketDataFeedCatalog {
  feeds: MarketDataFeedDto[];
  defaultFeeds: string[];
  /** House has every feed. */
  houseAllFeeds: boolean;
}

/** `GET admin/md/usage` per feed and usage. */
export interface UsageFeedRow {
  feedId: string;
  feedName: string;
  exchangeFeed: boolean;
  usage: 'display' | 'nonDisplay' | string;
  distinctUsers: number;
  distinctTenants: number;
  accessCount: number;
  daysWithAccess: number;
}

/** `GET admin/md/usage` per feed, usage and organisation. */
export interface UsageTenantRow {
  feedId: string;
  usage: 'display' | 'nonDisplay' | string;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  distinctUsers: number;
  accessCount: number;
  firstDayUtc: string;
  lastDayUtc: string;
}

/** `GET admin/md/usage?month=`. */
export interface MarketDataUsageReport {
  month: string;
  feeds: UsageFeedRow[];
  tenants: UsageTenantRow[];
  /** The month is still running. */
  partial: boolean;
  generatedAtUtc: string;
}

/** A downloaded CSV. */
export interface UsageCsvFile {
  blob: Blob;
  fileName: string;
}

/** The grant form. Dates are `yyyy-mm-dd` (UTC days) or ''. */
export interface GrantDraft {
  tenantId: number | null;
  feedId: string;
  display: boolean;
  nonDisplay: boolean;
  validFrom: string;
  validTo: string;
  reason: string;
}
