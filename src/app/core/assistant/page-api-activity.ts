import { Injectable, inject } from '@angular/core';
import { HttpEventType, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { filter, tap } from 'rxjs';

/** The engine's API prefix; everything after it is what the assistant's endpoint search matches. */
const API_PREFIX = '/api/v1/lascodia-trading-engine';

/** The dock's own traffic, live-update tickets and liveness pings say nothing about the page. */
const IGNORED = [
  /^\/market-data\/assistant(\/|$)/,
  /^\/market-data\/analyze\/\d+\/follow-up/,
  /^\/health(\/|$)/,
  /^\/admin\/auth\/me$/,
  // The console shell's own calls (header, status bar, notification bell) — every page makes them,
  // so they say nothing about the page the operator is on.
  /^\/tenant\/branding$/,
  /^\/admin\/notifications\/feed$/,
  /^\/paper-trading\/status$/,
  /^\/admin\/kill-switch\/global$/,
];

/**
 * Credential surfaces are never recorded at all, not even their path: a password set, a token
 * mint or a sign-in carries a secret in its body or answer. Same segments the engine's assistant
 * classifier refuses (AssistantAccess.DeniedSegments).
 */
const CREDENTIAL_SEGMENT =
  /(^|\/)(auth|login|logout|refresh|register|token|tokens|ws-ticket|password|change-password|reset-password|credentials|rotate-api-key|api-key|secret|scim-tokens|invitations|sso|tenant-key|machine|bff)(\/|$)/i;

/**
 * A request body is kept only for read-shaped calls, where it is the page's filter (a paged list,
 * a search, a compare, a preview). A write's body is the operator's form — it can hold anything
 * they typed, so it is not copied into the assistant's context.
 */
const FILTER_BODY_PATH =
  /\/(list|query|paged|search|compare|preview|summary|points|walk|explain|estimate|sensitivity-analysis|validate|compile)$/i;

const MAX_SOURCES = 30;
const MAX_VALUE_CHARS = 80;
const MAX_BODY_CHARS = 400;

/** One engine call the current page made. */
export interface PageDataSource {
  /** "GET", "POST", … */
  method: string;
  /** Path after the API prefix, with the page's real ids in it: "/strategy/1184/footprint". */
  path: string;
  /** Query string as the page sent it — on list pages these ARE the operator's filters. */
  query?: Record<string, string>;
  /** A POST/PUT body, abbreviated — paged list filters travel here. */
  body?: string;
  /** Last HTTP status seen (0 = no answer / network error). */
  status: number;
  /** How many times the page made this call since it opened (polling shows up as > 1). */
  calls: number;
}

/**
 * The engine calls the current page has made since the operator opened it.
 *
 * <p>Most pages publish no facts of their own, so on them the assistant knew a page's NAME and
 * nothing about where its numbers come from; it had to guess which of ~1,000 endpoints back the
 * page. The page's own requests answer that exactly, on every page, with no per-page code: each
 * path can be looked up with search_endpoints and called again with the same filters.</p>
 *
 * <p>Only the request is recorded — method, path, query and an abbreviated body, all of which
 * the console itself wrote. Responses are not: they hold data (broker comments, news, notes) that
 * must reach the model through a tool, where it is fenced as untrusted, not through the page
 * context.</p>
 */
@Injectable({ providedIn: 'root' })
export class PageApiActivity {
  private readonly sources = new Map<string, PageDataSource>();
  private pagePath = '';

  constructor() {
    const router = inject(Router);
    this.pagePath = pathOnly(router.url);
    router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      // A filter change (query only) is the same page: keep what it loaded. A new page starts empty.
      const next = pathOnly((e as NavigationEnd).urlAfterRedirects);
      if (next !== this.pagePath) {
        this.sources.clear();
        this.pagePath = next;
      }
    });
  }

  /** Called by the interceptor for every request; ignores anything that is not an engine call. */
  record(req: HttpRequest<unknown>, status: number): void {
    const parsed = engineCall(req.urlWithParams);
    if (!parsed || IGNORED.some((re) => re.test(parsed.path))) return;
    if (CREDENTIAL_SEGMENT.test(parsed.path)) return;
    const key = `${req.method} ${parsed.path}`;
    const existing = this.sources.get(key);
    if (existing) {
      existing.calls++;
      existing.status = status;
      if (parsed.query) existing.query = parsed.query;
      return;
    }
    if (this.sources.size >= MAX_SOURCES) return;
    const body =
      req.method !== 'GET' && req.method !== 'HEAD' && FILTER_BODY_PATH.test(parsed.path)
        ? abbreviate(req.body)
        : undefined;
    this.sources.set(key, {
      method: req.method,
      path: parsed.path,
      ...(parsed.query ? { query: parsed.query } : {}),
      ...(body ? { body } : {}),
      status,
      calls: 1,
    });
  }

  /** What the page has called so far, oldest first. */
  list(): PageDataSource[] {
    return [...this.sources.values()].map((s) => ({ ...s }));
  }
}

/** Records every engine call into {@link PageApiActivity}, with the status it got. */
export const pageApiActivityInterceptor: HttpInterceptorFn = (req, next) => {
  const activity = inject(PageApiActivity);
  return next(req).pipe(
    tap({
      next: (ev) => {
        if (ev.type === HttpEventType.Response) activity.record(req, ev.status);
      },
      error: (err: unknown) => {
        const status =
          err && typeof err === 'object' && 'status' in err
            ? Number((err as { status: unknown }).status)
            : 0;
        activity.record(req, Number.isFinite(status) ? status : 0);
      },
    }),
  );
};

/** Splits an absolute or relative URL into the engine path and its query, or null if not an engine call. */
export function engineCall(url: string): { path: string; query?: Record<string, string> } | null {
  const at = url.indexOf(API_PREFIX);
  if (at < 0) return null;
  const rest = url.slice(at + API_PREFIX.length);
  const [rawPath, rawQuery] = rest.split('?', 2);
  const path = rawPath.split('#')[0] || '/';
  if (!rawQuery) return { path };
  const query: Record<string, string> = {};
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=', 2);
    try {
      query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')).slice(
        0,
        MAX_VALUE_CHARS,
      );
    } catch {
      query[k] = v.slice(0, MAX_VALUE_CHARS);
    }
  }
  return Object.keys(query).length ? { path, query } : { path };
}

function abbreviate(body: unknown): string | undefined {
  if (body == null || body instanceof FormData || body instanceof Blob) return undefined;
  let text: string;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    return undefined;
  }
  if (!text || text === '{}' || text === 'null') return undefined;
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '…' : text;
}

function pathOnly(url: string): string {
  return (url || '').split(/[?#]/)[0];
}
