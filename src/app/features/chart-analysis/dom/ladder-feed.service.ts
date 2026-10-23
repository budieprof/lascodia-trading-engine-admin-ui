import { Injectable, NgZone, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { hubConnectPlan } from '@core/realtime/hub-auth';
import { backoffMs } from '@core/realtime/realtime.service';

import { LiveDepthService } from '../orderflow/live-depth.service';
import { parseDepth } from '../panels/side/depth';
import {
  applyBookEvents,
  bestPrices,
  bookFromLevels,
  emptyBook,
  type BookState,
  type MdFrame,
  type MdTicks,
} from './book-state';

/**
 * THE LADDER'S MARKET-DATA ADAPTER (dom-trading, market-data program wave B).
 *
 * The ladder reads the live book and ticks through this one seam: `watch(symbol)` → a {@link LadderWatch} with a cheap
 * pull API (`book()`, `quote()`, read every throttled frame) and a ≤ 4 Hz `version` signal for Angular. Until the
 * shared streaming client (`core/realtime/marketdata-stream.service.ts`, ui-stream) is merged, this file holds a
 * MINIMAL client of the engine's market-data hub (contract C4, `/api/hubs/marketdata`, JSON protocol): one
 * connection, run outside Angular's zone, `Subscribe(symbol, [], ['ticks','book'])`, C2 S/D events folded per source.
 * When the hub cannot be reached (or never sends a book) it falls back to the 1.5 s polled snapshot
 * (`market-data/order-book/latest`, {@link LiveDepthService}) and says so (`mode: 'poll'`).
 *
 * Swap plan: once ui-stream lands, replace the private `HubClient` below with the streaming service's per-(symbol,
 * source) state — the {@link LadderWatch} surface stays, and nothing in the ladder changes.
 */

export type LadderFeedMode = 'connecting' | 'stream' | 'poll' | 'none';

export interface LadderQuote {
  bid: number | null;
  ask: number | null;
  /** Epoch ms of the newest tick or book event behind it. */
  t: number;
}

export interface LadderWatch {
  /** Bumped at most 4 times a second while data arrives — the only thing Angular needs to track. */
  readonly version: Signal<number>;
  readonly mode: Signal<LadderFeedMode>;
  /** Source ids that streamed a book, and the one shown. */
  readonly sources: Signal<string[]>;
  readonly sourceId: Signal<string | null>;
  /** Feeds the engine refused to this session (not entitled). */
  readonly denied: Signal<string[]>;
  /** The book of the shown source (mutated in place by the feed; read it, never keep it). */
  book(): BookState | null;
  quote(): LadderQuote;
  /** Called with every tick batch of the shown source (outside Angular's zone). */
  onTicks(listener: (ticks: MdTicks) => void): () => void;
  selectSource(sourceId: string): void;
  release(): void;
}

/** The hub's answer to Subscribe (C4 + md-ingest's additive fields). */
interface SubscribeResult {
  ok?: boolean;
  denied?: string[];
  subscribed?: string[];
  unknown?: string[];
  error?: string | null;
}

/** How long the stream may stay silent (no book) before the ladder polls instead. */
const STREAM_GRACE_MS = 6_000;
/** The ≤ 4 Hz frame of the Angular-bound version signal. */
const VERSION_MS = 250;

interface Feed {
  symbol: string;
  watchers: number;
  books: Map<string, BookState>;
  lastTick: Map<string, { bid: number; ask: number; t: number }>;
  selected: string | null;
  dirty: boolean;
  tickListeners: Set<(ticks: MdTicks) => void>;
  version: WritableSignal<number>;
  mode: WritableSignal<LadderFeedMode>;
  sources: WritableSignal<string[]>;
  sourceId: WritableSignal<string | null>;
  denied: WritableSignal<string[]>;
  poll: { release(): void; snapshot: () => unknown } | null;
  pollBook: BookState | null;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
}

@Injectable({ providedIn: 'root' })
export class LadderFeedService {
  private readonly zone = inject(NgZone);
  private readonly auth = inject(AuthService);
  private readonly runtime = inject(RUNTIME_CONFIG);
  private readonly liveDepth = inject(LiveDepthService);
  private readonly api = inject(ApiService);
  private readonly feeds = new Map<string, Feed>();
  private connection: HubConnection | null = null;
  private starting: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;

  watch(symbol: string): LadderWatch {
    const key = symbol.toUpperCase();
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = this.createFeed(key);
      this.feeds.set(key, feed);
      void this.subscribe(feed);
    }
    feed.watchers++;
    const held = feed;
    let released = false;
    return {
      version: held.version.asReadonly(),
      mode: held.mode.asReadonly(),
      sources: held.sources.asReadonly(),
      sourceId: held.sourceId.asReadonly(),
      denied: held.denied.asReadonly(),
      book: () => (held.mode() === 'poll' ? held.pollBook : held.selected ? (held.books.get(held.selected) ?? null) : null),
      quote: () => this.quoteOf(held),
      onTicks: (listener) => {
        held.tickListeners.add(listener);
        return () => held.tickListeners.delete(listener);
      },
      selectSource: (sourceId) => {
        held.selected = sourceId;
        held.sourceId.set(sourceId);
        held.dirty = true;
      },
      release: () => {
        if (released) return;
        released = true;
        if (--held.watchers > 0) return;
        clearInterval(held.timer);
        held.poll?.release();
        this.feeds.delete(key);
        void this.invoke('Unsubscribe', key);
        if (this.feeds.size === 0) void this.stop();
      },
    };
  }

  /** C5 ticks of `symbol` in [from, to] (epoch ms) for the session's tick counts; null when the history is not available. */
  async historyTicks(symbol: string, sourceId: string | null, from: number, to: number): Promise<MdTicks | null> {
    try {
      const res = await firstValueFrom(
        this.api.post<{ data?: { sources?: { sourceId: string; ticks?: MdTicks | null }[] } | null; status?: boolean }>(
          '/md/history',
          { symbol, sourceIds: sourceId ? [sourceId] : null, from, to, kinds: ['ticks'] },
          { silent: true },
        ),
      );
      const sources = res?.data?.sources ?? [];
      const s = sources.find((x) => x.sourceId === sourceId) ?? sources.find((x) => (x.ticks?.t?.length ?? 0) > 0);
      return s?.ticks ?? null;
    } catch {
      return null;
    }
  }

  // ── Feeds ─────────────────────────────────────────────────────────────────

  private createFeed(symbol: string): Feed {
    const feed: Feed = {
      symbol,
      watchers: 0,
      books: new Map(),
      lastTick: new Map(),
      selected: null,
      dirty: false,
      tickListeners: new Set(),
      version: signal(0),
      mode: signal<LadderFeedMode>('connecting'),
      sources: signal<string[]>([]),
      sourceId: signal<string | null>(null),
      denied: signal<string[]>([]),
      poll: null,
      pollBook: null,
      startedAt: Date.now(),
      timer: undefined as unknown as ReturnType<typeof setInterval>,
    };
    // The Angular-bound beat runs outside the zone; a signal write schedules the view on its own.
    feed.timer = this.zone.runOutsideAngular(() =>
      setInterval(() => this.beat(feed), VERSION_MS),
    );
    return feed;
  }

  private beat(feed: Feed): void {
    // No book from the stream within the grace period: poll instead (and keep listening — the stream wins back).
    if (feed.mode() !== 'stream' && feed.books.size === 0 && Date.now() - feed.startedAt > STREAM_GRACE_MS && !feed.poll)
      this.startPolling(feed);
    if (feed.poll) {
      const snap = feed.poll.snapshot() as Parameters<typeof parseDepth>[0];
      if (snap) {
        const d = parseDepth(snap, 50);
        const t = Date.parse(snap.capturedAt) || Date.now();
        if (!feed.pollBook || feed.pollBook.t !== t) {
          feed.pollBook = bookFromLevels(d.bids, d.asks, t);
          feed.dirty = true;
        }
      }
    }
    if (feed.dirty) {
      feed.dirty = false;
      feed.version.update((v) => v + 1);
    }
  }

  private startPolling(feed: Feed): void {
    const watch = this.liveDepth.watch(feed.symbol);
    feed.poll = { release: () => watch.release(), snapshot: () => watch.snapshot() };
    feed.mode.set('poll');
  }

  private stopPolling(feed: Feed): void {
    feed.poll?.release();
    feed.poll = null;
    feed.pollBook = null;
  }

  private quoteOf(feed: Feed): LadderQuote {
    if (feed.mode() === 'poll') {
      const b = feed.pollBook;
      if (!b) return { bid: null, ask: null, t: 0 };
      const best = bestPrices(b);
      return { bid: best.bid, ask: best.ask, t: b.t };
    }
    const src = feed.selected;
    const tick = src ? feed.lastTick.get(src) : undefined;
    const book = src ? feed.books.get(src) : undefined;
    const best = book ? bestPrices(book) : { bid: null, ask: null };
    // The newest of the tick and the book decides (a tick carries the broker's quote even where the book is thin).
    if (tick && (!book || tick.t >= book.t)) return { bid: tick.bid, ask: tick.ask, t: tick.t };
    return { bid: best.bid, ask: best.ask, t: book?.t ?? 0 };
  }

  /** One frame of the hub (outside the zone). */
  private onFrame(frame: MdFrame): void {
    const feed = this.feeds.get((frame.symbol ?? '').toUpperCase());
    if (!feed || !frame.sourceId) return;
    const source = frame.sourceId;
    if (frame.book?.length) {
      let book = feed.books.get(source);
      if (!book) {
        book = emptyBook();
        feed.books.set(source, book);
        feed.sources.set([...feed.books.keys()].sort());
      }
      applyBookEvents(book, frame.book);
      if (!feed.selected) {
        feed.selected = source;
        feed.sourceId.set(source);
      }
      if (feed.mode() !== 'stream' && book.hasSnapshot) {
        feed.mode.set('stream');
        this.stopPolling(feed);
      }
    }
    const ticks = frame.ticks;
    if (ticks?.t?.length) {
      const n = ticks.t.length - 1;
      feed.lastTick.set(source, { bid: ticks.b[n], ask: ticks.a[n], t: ticks.t[n] });
      if (!feed.selected) {
        feed.selected = source;
        feed.sourceId.set(source);
      }
      if (source === feed.selected) for (const l of feed.tickListeners) l(ticks);
    }
    if (source === feed.selected) feed.dirty = true;
  }

  // ── The hub (minimal C4 client; replaced by ui-stream's service) ─────────

  private async subscribe(feed: Feed): Promise<void> {
    await this.ensureConnected();
    const res = await this.invoke<SubscribeResult>('Subscribe', feed.symbol, [], ['ticks', 'book']);
    if (res?.denied?.length) feed.denied.set(res.denied);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection?.state === HubConnectionState.Connected) return;
    this.starting ??= this.zone
      .runOutsideAngular(() => this.start())
      .finally(() => (this.starting = null));
    await this.starting;
  }

  private async start(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) return;
    const base = this.runtime.apiBaseUrl.replace(/\/$/, '');
    const plan = await hubConnectPlan(this.auth, `${base}/api/hubs/marketdata`);
    if (!plan) {
      this.scheduleRestart();
      return;
    }
    let builder = new HubConnectionBuilder().withUrl(plan.url, plan.options);
    if (plan.autoReconnect)
      builder = builder.withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => backoffMs(ctx.previousRetryCount) });
    const connection = builder.configureLogging(LogLevel.Warning).build();
    connection.on('md', (frame: MdFrame) => this.onFrame(frame));
    connection.onreconnected(() => void this.resubscribeAll());
    connection.onclose(() => this.scheduleRestart());
    this.connection = connection;
    try {
      await connection.start();
      this.restartAttempt = 0;
    } catch {
      this.scheduleRestart();
    }
  }

  /** After a reconnect the server has no subscriptions; each Subscribe answers with the current book as an `S`. */
  private async resubscribeAll(): Promise<void> {
    for (const feed of this.feeds.values()) {
      for (const b of feed.books.values()) b.hasSnapshot = false;
      await this.subscribe(feed);
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null || this.feeds.size === 0 || !this.auth.isAuthenticated()) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.connection = null;
      void this.zone.runOutsideAngular(() => this.start()).then(() => this.resubscribeAll());
    }, backoffMs(this.restartAttempt++));
  }

  private async stop(): Promise<void> {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const c = this.connection;
    this.connection = null;
    if (c) {
      try {
        await c.stop();
      } catch {
        /* best effort */
      }
    }
  }

  private async invoke<T = void>(method: string, ...args: unknown[]): Promise<T | null> {
    const c = this.connection;
    if (!c || c.state !== HubConnectionState.Connected) return null;
    try {
      return ((await c.invoke(method, ...args)) as T) ?? null;
    } catch {
      return null;
    }
  }
}
