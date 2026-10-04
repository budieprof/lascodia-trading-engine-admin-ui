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
import {
  bucketStartFor,
  foldBars,
  lastCompleteBarTime,
  mergeForming,
} from '../../datafeed/aggregate';
import { priceScaleFor } from '../../datafeed/symbol-info';
import { StrategiesService } from '@core/services/strategies.service';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingToolbarComponent } from '../../drawings/ui/drawing-toolbar.component';
import { DrawingSettingsDialogComponent } from '../../drawings/ui/drawing-settings-dialog.component';
import type { ZOrderOp } from '../../drawings/drawing-ops';
import {
  WatchlistPanelComponent,
  type WatchHeadline,
} from '../../watchlist/watchlist-panel.component';
import { TechnicalsViewComponent } from '../../panels/technicals-view.component';
import type { StudyRef } from '../../panels/technicals';
import { IndicatorsDialogComponent } from '../../dialog/indicators-dialog.component';
import type { DialogItem, DialogTab } from '../../dialog/dialog-items';
import {
  fundamentalIdOf,
  studyDefaults,
  studyDialogItems,
  studyKind,
  studyLabel,
  studyMeta,
} from '../../studies';
import { FxFundamentalsService } from '../../panels/fx-fundamentals.service';
import { DailyBarsService } from '../../panels/daily-bars.service';
import { FUNDAMENTAL_PANES, stepDifference, type PanePoint } from '../../panels/fx-fundamentals';
import { PerformanceTilesComponent } from '../../panels/performance-tiles.component';
import { SeasonalsComponent } from '../../panels/seasonals.component';
import { TechnicalsGaugeComponent } from '../../panels/technicals-gauge.component';
import type { ExternalPane } from '../../chart/chart-host.component';
import {
  catchError,
  forkJoin,
  from,
  map,
  of,
  switchMap as switchMapTo,
  type Observable,
} from 'rxjs';
import {
  ChartScriptService,
  type ChartScriptCatalog,
  type ChartScriptItem,
} from '../../scripts/chart-script.service';
import type { ChartScriptResult, ChartTrade } from '../../scripts/chart-script.model';
import { tradeWindow } from '../../scripts/trade-detail';
import { chartPineAdapter } from '../../scripts/chart-pine-adapter';
import { detectScriptKind } from '../../scripts/chart-script.model';
import {
  pineAssistCommands,
  pineEditorFacts,
  type PineEditorAdapter,
} from '@shared/pine-assist/pine-assist';
import { firstValueFrom } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { AssistantDockService } from '@core/assistant/assistant-dock.service';
import type { ScriptInputValues } from '@core/api/scripting.types';
import { StrategyTesterPanelComponent } from '../../scripts/strategy-tester-panel.component';
import {
  ScriptEditorPanelComponent,
  type ScriptEditorSubmit,
} from '../../scripts/script-editor-panel.component';
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
import {
  profileWithValueArea,
  supportResistance,
  VOLUME_PROFILE_MODES,
  type VolumeProfileMode,
} from '../../overlays/analysis-overlays';
import { marketStructure } from '../../overlays/market-structure';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import type { PriceOverlay } from '../../overlays/overlay-renderer';
import type { ChartMarker } from '../../chart/chart-host.component';
import {
  CHART_TIMEZONES,
  timezoneOffsetMinutes,
  ChartLayoutStore,
  type ChartLayout,
  type StudyTemplate,
} from '../../workspace/layout-store.service';
import {
  DEFAULT_STYLE,
  RAIL_LAYOUT,
  RAIL_STANDALONE,
  TOOLS,
  toolFor,
  type ToolSpec,
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
  '120': '2h',
  '240': '4h',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
};

const RESOLUTION_GROUPS: Array<{
  label: string;
  items: Array<{ id: TvResolution; name: string }>;
}> = [
  {
    label: 'Minutes',
    items: [
      { id: '1', name: '1 minute' },
      { id: '5', name: '5 minutes' },
      { id: '15', name: '15 minutes' },
      { id: '30', name: '30 minutes' },
    ],
  },
  {
    label: 'Hours',
    items: [
      { id: '60', name: '1 hour' },
      { id: '120', name: '2 hours' },
      { id: '240', name: '4 hours' },
    ],
  },
  {
    label: 'Days',
    items: [
      { id: '1D', name: '1 day' },
      { id: '1W', name: '1 week' },
      { id: '1M', name: '1 month' },
    ],
  },
];

const DAY = 86_400_000;
/** TradingView's bottom-bar presets: each picks the interval it shows the span at. */
const RANGE_PRESETS: Array<{
  id: string;
  title: string;
  resolution: TvResolution;
  spanMs: number | 'ytd' | 'all';
}> = [
  { id: '1D', title: '1 day in 1 minute intervals', resolution: '1', spanMs: DAY },
  { id: '5D', title: '5 days in 5 minute intervals', resolution: '5', spanMs: 5 * DAY },
  { id: '1M', title: '1 month in 30 minute intervals', resolution: '30', spanMs: 30 * DAY },
  { id: '3M', title: '3 months in 1 hour intervals', resolution: '60', spanMs: 91 * DAY },
  { id: '6M', title: '6 months in 4 hour intervals', resolution: '240', spanMs: 182 * DAY },
  { id: 'YTD', title: 'Year to date in 1 day intervals', resolution: '1D', spanMs: 'ytd' },
  { id: '1Y', title: '1 year in 1 day intervals', resolution: '1D', spanMs: 365 * DAY },
  { id: '5Y', title: '5 years in 1 week intervals', resolution: '1W', spanMs: 5 * 365 * DAY },
  { id: 'All', title: 'All data in 1 month intervals', resolution: '1M', spanMs: 'all' },
];

type ToolbarMenu = 'interval' | 'style' | 'templates' | 'overlays' | 'alert' | 'split' | 'tz';

/** The chart-type menu, grouped as TradingView groups it. TPO and Session volume profile toggle studies. */
type StyleChoice = ChartStyle | 'tpo' | 'session-vp';
const STYLE_GROUPS: Array<Array<{ id: StyleChoice; label: string }>> = [
  [
    { id: 'bars', label: 'Bars' },
    { id: 'candles', label: 'Candles' },
    { id: 'hollow', label: 'Hollow candles' },
    { id: 'vol-candle', label: 'Volume candles' },
  ],
  [
    { id: 'line', label: 'Line' },
    { id: 'line-markers', label: 'Line with markers' },
    { id: 'stepline', label: 'Step line' },
  ],
  [
    { id: 'area', label: 'Area' },
    { id: 'hlc-area', label: 'HLC area' },
    { id: 'baseline', label: 'Baseline' },
  ],
  [
    { id: 'column', label: 'Columns' },
    { id: 'hilo', label: 'High-low' },
    { id: 'hlc-bars', label: 'HLC bars' },
  ],
  [
    { id: 'tpo', label: 'Time price opportunity' },
    { id: 'session-vp', label: 'Session volume profile' },
  ],
  [
    { id: 'heikin-ashi', label: 'Heikin Ashi' },
    { id: 'renko', label: 'Renko' },
    { id: 'line-break', label: 'Line break' },
    { id: 'kagi', label: 'Kagi' },
    { id: 'pnf', label: 'Point & figure' },
    { id: 'range', label: 'Range' },
  ],
];
const STYLE_STUDY: Partial<Record<StyleChoice, string>> = {
  tpo: 'profile:tpo',
  'session-vp': 'profile:vp-session',
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
  { id: 'range', label: 'Range' },
];

/** How many bars to pull per request / per scroll-back page. */
const PAGE_BARS = 1500;

const WATCHLIST_OPEN_KEY = 'lascodia.chart.watchlistOpen';
/** TradingView keeps the watchlist docked by default; the operator's last choice wins. */
const DOCK_WIDTH_KEY = 'lascodia.chart.watchlistWidth';
function loadDockWidth(): number {
  try {
    const w = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return w >= 240 && w <= 640 ? w : 380;
  } catch {
    return 380;
  }
}

function loadWatchlistOpen(): boolean {
  try {
    return localStorage.getItem(WATCHLIST_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

@Component({
  selector: 'app-chart-analysis-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DecimalPipe,
    DatePipe,
    ChartHostComponent,
    IndicatorsDialogComponent,
    ChartIconComponent,
    DrawingToolbarComponent,
    DrawingSettingsDialogComponent,
    WatchlistPanelComponent,
    StrategyTesterPanelComponent,
    ScriptEditorPanelComponent,
    PerformanceTilesComponent,
    SeasonalsComponent,
    TechnicalsGaugeComponent,
    TechnicalsViewComponent,
  ],
  templateUrl: './chart-analysis-page.component.html',
  styleUrl: './chart-analysis-page.component.scss',
  host: {
    '(keydown)': 'onKeydown($event)',
    '(document:click)': 'closeRailFlyout()',
    tabindex: '0',
  },
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
  private readonly chartScripts = inject(ChartScriptService);
  private readonly fundamentals = inject(FxFundamentalsService);
  private readonly dailyBars = inject(DailyBarsService);

  /** Fetched FX-fundamental series, keyed by the study's uid. */
  readonly externalPanes = signal<ExternalPane[]>([]);

  private readonly host = viewChild<ChartHostComponent>('host');

  readonly resolutions = SUPPORTED_RESOLUTIONS;
  readonly resolutionLabel = (r: TvResolution) => RESOLUTION_LABELS[r] ?? r;
  readonly chartStyles = CHART_STYLES;
  readonly chartStyleGroups = STYLE_GROUPS;
  readonly resolutionGroups = RESOLUTION_GROUPS;

  /** One open toolbar menu at a time, as in TradingView. */
  readonly openMenu = signal<ToolbarMenu | null>(null);
  toggleMenu(menu: ToolbarMenu, ev: Event): void {
    ev.stopPropagation();
    this.layoutMenuOpen.set(false);
    this.openMenu.set(this.openMenu() === menu ? null : menu);
  }

  readonly styleLabel = computed(
    () => CHART_STYLES.find((s) => s.id === this.style())?.label ?? this.style(),
  );

  isStyleSelected(id: StyleChoice): boolean {
    const study = STYLE_STUDY[id];
    return study ? this.active().some((a) => a.defId === study) : this.style() === id;
  }

  pickStyle(id: StyleChoice): void {
    const study = STYLE_STUDY[id];
    if (study) {
      const existing = this.active().find((a) => a.defId === study);
      if (existing) this.removeIndicator(existing.uid);
      else this.addIndicator(study);
    } else {
      this.style.set(id as ChartStyle);
    }
    this.openMenu.set(null);
  }

  readonly overlayCount = computed(
    () =>
      [
        this.showOverlays(),
        this.showEvents(),
        this.showVolumeProfile(),
        this.showSupportResistance(),
        this.showStructure(),
        this.deltaOn(),
      ].filter(Boolean).length,
  );

  readonly alertPrice = signal<number>(0);
  openAlertDraft(ev: Event): void {
    this.alertPrice.set(Number((this.bars().at(-1)?.close ?? 0).toFixed(this.precision())));
    this.toggleMenu('alert', ev);
  }

  readonly rangePresets = RANGE_PRESETS;
  /** A preset waiting for its interval's bars to load before the window is applied. */
  private pendingRange: { fromMs: number; toMs: number } | 'all' | null = null;

  applyRangePreset(id: string): void {
    const p = RANGE_PRESETS.find((r) => r.id === id);
    if (!p) return;
    const now = Date.now();
    this.pendingRange =
      p.spanMs === 'all'
        ? 'all'
        : {
            fromMs:
              p.spanMs === 'ytd' ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) : now - p.spanMs,
            toMs: now,
          };
    if (this.resolution() !== p.resolution) this.selectResolution(p.resolution);
    else this.flushPendingRange();
  }

  goToDate(value: string): void {
    const t = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(t)) return;
    // Centre the day: a window the width of what is on screen, around the date.
    const span = Math.max((resolutionMs(this.resolution()) ?? DAY) * 120, DAY);
    this.pendingRange = { fromMs: t - span / 2, toMs: t + span / 2 };
    this.flushPendingRange();
  }

  private flushPendingRange(): void {
    const host = this.host();
    const r = this.pendingRange;
    if (!host || !r || !this.bars().length) return;
    if (r === 'all') host.fitContent();
    else host.setVisibleRange(r.fromMs, r.toMs);
    this.pendingRange = null;
  }

  toggleEditor(): void {
    if (this.dockTab() === 'editor') {
      this.editorOpen.set(false);
      return;
    }
    // Opening the editor shows the script on the chart, as TradingView does.
    this.openScriptSource(this.editorKey());
  }

  toggleTester(): void {
    if (this.dockTab() === 'tester') {
      this.testerOpen.set(false);
    } else {
      this.testerOpen.set(true);
      this.dockPreference.set('tester');
    }
  }

  autoScale(): void {
    this.scaleMode.set('normal');
    this.host()?.autoScalePrice();
  }

  /** Bottom-bar clock on the chart's timezone, ticking each second like TradingView's. */
  readonly clock = signal('');
  readonly timezoneShort = computed(() => {
    const zone = this.timezone();
    if (zone === 'UTC') return 'UTC';
    const offset = timezoneOffsetMinutes(zone, Date.now());
    const sign = offset >= 0 ? '+' : '−';
    const h = Math.floor(Math.abs(offset) / 60);
    const m = Math.abs(offset) % 60;
    return `(UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''})`;
  });
  private tickClock(): void {
    const zone = this.timezone();
    const now = Date.now();
    const shifted = new Date(
      now + (zone === 'UTC' ? 0 : timezoneOffsetMinutes(zone, now) * 60_000),
    );
    this.clock.set(shifted.toISOString().slice(11, 19));
  }

  readonly currentLayoutName = computed(() => {
    this.layoutStore.layouts();
    return this.layoutStore.lastLayout()?.name ?? 'Unnamed';
  });
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
  readonly dialogTab = signal<DialogTab>('indicators');

  /** Pine scripts + strategies the dialog can add; fetched when the dialog first opens. */
  readonly scriptCatalog = signal<ChartScriptCatalog | null>(null);
  readonly dialogItems = computed<DialogItem[]>(() => {
    const items = studyDialogItems();
    const cat = this.scriptCatalog();
    if (cat) {
      for (const it of cat.mine)
        items.push({
          kind: it.kind === 'strategy' ? 'strategy' : 'script',
          id: it.key,
          name: it.name,
          description: it.description,
          category: it.kind === 'strategy' ? 'My scripts' : 'My scripts',
          tag: 'Pine',
        });
      for (const it of cat.strategies)
        items.push({
          kind: 'strategy',
          id: it.key,
          name: it.name,
          description: it.description,
          category: 'Engine strategies',
          tag: [it.symbol, it.timeframe].filter(Boolean).join(' '),
        });
      for (const it of cat.examples)
        items.push({
          kind: it.kind === 'strategy' ? 'strategy' : 'script',
          id: it.key,
          name: it.name,
          description: it.description,
          category: 'Built-in examples',
          tag: 'Pine',
        });
    }
    return items;
  });

  /** Pine runs on the chart (indicators and at most one strategy, like TradingView). */
  readonly scriptRuns = signal<
    {
      item: ChartScriptItem;
      result: ChartScriptResult;
      values: ScriptInputValues;
      symbol: string;
      resolution: TvResolution;
    }[]
  >([]);
  readonly scriptResults = computed(() => this.scriptRuns().map((r) => r.result));
  readonly strategyRun = computed(
    () => this.scriptRuns().find((r) => r.result.kind === 'strategy') ?? null,
  );
  readonly scriptRunning = signal(false);
  readonly scriptError = signal<string | null>(null);
  readonly testerOpen = signal(true);
  readonly editorOpen = signal(false);

  // ── Pine Editor ↔ chart script (TradingView: the editor shows the script on the chart) ──
  private readonly strategies = inject(StrategiesService);
  /** The chart script the editor is showing (its run key), or null for a new script. */
  readonly editorKey = signal<string | null>(null);
  /** Engine strategy sources, fetched once per id. */
  private readonly strategySources = signal<Record<number, string | null>>({});
  readonly editorTarget = computed(() => {
    const runs = this.scriptRuns();
    const key = this.editorKey();
    const run = runs.find((r) => r.item.key === key) ?? null;
    if (!run) return null;
    const item = run.item;
    const id = item.strategyId ?? null;
    const source = item.pineSource ?? (id !== null ? (this.strategySources()[id] ?? null) : null);
    return {
      key: item.key,
      name: run.result.title || item.name,
      source,
      strategyId: id,
      loading: id !== null && source === null,
    };
  });

  /** Point the editor at a chart script, loading an engine strategy's source when needed. */
  openScriptSource(key: string | null): void {
    if (key !== this.editorKey()) this.assistSource.set(null);
    const runs = this.scriptRuns();
    const target =
      key ??
      (runs.find((r) => r.result.kind === 'strategy') ?? runs[runs.length - 1])?.item.key ??
      null;
    this.editorKey.set(target);
    const item = runs.find((r) => r.item.key === target)?.item;
    const id = item?.strategyId;
    if (id !== undefined && id !== null && !item?.pineSource && !(id in this.strategySources())) {
      this.strategies
        .getById(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) =>
            this.strategySources.update((m) => ({ ...m, [id]: res?.data?.scriptSource ?? '' })),
          error: () => this.strategySources.update((m) => ({ ...m, [id]: '' })),
        });
    }
    this.editorOpen.set(true);
    this.dockPreference.set('editor');
  }
  // ── The assistant's view of the Pine Editor (`pine.*` / `strategy.*` page commands) ──
  /** The editor's current text, for the script it shows — kept here so it reads even with the tester in front. */
  private readonly editorDraft = signal<{ key: string | null; text: string } | null>(null);
  /** Text the assistant wrote, pushed into the editor (a new seq applies it). */
  readonly assistSource = signal<{ text: string; seq: number } | null>(null);
  private assistSeq = 0;

  onEditorSource(text: string): void {
    this.editorDraft.set({ key: this.editorKey(), text });
  }

  private draftText(): string {
    const d = this.editorDraft();
    if (d && d.key === this.editorKey()) return d.text;
    return this.editorTarget()?.source ?? '';
  }

  private writeDraft(text: string): void {
    if (!this.editorOpen()) this.openScriptSource(this.editorKey());
    this.dockPreference.set('editor');
    this.editorDraft.set({ key: this.editorKey(), text });
    this.assistSource.set({ text, seq: ++this.assistSeq });
  }

  private readonly scriptEditor = viewChild(ScriptEditorPanelComponent);
  private readonly marketData = inject(MarketDataService);
  private readonly assistantDock = inject(AssistantDockService);

  private readonly pineAdapter: PineEditorAdapter = chartPineAdapter({
    editorName: () => this.editorTarget()?.name ?? null,
    draft: () => this.draftText(),
    writeDraft: (t) => this.writeDraft(t),
    openEditor: () => {
      if (!this.editorOpen()) this.openScriptSource(this.editorKey());
      this.dockPreference.set('editor');
    },
    compile: async (source) => {
      const r = await firstValueFrom(
        this.chartScripts.compile(source, this.symbol(), this.resolution()),
      );
      this.scriptEditor()?.showCompile(r);
      return r;
    },
    runDraft: (source) =>
      new Promise((resolve) => {
        const target = this.editorTarget();
        if (target) this.removeScript(target.key);
        const item = this.chartScripts.itemForSource(
          source,
          detectScriptKind(source),
          target?.name ?? 'Untitled script',
        );
        this.editorKey.set(item.key);
        this.editorDraft.set({ key: item.key, text: source });
        this.runScript(item, {}, false, resolve);
      }),
    currentRun: () => {
      const run =
        this.scriptRuns().find((r) => r.item.key === this.editorKey()) ?? this.strategyRun();
      return run ? { result: run.result, values: run.values } : null;
    },
    rerun: (values) =>
      new Promise((resolve) => {
        const run =
          this.scriptRuns().find((r) => r.item.key === this.editorKey()) ?? this.strategyRun();
        if (!run) resolve({ error: 'Nothing is running on the chart.' });
        else this.runScript(run.item, values, true, resolve);
      }),
    focusTrade: (t) => this.focusTrade(t),
    pricePrecision: () => this.precision(),
    readBuffer: async (name) => {
      const id = this.assistantDock.conversationId();
      return id ? firstValueFrom(this.marketData.getAssistantBuffer(id, name)) : null;
    },
  });

  /** Which dock tab wins when both the editor and the tester are open. */
  readonly dockPreference = signal<'editor' | 'tester'>('tester');
  readonly dockTab = computed<'editor' | 'tester' | null>(() => {
    const editor = this.editorOpen();
    const tester = !!this.strategyRun() && this.testerOpen();
    if (editor && tester) return this.dockPreference();
    return editor ? 'editor' : tester ? 'tester' : null;
  });

  /** Other symbols' bars for compare studies, keyed by symbol. */
  readonly compareBars = signal<Record<string, Bar[]>>({});
  private readonly compareSymbols = computed(() => {
    const out = new Set<string>();
    for (const a of this.active()) {
      if (!a.visible || !indicatorById(a.defId)?.needsCompare) continue;
      const sym = String(a.params['symbol'] ?? '').toUpperCase();
      if (sym && sym !== this.symbol().toUpperCase()) out.add(sym);
    }
    return [...out].sort();
  });
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

  // ── Analytical overlays ──────────────────────────────────────────────────
  //
  // Derived from the loaded bars, not fetched. The chart host computes them; these are the
  // toggles the toolbar drives.
  readonly showVolumeProfile = signal(false);
  readonly volumeProfileMode = signal<VolumeProfileMode>('visible');
  readonly vpMenuOpen = signal(false);
  readonly volumeProfileModes = VOLUME_PROFILE_MODES;
  readonly showSupportResistance = signal(false);
  readonly showStructure = signal(false);

  /** The estimated-delta study, which is a PANE study rather than a price overlay. */
  readonly deltaOn = computed(() => this.active().some((i) => i.defId === 'est-delta'));

  toggleDelta(): void {
    const existing = this.active().find((i) => i.defId === 'est-delta');
    if (existing) this.removeIndicator(existing.uid);
    else this.addIndicator('est-delta');
  }
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
  readonly watchlistOpen = signal(loadWatchlistOpen());
  readonly dockWidth = signal(loadDockWidth());
  /** Symbols the watchlist panel shows, for the live-price subscription. */
  readonly watchlistSymbols = signal<string[]>([]);
  readonly liveBids = computed(() => {
    const out: Record<string, number> = {};
    for (const [sym, q] of Object.entries(this.prices())) out[sym] = q.bid;
    return out;
  });
  readonly watchHeadline = computed<WatchHeadline | null>(() => {
    const a = this.articles()[0];
    if (!a) return null;
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(a.publishedAtUtc)) / 60_000));
    const at =
      mins < 60
        ? `${mins} min ago`
        : mins < 1440
          ? `${Math.round(mins / 60)} h ago`
          : `${Math.round(mins / 1440)} d ago`;
    return { title: a.title, source: a.sourceName, at };
  });

  // ── Technicals view ("More technicals") ──────────────────────────────────
  // Laid over the chart area rather than replacing it, so the chart stays
  // mounted and "Back to chart" returns to exactly the same state.
  readonly technicalsOpen = signal(false);
  readonly currentPair = computed(() =>
    this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === this.symbol().toUpperCase()),
  );

  /** A Technicals row's indicator, with that row's inputs, onto the chart — then show the chart. */
  addStudyFromTechnicals(study: StudyRef): void {
    this.addIndicator(study.id, study.params);
    this.technicalsOpen.set(false);
  }

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
  /** Strength used when the magnet is on — TradingView's Weak / Strong. */
  readonly magnetStrength = signal<'weak' | 'strong'>(readPref('magnetStrength', 'weak'));
  readonly magnetMenuOpen = signal(false);
  /** What the chart applies: off, or the chosen strength. */
  readonly magnetMode = computed(() => (this.magnet() ? this.magnetStrength() : 'off'));
  /** TV "Stay in drawing mode". */
  readonly stayInDrawing = signal<boolean>(readPref('stayInDrawing', false));
  /** Drawing whose Settings dialog is open. */
  readonly settingsFor = signal<string | null>(null);
  /** Right-click menu on a drawing (page-relative coordinates). */
  readonly drawingMenu = signal<{ id: string; x: number; y: number } | null>(null);
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

  /**
   * The left rail, grouped as TradingView groups it: one button per family, the rest of the
   * family in a flyout. Fifty-odd single buttons in a column was a scroll hunt.
   */
  readonly toolGroups = computed(() =>
    RAIL_LAYOUT.map((g) => {
      const sections = g.sections.map((sec) => ({
        title: sec.title,
        tools: sec.kinds.map((k) => toolFor(k)).filter((t): t is ToolSpec => !!t),
      }));
      return { name: g.id, title: g.title, sections, tools: sections.flatMap((sec) => sec.tools) };
    }),
  );
  readonly railStandalone = RAIL_STANDALONE.map((k) => toolFor(k)).filter(
    (t): t is ToolSpec => !!t,
  );

  /** Which tool each rail button currently shows — the family's last-used, as on TradingView. */
  readonly railPick = signal<Record<string, DrawingKind>>({});
  /** Group whose flyout is open, or null. */
  readonly railFlyout = signal<string | null>(null);
  /** Vertical offset of the open flyout, aligned to its rail button. */
  readonly railFlyoutTop = signal(0);

  railTool(group: { name: string; tools: readonly ToolSpec[] }): ToolSpec {
    const kind = this.railPick()[group.name];
    return group.tools.find((t) => t.kind === kind) ?? group.tools[0];
  }

  railGroupActive(group: { tools: readonly ToolSpec[] }): boolean {
    const t = this.tool();
    return t !== null && group.tools.some((x) => x.kind === t);
  }

  toggleRailFlyout(name: string, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.railFlyout() === name) {
      this.railFlyout.set(null);
      return;
    }
    const btn = (ev.currentTarget as HTMLElement).closest('.rail-slot') as HTMLElement | null;
    const rail = btn?.closest('.chart-body') as HTMLElement | null;
    if (btn && rail) {
      this.railFlyoutTop.set(btn.getBoundingClientRect().top - rail.getBoundingClientRect().top);
    }
    this.railFlyout.set(name);
  }

  pickRailTool(group: string, kind: DrawingKind): void {
    this.railPick.update((m) => ({ ...m, [group]: kind }));
    this.railFlyout.set(null);
    this.tool.set(kind);
  }

  closeRailFlyout(): void {
    this.railFlyout.set(null);
    this.magnetMenuOpen.set(false);
    this.drawingMenu.set(null);
    this.vpMenuOpen.set(false);
    this.openMenu.set(null);
    this.layoutMenuOpen.set(false);
  }

  /** Flyout contents for the open group. */
  readonly openRailGroup = computed(() => {
    const name = this.railFlyout();
    return name ? (this.toolGroups().find((g) => g.name === name) ?? null) : null;
  });

  setVolumeProfileMode(mode: VolumeProfileMode): void {
    this.volumeProfileMode.set(mode);
    this.showVolumeProfile.set(true);
    this.vpMenuOpen.set(false);
  }

  volumeProfileModeLabel(): string {
    return VOLUME_PROFILE_MODES.find((m) => m.id === this.volumeProfileMode())?.label ?? '';
  }

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

    // FX-fundamental studies: fetched per symbol, drawn as their own panes.
    effect(() => {
      const items = this.active().filter((a) => a.visible && studyKind(a.defId) === 'fundamental');
      const symbol = this.symbol();
      untracked(() => this.loadFundamentals(items, symbol));
    });

    // Compare studies need the other symbol's bars on the same resolution.
    effect(() => {
      const symbols = this.compareSymbols();
      const resolution = this.resolution();
      untracked(() => void this.loadCompareBars(symbols, resolution));
    });

    // A Pine run describes ONE symbol+timeframe; re-run on a switch rather than paint
    // another instrument's plots over this one.
    effect(() => {
      const symbol = this.symbol();
      const resolution = this.resolution();
      untracked(() => {
        const runs = this.scriptRuns();
        if (runs.some((r) => r.symbol !== symbol || r.resolution !== resolution)) {
          for (const r of runs) this.runScript(r.item, r.values, true);
        }
      });
    });

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
        ...(this.editorOpen() || this.scriptRuns().length ? pineEditorFacts(this.pineAdapter) : {}),
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

    // The Pine Editor: the assistant reads, edits, compiles and runs the operator's script live.
    this.uiCommands.register(pineAssistCommands(this.pineAdapter), this.destroyRef);

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
        bars: () => this.bars(),
        drawings: () => this.drawings.visible(),
        addDrawing: (kind, points, color) =>
          this.drawings.add(kind, points, {
            ...DEFAULT_STYLE,
            ...(toolFor(kind)?.defaultStyle ?? {}),
            ...(color ? { color } : {}),
          }).id,
        removeDrawing: (id) => this.drawings.remove(id),
        styleDrawing: (id, patch) => this.drawings.updateStyle(id, patch),
        setVisibleRange: (from, to) => this.host()?.setVisibleRange(from, to) ?? false,
        showLastBars: (n) => this.host()?.showLastBars(n) ?? false,
        fitContent: () => this.host()?.fitContent(),
        scrollToRealtime: () => this.host()?.scrollToRealtime(),
        resetScales: () => this.resetScales(),

        layouts: () => this.layoutStore.layouts(),
        // The toolbar's Save asks for a name through prompt(), which nothing outside the
        // browser can answer — so the store is called directly with the given name.
        saveLayout: (name) => this.layoutStore.saveLayout(name, this.snapshotOfChart()).id,
        applyLayout: (id) => {
          const found = this.layoutStore.layouts().find((l) => l.id === id);
          if (found) this.applyLayout(found);
        },
        removeLayout: (id) => this.layoutStore.removeLayout(id),
        studyTemplates: () =>
          this.layoutStore.templates().map((t) => ({
            id: t.id,
            name: t.name,
            count: t.indicators.length,
          })),
        saveStudyTemplate: (name) => {
          if (this.active().length === 0) return false;
          this.layoutStore.saveTemplate(name, this.active());
          return true;
        },
        applyStudyTemplate: (id) => {
          const found = this.layoutStore.templates().find((t) => t.id === id);
          if (found) this.applyTemplate(found);
        },
        removeStudyTemplate: (id) => this.layoutStore.removeTemplate(id),

        replay: () => ({
          active: this.replayActive(),
          index: this.replayIndex(),
          total: this.bars().length,
          playing: this.replayPlaying(),
          speed: this.replaySpeed(),
        }),
        startReplay: () => this.startReplay(),
        exitReplay: () => this.exitReplay(),
        stepReplay: (d) => this.stepReplay(d),
        toggleReplayPlay: () => this.toggleReplayPlay(),
        setReplaySpeed: (x) => this.setReplaySpeed(String(x)),
        setReplayIndex: (i) => this.setReplayIndex(String(i)),

        loadOlder: () => this.loadOlder(),
        eventImpact: () => this.minEventImpact(),
        setEventImpact: (v) => {
          this.minEventImpact.set(v);
          this.loadEvents();
        },
        sidePane: () => this.sidePane(),
        setSidePane: (v) => {
          // openSidePane TOGGLES, which cannot express "open the news pane" when it is
          // already open. Set the state outright and fire the same load it would have.
          this.sidePane.set(v);
          if (v === 'news') this.loadNews();
        },
        watchlistOpen: this.watchlistOpen,
        objectTreeOpen: this.objectTreeOpen,
        toggleFullscreen: () => this.toggleFullscreen(),
        isFullscreen: () => this.isFullscreen(),
        showVolumeProfile: this.showVolumeProfile,
        showSupportResistance: this.showSupportResistance,
        showStructure: this.showStructure,
        structureSummary: () => marketStructure(this.bars()).summary,
        // Computed on demand rather than held in a signal: the assistant asks rarely, and a
        // second copy of this would be a second thing that can disagree with the chart.
        srLevels: () => supportResistance(this.bars()),
        volumeProfile: () => {
          const p = profileWithValueArea(this.bars());
          return p
            ? { poc: p.poc, valueAreaLow: p.valueAreaLow, valueAreaHigh: p.valueAreaHigh }
            : null;
        },
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
        ...(this.watchlistOpen() ? this.watchlistSymbols() : []),
      ]);
      wanted.delete('');
      untracked(() => this.syncPriceSubscriptions(wanted));
    });

    // Ticking clock, and presets applied once their interval's bars are in.
    this.tickClock();
    const clockTimer = setInterval(() => this.tickClock(), 1000);
    this.destroyRef.onDestroy(() => clearInterval(clockTimer));
    effect(() => {
      this.bars();
      this.timezone();
      untracked(() => {
        this.tickClock();
        queueMicrotask(() => this.flushPendingRange());
      });
    });

    // Remember the dock state, and keep the headline under the watchlist on the current symbol.
    effect(() => {
      const open = this.watchlistOpen();
      try {
        localStorage.setItem(WATCHLIST_OPEN_KEY, open ? '1' : '0');
      } catch {
        // Per-viewer convenience only.
      }
    });
    effect(() => {
      const open = this.watchlistOpen();
      this.symbol();
      this.symbols();
      if (open && this.sidePane() !== 'news') untracked(() => this.loadNews());
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

    // Re-read the forming bar from M1 every minute. Ticks arrive throttled to ~1 Hz, so a spike
    // between two of them never reaches the live bar's high or low; and a bar that closed while the
    // page was open was built entirely from those throttled ticks. One small request a minute keeps
    // the newest candle honest without waiting for a reload.
    const resync = setInterval(() => void this.syncFormingBars(), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(resync));
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
      void this.realtime
        .leave(`price:${symbol}`, 'UnsubscribePrice', symbol)
        .catch(() => undefined);
    }
    for (const symbol of wanted) {
      if (this.subscribedSymbols.has(symbol)) continue;
      this.subscribedSymbols.add(symbol);
      // `join`, not `invoke`: the subscription is recorded and applied when the hub is up, and
      // re-applied after a reconnect. A plain invoke resolves with undefined when the connection
      // is not yet Connected — so the re-arm below never ran, the symbol stayed marked as
      // subscribed, and the page received no prices for the rest of its life. That is invisible on
      // localhost, where the hub connects before the chart asks, and reliable through a tunnel,
      // where it does not.
      void this.realtime.join(`price:${symbol}`, 'SubscribePrice', symbol).catch(() => {
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
      this.lastStored = lastCompleteBarTime(bars, this.resolution());
      // The history ends at the last CLOSED bar; build the one still forming from real data
      // rather than from whatever tick happens to arrive first.
      void this.syncFormingBars();
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

  /**
   * Time of the newest bar that is known to be COMPLETE in stored history. Every bar after it is
   * still forming, and is rebuilt from M1 rather than trusted.
   */
  private lastStored: number | null = null;

  /**
   * Rebuild the forming bar (and any closed bar the engine has not yet stored) from M1.
   *
   * <p>The engine writes a bar only once it has closed, so the newest bar is never in the history
   * and the chart had to invent it from live ticks — opening it at whatever price arrived first
   * after the page loaded. Load the chart mid-bar and the candle jumped away from the previous close,
   * with an open, high and low that covered seconds instead of the whole period. M1 trails the
   * market by at most a minute, so it gives the real ones.</p>
   *
   * <p>Ticks still move the close between syncs; this corrects everything else.</p>
   */
  private async syncFormingBars(): Promise<void> {
    const resolution = this.resolution();
    const symbol = this.symbol();
    const stored = this.lastStored;
    if (resolution === '1' || stored === null || this.bars().length === 0) return;

    const minutes = await this.feed.minuteBarsSince(symbol, stored + 1);
    if (!minutes || minutes.length === 0) return;
    // The operator may have switched symbol or timeframe while the request was in flight.
    if (symbol !== this.symbol() || resolution !== this.resolution() || stored !== this.lastStored)
      return;

    this.bars.set(mergeForming(this.bars(), foldBars(minutes, resolution), stored));
  }

  private applyTick(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    if (!tick?.symbol || tick.symbol.toUpperCase() !== this.symbol().toUpperCase()) return;
    const price = tick.bid ?? tick.price ?? tick.ask;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;

    const current = this.bars();
    if (current.length === 0) return;

    const last = current[current.length - 1];
    // The same bucketing the history uses. `floor(now / step)` put weekly bars on an
    // epoch-aligned week (which starts on a THURSDAY) and treated a month as a flat 31 days,
    // so on 1W and 1M a live tick could open a bar that no stored bar would ever line up with.
    const bucket = bucketStartFor(this.resolution(), Date.now());
    if (bucket === null) return;

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

  startDockResize(ev: PointerEvent): void {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = this.dockWidth();
    const move = (e: PointerEvent) =>
      this.dockWidth.set(Math.min(640, Math.max(240, startW + (startX - e.clientX))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(DOCK_WIDTH_KEY, String(this.dockWidth()));
      } catch {
        // Per-viewer convenience only.
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

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

  private async loadCompareBars(symbols: string[], resolution: TvResolution): Promise<void> {
    const now = Date.now();
    const next: Record<string, Bar[]> = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          next[sym] = (await this.feed.getBars(sym, resolution, 0, now, PAGE_BARS)).bars;
        } catch {
          // Unknown symbol: the study stays empty rather than failing the chart.
        }
      }),
    );
    // Drop the result if the operator moved on while it loaded.
    if (resolution !== this.resolution()) return;
    this.compareBars.set(next);
  }

  private fundamentalsRequest = 0;
  private loadFundamentals(items: ActiveIndicator[], symbol: string): void {
    const request = ++this.fundamentalsRequest;
    if (!items.length) {
      this.externalPanes.set([]);
      return;
    }
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    const one = (a: ActiveIndicator): Observable<ExternalPane> => {
      const id = fundamentalIdOf(a.defId);
      const pane = (lines: ExternalPane['lines']): ExternalPane => ({ uid: a.uid, lines });
      switch (id) {
        case 'rate-differential':
          return this.fundamentals
            .rateDifferential(symbol)
            .pipe(
              map((pts) =>
                pane([{ title: `${base}−${quote} rate %`, color: '#2962FF', points: pts }]),
              ),
            );
        case 'swap-carry':
          return from(this.dailyBars.daily(symbol)).pipe(
            switchMapTo((daily) => this.fundamentals.carryPanes(symbol, daily)),
            map((c) => {
              if (c.swapIssue) this.scriptError.set(`Swap / carry: ${c.swapIssue}`);
              return pane([
                { title: 'Swap long / lot', color: '#26A69A', points: c.swapLong },
                { title: 'Swap short / lot', color: '#EF5350', points: c.swapShort },
              ]);
            }),
          );
        case 'news-pressure':
          return this.fundamentals
            .newsPressureDifference(base, quote)
            .pipe(
              map((pts) =>
                pane([
                  { title: `News ${base}−${quote}`, color: '#AB47BC', points: pts, precision: 3 },
                ]),
              ),
            );
        case 'economic-surprise': {
          const side = String(a.params['side'] ?? 'base − quote');
          const halfLifeDays = Number(a.params['halfLifeDays'] ?? 30);
          const series = (ccy: string) => this.fundamentals.surpriseIndex(ccy, { halfLifeDays });
          const pts$: Observable<PanePoint[]> =
            side === 'base'
              ? series(base)
              : side === 'quote'
                ? series(quote)
                : forkJoin([series(base), series(quote)]).pipe(
                    map(([x, y]) => stepDifference(x, y)),
                  );
          return pts$.pipe(
            map((pts) =>
              pane([
                {
                  title: `Surprise ${side === 'base − quote' ? `${base}−${quote}` : side === 'base' ? base : quote}`,
                  color: '#FF6D00',
                  points: pts,
                },
              ]),
            ),
          );
        }
        default:
          return of(pane([]));
      }
    };
    forkJoin(
      items.map((a) =>
        one(a).pipe(
          catchError((err: unknown) => {
            const title = FUNDAMENTAL_PANES.find((f) => f.id === fundamentalIdOf(a.defId))?.title;
            this.scriptError.set(
              `${title ?? a.defId}: ${err instanceof Error ? err.message : 'unavailable'}`,
            );
            return of({ uid: a.uid, lines: [] } as ExternalPane);
          }),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((panes) => {
        if (request === this.fundamentalsRequest) this.externalPanes.set(panes);
      });
  }

  openStudiesDialog(tab: DialogTab = 'indicators'): void {
    this.dialogTab.set(tab);
    this.indicatorMenuOpen.set(true);
    if (!this.scriptCatalog()) {
      this.chartScripts
        .listItems()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((cat) => this.scriptCatalog.set(cat));
    }
  }

  private scriptItemByKey(key: string): ChartScriptItem | null {
    const cat = this.scriptCatalog();
    if (!cat) return null;
    return [...cat.mine, ...cat.strategies, ...cat.examples].find((i) => i.key === key) ?? null;
  }

  onDialogPick(item: DialogItem): void {
    if (item.kind === 'strategy' || item.kind === 'script') {
      const script = this.scriptItemByKey(item.id);
      if (script) this.runScript(script, {});
      this.indicatorMenuOpen.set(false);
      return;
    }
    if (!studyMeta(item.id)) {
      // Listed for completeness (e.g. COT) but there is no data behind it.
      this.scriptError.set(`${item.name}: ${item.description ?? 'not available'}`);
      this.indicatorMenuOpen.set(false);
      return;
    }
    this.addIndicator(item.id);
  }

  /** Run a Pine script/strategy over the loaded window and paint it. */
  runScript(
    item: ChartScriptItem,
    values: ScriptInputValues,
    replace = false,
    done?: (r: ChartScriptResult | { error: string }) => void,
  ): void {
    this.scriptRunning.set(true);
    this.scriptError.set(null);
    const symbol = this.symbol();
    const resolution = this.resolution();
    this.chartScripts
      .runOnChart(item, symbol, resolution, values, Math.min(this.bars().length || PAGE_BARS, 5000))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.scriptRunning.set(false);
          // A run for a symbol the operator has since left is stale.
          if (symbol !== this.symbol() || resolution !== this.resolution()) {
            done?.({ error: 'The chart moved to another symbol or timeframe during the run.' });
            return;
          }
          if (result.error) {
            this.scriptError.set(`${item.name}: ${result.error}`);
            done?.({ error: result.error });
            return;
          }
          this.scriptRuns.update((runs) => {
            // One strategy at a time (its tester owns the bottom panel); a re-run replaces.
            const kept = runs.filter(
              (r) =>
                r.item.key !== item.key &&
                !(result.kind === 'strategy' && r.result.kind === 'strategy'),
            );
            return [...kept, { item, result, values, symbol, resolution }];
          });
          if (result.kind === 'strategy' && !replace) {
            this.testerOpen.set(true);
            this.dockPreference.set('tester');
          }
          done?.(result);
        },
        error: (err: unknown) => {
          this.scriptRunning.set(false);
          done?.({ error: err instanceof Error ? err.message : 'run failed' });
          this.scriptError.set(
            `${item.name}: ${err instanceof Error ? err.message : 'run failed'}`,
          );
        },
      });
  }

  /** Frame a strategy trade on the chart (List of trades click), TradingView-style. */
  focusTrade(t: ChartTrade): void {
    const step = (resolutionMs(this.resolution()) ?? 3_600_000) / 1000;
    const w = tradeWindow(t, step, Math.floor(Date.now() / 1000));
    this.host()?.glideToRange(w.fromMs, w.toMs);
  }

  rerunStrategy(values: ScriptInputValues): void {
    const run = this.strategyRun();
    if (run) this.runScript(run.item, values, true);
  }

  removeScript(key: string): void {
    this.scriptRuns.update((runs) => runs.filter((r) => r.item.key !== key));
  }

  onEditorAdd(submit: ScriptEditorSubmit): void {
    // Editing a script that is on the chart updates it in place (the edited copy replaces it).
    const replacing = this.editorTarget();
    if (replacing) this.removeScript(replacing.key);
    const item = this.chartScripts.itemForSource(submit.source, submit.kind, submit.name);
    this.editorKey.set(item.key);
    this.runScript(item, {});
  }

  onEditorSaved(): void {
    // Refresh "My scripts" in the dialog.
    this.chartScripts
      .listItems()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((cat) => this.scriptCatalog.set(cat));
  }

  /** Add a study; `params` override its defaults. The same study with the same inputs is not added twice. */
  addIndicator(defId: string, params?: Record<string, number | string>): void {
    if (!studyMeta(defId)) return;
    const merged = { ...studyDefaults(defId), ...params };
    const same = (a: Record<string, number | string>) =>
      Object.keys(merged).every((k) => a[k] === merged[k]);
    if (params && this.active().some((i) => i.defId === defId && same(i.params))) {
      this.indicatorMenuOpen.set(false);
      return;
    }
    this.active.update((list) => [
      ...list,
      {
        uid: `${defId}-${Date.now().toString(36)}-${list.length}`,
        defId,
        params: merged,
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
    const item = this.active().find((i) => i.uid === uid);
    const input = item ? studyMeta(item.defId)?.inputs.find((i) => i.key === key) : undefined;
    // Select and symbol inputs are strings; everything else must parse as a number.
    let value: number | string;
    if (input && (input.type === 'select' || input.type === 'symbol')) {
      value = input.type === 'symbol' ? raw.trim().toUpperCase() : raw;
      if (!value) return;
    } else {
      value = Number(raw);
      if (!Number.isFinite(value)) return;
    }
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, params: { ...i.params, [key]: value } } : i)),
    );
  }

  labelFor(item: ActiveIndicator): string {
    return studyLabel(item.defId, item.params);
  }

  inputsFor(item: ActiveIndicator) {
    return studyMeta(item.defId)?.inputs.filter((i) => i.type !== 'source') ?? [];
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
    this.createAlertAt(price);
  }

  /** Create a PriceLevel alert at `price`, above or below the last close. */
  createAlertAt(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;

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

  toggleMagnetMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    this.railFlyout.set(null);
    if (this.magnetMenuOpen()) {
      this.magnetMenuOpen.set(false);
      return;
    }
    const btn = (ev.currentTarget as HTMLElement).closest('.rail-slot') as HTMLElement | null;
    const body = btn?.closest('.chart-body') as HTMLElement | null;
    if (btn && body)
      this.railFlyoutTop.set(btn.getBoundingClientRect().top - body.getBoundingClientRect().top);
    this.magnetMenuOpen.set(true);
  }

  setMagnetStrength(mode: 'weak' | 'strong'): void {
    this.magnetStrength.set(mode);
    this.magnet.set(true);
    this.magnetMenuOpen.set(false);
    writePref('magnetStrength', mode);
  }

  toggleStayInDrawing(): void {
    this.stayInDrawing.set(!this.stayInDrawing());
    writePref('stayInDrawing', this.stayInDrawing());
  }

  openDrawingMenu(e: { id: string; clientX: number; clientY: number }, area: HTMLElement): void {
    this.contextMenu.set(null);
    const r = area.getBoundingClientRect();
    this.drawingMenu.set({ id: e.id, x: e.clientX - r.left, y: e.clientY - r.top });
  }

  /** Drawing context-menu / More-menu actions (TradingView's set). */
  drawingAction(
    id: string,
    action: 'settings' | 'clone' | 'copy' | 'hide' | 'lock' | 'remove' | ZOrderOp,
  ): void {
    this.drawingMenu.set(null);
    switch (action) {
      case 'settings':
        this.settingsFor.set(id);
        break;
      case 'clone': {
        const c = this.drawings.clone(id);
        if (c) this.drawings.selectedId.set(c.id);
        break;
      }
      case 'copy':
        this.drawings.copy(id);
        break;
      case 'hide':
        this.drawings.setHidden(id, true);
        this.drawings.selectedId.set(null);
        break;
      case 'lock':
        this.drawings.toggleLock(id);
        break;
      case 'remove':
        this.drawings.remove(id);
        break;
      default:
        this.drawings.reorder(id, action);
    }
  }

  drawingById(id: string): Drawing | undefined {
    return this.drawings.allDrawings().find((d) => d.id === id);
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

    // The Technicals view covers the chart: Esc returns to it, and no chart shortcut acts
    // on drawings the operator cannot see.
    if (this.technicalsOpen()) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.technicalsOpen.set(false);
      }
      return;
    }

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
    if (mod && ev.key.toLowerCase() === 'c' && !ev.shiftKey) {
      const id = this.drawings.selectedId();
      if (id && !window.getSelection()?.toString()) {
        ev.preventDefault();
        this.drawings.copy(id);
      }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'v' && !ev.shiftKey) {
      if (this.drawings.hasClipboard) {
        ev.preventDefault();
        this.host()?.pasteDrawing();
      }
      return;
    }
    if (ev.key === 'Enter' && this.tool()) {
      if (this.host()?.finishDrawing()) ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      // TV: Esc first abandons a drawing in progress and drops the tool, then
      // clears the selection.
      this.host()?.cancelDrawing();
      this.railFlyout.set(null);
      this.magnetMenuOpen.set(false);
      this.drawingMenu.set(null);
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
    if (ev.key.startsWith('Arrow') && this.drawings.selectedId() && !mod) {
      // Nudge: one bar sideways / one pixel vertically; Shift ×10.
      const k = ev.shiftKey ? 10 : 1;
      const bars = ev.key === 'ArrowLeft' ? -k : ev.key === 'ArrowRight' ? k : 0;
      const px = ev.key === 'ArrowUp' ? -k : ev.key === 'ArrowDown' ? k : 0;
      if (this.host()?.nudgeSelectedDrawing(bars, px)) ev.preventDefault();
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

/** Small per-browser drawing preferences (magnet strength, stay-in-drawing). */
function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`lascodia.chart.pref.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`lascodia.chart.pref.${key}`, JSON.stringify(value));
  } catch {
    /* preference not remembered */
  }
}
