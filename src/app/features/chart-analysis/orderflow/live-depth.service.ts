import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { MarketDataStreamService, type MdWatch } from '@core/realtime/marketdata-stream.service';
import { ChartPanelsService } from '../panels/side/chart-panels.service';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import { bookToSnapshot, pickBookStream } from './stream-depth';
import { entitlementRefusalMessage } from '@core/market-data/entitlement-refusal';

/** How often the live book is read when the hub is not delivering (the EA reports it about once a second). */
export const LIVE_DEPTH_POLL_MS = 1_500;
/** The streamed book is republished to Angular at most this often. */
export const LIVE_DEPTH_STREAM_MS = 250;

export interface LiveDepth {
  /** The newest snapshot read; null until the first answer (or after a failure). */
  readonly snapshot: Signal<OrderBookSnapshot | null>;
  /** Why there is no book (no depth for the symbol, nothing streaming); null while it reads. */
  readonly error: Signal<string | null>;
  /** When the last answer came (ms), for the panel's age clock. */
  readonly readAt: Signal<number>;
  /** Where the book comes from now: the market-data hub (every change) or the 1.5 s poll. */
  readonly via: Signal<'stream' | 'poll'>;
  /** Stop watching (the poll ends with its last watcher). */
  release(): void;
}

interface Feed {
  symbol: string;
  /** The source to show (null: the freshest streaming one). */
  sourceId: string | null;
  watchers: number;
  timer: ReturnType<typeof setInterval>;
  seq: number;
  md: MdWatch;
  streamTimer: ReturnType<typeof setTimeout> | null;
  snapshot: WritableSignal<OrderBookSnapshot | null>;
  error: WritableSignal<string | null>;
  readAt: WritableSignal<number>;
  via: WritableSignal<'stream' | 'poll'>;
}

/**
 * The broker's live book for a symbol, ONE feed per (symbol, source) however many readers (the depth panel's ladder
 * and the heatmap's newest column). Prefers the market-data hub (C4: every book change, applied S/D, republished
 * ≤ 4 Hz); while the hub is not delivering a book for the symbol it falls back to polling
 * `market-data/order-book/latest` every 1.5 s (tab visible only) — the hub can be down, or the engine older.
 */
@Injectable({ providedIn: 'root' })
export class LiveDepthService {
  private readonly api = inject(ChartPanelsService);
  private readonly stream = inject(MarketDataStreamService);
  private readonly feeds = new Map<string, Feed>();

  watch(symbol: string, sourceId: string | null = null): LiveDepth {
    const key = `${symbol.toUpperCase()}|${sourceId ?? ''}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      const md = this.stream.watch({
        symbol,
        sources: sourceId ? [sourceId] : null,
        kinds: ['book'],
      });
      const created: Feed = {
        symbol,
        sourceId,
        watchers: 0,
        seq: 0,
        md,
        streamTimer: null,
        snapshot: signal<OrderBookSnapshot | null>(null),
        error: signal<string | null>(null),
        readAt: signal(Date.now()),
        via: signal<'stream' | 'poll'>('poll'),
        timer: setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          if (this.publishStream(created)) return;
          void this.read(created);
        }, LIVE_DEPTH_POLL_MS),
      };
      md.onBook(() => this.scheduleStream(created));
      feed = created;
      this.feeds.set(key, feed);
      if (!this.publishStream(feed)) void this.read(feed);
    }
    feed.watchers++;
    const held = feed;
    let released = false;
    return {
      snapshot: held.snapshot.asReadonly(),
      error: held.error.asReadonly(),
      readAt: held.readAt.asReadonly(),
      via: held.via.asReadonly(),
      release: () => {
        if (released) return;
        released = true;
        if (--held.watchers > 0) return;
        clearInterval(held.timer);
        if (held.streamTimer) clearTimeout(held.streamTimer);
        held.md.release();
        held.seq++;
        if (this.feeds.get(key) === held) this.feeds.delete(key);
      },
    };
  }

  /** A book event arrived on the hub: republish within {@link LIVE_DEPTH_STREAM_MS}. */
  private scheduleStream(feed: Feed): void {
    if (feed.streamTimer) return;
    feed.streamTimer = setTimeout(() => {
      feed.streamTimer = null;
      this.publishStream(feed);
    }, LIVE_DEPTH_STREAM_MS);
  }

  /** Publish the streamed book when the hub is delivering one; false when it is not (poll instead). */
  private publishStream(feed: Feed): boolean {
    if (!this.stream.usable()) return false;
    const s = pickBookStream(feed.md.streams(), feed.sourceId, Date.now());
    if (!s) return false;
    const snap = bookToSnapshot(feed.symbol, s.sourceId, s.book);
    if (!snap) return false;
    feed.seq++; // a poll in flight is now older than the stream
    feed.snapshot.set(snap);
    feed.error.set(null);
    feed.readAt.set(Date.now());
    feed.via.set('stream');
    return true;
  }

  private async read(feed: Feed): Promise<void> {
    const n = ++feed.seq;
    try {
      const snap = await firstValueFrom(this.api.orderBook(feed.symbol));
      if (n !== feed.seq) return;
      feed.snapshot.set(snap);
      feed.error.set(null);
      feed.via.set('poll');
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
