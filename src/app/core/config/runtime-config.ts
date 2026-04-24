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
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}
