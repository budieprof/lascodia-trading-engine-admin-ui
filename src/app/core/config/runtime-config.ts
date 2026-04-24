import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface RuntimeConfig {
  apiBaseUrl: string;
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
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}
