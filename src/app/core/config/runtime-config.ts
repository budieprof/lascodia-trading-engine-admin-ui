import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface RuntimeConfig {
  apiBaseUrl: string;

  // Optional observability hooks — omit in local dev, populate in prod.
  sentryDsn?: string;
  sentryEnvironment?: string;
  sentryRelease?: string;
  sentryTracesSampleRate?: number;

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
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

const FALLBACK_CONFIG: RuntimeConfig = {
  apiBaseUrl: environment.apiBaseUrl,
};

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) return FALLBACK_CONFIG;
    const cfg = (await res.json()) as Partial<RuntimeConfig>;
    return {
      apiBaseUrl: cfg.apiBaseUrl ?? FALLBACK_CONFIG.apiBaseUrl,
      sentryDsn: cfg.sentryDsn,
      sentryEnvironment: cfg.sentryEnvironment,
      sentryRelease: cfg.sentryRelease,
      sentryTracesSampleRate: cfg.sentryTracesSampleRate,
      featureFlags: cfg.featureFlags,
      appVersion: cfg.appVersion,
      buildSha: cfg.buildSha,
      buildTime: cfg.buildTime,
      environmentLabel: cfg.environmentLabel,
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}
