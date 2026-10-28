/** Billing and metering DTOs (engine enterprise program billing-metering; `docs/api/billing-api.md`). */

export interface FeedDayUsage {
  feed: string;
  displayUsers: number;
  nonDisplayUsers: number;
  accesses: number;
}

export interface BillingUsageDay {
  dayUtc: string;
  planId: number;
  planSlug: string;
  connectedTerminals: number;
  activeUsers: number;
  propModule: boolean;
  brokerModule: boolean;
  fundModule: boolean;
  licensedFeeds: string[];
  feedUsage: FeedDayUsage[];
  feedsDegraded: boolean;
  isClosed: boolean;
  lastMeteredAtUtc: string;
}

export interface BillingFeedMonth {
  feedId: string;
  licensedDays: number;
  distinctDisplayUsers: number;
  distinctNonDisplayUsers: number;
  accesses: number;
}

export interface InvoiceLine {
  sortOrder: number;
  kind: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  explanation: string;
  priceBookId: number | null;
  priceBookVersion: number | null;
}

export interface InvoicePreview {
  ok: boolean;
  error: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  total: number;
  daysMetered: number;
  daysInPeriod: number;
  warnings: string[];
}

export interface BillingUsageMonth {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  month: string;
  partial: boolean;
  daysInMonth: number;
  days: BillingUsageDay[];
  peakConnectedTerminals: number;
  terminalDays: number;
  peakActiveUsers: number;
  feeds: BillingFeedMonth[];
  llmUsd: number | null;
  estimate: InvoicePreview | null;
  notInvoiced: boolean;
  generatedAtUtc: string;
}

export type InvoiceStatus = 'Draft' | 'Finalised' | 'Void';
export type InvoicePaymentStatus = 'NotSubmitted' | 'Submitted' | 'Paid' | 'Failed';

export interface Invoice {
  id: number;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  month: string;
  periodStartUtc: string;
  periodEndUtc: string;
  number: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  total: number;
  daysMetered: number;
  daysInPeriod: number;
  warnings: string[];
  generatedAtUtc: string;
  generatedBy: string | null;
  finalisedAtUtc: string | null;
  finalisedBy: string | null;
  reviewNote: string | null;
  voidedAtUtc: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  paymentStatus: InvoicePaymentStatus;
  paymentProvider: string | null;
  paymentReference: string | null;
  paymentMessage: string | null;
  paymentUpdatedAtUtc: string | null;
  /** Detail reads only. */
  lines: InvoiceLine[] | null;
}

export interface FeedPrice {
  feedId: string;
  monthlyCost: number;
  perDisplayUserCost: number;
  marginPct: number;
}

/** Exchange fee pass-through per subscriber (engine WS8 8.5). */
export interface ExchangeFee {
  family: string;
  professionalMonthly: number;
  nonProfessionalMonthly: number;
  nonDisplayMonthly: number;
  marginPct: number;
}

export interface PriceBook {
  id: number;
  planId: number;
  planSlug: string;
  planName: string;
  version: number;
  status: 'Draft' | 'Published';
  currency: string;
  effectiveFromUtc: string;
  platformFeeMonthly: number;
  perTerminalMonthly: number;
  includedTerminals: number;
  perUserMonthly: number;
  includedUsers: number;
  propModuleMonthly: number;
  brokerModuleMonthly: number;
  fundModuleMonthly: number;
  feedPrices: FeedPrice[];
  /** Engine WS8 8.5 (absent from older engines). */
  exchangeFees?: ExchangeFee[];
  llmMarginPct: number | null;
  notes: string | null;
  inForce: boolean;
  createdAtUtc: string;
  updatedAtUtc: string | null;
  publishedAtUtc: string | null;
  createdBy: string | null;
  publishedBy: string | null;
}

/** Body of POST/PUT platform/billing/price-books. */
export interface PriceBookBody {
  planId?: number;
  currency: string;
  effectiveFromUtc: string;
  platformFeeMonthly: number;
  perTerminalMonthly: number;
  includedTerminals: number;
  perUserMonthly: number;
  includedUsers: number;
  propModuleMonthly: number;
  brokerModuleMonthly: number;
  fundModuleMonthly: number;
  feedPrices: FeedPrice[];
  exchangeFees: ExchangeFee[];
  llmMarginPct: number | null;
  notes: string | null;
}

export interface GenerateInvoicesResult {
  month: string;
  drafted: Invoice[];
  skipped: { tenantId: number; tenantSlug: string; reason: string }[];
}

export interface PaymentProviderInfo {
  configured: string;
  active: boolean;
  isTestDouble: boolean;
  available: string[];
  notice: string;
}

export interface BillingFile {
  blob: Blob;
  fileName: string;
}

// ── Self-serve plans (Stripe Checkout + billing portal) ──

/** One plan an organisation can be on (`GET billing/plans/public`, and `offers` of the subscription). */
export interface PlanOffer {
  slug: string;
  name: string;
  description: string | null;
  /** In the currency's major unit (49 = $49). 0 = the free default plan. */
  priceAmount: number;
  currency: string | null;
  interval: 'month' | 'year' | null;
  /** A null limit is unlimited. */
  maxTradingAccounts: number | null;
  maxActiveEaInstances: number | null;
  maxMembers: number | null;
  maxStrategies: number | null;
  isDefault: boolean;
  isCurrent: boolean;
}

export type SubscriptionStatus =
  | 'none'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'unpaid';

/** `GET tenant/billing/subscription` (`tenant.billing.read`). */
export interface BillingSubscription {
  selfServeEnabled: boolean;
  currentPlan: { slug: string; name: string } | null;
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEndUtc: string | null;
  /** The engine's own answer: the person may change the plan (the console also needs `tenant.billing.manage`). */
  canManage: boolean;
  hasBillingAccount: boolean;
  offers: PlanOffer[];
}

/** `POST tenant/billing/checkout` / `POST tenant/billing/portal`: where to send the browser. */
export interface BillingRedirect {
  url: string;
}
