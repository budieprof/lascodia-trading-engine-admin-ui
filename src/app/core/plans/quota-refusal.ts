/**
 * Plan quota refusals (engine multi-tenancy Phase 7, `docs/api/plans-api.md`). A creation the
 * organisation's plan does not allow answers HTTP 403 with `responseCode: "-403-quota"` and the refusal
 * as `data`. This turns it into one plain sentence wherever an error is shown.
 */

export const QUOTA_RESPONSE_CODE = '-403-quota';

/** The refusal the engine sends as `data`. */
export interface QuotaRefusal {
  /** `tradingAccounts`, `activeEaInstances`, `members`, `concurrentResearchJobs`, `strategies`, `scripts` or `feature`. */
  quota: string;
  /** For a feature refusal: `sso`, `scim` or `personalAccessTokens`. */
  feature?: string | null;
  limit: number;
  used: number;
  requested?: number | null;
  /** The plan's display name ('' when the organisation has none). */
  plan: string;
  planSlug?: string | null;
  tenantId?: number | null;
}

/** "trading accounts", … — the noun a person reads for each quota key. */
export const QUOTA_NOUNS: Readonly<Record<string, string>> = {
  tradingAccounts: 'trading accounts',
  activeEaInstances: 'connected EA terminals',
  members: 'people (members and pending invitations)',
  concurrentResearchJobs: 'backtests and optimisations at a time',
  strategies: 'strategies',
  scripts: 'saved scripts and libraries',
  realTradingAccounts: 'real (live-money) trading accounts',
};

/** "single sign-on", … — the feature a person reads. */
export const FEATURE_NOUNS: Readonly<Record<string, string>> = {
  sso: 'single sign-on',
  scim: 'SCIM provisioning',
  personalAccessTokens: 'personal access tokens',
  propModule: 'the prop-firm module',
  brokerModule: 'the broker dealing-desk module',
  fundModule:
    'the fund module (best-execution reports, performance statements and compliance exports)',
  fullMarketDataCapture: 'full tick and order-book capture',
};

type Envelope = { responseCode?: unknown; message?: unknown; data?: unknown };

/** The envelope inside an `HttpErrorResponse` (`.error`), an `ApiError` (`.response`) or the envelope itself. */
function envelopeOf(err: unknown): Envelope | null {
  if (!err || typeof err !== 'object') return null;
  const o = err as { error?: unknown; response?: unknown; responseCode?: unknown };
  if (typeof o.responseCode === 'string') return o as Envelope;
  for (const inner of [o.error, o.response]) {
    if (
      inner &&
      typeof inner === 'object' &&
      typeof (inner as Envelope).responseCode === 'string'
    ) {
      return inner as Envelope;
    }
  }
  return null;
}

function isRefusal(data: unknown): data is QuotaRefusal {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d['quota'] === 'string' &&
    typeof d['limit'] === 'number' &&
    typeof d['used'] === 'number' &&
    typeof d['plan'] === 'string'
  );
}

/** True when the error (or envelope) is a plan quota refusal. */
export function isQuotaRefusal(err: unknown): boolean {
  return envelopeOf(err)?.responseCode === QUOTA_RESPONSE_CODE;
}

/** The refusal data, or null (not a quota refusal, or one without data). */
export function quotaRefusalOf(err: unknown): QuotaRefusal | null {
  const env = envelopeOf(err);
  if (env?.responseCode !== QUOTA_RESPONSE_CODE) return null;
  return isRefusal(env.data) ? env.data : null;
}

/**
 * Priced units (freemium program): `ai.analysis`, `research.backtest`, `signals.symbols`, `watches.active`. Their
 * amounts can be fractional (a chat follow-up is 0.25), so the engine's own sentence — exact, and naming the add-on
 * or the reset date — is shown for them.
 */
export function isUnitRefusal(r: Pick<QuotaRefusal, 'quota'>): boolean {
  return r.quota.includes('.');
}

/** Where a refused organisation can see its usage and add more: Organisation → Usage & billing. */
export const USAGE_AND_ADD_ONS_LINK = { label: 'See usage & add-ons', route: '/organisation/billing' } as const;

/** The toast link for a quota refusal (limits and priced units), or null for anything else. */
export function quotaRefusalLink(err: unknown): { label: string; route: string } | null {
  const r = quotaRefusalOf(err);
  if (!r || !r.plan || r.quota === 'feature') return null;
  return { ...USAGE_AND_ADD_ONS_LINK };
}

/** One plain sentence for a refusal. */
export function describeQuotaRefusal(r: QuotaRefusal): string {
  if (!r.plan) {
    return 'Your organisation has no plan, so nothing new can be added. Ask platform staff to assign one.';
  }
  if (r.quota === 'feature') {
    const feature = FEATURE_NOUNS[r.feature ?? ''] ?? 'this feature';
    return `Your organisation's plan (${r.plan}) does not include ${feature}. Ask platform staff to move it to a plan that does.`;
  }
  const noun = QUOTA_NOUNS[r.quota] ?? r.quota;
  const inUse = r.used === 1 ? '1 is in use' : `${r.used} are in use`;
  const adding = r.requested && r.requested > 1 ? ` and this would add ${r.requested}` : '';
  return `Your organisation's plan (${r.plan}) allows ${r.limit} ${noun}; ${inUse}${adding}. Free one up, or see Usage & billing for a larger plan.`;
}

/**
 * The sentence to show for a quota refusal: built from its data, else the engine's own message; null
 * when the error is not a quota refusal at all.
 */
export function quotaRefusalMessage(err: unknown): string | null {
  const env = envelopeOf(err);
  if (env?.responseCode !== QUOTA_RESPONSE_CODE) return null;
  if (isRefusal(env.data)) {
    if (isUnitRefusal(env.data) && typeof env.message === 'string' && env.message) return env.message;
    return describeQuotaRefusal(env.data);
  }
  return typeof env.message === 'string' && env.message
    ? env.message
    : "Your organisation's plan does not allow this. Ask platform staff for a larger plan.";
}
