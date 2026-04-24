import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, of, tap } from 'rxjs';
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

/**
 * Session persistence:
 *   - Token + user are mirrored to `sessionStorage` so a page refresh doesn't
 *     kick the operator back to /login. Closing the tab clears it — meets the
 *     PRD §14 "JWT not in localStorage" bar while fixing the reload UX.
 *   - An idle-timeout watcher logs out after N minutes of no user activity
 *     (pointerdown, keydown, visibilitychange). Tunable via IDLE_TIMEOUT_MS.
 */
const TOKEN_KEY = 'lascodia.auth.token';
const USER_KEY = 'lascodia.auth.user';
const LAST_ACTIVITY_KEY = 'lascodia.auth.lastActivity';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_THROTTLE_MS = 30 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

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
   * Decoded role claims from the JWT. Empty list when the token carries no
   * role claim — legacy dev tokens from the shared library's `/auth/token`
   * don't issue roles, so `hasRole` treats the empty-list case as "full
   * access" (see below). Engine-issued tokens via `POST /auth/login` DO carry
   * roles and are enforced strictly.
   */
  readonly roles = computed<readonly string[]>(() => rolesFromPayload(decodeJwt(this._token())));

  private lastActivity = Number(this.readSessionString(LAST_ACTIVITY_KEY) ?? Date.now());
  private activityListenersBound = false;
  private idleIntervalId: ReturnType<typeof setInterval> | null = null;

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

    // If we restored a session, check whether it's gone stale.
    if (this.isAuthenticated() && this.isIdleExpired()) {
      this.clearSession();
    } else if (this.isAuthenticated()) {
      this.startIdleWatch();
    }
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
          }
        }),
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
          }
        }),
      );
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
      // logged by the HTTP error interceptor; we don't rethrow here.
      this.api
        .post('/auth/logout', {})
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

  // ── Idle-timeout plumbing ──────────────────────────────────────────

  private clearSession(): void {
    this._token.set(null);
    this._user.set(null);
    this.removeSession(LAST_ACTIVITY_KEY);
    this.stopIdleWatch();
  }

  private isIdleExpired(): boolean {
    return Date.now() - this.lastActivity > IDLE_TIMEOUT_MS;
  }

  private startIdleWatch(): void {
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
