/**
 * The decisions behind the plan, usage and fleet screens (engine multi-tenancy Phase 7), kept out of
 * the components so they can be tested on their own.
 */
import type {
  FleetInstance,
  FleetOrganisation,
  PlanDto,
  PlanLimitField,
  SavePlanBody,
  TenantUsage,
  UsageItem,
} from './plans.types';
import { PLAN_LIMIT_FIELDS } from './plans.types';

/** Same bounds as the engine's `PlanRules` (a guard against typos, not a commercial cap). */
export const MAX_COUNT_LIMIT = 1_000_000;
export const MAX_LLM_USD = 1_000_000;
export const MAX_RETENTION_DAYS = 3650;
const RESERVED_SLUGS = new Set(['house', 'default', 'none']);

/** What each limit is called on the form and in tables. */
export const LIMIT_LABELS: Readonly<Record<PlanLimitField, string>> = {
  maxTradingAccounts: 'Trading accounts',
  maxActiveEaInstances: 'Connected EA terminals',
  maxMembers: 'People (members + pending invitations)',
  maxConcurrentResearchJobs: 'Backtests / optimisations at a time',
  maxStrategies: 'Strategies',
  maxScripts: 'Saved scripts and libraries',
};

/** The usage item key of each plan limit (the engine's quota keys). */
export const LIMIT_QUOTA_KEYS: Readonly<Record<PlanLimitField, string>> = {
  maxTradingAccounts: 'tradingAccounts',
  maxActiveEaInstances: 'activeEaInstances',
  maxMembers: 'members',
  maxConcurrentResearchJobs: 'concurrentResearchJobs',
  maxStrategies: 'strategies',
  maxScripts: 'scripts',
};

// ── Plan form ─────────────────────────────────────────────────────────

/** A new plan: everything unlimited, no features, not the default. */
export function emptyPlanDraft(): SavePlanBody {
  return {
    slug: '',
    name: '',
    description: null,
    maxTradingAccounts: null,
    maxActiveEaInstances: null,
    maxMembers: null,
    maxConcurrentResearchJobs: null,
    maxStrategies: null,
    maxScripts: null,
    maxMonthlyLlmUsd: null,
    logRetentionDays: null,
    allowsSso: false,
    allowsScim: false,
    allowsPersonalAccessTokens: false,
    isDefault: false,
  };
}

/** The edit form of an existing plan (its slug is permanent and not sent). */
export function draftFromPlan(p: PlanDto): SavePlanBody {
  return {
    name: p.name,
    description: p.description ?? null,
    maxTradingAccounts: p.maxTradingAccounts,
    maxActiveEaInstances: p.maxActiveEaInstances,
    maxMembers: p.maxMembers,
    maxConcurrentResearchJobs: p.maxConcurrentResearchJobs,
    maxStrategies: p.maxStrategies,
    maxScripts: p.maxScripts,
    maxMonthlyLlmUsd: p.maxMonthlyLlmUsd,
    logRetentionDays: p.logRetentionDays,
    allowsSso: p.allowsSso,
    allowsScim: p.allowsScim,
    allowsPersonalAccessTokens: p.allowsPersonalAccessTokens,
    isDefault: p.isDefault,
  };
}

/** A limit typed in a box: '' = unlimited (null); anything that is not a number stays as typed (NaN). */
export function parseLimit(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  return Number(s);
}

/** Problems with a plan before it is sent (`creating` = a new plan, which needs a slug). */
export function planErrors(d: SavePlanBody, creating: boolean): string[] {
  const errors: string[] = [];
  if (creating) {
    const slug = (d.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug)) {
      errors.push(
        'Slug must be 3–63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      );
    } else if (RESERVED_SLUGS.has(slug)) {
      errors.push('That slug is reserved.');
    }
  }
  if (!d.name.trim()) errors.push('Give the plan a name.');
  else if (d.name.trim().length > 128) errors.push('Names are at most 128 characters.');
  if ((d.description ?? '').length > 1000) errors.push('The description is at most 1,000 characters.');

  for (const field of PLAN_LIMIT_FIELDS) {
    const v = d[field];
    if (v === null) continue;
    const min = field === 'maxMembers' ? 1 : 0;
    if (!Number.isInteger(v) || v < min || v > MAX_COUNT_LIMIT) {
      errors.push(
        field === 'maxMembers'
          ? `${LIMIT_LABELS[field]}: a whole number from 1 (the organisation's Owner), or empty for unlimited.`
          : `${LIMIT_LABELS[field]}: a whole number from 0, or empty for unlimited.`,
      );
    }
  }
  const llm = d.maxMonthlyLlmUsd;
  if (llm !== null && (!Number.isFinite(llm) || llm < 0 || llm > MAX_LLM_USD)) {
    errors.push('Monthly LLM budget: an amount in US dollars from 0, or empty for unlimited.');
  }
  const days = d.logRetentionDays;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS)) {
    errors.push(`Log retention: whole days from 1 to ${MAX_RETENTION_DAYS}, or empty for the platform's.`);
  }
  return errors;
}

/** The body to send: a trimmed name and description, the slug lowercased on create. */
export function planBody(d: SavePlanBody, creating: boolean): SavePlanBody {
  const body: SavePlanBody = {
    ...d,
    name: d.name.trim(),
    description: d.description?.trim() ? d.description.trim() : null,
  };
  if (creating) body.slug = (d.slug ?? '').trim().toLowerCase();
  else delete body.slug;
  return body;
}

// ── Display ───────────────────────────────────────────────────────────

/** "Unlimited" or the number. */
export function limitText(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unlimited' : value.toLocaleString('en-US');
}

/** "$10.00" or "Unlimited". */
export function usdText(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unlimited';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The features a plan includes, in words; "None" when it includes none. */
export function featureList(p: {
  allowsSso: boolean;
  allowsScim: boolean;
  allowsPersonalAccessTokens: boolean;
}): string {
  const names = [
    p.allowsSso ? 'Single sign-on' : null,
    p.allowsScim ? 'SCIM' : null,
    p.allowsPersonalAccessTokens ? 'Access tokens' : null,
  ].filter((n): n is string => n !== null);
  return names.length ? names.join(', ') : 'None';
}

/** Share of the limit in use (0–100, capped), or null when unlimited. A zero limit with nothing in use is 0. */
export function usagePercent(item: Pick<UsageItem, 'limit' | 'used'>): number | null {
  if (item.limit === null) return null;
  if (item.limit === 0) return item.used > 0 ? 100 : 0;
  return Math.min(100, Math.round((item.used / item.limit) * 100));
}

/** How an item reads: plenty of room, getting close (≥ 80 %), or full / over. */
export function usageTone(item: Pick<UsageItem, 'limit' | 'used' | 'overLimit'>): 'ok' | 'warn' | 'bad' {
  if (item.limit === null) return 'ok';
  if (item.overLimit || item.used >= item.limit) return 'bad';
  return (usagePercent(item) ?? 0) >= 80 ? 'warn' : 'ok';
}

/** "2 of 4", "3 (unlimited)". */
export function usageText(item: Pick<UsageItem, 'limit' | 'used'>): string {
  return item.limit === null
    ? `${item.used.toLocaleString('en-US')} (unlimited)`
    : `${item.used.toLocaleString('en-US')} of ${item.limit.toLocaleString('en-US')}`;
}

/**
 * What would be over the target plan's limits if an organisation moved to it — shown before staff
 * confirm (moving removes nothing; the organisation just cannot add more).
 */
export function overLimitOn(target: PlanDto, usage: TenantUsage | null): string[] {
  if (!usage || target.isHousePlan) return [];
  const out: string[] = [];
  for (const field of PLAN_LIMIT_FIELDS) {
    const limit = target[field];
    const item = usage.items.find((i) => i.key === LIMIT_QUOTA_KEYS[field]);
    if (limit === null || !item || item.used <= limit) continue;
    out.push(`${LIMIT_LABELS[field]}: ${item.used} in use, ${target.name} allows ${limit}`);
  }
  return out;
}

// ── Monthly export ────────────────────────────────────────────────────

/** "2026-10" for a date (UTC). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The current month and the `count - 1` before it, newest first (the export takes no future month). */
export function exportMonths(now: Date, count = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

/** "September 2026" for "2026-09". */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The refusal text inside a failed blob download (the engine answers an envelope even when a file
 * was asked for); the fallback when it cannot be read.
 */
export async function blobErrorText(err: unknown, fallback: string): Promise<string> {
  const body = (err as { error?: unknown } | null)?.error;
  if (body instanceof Blob) {
    try {
      const parsed = JSON.parse(await body.text()) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch {
      // not an envelope
    }
  }
  return fallback;
}

// ── Fleet ─────────────────────────────────────────────────────────────

export type FleetFilter = 'all' | 'attention' | 'stale' | 'disconnected';

const HEALTH_ORDER: Record<string, number> = { Stale: 0, Healthy: 1, ShuttingDown: 2, Disconnected: 3 };

/** Terminals to show: by filter, organisation and a free-text search; stale first, then by organisation. */
export function fleetRows(
  instances: readonly FleetInstance[],
  filter: FleetFilter,
  tenantId: number | null,
  search: string,
): FleetInstance[] {
  const q = search.trim().toLowerCase();
  return instances
    .filter((i) => tenantId === null || i.tenantId === tenantId)
    .filter((i) =>
      filter === 'stale'
        ? i.health === 'Stale'
        : filter === 'disconnected'
          ? i.health === 'Disconnected' || i.health === 'ShuttingDown'
          : filter === 'attention'
            ? i.health === 'Stale' || (i.stateMachine !== null && i.stateMachine !== 'RUNNING')
            : true,
    )
    .filter(
      (i) =>
        !q ||
        i.instanceId.toLowerCase().includes(q) ||
        i.tenantSlug.toLowerCase().includes(q) ||
        (i.accountLogin ?? '').toLowerCase().includes(q) ||
        i.eaVersion.toLowerCase().includes(q),
    )
    .slice()
    .sort(
      (a, b) =>
        (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) ||
        a.tenantSlug.localeCompare(b.tenantSlug) ||
        a.instanceId.localeCompare(b.instanceId),
    );
}

/** Organisations that need a look first. */
export function attentionFirst(orgs: readonly FleetOrganisation[]): FleetOrganisation[] {
  return orgs
    .slice()
    .sort(
      (a, b) =>
        Number(b.needsAttention) - Number(a.needsAttention) ||
        b.stale - a.stale ||
        a.slug.localeCompare(b.slug),
    );
}

/** "45 s", "12 min", "3 h", "2 d". */
export function ageText(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/** How the terminal signs in, in words. */
export function credentialLabel(origin: string): string {
  switch (origin) {
    case 'Enrollment':
      return 'Own credential (enrolled)';
    case 'LegacyUpgrade':
      return 'Own credential (upgraded from API key)';
    case 'Child':
      return 'Own credential (sibling terminal)';
    case 'LegacyApiKey':
      return 'Shared account API key (legacy)';
    default:
      return origin;
  }
}
