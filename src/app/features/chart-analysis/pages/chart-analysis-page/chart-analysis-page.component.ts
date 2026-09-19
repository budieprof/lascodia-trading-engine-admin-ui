import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { CurrencyPairDto } from '@core/api/api.types';
import { CandleFeedService, type Bar } from '../../datafeed/candle-feed.service';
import { SUPPORTED_RESOLUTIONS, resolutionMs, type TvResolution } from '../../datafeed/resolution';
import { priceScaleFor } from '../../datafeed/symbol-info';
import {
  INDICATORS,
  defaultParams,
  indicatorById,
  indicatorLabel,
} from '../../indicators/registry';
import {
  ChartHostComponent,
  type ActiveIndicator,
  type ChartStyle,
  type LegendSnapshot,
} from '../../chart/chart-host.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { PositionsService } from '@core/services/positions.service';
import { EconomicEventsService } from '@core/services/economic-events.service';
import type { EventMark } from '../../overlays/event-marks-renderer';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import type { PriceOverlay } from '../../overlays/overlay-renderer';
import type { ChartMarker } from '../../chart/chart-host.component';
import {
  CHART_TIMEZONES,
  ChartLayoutStore,
  type ChartLayout,
  type StudyTemplate,
} from '../../workspace/layout-store.service';
import {
  TOOLS,
  toolFor,
  type DashStyle,
  type Drawing,
  type DrawingKind,
} from '../../drawings/model';

/** Labels for the timeframe bar, in TradingView's shorthand. */
const RESOLUTION_LABELS: Record<TvResolution, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
};

const CHART_STYLES: Array<{ id: ChartStyle; label: string }> = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'heikin-ashi', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'hlc-bars', label: 'HLC bars' },
  { id: 'line', label: 'Line' },
  { id: 'line-markers', label: 'Line with markers' },
  { id: 'stepline', label: 'Step line' },
  { id: 'area', label: 'Area' },
  { id: 'hlc-area', label: 'HLC area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'column', label: 'Columns' },
  // Price-based: these rebuild the bars rather than re-skinning them.
  { id: 'renko', label: 'Renko' },
  { id: 'line-break', label: 'Line Break' },
  { id: 'kagi', label: 'Kagi' },
  { id: 'pnf', label: 'Point & Figure' },
];

/** How many bars to pull per request / per scroll-back page. */
const PAGE_BARS = 1500;

@Component({
  selector: 'app-chart-analysis-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DecimalPipe, ChartHostComponent],
  templateUrl: './chart-analysis-page.component.html',
  styleUrl: './chart-analysis-page.component.scss',
  host: { '(keydown)': 'onKeydown($event)', tabindex: '0' },
})
export class ChartAnalysisPageComponent {
  private readonly pairs = inject(CurrencyPairsService);
  private readonly feed = inject(CandleFeedService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly host = viewChild<ChartHostComponent>('host');

  readonly resolutions = SUPPORTED_RESOLUTIONS;
  readonly resolutionLabel = (r: TvResolution) => RESOLUTION_LABELS[r] ?? r;
  readonly chartStyles = CHART_STYLES;
  readonly catalogue = INDICATORS;

  readonly symbols = signal<CurrencyPairDto[]>([]);
  readonly symbol = signal<string>('EURUSD');
  readonly resolution = signal<TvResolution>('60');
  readonly style = signal<ChartStyle>('candles');
  readonly showVolume = signal(true);
  readonly bars = signal<Bar[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = signal<ActiveIndicator[]>([]);
  readonly legend = signal<LegendSnapshot | null>(null);
  readonly indicatorMenuOpen = signal(false);
  readonly symbolMenuOpen = signal(false);
  readonly symbolQuery = signal('');

  // ── Drawings ─────────────────────────────────────────────────────────────
  readonly drawings = inject(DrawingStore);
  private readonly positions = inject(PositionsService);
  private readonly signals = inject(TradeSignalsService);

  /** Engine state drawn on the chart: position levels and signal markers. */
  readonly overlays = signal<PriceOverlay[]>([]);
  readonly markers = signal<ChartMarker[]>([]);
  readonly showOverlays = signal(true);

  /** Economic events on the time axis. */
  private readonly economicEvents = inject(EconomicEventsService);
  readonly events = signal<EventMark[]>([]);
  readonly showEvents = signal(true);
  readonly minEventImpact = signal<'High' | 'Medium' | 'Low'>('Medium');

  // ── Watchlist ────────────────────────────────────────────────────────────
  //
  // Prices come from the same throttled `priceUpdated` stream the chart uses,
  // so the panel costs one extra map rather than 23 more polls.
  readonly watchlistOpen = signal(false);
  readonly prices = signal<Record<string, { bid: number; prev: number }>>({});

  readonly watchlist = computed(() => {
    const quotes = this.prices();
    return this.symbols().map((p) => {
      const sym = (p.symbol ?? '').toUpperCase();
      const q = quotes[sym];
      const changePct = q && q.prev !== 0 ? ((q.bid - q.prev) / q.prev) * 100 : null;
      return {
        symbol: sym,
        digits: Math.trunc(p.decimalPlaces) || 5,
        bid: q?.bid ?? null,
        changePct,
      };
    });
  });

  // ── Bar replay ───────────────────────────────────────────────────────────
  //
  // Replay is a pure VIEW over the loaded bars: it truncates the series rather
  // than refetching. Everything downstream — indicators, the legend, drawings —
  // already follows the plotted bars, so they rewind for free and, critically,
  // an indicator cannot accidentally see bars from the future.
  readonly replayActive = signal(false);
  readonly replayIndex = signal(0);
  readonly replayPlaying = signal(false);
  readonly replaySpeed = signal(4);
  private replayTimer: ReturnType<typeof setInterval> | null = null;

  /** What the chart actually plots — the full series, or a replay prefix. */
  readonly displayBars = computed(() => {
    const all = this.bars();
    if (!this.replayActive()) return all;
    return all.slice(0, Math.max(1, Math.min(this.replayIndex(), all.length)));
  });

  readonly replayAtEnd = computed(() => this.replayIndex() >= this.bars().length);
  readonly tools = TOOLS;
  readonly tool = signal<DrawingKind | null>(null);
  readonly magnet = signal(false);
  readonly scaleMode = signal<'normal' | 'log' | 'percent'>('normal');
  readonly objectTreeOpen = signal(false);
  readonly dashOptions: DashStyle[] = ['solid', 'dashed', 'dotted'];

  // ── Workspace: layouts, templates, timezone, chrome ──────────────────────
  readonly layoutStore = inject(ChartLayoutStore);
  readonly timezones = CHART_TIMEZONES;
  readonly timezone = signal<string>('UTC');
  readonly layoutMenuOpen = signal(false);
  readonly contextMenu = signal<{ x: number; y: number } | null>(null);
  readonly isFullscreen = signal(false);

  readonly toolGroups = computed(() => {
    const groups: Array<{ name: string; tools: typeof TOOLS }> = [];
    for (const t of TOOLS) {
      const existing = groups.find((g) => g.name === t.group);
      if (existing) (existing.tools as (typeof TOOLS)[number][]).push(t);
      else groups.push({ name: t.group, tools: [t] as unknown as typeof TOOLS });
    }
    return groups;
  });

  readonly precision = computed(() => {
    const pair = this.symbols().find((p) => p.symbol === this.symbol());
    return pair ? Math.trunc(pair.decimalPlaces) || 5 : 5;
  });

  readonly priceScale = computed(() => priceScaleFor(this.precision()));

  readonly filteredSymbols = computed(() => {
    const q = this.symbolQuery().trim().toUpperCase();
    const all = this.symbols();
    return q ? all.filter((p) => (p.symbol ?? '').toUpperCase().includes(q)) : all;
  });

  /** Legend colour follows the bar's direction, as on TradingView. */
  readonly legendUp = computed(() => {
    const l = this.legend();
    return l?.close != null && l?.open != null ? l.close >= l.open : true;
  });

  constructor() {
    this.loadSymbols();
    // A running replay interval would outlive the page and keep stepping a
    // chart nobody is looking at.
    this.destroyRef.onDestroy(() => this.pauseReplay());

    // Deep link: /chart-analysis/EURUSD?tf=60 so a chart can be linked to from
    // a position or a signal without the operator re-selecting anything.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const s = params.get('symbol');
      if (s) this.symbol.set(s.toUpperCase());
      const tf = this.route.snapshot.queryParamMap.get('tf') as TvResolution | null;
      if (tf && (SUPPORTED_RESOLUTIONS as readonly string[]).includes(tf)) this.resolution.set(tf);
      void this.reload();
    });

    // Live price → update the forming bar. The engine throttles these, so this
    // is a repaint of the last candle rather than a tick stream.
    this.realtime
      .on<{ symbol?: string; bid?: number; ask?: number; price?: number }>('priceUpdated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tick) => {
        this.applyTick(tick);
        this.recordQuote(tick);
      });
  }

  /**
   * Load this symbol's open positions and recent signals onto the chart.
   *
   * Filtered by symbol server-side via the nested `filter` object — sent flat
   * the criteria are discarded in silence and the handler answers with page 1
   * of the whole table, which here would paint another symbol's stop loss onto
   * this chart. That is a wrong chart, not an empty one.
   */
  private loadTradingOverlays(): void {
    const symbol = this.symbol();
    if (!this.showOverlays()) {
      this.overlays.set([]);
      this.markers.set([]);
      return;
    }

    this.positions
      .list({ currentPage: 1, itemCountPerPage: 50, filter: { symbol, status: 'Open' } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter(
          (p) => (p.symbol ?? '').toUpperCase() === symbol.toUpperCase(),
        );
        const out: PriceOverlay[] = [];
        for (const p of rows) {
          const long = String(p.direction).toLowerCase().includes('buy');
          const lots = p.openLots || p.tradedLots || 0;
          out.push({
            kind: 'entry',
            price: p.averageEntryPrice,
            label: `${long ? 'LONG' : 'SHORT'} ${lots.toFixed(2)}`,
            color: long ? '#26A69A' : '#EF5350',
          });
          if (p.stopLoss)
            out.push({ kind: 'stop', price: p.stopLoss, label: 'SL', color: '#EF5350' });
          if (p.takeProfit)
            out.push({ kind: 'target', price: p.takeProfit, label: 'TP', color: '#26A69A' });
        }
        this.overlays.set(out);
      });

    this.signals
      .list({
        currentPage: 1,
        itemCountPerPage: 100,
        filter: { symbol },
        sortBy: 'id',
        sortDirection: 'desc',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter(
          (s) => (s.symbol ?? '').toUpperCase() === symbol.toUpperCase(),
        );
        const marks: ChartMarker[] = [];
        for (const s of rows) {
          const at = Date.parse(s.generatedAt ?? '');
          // A signal with no readable timestamp cannot be pinned to a bar; a
          // NaN time makes the library drop the whole batch silently.
          if (Number.isNaN(at)) continue;
          const long = String(s.direction).toLowerCase().includes('buy');
          marks.push({
            time: at,
            position: long ? 'belowBar' : 'aboveBar',
            shape: long ? 'arrowUp' : 'arrowDown',
            color: long ? '#26A69A' : '#EF5350',
            text: `#${s.id}`,
          });
        }
        this.markers.set(marks);
      });
  }

  // ── Replay controls ──────────────────────────────────────────────────────

  startReplay(): void {
    const total = this.bars().length;
    if (total === 0) return;
    // Start two thirds in, so there is visible history to reason from and
    // enough ahead to be worth stepping through.
    this.replayIndex.set(Math.max(1, Math.floor(total * 0.66)));
    this.replayActive.set(true);
  }

  exitReplay(): void {
    this.pauseReplay();
    this.replayActive.set(false);
  }

  stepReplay(delta: number): void {
    const total = this.bars().length;
    this.replayIndex.update((i) => Math.max(1, Math.min(total, i + delta)));
    if (this.replayAtEnd()) this.pauseReplay();
  }

  toggleReplayPlay(): void {
    if (this.replayPlaying()) this.pauseReplay();
    else this.playReplay();
  }

  private playReplay(): void {
    if (this.replayAtEnd()) return;
    this.pauseReplay();
    this.replayPlaying.set(true);
    // Speed is bars per second; the interval is derived so changing speed
    // mid-playback takes effect on the next tick rather than needing a restart.
    this.replayTimer = setInterval(
      () => {
        this.stepReplay(1);
        if (this.replayAtEnd()) this.pauseReplay();
      },
      1000 / Math.max(1, this.replaySpeed()),
    );
  }

  private pauseReplay(): void {
    if (this.replayTimer !== null) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    this.replayPlaying.set(false);
  }

  setReplaySpeed(raw: string): void {
    const speed = Number(raw);
    if (!Number.isFinite(speed)) return;
    this.replaySpeed.set(speed);
    if (this.replayPlaying()) this.playReplay();
  }

  setReplayIndex(raw: string): void {
    const index = Number(raw);
    if (Number.isFinite(index)) this.replayIndex.set(index);
  }

  /** The time at the replay head, for the toolbar readout. */
  replayTime(): string {
    const bars = this.displayBars();
    return bars.length ? this.formatTime(bars[bars.length - 1].time) : '';
  }

  /**
   * Load the calendar around the visible window.
   *
   * Filtered to the currencies this pair is made of: an operator charting
   * EURUSD cares about EUR and USD prints, and drawing every JPY release on
   * top of them is noise that makes the ones that matter harder to see.
   */
  private loadEvents(): void {
    if (!this.showEvents()) {
      this.events.set([]);
      return;
    }
    const symbol = this.symbol().toUpperCase();
    const pair = this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === symbol);
    const currencies = [pair?.baseCurrency, pair?.quoteCurrency]
      .filter((c): c is string => !!c)
      .map((c) => c.toUpperCase());

    // Window to the bars actually plotted, not a fixed number of days: 1500
    // H1 bars is ~62 days but 1500 M5 bars is ~5, and a fixed window is either
    // short of the left edge or wasteful.
    const loaded = this.bars();
    const fromMs = loaded.length ? loaded[0].time : Date.now() - 45 * 86_400_000;
    const from = new Date(fromMs).toISOString();
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString();

    // sortBy/sortDirection are EXPLICIT. The handler's default is ascending, so
    // a capped page returns the OLDEST events in the window — which is exactly
    // what happened here: the chart showed 9-18 Sep and the API cheerfully
    // returned 5-20 Aug, so nothing rendered and the feature looked broken.
    this.economicEvents
      .list({
        currentPage: 1,
        itemCountPerPage: 500,
        filter: { from, to },
        sortBy: 'scheduledAt',
        sortDirection: 'desc',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter(
          (e) => currencies.length === 0 || currencies.includes((e.currency ?? '').toUpperCase()),
        );
        const marks: EventMark[] = [];
        for (const e of rows) {
          const at = Date.parse(e.scheduledAt ?? '');
          if (Number.isNaN(at)) continue;
          const impact = String(e.impact);
          marks.push({
            time: at,
            title: e.title ?? '',
            currency: (e.currency ?? '').toUpperCase(),
            impact: impact === 'High' ? 'High' : impact === 'Medium' ? 'Medium' : 'Low',
          });
        }
        this.events.set(marks);
      });
  }

  toggleEvents(): void {
    this.showEvents.set(!this.showEvents());
    this.loadEvents();
  }

  cycleEventImpact(): void {
    const order: Array<'High' | 'Medium' | 'Low'> = ['High', 'Medium', 'Low'];
    const next = order[(order.indexOf(this.minEventImpact()) + 1) % order.length];
    this.minEventImpact.set(next);
  }

  toggleOverlays(): void {
    this.showOverlays.set(!this.showOverlays());
    this.loadTradingOverlays();
    this.loadEvents();
  }

  /**
   * Keep the watchlist's last price and a reference for the change column.
   *
   * `prev` is seeded once per symbol and then left alone, so the percentage is
   * the move since this page opened rather than since the previous tick — a
   * per-tick delta reads as permanent noise around zero.
   */
  private recordQuote(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    const symbol = tick?.symbol?.toUpperCase();
    const bid = tick.bid ?? tick.price ?? tick.ask;
    if (!symbol || typeof bid !== 'number' || !Number.isFinite(bid)) return;
    this.prices.update((map) => ({
      ...map,
      [symbol]: { bid, prev: map[symbol]?.prev ?? bid },
    }));
  }

  private loadSymbols(): void {
    this.pairs
      .list({ currentPage: 1, itemCountPerPage: 200, filter: {} })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter((p) => p.isActive && p.symbol);
        this.symbols.set(rows);
      });
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    // Drawings belong to a symbol AND timeframe, so the scope has to move with
    // the chart before any drawing is read or written.
    this.drawings.setScope(this.symbol(), this.resolution());
    this.loadTradingOverlays();
    this.feed.invalidate(this.symbol(), this.resolution());
    const now = Date.now();
    try {
      const { bars } = await this.feed.getBars(this.symbol(), this.resolution(), 0, now, PAGE_BARS);
      this.bars.set(bars);
      // After the bars, so the calendar window matches what is on screen.
      this.loadEvents();
      if (bars.length === 0) {
        this.error.set(
          `No ${this.resolutionLabel(this.resolution())} candles stored for ${this.symbol()}.`,
        );
      }
    } catch {
      this.error.set('Could not load candles.');
    } finally {
      this.loading.set(false);
      this.host()?.historyLoaded();
    }
  }

  /**
   * Scroll-back paging: fetch the window ENDING at the oldest bar we hold and
   * prepend it. Asking by `to` rather than by `from` matches how the engine
   * pages (newest-first from a cutoff), so each page is a clean extension
   * backwards with no gap and no overlap to reconcile.
   */
  async loadOlder(): Promise<void> {
    const current = this.bars();
    if (current.length === 0 || this.loading()) {
      this.host()?.historyLoaded();
      return;
    }
    const oldest = current[0].time;
    const step = resolutionMs(this.resolution()) ?? 60_000;
    this.loading.set(true);
    try {
      const { bars } = await this.feed.getBars(
        this.symbol(),
        this.resolution(),
        0,
        oldest - step,
        PAGE_BARS,
      );
      if (bars.length > 0) {
        const merged = new Map<number, Bar>();
        for (const b of bars) merged.set(b.time, b);
        for (const b of current) merged.set(b.time, b);
        this.bars.set([...merged.values()].sort((a, b) => a.time - b.time));
      }
    } finally {
      this.loading.set(false);
      this.host()?.historyLoaded();
    }
  }

  private applyTick(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    if (!tick?.symbol || tick.symbol.toUpperCase() !== this.symbol().toUpperCase()) return;
    const price = tick.bid ?? tick.price ?? tick.ask;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;

    const current = this.bars();
    if (current.length === 0) return;
    const step = resolutionMs(this.resolution());
    if (!step) return;

    const last = current[current.length - 1];
    const bucket = Math.floor(Date.now() / step) * step;

    if (bucket > last.time) {
      // A new bar opened. Seed it from the tick rather than waiting for the
      // next history fetch, so the chart does not stall a whole timeframe
      // behind the market.
      this.bars.set([
        ...current,
        { time: bucket, open: price, high: price, low: price, close: price, volume: 0 },
      ]);
      return;
    }
    if (bucket < last.time) return;

    const updated: Bar = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
    this.bars.set([...current.slice(0, -1), updated]);
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────

  selectSymbol(symbol: string): void {
    this.symbolMenuOpen.set(false);
    this.symbolQuery.set('');
    if (symbol === this.symbol()) return;
    this.symbol.set(symbol);
    void this.router.navigate(['/chart-analysis', symbol], {
      queryParams: { tf: this.resolution() },
      replaceUrl: true,
    });
    void this.reload();
  }

  selectResolution(r: TvResolution): void {
    if (r === this.resolution()) return;
    this.resolution.set(r);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tf: r },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.reload();
  }

  addIndicator(defId: string): void {
    const def = indicatorById(defId);
    if (!def) return;
    this.active.update((list) => [
      ...list,
      {
        uid: `${defId}-${Date.now().toString(36)}-${list.length}`,
        defId,
        params: defaultParams(def),
        visible: true,
      },
    ]);
    this.indicatorMenuOpen.set(false);
  }

  removeIndicator(uid: string): void {
    this.active.update((list) => list.filter((i) => i.uid !== uid));
  }

  toggleIndicator(uid: string): void {
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, visible: !i.visible } : i)),
    );
  }

  setParam(uid: string, key: string, raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, params: { ...i.params, [key]: value } } : i)),
    );
  }

  labelFor(item: ActiveIndicator): string {
    const def = indicatorById(item.defId);
    return def ? indicatorLabel(def, item.params) : item.defId;
  }

  inputsFor(item: ActiveIndicator) {
    return indicatorById(item.defId)?.inputs.filter((i) => i.type === 'number') ?? [];
  }

  onLegend(snapshot: LegendSnapshot): void {
    this.legend.set(snapshot);
  }

  // ── Workspace actions ────────────────────────────────────────────────────

  private snapshotOfChart(): Omit<ChartLayout, 'id' | 'name' | 'savedAt'> {
    return {
      symbol: this.symbol(),
      resolution: this.resolution(),
      style: this.style(),
      showVolume: this.showVolume(),
      scaleMode: this.scaleMode(),
      timezone: this.timezone(),
      indicators: this.active().map((i) => ({ ...i, params: { ...i.params } })),
    };
  }

  saveLayout(): void {
    const name = prompt(
      'Layout name',
      `${this.symbol()} ${this.resolutionLabel(this.resolution())}`,
    );
    if (name === null) return;
    const saved = this.layoutStore.saveLayout(name, this.snapshotOfChart());
    this.layoutStore.rememberLast(saved.id);
    this.layoutMenuOpen.set(false);
  }

  applyLayout(layout: ChartLayout): void {
    this.layoutMenuOpen.set(false);
    this.style.set(layout.style);
    this.showVolume.set(layout.showVolume);
    this.scaleMode.set(layout.scaleMode);
    this.timezone.set(layout.timezone ?? 'UTC');
    // Fresh uids: reapplying a layout must not collide with studies already on
    // the chart, which would leave the new ones un-rendered.
    this.active.set(
      layout.indicators.map((i, n) => ({
        ...i,
        params: { ...i.params },
        uid: `${i.defId}-${Date.now().toString(36)}-${n}`,
      })),
    );
    this.layoutStore.rememberLast(layout.id);
    const changed = layout.symbol !== this.symbol() || layout.resolution !== this.resolution();
    this.symbol.set(layout.symbol);
    this.resolution.set(layout.resolution);
    if (changed) void this.reload();
  }

  removeLayout(id: string, ev: Event): void {
    ev.stopPropagation();
    this.layoutStore.removeLayout(id);
  }

  saveTemplate(): void {
    if (this.active().length === 0) return;
    const name = prompt('Template name', 'My studies');
    if (name === null) return;
    this.layoutStore.saveTemplate(name, this.active());
    this.layoutMenuOpen.set(false);
  }

  applyTemplate(template: StudyTemplate): void {
    this.layoutMenuOpen.set(false);
    this.active.set(this.layoutStore.instantiate(template));
  }

  removeTemplate(id: string, ev: Event): void {
    ev.stopPropagation();
    this.layoutStore.removeTemplate(id);
  }

  /** Download the chart as a PNG. */
  takeSnapshot(): void {
    const data = this.host()?.snapshot();
    this.contextMenu.set(null);
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = `${this.symbol()}-${this.resolutionLabel(this.resolution())}-${Date.now()}.png`;
    a.click();
  }

  async toggleFullscreen(): Promise<void> {
    const el = document.querySelector('.chart-page');
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        this.isFullscreen.set(false);
      } else {
        await (el as HTMLElement).requestFullscreen();
        this.isFullscreen.set(true);
      }
    } catch {
      // Fullscreen is refused without a user gesture in some contexts; the
      // chart is perfectly usable without it, so this is not worth surfacing.
    }
  }

  openContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const host = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.contextMenu.set({ x: ev.clientX - host.left, y: ev.clientY - host.top });
  }

  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  resetScales(): void {
    this.host()?.resetScales();
    this.contextMenu.set(null);
  }

  clearDrawingsFromMenu(): void {
    this.drawings.clearVisible();
    this.contextMenu.set(null);
  }

  // ── Drawing actions ──────────────────────────────────────────────────────

  selectTool(kind: DrawingKind | null): void {
    this.tool.set(this.tool() === kind ? null : kind);
  }

  /** The chart disarms the tool itself once a drawing completes. */
  onToolComplete(): void {
    this.tool.set(null);
  }

  toolLabel(kind: DrawingKind): string {
    return toolFor(kind)?.label ?? kind;
  }

  removeDrawing(id: string): void {
    this.drawings.remove(id);
  }

  selectDrawing(id: string): void {
    this.drawings.selectedId.set(id);
  }

  setDrawingColor(id: string, color: string): void {
    this.drawings.updateStyle(id, { color });
  }

  setDrawingWidth(id: string, raw: string): void {
    const width = Number(raw);
    if (Number.isFinite(width)) this.drawings.updateStyle(id, { width });
  }

  setDrawingDash(id: string, dash: string): void {
    this.drawings.updateStyle(id, { dash: dash as DashStyle });
  }

  setDrawingText(id: string, text: string): void {
    this.drawings.updateStyle(id, { text });
  }

  toggleDrawingFill(id: string, current: string | null): void {
    // Toggling fill has to preserve the drawing's own colour, not snap back to
    // the default blue, or restyling a shape loses the styling twice over.
    const selected = this.drawings.selected();
    const base = selected?.style.color ?? '#2962FF';
    this.drawings.updateStyle(id, { fill: current ? null : withAlpha(base, 0.15) });
  }

  /**
   * Keyboard shortcuts, matching TradingView's where they exist.
   *
   * Bound on the host rather than on `document` so typing in the symbol search
   * or an indicator input never deletes the selected drawing.
   */
  onKeydown(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) this.drawings.redo();
      else this.drawings.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.drawings.redo();
      return;
    }
    if (ev.key === 'Escape') {
      this.tool.set(null);
      this.drawings.selectedId.set(null);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const id = this.drawings.selectedId();
      if (id) {
        ev.preventDefault();
        this.drawings.remove(id);
      }
      return;
    }
    if (ev.key.toLowerCase() === 'm' && !mod) {
      this.magnet.set(!this.magnet());
    }
  }

  drawingLabel(d: Drawing): string {
    return toolFor(d.kind)?.label ?? d.kind;
  }

  /**
   * Format a plotted bar time for the legend.
   *
   * The times reaching here are already shifted into the display timezone (the
   * chart has no timezone of its own, so the shift is applied to the data), so
   * this formats them as wall-clock and labels them with the zone actually in
   * use. Hardcoding " UTC" was wrong in both directions: it claimed UTC while
   * showing New York's clock.
   */
  formatTime(ms: number | null): string {
    if (ms === null) return '';
    const zone = this.timezone();
    const label = this.timezones.find((t) => t.id === zone)?.label ?? zone;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ` ${label}`;
  }
}

/** Translate a hex colour into an rgba fill at the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(41,98,255,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}
