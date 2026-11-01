/** Engine `GET platform/security/posture` (gaps program security, gap #8). Platform staff only. */

export interface RateLimitPolicyStatus {
  name: string;
  partition: string;
  applies: string;
  /** Requests the policy judged in the answering process since it started. */
  counted: number;
  /** Requests it refused (HTTP 429) since the process started. */
  rejected: number;
  endpoints: number;
}

export interface RateLimitKeyPosture {
  key: string;
  policy: string;
  /** The budget applied now (requests per minute). */
  effective: number;
  /** The stored EngineConfig value; null when no row exists. */
  stored: string | null;
  default: number;
  min: number;
  max: number;
  description: string;
  lastChangedAtUtc: string | null;
  lastChangedBy: string | null;
}

export interface RateLimitExemption {
  verb: string;
  route: string;
  reason: string;
}

export interface RateLimitPosture {
  policies: RateLimitPolicyStatus[];
  keys: RateLimitKeyPosture[];
  exemptions: RateLimitExemption[];
  countingSinceUtc: string;
  settingsReadAtUtc: string | null;
  settingsReadError: string | null;
  process: string;
}

export interface EndpointAuditSummary {
  endpoints: number;
  anonymous: number;
  permission: number;
  authenticatedOnly: number;
  signedInHub: number;
  exempt: number;
  byPolicy: Record<string, number>;
  lackingAuthDecision: string[];
  lackingRateLimitDecision: string[];
  unreviewedExemptions: string[];
}

export interface DatabaseRolePosture {
  role: string | null;
  superuser: boolean | null;
  bypassesRls: boolean | null;
  tablesWithRls: number | null;
  checkedAtUtc: string | null;
  error: string | null;
  action: string | null;
}

export interface EngineHeader {
  name: string;
  value: string;
}

export type FindingSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
export type FindingStatus = 'Fixed' | 'Open' | 'Operator';

export interface SecurityFinding {
  id: string;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  area: string;
  remedy: string;
}

export interface PentestReadinessItem {
  id: string;
  title: string;
  owner: string;
  /** `Done` or `Pending`. */
  status: string;
  detail: string;
}

export interface SecurityPosture {
  rateLimits: RateLimitPosture;
  endpointAudit: EndpointAuditSummary;
  database: DatabaseRolePosture;
  engineHeaders: EngineHeader[];
  findings: SecurityFinding[];
  pentestReadiness: PentestReadinessItem[];
  generatedAtUtc: string;
}

/** One response header of the console's own origin, judged against the policy. */
export interface HeaderCheck {
  name: string;
  expected: string;
  actual: string | null;
  /** ok = meets the policy; weak = present but short of it; missing; na = not applicable here (e.g. HSTS over http). */
  status: 'ok' | 'weak' | 'missing' | 'na';
  note: string;
}
