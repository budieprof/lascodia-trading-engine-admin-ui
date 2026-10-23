import { DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService } from '@core/realtime/marketdata-stream.service';
import { sourceKinds, sourceLabel, type MdSource } from '@core/realtime/marketdata.types';
import { createWebGlHeatSurface } from './gl/heat-gl';
import type { StreamHeatSource } from './heatmap-primitive';
import { StreamHeatmap, streamHeatFits, streamWindowFor } from './stream-heatmap';
import { TradeFeed } from './trade-bubbles';
import type { TradeBubblesModel } from './trade-bubbles-primitive';
import type { Bar } from '../datafeed/candle-feed.service';
import { resolutionMs, type TvResolution } from '../datafeed/resolution';
import { formatUtcShort, shortInstance } from './canvas-text';
import { ChartFlowService } from './chart-flow.service';
import { joinFills, type FillMark } from './fills';
import type { FootprintBar, FootprintLayerModel } from './footprint-primitive';
import {
  clipHeatGrid,
  depthHalfSpan,
  buildHeatGrid,
  foldLiveSnapshot,
  formatBucket,
  heatNeedsFetch,
  heatWindowFor,
  type HeatGrid,
  type HeatWindow,
} from './heatmap-grid';
import { LiveDepthService, type LiveDepth } from './live-depth.service';
import type { FlowPaneModel, OrderFlowModel } from './orderflow-layers';
import type {
  FootprintRowDto,
  OrderFlowSettings,
  OrderFlowView,
  TickBarDto,
  TickBarsDto,
} from './orderflow.types';
import { utcMs } from '../panels/fx-fundamentals';
import {
  FOOTPRINT_MIN_BAR_PX,
  MAX_FLOW_BARS,
  MAX_FOOTPRINT_BARS,
  flowIndexes,
  footprintAllowed,
  footprintCells,
  footprintRowPoints,
  formatRowSize,
  medianBarRange,
  liquidityPulled,
  tickBarsRequest,
  barEnd,
} from './tick-flow';
import { entitlementRefusalMessage } from '@core/market-data/entitlement-refusal';

/** Styles whose bars are built from price, not time: no time-keyed flow can be laid on them. */
export const PRICE_BASED_STYLES: ReadonlySet<string> = new Set([
  'renko',
  'kagi',
  'pnf',
  'line-break',
  'range',
]);

/** What the feed reads of the page. */
export interface OrderFlowFeedDeps {
  settings: () => OrderFlowSettings;
  symbol: () => string;
  resolution: () => string;
  /** The bars the chart plots (Bar Replay's view in replay), UTC opens ascending. */
  bars: () => readonly Bar[];
  /** The chart style (price-based styles get no flow). */
  style: () => string;
  /** What the chart shows (the host's `orderFlowLayers.view()`). */
  view: () => OrderFlowView | null;
  /** The header's account scope (fills are drawn for these accounts only) and its stable key. */
  accountIds: () => readonly number[];
  accountKey: () => string;
  /** Bar Replay's head instant (UTC ms), null when live: nothing after it is fetched or drawn. */
  replayClip: () => number | null;
  /** Digits and pip of the symbol. */
  precision: () => number;
  pipSize: () => number;
  /** Server time (UTC ms). */
  now: () => number;
  /** Whether the event-level WebGL heatmap can run here (default: a WebGL2 context can be made). */
  gpu?: () => boolean;
  /**
   * Tick replay: the footprint rows of [from, to] from the recorded ticks (the bar forming at the head follows the
   * head exactly); null outside tick replay.
   */
  tickFootprint?: (fromUtc: number, toUtc: number) => FootprintRowDto[] | null;
}

let gpuProbe: boolean | null = null;
/** Whether this browser can run the WebGL2 heatmap (probed once). */
export function webGlHeatAvailable(): boolean {
  if (gpuProbe === null) {
    const s = createWebGlHeatSurface();
    gpuProbe = s !== null;
    s?.dispose();
  }
  return gpuProbe;
}

/** How the heatmap is drawn now: off, bucketed C1 snapshots (canvas 2D), or every book event (WebGL). */
export type HeatMode = 'none' | 'grid' | 'stream';

type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

/** What a flow (C2) answer was asked for. */
interface FlowFetched {
  symbol: string;
  resolution: string;
  /** UTC opens of the first and last bar asked about, and the exclusive end of the last. */
  fromUtc: number;
  toUtc: number;
  endUtc: number;
  /** The newest bar the chart held then. */
  lastBarUtc: number;
  rowPoints?: number;
}

/** The newest-first refresh while the live edge is on screen (ticks keep arriving). */
const LIVE_FLOW_REFRESH_MS = 30_000;
const LIVE_FILLS_REFRESH_MS = 60_000;
const DEBOUNCE_MS = 300;
/** A drawn depth band thinner than this (px) gets the "clearer on 15m and below" hint. */
const MIN_BAND_PX = 4;
/** A debounce never holds a fetch back longer than this (replay playing steps faster than the debounce). */
const MAX_DEBOUNCE_MS = 1_500;

function errorText(e: unknown): string {
  // Not entitled (engine C6, `-403-entitlement`): the engine's reason names the feed — a state, not a fault.
  const notEntitled = entitlementRefusalMessage(e);
  if (notEntitled) return `not entitled. ${notEntitled}`;
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : 'the engine did not answer';
}

/**
 * The page side of the order-flow layers: fetches what the visible window needs (C1 heatmap, C2 tick flow and
 * footprint, C3 fills), keeps the live book folded into the heatmap while the right edge is on screen, holds every
 * layer at the Bar Replay head, and builds the {@link OrderFlowModel} the chart host draws — including the notes that
 * say what each layer is built from and where its data stops.
 *
 * Construct in an injection context (a component field initializer).
 */
export class OrderFlowFeed {
  private readonly api = inject(ChartFlowService);
  private readonly liveDepth = inject(LiveDepthService);
  private readonly auth = inject(AuthService);
  private readonly mdApi = inject(MarketDataApiService);
  private readonly mdStream = inject(MarketDataStreamService);

  /** The market-data sources the caller is entitled to (C7), once a layer that uses them is on; null before. */
  readonly mdSources = signal<MdSource[] | null>(null);
  private sourcesAsked = false;
  /** Bumped when the stream layers' STATE changes (loading / ready / error / source) — not per frame. */
  private readonly streamState = signal(0);
  private streamStateKey = '';
  private readonly redrawListeners = new Set<() => void>();
  private readonly streamHeat = new StreamHeatmap({
    history: (r) => this.mdApi.history(r),
    watch: (spec) => this.mdStream.watch(spec),
    now: () => this.deps.now(),
    point: () => this.point(),
    changed: () => this.streamChanged(),
  });
  private readonly tradeFeed = new TradeFeed({
    history: (r) => this.mdApi.history(r),
    watch: (spec) => this.mdStream.watch(spec),
    now: () => this.deps.now(),
    changed: () => this.streamChanged(),
  });
  /** The event-level heatmap as the primitive pulls it. */
  private readonly streamSource: StreamHeatSource = {
    layer: () => this.streamHeat.layer(),
    label: 'Broker DOM',
  };

  private readonly heat = signal<{ window: HeatWindow; grid: HeatGrid } | null>(null);
  private readonly heatState = signal<LoadState>({ kind: 'idle' });
  /** The oldest snapshot the engine holds, per symbol, from its last answer. */
  private readonly oldestBySymbol = new Map<string, number | null>();
  private readonly flow = signal<{ span: FlowFetched; data: TickBarsDto } | null>(null);
  private readonly flowState = signal<LoadState>({ kind: 'idle' });
  private readonly foot = signal<{ span: FlowFetched; data: TickBarsDto } | null>(null);
  private readonly footState = signal<LoadState>({ kind: 'idle' });
  private readonly fillsData = signal<{
    key: string;
    fromUtc: number;
    toUtc: number;
    fills: FillMark[];
    hidden: number;
    truncated: boolean;
  } | null>(null);
  private readonly fillsState = signal<LoadState>({ kind: 'idle' });
  private readonly live = signal<LiveDepth | null>(null);
  private readonly seq = { heat: 0, flow: 0, foot: 0, fills: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstScheduled = 0;
  private lastFlowAt = 0;
  private lastFillsAt = 0;

  constructor(private readonly deps: OrderFlowFeedDeps) {
    // Anything the fetches depend on: refetch what no longer covers the view (debounced).
    effect(() => {
      const s = deps.settings();
      deps.symbol();
      deps.resolution();
      deps.view();
      deps.replayClip();
      deps.accountKey();
      deps.style();
      this.barsKey();
      if (!s.heatmap && !s.cvd && !s.ribbon && !s.footprint && !s.fills) return;
      untracked(() => this.schedule());
    });

    // The market-data sources, once a layer that names one is on.
    effect(() => {
      const s = deps.settings();
      if (!(s.heatmap || s.trades) || this.sourcesAsked) return;
      this.sourcesAsked = true;
      untracked(() =>
        this.mdApi.sources().then(
          (list) => this.mdSources.set(list),
          () => this.mdSources.set([]),
        ),
      );
    });

    // A new symbol or source: the stream layers start over (an error for the old one must not stick). Declared before
    // the effects that fetch, so on a change it runs first.
    let seriesKey: string | null = null;
    effect(() => {
      const key = `${deps.symbol()}|${deps.settings().sourceId ?? ''}`;
      untracked(() => {
        const first = seriesKey === null;
        seriesKey = key;
        if (first) return;
        this.streamHeat.clear();
        this.tradeFeed.clear();
        this.streamStateKey = '';
        this.streamState.update((v) => v + 1);
      });
    });

    // The event-level heatmap and the trade layer follow the view and the replay head at once (no debounce — the
    // tick replay moves the head every frame; a move inside the held window only advances the fold).
    effect(() => {
      const mode = this.heatMode();
      const view = deps.view();
      const clip = deps.replayClip();
      const symbol = deps.symbol();
      const sourceId = deps.settings().sourceId;
      untracked(() => {
        if (mode !== 'stream' || !view || !symbol) {
          if (mode !== 'stream') this.streamHeat.clear();
          return;
        }
        this.streamHeat.update({
          symbol,
          sourceId,
          view: this.streamView(view),
          head: clip,
          live: view.rightEdgeInView,
        });
      });
    });
    effect(() => {
      const s = deps.settings();
      const view = deps.view();
      const clip = deps.replayClip();
      const symbol = deps.symbol();
      const src = this.tradeSource();
      untracked(() => {
        if (!s.trades || !view || !symbol || !src) {
          this.tradeFeed.clear();
          return;
        }
        const w = streamWindowFor(this.streamView(view), clip ?? deps.now());
        if (!w) return;
        this.tradeFeed.update({
          symbol,
          sourceId: src.sourceId,
          fromUtc: w.fromUtc,
          toUtc: w.toUtc,
          head: clip,
          live: view.rightEdgeInView,
        });
      });
    });
    // The live book: one shared 1.5 s poll, only while the BUCKETED heatmap is on, the newest bar is on screen and not
    // in replay (the event-level layer has its own stream). A boolean, so a pan that keeps the right edge in view does
    // not drop and re-open the poll.
    const wantLive = computed(
      () =>
        this.heatMode() === 'grid' &&
        deps.view()?.rightEdgeInView === true &&
        deps.replayClip() === null,
    );
    effect((onCleanup) => {
      const want = wantLive();
      const symbol = deps.symbol();
      if (!want || !symbol) return;
      const watch = this.liveDepth.watch(symbol);
      untracked(() => this.live.set(watch));
      onCleanup(() => {
        watch.release();
        if (untracked(() => this.live()) === watch) this.live.set(null);
      });
    });
    effect(() => {
      const snap = this.live()?.snapshot();
      if (!snap) return;
      untracked(() => {
        const h = this.heat();
        if (!h || this.deps.replayClip() !== null) return;
        const grid = foldLiveSnapshot(h.grid, snap);
        if (grid !== h.grid) this.heat.set({ window: h.window, grid });
      });
    });

    // At the live edge the newest bar keeps filling with ticks: re-read the flow now and then.
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const v = this.deps.view();
      if (!v?.rightEdgeInView || this.deps.replayClip() !== null) return;
      const s = this.deps.settings();
      const now = Date.now();
      const flowDue =
        (s.cvd || s.ribbon || s.footprint) && now - this.lastFlowAt >= LIVE_FLOW_REFRESH_MS;
      const fillsDue = s.fills && now - this.lastFillsAt >= LIVE_FILLS_REFRESH_MS;
      if (flowDue || fillsDue) this.refresh({ flow: flowDue, fills: fillsDue });
    }, 5_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearTimeout(this.timer);
      this.streamHeat.dispose();
      this.tradeFeed.clear();
      this.redrawListeners.clear();
      this.seq.heat++;
      this.seq.flow++;
      this.seq.foot++;
      this.seq.fills++;
    });
  }

  /** The bars' extent: a new bar or more history changes it, a tick inside the forming bar does not. */
  private readonly barsKey = computed(() => {
    const bars = this.deps.bars();
    return `${bars.length}|${bars[0]?.time}|${bars.at(-1)?.time}`;
  });

  /** How the heatmap is drawn for this view (see {@link HeatMode}). */
  readonly heatMode = computed<HeatMode>(() => {
    const s = this.deps.settings();
    const v = this.deps.view();
    if (!s.heatmap) return 'none';
    if (!v || !(this.deps.gpu ?? webGlHeatAvailable)()) return 'grid';
    this.streamState();
    const cap = this.deps.replayClip() ?? this.deps.now();
    if (!streamHeatFits(this.streamView(v, cap))) return 'grid';
    // No event-level book for this symbol / window (none stored, not entitled): the bucketed snapshots instead.
    if (this.streamHeat.state.kind === 'error') return 'grid';
    return 'stream';
  });

  /** The view as the stream layers read it: at the live edge it reaches now (or the head). */
  private streamView(v: OrderFlowView, cap = this.deps.replayClip() ?? this.deps.now()) {
    return {
      fromUtc: v.fromUtc,
      toUtc: v.rightEdgeInView ? Math.max(v.toUtc, cap) : v.toUtc,
      widthPx: v.widthPx,
      pricePerPx: v.pricePerPx,
    };
  }

  /** The source the trade layer reads: the picked one when it publishes trades, else the first that does. */
  readonly tradeSource = computed<MdSource | null>(() => {
    const list = this.mdSources() ?? [];
    const withTrades = list.filter((s) => sourceKinds(s).includes('trades'));
    const picked = this.deps.settings().sourceId;
    return withTrades.find((s) => s.sourceId === picked) ?? withTrades[0] ?? null;
  });

  /** A stream layer changed: redraw now; re-derive the captions only when its state changed. */
  private streamChanged(): void {
    for (const l of this.redrawListeners) l();
    const h = this.streamHeat.state;
    const t = this.tradeFeed.state;
    const key = `${h.kind}|${h.kind === 'error' ? h.message : ''}|${this.streamHeat.sourceId()}|${this.streamHeat.note()}|${t.kind}|${t.kind === 'error' ? t.message : ''}`;
    if (key !== this.streamStateKey) {
      this.streamStateKey = key;
      this.streamState.update((v) => v + 1);
    }
  }

  private readonly redrawSub = (fn: () => void) => this.subscribeRedraw(fn);

  /** Register a redraw callback (the chart's layers: stream data advanced). Returns the unsubscribe. */
  subscribeRedraw(fn: () => void): () => void {
    this.redrawListeners.add(fn);
    return () => this.redrawListeners.delete(fn);
  }

  /** Whether the fills layer can be read with this session's permissions. */
  readonly canReadFills = computed(() => this.auth.hasPermission(Permission.AccessOperator));

  private schedule(): void {
    const now = Date.now();
    if (this.timer !== undefined && now - this.firstScheduled < MAX_DEBOUNCE_MS) {
      clearTimeout(this.timer);
    } else if (this.timer === undefined) {
      this.firstScheduled = now;
    } else {
      return; // held long enough: let the pending one fire
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh({});
    }, DEBOUNCE_MS);
  }

  /** The bars to ask about: in replay, none that opens at or after the head. */
  private barsNow(): readonly Bar[] {
    const bars = this.deps.bars();
    const clip = this.deps.replayClip();
    if (clip === null || !bars.length || bars[bars.length - 1].time < clip) return bars;
    let n = bars.length;
    while (n > 0 && bars[n - 1].time >= clip) n--;
    return bars.slice(0, n);
  }

  /** The newest-bar cap of every fetch: the replay head, else now. */
  private cap(): number {
    return this.deps.replayClip() ?? this.deps.now();
  }

  private point(): number {
    return 10 ** -Math.max(0, Math.trunc(this.deps.precision()));
  }

  /** Fetch what the view needs and what is held does not cover; `force` re-reads a layer even when covered. */
  private refresh(force: { flow?: boolean; fills?: boolean }): void {
    const s = this.deps.settings();
    const view = this.deps.view();
    const symbol = this.deps.symbol();
    if (!view || !symbol) return;
    const priceBased = PRICE_BASED_STYLES.has(this.deps.style());
    if (s.heatmap && this.heatMode() === 'grid') this.refreshHeat(symbol, view);
    if ((s.cvd || s.ribbon) && !priceBased) this.refreshFlow(symbol, view, force.flow === true);
    if (s.footprint && !priceBased) this.refreshFootprint(symbol, view, force.flow === true);
    if (s.fills && this.canReadFills()) this.refreshFills(symbol, view, force.fills === true);
  }

  // ── OF-1 heatmap ─────────────────────────────────────────────────────────

  private refreshHeat(symbol: string, view: OrderFlowView): void {
    const oldest = this.oldestBySymbol.get(symbol.toUpperCase()) ?? null;
    const span = {
      fromUtc: view.fromUtc,
      toUtc: Math.max(view.toUtc, view.fromUtc + 60_000),
      widthPx: view.widthPx,
    };
    const cap = this.cap();
    const wanted = heatWindowFor(
      symbol,
      view.rightEdgeInView ? { ...span, toUtc: cap } : span,
      cap,
      oldest,
    );
    const held = this.heat();
    if (!heatNeedsFetch(held?.grid.symbol === symbol ? held.window : null, wanted) || !wanted)
      return;
    const n = ++this.seq.heat;
    this.heatState.set({ kind: 'loading' });
    this.api.heatmap(symbol, wanted.fromUtc, wanted.toUtc, wanted.buckets).then(
      (dto) => {
        if (n !== this.seq.heat) return;
        const grid = buildHeatGrid(dto, this.point());
        this.oldestBySymbol.set(symbol.toUpperCase(), grid.oldestAvailableUtc);
        this.heat.set({ window: wanted, grid });
        this.heatState.set({ kind: 'idle' });
      },
      (e) => {
        if (n !== this.seq.heat) return;
        this.heatState.set({ kind: 'error', message: errorText(e) });
      },
    );
  }

  // ── OF-2 / OF-4 tick flow ────────────────────────────────────────────────

  /** Whether a held flow answer still covers the view (same series, both visible ends, the newest bar). */
  private covers(
    held: FlowFetched | null,
    view: OrderFlowView,
    bars: readonly Bar[],
    symbol: string,
  ): boolean {
    if (!held || held.symbol !== symbol || held.resolution !== this.deps.resolution()) return false;
    if (view.fromUtc < held.fromUtc || view.toUtc > held.toUtc) return false;
    if (view.rightEdgeInView && held.lastBarUtc !== bars.at(-1)?.time) return false;
    const clip = this.deps.replayClip();
    // In replay an answer that reaches past the head would show ticks from the future.
    return clip === null || held.endUtc <= clip;
  }

  private refreshFlow(symbol: string, view: OrderFlowView, force: boolean): void {
    const bars = this.barsNow();
    if (!force && this.covers(this.flow()?.span ?? null, view, bars, symbol)) return;
    const idx = flowIndexes(view, bars.length, MAX_FLOW_BARS);
    if (!idx) return;
    const barMs = resolutionMs(this.deps.resolution() as TvResolution);
    const cap = this.cap();
    const req = tickBarsRequest(symbol, bars, idx, barMs, cap, null);
    if (!req) return;
    const span: FlowFetched = {
      symbol,
      resolution: this.deps.resolution(),
      fromUtc: bars[idx.from].time,
      toUtc: bars[idx.to].time,
      endUtc: barEnd(bars, idx.to, barMs, cap),
      lastBarUtc: bars.at(-1)!.time,
    };
    const n = ++this.seq.flow;
    this.lastFlowAt = Date.now();
    this.flowState.set({ kind: 'loading' });
    this.api.tickBars(req).then(
      (data) => {
        if (n !== this.seq.flow) return;
        this.flow.set({ span, data });
        this.flowState.set({ kind: 'idle' });
      },
      (e) => {
        if (n !== this.seq.flow) return;
        this.flowState.set({ kind: 'error', message: errorText(e) });
      },
    );
  }

  // ── OF-3 footprint ───────────────────────────────────────────────────────

  /** The footprint's bars for the view: the visible ones ± half again, when wide enough and inside the C2 limits. */
  private footprintSpan(
    view: OrderFlowView,
    bars: readonly Bar[],
  ): { from: number; to: number; endUtc: number; allowed: boolean } | null {
    if (bars.length === 0) return null;
    const visible = view.toIndex - view.fromIndex + 1;
    const from = Math.max(0, view.fromIndex - Math.ceil(visible / 2));
    const to = Math.min(bars.length - 1, view.toIndex + Math.ceil(visible / 2));
    const barMs = resolutionMs(this.deps.resolution() as TvResolution);
    const endUtc = barEnd(bars, to, barMs, this.cap());
    const count = to - from + 1;
    return {
      from,
      to,
      endUtc,
      allowed: count <= MAX_FOOTPRINT_BARS && footprintAllowed(count, bars[from].time, endUtc),
    };
  }

  /**
   * The footprint's row size: the operator's, or adaptive — about ten rows across the median visible bar, the held
   * size kept while it still gives 6–16 (a small zoom or pan re-asks nothing).
   */
  private rowPointsFor(
    view: OrderFlowView,
    bars: readonly Bar[],
    held: FlowFetched | null,
  ): number {
    const manual = this.deps.settings().footprintRowPoints;
    if (manual !== null) return manual;
    const sameSeries =
      held?.symbol === this.deps.symbol() && held?.resolution === this.deps.resolution();
    return footprintRowPoints(
      medianBarRange(bars, view.fromIndex, view.toIndex),
      this.point(),
      sameSeries ? (held?.rowPoints ?? null) : null,
    );
  }

  private refreshFootprint(symbol: string, view: OrderFlowView, force: boolean): void {
    if (view.barSpacing < FOOTPRINT_MIN_BAR_PX) return;
    const bars = this.barsNow();
    const span = this.footprintSpan(view, bars);
    if (!span?.allowed) return;
    const held = this.foot()?.span ?? null;
    const rowPoints = this.rowPointsFor(view, bars, held);
    if (!force && held?.rowPoints === rowPoints && this.covers(held, view, bars, symbol)) return;
    const barMs = resolutionMs(this.deps.resolution() as TvResolution);
    const req = tickBarsRequest(symbol, bars, span, barMs, this.cap(), { rowPoints });
    if (!req) return;
    const fetched: FlowFetched = {
      symbol,
      resolution: this.deps.resolution(),
      fromUtc: bars[span.from].time,
      toUtc: bars[span.to].time,
      endUtc: span.endUtc,
      lastBarUtc: bars.at(-1)!.time,
      rowPoints,
    };
    const n = ++this.seq.foot;
    this.footState.set({ kind: 'loading' });
    this.api.tickBars(req).then(
      (data) => {
        if (n !== this.seq.foot) return;
        this.foot.set({ span: fetched, data });
        this.footState.set({ kind: 'idle' });
      },
      (e) => {
        if (n !== this.seq.foot) return;
        this.footState.set({ kind: 'error', message: errorText(e) });
      },
    );
  }

  // ── OF-6 fills ───────────────────────────────────────────────────────────

  private refreshFills(symbol: string, view: OrderFlowView, force: boolean): void {
    const key = `${symbol}|${this.deps.accountKey()}`;
    const held = this.fillsData();
    const cap = this.cap();
    const toUtc = view.rightEdgeInView
      ? cap
      : Math.min(cap, view.toUtc + (view.toUtc - view.fromUtc) * 0.25);
    if (!force && held?.key === key && view.fromUtc >= held.fromUtc && toUtc <= held.toUtc + 60_000)
      return;
    const fromUtc = view.fromUtc - (view.toUtc - view.fromUtc) * 0.25;
    const accountIds = [...this.deps.accountIds()];
    const pip = this.deps.pipSize();
    const point = this.point();
    const n = ++this.seq.fills;
    this.lastFillsAt = Date.now();
    this.fillsState.set({ kind: 'loading' });
    this.api.fills(symbol, fromUtc, toUtc, accountIds).then(
      (r) => {
        if (n !== this.seq.fills) return;
        const joined = joinFills(r.logs, r.orders, symbol, fromUtc, toUtc, pip, point);
        this.fillsData.set({ key, fromUtc, toUtc, ...joined, truncated: r.truncated });
        this.fillsState.set({ kind: 'idle' });
      },
      (e) => {
        if (n !== this.seq.fills) return;
        this.fillsState.set({ kind: 'error', message: errorText(e) });
      },
    );
  }

  // ── The model ───────────────────────────────────────────────────────────

  /** The flow answer for this series, cut at the replay head (null when it reaches past it). */
  private readonly flowBars = computed<{
    bars: TickBarDto[];
    coverage: number | null;
    fromUtc: number;
  } | null>(
    () => {
      const f = this.flow();
      const symbol = this.deps.symbol();
      if (!f || f.span.symbol !== symbol || f.span.resolution !== this.deps.resolution())
        return null;
      const clip = this.deps.replayClip();
      if (clip !== null && f.span.endUtc > clip) return null;
      const coverage = f.data.tickCoverageFromUtc ? utcMs(f.data.tickCoverageFromUtc) : NaN;
      return {
        bars: f.data.bars,
        coverage: Number.isFinite(coverage) ? coverage : null,
        fromUtc: f.span.fromUtc,
      };
    },
    // The same answer stays the same value while the replay head moves, so the panes are not rewritten per step.
    { equal: (a, b) => a === b || (a !== null && b !== null && a.bars === b.bars) },
  );

  /** The ribbon's "liquidity pulled" flags, once per answer. */
  private readonly pulled = computed(() => {
    const f = this.flowBars();
    return f ? liquidityPulled(f.bars) : [];
  });

  private stateNote(state: LoadState, what: string): string | null {
    if (state.kind === 'loading') return `${what}: loading…`;
    if (state.kind === 'error') return `${what} unavailable — ${state.message}`;
    return null;
  }

  /** The label of a source id (its registry display name), else the id. */
  private labelOf(sourceId: string | null): string {
    if (!sourceId) return 'broker';
    const src = this.mdSources()?.find((s) => s.sourceId === sourceId);
    return src ? sourceLabel(src) : sourceId;
  }

  private streamCaptions(): { model: OrderFlowModel['heatmap']; lines: string[] } {
    this.streamState();
    const st = this.streamHeat.state;
    const sourceId = this.streamHeat.sourceId();
    if (st.kind === 'loading' && !sourceId)
      return { model: null, lines: ['Broker DOM depth: loading every book event…'] };
    if (st.kind === 'idle' && !sourceId)
      return { model: null, lines: ['Broker DOM depth: waiting for the chart'] };
    const src = this.mdSources()?.find((s) => s.sourceId === sourceId) ?? null;
    const kind = src?.kind === 'CmeFutures' ? 'CME' : src?.kind === 'FixVenue' ? 'Venue' : 'Broker';
    this.streamSource.label = `${this.labelOf(sourceId)} ${kind === 'Broker' ? 'DOM' : 'book'}`;
    const live =
      this.deps.replayClip() === null && this.deps.view()?.rightEdgeInView ? ' · live' : '';
    const lines = [
      `${kind} depth — ${this.labelOf(sourceId)}, every book event (event-level, WebGL)${live}${st.kind === 'loading' ? ' · loading…' : ''}`,
      `Sizes as the source reports them${src?.sizeUnit ? ` (registered unit: ${src.sizeUnit})` : ''}; book history is kept 90 days`,
    ];
    const note = this.streamHeat.note();
    if (note) lines.push(note);
    return {
      model: { stream: this.streamSource, opacity: this.deps.settings().heatmapOpacity },
      lines,
    };
  }

  private tradeLayer(): { model: TradeBubblesModel | null; lines: string[] } {
    this.streamState();
    const symbol = this.deps.symbol();
    if (this.mdSources() === null) return { model: null, lines: ['Trades: loading sources…'] };
    const src = this.tradeSource();
    if (!src)
      return {
        model: null,
        lines: [
          `Trades: no source you are entitled to publishes trades for ${symbol} (spot FX brokers have no tape; CME / venue feeds do)`,
        ],
      };
    const v = this.deps.view();
    if (v && !streamHeatFits(this.streamView(v)))
      return { model: null, lines: ['Trades: zoom in to 2 h or less to see each trade'] };
    const st = this.tradeFeed.state;
    if (st.kind === 'error') return { model: null, lines: [`Trades unavailable — ${st.message}`] };
    const min = this.deps.settings().tradeMinSize;
    const lines = [
      `Trades — ${sourceLabel(src)}, each print: size = area, green buyer- / red seller-initiated${min > 0 ? `, ≥ ${min}` : ''}${st.kind === 'loading' ? ' · loading…' : ''}`,
    ];
    return {
      model: {
        feed: this.tradeFeed,
        label: sourceLabel(src),
        minSize: min,
        clipUtc: this.deps.replayClip(),
      },
      lines,
    };
  }

  private heatCaptions(view: OrderFlowView | null): {
    model: OrderFlowModel['heatmap'];
    lines: string[];
  } {
    if (this.heatMode() === 'stream') return this.streamCaptions();
    const symbol = this.deps.symbol();
    const lines: string[] = [];
    const h = this.heat();
    const note = this.stateNote(this.heatState(), 'Broker DOM depth');
    if (!h || h.grid.symbol !== symbol) {
      lines.push(note ?? 'Broker DOM depth: waiting for the chart');
      return { model: null, lines };
    }
    if (h.grid.oldestAvailableUtc === null) {
      lines.push(`Broker DOM depth — none stored for ${symbol} (no EA streams its book)`);
      return { model: null, lines };
    }
    const grid = clipHeatGrid(h.grid, this.deps.replayClip());
    const sources = grid.sources.map(shortInstance).join(', ') || 'no reporting EA';
    const live = this.live() !== null && this.deps.replayClip() === null ? ' · live' : '';
    lines.push(
      `Broker DOM depth — ${sources}, sampled every ${formatBucket(grid.bucketMs)}${live}`,
    );
    if (grid.oldestAvailableUtc !== null && view && view.fromUtc < grid.oldestAvailableUtc)
      lines.push(
        `Depth history starts ${formatUtcShort(grid.oldestAvailableUtc)} (order books are kept 7 days)`,
      );
    if (grid.columns.length === 0) lines.push('No broker depth captured in this window');
    else if (view?.pricePerPx) {
      // A broker DOM is often ~10 levels, about a pip each side: on 1h that is a few px under the candles.
      const halfSpan = depthHalfSpan(grid);
      if (halfSpan > 0 && (2 * halfSpan) / view.pricePerPx < MIN_BAND_PX) {
        const pips = halfSpan / this.deps.pipSize();
        lines.push(
          `Broker depth spans only ±${pips < 10 ? pips.toFixed(1) : Math.round(pips)} pips — clearer on 15m and below`,
        );
      }
    }
    if (note && this.heatState().kind === 'error') lines.push(note);
    return { model: { grid, opacity: this.deps.settings().heatmapOpacity }, lines };
  }

  private footprintModel(view: OrderFlowView | null): {
    model: FootprintLayerModel | null;
    lines: string[];
  } {
    if (!view) return { model: null, lines: [] };
    if (view.barSpacing < FOOTPRINT_MIN_BAR_PX)
      return { model: null, lines: ['Zoom in to see the footprint'] };
    const bars = this.barsNow();
    const span = this.footprintSpan(view, bars);
    if (span && !span.allowed)
      return {
        model: null,
        lines: [
          'Footprint needs a window of 3 days and 500 bars at most — use a shorter timeframe',
        ],
      };
    const f = this.foot();
    const symbol = this.deps.symbol();
    const clip = this.deps.replayClip();
    const note = this.stateNote(this.footState(), 'Footprint');
    if (
      !f ||
      f.span.symbol !== symbol ||
      f.span.resolution !== this.deps.resolution() ||
      (clip !== null && f.span.endUtc > clip)
    )
      return { model: null, lines: note ? [note] : [] };
    const rowPrice = (f.span.rowPoints ?? 10) * this.point();
    const out: FootprintBar[] = [];
    let candleOnly = 0;
    f.data.bars.forEach((b, i) => {
      if (b.source !== 'ticks' || !b.footprint?.length) {
        if (b.source !== 'ticks') candleOnly++;
        return;
      }
      const t = utcMs(b.t);
      const next = f.data.bars[i + 1];
      const end = next ? utcMs(next.t) : f.span.endUtc;
      out.push({ t, end, cells: footprintCells(b.footprint, rowPrice) });
    });
    // Tick replay: the bar forming at the head, from the recorded ticks up to the head (C2 answers stop before it).
    const clipNow = this.deps.replayClip();
    const forming = bars.at(-1);
    if (this.deps.tickFootprint && clipNow !== null && forming && forming.time <= clipNow) {
      const rowsNow = this.deps.tickFootprint(forming.time, clipNow);
      if (rowsNow) {
        const at = out.findIndex((b) => b.t === forming.time);
        const fb: FootprintBar = {
          t: forming.time,
          end: Math.max(clipNow, forming.time + 1),
          cells: footprintCells(rowsNow, rowPrice),
        };
        if (at >= 0) out[at] = fb;
        else out.push(fb);
      }
    }
    const rows = formatRowSize(f.span.rowPoints ?? 10, this.point(), this.deps.pipSize());
    const mode = this.deps.settings().footprintRowPoints === null ? ' (auto)' : '';
    const lines = [
      `Footprint — tick counts (down × up, tick rule on broker quotes), rows of ${rows}${mode}; shaded: 3:1 diagonal imbalance`,
    ];
    if (candleOnly > 0)
      lines.push(
        `${candleOnly} bar${candleOnly === 1 ? '' : 's'} without retained ticks: no footprint`,
      );
    if (note && this.footState().kind === 'error') lines.push(note);
    return { model: { bars: out, rowPrice }, lines };
  }

  private flowPane(kind: 'cvd' | 'ribbon'): FlowPaneModel {
    if (PRICE_BASED_STYLES.has(this.deps.style()))
      return {
        bars: [],
        notes: ['not available on price-based styles (Renko, Kagi, P&F, Line break, Range)'],
      };
    const f = this.flowBars();
    const note = this.stateNote(this.flowState(), 'tick flow');
    const notes: string[] = [];
    if (!f) return { bars: [], notes: note ? [note] : ['waiting for the chart'] };
    if (f.coverage === null) notes.push('no ticks retained for this symbol');
    else if (f.fromUtc < f.coverage)
      notes.push(
        kind === 'cvd'
          ? `no ticks before ${formatUtcShort(f.coverage)} (ticks are kept 14 days)`
          : `ticks from ${formatUtcShort(f.coverage)} (kept 14 days); older bars: candle spread only`,
      );
    if (kind === 'ribbon') notes.push('● liquidity pulled: spread ≥ 2× median while ticks spike');
    if (note && this.flowState().kind === 'error') notes.push(note);
    return kind === 'ribbon'
      ? { bars: f.bars, pulled: this.pulled(), notes }
      : { bars: f.bars, notes };
  }

  /** The panes' models, recomputed only when their answer or load state changes — not on a pan. */
  private readonly cvdPane = computed(() => this.flowPane('cvd'));
  private readonly ribbonPane = computed(() => this.flowPane('ribbon'));

  private fillsLayer(): { fills: FillMark[]; lines: string[] } {
    if (!this.canReadFills())
      return {
        fills: [],
        lines: ['Fills & slippage need the operator permission (execution quality log)'],
      };
    const symbol = this.deps.symbol();
    const d = this.fillsData();
    const note = this.stateNote(this.fillsState(), 'Fills & slippage');
    if (!d || d.key !== `${symbol}|${this.deps.accountKey()}`)
      return { fills: [], lines: note ? [note] : [] };
    if (this.deps.accountIds().length === 0)
      return { fills: [], lines: ['Fills & slippage: no account selected in the header'] };
    const clip = this.deps.replayClip();
    const fills = clip === null ? d.fills : d.fills.filter((f) => f.time <= clip);
    const parts = [
      `Fills & slippage — ${fills.length} fill${fills.length === 1 ? '' : 's'} (execution quality log, accounts in scope)`,
    ];
    if (d.hidden > 0) parts.push(`${d.hidden} of other accounts hidden`);
    if (d.truncated) parts.push('newest 200 only');
    const lines = [parts.join(' · ')];
    if (note && this.fillsState().kind === 'error') lines.push(note);
    return { fills, lines };
  }

  /** What the chart host draws; null with every order-flow layer off. */
  readonly model = computed<OrderFlowModel | null>(() => {
    const s = this.deps.settings();
    if (!s.heatmap && !s.cvd && !s.ribbon && !s.footprint && !s.fills && !s.trades) return null;
    const view = this.deps.view();
    const captions: string[] = [];
    let trades: TradeBubblesModel | null = null;
    let heatmap: OrderFlowModel['heatmap'] = null;
    let footprint: FootprintLayerModel | null = null;
    let fills: FillMark[] = [];
    if (s.heatmap) {
      const h = this.heatCaptions(view);
      heatmap = h.model;
      captions.push(...h.lines);
    }
    if (s.footprint) {
      if (PRICE_BASED_STYLES.has(this.deps.style()))
        captions.push('Footprint: not available on price-based styles');
      else {
        const f = this.footprintModel(view);
        footprint = f.model;
        captions.push(...f.lines);
      }
    }
    if (s.fills) {
      const f = this.fillsLayer();
      fills = f.fills;
      captions.push(...f.lines);
    }
    if (s.trades) {
      const t = this.tradeLayer();
      trades = t.model;
      captions.push(...t.lines);
    }
    return {
      trades,
      subscribeRedraw: this.redrawSub,
      heatmap,
      footprint,
      fills,
      captions,
      cvd: s.cvd ? this.cvdPane() : null,
      ribbon: s.ribbon ? this.ribbonPane() : null,
    };
  });
}
