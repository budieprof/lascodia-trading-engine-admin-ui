import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ChartPanelsService } from '../panels/side/chart-panels.service';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import { entitlementRefusalMessage } from '@core/market-data/entitlement-refusal';

/** How often the live book is read (the EA reports it about once a second). */
export const LIVE_DEPTH_POLL_MS = 1_500;

export interface LiveDepth {
  /** The newest snapshot read; null until the first answer (or after a failure). */
  readonly snapshot: Signal<OrderBookSnapshot | null>;
  /** Why there is no book (no depth for the symbol, nothing streaming); null while it reads. */
  readonly error: Signal<string | null>;
  /** When the last answer came (ms), for the panel's age clock. */
  readonly readAt: Signal<number>;
  /** Stop watching (the poll ends with its last watcher). */
  release(): void;
}

interface Feed {
  symbol: string;
  watchers: number;
  timer: ReturnType<typeof setInterval>;
  seq: number;
  snapshot: WritableSignal<OrderBookSnapshot | null>;
  error: WritableSignal<string | null>;
  readAt: WritableSignal<number>;
}

/**
 * The broker's live book (`market-data/order-book/latest`), polled every 1.5 s while anything watches it and the tab
 * is visible — ONE poll per symbol however many readers: the depth panel's ladder and the heatmap's newest column
 * (OF-1) read the same answers instead of doubling the requests.
 */
@Injectable({ providedIn: 'root' })
export class LiveDepthService {
  private readonly api = inject(ChartPanelsService);
  private readonly feeds = new Map<string, Feed>();

  watch(symbol: string): LiveDepth {
    const key = symbol.toUpperCase();
    let feed = this.feeds.get(key);
    if (!feed) {
      const created: Feed = {
        symbol,
        watchers: 0,
        seq: 0,
        snapshot: signal<OrderBookSnapshot | null>(null),
        error: signal<string | null>(null),
        readAt: signal(Date.now()),
        timer: setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void this.read(created);
        }, LIVE_DEPTH_POLL_MS),
      };
      feed = created;
      this.feeds.set(key, feed);
      void this.read(feed);
    }
    feed.watchers++;
    const held = feed;
    let released = false;
    return {
      snapshot: held.snapshot.asReadonly(),
      error: held.error.asReadonly(),
      readAt: held.readAt.asReadonly(),
      release: () => {
        if (released) return;
        released = true;
        if (--held.watchers > 0) return;
        clearInterval(held.timer);
        held.seq++;
        if (this.feeds.get(key) === held) this.feeds.delete(key);
      },
    };
  }

  private async read(feed: Feed): Promise<void> {
    const n = ++feed.seq;
    try {
      const snap = await firstValueFrom(this.api.orderBook(feed.symbol));
      if (n !== feed.seq) return;
      feed.snapshot.set(snap);
      feed.error.set(null);
    } catch (e: unknown) {
      if (n !== feed.seq) return;
      feed.snapshot.set(null);
      // Not entitled to the broker DOM feed (engine C6): say so, not "no depth".
      feed.error.set(
        entitlementRefusalMessage(e) ??
          `No depth for ${feed.symbol}: this broker does not publish market depth for it, or no EA is streaming it.`,
      );
    }
    feed.readAt.set(Date.now());
  }
}
