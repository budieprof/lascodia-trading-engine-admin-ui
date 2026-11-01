import type {
  HeaderCheck,
  RateLimitKeyPosture,
  RateLimitPolicyStatus,
  SecurityFinding,
} from './security-posture.types';

/** One year — the HSTS max-age the policy asks for. */
export const HSTS_MIN_MAX_AGE = 31_536_000;

/** CSP directives by name (lower case) → their source lists. */
export function parseCsp(header: string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (header ?? '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!out.has(name)) out.set(name, tokens.slice(1));
  }
  return out;
}

/** The sources that govern scripts: script-src, else default-src (CSP fallback). */
export function scriptSources(csp: Map<string, string[]>): string[] | null {
  return csp.get('script-src') ?? csp.get('default-src') ?? null;
}

function hsts(value: string | null, https: boolean): HeaderCheck {
  const expected = `max-age ≥ ${HSTS_MIN_MAX_AGE} (1 year); includeSubDomains`;
  if (!https)
    return {
      name: 'Strict-Transport-Security',
      expected,
      actual: value,
      status: 'na',
      note: 'Browsers honour HSTS only over HTTPS — open the console through its public https address to check it.',
    };
  if (!value)
    return {
      name: 'Strict-Transport-Security',
      expected,
      actual: null,
      status: 'missing',
      note: 'Not sent. Apply deploy/caddy/Caddyfile.security.diff (engine repo).',
    };
  const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(value)?.[1] ?? NaN);
  const sub = /includesubdomains/i.test(value);
  const ok = Number.isFinite(maxAge) && maxAge >= HSTS_MIN_MAX_AGE && sub;
  return {
    name: 'Strict-Transport-Security',
    expected,
    actual: value,
    status: ok ? 'ok' : 'weak',
    note: ok
      ? 'Browsers will refuse plain http for this host for a year.'
      : `Shorter than the policy (${Number.isFinite(maxAge) ? Math.round(maxAge / 86400) + ' days' : 'no max-age'}${sub ? '' : ', no includeSubDomains'}). Apply deploy/caddy/Caddyfile.security.diff.`,
  };
}

function cspCheck(value: string | null): HeaderCheck {
  const expected = "script-src without 'unsafe-inline' / 'unsafe-eval'; frame-ancestors 'none'";
  if (!value)
    return {
      name: 'Content-Security-Policy',
      expected,
      actual: null,
      status: 'missing',
      note: 'No policy on the console page.',
    };
  const csp = parseCsp(value);
  const scripts = scriptSources(csp) ?? [];
  const problems: string[] = [];
  if (scripts.includes("'unsafe-inline'")) problems.push("inline script allowed ('unsafe-inline')");
  if (scripts.includes("'unsafe-eval'")) problems.push("eval allowed ('unsafe-eval')");
  if (!(csp.get('frame-ancestors') ?? []).includes("'none'")) problems.push('framing not refused');
  return {
    name: 'Content-Security-Policy',
    expected,
    actual: value,
    status: problems.length ? 'weak' : 'ok',
    note: problems.length
      ? `${problems.join('; ')}. Apply deploy/caddy/Caddyfile.security.diff after this console release.`
      : (csp.get('style-src') ?? []).includes("'unsafe-inline'")
        ? 'Inline styles stay allowed (Angular component styles) — the documented residue.'
        : 'Meets the policy.',
  };
}

function exact(name: string, expected: string, value: string | null, note: string): HeaderCheck {
  const ok = value !== null && value.trim().toLowerCase() === expected.toLowerCase();
  return {
    name,
    expected,
    actual: value,
    status: value === null ? 'missing' : ok ? 'ok' : 'weak',
    note,
  };
}

/**
 * Judges the console origin's own response headers (read with a same-origin HEAD of `/`). `get` returns a header
 * value or null; `https` is whether the page was loaded over https (HSTS means nothing over http).
 */
export function checkHeaders(get: (name: string) => string | null, https: boolean): HeaderCheck[] {
  return [
    hsts(get('strict-transport-security'), https),
    cspCheck(get('content-security-policy')),
    exact('X-Content-Type-Options', 'nosniff', get('x-content-type-options'), 'No MIME sniffing.'),
    exact(
      'X-Frame-Options',
      'DENY',
      get('x-frame-options'),
      'Legacy anti-framing (CSP frame-ancestors covers modern browsers).',
    ),
    exact(
      'Referrer-Policy',
      'strict-origin-when-cross-origin',
      get('referrer-policy'),
      'Other sites see the origin only, never the page.',
    ),
  ];
}

/** Why a typed budget is refused, or null when it is a whole number in range. */
export function budgetError(
  raw: string,
  key: Pick<RateLimitKeyPosture, 'min' | 'max'>,
): string | null {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return 'Enter a whole number of requests per minute.';
  const n = Number(v);
  if (n < key.min || n > key.max)
    return `Between ${key.min} and ${key.max.toLocaleString('en-US')}.`;
  return null;
}

/**
 * A warning when a new budget sits close to the traffic the policy carries — the console cannot know the per-principal
 * peak, so this compares with the busiest a single principal could plausibly be: everything the policy counted, spread
 * over the minutes since counting started.
 */
export function budgetWarning(
  value: number,
  policy: RateLimitPolicyStatus | undefined,
  sinceUtc: string,
  now: number,
): string | null {
  if (!policy) return null;
  const minutes = Math.max(1, (now - Date.parse(sinceUtc)) / 60_000);
  const perMinute = policy.counted / minutes;
  if (value < perMinute * 2)
    return `The "${policy.name}" policy carried ~${Math.round(perMinute)} requests/min in total since this process started; a budget below twice that may refuse real traffic.`;
  return null;
}

/** Share of a policy's requests it refused, as a percentage with one decimal ('—' when it saw none). */
export function rejectShare(p: Pick<RateLimitPolicyStatus, 'counted' | 'rejected'>): string {
  if (p.counted <= 0) return p.rejected > 0 ? '100%' : '—';
  return `${((100 * p.rejected) / p.counted).toFixed(1)}%`;
}

const SEVERITY_ORDER: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
const STATUS_ORDER: Record<string, number> = { Open: 0, Operator: 1, Fixed: 2 };

/** Open first, then operator items, then fixed; most severe first within each. */
export function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.id.localeCompare(b.id),
  );
}

/** Counts per status, for the summary tiles. */
export function findingCounts(findings: SecurityFinding[]): {
  open: number;
  operator: number;
  fixed: number;
} {
  return {
    open: findings.filter((f) => f.status === 'Open').length,
    operator: findings.filter((f) => f.status === 'Operator').length,
    fixed: findings.filter((f) => f.status === 'Fixed').length,
  };
}
