import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Observable,
  catchError,
  defer,
  firstValueFrom,
  map,
  of,
  shareReplay,
  switchMap,
  tap,
  timeout,
} from 'rxjs';
import { ApiService } from '../api/api.service';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import { BrowserLocation } from '../browser/browser-location';
import {
  HOUSE_TENANT_ID,
  setStorageIdentity,
  type StorageIdentity,
} from '../storage/app-storage';
import { decodeJwt, rolesFromPayload } from './jwt';
import { DEFAULT_POST_LOGIN_ROUTE, returnUrlQueryParams, sanitizeReturnUrl } from './return-url';
import { authModeFrom, type AuthMode } from './auth-mode';
import { BffSessionService } from './bff-session.service';
import type { BffImpersonation, BffMembership, BffSession, BffTenant } from './bff.types';
import { CSRF_HEADER } from './bff.types';
import { IdleTimeoutService } from './idle-timeout.service';
import { permissionsForLegacyRoles } from './legacy-role-permissions';
import { Permission, type PermissionKey } from './permissions.generated';
import { canSee, type AccessSubject } from './route-access';

export interface AuthUser {
  passportId: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Canonical role names mirroring the engine's `OperatorRoleNames`. Kept as a
 * const tuple so usages are autocompleted and typos surface at compile time.
 * Gating no longer uses roles (permission keys do, see `hasPermission`); the
 * names remain for the Operator Roles page and legacy feature-flag rules.
 */
export const ROLES = {
  Viewer: 'Viewer',
  Trader: 'Trader',
  Analyst: 'Analyst',
  Operator: 'Operator',
  Admin: 'Admin',
  EA: 'EA',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Engine `POST /auth/login` payload (web login — password required). */
export interface OperatorLoginCredentials {
  accountId: string;
  brokerServer: string;
  password: string;
}

/** Shape of a successful `POST /auth/login` envelope from the engine. */
export interface OperatorAuthEnvelope {
  data: {
    token: string;
    expiresAt: string;
    tokenType: string;
    account?: {
      id: number;
      accountId: string;
      accountName: string;
      brokerServer: string;
      brokerName: string;
    };
  } | null;
  status: boolean;
  message: string | null;
  responseCode: string | null;
}

/** Shape of a successful `POST /admin/auth/login` envelope from the engine. */
export interface AdminAuthEnvelope {
  data: {
    token: string;
    expiresAt: string;
    tokenType: string;
    mustChangePassword: boolean;
    user?: {
      id: number;
      username: string;
      displayName: string;
      email: string;
      isSuperAdmin: boolean;
      roles: string[];
    };
  } | null;
  status: boolean;
  message: string | null;
}

/** Shape of `GET /admin/auth/me` data. */
export interface AdminMeData {
  id: number;
  username: string;
  displayName: string;
  email: string;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

/** Why a session ended without the person choosing to sign out — shown on the login page. */
export type SignOutReason = 'expired' | 'idle';

/**
 * Legacy session persistence (`bffAuth` off):
 *   - Token + user are mirrored to `sessionStorage` so a page refresh doesn't
 *     kick the operator back to /login. Closing the tab clears it — meets the
 *     PRD §14 "JWT not in localStorage" bar while fixing the reload UX.
 *   - An idle-timeout watcher logs out after N minutes of no user activity
 *     (pointerdown, keydown, visibilitychange). Tunable via IDLE_TIMEOUT_MS.
 *     Currently DISABLED via IDLE_LOGOUT_ENABLED so the console can be left
 *     open and unattended for long stretches without self-logging-out; flip
 *     the flag back to `true` to restore the idle timeout.
 *
 * With `bffAuth` on, none of that applies: the session lives server-side behind
 * an HttpOnly cookie, nothing is stored here, and the idle timeout is ON with the
 * organisation's own `idleTimeoutSeconds` ({@link IdleTimeoutService}).
 */
const TOKEN_KEY = 'lascodia.auth.token';
const USER_KEY = 'lascodia.auth.user';
const PERMS_KEY = 'lascodia.auth.perms';
const LAST_ACTIVITY_KEY = 'lascodia.auth.lastActivity';
/** One-shot note for the login page: why the previous session ended (BFF sign-out leaves the app). */
export const SIGNED_OUT_NOTE_KEY = 'lascodia.auth.signedOutNote';
// Master switch for the client-side idle auto-logout. When false, neither
// the restored-session staleness check nor the periodic watcher will ever
// log the operator out for inactivity (the JWT's own server-side expiry
// still applies and is out of this layer's control).
const IDLE_LOGOUT_ENABLED = false;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_THROTTLE_MS = 30 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
/** The boot-time permission load may hold up the first render this long, no longer. */
const INIT_TIMEOUT_MS = 10_000;

// ── Token-refresh tunables ────────────────────────────────────────────
// Schedule the proactive refresh this far ahead of the JWT's `exp`. Keep it
// generous enough to absorb a slow round-trip + network blip yet not so wide
// that the new token is itself ~ as old as the one it replaced.
const REFRESH_LEAD_MS = 5 * 60 * 1000; // 5 minutes
// Floor on the timer — never schedule under 30s so a token issued with an
// implausibly tight exp (clock skew, dev shorts) still gives the app room to
// breathe before re-firing.
const REFRESH_MIN_DELAY_MS = 30 * 1000;
// Cookie-session fallback cadence: when the JWT lives in an HttpOnly cookie
// we can't read `exp`. The engine default exp is 8h; refreshing every hour
// keeps the session indefinitely fresh with minimal extra traffic.
const REFRESH_COOKIE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Sentinel used when the JWT lives only in the HttpOnly cookie (the JS layer
// has no readable token string). Kept in sync with `probeCookieSession()`.
const COOKIE_SESSION_SENTINEL = 'cookie-session';

/**
 * Who is signed in, what they may do, and the sign-in / sign-out flows — for both
 * auth modes behind one surface ({@link AuthMode}, `config.json` → `featureFlags.bffAuth`).
 *
 * Gating is by PERMISSION KEY only ({@link hasPermission}). A session without
 * permissions sees nothing privileged: the old "no role claims = full access"
 * fallbacks are gone. The engine remains the enforcer; this is UX.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly bff = inject(BffSessionService);
  private readonly browser = inject(BrowserLocation);
  private readonly idle = inject(IdleTimeoutService);

  /** Fixed for the life of the page: the flag is read once from `config.json`. */
  readonly mode: AuthMode = authModeFrom(inject(RUNTIME_CONFIG));

  // ── Legacy state (empty in BFF mode) ──────────────────────────────────
  private readonly _token = signal<string | null>(
    this.mode === 'legacy' ? this.readSessionString(TOKEN_KEY) : null,
  );
  private readonly _legacyUser = signal<AuthUser | null>(
    this.mode === 'legacy' ? this.readSessionJson<AuthUser>(USER_KEY) : null,
  );
  /**
   * When the session is backed by an HttpOnly cookie, the JWT is unreadable
   * from JS — so `probeCookieSession()` populates this signal with the roles
   * the engine reported via `GET /auth/whoami`.
   */
  private readonly _cookieRoles = signal<string[]>([]);
  private readonly _cookieAccountId = signal<number | null>(null);
  /** Admin-user permissions reported by `GET /admin/auth/me`. */
  private readonly _adminPermissions = signal<string[]>(
    this.mode === 'legacy' ? (this.readSessionJson<string[]>(PERMS_KEY) ?? []) : [],
  );
  private readonly _isSuperAdmin = signal<boolean>(false);
  private readonly _mustChangePassword = signal<boolean>(false);

  /** The legacy bearer token (null in BFF mode — the browser never holds one there). */
  readonly token = this._token.asReadonly();

  /** The BFF session payload (null in legacy mode and when signed out). */
  readonly session = this.bff.session;

  readonly isAuthenticated = computed(() =>
    this.mode === 'bff' ? this.bff.session() !== null : this._token() !== null,
  );

  readonly user = computed<AuthUser | null>(() => {
    if (this.mode === 'legacy') return this._legacyUser();
    const s = this.bff.session();
    if (!s) return null;
    return {
      passportId: String(s.user.id),
      firstName: s.user.displayName || s.user.username,
      lastName: '',
      email: s.user.email ?? '',
    };
  });

  /**
   * Role claims of a legacy token (or the roles `/auth/whoami` reported for a
   * legacy cookie session). Informational — gating uses permissions. Always
   * empty in BFF mode: roles are per organisation there and the session reports
   * the resulting permissions instead.
   */
  readonly roles = computed<readonly string[]>(() => {
    if (this.mode === 'bff') return [];
    const fromToken = rolesFromPayload(decodeJwt(this._token()));
    if (fromToken.length > 0) return fromToken;
    return this._cookieRoles();
  });

  /**
   * Effective permission keys in the active organisation.
   *  - BFF: exactly what `/bff/session` reports.
   *  - Legacy admin user: what `GET /admin/auth/me` reports (super admins get the full catalog).
   *  - Legacy trading-account login: the bundles of its role claims
   *    ({@link permissionsForLegacyRoles}).
   *  - Anything else: none.
   */
  readonly permissions = computed<readonly string[]>(() => {
    if (this.mode === 'bff') return this.bff.session()?.permissions ?? [];
    if (!this._token()) return [];
    if (this.isAdminToken()) return this._adminPermissions();
    return permissionsForLegacyRoles(this.roles());
  });
  private readonly permissionSet = computed(() => new Set(this.permissions()));

  readonly isSuperAdmin = this._isSuperAdmin.asReadonly();
  /** True when the user must change their password before using the app (legacy only). */
  readonly mustChangePassword = this._mustChangePassword.asReadonly();

  /** The organisation the console acts in (BFF); null in legacy mode, which is always House. */
  readonly activeTenant = computed<BffTenant | null>(() => this.bff.session()?.activeTenant ?? null);
  /** Organisations the person belongs to (BFF); empty in legacy mode. */
  readonly memberships = computed<readonly BffMembership[]>(
    () => this.bff.session()?.memberships ?? [],
  );
  /**
   * Platform staff may use the platform console. BFF: as `/bff/session` reports it (false while
   * impersonating). Legacy: a House administrator holding `platform.tenants.manage` — the only
   * platform page that works without the BFF is Organisations, whose API is gated the same way.
   */
  readonly isPlatformStaff = computed(() =>
    this.mode === 'bff'
      ? (this.bff.session()?.isPlatformStaff ?? false)
      : this.hasPermission(Permission.PlatformTenantsManage),
  );

  /** The person as the route table ({@link ROUTE_ACCESS}) sees them. */
  readonly accessSubject = computed<AccessSubject>(() => ({
    hasPermission: (key: string) => this.hasPermission(key),
    bff: this.mode === 'bff',
    platformStaff: this.isPlatformStaff(),
  }));
  /** Set while platform staff view the console as this user. */
  readonly impersonation = computed<BffImpersonation | null>(
    () => this.bff.session()?.impersonation ?? null,
  );

  /** Whose `localStorage` namespace is in use (see `core/storage/app-storage.ts`). */
  readonly storageIdentity = computed<StorageIdentity | null>(() => {
    if (this.mode === 'bff') {
      const s = this.bff.session();
      if (!s || !s.activeTenant) return null;
      return { userKey: `u${s.user.id}`, tenantId: s.activeTenant.id };
    }
    const payload = decodeJwt(this._token());
    const adminId = Number(payload?.['adminUserId']);
    if (Number.isInteger(adminId) && adminId > 0) {
      return { userKey: `u${adminId}`, tenantId: HOUSE_TENANT_ID };
    }
    const accountId = Number(payload?.tradingAccountId ?? this._cookieAccountId());
    if (Number.isInteger(accountId) && accountId > 0) {
      return { userKey: `acct${accountId}`, tenantId: HOUSE_TENANT_ID };
    }
    return null;
  });

  private lastActivity = Number(this.readSessionString(LAST_ACTIVITY_KEY) ?? Date.now());
  private activityListenersBound = false;
  private idleIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Pending pro-active token-refresh handle. Scheduled by `scheduleRefresh()`
   * to fire ~5 min before the JWT's `exp` so the operator never sees their
   * session blink — and re-armed by the refresh response. Cleared on logout
   * and on every reschedule.
   */
  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  /**
   * De-duped in-flight refresh. The 401-fallback interceptor and the
   * proactive timer can race; sharing the same observable means concurrent
   * callers all see the same outcome and the engine only sees one POST.
   */
  private refreshInFlight$: Observable<string | null> | null = null;

  /** Guards the BFF teardown so a burst of 401s navigates once. */
  private endingSession = false;

  constructor() {
    if (this.mode === 'bff') {
      // Nothing of a previous legacy session may linger next to a cookie session.
      for (const k of [TOKEN_KEY, USER_KEY, PERMS_KEY]) this.removeSession(k);
      // Per-person storage stays shut until `initialize()` knows who is signed in.
      this.syncStorageIdentity();
      return;
    }

    // Mirror signal state to sessionStorage whenever it changes.
    effect(() => {
      const token = this._token();
      if (token) {
        this.writeSession(TOKEN_KEY, token);
      } else {
        this.removeSession(TOKEN_KEY);
      }
    });
    effect(() => {
      const user = this._legacyUser();
      if (user) {
        this.writeSession(USER_KEY, JSON.stringify(user));
      } else {
        this.removeSession(USER_KEY);
      }
    });
    effect(() => {
      const perms = this._adminPermissions();
      if (perms.length > 0) {
        this.writeSession(PERMS_KEY, JSON.stringify(perms));
      } else {
        this.removeSession(PERMS_KEY);
      }
    });

    // If we restored a session, check whether it's gone stale.
    if (this.isAuthenticated() && this.isIdleExpired()) {
      this.clearSession();
    } else if (this.isAuthenticated()) {
      this.startIdleWatch();
      // Arm the proactive refresh from the restored token's `exp`. If the
      // token is already past expiry (laptop slept overnight), schedule
      // immediately — the handler grants up to RefreshGraceDays of headroom
      // on the server side. If we can't read `exp` (cookie session), the
      // fallback interval still keeps the cookie alive.
      this.scheduleRefresh();
      // Re-hydrate the admin permission set from the engine on boot. (A restored
      // admin token with NO cached permissions is loaded by `initialize()` before
      // the first route renders.)
      if (this.isAdminToken() && this._adminPermissions().length > 0) this.loadMe().subscribe();
    }
    this.syncStorageIdentity();
  }

  /**
   * Resolves who is signed in BEFORE the first route renders (an app initializer), so guards and
   * every service that reads storage at construction see the final identity and permissions.
   *  - BFF: `GET /bff/session`.
   *  - Legacy: a restored admin token whose permissions were not cached loads them now.
   * Bounded: a slow engine delays the first paint by at most {@link INIT_TIMEOUT_MS}, then the
   * console starts with what it has (no session / no permissions — fail closed).
   */
  async initialize(): Promise<void> {
    if (this.mode === 'bff') {
      await this.bff.load();
      this.afterBffSessionChange();
      return;
    }
    if (this.isAuthenticated() && this.isAdminToken() && this._adminPermissions().length === 0) {
      await firstValueFrom(
        this.loadMe().pipe(
          timeout(INIT_TIMEOUT_MS),
          catchError(() => of(null)),
        ),
      );
    }
    this.syncStorageIdentity();
  }

  /** True when the current token is an admin-user token (carries the adminUserId claim). */
  private isAdminToken(): boolean {
    const payload = decodeJwt(this._token());
    return payload != null && payload['adminUserId'] != null;
  }

  // ── Permission checks ─────────────────────────────────────────────────

  /**
   * True when the signed-in person holds the permission in the active organisation. A legacy super
   * admin holds every permission (the engine bypasses checks for them too). No session, or a session
   * the engine reported no permissions for, holds nothing.
   */
  hasPermission(permission: PermissionKey | string): boolean {
    if (this.mode === 'legacy' && this._token() && this._isSuperAdmin()) return true;
    return this.permissionSet().has(permission);
  }

  /** True when the person holds at least one of the keys (an empty list is always allowed). */
  hasAnyPermission(permissions: readonly (PermissionKey | string)[]): boolean {
    return permissions.length === 0 || permissions.some((p) => this.hasPermission(p));
  }

  /** Whether the page at `url` is open to this person ({@link ROUTE_ACCESS}; unknown pages are not). */
  canSeePath(url: string): boolean {
    return canSee(url, this.accessSubject());
  }

  // ── BFF sign-in flows (contract C3.1 / C3.2) ──────────────────────────

  /** Leaves for `/bff/login` (Keycloak). `returnUrl` is sanitised to a same-origin path. */
  beginSignIn(returnUrl?: string | null): void {
    this.browser.assign(
      this.bff.loginUrl({ returnUrl: sanitizeReturnUrl(returnUrl) ?? DEFAULT_POST_LOGIN_ROUTE }),
    );
  }

  /**
   * Step-up (C3.2): sign in again with a second factor, then come back to `returnUrl`.
   * `tenant` asks for that organisation (switching into one that requires MFA).
   */
  beginStepUp(returnUrl?: string | null, tenant?: number | null): void {
    this.browser.assign(
      this.bff.loginUrl({
        acr: 'mfa',
        returnUrl: sanitizeReturnUrl(returnUrl) ?? DEFAULT_POST_LOGIN_ROUTE,
        tenant: tenant ?? null,
      }),
    );
  }

  /**
   * Moves the session to another organisation, then RELOADS the console on the dashboard: every
   * page, store, cache and realtime room belonged to the previous organisation, and a reload is the
   * one reset that cannot miss any of them. Resolves `'stepUp'` (after starting a step-up sign-in)
   * when that organisation requires a second factor; rejects with the engine's refusal otherwise.
   */
  async switchTenant(tenantId: number): Promise<'switched' | 'stepUp'> {
    if (this.mode !== 'bff') throw new Error('Organisations are switched through the BFF session.');
    try {
      await this.bff.switchTenant(tenantId);
    } catch (err) {
      if (isStepUpError(err)) {
        this.beginStepUp(DEFAULT_POST_LOGIN_ROUTE, tenantId);
        return 'stepUp';
      }
      throw err;
    }
    this.idle.stop();
    this.browser.assign(DEFAULT_POST_LOGIN_ROUTE);
    return 'switched';
  }

  /** Re-reads `/bff/session` (fresh CSRF token, permissions, MFA time). */
  async refreshSession(): Promise<BffSession | null> {
    if (this.mode !== 'bff') return null;
    const s = await this.bff.load();
    this.afterBffSessionChange();
    return s;
  }

  /** `X-CSRF-Token` for a request built outside HttpClient (keepalive `fetch` on page unload). */
  csrfHeaders(): Record<string, string> {
    const token = this.mode === 'bff' ? this.bff.csrfToken() : null;
    return token ? { [CSRF_HEADER]: token } : {};
  }

  /** A single-use realtime ticket (BFF only). */
  realtimeTicket(): Promise<string | null> {
    return this.mode === 'bff' ? this.bff.wsTicket() : Promise.resolve(null);
  }

  /**
   * The engine says the session is gone (a 401 that is not a step-up). Forget it and go to the
   * login page, remembering where the person was. Idempotent across a burst of failing requests.
   */
  sessionEnded(): void {
    if (this.mode !== 'bff') {
      this.logout({ expired: true });
      return;
    }
    if (this.endingSession) return;
    this.endingSession = true;
    const returnParams = returnUrlQueryParams(this.router.url);
    this.bff.clear();
    this.afterBffSessionChange();
    void this.router
      .navigate(['/login'], { queryParams: { ...returnParams, reason: 'expired' } })
      .finally(() => (this.endingSession = false));
  }

  private afterBffSessionChange(): void {
    this.syncStorageIdentity();
    const s = this.bff.session();
    if (s && s.idleTimeoutSeconds > 0) {
      this.idle.start(s.idleTimeoutSeconds, () => this.logout({ reason: 'idle' }));
    } else {
      this.idle.stop();
    }
  }

  private syncStorageIdentity(): void {
    setStorageIdentity(this.storageIdentity());
  }

  // ── Legacy sign-in (bffAuth off) ──────────────────────────────────────

  /**
   * Boot-time probe for a cookie-backed session. The browser can't read the
   * HttpOnly cookie, so we ask the engine who we are; if it responds with a
   * tradingAccountId, we flip `isAuthenticated` true and stash the reported
   * roles. Safe to call on every boot — no-ops when no cookie is present.
   */
  probeCookieSession(): Observable<{ tradingAccountId: number; roles: string[] } | null> {
    return this.api
      .get<{
        data: { tradingAccountId: number; roles: string[] } | null;
        status: boolean;
      }>('/auth/whoami')
      .pipe(
        tap((res) => {
          if (res?.status && res.data && res.data.tradingAccountId > 0) {
            // Sentinel token — the real JWT lives in the HttpOnly cookie,
            // unreadable from JS. `isAuthenticated` flips true; HTTP calls
            // ride the cookie via `withCredentials`.
            if (!this._token()) this._token.set(COOKIE_SESSION_SENTINEL);
            this._cookieRoles.set(res.data.roles);
            this._cookieAccountId.set(res.data.tradingAccountId);
            this._legacyUser.set({
              passportId: String(res.data.tradingAccountId),
              firstName: '',
              lastName: '',
              email: '',
            });
            this.touchActivity();
            this.startIdleWatch();
            this.scheduleRefresh();
            this.syncStorageIdentity();
          }
        }),
        map((res) => res?.data ?? null),
        catchError(() => of(null)),
      );
  }

  /**
   * Short-lived bearer token for the SignalR handshake. Returned by the
   * engine's `GET /auth/ws-ticket` which reads the HttpOnly cookie. Used by
   * `RealtimeService.connect()` when `getToken()` returns the cookie sentinel.
   */
  fetchWsTicket(): Observable<string | null> {
    return this.api
      .get<{ data: { token: string } | null; status: boolean }>('/auth/ws-ticket')
      .pipe(
        map((res) => (res?.status ? (res.data?.token ?? null) : null)),
        catchError(() => of(null)),
      );
  }

  /**
   * Engine-backed trading-account login via `POST /auth/login`. The issued JWT
   * carries role claims mirroring the account's `OperatorRole` grants; the
   * session's permissions are those roles' bundles.
   */
  loginOperator(credentials: OperatorLoginCredentials): Observable<OperatorAuthEnvelope> {
    return this.api
      .post<OperatorAuthEnvelope>('/auth/login', {
        accountId: credentials.accountId,
        brokerServer: credentials.brokerServer,
        password: credentials.password,
        loginSource: 'web',
      })
      .pipe(
        tap((response) => {
          if (response?.status && response.data?.token) {
            const token = response.data.token;
            const account = response.data.account;
            this._token.set(token);
            this._legacyUser.set({
              passportId: account?.accountId ?? credentials.accountId,
              firstName: account?.accountName ?? credentials.accountId,
              lastName: '',
              email: '',
            });
            this.touchActivity();
            this.startIdleWatch();
            this.scheduleRefresh();
            this.syncStorageIdentity();
          }
        }),
      );
  }

  /**
   * Admin-user login via `POST /admin/auth/login` (username + password). On success the issued
   * JWT carries the user's role claims and (for super admins) `is_superadmin`. The returned
   * observable completes only AFTER the effective permissions have been loaded from
   * `/admin/auth/me`, so the first page after sign-in is guarded with the real permission set.
   */
  loginAdmin(username: string, password: string): Observable<AdminAuthEnvelope> {
    return this.api.post<AdminAuthEnvelope>('/admin/auth/login', { username, password }).pipe(
      switchMap((response) => {
        if (!(response?.status && response.data?.token)) return of(response);
        this._token.set(response.data.token);
        this._legacyUser.set({
          passportId: String(response.data.user?.id ?? ''),
          firstName: response.data.user?.displayName || response.data.user?.username || '',
          lastName: '',
          email: response.data.user?.email ?? '',
        });
        this._isSuperAdmin.set(!!response.data.user?.isSuperAdmin);
        this._mustChangePassword.set(!!response.data.mustChangePassword);
        this.touchActivity();
        this.startIdleWatch();
        this.scheduleRefresh();
        this.syncStorageIdentity();
        return this.loadMe().pipe(map(() => response));
      }),
    );
  }

  /**
   * Loads the signed-in admin user's profile + effective permissions from
   * `GET /admin/auth/me` and pushes them into the reactive signals. Safe no-op
   * for non-admin sessions (the engine returns a failure envelope).
   */
  loadMe(): Observable<AdminMeData | null> {
    return this.api.get<{ data: AdminMeData | null; status: boolean }>('/admin/auth/me').pipe(
      tap((res) => {
        if (res?.status && res.data) {
          this._adminPermissions.set(res.data.permissions ?? []);
          this._isSuperAdmin.set(!!res.data.isSuperAdmin);
          this._mustChangePassword.set(!!res.data.mustChangePassword);
          this._legacyUser.set({
            passportId: String(res.data.id),
            firstName: res.data.displayName || res.data.username,
            lastName: '',
            email: res.data.email ?? '',
          });
        }
      }),
      map((res) => res?.data ?? null),
      catchError(() => of(null)),
    );
  }

  /** Clears the must-change-password flag locally after a successful self-change. */
  clearMustChangePassword(): void {
    this._mustChangePassword.set(false);
  }

  /**
   * Signs out.
   *
   * BFF: `POST /bff/logout`, then the browser goes to the URL it returns (Keycloak's end-session
   * page, which comes back to the console). A session taken from the person (`expired`, `idle`)
   * leaves a note for the login page and the route to come back to.
   *
   * Legacy: logs out locally and — if the current session is backed by an engine-issued
   * JWT — tells the engine to revoke the token's `jti` so the same string can't
   * be replayed. The API call is best-effort; a failure still clears the
   * local session and routes to /login (never hold a user hostage to the server).
   *
   * @param options.expired  Set when the session was taken from the user
   *   (refresh exhausted, jti revoked, idle timeout) rather than surrendered
   *   deliberately. Only then is the current route captured as a returnUrl.
   */
  logout(options?: { expired?: boolean; reason?: SignOutReason }): void {
    const reason: SignOutReason | undefined =
      options?.reason ?? (options?.expired ? 'expired' : undefined);

    if (this.mode === 'bff') {
      void this.logoutBff(reason);
      return;
    }

    const hadToken = !!this._token();
    if (hadToken) {
      // Fire-and-forget — don't block the UX on the network. errors are
      // logged by the HTTP error interceptor; we don't rethrow here. Admin
      // tokens revoke via the admin endpoint (no tradingAccountId claim).
      const logoutPath = this.isAdminToken() ? '/admin/auth/logout' : '/auth/logout';
      this.api
        .post(logoutPath, {})
        .pipe(catchError(() => of(null)))
        .subscribe();
    }

    // Capture the current route BEFORE clearing the session so login can put
    // the user back where they were standing when it died.
    //
    // Deliberately opt-in. A sign-out from the header means "I am done here";
    // returning that user to the page they just left on their next login would
    // be wrong, and on a shared machine it also hands the next operator the
    // previous one's context.
    const returnParams = reason ? returnUrlQueryParams(this.router.url) : {};

    this.clearSession();
    this.router.navigate(['/login'], { queryParams: returnParams });
  }

  private async logoutBff(reason: SignOutReason | undefined): Promise<void> {
    if (reason) {
      const returnUrl = returnUrlQueryParams(this.router.url)['returnUrl'] ?? null;
      this.writeSession(SIGNED_OUT_NOTE_KEY, JSON.stringify({ reason, returnUrl }));
    } else {
      this.removeSession(SIGNED_OUT_NOTE_KEY);
    }
    this.idle.stop();
    const url = await this.bff.logout();
    this.syncStorageIdentity();
    this.browser.assign(url);
  }

  /** Reads and clears the note {@link logout} left for the login page. */
  takeSignedOutNote(): { reason: SignOutReason; returnUrl: string | null } | null {
    const note = this.readSessionJson<{ reason: SignOutReason; returnUrl: string | null }>(
      SIGNED_OUT_NOTE_KEY,
    );
    this.removeSession(SIGNED_OUT_NOTE_KEY);
    if (!note || (note.reason !== 'expired' && note.reason !== 'idle')) return null;
    return { reason: note.reason, returnUrl: sanitizeReturnUrl(note.returnUrl) };
  }

  /** The legacy bearer token; null in BFF mode (cookie only) and when signed out. */
  getToken(): string | null {
    return this._token();
  }

  // ── Token-refresh plumbing (legacy) ────────────────────────────────

  /**
   * Force a token refresh now. De-duped: concurrent callers share the same
   * in-flight observable so the engine only sees one POST per cycle. Emits
   * the new token string on success (or the cookie sentinel for cookie
   * sessions) and `null` on any failure — the 401-fallback interceptor uses
   * the null branch as its signal to actually log out. Always null in BFF
   * mode: the engine refreshes the session's tokens server-side.
   */
  refreshToken(): Observable<string | null> {
    if (this.mode === 'bff') return of(null);
    if (this.refreshInFlight$) return this.refreshInFlight$;

    const current = this._token();
    // Cookie-only sessions: don't send a sentinel up the wire. The engine's
    // refresh endpoint will read the lascodia-auth cookie via `withCredentials`.
    const body = current && current !== COOKIE_SESSION_SENTINEL ? { token: current } : {};

    // Renew against the endpoint that matches the token type, exactly as
    // logout() does. This is load-bearing: `/auth/refresh` is the TRADING
    // ACCOUNT path, and its handler hard-fails any token without a
    // `tradingAccountId` claim ("Token has no tradingAccountId claim").
    // Admin-user tokens never carry that claim, so sending them there made
    // every admin refresh fail — the proactive timer renewed nothing and the
    // first 401 after expiry tore the session down instead of recovering it.
    const refreshPath = this.isAdminToken() ? '/admin/auth/refresh' : '/auth/refresh';

    this.refreshInFlight$ = defer(() =>
      this.api.post<{
        data: { token: string; expiresAt: string; tokenType: string } | null;
        status: boolean;
        message: string | null;
      }>(refreshPath, body),
    ).pipe(
      map((res) => {
        if (!res?.status || !res.data?.token) return null;
        const newToken = res.data.token;
        this._token.set(newToken);
        this.touchActivity();
        this.scheduleRefresh();
        return newToken;
      }),
      catchError(() => of(null)),
      tap({
        next: () => {
          this.refreshInFlight$ = null;
        },
        error: () => {
          this.refreshInFlight$ = null;
        },
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    return this.refreshInFlight$;
  }

  /**
   * Arms a single setTimeout to fire `REFRESH_LEAD_MS` before the JWT's
   * `exp`. Reads `exp` from the current token; for cookie sessions (no
   * readable token), falls back to a fixed hourly cadence. Idempotent —
   * any prior timer is cancelled before the new one is armed.
   */
  private scheduleRefresh(): void {
    this.cancelRefresh();

    const token = this._token();
    if (!token) return;

    // Cookie session: we can't read `exp`, so refresh on a fixed cadence.
    if (token === COOKIE_SESSION_SENTINEL) {
      this.refreshTimerId = setTimeout(
        () => this.refreshToken().subscribe(),
        REFRESH_COOKIE_INTERVAL_MS,
      );
      return;
    }

    const payload = decodeJwt(token);
    const expSeconds = payload?.exp;
    if (!expSeconds || !Number.isFinite(expSeconds)) {
      // Token without an `exp` claim shouldn't happen for engine-issued JWTs,
      // but fall back to the cookie cadence so we never silently stop refreshing.
      this.refreshTimerId = setTimeout(
        () => this.refreshToken().subscribe(),
        REFRESH_COOKIE_INTERVAL_MS,
      );
      return;
    }

    const expMs = expSeconds * 1000;
    const now = Date.now();
    const delay = Math.max(expMs - now - REFRESH_LEAD_MS, REFRESH_MIN_DELAY_MS);
    this.refreshTimerId = setTimeout(() => this.refreshToken().subscribe(), delay);
  }

  private cancelRefresh(): void {
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  // ── Idle-timeout plumbing (legacy) ─────────────────────────────────

  private clearSession(): void {
    this._token.set(null);
    this._legacyUser.set(null);
    this._adminPermissions.set([]);
    this._isSuperAdmin.set(false);
    this._mustChangePassword.set(false);
    this._cookieRoles.set([]);
    this._cookieAccountId.set(null);
    this.removeSession(LAST_ACTIVITY_KEY);
    this.stopIdleWatch();
    this.cancelRefresh();
    this.refreshInFlight$ = null;
    this.syncStorageIdentity();
  }

  private isIdleExpired(): boolean {
    // Gated off: with idle-logout disabled the session is never considered
    // stale, so the constructor's restored-session check keeps the operator
    // signed in no matter how long the tab sat idle.
    if (!IDLE_LOGOUT_ENABLED) return false;
    return Date.now() - this.lastActivity > IDLE_TIMEOUT_MS;
  }

  private startIdleWatch(): void {
    // Idle auto-logout disabled — don't bind activity listeners or arm the
    // periodic watcher at all (isIdleExpired() is also gated as a backstop).
    if (!IDLE_LOGOUT_ENABLED) return;
    if (!this.activityListenersBound && typeof window !== 'undefined') {
      const onActivity = () => this.touchActivity();
      window.addEventListener('pointerdown', onActivity, { passive: true });
      window.addEventListener('keydown', onActivity, { passive: true });
      window.addEventListener('visibilitychange', onActivity, { passive: true });
      this.activityListenersBound = true;
    }
    if (this.idleIntervalId === null) {
      this.idleIntervalId = setInterval(() => {
        if (this.isAuthenticated() && this.isIdleExpired()) {
          // Idle timeout is an expiry, not a deliberate sign-out.
          this.logout({ expired: true });
        }
      }, IDLE_CHECK_INTERVAL_MS);
    }
  }

  private stopIdleWatch(): void {
    if (this.idleIntervalId !== null) {
      clearInterval(this.idleIntervalId);
      this.idleIntervalId = null;
    }
  }

  private touchActivity(): void {
    const now = Date.now();
    if (now - this.lastActivity < ACTIVITY_THROTTLE_MS) return;
    this.lastActivity = now;
    this.writeSession(LAST_ACTIVITY_KEY, String(now));
  }

  // ── sessionStorage helpers (SSR/private-browser safe) ──────────────

  private readSessionString(key: string): string | null {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  private readSessionJson<T>(key: string): T | null {
    const raw = this.readSessionString(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private writeSession(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }

  private removeSession(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}

/** A refusal carrying the step-up challenge (contract C3.2). */
export function isStepUpError(err: unknown): boolean {
  const e = err as {
    status?: number;
    error?: { responseCode?: unknown } | null;
    headers?: { get?: (n: string) => string | null };
  } | null;
  if (!e || e.status !== 401) return false;
  if (e.error && typeof e.error === 'object' && e.error.responseCode === '-401-stepup') return true;
  const www = e.headers?.get?.('WWW-Authenticate') ?? '';
  return /insufficient_user_authentication/i.test(www);
}
