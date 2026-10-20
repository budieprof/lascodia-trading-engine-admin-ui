import type {
  AuditActorType,
  AuditCategory,
  AuditChainVerification,
  AuditEventDto,
  AuditOutcome,
} from './audit-log.types';

/**
 * Pure logic behind the audit log page: the filter model and its query string, the before/after diff
 * shown in the detail drawer, and the wording of the chain-verification badge. Kept out of the
 * component so it is tested without Angular.
 */

export type AuditTimeRange = '1h' | '24h' | '7d' | '30d' | '90d' | 'all' | 'custom';

export interface AuditFilters {
  range: AuditTimeRange;
  /** `datetime-local` value (the viewer's local time); used when `range` is `custom`. */
  from: string;
  to: string;
  /** An exact actor id (`admin-user:5`) or text in the actor's name. */
  actor: string;
  actorType: AuditActorType | '';
  /** Action key prefix (`auth.`) or a full key. */
  action: string;
  category: AuditCategory | '';
  outcome: AuditOutcome | '';
  resourceType: string;
  resourceId: string;
  /** Digits only; empty = every tenant. */
  tenantId: string;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  range: '7d',
  from: '',
  to: '',
  actor: '',
  actorType: '',
  action: '',
  category: '',
  outcome: '',
  resourceType: '',
  resourceId: '',
  tenantId: '',
};

export const AUDIT_TIME_RANGES: readonly { value: AuditTimeRange; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom…' },
];

const RANGE_MS: Partial<Record<AuditTimeRange, number>> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

/** The action areas the engine writes (see the engine's `AuditActions`), offered as quick prefixes. */
export const AUDIT_ACTION_AREAS: readonly { value: string; label: string }[] = [
  { value: 'auth.', label: 'Sign-in, sessions and credentials' },
  { value: 'auth.login.', label: 'Sign-ins only' },
  { value: 'iam.', label: 'Users, roles and grants' },
  { value: 'access.denied', label: 'Authorization refusals' },
  { value: 'config.', label: 'Engine configuration' },
  { value: 'trading.', label: 'Kill switches and emergency flatten' },
  { value: 'platform.', label: 'Supervisor daemons' },
  { value: 'audit.', label: 'Audit log exports' },
];

/** The problem with `f`, in plain words, or null when it can be sent. */
export function validateAuditFilters(f: AuditFilters): string | null {
  if (f.tenantId.trim() !== '' && !/^\d{1,18}$/.test(f.tenantId.trim())) {
    return 'Tenant must be a whole number.';
  }
  if (f.range === 'custom') {
    const from = parseLocal(f.from);
    const to = parseLocal(f.to);
    if (f.from && from === null) return 'The start date is not a valid date.';
    if (f.to && to === null) return 'The end date is not a valid date.';
    if (from === null && to === null) return 'Pick a start or an end date for a custom range.';
    if (from !== null && to !== null && from >= to) return 'The start must be before the end.';
  }
  return null;
}

/**
 * Query parameters for `GET /admin/audit-events` (and `/export`): only the filters that are set, the
 * time range turned into ISO instants relative to `now`.
 */
export function auditQueryParams(f: AuditFilters, now: Date): Record<string, string> {
  const params: Record<string, string> = {};
  const span = RANGE_MS[f.range];
  if (span !== undefined) {
    params['from'] = new Date(now.getTime() - span).toISOString();
  } else if (f.range === 'custom') {
    const from = parseLocal(f.from);
    const to = parseLocal(f.to);
    if (from !== null) params['from'] = new Date(from).toISOString();
    if (to !== null) params['to'] = new Date(to).toISOString();
  }
  const text: [keyof AuditFilters, string][] = [
    ['actor', 'actor'],
    ['actorType', 'actorType'],
    ['action', 'action'],
    ['category', 'category'],
    ['outcome', 'outcome'],
    ['resourceType', 'resourceType'],
    ['resourceId', 'resourceId'],
    ['tenantId', 'tenantId'],
  ];
  for (const [field, name] of text) {
    const value = String(f[field] ?? '').trim();
    if (value !== '') params[name] = value;
  }
  return params;
}

/** `?a=1&b=2` (empty string when there is nothing to send). */
export function toQueryString(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** How many filters differ from the defaults (shown on the Reset button). */
export function activeAuditFilterCount(f: AuditFilters): number {
  let n = 0;
  for (const key of Object.keys(DEFAULT_AUDIT_FILTERS) as (keyof AuditFilters)[]) {
    if (key === 'from' || key === 'to') continue;
    if (String(f[key]).trim() !== String(DEFAULT_AUDIT_FILTERS[key])) n++;
  }
  return n;
}

function parseLocal(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Before / after diff ────────────────────────────────────────────────────

export type DiffChange = 'added' | 'removed' | 'changed' | 'same';

export interface DiffRow {
  /** Dotted path into the document (`permissions`, `aggregate.count`); `(value)` for a bare value. */
  path: string;
  before: string | null;
  after: string | null;
  change: DiffChange;
}

/**
 * A flat, readable diff of two JSON documents: objects are walked to their leaves, arrays and scalars
 * are compared as whole values (a permission list reads better as one line than as indexes).
 * Unchanged leaves are left out unless `includeSame`.
 */
export function auditJsonDiff(before: unknown, after: unknown, includeSame = false): DiffRow[] {
  const left = flatten(before);
  const right = flatten(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const rows: DiffRow[] = [];
  for (const path of paths) {
    const b = left.has(path) ? left.get(path)! : null;
    const a = right.has(path) ? right.get(path)! : null;
    const change: DiffChange =
      b === null ? 'added' : a === null ? 'removed' : a === b ? 'same' : 'changed';
    if (change === 'same' && !includeSame) continue;
    rows.push({ path, before: b, after: a, change });
  }
  return rows;
}

function flatten(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (value === null || value === undefined) return out;
  const walk = (v: unknown, path: string) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      // An empty nested object is a value worth showing; an empty document has no fields at all.
      if (entries.length === 0 && path) out.set(path, '{}');
      for (const [k, child] of entries) walk(child, path ? `${path}.${k}` : k);
      return;
    }
    out.set(path || '(value)', formatJsonValue(v));
  };
  walk(value, '');
  return out;
}

/** A JSON value as one line: strings bare, everything else as JSON. */
export function formatJsonValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v);
}

// ── Labels ─────────────────────────────────────────────────────────────────

export type Tone = 'positive' | 'negative' | 'warning' | 'neutral';

export function outcomeTone(outcome: AuditOutcome): Tone {
  switch (outcome) {
    case 'Succeeded':
      return 'positive';
    case 'Denied':
      return 'warning';
    case 'Failed':
      return 'negative';
    default:
      return 'neutral';
  }
}

/** The actor as a person reads it: the display name with the id, or the id alone. */
export function actorLabel(e: Pick<AuditEventDto, 'actorDisplay' | 'actorId'>): string {
  return e.actorDisplay && e.actorDisplay !== e.actorId
    ? `${e.actorDisplay} (${e.actorId})`
    : e.actorId;
}

export function resourceLabel(e: Pick<AuditEventDto, 'resourceType' | 'resourceId'>): string {
  if (!e.resourceType && !e.resourceId) return '—';
  if (!e.resourceId) return e.resourceType!;
  return e.resourceType ? `${e.resourceType} ${e.resourceId}` : e.resourceId;
}

/** True for a row the engine aggregated (EA sign-in failures, authorization refusals). */
export function isAggregated(e: Pick<AuditEventDto, 'after'>): boolean {
  const after = e.after as { aggregate?: { count?: unknown } } | null;
  return !!after && typeof after === 'object' && typeof after.aggregate?.count === 'number';
}

export function aggregateCount(e: Pick<AuditEventDto, 'after'>): number | null {
  return isAggregated(e) ? ((e.after as { aggregate: { count: number } }).aggregate.count ?? null) : null;
}

// ── Chain verification badge ───────────────────────────────────────────────

export interface VerificationBadge {
  tone: 'ok' | 'broken' | 'unknown' | 'running';
  label: string;
  detail: string;
}

/**
 * The badge for a verification result. `scope` says what was checked ("the last 5,000 events",
 * "the whole log") so the badge never claims more than it proved.
 */
export function verificationBadge(
  v: AuditChainVerification | null,
  scope: string,
  running = false,
): VerificationBadge {
  if (running) return { tone: 'running', label: 'Verifying…', detail: `Recomputing ${scope}.` };
  if (!v) {
    return {
      tone: 'unknown',
      label: 'Not verified',
      detail: 'The hash chain has not been checked on this page yet.',
    };
  }
  if (!v.intact && v.firstBrokenLink) {
    return {
      tone: 'broken',
      label: `Chain broken at #${v.firstBrokenLink.eventId}`,
      detail: v.firstBrokenLink.detail,
    };
  }
  const pending = v.pendingUnsealed > 0 ? `; ${v.pendingUnsealed} newest not sealed yet` : '';
  const partial = v.truncated ? ' (stopped early — more to check)' : '';
  return {
    tone: 'ok',
    label: v.rowsChecked === 0 ? 'Nothing to verify' : 'Chain intact',
    detail: `${v.sealedRowsVerified.toLocaleString('en-US')} sealed events in ${scope} recomputed and linked${pending}${partial}.`,
  };
}
