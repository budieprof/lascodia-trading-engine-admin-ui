/**
 * The decisions behind the organisation screens, kept out of the components so they can be tested
 * on their own: validation, grouping, labels, selections.
 */
import type { PermissionDefinition } from '@core/auth/permissions.generated';
import type {
  AccessReviewEntry,
  ApprovalRequest,
  GrantSpec,
  IamMember,
  IamRole,
  MemberStatus,
  SaveSsoBody,
  ScopeType,
  SecurityPolicy,
} from './iam.types';

// ── CIDR (security policy IP allow-list) ──────────────────────────────

export type CidrCheck = { ok: true; value: string } | { ok: false; error: string };

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith('0')) return null; // no octal-looking octets
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes of an IPv6 address (`::` and an embedded IPv4 tail allowed), or null. */
function parseIPv6(s: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const g = items[i];
      if (i === items.length - 1 && g.includes('.')) {
        const v4 = parseIPv4(g);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

function hostBitsZero(bytes: number[], prefix: number): boolean {
  for (let bit = prefix; bit < bytes.length * 8; bit++) {
    if ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1) return false;
  }
  return true;
}

function networkOf(bytes: number[], prefix: number): number[] {
  return bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, prefix - i * 8));
    return keep === 0 ? 0 : b & (0xff << (8 - keep)) & 0xff;
  });
}

/** RFC 5952 text: lowercase, the longest run of two or more zero groups as `::`. */
function formatV6(bytes: number[]): string {
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/**
 * Validates one allow-list entry. A bare address is taken as a single host (`/32`, `/128`). The
 * network must have no host bits set — the engine parses entries as networks and refuses
 * `10.0.0.5/8`, so the console says which network was probably meant instead.
 */
export function checkCidr(input: string): CidrCheck {
  const s = input.trim();
  if (!s) return { ok: false, error: 'Enter an address or network, e.g. 203.0.113.0/24.' };
  const [addr, prefixText, extra] = s.split('/');
  if (extra !== undefined) return { ok: false, error: `"${s}" is not a network.` };
  const v4 = parseIPv4(addr);
  const v6 = v4 ? null : parseIPv6(addr);
  const bytes = v4 ?? v6;
  if (!bytes) return { ok: false, error: `"${addr}" is not an IP address.` };
  const max = v4 ? 32 : 128;
  if (prefixText === undefined) return { ok: true, value: `${addr}/${max}` };
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) {
    return { ok: false, error: `The prefix of "${s}" must be 0–${max}.` };
  }
  const prefix = Number(prefixText);
  if (!hostBitsZero(bytes, prefix)) {
    const net = networkOf(bytes, prefix);
    const suggestion = v4 ? net.join('.') : formatV6(net);
    return { ok: false, error: `"${s}" has host bits set — did you mean ${suggestion}/${prefix}?` };
  }
  return { ok: true, value: `${addr}/${prefix}` };
}

/** Validates a whole allow-list (one entry per line or comma). Duplicates are dropped. */
export function parseAllowlist(text: string): { entries: string[]; errors: string[] } {
  const entries: string[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    if (!raw.trim()) continue;
    const r = checkCidr(raw);
    if (r.ok) {
      if (!entries.includes(r.value)) entries.push(r.value);
    } else {
      errors.push(r.error);
    }
  }
  return { entries, errors };
}

/** Problems with a security policy before it is sent; empty when it can be saved. */
export function securityPolicyErrors(p: SecurityPolicy): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(p.sessionIdleMinutes) || p.sessionIdleMinutes < 1) {
    errors.push('Idle timeout must be a whole number of minutes, at least 1.');
  }
  if (!Number.isInteger(p.sessionAbsoluteHours) || p.sessionAbsoluteHours < 1) {
    errors.push('Session lifetime must be a whole number of hours, at least 1.');
  }
  if (
    errors.length === 0 &&
    p.sessionIdleMinutes > p.sessionAbsoluteHours * 60
  ) {
    errors.push('The idle timeout cannot be longer than the whole session.');
  }
  return errors;
}

// ── Single sign-on ─────────────────────────────────────────────────

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Problems with an SSO form before it is saved. */
export function ssoErrors(d: SaveSsoBody, hasStoredSecret: boolean): string[] {
  const errors: string[] = [];
  if (!d.displayName.trim()) errors.push('Give the connection a name people will recognise on the sign-in page.');
  try {
    const u = new URL(d.issuerOrMetadataUrl);
    if (u.protocol !== 'https:') errors.push('The issuer / metadata URL must use https.');
  } catch {
    errors.push(d.protocol === 'oidc' ? 'Enter the identity provider’s issuer URL.' : 'Enter the SAML metadata URL.');
  }
  if (d.protocol === 'oidc') {
    if (!d.clientId.trim()) errors.push('Enter the client id the identity provider gave you.');
    if (!hasStoredSecret && !(d.clientSecret ?? '').trim()) errors.push('Enter the client secret.');
  }
  const bad = d.domains.filter((x) => !DOMAIN.test(x));
  if (bad.length) errors.push(`Not e-mail domains: ${bad.join(', ')}.`);
  if (d.enabled && d.domains.length === 0) errors.push('Add at least one e-mail domain to route to this connection.');
  return errors;
}

// ── Permission catalog grouping (roles editor, token form) ────────────

export interface PermissionGroup {
  category: string;
  permissions: PermissionDefinition[];
}

/** Catalog grouped by category (sorted), keys sorted inside; deprecated keys last in each group. */
export function groupCatalog(catalog: readonly PermissionDefinition[]): PermissionGroup[] {
  const byCat = new Map<string, PermissionDefinition[]>();
  for (const p of catalog) {
    const list = byCat.get(p.category) ?? [];
    list.push(p);
    byCat.set(p.category, list);
  }
  return [...byCat.entries()]
    .map(([category, permissions]) => ({
      category,
      permissions: [...permissions].sort(
        (a, b) => Number(a.deprecated) - Number(b.deprecated) || a.key.localeCompare(b.key),
      ),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Keys a role holds that this console's catalog copy does not know (shown, never dropped). */
export function unknownKeys(keys: readonly string[], catalog: readonly PermissionDefinition[]): string[] {
  const known = new Set(catalog.map((p) => p.key));
  return keys.filter((k) => !known.has(k)).sort();
}

/** Problems with a role before it is saved. */
export function roleErrors(name: string, permissions: readonly string[], existing: readonly IamRole[], editingId: number | null): string[] {
  const errors: string[] = [];
  const n = name.trim();
  if (!n) errors.push('Give the role a name.');
  else if (n.length > 64) errors.push('Role names are at most 64 characters.');
  else if (existing.some((r) => r.id !== editingId && r.name.toLowerCase() === n.toLowerCase())) {
    errors.push(`A role called "${n}" already exists in this organisation.`);
  }
  if (permissions.length === 0) errors.push('Choose at least one permission.');
  return errors;
}

// ── Grants ────────────────────────────────────────────────────────────

/** Plain words for a scope. */
export function scopeLabel(scopeType: string, scopeId: number | null, name?: string | null): string {
  switch (scopeType) {
    case 'Tenant':
      return 'Whole organisation';
    case 'AccountGroup':
      return `Account group ${name ?? `#${scopeId}`}`;
    case 'TradingAccount':
      return `Trading account ${name ?? `#${scopeId}`}`;
    case 'Strategy':
      return `Strategy ${name ?? `#${scopeId}`}`;
    case 'Platform':
      return 'Platform';
    default:
      return `${scopeType} ${scopeId ?? ''}`.trim();
  }
}

/**
 * Permissions of a role that only count organisation-wide, so granting the role at a narrower
 * scope gives the person less than its name suggests. Empty for organisation-wide grants.
 */
export function unscopeableIn(
  role: IamRole | null | undefined,
  scopeType: ScopeType,
  catalog: readonly PermissionDefinition[],
): string[] {
  if (!role || scopeType === 'Tenant') return [];
  const byKey = new Map(catalog.map((p) => [p.key, p]));
  return role.permissions.filter((k) => byKey.get(k)?.scopeable === false).sort();
}

export interface GrantDraft {
  principalId: number | null;
  roleId: number | null;
  scopeType: ScopeType;
  scopeId: number | null;
  /** `yyyy-MM-ddTHH:mm` from a datetime-local input, or '' for no expiry. */
  expiresLocal: string;
  reason: string;
}

/** Problems with a grant before it is sent. */
export function grantErrors(d: GrantDraft, now = Date.now()): string[] {
  const errors: string[] = [];
  if (!d.principalId) errors.push('Choose who gets the role.');
  if (!d.roleId) errors.push('Choose a role.');
  if (d.scopeType !== 'Tenant' && !d.scopeId) errors.push('Choose what the role applies to.');
  if (d.expiresLocal) {
    const t = new Date(d.expiresLocal).getTime();
    if (!Number.isFinite(t)) errors.push('The expiry is not a valid date.');
    else if (t <= now) errors.push('The expiry must be in the future.');
  }
  if (d.reason.length > 500) errors.push('Keep the reason under 500 characters.');
  return errors;
}

/** ISO UTC from a datetime-local value ('' → null). */
export function localToUtc(local: string): string | null {
  if (!local) return null;
  const t = new Date(local);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
}

// ── Invitations ───────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Problems with an invitation before it is sent. */
export function invitationErrors(email: string, grants: readonly GrantSpec[]): string[] {
  const errors: string[] = [];
  if (!EMAIL.test(email.trim())) errors.push('Enter the e-mail address of the person to invite.');
  if (grants.length === 0) errors.push('Give the person at least one role.');
  grants.forEach((g, i) => {
    if (!g.roleId) errors.push(`Role ${i + 1}: choose a role.`);
    if (g.scopeType !== 'Tenant' && !g.scopeId) errors.push(`Role ${i + 1}: choose what it applies to.`);
  });
  return errors;
}

// ── Members ───────────────────────────────────────────────────────────

/** The status change offered for a member, or null (invited people are handled as invitations). */
export function nextMemberStatus(status: MemberStatus | string): { to: MemberStatus; label: string } | null {
  if (status === 'Active') return { to: 'Suspended', label: 'Suspend' };
  if (status === 'Suspended') return { to: 'Active', label: 'Reactivate' };
  return null;
}

/** Members matching a free-text filter (username, name or e-mail), in name order. */
export function filterMembers(members: readonly IamMember[], text: string): IamMember[] {
  const q = text.trim().toLowerCase();
  return members
    .filter(
      (m) =>
        !q ||
        m.username.toLowerCase().includes(q) ||
        (m.displayName ?? '').toLowerCase().includes(q) ||
        (m.email ?? '').toLowerCase().includes(q),
    )
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
}

/** A member's name for lists. */
export function memberLabel(m: Pick<IamMember, 'username' | 'displayName' | 'email'>): string {
  return m.displayName ? `${m.displayName} (${m.username})` : m.username;
}

// ── Approvals ─────────────────────────────────────────────────────

/** Whether this person may decide the request (never their own; only while pending). */
export function canDecide(r: ApprovalRequest, myUserId: number | null): { ok: boolean; why: string } {
  if (r.status !== 'Pending') return { ok: false, why: `Already ${String(r.status).toLowerCase()}.` };
  if (myUserId !== null && r.requestedByUserId === myUserId) {
    return { ok: false, why: 'You cannot approve your own request — another person must.' };
  }
  if (r.expiresAtUtc && Date.parse(r.expiresAtUtc) <= Date.now()) return { ok: false, why: 'This request has expired.' };
  return { ok: true, why: '' };
}

// ── Access review ─────────────────────────────────────────────────────

/** Ids of every stale grant (the "select all stale" action). */
export function staleGrantIds(entries: readonly AccessReviewEntry[]): number[] {
  return entries.filter((e) => e.stale).map((e) => e.grantId);
}

/** Toggles one id in a selection (returns a new set). */
export function toggled<T>(set: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ── Tokens ────────────────────────────────────────────────────────────

/** Most a personal access token may live (ADR-0030 §6 / I3.7). */
export const MAX_TOKEN_DAYS = 365;

/**
 * Problems with a token request. Its permissions must be a subset of what the session holds — the
 * engine checks too, but nobody should be offered what they cannot have.
 */
export function tokenErrors(
  name: string,
  permissions: readonly string[],
  expiresInDays: number,
  held: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push('Name the token after what will use it.');
  if (permissions.length === 0) errors.push('Choose at least one permission.');
  const extra = permissions.filter((p) => !held.has(p));
  if (extra.length) errors.push(`You do not hold: ${extra.join(', ')}.`);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_TOKEN_DAYS) {
    errors.push(`A token lasts 1–${MAX_TOKEN_DAYS} days.`);
  }
  return errors;
}

// ── Formatting ────────────────────────────────────────────────────────

/** Local date-time for a UTC timestamp, or '—'. */
export function when(utc: string | null | undefined): string {
  if (!utc) return '—';
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Whether a failed call is the page's to report. A 401 is not: the interceptor already started a
 * step-up sign-in or ended the session, and said so.
 */
export function reportable(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status !== 401;
}

/** Error text for a failed call, preferring the engine's own message. */
export function errorText(err: unknown, fallback: string): string {
  const e = err as { message?: unknown; error?: { message?: unknown } } | null;
  const fromBody = e?.error && typeof e.error.message === 'string' ? e.error.message : null;
  const own = typeof e?.message === 'string' && !/^Http failure/.test(e.message) ? e.message : null;
  return fromBody || own || fallback;
}

// ── Sessions ──────────────────────────────────────────────────────────

/** "Chrome on macOS" from a user-agent string; the raw string when nothing is recognised. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 80);
}
