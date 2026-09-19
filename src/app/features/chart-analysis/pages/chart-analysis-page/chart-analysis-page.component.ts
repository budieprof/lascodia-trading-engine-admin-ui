import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
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
import { AlertsService } from '@core/services/alerts.service';
import { OrdersService } from '@core/services/orders.service';
import { MartingaleService } from '@core/services/martingale.service';
import { NewsIntelService } from '@core/services/news-intel.service';
import type {
  NewsArticleView,
  NewsFocusResult,
  NewsPressureLeg,
} from '@features/news-intel/news-intel.types';
import { NotificationService } from '@core/notifications/notification.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { UiCommandService } from '@core/assistant/ui-command.service';
import { chartCommands } from '../../chart-commands';
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

/** One comparison chart in a split layout. */
export interface ComparePanel {
  id: string;
  symbol: string;
  resolution: TvResolution;
  bars: Bar[];
}

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
  { id: 'hilo', label: 'High-Low' },
  { id: 'vol-candle', label: 'Volume candles' },
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
  imports: [FormsModule, DecimalPipe, DatePipe, ChartHostComponent],
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
  private readonly pageContext = inject(PageContextService);
  private readonly uiCommands = inject(UiCommandService);

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
  /** Position levels. Kept separate from order levels so each can refresh alone. */
  private readonly positionOverlays = signal<PriceOverlay[]>([]);
  private readonly orderOverlays = signal<PriceOverlay[]>([]);
  private readonly signalMarkers = signal<ChartMarker[]>([]);
  private readonly rungMarkers = signal<ChartMarker[]>([]);

  readonly overlays = computed(() => [...this.positionOverlays(), ...this.orderOverlays()]);
  readonly markers = computed(() => [...this.signalMarkers(), ...this.rungMarkers()]);
  readonly showOverlays = signal(true);
  private readonly orders = inject(OrdersService);
  private readonly martingale = inject(MartingaleService);

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

  // ── Side panes: Details and News ─────────────────────────────────────────
  private readonly newsIntel = inject(NewsIntelService);
  readonly sidePane = signal<'none' | 'details' | 'news'>('none');
  readonly articles = signal<NewsArticleView[]>([]);
  readonly newsLoading = signal(false);
  readonly newsFocus = signal<NewsFocusResult | null>(null);

  /**
   * Symbol facts for the Details pane, assembled from what the console already
   * knows rather than a new endpoint: the pair's own metadata, the loaded bar
   * range, and the session's move.
   */
  readonly details = computed(() => {
    const symbol = this.symbol();
    const pair = this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === symbol);
    const bars = this.bars();
    const first = bars[0];
    const last = bars[bars.length - 1];
    const dayStart = last ? Math.floor(last.time / 86_400_000) * 86_400_000 : 0;
    const today = bars.filter((b) => b.time >= dayStart);
    const dayOpen = today[0]?.open ?? null;
    return {
      symbol,
      base: pair?.baseCurrency ?? '—',
      quote: pair?.quoteCurrency ?? '—',
      digits: pair ? Math.trunc(pair.decimalPlaces) : 5,
      contractSize: pair?.contractSize ?? null,
      minLot: pair?.minLotSize ?? null,
      maxLot: pair?.maxLotSize ?? null,
      lotStep: pair?.lotStep ?? null,
      bars: bars.length,
      from: first ? this.formatTime(first.time) : '—',
      to: last ? this.formatTime(last.time) : '—',
      last: last?.close ?? null,
      dayOpen,
      dayHigh: today.length ? Math.max(...today.map((b) => b.high)) : null,
      dayLow: today.length ? Math.min(...today.map((b) => b.low)) : null,
      dayChangePct:
        dayOpen && last && dayOpen !== 0 ? ((last.close - dayOpen) / dayOpen) * 100 : null,
    };
  });
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
  readonly contextMenu = signal<{ x: number; y: number; price: number | null } | null>(null);
  private readonly alerts = inject(AlertsService);
  private readonly notify = inject(NotificationService);
  readonly isFullscreen = signal(false);

  /**
   * Box size for the price-based styles, as a multiple of ATR.
   *
   * An absolute price would be useless across timeframes — 10 pips is a
   * sensible Renko brick on H1 and absurd on D1 — so the operator scales the
   * ATR-derived default rather than replacing it.
   */
  readonly boxSizeAtr = signal(1);

  /**
   * FX market status, from the bar data rather than a clock.
   *
   * The week runs Sunday 22:00 UTC to Friday 22:00 UTC, but brokers differ and
   * holidays are not on any weekday rule. Asking "has a bar closed recently?"
   * answers the question the operator actually has — is this chart live — and
   * cannot disagree with the data on screen.
   */
  readonly marketStatus = computed<'open' | 'closed' | 'stale'>(() => {
    const bars = this.bars();
    if (bars.length === 0) return 'closed';
    const step = resolutionMs(this.resolution()) ?? 60_000;
    const age = Date.now() - bars[bars.length - 1].time;
    if (age <= step * 2) return 'open';
    // Beyond two bars but inside a weekend is "closed"; beyond that, the feed
    // itself is suspect and saying "open" would be a lie.
    return age <= 3 * 86_400_000 ? 'closed' : 'stale';
  });

  // ── Split view ───────────────────────────────────────────────────────────
  //
  // The primary chart keeps every tool. Comparison panels are their own charts
  // with their own symbol, timeframe, bars and drawings — drawings are scoped
  // per symbol+timeframe, so each panel renders only its own.
  readonly splitLayout = signal<'1' | '2h' | '2v' | '4' | '6' | '8'>('1');
  readonly comparePanels = signal<ComparePanel[]>([]);

  readonly splitLayouts: Array<{
    id: '1' | '2h' | '2v' | '4' | '6' | '8';
    label: string;
    panels: number;
  }> = [
    { id: '1', label: '▢', panels: 0 },
    { id: '2h', label: '◫', panels: 1 },
    { id: '2v', label: '⊟', panels: 1 },
    { id: '4', label: '⊞', panels: 3 },
    { id: '6', label: '⊟⊞', panels: 5 },
    { id: '8', label: '⊞⊞', panels: 7 },
  ];

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

  /**
   * Symbols this page currently holds a live-price subscription for.
   *
   * The hub rooms are PER-SYMBOL (`SubscribePrice` / `UnsubscribePrice`), not
   * per-route, so a chart that never subscribes receives whatever ticks other
   * pages happen to have joined — which is why the watchlist showed a dash for
   * every price. Tracking the set lets the diff below subscribe and
   * unsubscribe only what actually changed.
   */
  private readonly subscribedSymbols = new Set<string>();

  constructor() {
    this.loadSymbols();

    // Tell the assistant what this page is showing, and what it may do to it.
    //
    // Both halves matter. Without the FACTS the assistant cannot see the chart at all, and
    // its only honest answer about a study or a style is a guess at how charting widgets
    // usually work — which is how it came to describe controls (an "eye / gear / ×" cluster)
    // that this build does not have. Without the COMMANDS it can describe the chart
    // perfectly and still not change it, because chart state is client-side and every other
    // action it can take is an engine endpoint.
    this.pageContext.publish(() => ({
      headline: `Chart analysis — ${this.symbol()} ${this.resolutionLabel(this.resolution())}, ${this.style()}, ${this.active().length} stud${this.active().length === 1 ? 'y' : 'ies'}`,
      record: { kind: 'symbol', id: this.symbol(), label: this.symbol() },
      filters: {
        timeframe: this.resolution(),
        style: this.style(),
        scaleMode: this.scaleMode(),
        timezone: this.timezone(),
        splitLayout: this.splitLayout(),
        volume: this.showVolume(),
        tradeOverlays: this.showOverlays(),
        economicEvents: this.showEvents(),
        magnet: this.magnet(),
        replay: this.replayActive(),
      },
      figures: {
        barsLoaded: this.bars().length,
        drawings: this.drawings.visible().length,
        studies:
          this.active()
            .map((i) => this.labelFor(i))
            .join(', ') || '(none)',
        lastBarUtc: this.bars().at(-1)?.time
          ? new Date(this.bars().at(-1)!.time).toISOString()
          : null,
      },
      ids: { studies: this.active().map((i) => i.uid) },
    }));

    this.uiCommands.register(
      chartCommands({
        symbol: this.symbol,
        resolution: this.resolution,
        style: this.style,
        showVolume: this.showVolume,
        showOverlays: this.showOverlays,
        showEvents: this.showEvents,
        magnet: this.magnet,
        scaleMode: this.scaleMode,
        timezone: this.timezone,
        splitLayout: this.splitLayout,
        active: this.active,
        boxSizeAtr: this.boxSizeAtr,
        drawingCount: () => this.drawings.visible().length,
        selectSymbol: (s) => this.selectSymbol(s),
        selectResolution: (r) => this.selectResolution(r as TvResolution),
        addIndicator: (id) => this.addIndicator(id),
        removeIndicator: (uid) => this.removeIndicator(uid),
        toggleIndicator: (uid) => this.toggleIndicator(uid),
        setIndicatorParam: (uid, key, value) => this.setParam(uid, key, String(value)),
        setSplitLayout: (id) => this.setSplitLayout(id),
        selectTool: (kind) => this.tool.set(kind),
        clearDrawings: () => this.drawings.clearVisible(),
        takeSnapshot: () => this.takeSnapshot(),
        knownSymbols: () =>
          this.symbols()
            .map((p) => p.symbol ?? '')
            .filter(Boolean),
        timezones: () => this.timezones,
      }),
      this.destroyRef,
    );

    // Keep the live-price subscriptions in step with what is on screen: the
    // primary chart, every comparison panel, and — only while it is open —
    // the watchlist. The watchlist costs 23 rooms, which is the honest price
    // of a live watchlist and why it is not subscribed when closed.
    effect(() => {
      const wanted = new Set<string>([
        this.symbol().toUpperCase(),
        ...this.comparePanels().map((p) => p.symbol.toUpperCase()),
        ...(this.watchlistOpen() ? this.symbols().map((p) => (p.symbol ?? '').toUpperCase()) : []),
      ]);
      wanted.delete('');
      untracked(() => this.syncPriceSubscriptions(wanted));
    });

    this.destroyRef.onDestroy(() => {
      for (const symbol of this.subscribedSymbols) {
        void this.realtime.invoke('UnsubscribePrice', symbol).catch(() => undefined);
      }
      this.subscribedSymbols.clear();
    });
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
      this.positionOverlays.set([]);
      this.orderOverlays.set([]);
      this.signalMarkers.set([]);
      this.rungMarkers.set([]);
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
        this.positionOverlays.set(out);
      });

    // ── Working orders ────────────────────────────────────────────────────
    //
    // Only orders that can still fill. A filled order is already a position and
    // is drawn as one; a cancelled one is history. Drawing either would put
    // lines on the chart at prices nothing is waiting at.
    this.orders
      .list({
        currentPage: 1,
        itemCountPerPage: 50,
        filter: { symbol },
        sortBy: 'id',
        sortDirection: 'desc',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const working = (res.data.data ?? []).filter(
          (o) =>
            (o.symbol ?? '').toUpperCase() === symbol.toUpperCase() &&
            ['Pending', 'Submitted', 'PartialFill'].includes(String(o.status)),
        );
        const lines: PriceOverlay[] = [];
        for (const o of working) {
          const buy = String(o.orderType) === 'Buy';
          lines.push({
            kind: 'order',
            price: o.price,
            label: `${String(o.executionType).toUpperCase()} ${buy ? 'BUY' : 'SELL'} ${o.quantity}`,
            color: buy ? '#26A69A' : '#EF5350',
          });
          if (o.stopLoss)
            lines.push({ kind: 'stop', price: o.stopLoss, label: 'O·SL', color: '#EF5350' });
          if (o.takeProfit)
            lines.push({ kind: 'target', price: o.takeProfit, label: 'O·TP', color: '#26A69A' });
        }
        this.orderOverlays.set(lines);
      });

    // ── Martingale rungs ──────────────────────────────────────────────────
    //
    // Each closed rung is pinned to the BAR it closed on, not to a price line:
    // a chain's rungs are events in sequence, and stacking six horizontal lines
    // on the price scale buries the candles the operator is reading.
    this.martingale
      .getOverview({ maxChains: 40 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (overview) => {
          const chains = (overview?.chains ?? []).filter(
            (c) => (c.symbol ?? '').toUpperCase() === symbol.toUpperCase(),
          );
          const marks: ChartMarker[] = [];
          for (const chain of chains) {
            for (const entry of chain.ledger ?? []) {
              const at = Date.parse(entry.closedAtUtc ?? '');
              if (Number.isNaN(at)) continue;
              const loss = String(entry.outcome) === 'Loss';
              marks.push({
                time: at,
                position: 'belowBar',
                shape: 'square',
                color: loss ? '#EF5350' : '#26A69A',
                text: `R${entry.depthAfter}`,
              });
            }
          }
          this.rungMarkers.set(marks);
        },
        // The ladder module can be off entirely; that is not an error worth a
        // toast, it just means there are no rungs to draw.
        error: () => this.rungMarkers.set([]),
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
        this.signalMarkers.set(marks);
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

  setBoxSize(raw: string): void {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) this.boxSizeAtr.set(value);
  }

  /** True while a price-based style is showing, so the box control appears. */
  readonly priceBasedStyle = computed(() =>
    ['renko', 'kagi', 'pnf', 'line-break'].includes(this.style()),
  );

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

  openSidePane(pane: 'details' | 'news'): void {
    this.sidePane.set(this.sidePane() === pane ? 'none' : pane);
    if (this.sidePane() === 'news') this.loadNews();
  }

  /**
   * Headlines for the charted pair's currencies.
   *
   * Filtered to the two currencies the pair is made of, for the same reason the
   * economic events are: an operator charting EURUSD does not want JPY
   * headlines competing for the same space.
   */
  private loadNews(): void {
    const pair = this.symbols().find(
      (p) => (p.symbol ?? '').toUpperCase() === this.symbol().toUpperCase(),
    );
    const currency = pair?.baseCurrency?.toUpperCase();
    this.newsLoading.set(true);
    this.newsIntel
      .getArticles({ currency, hours: 48, take: 40 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.articles.set(Array.isArray(rows) ? rows : []);
          this.newsLoading.set(false);
        },
        // The news module can be disabled entirely; an empty pane says that
        // better than an error toast the operator cannot act on.
        error: () => {
          this.articles.set([]);
          this.newsLoading.set(false);
        },
      });

    // The headlines above are the RECORD layer. This is the module's actual
    // read on the pair — the base-minus-quote bias and, more importantly, how
    // much of it is still live. A deeply negative score whose liveShare has
    // decayed to nothing is a story the market has finished repricing; showing
    // headlines without it invites trading news that is already in the price.
    this.newsFocus.set(null);
    this.newsIntel
      .getFocus(this.symbol().toUpperCase())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.newsFocus.set(r ?? null),
        error: () => this.newsFocus.set(null),
      });
  }

  /**
   * Format a leg for the pane: score, story count and live share.
   *
   * `liveShare === null` is NOT the same as zero — the type documents it as
   * "no weight to divide" versus "measured, and none of it is live" — so it
   * renders as an em dash rather than 0%.
   */
  legSummary(leg: NewsPressureLeg | null): string {
    if (!leg) return '—';
    const live = leg.liveShare === null ? '—' : `${Math.round(leg.liveShare * 100)}% live`;
    const stories = `${leg.storyCount} ${leg.storyCount === 1 ? 'story' : 'stories'}`;
    return `${leg.score >= 0 ? '+' : ''}${leg.score.toFixed(2)} · ${stories} · ${live}`;
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

  private syncPriceSubscriptions(wanted: Set<string>): void {
    for (const symbol of [...this.subscribedSymbols]) {
      if (wanted.has(symbol)) continue;
      this.subscribedSymbols.delete(symbol);
      // Failures are ignored on purpose: the hub drops a connection's groups
      // automatically on disconnect, so a missed unsubscribe costs nothing.
      void this.realtime.invoke('UnsubscribePrice', symbol).catch(() => undefined);
    }
    for (const symbol of wanted) {
      if (this.subscribedSymbols.has(symbol)) continue;
      this.subscribedSymbols.add(symbol);
      void this.realtime.invoke('SubscribePrice', symbol).catch(() => {
        // Re-arm so a reconnect can try again rather than leaving the symbol
        // permanently unsubscribed.
        this.subscribedSymbols.delete(symbol);
      });
    }
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

  // ── Split view ───────────────────────────────────────────────────────────

  setSplitLayout(id: '1' | '2h' | '2v' | '4' | '6' | '8'): void {
    this.splitLayout.set(id);
    const wanted = this.splitLayouts.find((l) => l.id === id)?.panels ?? 0;
    const current = this.comparePanels();
    if (current.length === wanted) return;

    if (current.length > wanted) {
      this.comparePanels.set(current.slice(0, wanted));
      return;
    }
    // New panels open on a different symbol from the primary chart: two
    // identical charts side by side is never what the operator wanted.
    const taken = new Set([this.symbol(), ...current.map((p) => p.symbol)]);
    const candidates = this.symbols()
      .map((s) => (s.symbol ?? '').toUpperCase())
      .filter((s) => s && !taken.has(s));
    const added: ComparePanel[] = [];
    for (let i = current.length; i < wanted; i++) {
      const symbol = candidates[i - current.length] ?? this.symbol();
      added.push({
        id: `p${Date.now().toString(36)}${i}`,
        symbol,
        resolution: this.resolution(),
        bars: [],
      });
    }
    this.comparePanels.set([...current, ...added]);
    for (const panel of added) void this.loadPanel(panel.id);
  }

  private async loadPanel(id: string): Promise<void> {
    const panel = this.comparePanels().find((p) => p.id === id);
    if (!panel) return;
    const { bars } = await this.feed
      .getBars(panel.symbol, panel.resolution, 0, Date.now(), PAGE_BARS)
      .catch(() => ({ bars: [] as Bar[], noData: true }));
    this.comparePanels.update((list) => list.map((p) => (p.id === id ? { ...p, bars } : p)));
  }

  setPanelSymbol(id: string, symbol: string): void {
    this.comparePanels.update((list) =>
      list.map((p) => (p.id === id ? { ...p, symbol: symbol.toUpperCase(), bars: [] } : p)),
    );
    void this.loadPanel(id);
  }

  setPanelResolution(id: string, resolution: string): void {
    this.comparePanels.update((list) =>
      list.map((p) =>
        p.id === id ? { ...p, resolution: resolution as TvResolution, bars: [] } : p,
      ),
    );
    void this.loadPanel(id);
  }

  /** Promote a comparison panel to the primary chart. */
  focusPanel(id: string): void {
    const panel = this.comparePanels().find((p) => p.id === id);
    if (!panel) return;
    const previous = { symbol: this.symbol(), resolution: this.resolution() };
    this.comparePanels.update((list) =>
      list.map((p) => (p.id === id ? { ...p, ...previous, bars: [] } : p)),
    );
    this.symbol.set(panel.symbol);
    this.resolution.set(panel.resolution);
    void this.reload();
    void this.loadPanel(id);
  }

  panelPrecision(symbol: string): number {
    const pair = this.symbols().find(
      (p) => (p.symbol ?? '').toUpperCase() === symbol.toUpperCase(),
    );
    return pair ? Math.trunc(pair.decimalPlaces) || 5 : 5;
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
    const y = ev.clientY - host.top;
    // The price under the cursor is captured HERE, while the pointer position
    // is still meaningful. Reading it when the menu item is clicked would
    // measure wherever the pointer had drifted to by then.
    this.contextMenu.set({ x: ev.clientX - host.left, y, price: this.host()?.priceAtY(y) ?? null });
  }

  /**
   * Create a price alert at the point that was right-clicked.
   *
   * Uses the engine's existing `PriceLevel` alert type, so an alert raised
   * from the chart is the same object as one raised anywhere else — it routes
   * through the same channels and shows up in the same list, rather than being
   * a chart-only notion that quietly does nothing.
   */
  createAlertHere(): void {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    const price = menu?.price;
    if (price === null || price === undefined) return;

    const digits = this.precision();
    const symbol = this.symbol();
    const last = this.bars().at(-1)?.close ?? price;
    const direction = price >= last ? 'Above' : 'Below';

    this.alerts
      .create({
        alertType: 'PriceLevel',
        symbol,
        conditionJson: JSON.stringify({ symbol, price, direction }),
        isActive: true,
        deduplicationKey: `chart:${symbol}:${price.toFixed(digits)}`,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (res?.status) {
            this.notify.success(
              `Alert set: ${symbol} ${direction.toLowerCase()} ${price.toFixed(digits)}`,
            );
          } else {
            this.notify.error(res?.message ?? 'Could not create the alert.');
          }
        },
        error: () => this.notify.error('Could not create the alert.'),
      });
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
