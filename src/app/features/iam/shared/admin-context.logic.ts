/**
 * Pure helpers behind the context panels of the organisation, platform and account screens: the audit-trail
 * panel (recent events for a subject, merged across several action prefixes) and the stat tiles' wording.
 * Kept out of the components so they are tested without Angular.
 */

/** The fields of an audit event the trail panel shows (a subset of the audit log's `AuditEventDto`). */
export interface TrailEvent {
  id: number;
  occurredAtUtc: string;
  actorId: string;
  actorDisplay: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  reason: string | null;
  tenantId: number | null;
}

/** Words for the action keys the engine writes most often on these screens; anything else is derived. */
const ACTION_WORDS: Record<string, string> = {
  'auth.login.succeeded': 'Signed in',
  'auth.login.failed': 'Sign-in refused',
  'auth.logout': 'Signed out',
  'auth.token.refresh_refused': 'Session renewal refused',
  'auth.machine.enrolled': 'Terminal enrolled',
  'auth.machine.legacy_upgraded': 'Terminal moved to its own credential',
  'auth.machine.legacy_refused': 'Old-style terminal sign-in refused',
  'auth.machine.enrollment_token.created': 'Enrollment token created',
  'platform.ea_release.published': 'EA build published',
  'platform.fleet.viewed': 'Fleet health viewed',
  'platform.usage.exported': 'Usage export downloaded',
  'platform.plan.created': 'Plan created',
  'platform.plan.updated': 'Plan changed',
  'platform.identity.users_linked': 'Users linked to the identity provider',
  'onboarding.ea.downloaded': 'EA downloaded',
  'iam.access_review.generated': 'Access review report written',
  'iam.access_review.campaign_generated': 'Quarterly access review opened',
  'config.engine.changed': 'Engine setting changed',
};

/** "Elevation approved" from `platform.elevation.approved`: the known wording, else the key's last parts. */
export function auditActionLabel(action: string): string {
  const known = ACTION_WORDS[action];
  if (known) return known;
  const parts = action.split('.').filter(Boolean);
  if (parts.length === 0) return action;
  // Drop the area (auth / iam / platform / tenant …) — the panel's heading already says it.
  const tail = parts.length > 2 ? parts.slice(1) : parts;
  const text = tail.join(' ').replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who did it, as a person reads it: the display name, else the namespaced id in words. */
export function auditActorLabel(e: Pick<TrailEvent, 'actorId' | 'actorDisplay'>): string {
  if (e.actorDisplay && e.actorDisplay.trim()) return e.actorDisplay.trim();
  const [kind, id] = e.actorId.split(':', 2);
  switch (kind) {
    case 'admin-user':
      return `User #${id}`;
    case 'trading-account':
      return `Account #${id}`;
    case 'daemon':
      return `Supervisor ${id}`;
    case 'service':
      return `Service ${id}`;
    case 'system':
      return 'The engine';
    case 'anonymous':
      return 'Not signed in';
    default:
      return e.actorId;
  }
}

/**
 * The newest `limit` events of several pages (one per action prefix), without duplicates — a prefix list may
 * overlap (`iam.` and `iam.grant.`).
 */
export function mergeTrail(pages: readonly (readonly TrailEvent[])[], limit: number): TrailEvent[] {
  const byId = new Map<number, TrailEvent>();
  for (const page of pages) for (const e of page) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, Math.max(0, limit));
}

/** "3 min ago", "5 h ago", "2 days ago"; '—' for no time; a future time reads "in …". */
export function ago(utc: string | null | undefined, now = Date.now()): string {
  if (!utc) return '—';
  const t = new Date(utc).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = now - t;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const text =
    s < 60
      ? 'less than a minute'
      : s < 3600
        ? `${Math.round(s / 60)} min`
        : s < 86_400
          ? `${Math.round(s / 3600)} h`
          : `${Math.round(s / 86_400)} day${Math.round(s / 86_400) === 1 ? '' : 's'}`;
  if (text === 'less than a minute') return future ? 'within a minute' : 'just now';
  return future ? `in ${text}` : `${text} ago`;
}

/** "1 team" / "3 teams" / "0 teams". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bytes as "2.1 MB" / "640 KB". */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How many items fall under each key ("Pending" → 2, "Executed" → 5). */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
