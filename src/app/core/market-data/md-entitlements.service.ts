import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';

/** One feed the active organisation can read (engine C6 `GET md/entitlements/me`). */
export interface MyMarketDataFeed {
  /** `broker-ticks`, `broker-dom`, `cme-l2`, `cme-trades`, `venue:{id}`, `source:{id}`. */
  feedId: string;
  name: string;
  /** People may view it. */
  display: boolean;
  /** Machines and algorithms may consume it. */
  nonDisplay: boolean;
  /** When the licence ends (ISO), null = no end. */
  validTo: string | null;
  /** `grant` (a licence), `default` (every organisation's), `house` (House has every feed). */
  source: 'grant' | 'default' | 'house' | string;
}

/** `GET md/entitlements/me`. */
export interface MyMarketDataEntitlements {
  tenantId: number | null;
  feeds: MyMarketDataFeed[];
  /** Every feed is readable (House), including feeds added later. */
  allFeeds: boolean;
  /** The plan's feed bound; null = every feed. */
  planFeeds: string[] | null;
  /** The engine could not read entitlements: only the default rule applies for now. */
  degraded: boolean;
}

/** Re-read at most this often (the engine's own cache is 30 s). */
const MAX_AGE_MS = 60_000;

/**
 * The active organisation's market-data entitlements (engine C6), for layers that want to show "not entitled" before
 * asking for data — the chart's heatmap / DOM / trade layers and the source picker. Loaded on first use, kept a minute;
 * `refresh()` after an `mdRevoked` hub message. Until loaded (or when the engine is older than C6) nothing is assumed
 * refused: `isEntitled` answers `null` = unknown, and the data call itself says so (`-403-entitlement`).
 */
@Injectable({ providedIn: 'root' })
export class MarketDataEntitlementsService {
  private readonly api = inject(ApiService);
  private readonly state = signal<MyMarketDataEntitlements | null>(null);
  private loadedAt = 0;
  private inFlight: Promise<MyMarketDataEntitlements | null> | null = null;

  /** The last answer (null until loaded or when the engine does not offer it). */
  readonly entitlements = this.state.asReadonly();

  /** Feed ids readable for display, as a set (empty until loaded). */
  readonly displayFeeds = computed(
    () => new Set((this.state()?.feeds ?? []).filter((f) => f.display).map((f) => f.feedId)),
  );

  /** Loads (or re-uses a fresh answer). Never throws: a failure leaves the last answer. */
  async load(force = false): Promise<MyMarketDataEntitlements | null> {
    if (!force && this.state() && Date.now() - this.loadedAt < MAX_AGE_MS) return this.state();
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const me = await firstValueFrom(
          this.api.getEnvelope<MyMarketDataEntitlements>('/md/entitlements/me', { silent: true }),
        );
        this.state.set(me);
        this.loadedAt = Date.now();
        return me;
      } catch {
        return this.state();
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Drops the answer and loads again (after a revocation notice). */
  refresh(): Promise<MyMarketDataEntitlements | null> {
    return this.load(true);
  }

  /**
   * Whether the organisation may view (`display`, default) or consume (`nonDisplay`) a feed: true / false once loaded,
   * null while unknown.
   */
  isEntitled(feedId: string, usage: 'display' | 'nonDisplay' = 'display'): boolean | null {
    return entitledIn(this.state(), feedId, usage);
  }
}

/** The rule on a loaded answer (exported for tests and for code holding an answer of its own). */
export function entitledIn(
  me: MyMarketDataEntitlements | null,
  feedId: string,
  usage: 'display' | 'nonDisplay' = 'display',
): boolean | null {
  if (!me) return null;
  if (me.allFeeds) return true;
  const feed = me.feeds.find((f) => f.feedId === feedId);
  if (!feed) return false;
  return usage === 'display' ? feed.display : feed.nonDisplay;
}
