/**
 * Plans, usage and fleet health (engine multi-tenancy Phase 7; contract `docs/api/plans-api.md` in the
 * engine repo). A null limit is unlimited.
 */

/** `GET /platform/plans` row. */
export interface PlanDto {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  maxTradingAccounts: number | null;
  maxActiveEaInstances: number | null;
  maxMembers: number | null;
  maxConcurrentResearchJobs: number | null;
  maxStrategies: number | null;
  maxScripts: number | null;
  maxMonthlyLlmUsd: number | null;
  logRetentionDays: number | null;
  allowsSso: boolean;
  allowsScim: boolean;
  allowsPersonalAccessTokens: boolean;
  /** Module: the prop-firm module (engine prop-module). Older engines omit it (= not included). */
  allowsPropModule?: boolean;
  /** Module: the broker dealing desk (enterprise program wave 2); absent from older engines. */
  allowsBrokerModule?: boolean;
  /** Market-data feeds the plan includes (engine C6), comma-separated; null = every feed. */
  marketDataFeeds?: string | null;
  isDefault: boolean;
  /** House's own plan: fixed, and never given to another organisation. */
  isHousePlan: boolean;
  /** Organisations on it (the default plan also counts those with none assigned). */
  organisations: number;
  createdAtUtc?: string | null;
  updatedAtUtc?: string | null;
}

/** The numeric limits of a plan, in form order. */
export const PLAN_LIMIT_FIELDS = [
  'maxTradingAccounts',
  'maxActiveEaInstances',
  'maxMembers',
  'maxConcurrentResearchJobs',
  'maxStrategies',
  'maxScripts',
] as const;
export type PlanLimitField = (typeof PLAN_LIMIT_FIELDS)[number];

/** `POST /platform/plans` (with `slug`) and `PUT /platform/plans/{id}` (without). */
export interface SavePlanBody {
  slug?: string;
  name: string;
  description: string | null;
  maxTradingAccounts: number | null;
  maxActiveEaInstances: number | null;
  maxMembers: number | null;
  maxConcurrentResearchJobs: number | null;
  maxStrategies: number | null;
  maxScripts: number | null;
  maxMonthlyLlmUsd: number | null;
  logRetentionDays: number | null;
  allowsSso: boolean;
  allowsScim: boolean;
  allowsPersonalAccessTokens: boolean;
  /** Module: the prop-firm module (engine prop-module). Older engines omit it (= not included). */
  allowsPropModule?: boolean;
  /** Module: the broker dealing desk. */
  allowsBrokerModule?: boolean;
  /** Market-data feeds (engine C6): comma-separated feed ids, `venue:*` / `source:*`; null = every feed. */
  marketDataFeeds: string | null;
  isDefault: boolean;
}

/** One bounded thing of an organisation's usage. */
export interface UsageItem {
  /** The quota key — the same one a `-403-quota` refusal names. */
  key: string;
  label: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  overLimit: boolean;
}

/** `GET /tenant/usage` and `GET /platform/tenants/{id}/usage`. */
export interface TenantUsage {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  kind: string;
  status: string;
  /** House: no limit applies. */
  unlimited: boolean;
  plan: {
    id: number;
    slug: string;
    name: string;
    description?: string | null;
    /** No plan assigned: held to the default plan. */
    viaDefault: boolean;
  } | null;
  items: UsageItem[];
  features: {
    sso: boolean;
    scim: boolean;
    personalAccessTokens: boolean;
    propModule?: boolean;
    brokerModule?: boolean;
  };
  llm: {
    /** False until per-organisation LLM metering exists: no spend figure is shown then. */
    available: boolean;
    monthlyLimitUsd: number | null;
    monthToDateUsd: number | null;
    note?: string | null;
  };
  logRetention: { days: number | null; applied: boolean; note?: string | null };
  generatedAtUtc: string;
}

export type FleetHealthState = 'Healthy' | 'Stale' | 'Disconnected' | 'ShuttingDown';

export interface FleetKillSwitch {
  scope: 'Organisation' | 'Account' | string;
  tradingAccountId: number | null;
  reason: string;
  changedBy: string | null;
  changedAtUtc: string;
}

export interface FleetOrganisation {
  tenantId: number;
  slug: string;
  name: string;
  kind: string;
  status: string;
  instances: number;
  healthy: number;
  stale: number;
  disconnected: number;
  killSwitches: FleetKillSwitch[];
  needsAttention: boolean;
}

export interface FleetInstance {
  id: number;
  instanceId: string;
  tenantId: number;
  tenantSlug: string;
  tradingAccountId: number;
  accountLogin: string | null;
  brokerServer: string | null;
  status: string;
  health: FleetHealthState | string;
  stateMachine: string | null;
  eaKillSwitchActive: boolean | null;
  eaVersion: string;
  lastHeartbeatUtc: string;
  heartbeatAgeSeconds: number;
  /** `Enrollment`, `LegacyUpgrade`, `Child` (a per-instance credential) or `LegacyApiKey`. */
  credentialOrigin: string;
  credentialLastUsedUtc: string | null;
}

/** `GET /platform/fleet`. */
export interface FleetHealth {
  generatedAtUtc: string;
  heartbeatTimeoutSeconds: number;
  sinceHours: number;
  globalKillSwitchEngaged: boolean;
  organisations: FleetOrganisation[];
  instances: FleetInstance[];
}

/** A downloaded export. */
export interface UsageExportFile {
  blob: Blob;
  fileName: string;
}
