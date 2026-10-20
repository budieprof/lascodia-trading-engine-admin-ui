import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpContext, HttpHeaders, HttpRequest } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { AuthService } from './auth.service';
import { CSRF_HEADER } from './bff.types';
import { isEngineUrl } from './csrf.interceptor';
import { STEP_UP_REPLAY } from './http-context';

/** Per tab: the redirect chain to Keycloak and back stays in the same tab. */
export const STEP_UP_PENDING_KEY = 'lascodia.auth.stepUpPending';
/** A pending action older than this is dropped, not offered. */
export const STEP_UP_PENDING_TTL_MS = 10 * 60_000;
/** The engine accepts a second factor this recent (contract C3.2, `max_age=300`). */
export const STEP_UP_MAX_AGE_MS = 300_000;

/** Headers never stored or replayed: credentials are the session's business. */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', CSRF_HEADER.toLowerCase()]);

/** The action the engine refused pending a step-up, kept across the sign-in round trip. */
export interface PendingStepUp {
  method: string;
  url: string;
  /** JSON text of the body; null for no body. */
  body: string | null;
  headers: Record<string, string>;
  /** The console route the person was on. */
  route: string;
  /** Plain description for the banner. */
  label: string;
  createdAt: number;
}

/**
 * Builds the record for a refused request, or null when its body cannot be replayed faithfully
 * (files, binary) — the person is then simply asked to repeat the action.
 */
export function pendingFor(req: HttpRequest<unknown>, route: string, now = Date.now()): PendingStepUp | null {
  const b = req.body;
  if (
    (typeof FormData !== 'undefined' && b instanceof FormData) ||
    (typeof Blob !== 'undefined' && b instanceof Blob) ||
    b instanceof ArrayBuffer ||
    (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams)
  ) {
    return null;
  }
  let body: string | null = null;
  if (b !== null && b !== undefined) {
    try {
      body = JSON.stringify(b);
    } catch {
      return null;
    }
  }
  const headers: Record<string, string> = {};
  for (const name of req.headers.keys()) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    const v = req.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  return {
    method: req.method,
    url: req.urlWithParams,
    body,
    headers,
    route,
    label: describe(req.method, req.url),
    createdAt: now,
  };
}

/** `POST …/api/v1/lascodia-trading-engine/iam/grants` → `POST iam/grants`. */
export function describe(method: string, url: string): string {
  const path = url
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api\/v1\/lascodia-trading-engine\//, '')
    .replace(/^\//, '')
    .split('?')[0];
  return `${method.toUpperCase()} ${path}`;
}

/** True when the session's last sign-in used a second factor within the engine's window. */
export function mfaIsFresh(mfa: { satisfied: boolean; authTimeUtc: string } | null | undefined, now = Date.now()): boolean {
  if (!mfa?.satisfied) return false;
  const t = Date.parse(mfa.authTimeUtc);
  return Number.isFinite(t) && now - t <= STEP_UP_MAX_AGE_MS;
}

/**
 * Step-up (contract C3.2). When the engine answers 401 `-401-stepup`, the console remembers the
 * refused action, sends the person to `/bff/login?acr=mfa&returnUrl=<current route>`, and — back on
 * that route with a fresh second factor — offers to finish it ({@link pending} drives the banner).
 *
 * The retry is one deliberate click, never automatic: the person left the page, maybe for minutes,
 * and on a live trading console a write must not fire without them seeing it.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);
  private readonly apiBaseUrl = inject(RUNTIME_CONFIG).apiBaseUrl;

  /** The action waiting to be finished after the step-up, if any. */
  readonly pending = signal<PendingStepUp | null>(null);
  /** Set when the person came back without a usable second factor. */
  readonly failed = signal<PendingStepUp | null>(null);
  readonly busy = signal(false);

  private redirecting = false;

  /** The error interceptor saw a step-up challenge for `req`. */
  challenge(req: HttpRequest<unknown>): void {
    if (req.context.get(STEP_UP_REPLAY)) {
      this.notify.error('That still needs a fresh sign-in with your second factor. Try it again.');
      return;
    }
    if (this.redirecting) return;
    this.redirecting = true;
    const route = this.router.url;
    const record = pendingFor(req, route);
    if (record) write(record);
    else remove();
    this.notify.info('This needs a fresh sign-in with your second factor. Taking you there…');
    this.auth.beginStepUp(route);
  }

  /** Starts a step-up before acting (the "Confirm with MFA" affordance) — nothing is pending. */
  confirmWithMfa(): void {
    remove();
    this.auth.beginStepUp(this.router.url);
  }

  /** Whether the session's second factor is recent enough for a step-up action right now. */
  isFresh(): boolean {
    return mfaIsFresh(this.auth.session()?.mfa);
  }

  /** On a signed-in page: picks up an action left before the step-up round trip. */
  restore(now = Date.now()): void {
    const record = read();
    if (!record) return;
    const origin = typeof location === 'undefined' ? undefined : location.origin;
    // Only ever replay to the engine: the record sat in storage and is not trusted further than that.
    if (now - record.createdAt > STEP_UP_PENDING_TTL_MS || !isEngineUrl(record.url, this.apiBaseUrl, origin)) {
      remove();
      return;
    }
    if (mfaIsFresh(this.auth.session()?.mfa, now)) this.pending.set(record);
    else {
      remove();
      this.failed.set(record);
    }
  }

  /** Finish the pending action (one explicit click). */
  async retry(): Promise<boolean> {
    const record = this.pending();
    if (!record || this.busy()) return false;
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.http.request(record.method, record.url, {
          body: record.body === null ? null : JSON.parse(record.body),
          headers: new HttpHeaders(record.headers),
          withCredentials: true,
          context: new HttpContext().set(STEP_UP_REPLAY, true),
        }),
      );
      this.notify.success(`Done after your second-factor sign-in: ${record.label}. Refresh the page to see the change.`);
      return true;
    } catch {
      // The error interceptor already told the person why.
      return false;
    } finally {
      remove();
      this.pending.set(null);
      this.busy.set(false);
    }
  }

  discard(): void {
    remove();
    this.pending.set(null);
    this.failed.set(null);
  }
}

function read(): PendingStepUp | null {
  try {
    const raw = sessionStorage.getItem(STEP_UP_PENDING_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<PendingStepUp>;
    if (typeof r.method !== 'string' || typeof r.url !== 'string' || typeof r.createdAt !== 'number') return null;
    return {
      method: r.method,
      url: r.url,
      body: typeof r.body === 'string' ? r.body : null,
      headers: r.headers && typeof r.headers === 'object' ? r.headers : {},
      route: typeof r.route === 'string' ? r.route : '/',
      label: typeof r.label === 'string' ? r.label : describe(r.method, r.url),
      createdAt: r.createdAt,
    };
  } catch {
    return null;
  }
}

function write(record: PendingStepUp): void {
  try {
    sessionStorage.setItem(STEP_UP_PENDING_KEY, JSON.stringify(record));
  } catch {
    /* storage blocked: the person repeats the action after signing in */
  }
}

function remove(): void {
  try {
    sessionStorage.removeItem(STEP_UP_PENDING_KEY);
  } catch {
    /* storage blocked */
  }
}
