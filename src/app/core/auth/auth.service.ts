import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, defer, map, of, shareReplay, tap } from 'rxjs';
import { ApiService } from '../api/api.service';
import { TokenResponseDto } from '../api/api.types';
import { decodeJwt, rolesFromPayload } from './jwt';

export interface AuthUser {
  passportId: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Canonical role names mirroring the engine's `OperatorRoleNames`. Kept as a
 * const tuple so usages are autocompleted and typos surface at compile time.
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

// Which roles satisfy each policy — mirrors the server-side cascade in
// `Policies.Register`. Admin covers everything; Operator covers Trader/Analyst
// reads but not the Admin-only role management.
const POLICY_ROLES: Record<Role, readonly Role[]> = {
  Viewer: ['Viewer', 'Trader', 'Analyst', 'Operator', 'Admin', 'EA'],
  Trader: ['Trader', 'Operator', 'Admin'],
  Analyst: ['Analyst', 'Operator', 'Admin'],
  Operator: ['Operator', 'Admin'],
  Admin: ['Admin'],
  EA: ['EA'],
};

export interface LoginCredentials {
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
}

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

/**
 * Session persistence:
 *   - Token + user are mirrored to `sessionStorage` so a page refresh doesn't
 *     kick the operator back to /login. Closing the tab clears it — meets the
 *     PRD §14 "JWT not in localStorage" bar while fixing the reload UX.
 *   - An idle-timeout watcher logs out after N minutes of no user activity
 *     (pointerdown, keydown, visibilitychange). Tunable via IDLE_TIMEOUT_MS.
 *     Currently DISABLED via IDLE_LOGOUT_ENABLED so the console can be left
 *     open and unattended for long stretches without self-logging-out; flip
 *     the flag back to `true` to restore the idle timeout.
 */
const TOKEN_KEY = 'lascodia.auth.token';
const USER_KEY = 'lascodia.auth.user';
const PERMS_KEY = 'lascodia.auth.perms';
const LAST_ACTIVITY_KEY = 'lascodia.auth.lastActivity';
// Master switch for the client-side idle auto-logout. When false, neither
// the restored-session staleness check nor the periodic watcher will ever
// log the operator out for inactivity (the JWT's own server-side expiry
// still applies and is out of this layer's control).
const IDLE_LOGOUT_ENABLED = false;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_THROTTLE_MS = 30 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

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

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  private readonly _token = signal<string | null>(this.readSessionString(TOKEN_KEY));
  private readonly _user = signal<AuthUser | null>(this.readSessionJson<AuthUser>(USER_KEY));

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  /**
   * When the session is backed by an HttpOnly cookie, the JWT is unreadable
   * from JS — so `probeCookieSession()` populates this signal with the roles
   * the engine reported via `GET /auth/whoami`.
   */
  private readonly _cookieRoles = signal<string[]>([]);

  /**
   * Decoded role claims from the JWT, or the server-reported roles for
   * cookie-authenticated sessions. Empty list when the token carries no role
   * claim — legacy dev tokens from the shared library's `/auth/token` don't
   * issue roles, so `hasRole` treats the empty-list case as "full access"
   * (see below). Engine-issued tokens via `POST /auth/login` DO carry roles
   * and are enforced strictly.
   */
  readonly roles = computed<readonly string[]>(() => {
    const fromToken = rolesFromPayload(decodeJwt(this._token()));
    if (fromToken.length > 0) return fromToken;
    return this._cookieRoles();
  });

  /**
   * Effective permission keys for the signed-in admin user, sourced from
   * `GET /admin/auth/me` (the engine resolves roles → permissions server-side;
   * super admins receive the full catalog). Used to gate menus/routes — the
   * engine remains the authoritative enforcer. Empty for broker/EA logins,
   * which fall back to role/policy gating.
   */
  private readonly _permissions = signal<string[]>(this.readSessionJson<string[]>(PERMS_KEY) ?? []);
  private readonly _isSuperAdmin = signal<boolean>(false);
  private readonly _mustChangePassword = signal<boolean>(false);

  readonly permissions = this._permissions.asReadonly();
  readonly isSuperAdmin = this._isSuperAdmin.asReadonly();
  /** True when the user must change their password before using the app. */
  readonly mustChangePassword = this._mustChangePassword.asReadonly();

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

  constructor() {
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
      const user = this._user();
      if (user) {
        this.writeSession(USER_KEY, JSON.stringify(user));
      } else {
        this.removeSession(USER_KEY);
      }
    });
    effect(() => {
      const perms = this._permissions();
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
      // Re-hydrate the admin permission set from the engine on boot.
      if (this.isAdminToken()) this.loadMe().subscribe();
    }
  }

  /** True when the current token is an admin-user token (carries the adminUserId claim). */
  private isAdminToken(): boolean {
    const payload = decodeJwt(this._token());
    return payload != null && payload['adminUserId'] != null;
  }

  login(credentials: LoginCredentials): Observable<TokenResponseDto> {
    return this.api
      .post<TokenResponseDto>('/auth/token', {
        userId: credentials.userId || 'dev-user-1',
        firstName: credentials.firstName || 'Dev',
        lastName: credentials.lastName || 'User',
        email: credentials.email || 'dev@lascodia.com',
        phoneNumber: credentials.phoneNumber || '',
      })
      .pipe(
        tap((response) => {
          if (response.token) {
            this._token.set(response.token);
            this._user.set({
              passportId: credentials.userId || 'dev-user-1',
              firstName: credentials.firstName || 'Dev',
              lastName: credentials.lastName || 'User',
              email: credentials.email || 'dev@lascodia.com',
            });
            this.touchActivity();
            this.startIdleWatch();
            this.scheduleRefresh();
          }
        }),
      );
  }

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
            this._user.set({
              passportId: String(res.data.tradingAccountId),
              firstName: '',
              lastName: '',
              email: '',
            });
            this.touchActivity();
            this.startIdleWatch();
            this.scheduleRefresh();
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
   * Engine-backed login via `POST /auth/login`. The issued JWT carries role
   * claims mirroring the account's `OperatorRole` grants, so `hasPolicy`
   * becomes strict for this session (no longer falling through the
   * empty-roles escape hatch). Use this path in production; the dev
   * `login()` method above stays for local work.
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
            this._user.set({
              passportId: account?.accountId ?? credentials.accountId,
              firstName: account?.accountName ?? credentials.accountId,
              lastName: '',
              email: '',
            });
            this.touchActivity();
            this.startIdleWatch();
            this.scheduleRefresh();
          }
        }),
      );
  }

  /**
   * Admin-user login via `POST /admin/auth/login` (username + password). On success the issued
   * JWT carries the user's role claims and (for super admins) `is_superadmin`; we then load the
   * effective permission set from `/admin/auth/me` for menu/route gating.
   */
  loginAdmin(username: string, password: string): Observable<AdminAuthEnvelope> {
    return this.api.post<AdminAuthEnvelope>('/admin/auth/login', { username, password }).pipe(
      tap((response) => {
        if (response?.status && response.data?.token) {
          this._token.set(response.data.token);
          this._user.set({
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
          this.loadMe().subscribe();
        }
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
          this._permissions.set(res.data.permissions ?? []);
          this._isSuperAdmin.set(!!res.data.isSuperAdmin);
          this._mustChangePassword.set(!!res.data.mustChangePassword);
          this._user.set({
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
   * True when the user holds the given permission key. Super admins hold every
   * permission. Empty-permission + empty-role tokens (legacy dev `/auth/token`)
   * fall through to "allowed" for backward compatibility, matching `hasPolicy`.
   */
  hasPermission(permission: string): boolean {
    if (this._isSuperAdmin()) return true;
    const perms = this._permissions();
    if (perms.length === 0 && this.roles().length === 0) return true; // legacy dev-token escape hatch
    return perms.includes(permission);
  }

  /**
   * Logs out locally and — if the current session is backed by an engine-issued
   * JWT — tells the engine to revoke the token's `jti` so the same string can't
   * be replayed. The API call is best-effort; a failure still clears the
   * local session and routes to /login (never hold a user hostage to the server).
   */
  logout(): void {
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
    this.clearSession();
    this.router.navigate(['/login']);
  }

  getToken(): string | null {
    return this._token();
  }

  /**
   * Gate logic that mirrors the server policy ladder. Empty-role tokens are
   * treated as "full access" for backward compatibility with the shared
   * library's dev `/auth/token` endpoint; once the UI migrates to engine
   * tokens every route should naturally become strict.
   */
  hasPolicy(policy: Role): boolean {
    const mine = this.roles();
    if (mine.length === 0) return true; // legacy dev-token escape hatch
    const allowed = POLICY_ROLES[policy];
    return mine.some((r) => allowed.includes(r as Role));
  }

  /** True when the token carries any of the supplied roles. */
  hasAnyRole(roles: readonly Role[]): boolean {
    const mine = this.roles();
    if (mine.length === 0) return true;
    return roles.some((r) => mine.includes(r));
  }

  // ── Token-refresh plumbing ─────────────────────────────────────────

  /**
   * Force a token refresh now. De-duped: concurrent callers share the same
   * in-flight observable so the engine only sees one POST per cycle. Emits
   * the new token string on success (or the cookie sentinel for cookie
   * sessions) and `null` on any failure — the 401-fallback interceptor uses
   * the null branch as its signal to actually log out.
   */
  refreshToken(): Observable<string | null> {
    if (this.refreshInFlight$) return this.refreshInFlight$;

    const current = this._token();
    // Cookie-only sessions: don't send a sentinel up the wire. The engine's
    // refresh endpoint will read the lascodia-auth cookie via `withCredentials`.
    const body = current && current !== COOKIE_SESSION_SENTINEL ? { token: current } : {};

    this.refreshInFlight$ = defer(() =>
      this.api.post<{
        data: { token: string; expiresAt: string; tokenType: string } | null;
        status: boolean;
        message: string | null;
      }>('/auth/refresh', body),
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

  // ── Idle-timeout plumbing ──────────────────────────────────────────

  private clearSession(): void {
    this._token.set(null);
    this._user.set(null);
    this._permissions.set([]);
    this._isSuperAdmin.set(false);
    this._mustChangePassword.set(false);
    this._cookieRoles.set([]);
    this.removeSession(LAST_ACTIVITY_KEY);
    this.stopIdleWatch();
    this.cancelRefresh();
    this.refreshInFlight$ = null;
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
          this.logout();
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
