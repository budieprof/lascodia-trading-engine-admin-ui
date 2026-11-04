import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface RuntimeConfig {
  apiBaseUrl: string;

  // Optional observability hooks — omit in local dev, populate in prod.
  sentryDsn?: string;
  sentryEnvironment?: string;
  sentryRelease?: string;
  sentryTracesSampleRate?: number;
  sentryReplaysSessionSampleRate?: number;
  sentryReplaysOnErrorSampleRate?: number;

  /**
   * Flag map consumed by `FeatureFlagsService`. Keyed by flag name; values
   * are either a plain boolean (global on/off) or an object with role + percent
   * rollout knobs. See `feature-flags.service.ts`.
   */
  featureFlags?: Record<string, unknown>;

  // ── Build metadata — surfaced in the footer version pill. Populate via the
  // docker entrypoint at run-time so the same image carries different SHAs
  // across deploys. All optional; the pill degrades gracefully.
  appVersion?: string;
  buildSha?: string;
  buildTime?: string;
  environmentLabel?: string;
  /**
   * Unique per PUBLISH, not per commit — `20260920-010621-3ef5bec`.
   *
   * <p>Two publishes of one commit share a SHA, so a SHA cannot tell a tab whether what it
   * is running is still what is deployed. {@link ReleaseWatchService} compares this.</p>
   */
  releaseId?: string;

  /**
   * Where people manage their password, second factor and passkeys with BFF sign-in (the identity
   * provider's account console). Defaults to `<apiBaseUrl>/idp/realms/lascodia/account/`.
   */
  identityAccountUrl?: string;
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

const FALLBACK_CONFIG: RuntimeConfig = {
  apiBaseUrl: environment.apiBaseUrl,
};

/** `config.json` could not be read after every retry (production builds only). */
export class RuntimeConfigUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The console settings (config.json) could not be loaded.', { cause });
    this.name = 'RuntimeConfigUnavailableError';
  }
}

export interface LoadRuntimeConfigOptions {
  /** Waits before each retry, in ms. Three attempts in all by default. */
  retryDelaysMs?: readonly number[];
  /** Per-attempt timeout, in ms. */
  timeoutMs?: number;
  /**
   * What to do when every attempt failed. `fallback` (development builds) starts with the built-in
   * defaults; `throw` (production) refuses to start.
   */
  onFailure?: 'fallback' | 'throw';
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1500] as const;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * One attempt. Anything other than a 200 carrying a JSON object fails it: a 404 during a release
 * swap, a timeout, or an HTML page from the network edge (a challenge or error page answers 200
 * with HTML, and `res.json()` throws on it).
 */
async function fetchConfigOnce(
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Partial<RuntimeConfig>> {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn('config.json', { cache: 'no-store', signal: ctrl?.signal });
    if (!res.ok) throw new Error(`config.json answered HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('config.json is not a JSON object');
    }
    return body as Partial<RuntimeConfig>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads `config.json`, retrying a failed read.
 *
 * In production this NEVER falls back to built-in defaults. Those defaults carry no feature flags,
 * and `bffAuth` decides how people sign in: falling back once showed the retired Admin / Operator
 * password form instead of the Keycloak sign-in (2026-11-04). Refusing to start is the safe answer;
 * `main.ts` shows a "could not load, retry" screen instead.
 */
export async function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): Promise<RuntimeConfig> {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const onFailure = options.onFailure ?? (environment.production ? 'throw' : 'fallback');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cfg: Partial<RuntimeConfig> | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      cfg = await fetchConfigOnce(fetchFn, timeoutMs);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (cfg === null) {
    if (onFailure === 'throw') throw new RuntimeConfigUnavailableError(lastError);
    return FALLBACK_CONFIG;
  }
  return {
    apiBaseUrl: cfg.apiBaseUrl ?? FALLBACK_CONFIG.apiBaseUrl,
    sentryDsn: cfg.sentryDsn,
    sentryEnvironment: cfg.sentryEnvironment,
    sentryRelease: cfg.sentryRelease,
    sentryTracesSampleRate: cfg.sentryTracesSampleRate,
    sentryReplaysSessionSampleRate: cfg.sentryReplaysSessionSampleRate,
    sentryReplaysOnErrorSampleRate: cfg.sentryReplaysOnErrorSampleRate,
    featureFlags: cfg.featureFlags,
    appVersion: cfg.appVersion,
    buildSha: cfg.buildSha,
    buildTime: cfg.buildTime,
    environmentLabel: cfg.environmentLabel,
    releaseId: cfg.releaseId,
    identityAccountUrl: cfg.identityAccountUrl,
  };
}
