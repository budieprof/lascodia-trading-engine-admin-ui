import { Injectable, computed, inject, signal } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG, type RuntimeConfig } from '@core/config/runtime-config';

/**
 * Shape of a flag rule loaded from `config.json`. Each flag can be:
 *   - A plain boolean (global on/off).
 *   - An object with `{ enabled, permissions, roles, percent }` for permission / role gating +
 *     gradual rollout. Every knob that is set must pass.
 *
 * `bffAuth` is read separately (`core/auth/auth-mode.ts`): it decides HOW a person signs in, so it
 * cannot depend on who they are.
 *
 * Percent rollout uses a stable hash of the current `tradingAccountId` so the
 * same operator either always sees the flag or always doesn't — no flicker
 * between sessions.
 */
export type FeatureFlagRule =
  | boolean
  | {
      enabled?: boolean;
      /**
       * Any-of — if set, the caller must hold at least one of these permission keys in the
       * active organisation. Prefer this to `roles`: with `bffAuth` on a session carries
       * permissions, not roles.
       */
      permissions?: string[];
      /**
       * Any-of — if set, the caller's legacy token must carry at least one of these roles.
       * Legacy sign-in only (a BFF session has no roles, so a role rule never matches there).
       */
      roles?: string[];
      /** Rollout percentage (0–100). When set, hashes the current account id. */
      percent?: number;
    };

export type FeatureFlagMap = Record<string, FeatureFlagRule>;

export interface FeatureFlagsRuntimeConfig {
  featureFlags?: FeatureFlagMap;
}

/**
 * Runtime-config-backed feature flag service. Flags are loaded once from
 * `config.json` (so ops can flip them by rewriting the file on deploy) and
 * resolved per-call using the current auth principal. Shape mirrors what a
 * GrowthBook / Unleash client would expose so we can swap in a SaaS later
 * without rewriting callers.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly runtime = inject(RUNTIME_CONFIG) as RuntimeConfig & FeatureFlagsRuntimeConfig;
  private readonly auth = inject(AuthService);

  // Mutable for tests + local overrides via the `set` helper below.
  private readonly flags = signal<FeatureFlagMap>(this.runtime.featureFlags ?? {});

  /** Snapshot of the whole flag map — useful for admin-debug pages. */
  readonly all = this.flags.asReadonly();

  /**
   * `true` when the supplied flag name evaluates to enabled for the current
   * user. Defaults to `false` for unknown names — prefer explicit opt-in.
   */
  isOn(name: string): boolean {
    const rule = this.flags()[name];
    if (rule === undefined) return false;
    if (typeof rule === 'boolean') return rule;

    if (rule.enabled === false) return false;

    if (rule.permissions && rule.permissions.length > 0) {
      if (!this.auth.hasAnyPermission(rule.permissions)) return false;
    }

    if (rule.roles && rule.roles.length > 0) {
      const mine = this.auth.roles();
      if (!rule.roles.some((r) => mine.includes(r))) return false;
    }

    if (rule.percent !== undefined) {
      const key = this.bucketKey();
      if (!inRolloutBucket(key, rule.percent)) return false;
    }

    return true; // `enabled === false` was caught above; omitted/true both mean on.
  }

  /** Reactive variant — signals recompute when the underlying flags change. */
  watch(name: string) {
    return computed(() => this.isOn(name));
  }

  /**
   * Override a flag at runtime — useful for tests or dev toggles.
   * Persists nothing; wipes on reload.
   */
  set(name: string, value: FeatureFlagRule): void {
    this.flags.update((m) => ({ ...m, [name]: value }));
  }

  private bucketKey(): string {
    // Prefer the token's account id for stability across sessions; fall back
    // to the passport id; fall back to a stable "anon" so anon users all land
    // in the same bucket.
    return this.auth.user()?.passportId ?? 'anon';
  }
}

/**
 * Deterministic 0–99 bucket from a string + flag name. FNV-1a because it's
 * quick and the distribution is good enough for rollout gating.
 */
function inRolloutBucket(key: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = (hash >>> 0) % 100;
  return bucket < percent;
}
