/**
 * Wire shapes of the engine's backend-for-frontend (contract C3.1, multi-tenancy W3). Successful
 * `/bff/*` answers are bare JSON objects; refusals are the engine's `ResponseData` envelope
 * (401 `-401` / `-401-stepup`, 403 `-403` / `-403-csrf`).
 */

export interface BffUser {
  /** The engine's AdminUser id. */
  id: number;
  username: string;
  displayName: string;
  email: string;
}

/** `House`, `Customer`, `Canary` or `Demo` (the showcase organisation: recorded data, never trades). */
export type TenantKind = 'House' | 'Customer' | 'Canary' | 'Demo' | string;

export interface BffTenant {
  id: number;
  slug: string;
  name: string;
  kind: TenantKind;
}

/** `Invited`, `Active` or `Suspended`. */
export type MembershipStatus = 'Invited' | 'Active' | 'Suspended' | string;

export interface BffMembership {
  tenantId: number;
  slug: string;
  name: string;
  status: MembershipStatus;
}

/** Present while platform staff view the console as another user. */
export interface BffImpersonation {
  actorUserId: number;
  actorName: string;
  readOnly: boolean;
}

export interface BffMfa {
  /** The sign-in used a second factor (authenticator app, security key, passkey). */
  satisfied: boolean;
  /** When the person last authenticated interactively (ISO, UTC). */
  authTimeUtc: string;
}

/** `GET /bff/session`. */
export interface BffSession {
  user: BffUser;
  activeTenant: BffTenant | null;
  memberships: BffMembership[];
  /** Permission keys effective in the active organisation. */
  permissions: string[];
  isPlatformStaff: boolean;
  impersonation: BffImpersonation | null;
  /** Send as `X-CSRF-Token` on every unsafe request. */
  csrfToken: string;
  mfa: BffMfa;
  sessionId: string;
  expiresAtUtc: string;
  /** Sign the console out after this long without activity. */
  idleTimeoutSeconds: number;
}

/** `POST /bff/logout`. */
export interface BffLogoutResponse {
  logoutUrl: string;
}

/** `POST /bff/ws-ticket`. */
export interface BffWsTicket {
  ticket: string;
  expiresInSeconds: number;
}

/** Header the engine checks on unsafe cookie-authenticated requests. */
export const CSRF_HEADER = 'X-CSRF-Token';

/** Envelope codes the console reacts to (contracts C3.1–C3.3). */
export const AuthResponseCode = {
  StepUp: '-401-stepup',
  Csrf: '-403-csrf',
  ApprovalPending: '-202-approval',
} as const;

/**
 * Why `/bff/callback` sent the person back without a session: it appends `signin_error=<code>` to the
 * return path. Plain explanations for the login page.
 */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'no_access':
      return 'Your sign-in worked, but this console has no active account for you. Ask an administrator to invite you.';
    case 'no_membership':
      // A self-served organisation waiting for platform approval lands here too (multi-tenancy Phase 7, LC.1).
      return 'You are not an active member of any organisation yet. If you have just created one, it is waiting for approval: sign in again once it is approved. Otherwise ask an administrator to invite you.';
    case 'tenant_not_available':
      return 'That organisation is not available to you. Sign in again to use another one.';
    case 'network_not_allowed':
      return 'Your organisation does not allow sign-in from this network.';
    case 'mfa_required':
      return 'This needs a sign-in with your authenticator app or security key. Sign in again and use it.';
    case 'unavailable':
      return 'Sign-in is unavailable right now. Try again in a minute.';
    case 'access_denied':
      return 'Sign-in was cancelled.';
    default:
      return 'Sign-in did not complete. Try again.';
  }
}
