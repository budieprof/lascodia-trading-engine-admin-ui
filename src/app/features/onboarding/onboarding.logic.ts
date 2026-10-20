import type { SignupBody, TenantSignup, TenantSignupStatus } from './onboarding.types';

/** A handle from an organisation's name, as the engine makes it (lowercase letters/digits, hyphens, 3–63). */
export function slugFrom(name: string): string {
  let slug = '';
  for (const c of name.trim().toLowerCase()) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) slug += c;
    else if (slug.length > 0 && !slug.endsWith('-')) slug += '-';
  }
  slug = slug.replace(/^-+|-+$/g, '');
  if (slug.length > 63) slug = slug.slice(0, 63).replace(/-+$/, '');
  if (slug.length < 3) slug = `${slug}-org`.replace(/^-+/, '');
  return RESERVED.has(slug) ? `${slug}-org` : slug;
}

const RESERVED = new Set([
  'house',
  'platform',
  'admin',
  'api',
  'system',
  'root',
  'public',
  'internal',
  'lascodia',
]);

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug) && !RESERVED.has(slug);
}

/** The engine's plausibility check for an address (the identity provider verifies it). */
export function isPlausibleEmail(email: string): boolean {
  const e = email.trim();
  if (!e || /\s/.test(e) || (e.match(/@/g) ?? []).length !== 1) return false;
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return false;
  const domain = e.slice(at + 1);
  return (
    domain.includes('.') &&
    !domain.startsWith('.') &&
    !domain.endsWith('.') &&
    !domain.includes('..')
  );
}

/** What is wrong with the form (empty = it may be sent). */
export function signupProblems(body: SignupBody): string[] {
  const problems: string[] = [];
  if (!isPlausibleEmail(body.email)) problems.push('Enter a valid e-mail address.');
  if (!body.displayName.trim()) problems.push('Enter your name.');
  if (body.organisationName.trim().length < 2) problems.push("Enter the organisation's name.");
  if (body.organisationSlug && !isValidSlug(body.organisationSlug))
    problems.push(
      'The handle must be 3–63 lowercase letters, digits and hyphens (not a reserved word).',
    );
  return problems;
}

/** The refusal a sign-up answered with, in plain words (by response code). */
export function signupRefusal(
  code: string | null | undefined,
  message: string | null | undefined,
): string {
  switch (code) {
    case '-429':
      return message || 'Too many sign-ups from here today. Please try again tomorrow.';
    case '-503':
      return (
        message || 'Creating an organisation is not available right now. Please try again later.'
      );
    default:
      return message || 'The organisation could not be requested. Check the form and try again.';
  }
}

export function signupStatusLabel(s: TenantSignup): string {
  if (s.expired && (s.status === 'Pending' || s.status === 'Approved'))
    return 'Lapsed (address never verified)';
  const labels: Record<TenantSignupStatus, string> = {
    Pending: s.emailVerifiedAtUtc
      ? 'Verified — waiting for approval'
      : 'Waiting for e-mail verification',
    Approved: 'Approved — waiting for the verified sign-in',
    Provisioned: 'Organisation created',
    Rejected: 'Turned down',
    Expired: 'Lapsed',
  };
  return labels[s.status] ?? s.status;
}

export function signupTone(s: TenantSignup): 'ok' | 'warn' | 'bad' | 'muted' | 'info' {
  if (s.status === 'Provisioned') return 'ok';
  if (s.status === 'Rejected') return 'bad';
  if (s.expired || s.status === 'Expired') return 'muted';
  return s.emailVerifiedAtUtc ? 'info' : 'warn';
}

/** Staff may decide a request that is open (pending, or approved and still waiting). */
export function canDecide(s: TenantSignup): { approve: boolean; reject: boolean } {
  const open = !s.expired && (s.status === 'Pending' || s.status === 'Approved');
  return { approve: open && s.status === 'Pending', reject: open };
}

/** "2 of 4 done". */
export function progressText(completed: number, total: number): string {
  return completed >= total ? 'All done' : `${completed} of ${total} done`;
}
