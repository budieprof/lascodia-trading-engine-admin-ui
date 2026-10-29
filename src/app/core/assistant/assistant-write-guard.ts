import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { finalize, throwError } from 'rxjs';
import { isReadRequest } from './read-posts';

/** The guard the patched fetch / sendBeacon consult — the latest created (the app has one). */
let installedAdmit: ((method: string, url: string) => string | null) | null = null;

/**
 * Keeps the assistant's browser commands to READING.
 *
 * <p>The assistant may drive a page — type in a search box, pick a filter, open a row — because
 * those only change what is displayed. But a page control can also write: a toggle that
 * auto-saves, a "Pause" button, Enter in a create form. A request sent that way carries the
 * operator's own session straight to the engine and skips the approval card every
 * assistant-initiated change must go through (`AssistantAccess.Classify`). So while a
 * page-driving command runs, and for a short tail afterwards (debounced effects fire late), every
 * request that is not a read is refused in the browser before it leaves.</p>
 *
 * <p>"Read" = GET/HEAD/OPTIONS or a POST on the reviewed read list ({@link isReadRequest}) — any
 * URL, not just the engine API, because a write is a write wherever it goes. The refused request
 * fails like any other error, so the page shows its normal failure, and the command's result
 * names what was refused so the model can propose the change through the engine instead.</p>
 *
 * <p>Covers HttpClient (the interceptor below, registered first so nothing retries or toasts a
 * refusal), `fetch` and `navigator.sendBeacon` (the chart's keep-alive saves use those). SignalR
 * hub messages are not covered; every hub method the console invokes is a (un)subscribe.</p>
 */
@Injectable({ providedIn: 'root' })
export class AssistantWriteGuard {
  /** How long the guard stays up after a command's action returns. */
  static readonly TAIL_MS = 3000;

  private depth = 0;
  private until = 0;
  private inflight = 0;
  private lastRequestAt = 0;
  private readonly sessions = new Set<GuardSession>();
  /** Refusals that landed after the command that caused them had already reported. */
  private late: string[] = [];

  constructor() {
    // The patched transports ask whichever guard was created last (the app has exactly one).
    installedAdmit = (method, url) => this.admit(method, url);
    patchBrowserTransports();
  }

  /** True while a command runs or within its tail. */
  active(now = Date.now()): boolean {
    return this.depth > 0 || now < this.until;
  }

  /**
   * Decide one outgoing request. Returns a description of the refusal ("POST /strategy/12/pause"),
   * or null when it may go. Every request seen while the guard is up is recorded either way.
   */
  admit(method: string, url: string): string | null {
    if (!this.active()) return null;
    const path = displayPath(url);
    const what = `${method.toUpperCase()} ${path}`;
    this.lastRequestAt = Date.now();
    if (isReadRequest(method, pathOnly(url))) {
      if (!SECRET_PATH.test(path)) for (const s of this.sessions) push(s.requests, what);
      return null;
    }
    if (this.sessions.size === 0) push(this.late, what);
    for (const s of this.sessions) push(s.blocked, what);
    console.warn(`[assistant] blocked a write while driving the page: ${what}`);
    return what;
  }

  /** Bookkeeping for in-flight requests, so a command can wait for the page to settle. */
  requestStarted(): void {
    this.inflight++;
  }
  requestFinished(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  /**
   * Run a page-driving action under the guard, wait for the page to settle, and report what it
   * asked the engine for. The guard stays up for {@link TAIL_MS} after the action returns.
   */
  async run<T>(
    action: () => T | Promise<T>,
    opts: { minSettleMs?: number; maxSettleMs?: number; quietMs?: number; tailMs?: number } = {},
  ): Promise<GuardReport<T>> {
    const minSettle = opts.minSettleMs ?? 400;
    const maxSettle = opts.maxSettleMs ?? 2500;
    const quiet = opts.quietMs ?? 300;
    const session: GuardSession = { blocked: [], requests: [] };
    const blockedEarlier = this.late.splice(0);
    this.sessions.add(session);
    this.depth++;
    let value!: T;
    try {
      value = await action();
      const start = Date.now();
      await sleep(minSettle);
      // Settle: nothing in flight and no new request for `quiet` ms — or give up at maxSettle.
      while (
        Date.now() - start < maxSettle &&
        (this.inflight > 0 || Date.now() - this.lastRequestAt < quiet)
      ) {
        await sleep(50);
      }
    } finally {
      this.depth--;
      this.until = Math.max(this.until, Date.now() + (opts.tailMs ?? AssistantWriteGuard.TAIL_MS));
      this.sessions.delete(session);
    }
    return { value, blocked: session.blocked, requests: session.requests, blockedEarlier };
  }
}

export interface GuardReport<T> {
  value: T;
  /** Requests refused during this command ("POST /strategy/12/pause"). */
  blocked: string[];
  /** Read requests the page made during this command — the sign that it re-queried. */
  requests: string[];
  /** Refusals that landed in the tail of an EARLIER command, after it had reported. */
  blockedEarlier: string[];
}

interface GuardSession {
  blocked: string[];
  requests: string[];
}

/** Wrap `fetch` and `navigator.sendBeacon` once per window so they consult the guard too. */
function patchBrowserTransports(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __lascodiaWriteGuard?: boolean };
  if (w.__lascodiaWriteGuard) return;
  w.__lascodiaWriteGuard = true;
  const admit = (method: string, url: string) => installedAdmit?.(method, url) ?? null;

  const nativeFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
  if (nativeFetch) {
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const refused = admit(method, url);
      if (refused) return Promise.reject(new TypeError(blockedMessage(refused)));
      return nativeFetch(input, init);
    }) as typeof fetch;
  }
  const nav = w.navigator as Navigator | undefined;
  if (nav && typeof nav.sendBeacon === 'function') {
    const nativeBeacon = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url: string | URL, data?: BodyInit | null) =>
      admit('POST', String(url)) ? false : nativeBeacon(url, data);
  }
}

/** Runs first: a refused request never reaches retry, the error toast or the network. */
export const assistantWriteGuardInterceptor: HttpInterceptorFn = (req, next) => {
  const guard = inject(AssistantWriteGuard);
  const refused = guard.admit(req.method, req.urlWithParams);
  if (refused) {
    // Shaped like the engine's ResponseData envelope so a page that shows `error.message` shows why.
    return throwError(
      () =>
        new HttpErrorResponse({
          url: req.urlWithParams,
          status: 403,
          statusText: 'Blocked by the assistant',
          error: { status: false, message: blockedMessage(refused) },
        }),
    );
  }
  guard.requestStarted();
  return next(req).pipe(finalize(() => guard.requestFinished()));
};

/** What the operator / model reads about a refusal. */
export function blockedMessage(what: string): string {
  return (
    `That control would change data (${what}) — it was blocked. ` +
    'The assistant only changes what a page displays; propose the change through the engine instead.'
  );
}

/** One line for a command result: the refusals, or '' when there were none. */
export function describeBlocked(report: { blocked: string[]; blockedEarlier: string[] }): string {
  const parts: string[] = [];
  if (report.blocked.length) {
    parts.push(
      ` BLOCKED: that would change data (${report.blocked.join(', ')}) — nothing was sent. ` +
        'Propose the change through the engine (it becomes an approval card) instead.',
    );
  }
  if (report.blockedEarlier.length) {
    parts.push(` Also blocked after the previous command: ${report.blockedEarlier.join(', ')}.`);
  }
  return parts.join('');
}

/** Engine paths of credential surfaces are never echoed into the assistant's context. */
const SECRET_PATH =
  /(^|\/)(auth|login|logout|refresh|register|token|tokens|ws-ticket|password|credentials|api-key|secret|bff|machine)(\/|$)/i;

const API_PREFIX = '/api/v1/lascodia-trading-engine';
const MAX_LISTED = 12;

function push(list: string[], what: string): void {
  if (list.length < MAX_LISTED && !list.includes(what)) list.push(what);
}

function pathOnly(url: string): string {
  return url.split(/[?#]/)[0];
}

/** The URL's path, with the engine prefix removed and no query (filters may hold typed text). */
function displayPath(url: string): string {
  let p = pathOnly(url);
  const at = p.indexOf(API_PREFIX);
  if (at >= 0) return p.slice(at + API_PREFIX.length) || '/';
  try {
    p = new URL(p, 'http://x').pathname;
  } catch {
    /* keep as is */
  }
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
