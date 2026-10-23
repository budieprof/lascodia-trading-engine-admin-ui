import {
  DestroyRef,
  Injectable,
  NgZone,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { MarketDataEntitlementsService } from '@core/market-data/md-entitlements.service';
import { hubConnectPlan } from './hub-auth';
import { MarketDataApiService } from './marketdata-api.service';
import { CmeSpotService } from './cme-spot.service';
import {
  MarketDataStreamCore,
  type MdBookListener,
  type MdConnection,
  type MdFrameListener,
  type MdProtocol,
  type MdSourceStream,
  type MdStreamState,
  type MdWatchSpec,
  type MdWatchStatus,
} from './marketdata-stream';
import { MessagePackHubProtocol } from './msgpack-hub-protocol';
import { backoffMs } from './realtime.service';

/** Angular-bound views of a watch refresh at most this often (renderers pull every frame instead). */
export const MD_SIGNAL_INTERVAL_MS = 250;

/**
 * A live market-data watch on one symbol (C4). Two ways to read it:
 * - **pull** (renderers, every animation frame, no change detection): {@link streams} / {@link stream} give each
 *   source's {@link MdSourceStream} — `ticks` (TickRing), `trades` (TradeRing), `book` (BookState rebuilt from S/D);
 *   {@link onFrame} / {@link onBook} call back synchronously OUTSIDE the Angular zone as frames are applied;
 * - **signals** (Angular-bound widgets): {@link version} and {@link status}, refreshed at most 4 times a second.
 * Call {@link release} when done (the last watcher of a symbol unsubscribes; the last of all closes the connection).
 */
export interface MdWatch {
  readonly symbol: string;
  /** Bumped (≤ 4 Hz) when any frame of this symbol arrived or the status changed. */
  readonly version: Signal<number>;
  readonly status: Signal<MdWatchStatus>;
  streams(): MdSourceStream[];
  stream(sourceId: string): MdSourceStream | null;
  onFrame(listener: MdFrameListener): () => void;
  onBook(listener: MdBookListener): () => void;
  release(): void;
}

interface SymbolSignals {
  version: WritableSignal<number>;
  status: WritableSignal<MdWatchStatus>;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  refs: number;
}

const EMPTY_STATUS: MdWatchStatus = {
  state: 'idle',
  protocol: null,
  subscribed: [],
  denied: [],
  deniedReasons: {},
  notEntitled: null,
  revoked: null,
  unknown: [],
  error: null,
};

/**
 * The console's connection to the engine's market-data hub (`/api/hubs/marketdata`, contract C4): MessagePack (in-repo
 * protocol, `msgpack-hub-protocol.ts`) with a JSON fallback, created and run OUTSIDE the Angular zone so 10 frames a
 * second per (symbol, source) never trigger change detection. Lazy — connects with the first watch, disconnects after
 * the last. Same sign-in as the other hubs (`hub-auth.ts`: legacy token per attempt, or a single-use BFF ticket per
 * connection). Gaps and reconnects are repaired from `md/history` (C5) — see {@link MarketDataStreamCore}.
 */
@Injectable({ providedIn: 'root' })
export class MarketDataStreamService {
  private readonly auth = inject(AuthService);
  private readonly runtime = inject(RUNTIME_CONFIG);
  private readonly api = inject(MarketDataApiService);
  private readonly zone = inject(NgZone);
  /** The organisation's feeds (C6): re-read when the hub revokes one, so layers grey it out before asking again. */
  readonly entitlements = inject(MarketDataEntitlementsService);
  private readonly cmeSpot = inject(CmeSpotService);
  private readonly perSymbol = new Map<string, SymbolSignals>();

  /** The hub connection's state; `connected` = frames are flowing (consumers may stop polling). */
  readonly state = signal<MdStreamState>('idle');
  /** The protocol in use (null while not connected). */
  readonly protocol = signal<MdProtocol | null>(null);

  private readonly core = new MarketDataStreamCore({
    connect: (p) => this.connect(p),
    history: (req) => this.api.history(req),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    backoffMs,
    changed: (key) => this.markDirty(key),
    revoked: () => void this.entitlements.refresh(),
    stateChanged: (s) => {
      this.state.set(s);
      this.protocol.set(s === 'connected' ? this.core.currentProtocol : null);
    },
    // cme-tier2: CME futures frames onto the spot symbol (inversion, side swap, live basis) before they are applied.
    mapFrame: (f) => this.cmeSpot.mapFrame(f),
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.core.dispose());
  }

  /** Whether the hub is delivering now. */
  usable(): boolean {
    return this.core.usable;
  }

  /** Watch `spec.symbol` (see {@link MdWatch}). */
  watch(spec: MdWatchSpec): MdWatch {
    const key = spec.symbol.trim().toUpperCase();
    let sig = this.perSymbol.get(key);
    if (!sig) {
      sig = {
        version: signal(0),
        status: signal<MdWatchStatus>({ ...EMPTY_STATUS, state: this.core.state }),
        dirty: false,
        timer: null,
        lastFlush: 0,
        refs: 0,
      };
      this.perSymbol.set(key, sig);
    }
    sig.refs++;
    const held = sig;
    const id = this.zone.runOutsideAngular(() => this.core.watch({ ...spec, symbol: key }));
    const unsubs: (() => void)[] = [];
    let released = false;
    return {
      symbol: key,
      version: held.version.asReadonly(),
      status: held.status.asReadonly(),
      streams: () => this.core.streams(key),
      stream: (sourceId) => this.core.stream(key, sourceId),
      onFrame: (l) => {
        const off = this.core.onFrame(key, l);
        unsubs.push(off);
        return off;
      },
      onBook: (l) => {
        const off = this.core.onBook(key, l);
        unsubs.push(off);
        return off;
      },
      release: () => {
        if (released) return;
        released = true;
        for (const off of unsubs) off();
        this.zone.runOutsideAngular(() => this.core.unwatch(key, id));
        if (--held.refs <= 0) {
          if (held.timer) clearTimeout(held.timer);
          if (this.perSymbol.get(key) === held) this.perSymbol.delete(key);
        }
      },
    };
  }

  /** Coalesce change notices into ≤ 4 Hz signal writes (outside the zone; signals schedule their own refresh). */
  private markDirty(key: string): void {
    const sig = this.perSymbol.get(key);
    if (!sig) return;
    sig.dirty = true;
    if (sig.timer) return;
    const wait = Math.max(0, MD_SIGNAL_INTERVAL_MS - (Date.now() - sig.lastFlush));
    sig.timer = setTimeout(() => {
      sig.timer = null;
      if (!sig.dirty) return;
      sig.dirty = false;
      sig.lastFlush = Date.now();
      sig.version.update((v) => v + 1);
      sig.status.set(this.core.status(key) ?? { ...EMPTY_STATUS, state: this.core.state });
    }, wait);
  }

  private async connect(protocol: MdProtocol): Promise<MdConnection | null> {
    if (!this.auth.isAuthenticated()) return null;
    const base = this.runtime.apiBaseUrl.replace(/\/$/, '');
    const plan = await hubConnectPlan(this.auth, `${base}/api/hubs/marketdata`);
    if (!plan) return null;
    let builder = new HubConnectionBuilder().withUrl(plan.url, plan.options);
    if (protocol === 'messagepack') builder = builder.withHubProtocol(new MessagePackHubProtocol());
    if (plan.autoReconnect)
      builder = builder.withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => backoffMs(ctx.previousRetryCount),
      });
    const connection = builder.configureLogging(LogLevel.Warning).build();
    await connection.start();
    return connection;
  }
}
