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
  /** Engine WS8 8.3: a delayed-only licence (served `delayMinutes` late). Absent from older engines. */
  delayed?: boolean;
  delayMinutes?: number;
  /** The feed's exchange family (licensor); null for broker feeds. */
  exchangeFamily?: string | null;
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
  delayed: boolean;
  validFromUtc: string | null;
  validToUtc: string | null;
  reason: string;
}

/** `PUT admin/md/entitlements/{id}`. */
export interface UpdateEntitlementBody {
  display: boolean;
  nonDisplay: boolean;
  delayed: boolean;
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
  /** Engine WS8 8.1: the licensor family (null for broker feeds / unregistered sources). */
  exchangeFamily?: string | null;
  exchangeFamilyName?: string | null;
  /** `L1`, `L2`, `Trades`, `L1+Trades`, `Book+Trades`. */
  level?: string | null;
  /** A person must declare professional / non-professional status to see it in real time. */
  requiresDeclaration?: boolean;
  /** A delayed-only licence can be granted. */
  hasDelayedData?: boolean;
  delayMinutes?: number;
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

/** `GET admin/md/usage` per exchange family × subscriber type × usage × real-time (engine WS8 8.4). */
export interface UsageExchangeRow {
  family: string;
  familyName: string;
  /** `professional`, `nonProfessional`, `undeclared` (counted as professional by exchanges), `nonDisplay`. */
  subscriberType: string;
  usage: 'display' | 'nonDisplay' | string;
  realTime: boolean;
  distinctSubscribers: number;
  distinctTenants: number;
  accessCount: number;
  feeds: string[];
}

/** `GET admin/md/usage?month=`. */
export interface MarketDataUsageReport {
  month: string;
  feeds: UsageFeedRow[];
  tenants: UsageTenantRow[];
  /** Engine WS8 8.4 (absent from older engines). */
  exchanges?: UsageExchangeRow[];
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
  delayed: boolean;
  validFrom: string;
  validTo: string;
  reason: string;
}

// ── Subscriber declarations (engine WS8 8.2) ────────────────────────────────

export interface DeclarationQuestion {
  key: string;
  text: string;
  /** The answer that makes the person professional. */
  professionalWhen: boolean;
}

/** A declaration (self-service and staff review). */
export interface SubscriberDeclarationDto {
  id: number;
  tenantId: number;
  tenantSlug?: string | null;
  adminUserId: number;
  userName?: string | null;
  userEmail?: string | null;
  exchangeFamily: string;
  exchangeFamilyName: string;
  /** `Professional` | `NonProfessional` (in force). */
  subscriberType: string;
  /** What the answers alone say. */
  declaredType: string;
  answers: Record<string, boolean>;
  questionnaireVersion: number;
  signedName: string;
  signedAtUtc: string;
  expiresAtUtc: string;
  /** `Submitted` | `Accepted` | `Rejected` | `Superseded` | `Withdrawn`. */
  status: string;
  current: boolean;
  renewalDue: boolean;
  reviewedBy?: string | null;
  reviewedAtUtc?: string | null;
  reviewNote?: string | null;
}

export interface DeclarationFamily {
  id: string;
  name: string;
  /** The organisation holds a real-time licence of this family: a declaration is needed to view it. */
  needed: boolean;
  declaration: SubscriberDeclarationDto | null;
}

/** `GET md/declarations/me`. */
export interface MyDeclarations {
  tenantId: number | null;
  required: boolean;
  houseExempt: boolean;
  validityDays: number;
  questionnaireVersion: number;
  questions: DeclarationQuestion[];
  families: DeclarationFamily[];
}

/** `POST md/declarations`. */
export interface SubmitDeclarationBody {
  exchangeFamily: string;
  answers: Record<string, boolean>;
  selfDeclaredProfessional: boolean;
  signedName: string;
  attest: boolean;
}

/** `PUT admin/md/declarations/{id}/review`. */
export type DeclarationDecision = 'accept' | 'reject' | 'professional' | 'nonProfessional';
