import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import type { BffLogoutResponse, BffSession, BffWsTicket } from './bff.types';
import { SKIP_SESSION_HANDLING } from './http-context';

/** How long the boot-time session probe may hold up the first render. */
const LOAD_TIMEOUT_MS = 10_000;

export interface BffLoginOptions {
  /** Same-origin path to come back to (the engine sanitises it again). */
  returnUrl?: string | null;
  /** Organisation to sign in to (id or slug). */
  tenant?: string | number | null;
  /** `mfa` = step-up: sign in again with a second factor (contract C3.2). */
  acr?: 'mfa' | null;
}

/**
 * The console's side of the engine's backend-for-frontend (contract C3.1). Holds the current
 * session payload; everything else about signing in lives in {@link AuthService}, which is the only
 * caller.
 *
 * `/bff/*` is served at the engine ROOT, not under `/api/v1/lascodia-trading-engine`, so this talks
 * to HttpClient directly. Every call carries the session cookie (`withCredentials`); the CSRF
 * interceptor adds `X-CSRF-Token` to the unsafe ones.
 */
@Injectable({ providedIn: 'root' })
export class BffSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(RUNTIME_CONFIG).apiBaseUrl.replace(/\/$/, '');

  private readonly _session = signal<BffSession | null>(null);
  /** The signed-in session, or null. */
  readonly session = this._session.asReadonly();

  /** Set when the last probe could not reach the engine (as opposed to "nobody is signed in"). */
  readonly unreachable = signal(false);

  /** `/bff/<path>` on the engine. */
  url(path: string): string {
    return `${this.base}/bff/${path}`;
  }

  /** Where the browser goes to sign in (a full-document navigation, never XHR). */
  loginUrl(options: BffLoginOptions = {}): string {
    const q = new URLSearchParams();
    if (options.returnUrl) q.set('returnUrl', options.returnUrl);
    if (options.tenant !== null && options.tenant !== undefined && options.tenant !== '') {
      q.set('tenant', String(options.tenant));
    }
    if (options.acr) q.set('acr', options.acr);
    const qs = q.toString();
    return this.url('login') + (qs ? `?${qs}` : '');
  }

  /** The CSRF token unsafe requests must carry, or null without a session. */
  csrfToken(): string | null {
    return this._session()?.csrfToken || null;
  }

  /**
   * `GET /bff/session`. Resolves the session, or null when nobody is signed in (401) or the engine
   * refuses this sign-in (403 — network policy). Never throws: an unreachable engine also resolves
   * null, with {@link unreachable} set so the login page can say so.
   */
  async load(): Promise<BffSession | null> {
    try {
      const s = await firstValueFrom(
        this.http
          .get<BffSession>(this.url('session'), {
            withCredentials: true,
            context: quiet(),
          })
          .pipe(timeout(LOAD_TIMEOUT_MS)),
      );
      const session = isSession(s) ? s : null;
      this._session.set(session);
      this.unreachable.set(false);
      return session;
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      this.unreachable.set(!(status === 401 || status === 403));
      this._session.set(null);
      return null;
    }
  }

  /**
   * `POST /bff/switch-tenant`. Resolves the new session; rejects with the HttpErrorResponse when the
   * engine refuses (403 not a member / suspended, 401 step-up when that organisation needs a second
   * factor). The caller decides what to do — switching reloads the console.
   */
  async switchTenant(tenantId: number): Promise<BffSession> {
    const s = await firstValueFrom(
      this.http.post<BffSession>(
        this.url('switch-tenant'),
        { tenantId },
        { withCredentials: true, context: new HttpContext().set(SKIP_SESSION_HANDLING, true) },
      ),
    );
    if (!isSession(s)) throw new Error('The engine answered the switch without a session.');
    this._session.set(s);
    return s;
  }

  /**
   * `POST /bff/logout`: ends the session here and returns where the browser goes next (Keycloak's
   * end-session page, which comes back to the console). The cookie is cleared even when the call
   * fails, so a failure still lands on `/`.
   */
  async logout(): Promise<string> {
    try {
      const r = await firstValueFrom(
        this.http.post<BffLogoutResponse>(this.url('logout'), {}, { withCredentials: true, context: quiet() }),
      );
      return typeof r?.logoutUrl === 'string' && r.logoutUrl ? r.logoutUrl : '/';
    } catch {
      return '/';
    } finally {
      this._session.set(null);
    }
  }

  /** `POST /bff/ws-ticket`: a single-use, 30-second credential for ONE SignalR connection. */
  async wsTicket(): Promise<string | null> {
    try {
      const r = await firstValueFrom(
        this.http.post<BffWsTicket>(this.url('ws-ticket'), {}, { withCredentials: true, context: quiet() }),
      );
      return typeof r?.ticket === 'string' && r.ticket ? r.ticket : null;
    } catch {
      return null;
    }
  }

  /** Forget the session locally (it already ended server-side). */
  clear(): void {
    this._session.set(null);
  }
}

function quiet(): HttpContext {
  return new HttpContext().set(SKIP_SESSION_HANDLING, true).set(SUPPRESS_ERROR_TOAST, true);
}

/** Minimal shape check: a payload without these is treated as "no session" (fail closed). */
export function isSession(v: unknown): v is BffSession {
  const s = v as Partial<BffSession> | null;
  return (
    !!s &&
    typeof s === 'object' &&
    !!s.user &&
    typeof s.user.id === 'number' &&
    Array.isArray(s.permissions) &&
    Array.isArray(s.memberships) &&
    typeof s.csrfToken === 'string'
  );
}
