import { BookState } from './md-book';
import { TickRing, TradeRing } from './md-rings';
import type {
  MdBookEventWire,
  MdFrame,
  MdHistory,
  MdHistoryRequest,
  MdKind,
  MdSubscribeResult,
} from './marketdata.types';

/**
 * The market-data stream's engine room, free of Angular so it can be tested with a fake connection: one hub
 * connection (C4), standing subscriptions per symbol (the union of what every watcher asked for, re-issued on every
 * connection), per (symbol, source) state — a tick ring, a trade ring and the book rebuilt from S/D events — and the
 * resync rules:
 * - a NEW connection after a drop: frames are held while the missed span (≤ {@link RESYNC_MAX_MS}) is read from
 *   `md/history` (C5), the missing ticks / trades / book events are applied in order, then the held frames;
 * - a book delta with no book under it (a lost frame, a resubscribe race): the book is marked unknown and a keyframe is
 *   read from `md/history` for the last {@link KEYFRAME_LOOKBACK_MS} (at most once per {@link KEYFRAME_RETRY_MS}); the
 *   hub's own next `S` also repairs it.
 * Nothing here touches Angular: listeners run synchronously in whatever zone the connection's callbacks run in (the
 * Angular service creates the connection outside the zone).
 */

/** The connection as the core uses it (SignalR's HubConnection fits; tests pass a fake). */
export interface MdConnection {
  on(event: string, handler: (...args: unknown[]) => void): void;
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  onclose(cb: (error?: Error) => void): void;
  onreconnecting?(cb: (error?: Error) => void): void;
  onreconnected?(cb: (connectionId?: string) => void): void;
  stop(): Promise<void>;
}

export type MdProtocol = 'messagepack' | 'json';

export interface MdStreamDeps {
  /** Open (and start) a connection speaking `protocol`; rejects when it cannot. Null: not signed in / no ticket yet. */
  connect(protocol: MdProtocol): Promise<MdConnection | null>;
  /** C5 read (resync, keyframes). */
  history(req: MdHistoryRequest): Promise<MdHistory>;
  /** Wall clock, epoch ms (the engine's clock when known). */
  now(): number;
  /** Timers (tests drive them). */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Reconnect delay for attempt n. */
  backoffMs(attempt: number): number;
  /** Something about a symbol changed (frames, status): the Angular side turns this into ≤ 4 Hz signals. */
  changed(symbolKey: string): void;
  /** The connection state changed. */
  stateChanged(state: MdStreamState): void;
  /**
   * cme-tier2: map a frame before it is applied (CME futures onto the spot symbol — `CmeSpotService`); null drops it
   * (its source is not resolved yet: the book repairs from history). Absent: frames are applied as received.
   */
  mapFrame?(frame: MdFrame): MdFrame | null;
}

export type MdStreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

/** The event frames arrive on (engine `MarketDataHub.FrameEvent`). */
export const MD_FRAME_EVENT = 'md';
/** A reconnect reads at most this much missed history. */
export const RESYNC_MAX_MS = 60_000;
/** A keyframe request reads this far back. */
export const KEYFRAME_LOOKBACK_MS = 5_000;
/** A failing keyframe request is not repeated sooner than this. */
export const KEYFRAME_RETRY_MS = 5_000;
/** A connection that could not be opened leaves the hub "unavailable" (polling fallback) for this long. */
export const UNAVAILABLE_FOR_MS = 60_000;

/** One source's live state for a symbol: what renderers pull from. */
export class MdSourceStream {
  readonly ticks = new TickRing();
  readonly trades = new TradeRing();
  readonly book = new BookState();
  /** Book events applied since the stream started (renderers append live columns from {@link onBook}). */
  bookEvents = 0;
  /** Client time (ms) of the last frame. */
  lastFrameAt = 0;
  /** Times the book had to be re-keyed (gap, orphan delta). */
  bookGaps = 0;
  /** A keyframe read is in flight / last tried at. */
  keyframePending = false;
  keyframeTriedAt = 0;

  constructor(
    readonly symbol: string,
    readonly sourceId: string,
  ) {}
}

/** What a watcher asked for. */
export interface MdWatchSpec {
  /** Engine symbol. */
  symbol: string;
  /** Registry source ids; null / empty = every source the caller is entitled to. */
  sources?: readonly string[] | null;
  kinds: readonly MdKind[];
}

/** Subscription status of a symbol, as the hub answered it. */
export interface MdWatchStatus {
  state: MdStreamState;
  protocol: MdProtocol | null;
  /** `sourceId:kind` pairs streaming. */
  subscribed: string[];
  /** Feeds refused by entitlements. */
  denied: string[];
  /** Requested sources / kinds the hub does not know. */
  unknown: string[];
  error: string | null;
}

/** A listener for one symbol's frames: the frame as received and the source's state AFTER it was applied. */
export type MdFrameListener = (frame: MdFrame, stream: MdSourceStream) => void;
/** A listener for book events applied to a source (live, resync and keyframe repairs alike); `reset` = book replaced. */
export type MdBookListener = (
  stream: MdSourceStream,
  events: readonly MdBookEventWire[],
  reset: boolean,
) => void;

interface SymbolEntry {
  key: string;
  specs: Map<number, MdWatchSpec>;
  streams: Map<string, MdSourceStream>;
  frameListeners: Set<MdFrameListener>;
  bookListeners: Set<MdBookListener>;
  status: MdWatchStatus;
  /** What was last subscribed (sources null = all, kinds). */
  subscribedKey: string | null;
  /** Frames held during a resync. */
  held: MdFrame[] | null;
}

export class MarketDataStreamCore {
  private connection: MdConnection | null = null;
  private protocol: MdProtocol | null = null;
  private starting: Promise<void> | null = null;
  private restartTimer: unknown = null;
  private restartAttempt = 0;
  private msgpackRefused = false;
  private unavailableUntil = 0;
  private everConnected = false;
  /** Client time the connection was last known good (for the resync span). */
  private lastGoodAt = 0;
  private readonly symbols = new Map<string, SymbolEntry>();
  private nextId = 1;
  private disposed = false;
  state: MdStreamState = 'idle';

  constructor(private readonly deps: MdStreamDeps) {}

  /** Whether the hub is worth relying on now (else callers keep their polling fallbacks). */
  get usable(): boolean {
    return this.state === 'connected';
  }

  get currentProtocol(): MdProtocol | null {
    return this.protocol;
  }

  /** Start watching; returns an id for {@link unwatch}. */
  watch(spec: MdWatchSpec): number {
    const key = spec.symbol.trim().toUpperCase();
    let entry = this.symbols.get(key);
    if (!entry) {
      entry = {
        key,
        specs: new Map(),
        streams: new Map(),
        frameListeners: new Set(),
        bookListeners: new Set(),
        status: {
          state: this.state,
          protocol: this.protocol,
          subscribed: [],
          denied: [],
          unknown: [],
          error: null,
        },
        subscribedKey: null,
        held: null,
      };
      this.symbols.set(key, entry);
    }
    const id = this.nextId++;
    entry.specs.set(id, { ...spec, symbol: key });
    void this.ensureConnected().then(() => this.sync(entry!));
    return id;
  }

  unwatch(symbol: string, id: number): void {
    const key = symbol.trim().toUpperCase();
    const entry = this.symbols.get(key);
    if (!entry || !entry.specs.delete(id)) return;
    if (entry.specs.size === 0) {
      this.symbols.delete(key);
      void this.invoke('Unsubscribe', key);
      if (this.symbols.size === 0) void this.stop();
    } else void this.sync(entry);
  }

  onFrame(symbol: string, listener: MdFrameListener): () => void {
    const entry = this.symbols.get(symbol.trim().toUpperCase());
    if (!entry) return () => undefined;
    entry.frameListeners.add(listener);
    return () => entry.frameListeners.delete(listener);
  }

  onBook(symbol: string, listener: MdBookListener): () => void {
    const entry = this.symbols.get(symbol.trim().toUpperCase());
    if (!entry) return () => undefined;
    entry.bookListeners.add(listener);
    return () => entry.bookListeners.delete(listener);
  }

  streams(symbol: string): MdSourceStream[] {
    return [...(this.symbols.get(symbol.trim().toUpperCase())?.streams.values() ?? [])];
  }

  stream(symbol: string, sourceId: string): MdSourceStream | null {
    return this.symbols.get(symbol.trim().toUpperCase())?.streams.get(sourceId) ?? null;
  }

  status(symbol: string): MdWatchStatus | null {
    const e = this.symbols.get(symbol.trim().toUpperCase());
    return e ? { ...e.status, state: this.state, protocol: this.protocol } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.symbols.clear();
    void this.stop();
  }

  // ── Connection ─────────────────────────────────────────────────────────────────────────────

  private setState(s: MdStreamState): void {
    if (this.state === s) return;
    this.state = s;
    this.deps.stateChanged(s);
    for (const key of this.symbols.keys()) this.deps.changed(key);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection) return;
    if (this.deps.now() < this.unavailableUntil && this.restartTimer !== null) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    await this.starting;
  }

  private async start(): Promise<void> {
    if (this.disposed || this.connection || this.symbols.size === 0) return;
    this.setState(this.everConnected ? 'reconnecting' : 'connecting');
    let conn: MdConnection | null = null;
    let protocol: MdProtocol = this.msgpackRefused ? 'json' : 'messagepack';
    try {
      conn = await this.deps.connect(protocol);
    } catch {
      if (protocol === 'messagepack') {
        // An engine without the MessagePack protocol (or a proxy that mangles binary frames): JSON from now on.
        this.msgpackRefused = true;
        protocol = 'json';
        try {
          conn = await this.deps.connect('json');
        } catch {
          conn = null;
        }
      }
      if (!conn) {
        this.unavailableUntil = this.deps.now() + UNAVAILABLE_FOR_MS;
        this.setState('unavailable');
        this.scheduleRestart();
        return;
      }
    }
    if (!conn) {
      this.setState('unavailable');
      this.scheduleRestart();
      return;
    }
    if (this.disposed || this.symbols.size === 0) {
      void conn.stop().catch(() => undefined);
      return;
    }
    this.connection = conn;
    this.protocol = protocol;
    this.restartAttempt = 0;
    this.unavailableUntil = 0;
    conn.on(MD_FRAME_EVENT, (payload: unknown) => this.onFramePayload(payload));
    conn.onclose(() => {
      if (this.connection !== conn) return;
      this.connection = null;
      this.lastGoodAt = this.lastGoodAt || this.deps.now();
      this.setState(this.symbols.size ? 'reconnecting' : 'idle');
      for (const e of this.symbols.values()) e.subscribedKey = null;
      this.scheduleRestart();
    });
    conn.onreconnecting?.(() => {
      if (this.connection !== conn) return;
      this.lastGoodAt = this.deps.now();
      this.setState('reconnecting');
    });
    conn.onreconnected?.(() => {
      if (this.connection !== conn) return;
      this.setState('connected');
      for (const e of this.symbols.values()) {
        e.subscribedKey = null;
        void this.resubscribe(e, true);
      }
    });
    const resync = this.everConnected;
    this.everConnected = true;
    this.setState('connected');
    for (const e of this.symbols.values()) await this.resubscribe(e, resync);
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null || this.disposed || this.symbols.size === 0) return;
    this.restartTimer = this.deps.setTimeout(() => {
      this.restartTimer = null;
      void this.ensureConnected();
    }, this.deps.backoffMs(this.restartAttempt++));
  }

  private async stop(): Promise<void> {
    if (this.restartTimer !== null) {
      this.deps.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const c = this.connection;
    this.connection = null;
    this.everConnected = false;
    this.setState('idle');
    if (c) await c.stop().catch(() => undefined);
  }

  private async invoke<T>(method: string, ...args: unknown[]): Promise<T | null> {
    const c = this.connection;
    if (!c) return null;
    try {
      return ((await c.invoke<T>(method, ...args)) as T) ?? null;
    } catch {
      return null;
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────────────────────

  /** The union of what the watchers of a symbol want. */
  private wanted(entry: SymbolEntry): { sources: string[] | null; kinds: MdKind[] } {
    let all = false;
    const sources = new Set<string>();
    const kinds = new Set<MdKind>();
    for (const s of entry.specs.values()) {
      if (!s.sources || s.sources.length === 0) all = true;
      else for (const id of s.sources) sources.add(id);
      for (const k of s.kinds) kinds.add(k);
    }
    return { sources: all ? null : [...sources].sort(), kinds: [...kinds].sort() };
  }

  private async sync(entry: SymbolEntry): Promise<void> {
    if (!this.connection || this.symbols.get(entry.key) !== entry) return;
    const w = this.wanted(entry);
    const key = JSON.stringify(w);
    if (entry.subscribedKey === key) return;
    // Narrowing (a watcher left) needs a fresh subscription; widening adds to it.
    if (entry.subscribedKey !== null) await this.invoke('Unsubscribe', entry.key);
    await this.subscribeNow(entry, w, key);
  }

  private async resubscribe(entry: SymbolEntry, resync: boolean): Promise<void> {
    const w = this.wanted(entry);
    const key = JSON.stringify(w);
    if (resync && entry.streams.size > 0) {
      entry.held = [];
      await this.subscribeNow(entry, w, key);
      await this.resyncHistory(entry, w.kinds);
    } else await this.subscribeNow(entry, w, key);
  }

  private async subscribeNow(
    entry: SymbolEntry,
    w: { sources: string[] | null; kinds: MdKind[] },
    key: string,
  ): Promise<void> {
    entry.subscribedKey = key;
    const r = await this.invoke<MdSubscribeResult>('Subscribe', entry.key, w.sources, w.kinds);
    if (this.symbols.get(entry.key) !== entry) return;
    entry.status = {
      state: this.state,
      protocol: this.protocol,
      subscribed: r?.subscribed ?? [],
      denied: r?.denied ?? [],
      unknown: r?.unknown ?? [],
      error: r
        ? (r.error ?? (r.ok ? null : 'Nothing could be subscribed.'))
        : 'The market-data hub did not answer.',
    };
    if (!r) entry.subscribedKey = null;
    this.deps.changed(entry.key);
  }

  /** After a reconnect: read what was missed, apply it, then the frames held meanwhile. */
  private async resyncHistory(entry: SymbolEntry, kinds: MdKind[]): Promise<void> {
    const now = this.deps.now();
    try {
      const streams = [...entry.streams.values()];
      const since = Math.min(
        ...streams.map((s) => {
          const last = Math.max(
            s.ticks.lastTime || 0,
            s.book.known ? s.book.t : 0,
            s.trades.lastTime || 0,
          );
          return last > 0 ? last : now - RESYNC_MAX_MS;
        }),
      );
      const from = Math.max(now - RESYNC_MAX_MS, Math.floor(since));
      if (now > from && streams.length) {
        const h = await this.deps.history({
          symbol: entry.key,
          sourceIds: streams.map((s) => s.sourceId),
          from,
          to: now + 1,
          kinds,
        });
        for (const src of h.sources ?? []) {
          const stream = this.streamOf(entry, src.sourceId);
          if (src.ticks) stream.ticks.pushColumns(src.ticks);
          if (src.trades) stream.trades.pushColumns(src.trades);
          if (src.keyframe || src.book?.length) {
            const applied: MdBookEventWire[] = [];
            let reset = false;
            if (src.keyframe && !stream.book.known) {
              stream.book.applyKeyframe(src.keyframe);
              reset = true;
            }
            for (const e of src.book ?? []) if (this.applyBookEvent(stream, e)) applied.push(e);
            if (applied.length || reset) this.emitBook(entry, stream, applied, reset);
          }
        }
      }
    } catch {
      // The missed span stays missing; the hub's S frames repair the books.
    } finally {
      const held = entry.held ?? [];
      entry.held = null;
      for (const f of held) this.applyFrame(entry, f);
      this.deps.changed(entry.key);
    }
  }

  // ── Frames ─────────────────────────────────────────────────────────────────────────────────

  private onFramePayload(payload: unknown): void {
    const raw = payload as MdFrame | null;
    if (!raw || typeof raw.symbol !== 'string' || typeof raw.sourceId !== 'string') return;
    const f = this.deps.mapFrame ? this.deps.mapFrame(raw) : raw;
    if (!f) return;
    const entry = this.symbols.get(f.symbol.toUpperCase());
    if (!entry) return;
    this.lastGoodAt = this.deps.now();
    if (entry.held) {
      entry.held.push(f);
      return;
    }
    this.applyFrame(entry, f);
  }

  private streamOf(entry: SymbolEntry, sourceId: string): MdSourceStream {
    let s = entry.streams.get(sourceId);
    if (!s) {
      s = new MdSourceStream(entry.key, sourceId);
      entry.streams.set(sourceId, s);
    }
    return s;
  }

  /** Apply one book event unless it is older than the book (a resync overlap); false when not applied. */
  private applyBookEvent(stream: MdSourceStream, e: MdBookEventWire): boolean {
    if (stream.book.known && e.t < stream.book.t) return false;
    if (stream.book.apply(e)) {
      stream.bookEvents++;
      return true;
    }
    return false;
  }

  private applyFrame(entry: SymbolEntry, f: MdFrame): void {
    const stream = this.streamOf(entry, f.sourceId);
    stream.lastFrameAt = this.deps.now();
    if (f.ticks) stream.ticks.pushColumns(f.ticks);
    if (f.trades) stream.trades.pushColumns(f.trades);
    if (f.book?.length) {
      const applied: MdBookEventWire[] = [];
      let orphan = false;
      let reset = false;
      for (const e of f.book) {
        if (e.k === 'S') reset = true;
        if (this.applyBookEvent(stream, e)) applied.push(e);
        else if (e.k === 'D' && !stream.book.known) orphan = true;
      }
      if (applied.length) this.emitBook(entry, stream, applied, reset);
      if (orphan) this.requestKeyframe(entry, stream);
    }
    for (const l of entry.frameListeners) l(f, stream);
    this.deps.changed(entry.key);
  }

  private emitBook(
    entry: SymbolEntry,
    stream: MdSourceStream,
    events: readonly MdBookEventWire[],
    reset: boolean,
  ): void {
    for (const l of entry.bookListeners) l(stream, events, reset);
  }

  /** The book is unknown (a delta with nothing under it): read a keyframe from md/history. */
  private requestKeyframe(entry: SymbolEntry, stream: MdSourceStream): void {
    const now = this.deps.now();
    if (stream.keyframePending || now - stream.keyframeTriedAt < KEYFRAME_RETRY_MS) return;
    stream.keyframePending = true;
    stream.keyframeTriedAt = now;
    stream.bookGaps++;
    this.deps
      .history({
        symbol: entry.key,
        sourceIds: [stream.sourceId],
        from: now - KEYFRAME_LOOKBACK_MS,
        to: now + 1,
        kinds: ['book'],
      })
      .then((h) => {
        if (stream.book.known) return; // the hub's own S came first
        const src = h.sources?.find((s) => s.sourceId === stream.sourceId);
        if (!src) return;
        const applied: MdBookEventWire[] = [];
        if (src.keyframe) stream.book.applyKeyframe(src.keyframe);
        for (const e of src.book ?? []) if (this.applyBookEvent(stream, e)) applied.push(e);
        if (stream.book.known) {
          this.emitBook(entry, stream, applied, true);
          this.deps.changed(entry.key);
        }
      })
      .catch(() => undefined)
      .finally(() => (stream.keyframePending = false));
  }
}
