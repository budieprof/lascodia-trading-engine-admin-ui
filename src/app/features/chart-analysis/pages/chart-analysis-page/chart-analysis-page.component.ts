import {
  consolidatedId,
  isConsolidatedId,
  type MdSource,
} from '@core/realtime/marketdata.types';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  forwardRef,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import {
  clampSize,
  loadDockLayout,
  saveDockLayout,
  type DockLayout,
  type DockMode,
} from './dock-layout';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { CurrencyPairDto } from '@core/api/api.types';
import { CandleFeedService, type Bar } from '../../datafeed/candle-feed.service';
import { barCloseMs, sameSeries, type SeriesId } from '../../scripts/live-bar';
import { ThemeService } from '@core/theme/theme.service';

import {
  SUPPORTED_RESOLUTIONS,
  formatResolution,
  isSessionResolution,
  isSupportedResolution,
  parseInterval,
  resolutionMs,
  type TvResolution,
} from '../../datafeed/resolution';
import { currentDayBars } from '../../datafeed/session-bars';
import { TradingCalendar, type SessionSpec } from '../../datafeed/session-calendar';
import { tickPrice, tickTimeMs, type PriceTick } from '../../datafeed/live-tick';
import { ServerClock } from '@core/time/server-clock';
import { tradingDateLabel } from '../../chart/trading-date';
import { priceScaleFor } from '../../datafeed/symbol-info';
import {
  decimalsOfPrices,
  instrumentFacts,
  sameFacts,
  type InstrumentFacts,
} from '../../datafeed/instrument-facts';
import { InstrumentsService } from '@core/instruments/instruments.service';
import { venueInstrumentFor } from '@features/venues/venues.logic';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { InstrumentIconComponent } from '../../watchlist/instrument-icon.component';
import { changeText, formatVolume } from '../../chart/legend-format';
import { StrategiesService } from '@core/services/strategies.service';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingToolbarComponent } from '../../drawings/ui/drawing-toolbar.component';
import type { ZOrderOp } from '../../drawings/drawing-ops';
import {
  WatchlistPanelComponent,
  type WatchHeadline,
} from '../../watchlist/watchlist-panel.component';
import { TechnicalsViewComponent } from '../../panels/technicals-view.component';
import { SeasonalsViewComponent } from '../../panels/seasonals-view.component';
import { NewsAnalysisModalComponent } from '../../panels/news-analysis-modal.component';
import type { StudyRef } from '../../panels/technicals';
import { IndicatorsDialogComponent } from '../../dialog/indicators-dialog.component';
import type { DialogItem, DialogTab } from '../../dialog/dialog-items';
import {
  studyDefaults,
  studyDialogItems,
  studyKind,
  studyLabel,
  studyMeta,
} from '../../studies';
import { FxFundamentalsService } from '../../panels/fx-fundamentals.service';
import { DailyBarsService } from '../../panels/daily-bars.service';
import type { ChartViewState } from '../../chart/chart-host.component';
import { ChartFundamentalsLoader } from './chart-fundamentals-loader';
import { map } from 'rxjs';
import {
  ChartScriptService,
  editorRunKey,
  savedScriptId,
  startingValues,
  type ChartScriptCatalog,
  type ChartScriptItem,
} from '../../scripts/chart-script.service';
import type { ScriptChip } from '../../scripts/script-chip.component';
import {
  displayOverrides,
  resolveDisplay,
  styleOutputsOf,
  type ScriptDisplaySettings,
} from '../../scripts/script-display';
import { scriptRenderModel } from '../../scripts/script-model-cache';


import { ScriptingRealtimeService } from '@core/realtime/scripting-realtime.service';
import { ScriptingService } from '@core/services/scripting.service';
import type { ScriptSessionFrame } from '@core/api/scripting.types';
import {
  ChartScriptAlertFormComponent,
  type ScriptAlertTarget,
} from '../../alerts/chart-script-alert-form.component';
import type { ChartScriptAlertDto } from '../../alerts/chart-script-alerts.types';
import {
  ScriptSettingsDialogComponent,
  type InputPick,
} from '../../scripts/script-settings-dialog.component';
import { ChartBottomBarComponent, type BottomBarMenu } from './chart-bottom-bar.component';
import type { ChartScriptResult, ChartTrade } from '../../scripts/chart-script.model';
import { tradeWindow } from '../../scripts/trade-detail';
import { chartPineAdapter } from '../../scripts/chart-pine-adapter';
import {
  detectScriptKind,
  runTimeframeFor,
  scriptBasisOf,
  type ScriptBasis,
} from '../../scripts/chart-script.model';
import {
  pineAssistCommands,
  pineEditorFacts,
  type PineEditorAdapter,
} from '@shared/pine-assist/pine-assist';
import { firstValueFrom } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { AssistantDockService } from '@core/assistant/assistant-dock.service';
import type { ScriptInputValues } from '@core/api/scripting.types';
import { parseSavedInputs } from '@features/scripting/pine/pine-inputs';
import { ScriptSettings } from '../../scripts/script-settings';
import {
  StrategyTesterPanelComponent,
  type TradeReveal,
} from '../../scripts/strategy-tester-panel.component';
import {
  ScriptLogsPanelComponent,
  type LogsRunRequest,
} from '../../scripts/script-logs-panel.component';
import { backtestTimeframeOf, type DeepBacktestTarget } from '../../scripts/tester-trades';
import { UndoNoticeComponent } from '../../scripts/undo-notice.component';

import {
  REPLAY_AHEAD,
  chartScriptLayers,
  hiddenOnTimeframe,
  replayLag,
  sameLayers,
  type ChartScriptLayer,
} from '../../scripts/script-layers';
import { inputsSummary, type ScriptAction } from '../../scripts/script-status';
import {
  ScriptEditorPanelComponent,
  type ScriptEditorSubmit,
} from '../../scripts/script-editor-panel.component';
import {
  INDICATORS,
  defaultParams,
  indicatorById,
} from '../../indicators/registry';
import {
  ChartHostComponent,
  type ActiveIndicator,
  type ChartStyle,
  type LegendSnapshot,
  type ScaleMode,
} from '../../chart/chart-host.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { PositionsService } from '@core/services/positions.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ChartEventsService } from '../../overlays/chart-events.service';
import { ChartEventsState } from './chart-events-state';
import { ChartAlertsService } from '../../alerts/chart-alerts.service';
import { MarketPanesService } from '../../panels/market-panes.service';
import { volumeStudyNote } from '../../indicators/volume-labels';
import {
  exchangeSessionsNote,
  exchangeSessionsOf,
  type ExchangeSessions,
} from '../../indicators/exchange-sessions';
import { ChartAlertFormComponent } from '../../alerts/chart-alert-form.component';
import { ChartAlertManagerComponent } from '../../alerts/chart-alert-manager.component';
import { ObjectTreeComponent } from '../../drawings/ui/object-tree.component';
import {
  StudySettingsDialogComponent,
  type StudyPick,
} from '../../indicators/study-settings-dialog.component';
import { DrawingFavorites } from '../../drawings/drawing-favorites.service';
import { FavoritesBarComponent } from '../../drawings/ui/favorites-bar.component';
import { PatternScorecardDialogComponent } from '../../patterns/scorecard-dialog.component';
import type { CandleTrendFilter } from '../../patterns/candlestick-patterns';
import type { AutoAnalysisSettings } from '../../overlays/auto-analysis';
import { positionAccountFacts, positionOrderPrefill } from '../../drawings/position-link';
import {
  parseStudyInput,
  parseStudySource,
} from '../../indicators/study-settings';
import { ChartAlertsController } from './chart-alerts-controller';
import { OrdersService } from '@core/services/orders.service';
import { MartingaleService } from '@core/services/martingale.service';
import { NewsIntelService } from '@core/services/news-intel.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { UiCommandService } from '@core/assistant/ui-command.service';
import { chartCommands } from '../../chart-commands';
import {
  profileWithValueArea,
  supportResistance,
  VOLUME_PROFILE_MODES,
  type VolumeProfileMode,
} from '../../overlays/analysis-overlays';
import { marketStructure } from '../../overlays/market-structure';
import type { AlertableLevel } from '../../overlays/overlay-hits';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import {
  closedTradeMarkers,
  concernsSymbol,
  orderLines,
  positionLines,
  type LiveQuote,
} from '../../overlays/trade-layer';
import type { ChartMarker } from '../../chart/chart-host.component';
import {
  CHART_TIMEZONES,
  timezoneOffsetMinutes,
  ChartLayoutStore,
} from '../../workspace/layout-store.service';
import { ChartWorkspaceSync } from '../../workspace/workspace-sync.service';
import { EconomicEventModalComponent } from '../../panels/economic-event-modal.component';
import { headlineAge, type NewsArticleIngestedPayload } from '../../panels/news-pane';
import { ChartNewsPane } from './chart-news-pane';
import { ReplayController } from '../../replay/replay-controller';
import { ChartDrawingRailComponent } from './chart-drawing-rail.component';
import { ChartPanelStripComponent } from './chart-panel-strip.component';
import { ChartLegendComponent } from './chart-legend.component';
import { ChartOverlaysMenuComponent } from './chart-overlays-menu.component';
import { ChartContextMenusComponent } from './chart-context-menus.component';
import { ChartSidePaneComponent } from './chart-side-pane.component';
import { ChartStudiesStripComponent } from './chart-studies-strip.component';
import type { UiCommand } from '@core/assistant/ui-command.types';
import { buildPaletteActions, type PaletteAction } from '../../palette/chart-palette';
import { ChartPaletteComponent } from '../../palette/chart-palette.component';
import {
  comparePanes,
  compareSymbolsOf,
  compareTitle,
  restoredCompare,
  type CompareSeriesSpec,
} from '../../compare/compare-series';
import { CompareDialogComponent } from '../../compare/compare-dialog.component';
import { sharedRun } from '../../workspace/chart-panels';
import { restoredAppearance, type ChartAppearance } from '../../chart/appearance';
import {
  recalled,
  rememberSymbol,
  restoredSymbolMemory,
  type SymbolMemory,
} from '../../workspace/symbol-memory';
import {
  ChartSettingsDialogComponent,
  type ChartSettings,
} from '../../chart/chart-settings-dialog.component';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { ChartLayoutActions } from './chart-layout-actions';
import type { UndoableChart } from '../../workspace/undo-history';
import { ReplayScriptSessions } from '../../replay/replay-script-sessions';
import { ScriptingRunService } from '@shared/pine-chart/api/scripting-run.service';

import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { ReplayPanelComponent } from '../../replay/replay-panel.component';
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import type { SidePanel } from '../../panels/side/chart-panels.types';
import { ChartPrefsService } from '../../workspace/chart-prefs.service';
import { ChartTradingComponent } from '../../trading/chart-trading.component';
import { ChartAnalysisComponent } from '../../analysis/chart-analysis.component';
import { ChartTradeTimeline } from './chart-trade-timeline';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { TicketPrefill } from '../../trading/ticket-model';
import {
  WORKSPACE_VERSION,
  dockStateOf,
  linkGroupOf,
  migrateWorkspaceState,
  restoredDock,
  restoredPriceBased,
  restoredScriptItem,
  restoredSync,
  workspaceScriptOf,
  type ChartPanelState,
  type ChartSync,
  type ChartWorkspaceState,
  type DockView,
  type WorkspaceScript,
} from '../../workspace/workspace-state';
import { drawingTemplates } from '../../drawings/drawing-templates';
import {
  DEFAULT_STYLE,
  TOOLS,
  toolFor,
  type DashStyle,
  type Drawing,
  type DrawingKind,
} from '../../drawings/model';
import { appStorage } from '@core/storage/app-storage';
import { OrderFlowFeed } from '../../orderflow/orderflow-feed';
import { footprintRowChoices } from '../../orderflow/tick-flow';
import { sourceCarries } from '../../orderflow/flow-source';
import type { OrderBookSnapshot } from '../../panels/side/chart-panels.types';
import { bookToSnapshot } from '../../orderflow/stream-depth';
import { footprintRowsFromTape } from '../../replay/tick-replay';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { replayClipUtc } from '../../orderflow/orderflow-replay';
import { orderFlowCount } from '../../orderflow/orderflow.types';

/** A Pine script's latest run on the chart. */
export interface ChartScriptRun {
  item: ChartScriptItem;
  result: ChartScriptResult;
  /**
   * The input overrides the script runs with. Set from its Settings dialog at once, so while a
   * run with new values is in flight they are ahead of `result`; every later run takes them.
   */
  values: ScriptInputValues;
  /** The series the run was computed over. */
  symbol: string;
  resolution: TvResolution;
  /** Bars this run asked for — history loaded past it triggers a re-run. */
  requestedBars: number;
  /** How it is shown (eye, Style, Visibility): what differs from the defaults; saved with the layout. */
  display?: Partial<ScriptDisplaySettings>;
  /** When this run landed (client ms): how old the chart's run is when a re-run fails. */
  landedAt?: number;
  /** The bars it was computed on (PC-09): Heikin-Ashi or standard; absent = standard. */
  chartType?: ScriptBasis;
  /**
   * The Bar Replay head it was run to — that bar's open, Unix ms (PC-08): its last bar is at or
   * before it. Absent: run to now.
   */
  until?: number;
}

/** One of a multi-chart layout's other charts (CC-12, CC-I5). */
export type { ComparePanel } from '../../compare/split-panels.controller';

import {
  RESOLUTION_GROUPS,
  STYLE_GROUPS,
  STYLE_STUDY,
  CHART_STYLES,
  PAGE_BARS,
  MAX_SCRIPT_BARS,
  WATCHLIST_OPEN_KEY,
  DOCK_WIDTH_KEY,
  loadDockWidth,
  loadWatchlistOpen,
  DRAWING_HOTKEYS,
  CHART_HOTKEYS,
  type ToolbarMenu,
  type StyleChoice,
} from './chart-page.config';
import { ChartSessionStore } from './chart-session-store';
import { ChartTimeNavigator } from './chart-time-navigator';
import { ChartOverlaySettings } from './chart-overlay-settings';
import { ChartDrawingTools } from './chart-drawing-tools';
import { ChartDockState } from './chart-dock-state';
import { ChartEditorState } from './chart-editor-state';
import {
  ChartScriptEngine,
  type RunOutcome,
  type ScriptEngineHost,
  type ScriptUpdate,
} from './chart-script-engine';
import { ChartCompareState } from './chart-compare-state';
import { freshRuns, normaliseView, scaleAfterCompare, withAlpha } from './chart-page.helpers';
import { MarketSessionService } from '../../datafeed/market-session.service';
import { volumeUnitTag, type VolumeKind } from '../../datafeed/chart-facts';
import { FuturesRollsService } from '../../datafeed/futures-rolls.service';
import { ChartSeriesAdjustments } from './chart-series-adjustments';
import { intervalNote, noDataMessage } from '../../datafeed/data-availability';
import {
  panelCandidates,
  panelLook,
  panelSymbolGroups,
  PANEL_SCALES,
  restoredPanelView,
  type PanelView,
} from '../../compare/split-panels';
import { PanelStateComponent } from '../../compare/panel-state.component';
import {
  SPLIT_LAYOUTS,
  SplitPanelsController,
  type ComparePanel,
  type SplitLayoutId,
} from '../../compare/split-panels.controller';
import { ChartAnnouncer } from './chart-announcer';
import { TradeLayersLoader } from './trade-layers-loader';
import { ChartScheduler, browserSchedulerEnv } from './chart-scheduler';
import {
  ASSET_CLASS_NAME,
  AssetClassDefaultsService,
  defaultOnSwitch,
} from '../../workspace/asset-class-defaults';
import {
  parseSynthetic,
  syntheticNotice,
  syntheticSymbol,
  syntheticTitle,
  SyntheticTicks,
  type SyntheticSpec,
} from '../../compare/synthetic';
import { ChartSymbolSearch } from './chart-symbol-search';
import { ChartLinkedCharts } from './chart-linked-charts';
import { ChartUndoController } from './chart-undo-controller';
import { marketView, type MarketView } from '../../datafeed/market-status';
import {
  instrumentDescription,
  instrumentKindLabel,
  symbolChips,
  type SymbolChip,
} from '../../datafeed/symbol-chips';

/** Re-exported for existing importers; the function lives in chart-page.helpers.ts. */
export { normaliseView };

@Component({
  selector: 'app-chart-analysis-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PanelStateComponent,
    InstrumentIconComponent,
    DecimalPipe,
    ModalA11yDirective,
    ChartHostComponent,
    ChartTradingComponent,
    ChartAnalysisComponent,
    IndicatorsDialogComponent,
    ChartIconComponent,
    DrawingToolbarComponent,
    WatchlistPanelComponent,
    StrategyTesterPanelComponent,
    ScriptLogsPanelComponent,
    ScriptEditorPanelComponent,
    ScriptSettingsDialogComponent,
    ChartBottomBarComponent,
    TechnicalsViewComponent,
    SeasonalsViewComponent,
    NewsAnalysisModalComponent,
    EconomicEventModalComponent,
    UndoNoticeComponent,
    ChartAlertFormComponent,
    ChartAlertManagerComponent,
    ObjectTreeComponent,
    StudySettingsDialogComponent,
    FavoritesBarComponent,
    PatternScorecardDialogComponent,
    ChartScriptAlertFormComponent,
    ReplayPanelComponent,
    ChartSettingsDialogComponent,
    ChartPaletteComponent,
    CompareDialogComponent,
    ChartOverlaysMenuComponent,
    ChartDrawingRailComponent,
    ChartPanelStripComponent,
    ChartLegendComponent,
    ChartContextMenusComponent,
    ChartSidePaneComponent,
    ChartStudiesStripComponent,
  ],
  // The template's sections (rail, strip, legend, menus, side pane, studies) render this page's state.
  // US02: each template section gets its slice of the page, not the page.
  providers: [
    // US02b: the main series, for the sections that show it.
    {
      provide: ChartSessionStore,
      useFactory: (page: ChartAnalysisPageComponent) => page.session,
      deps: [forwardRef(() => ChartAnalysisPageComponent)],
    },
    {
      provide: ChartOverlaySettings,
      useFactory: (page: ChartAnalysisPageComponent) => page.overlaySettings,
      deps: [forwardRef(() => ChartAnalysisPageComponent)],
    },
    {
      provide: ChartDrawingTools,
      useFactory: (page: ChartAnalysisPageComponent) => page.drawingTools,
      deps: [forwardRef(() => ChartAnalysisPageComponent)],
    },
  ],
  templateUrl: './chart-analysis-page.component.html',
  styleUrl: './chart-analysis-page.component.scss',
  host: {
    '(keydown)': 'onKeydown($event)',
    '(document:click)': 'closeRailFlyout()',
    tabindex: '0',
    // The shell gives a fill-height page the height its breadcrumbs leave (LayoutComponent).
    class: 'fill-height',
  },
})
export class ChartAnalysisPageComponent {
  private readonly pairs = inject(CurrencyPairsService);
  /** The instrument catalogue (multi-asset WS7): the symbol search lists every asset class it holds. */
  private readonly instruments = inject(InstrumentsService);
  private readonly feed = inject(CandleFeedService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pageContext = inject(PageContextService);
  private readonly uiCommands = inject(UiCommandService);
  private readonly chartScripts = inject(ChartScriptService);
  private readonly theme = inject(ThemeService);
  /** b9-maint: the fundamental studies' panes ({@link ChartFundamentalsLoader}). */
  private readonly fundamentalPanes = new ChartFundamentalsLoader({
    paneScope: () => this.paneScope(),
    bars: () => this.bars(),
    scriptError: () => this.scriptError,
    fundamentals: inject(FxFundamentalsService),
    dailyBars: inject(DailyBarsService),
    marketPanes: inject(MarketPanesService),
    destroyRef: this.destroyRef,
  });
  /**
   * The engine's clock, for "is the newest bar's period still open" on the session grid: its
   * periods' opens and closes are the engine's instants, and a browser clock a few seconds off would
   * roll a bar early or late (the countdown reads the same clock).
   */
  private readonly serverClock = inject(ServerClock);
  private readonly mdApi = inject(MarketDataApiService);
  /** PC-I1: warm sessions' frames (`/api/hubs/scripting`), and their resync and end calls. */
  private readonly scriptHub = inject(ScriptingRealtimeService);
  private readonly scriptingApi = inject(ScriptingService);

  /** Fetched FX-fundamental series, keyed by the study's uid. */
  readonly externalPanes = this.fundamentalPanes.panes;

  private readonly host = viewChild<ChartHostComponent>('host');

  readonly resolutions = SUPPORTED_RESOLUTIONS;
  /** The catalogue row of `symbol` (C2), or null while unknown / not in the master. */
  private catalogueRow(symbol: string): InstrumentDto | null {
    return this.instruments.lookupState(symbol) === 'found' ? this.instruments.get(symbol) : null;
  }
  /** UD10: the interval menu's note for `resolution` on this symbol — "no data yet", "no stored bars" — or null. */
  intervalNote(resolution: TvResolution): string | null {
    const symbol = this.symbol();
    return intervalNote({
      instrument: this.catalogueRow(symbol),
      firstBarMs: this.feed.firstBarOf(symbol, resolution),
    });
  }
  readonly resolutionLabel = (r: TvResolution) => formatResolution(r);
  readonly chartStyles = CHART_STYLES;
  readonly chartStyleGroups = STYLE_GROUPS;
  readonly resolutionGroups = RESOLUTION_GROUPS;

  /** One open toolbar menu at a time, as in TradingView. */
  readonly openMenu = signal<ToolbarMenu | null>(null);

  // ── Intervals (CC-I8) ────────────────────────────────────────────────────

  /** Starred intervals, shown as buttons beside the interval menu (synced chart preference). */
  readonly favouriteIntervals = signal<TvResolution[]>(
    readPref<TvResolution[]>('favouriteIntervals', []),
  );
  isFavourite(r: TvResolution): boolean {
    return this.favouriteIntervals().includes(r);
  }
  toggleFavourite(r: TvResolution, ev: Event): void {
    ev.stopPropagation();
    const order = (x: TvResolution) => resolutionMs(x) ?? Number.MAX_SAFE_INTEGER;
    const next = this.isFavourite(r)
      ? this.favouriteIntervals().filter((x) => x !== r)
      : [...this.favouriteIntervals(), r].sort((a, b) => order(a) - order(b));
    this.favouriteIntervals.set(next);
    writePref('favouriteIntervals', next);
  }

  /** The interval being typed (TradingView's "change interval": type 45, 3h, 2D on the chart). */
  readonly intervalDraft = signal('');
  readonly intervalError = signal<string | null>(null);
  private readonly intervalInput = viewChild<ElementRef<HTMLInputElement>>('intervalInput');

  /** Apply the typed interval: any the engine can lay out, not only the menu's. */
  submitInterval(): void {
    const parsed = parseInterval(this.intervalDraft());
    if (typeof parsed === 'string') {
      this.intervalDraft.set('');
      this.intervalError.set(null);
      this.openMenu.set(null);
      this.selectResolution(parsed);
      return;
    }
    this.intervalError.set(parsed?.error ?? 'Not an interval: try 45, 3h, 2D or 1W.');
  }

  /** A digit typed on the chart opens the interval box with it, as on TradingView. */
  private openIntervalBox(first: string): void {
    this.intervalDraft.set(first);
    this.intervalError.set(null);
    this.openMenu.set('interval');
    setTimeout(() => {
      const el = this.intervalInput()?.nativeElement;
      el?.focus();
      el?.setSelectionRange(first.length, first.length);
    });
  }
  toggleMenu(menu: ToolbarMenu, ev: Event): void {
    ev.stopPropagation();
    this.layoutMenuOpen.set(false);
    this.symbolMenuOpen.set(false);
    this.openMenu.set(this.openMenu() === menu ? null : menu);
  }

  /** The symbol search and the layouts menu: one toolbar menu open at a time, as with {@link toggleMenu}. */
  toggleSymbolMenu(ev: Event): void {
    ev.stopPropagation();
    const open = !this.symbolMenuOpen();
    this.closeRailFlyout();
    this.symbolMenuOpen.set(open);
  }

  toggleLayoutMenu(ev: Event): void {
    ev.stopPropagation();
    const open = !this.layoutMenuOpen();
    this.closeRailFlyout();
    this.layoutMenuOpen.set(open);
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
        this.showPositions(),
        this.showOrders(),
        this.showOverlays(),
        this.showEvents(),
        this.showVolumeProfile(),
        this.showSupportResistance(),
        this.showStructure(),
        this.deltaOn(),
      ].filter(Boolean).length + orderFlowCount(this.orderFlow()),
  );

  /** b9-maint: price alerts — form, manager, alert lines ({@link ChartAlertsController}); the template reads `alerts`. */
  readonly alerts = new ChartAlertsController({
    symbol: () => this.symbol(),
    resolution: () => this.resolution(),
    logScale: () => this.scaleMode() === 'log',
    precision: () => this.precision(),
    host: () => this.host(),
    contextMenu: () => this.contextMenu(),
    closeContextMenu: () => this.contextMenu.set(null),
    openAlertMenu: () => this.openMenu.set('alert'),
    closeMenus: () => this.openMenu.set(null),
    toggleAlertMenu: (ev) => this.toggleMenu('alert', ev),
    alertMoveDialog: () => this.alertMoveDialog(),
    queryParamMap: this.route.queryParamMap,
    drawings: inject(DrawingStore),
    chartAlerts: inject(ChartAlertsService),
    notify: inject(NotificationService),
    destroyRef: this.destroyRef,
  });

  toggleEditor(): void {
    if (this.dockTab() === 'editor') {
      this.editorOpen.set(false);
      return;
    }
    // Opening the editor shows the script on the chart, as TradingView does.
    this.openScriptSource(this.editorKey());
  }

  toggleTester(): void {
    this.dock.toggleTester();
  }

  closeTester(): void {
    this.dock.closeTester();
  }

  /** "auto": fit the price scale to the visible bars, keeping its mode — log stays log (CC-19). */
  autoScale(): void {
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

  readonly currentLayoutName = computed(() => this.workspace.active().name);
  /**
   * US06: the page's periodic work (clock, headline age, market-status clock, script re-runs, forming-bar resync) on
   * one timer that stops while the tab is hidden and catches up when it shows ({@link ChartScheduler}).
   */
  private readonly scheduler = (() => {
    const s = new ChartScheduler(browserSchedulerEnv());
    inject(DestroyRef).onDestroy(() => s.dispose());
    return s;
  })();
  readonly catalogue = INDICATORS;

  readonly symbols = signal<CurrencyPairDto[]>([]);
  /**
   * US02b: the main series — symbol, timeframe, bars and whose they are, the forming bar, live prices, scroll-back —
   * lives in {@link ChartSessionStore}; the page reads it under the names it always had.
   */
  readonly session: ChartSessionStore = new ChartSessionStore({
    feed: this.feed,
    host: () => this.host(),
    replay: () => this.replay,
    loadEvents: (extend) => this.loadEvents(extend),
    extendCompareBars: (oldestMs) => this.extendCompareBars(oldestMs),
  });
  /** US02b: the overlay settings saved with a layout ({@link ChartOverlaySettings}); aliased below under their names. */
  readonly overlaySettings = new ChartOverlaySettings();
  readonly symbol = this.session.symbol;
  readonly resolution = this.session.resolution;
  readonly style = signal<ChartStyle>('candles');
  readonly showVolume = signal(true);
  readonly bars = this.session.bars;
  /** The symbol and resolution `bars` hold ({@link ChartSessionStore.barsFor}). */
  private readonly barsFor = this.session.barsFor;
  readonly dataKey = this.session.dataKey;
  readonly historyComplete = this.session.historyComplete;
  readonly sessionSpec = this.session.sessionSpec;
  private readonly tradingCalendar = this.session.tradingCalendar;
  readonly loading = this.session.loading;
  readonly error = this.session.error;
  readonly active = signal<ActiveIndicator[]>([]);
  readonly legend = signal<LegendSnapshot | null>(null);
  readonly indicatorMenuOpen = signal(false);
  readonly dialogTab = signal<DialogTab>('indicators');

  /** Pine scripts + strategies the dialog can add; fetched when the dialog first opens. */
  readonly scriptCatalog = signal<ChartScriptCatalog | null>(null);
  readonly dialogItems = computed<DialogItem[]>(() => {
    const items = studyDialogItems(this.paneScope());
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
          deletable: true,
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
  readonly scriptRuns = signal<ChartScriptRun[]>([]);
  /**
   * U13 (fu-ui): which panel the dock shows (editor / tester / Pine Logs) and the tester / logs actions. The page's
   * members of the same names below are aliases of its signals.
   */
  readonly dock = new ChartDockState<ChartScriptRun>({
    scriptRuns: () => this.scriptRuns(),
    strategyRun: () => this.strategyRun(),
  });
  /**
   * U13 (fu-ui): every Pine run on the chart — explicit and quiet re-runs, Bar Replay steps, landing, failures, warm
   * sessions — {@link ChartScriptEngine}. The page's members of the same names are aliases / delegates.
   */
  readonly engine = new ChartScriptEngine(this.engineHost());
  /**
   * The runs drawn on the chart: those computed for its symbol and resolution, once its bars are
   * that series. Through a switch the previous runs' plots, drawings and tables go at once, and the
   * new runs wait for the new bars — "Running script…" shows meanwhile.
   */
  readonly scriptResults = computed<ChartScriptLayer[]>(
    () => {
      const failures = this.scriptFailures();
      return chartScriptLayers(
        this.scriptRuns(),
        {
          chart: { symbol: this.symbol(), resolution: this.resolution() },
          bars: this.barsFor(),
          basis: this.chartBasis(),
          unavailable: this.scriptsUnavailable(),
          replayHead: this.replayHead(),
        },
        // What each status line prints besides its values (PC-I2).
        (run) => ({
          title: run.result.title || run.item.name,
          inputs: inputsSummary(run.result.inputs, run.values),
          failure: failures.get(run.item.key) ?? null,
        }),
      );
    },
    { equal: sameLayers },
  );
  /** The overlay scripts' status lines, for the price pane's legend (PC-I2). */
  readonly legendScriptRows = computed(
    () =>
      this.host()
        ?.scriptStatus()
        .filter((r) => r.pane === 'main') ?? [],
  );

  /** A status line (or chip) asked for something of a script. */
  onScriptAction(a: ScriptAction): void {
    switch (a.kind) {
      case 'visibility':
        this.toggleScriptVisible(a.key);
        break;
      case 'settings':
        this.settings.open(a.key);
        break;
      case 'source':
        this.openScriptSource(a.key);
        break;
      case 'logs':
        this.openLogs(a.key);
        break;
      case 'remove':
        this.removeScriptFromChart(a.key);
        break;
      case 'openAt':
        this.openScriptAt(a.key, a.where);
        break;
    }
  }
  /**
   * The bars runs are computed on for the chart's style (PC-09, PC-I8): Heikin-Ashi or standard;
   * null on a price-based style, which runs cannot be placed on.
   */
  readonly chartBasis = computed(() => scriptBasisOf(this.style()));
  /** "Not available on Renko charts" — why no script is drawn on this chart type; null when they are. */
  readonly scriptsUnavailable = computed(() =>
    this.chartBasis() === null
      ? `Not available on ${CHART_STYLES.find((s) => s.id === this.style())?.label ?? this.style()} charts`
      : null,
  );
  readonly strategyRun = computed(
    () => this.scriptRuns().find((r) => r.result.kind === 'strategy') ?? null,
  );
  /**
   * Why the Strategy Tester holds its report back: in Bar Replay the strategy's run reaches past
   * the head — its trades would be bars the chart has not reached (PC-08).
   */
  readonly testerSuspended = computed(() => {
    const run = this.strategyRun();
    return run && replayLag(run, this.replayHead()) === 'ahead' ? REPLAY_AHEAD : null;
  });
  /** Scripts with an explicit run in flight, by key, with its ticket — the engine's ({@link ChartScriptEngine}). */
  private readonly runningKeys = this.engine.runningKeys;
  readonly scriptRunning = computed(() => this.runningKeys().size > 0);
  /**
   * The chart's non-script notices (an FX-fundamentals pane that could not load, a study with no
   * data). A Pine script's failure is its own, on its chip ({@link scriptFailures}).
   */
  readonly scriptError = signal<string | null>(null);
  // The engine's run state ({@link ChartScriptEngine}): failures (PC-05, PC-13), scripts whose first run has not
  // landed, busy waits (C5) and "Update on chart" in flight — aliases.
  readonly scriptFailures = this.engine.scriptFailures;
  private readonly pendingScripts = this.engine.pendingScripts;
  private readonly waitingScripts = this.engine.waitingScripts;
  private readonly scriptUpdates = this.engine.scriptUpdates;

  /** The studies row's Pine chips: the scripts on the chart, then those still on their way. */
  readonly scriptChips = computed<ScriptChip[]>(() => {
    const running = this.runningKeys();
    const waiting = this.waitingScripts();
    const failures = this.scriptFailures();
    const updates = this.scriptUpdates();
    const updating = new Set(updates.keys());
    const viaUpdate = new Set(updates.values());
    const unavailable = this.scriptsUnavailable();
    const head = this.replayHead();
    const repaints = this.scriptRepaints();
    const warm = this.warmKeys();
    const chip = (
      key: string,
      name: string,
      kind: ScriptChip['kind'],
      placed: boolean,
      run: ChartScriptRun | null,
    ): ScriptChip => {
      const visible = resolveDisplay(run?.display).visible;
      const failure = failures.get(key) ?? null;
      return {
        key,
        name,
        kind,
        placed,
        visible,
        running: running.has(key) || updating.has(key),
        waitingUntil: waiting.get(key) ?? null,
        failure,
        lastGoodMs: run?.landedAt ?? null,
        unavailable:
          unavailable ??
          (run ? hiddenOnTimeframe(resolveDisplay(run.display), this.resolution()) : null),
        // Its run to the replay head is due — not for a hidden indicator (it is not run while
        // hidden), nor after a failed one (its badge says so), nor where scripts cannot sit.
        replay:
          run && !failure && !unavailable && (visible || kind === 'strategy')
            ? replayLag(run, head)
            : null,
        repaint: repaints.get(key) ?? null,
        warm: warm.has(key),
      };
    };
    const runs = this.scriptRuns();
    const out = runs.map((r) =>
      chip(r.item.key, r.result.title || r.item.name, r.result.kind, true, r),
    );
    for (const [key, p] of this.pendingScripts()) {
      // An edit on its way shows on the chip of the script it updates.
      if (viaUpdate.has(key) || runs.some((r) => r.item.key === key)) continue;
      out.push(chip(key, p.item.name, p.item.kind, false, null));
    }
    return out;
  });
  // The dock's open state — aliases of {@link dock} (ChartDockState).
  readonly testerOpen = this.dock.testerOpen;
  readonly testerPrompt = this.dock.testerPrompt;
  readonly testerShown = this.dock.testerShown;
  readonly editorOpen = this.dock.editorOpen;

  // ── Pine Editor ↔ chart script (TradingView: the editor shows the script on the chart) ──
  private readonly strategies = inject(StrategiesService);
  /**
   * U13 (fu-ui): which chart script the editor shows, its draft and assistant text — {@link ChartEditorState}. The
   * members of the same names below are aliases of its signals.
   */
  readonly editor = new ChartEditorState<ChartScriptItem, ChartScriptRun>({
    scriptRuns: () => this.scriptRuns(),
    pendingScripts: () => this.pendingScripts(),
    dock: {
      editorOpen: this.dock.editorOpen,
      frontDock: (which) => this.frontDock(which),
    },
    fetchStrategySource: (id, done) =>
      this.strategies
        .getById(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => done(res?.data?.scriptSource ?? ''),
          error: () => done(''),
        }),
  });
  /** The chart script the editor is showing (its run key), or null for a new script. */
  readonly editorKey = this.editor.editorKey;
  /** Engine strategy sources, fetched once per id. */
  private readonly strategySources = this.editor.strategySources;
  readonly editorTarget = this.editor.editorTarget;
  /** Set when the shown script was removed: the editor opens on the starter template ({@link ChartEditorState}). */
  private readonly editorCleared = this.editor.editorCleared;

  /** Point the editor at a chart script, loading an engine strategy's source when needed. */
  openScriptSource(key: string | null): void {
    this.editor.openScriptSource(key);
  }
  // ── The assistant's view of the Pine Editor (`pine.*` / `strategy.*` page commands) ──
  /** The editor's current text, for the script it shows — kept here so it reads even with the tester in front. */
  private readonly editorDraft = this.editor.editorDraft;
  /** Text the assistant wrote, pushed into the editor (a new seq applies it). */
  readonly assistSource = this.editor.assistSource;

  onEditorSource(text: string): void {
    this.editor.onEditorSource(text);
  }

  private draftText(): string {
    return this.editor.draftText();
  }

  private writeDraft(text: string): void {
    this.editor.writeDraft(text);
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
      this.frontDock('editor');
    },
    compile: async (source) => {
      const r = await firstValueFrom(
        this.chartScripts.compile(source, this.symbol(), this.resolution()),
      );
      this.scriptEditor()?.showCompile(r);
      return r;
    },
    runDraft: (source) => new Promise((resolve) => this.runDraftOnChart(source, resolve)),
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

  // Which panel is in the dock's front — aliases of {@link dock} (ChartDockState).
  readonly dockPreference = this.dock.dockPreference;
  readonly logsFront = this.dock.logsFront;
  readonly logsKey = this.dock.logsKey;
  readonly logsRun = this.dock.logsRun;
  readonly dockTab = this.dock.dockTab;
  readonly dockTabs = this.dock.dockTabs;

  /** Bring the editor or the tester to the dock's front (Pine Logs goes behind). */
  frontDock(which: 'editor' | 'tester'): void {
    this.dock.frontDock(which);
  }

  // ── Dock layout: the Pine Editor / Strategy Tester / Pine Logs panel docked below the chart, maximised over it
  //    (a strip of the live chart stays visible above), or beside it full height — sizes drag-adjustable, the choice
  //    remembered in this browser. Full screen is the chart page's own (the dock is inside it). ──
  readonly dockMode = signal<DockMode>(loadDockLayout().mode);
  /** Docked: the panel's height (px). */
  readonly dockHeight = signal(loadDockLayout().height);
  /** Maximised: the height of the live chart strip kept above the panel (px). */
  readonly dockChartStrip = signal(loadDockLayout().strip);
  /** Beside: the panel's width (px). */
  readonly dockSideWidth = signal(loadDockLayout().side);
  private readonly persistDockLayout = effect(() => {
    const layout: DockLayout = {
      mode: this.dockMode(),
      height: this.dockHeight(),
      strip: this.dockChartStrip(),
      side: this.dockSideWidth(),
    };
    saveDockLayout(layout);
  });

  /** The watchlist was open when the panel went beside the chart: it comes back when the panel leaves. */
  private watchlistBeforeSide = false;
  /** The panel opening (or closing) in a remembered Beside layout folds (or restores) the watchlist the same way. */
  private readonly foldWatchlistBeside = effect(() => {
    const open = !!this.dockTab();
    untracked(() => {
      if (this.dockMode() !== 'side') return;
      if (open && this.watchlistOpen()) {
        this.watchlistBeforeSide = true;
        this.watchlistOpen.set(false);
      } else if (!open && this.watchlistBeforeSide) {
        this.watchlistOpen.set(true);
        this.watchlistBeforeSide = false;
      }
    });
  });

  /**
   * A layout button: pressing Maximise or Beside again goes back to docked. Beside folds the watchlist away (code,
   * chart and watchlist do not fit side by side) and brings it back after; the strip still reopens it meanwhile.
   */
  setDockMode(mode: DockMode): void {
    const from = this.dockMode();
    const to = from === mode ? 'docked' : mode;
    if (to === 'side' && from !== 'side') {
      this.watchlistBeforeSide = this.watchlistOpen();
      this.watchlistOpen.set(false);
    } else if (from === 'side' && to !== 'side' && this.watchlistBeforeSide) {
      this.watchlistOpen.set(true);
      this.watchlistBeforeSide = false;
    }
    this.dockMode.set(to);
  }

  /**
   * Drag the dock's edge: its height (docked), the chart strip above it (maximised) or its width (beside). Sizes
   * are clamped so the chart and the panel both stay usable.
   */
  startPanelResize(ev: PointerEvent): void {
    const page = document.querySelector('.chart-page');
    if (!page || ev.button !== 0) return;
    ev.preventDefault();
    const box = page.getBoundingClientRect();
    const bodyTop = page.querySelector('.chart-body')?.getBoundingClientRect().top ?? box.top;
    const mode = this.dockMode();
    const move = (e: PointerEvent): void => {
      if (mode === 'side')
        this.dockSideWidth.set(clampSize(box.right - e.clientX, 360, box.width - 320));
      else if (mode === 'max')
        this.dockChartStrip.set(clampSize(e.clientY - bodyTop, 80, box.height - 260));
      else this.dockHeight.set(clampSize(box.bottom - e.clientY, 140, box.height - 200));
    };
    // No text selection and the resize cursor everywhere while dragging (the pointer leaves the thin handle).
    const body = document.body.style;
    const before = { cursor: body.cursor, select: body.userSelect };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      body.cursor = before.cursor;
      body.userSelect = before.select;
    };
    body.cursor = mode === 'side' ? 'ew-resize' : 'ns-resize';
    body.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** A dock tab clicked. */
  showDock(id: 'editor' | 'tester' | 'logs'): void {
    this.dock.showDock(id);
  }

  /** A script's Pine Logs, trace and profiler, in the dock's front (its chip or status line). */
  openLogs(key: string): void {
    this.dock.openLogs(key);
  }

  closeLogs(): void {
    this.dock.closeLogs();
  }

  /**
   * How the script whose logs are shown was run, for its trace and profile runs: the same window,
   * bars and inputs — to the same Bar Replay head when it was run to one.
   */
  readonly logsRequest = computed<LogsRunRequest | null>(() => {
    const r = this.logsRun();
    if (!r) return null;
    const until = r.until;
    const head =
      until === undefined ? null : (this.bars().find((b) => b.time === until) ?? { time: until });
    return {
      item: r.item,
      symbol: r.symbol,
      resolution: r.resolution,
      values: r.values,
      lastBars: r.requestedBars,
      opts: {
        chartType: r.chartType ?? 'standard',
        toMs: head ? barCloseMs(head, r.resolution) : null,
      },
    };
  });

  /** A bar the Pine Logs point at (UTC ms): panned into view, the zoom kept. */
  focusBar(timeMs: number): void {
    const step = resolutionMs(this.resolution()) ?? 3_600_000;
    this.host()?.panToRange(timeMs - 20 * step, timeMs + 20 * step);
  }

  /** Other symbols' bars for compare studies, keyed by symbol. */
  /** Compare overlays + compare studies' other symbols (CC-I12, CC-13) — U13: {@link ChartCompareState}. */
  private readonly compareState = new ChartCompareState({
    feed: { getBars: (sym, res, from, to, limit) => this.feed.getBars(sym, res, from, to, limit) },
    resolution: () => this.resolution(),
    oldestBarTime: () => this.bars()[0]?.time,
    now: () => this.serverClock.now(),
    calendarOf: (symbol) => this.calendarOf(symbol),
    gridOf: (symbol) => this.feed.gridOf(symbol),
    scaleMode: () => this.scaleMode,
    notify: (text) => this.notify.info(text),
  });
  readonly compareBars = this.compareState.bars;
  private readonly compareSymbols = computed(() => {
    const out = new Set<string>();
    for (const a of this.active()) {
      if (!a.visible || !indicatorById(a.defId)?.needsCompare) continue;
      const sym = String(a.params['symbol'] ?? '').toUpperCase();
      if (sym && sym !== this.symbol().toUpperCase()) out.add(sym);
    }
    // The compare overlays' and synthetic series' symbols (CC-I12) load the same way.
    for (const sym of compareSymbolsOf(this.compareSeries(), this.symbol())) out.add(sym);
    return [...out].sort();
  });
  readonly symbolMenuOpen = signal(false);
  readonly symbolQuery = signal('');

  // ── Drawings ─────────────────────────────────────────────────────────────
  readonly drawings = inject(DrawingStore);
  private readonly positions = inject(PositionsService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly signals = inject(TradeSignalsService);

  /**
   * Engine state drawn on the chart, each layer held and refreshed on its own: the symbol's open
   * positions, working orders and closed positions as the engine last sent them, and the signal and
   * martingale-rung markers. The position lines are re-drawn from these on every live price (their
   * P&L), never re-fetched for it.
   */
  private readonly tradeLayers = new TradeLayersLoader({
    symbol: () => this.symbol(),
    accountScope: this.accountScope,
    showPositions: () => this.showPositions(),
    showOrders: () => this.showOrders(),
    showClosedTrades: () => this.showClosedTrades(),
    showOverlays: () => this.showOverlays(),
    inTradeScope: () => this.inTradeScope(),
    positions: this.positions,
    orders: inject(OrdersService),
    signals: this.signals,
    martingale: inject(MartingaleService),
    destroyRef: this.destroyRef,
  });
  protected readonly openPositions = this.tradeLayers.openPositions;
  protected readonly workingOrders = this.tradeLayers.workingOrders;
  private readonly closedPositions = this.tradeLayers.closedPositions;
  private readonly signalMarkers = this.tradeLayers.signalMarkers;
  private readonly rungMarkers = this.tradeLayers.rungMarkers;
  /** The chart symbol's live quote (bid and ask), for the open positions' P&L at the exit side. */
  protected readonly liveQuote = signal<LiveQuote | null>(null);

  /** The account scope, as a filter: only the selected account's positions and orders are drawn. */
  private inTradeScope(): (accountId: number | null | undefined) => boolean {
    const ids = this.accountScope.accountIds();
    return (id) => id != null && ids.includes(id);
  }

  private readonly positionOverlays = computed(() =>
    this.showPositions()
      ? positionLines(
          this.openPositions(),
          this.symbol(),
          this.inTradeScope(),
          this.liveQuote(),
          this.facts(),
          (id) => this.accountScope.accounts().find((a) => a.id === id)?.currency ?? null,
        )
      : [],
  );
  private readonly orderOverlays = computed(() =>
    this.showOrders() ? orderLines(this.workingOrders(), this.symbol(), this.inTradeScope()) : [],
  );
  private readonly closedTradeMarkers = computed(() =>
    this.showClosedTrades()
      ? closedTradeMarkers(
          this.closedPositions(),
          this.symbol(),
          this.inTradeScope(),
          this.facts(),
        )
      : [],
  );

  readonly overlays = computed(() => [...this.positionOverlays(), ...this.orderOverlays()]);
  readonly markers = computed(() => [
    ...this.signalMarkers(),
    ...this.rungMarkers(),
    ...this.closedTradeMarkers(),
    ...this.tradeTimeline.markers(),
    ...this.analysisMarkers(),
    ...this.replay.markers(),
    ...this.rollMarkers(),
  ]);

  // ── SP-I5 (analysis): the analysis panel, its plan / watch overlay and the watches' fire markers ──
  /** The analysis panel is open (its overlay stays drawn when it is closed). */
  readonly analysisOpen = signal(false);
  /** The symbol's watches' fires, touches, call-offs and script steps (`app-chart-analysis` fills it). */
  readonly analysisMarkers = signal<ChartMarker[]>([]);
  /** Watches and monitors on the chart — fire / step / call-off marks and their price lines (overlays menu; saved with the layout). */
  readonly showWatchMarks = this.overlaySettings.showWatchMarks;
  /** A trade an analysis proposed, opened in the order ticket (paper, at market — nothing is sent until Submit). */
  onAnalysisTicket(prefill: TicketPrefill): void {
    this.ticketPrefill.set({ ...prefill });
  }

  // ── BX-1 (trading): the chart strategy's trade timeline — backtest, live session, paper and broker fills ──
  /** b9-maint: {@link ChartTradeTimeline}. */
  private readonly tradeTimeline = new ChartTradeTimeline({
    // A computed, as before: the timeline reloads when the strategy changes, not on every run of it.
    strategyId: computed(() => this.strategyRun()?.item.strategyId ?? null),
    symbol: () => this.symbol(),
    bars: () => this.bars(),
    scriptStrategies: inject(ScriptStrategyService),
  });
  /** The timeline is drawn (overlays menu "Trade timeline"); it needs an engine strategy script on the chart. */
  readonly showTradeTimeline = this.tradeTimeline.show;
  /** What the drawn timeline holds, or why nothing is drawn (the overlays menu shows it). */
  readonly tradeTimelineInfo = this.tradeTimeline.info;
  /** Trade layers, each its own toggle ({@link ChartOverlaySettings}). */
  readonly showPositions = this.overlaySettings.showPositions;
  readonly showOrders = this.overlaySettings.showOrders;
  readonly showOverlays = this.overlaySettings.showOverlays;
  readonly showClosedTrades = this.overlaySettings.showClosedTrades;
  readonly fitTradeLines = this.overlaySettings.fitTradeLines;
  readonly anyTradeOverlay = this.overlaySettings.anyTradeOverlay;

  // ── Analytical overlays ──────────────────────────────────────────────────
  //
  // Derived from the loaded bars, not fetched. The chart host computes them; these are the
  // toggles the toolbar drives.
  readonly showVolumeProfile = this.overlaySettings.showVolumeProfile;
  readonly volumeProfileMode = this.overlaySettings.volumeProfileMode;
  readonly vpMenuOpen = signal(false);
  readonly showSupportResistance = this.overlaySettings.showSupportResistance;
  readonly showStructure = this.overlaySettings.showStructure;
  readonly profileExtras = this.overlaySettings.profileExtras;

  /** Layer groups (PR-5), saved with the layout. */
  readonly layerGroups = this.overlaySettings.layerGroups;

  /** The estimated-delta study, which is a PANE study rather than a price overlay. */
  readonly deltaOn = computed(() => this.active().some((i) => i.defId === 'est-delta'));

  toggleDelta(): void {
    const existing = this.active().find((i) => i.defId === 'est-delta');
    if (existing) this.removeIndicator(existing.uid);
    else this.addIndicator('est-delta');
  }

  // ── Order flow (orderflow/): broker DOM heatmap, tick delta, footprint, spread ribbon, fills ──
  readonly orderFlow = this.overlaySettings.orderFlow;
  /** Multibook: the sources the consolidated heatmap may combine (every entitled source with a book). */
  readonly consolidatableSources = computed(() =>
    (this.orderFlowFeed.mdSources() ?? []).filter((s) => !!s.feeds?.book || !!s.feeds?.ticks),
  );
  /** Multibook: turn one source in or out of the consolidated heatmap (at least one stays in). */
  toggleConsolidatedSource(sourceId: string): void {
    const all = this.consolidatableSources().map((s) => s.sourceId);
    const current = all.filter((s) => this.overlaySettings.consolidatedHas(s));
    const next = current.includes(sourceId)
      ? current.filter((s) => s !== sourceId)
      : [...current, sourceId];
    if (!next.length) return;
    this.overlaySettings.setOrderFlowSource(consolidatedId(all, next));
  }
  /** Tick replay's book at the head for the depth panel (undefined outside tick replay). */
  readonly tickReplayBook = computed<OrderBookSnapshot | null | undefined>(() => {
    const head = this.replay.tickHead();
    const tick = this.replay.tick;
    if (head === null || !tick) return undefined;
    tick.version();
    const tape = tick.tape;
    if (!tape) return null;
    return bookToSnapshot(this.symbol(), tape.sourceId ?? 'recording', tape.bookAt(head));
  });
  /** Footprint rows: adaptive (about ten rows a typical bar) or a fixed height — MT5 points, else instrument ticks (UF02). */
  readonly footprintRowUnit = computed<'points' | 'ticks'>(() => {
    const f = this.facts();
    return !f.resolving && f.origin !== 'pair' && f.tickSize > 0 ? 'ticks' : 'points';
  });
  readonly footprintRowChoices = computed(() => footprintRowChoices(this.footprintRowUnit()));
  /** Bar Replay's head instant: every order-flow layer, and the depth panel, stop there (OF-5). Null when live. */
  readonly orderFlowReplayClip = computed(() => {
    if (!this.replay.active()) return null;
    // Tick replay: the head is an exact instant — every layer stops there.
    const tickHead = this.replay.tickHead();
    if (tickHead !== null) return tickHead;
    const intrabar = this.replay.cursor().sub !== null ? this.replay.intrabarSource() : null;
    const unit = resolutionMs(intrabar ?? this.resolution());
    return replayClipUtc(this.replay.headBar(), unit);
  });
  readonly orderFlowFeed = new OrderFlowFeed({
    settings: () => this.orderFlow(),
    symbol: () => this.symbol(),
    resolution: () => this.resolution(),
    bars: () => this.displayBars(),
    style: () => this.style(),
    view: () => this.host()?.orderFlowLayers.view() ?? null,
    accountIds: () => this.accountScope.accountIds(),
    accountKey: () => this.accountScope.accountIdsKey(),
    replayClip: () => this.orderFlowReplayClip(),
    precision: () => this.precision(),
    pipSize: () => this.pipSize(),
    now: () => this.serverClock.now(),
    facts: () => this.facts(),
    tickFootprint: (from, to) => {
      const tick = this.replay.tick;
      if (!tick || this.replay.tickHead() === null || !tick.tape) return null;
      tick.version();
      return footprintRowsFromTape(tick.tape, from, to);
    },
  });
  private readonly orders = inject(OrdersService);
  private readonly martingale = inject(MartingaleService);

  readonly showEvents = this.overlaySettings.showEvents;
  readonly minEventImpact = this.overlaySettings.minEventImpact;
  /** Shade the news blackout around Tier-1 events (CC-I2); saved with the layout. */
  readonly showBlackout = this.overlaySettings.showBlackout;
  /** b9-maint: economic events, blackout shading and event relevance ({@link ChartEventsState}); aliased below. */
  readonly eventsState = new ChartEventsState({
    symbol: () => this.symbol(),
    facts: () => this.facts(),
    currentPair: () => this.currentPair(),
    bars: () => this.bars(),
    replayActive: () => this.replayActive(),
    displayBars: () => this.displayBars(),
    showEvents: this.overlaySettings.showEvents,
    minEventImpact: this.overlaySettings.minEventImpact,
    showBlackout: () => this.showBlackout(),
    feed: this.feed,
    instruments: this.instruments,
    eventsFeed: inject(ChartEventsService),
  });
  /** Economic events on the time axis. */
  readonly events = this.eventsState.events;
  readonly blackout = this.eventsState.blackout;
  readonly eventRelevance = this.eventsState.eventRelevance;
  readonly paneScope = this.eventsState.paneScope;
  readonly exchangeSessions = this.eventsState.exchangeSessions;
  readonly technicalsSessionWords = this.eventsState.technicalsSessionWords;
  readonly pairCurrencies = this.eventsState.pairCurrencies;
  readonly chartEvents = this.eventsState.chartEvents;
  readonly blackoutTitle = this.eventsState.blackoutTitle;
  readonly eventBands = this.eventsState.eventBands;
  /**
   * The line under a study in the studies strip: why a pane is empty (UA03) — the engine's reason or "FX pairs only".
   */
  /** {@link studyNote} bound to the page, for the studies strip's input. */
  readonly studyNoteOf = (item: ActiveIndicator): string | null => this.studyNote(item);
  studyNote(item: ActiveIndicator): string | null {
    if (item.defId === 'exchange-sessions') return exchangeSessionsNote(this.exchangeSessions(), this.symbol());
    const pane = this.externalPanes().find((p) => p.uid === item.uid)?.note;
    if (pane) return pane;
    // UA07: a volume study says what its volume is (and that a delta is estimated). Only once C1 has said it.
    if (!this.feed.factsOf(this.symbol())) return null;
    return volumeStudyNote(item.defId, this.volumeKind(), this.facts().instrument.baseCurrency, item.params);
  }
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
  /** Ticks every 30 s while the tab is visible, so the headline's age keeps moving (SP-11: it was computed once). */
  private readonly headlineClock = signal(Date.now());
  private readonly headlineTick = this.scheduler.every('headline-age', 30_000, () =>
    this.headlineClock.set(Date.now()),
  );
  readonly watchHeadline = computed<WatchHeadline | null>(() => {
    const a = this.articles()[0];
    if (!a) return null;
    return {
      title: a.title,
      source: a.sourceName,
      at: headlineAge(a.publishedAtUtc, this.headlineClock()),
    };
  });
  /** The SP-I9 side panels (notes, broker depth, sentiment, account), one at a time beside the page's own panes. */
  readonly chartPanels = inject(ChartPanelsState);
  /** The symbol's exchange-traded instrument (fundamentals rail button), or null for every MT5 symbol. */
  readonly venueInstrument = computed(() => venueInstrumentFor(this.symbol()));

  // ── Technicals view ("More technicals") ──────────────────────────────────
  // Laid over the chart area rather than replacing it, so the chart stays
  // mounted and "Back to chart" returns to exactly the same state.
  readonly technicalsOpen = signal(false);
  /** "More seasonals": the Seasonals view, laid over the chart the same way. */
  readonly seasonalsOpen = signal(false);
  readonly currentPair = computed(() =>
    this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === this.symbol().toUpperCase()),
  );

  /** A Technicals row's indicator, with that row's inputs, onto the chart — then show the chart. */
  addStudyFromTechnicals(study: StudyRef): void {
    this.addIndicator(study.id, study.params);
    this.technicalsOpen.set(false);
  }

  // ── Side panes: Details and News ─────────────────────────────────────────
  /** b9-maint: the side panes, calendar filters and news ({@link ChartNewsPane}); aliased below. */
  readonly newsPane = new ChartNewsPane({
    symbol: () => this.symbol(),
    symbols: () => this.symbols(),
    eventRelevance: () => this.eventRelevance(),
    pairCurrencies: () => this.pairCurrencies(),
    details: () => this.details(),
    watchlistOpen: () => this.watchlistOpen(),
    chartPanels: this.chartPanels,
    newsIntel: inject(NewsIntelService),
    destroyRef: this.destroyRef,
  });
  readonly sidePane = this.newsPane.sidePane;
  readonly calendarAll = this.newsPane.calendarAll;
  readonly calendarMinImpact = this.newsPane.calendarMinImpact;
  readonly calendarEvent = this.newsPane.calendarEvent;
  readonly calendarCurrencies = this.newsPane.calendarCurrencies;
  readonly articles = this.newsPane.articles;
  readonly newsAnalysis = this.newsPane.newsAnalysis;
  readonly newsLoading = this.newsPane.newsLoading;
  readonly newsFocus = this.newsPane.newsFocus;

  /**
   * Symbol facts for the Details pane, assembled from what the console already
   * knows rather than a new endpoint: the pair's own metadata, the loaded bar
   * range, and the session's move — the 17:00 New York session on every
   * timeframe once the symbol's session is known, the UTC day on 1m … 1h
   * before then (`currentDayBars`).
   */
  readonly details = computed(() => {
    const symbol = this.symbol();
    const pair = this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === symbol);
    const bars = this.bars();
    const first = bars[0];
    const last = bars[bars.length - 1];
    const today = currentDayBars(bars, this.tradingCalendar()?.dayOf);
    const dayOpen = today[0]?.open ?? null;
    // Bug b1-2 / UI leftover: an equity or index CFD's pair row reads "USD / USD · Forex"; the description, the kind
    // and the sizing come from the instrument facts (FX: the pair's own numbers, as before).
    const f = this.facts();
    return {
      symbol,
      isFx: f.isFx,
      description: instrumentDescription(f.instrument) ?? symbol,
      kind: instrumentKindLabel(f.instrument, this.feed.factsOf(symbol)?.assetClass),
      quantityUnit: f.quantityUnit,
      base: pair?.baseCurrency ?? f.instrument.baseCurrency ?? '—',
      quote: pair?.quoteCurrency ?? f.quoteCurrency ?? '—',
      digits: f.precision,
      contractSize: f.isFx ? (pair?.contractSize ?? null) : f.contractValue,
      minLot: f.isFx ? (pair?.minLotSize ?? null) : f.minQuantity,
      maxLot: f.isFx ? (pair?.maxLotSize ?? null) : f.maxQuantity,
      lotStep: f.isFx ? (pair?.lotStep ?? null) : f.quantityStep,
      bars: bars.length,
      from: first ? this.barTimeLabel(first) : '—',
      to: last ? this.barTimeLabel(last) : '—',
      last: last?.close ?? null,
      dayOpen,
      dayHigh: today.length ? Math.max(...today.map((b) => b.high)) : null,
      dayLow: today.length ? Math.min(...today.map((b) => b.low)) : null,
      dayChangePct:
        dayOpen && last && dayOpen !== 0 ? ((last.close - dayOpen) / dayOpen) * 100 : null,
    };
  });
  readonly prices = signal<Record<string, { bid: number; prev: number }>>({});

  // ── Bar replay (CC-I4) ───────────────────────────────────────────────────
  //
  // Replay is a VIEW over the loaded bars: it shows a prefix of them, and with intrabar steps the
  // next bar forming from its 1m (1h above a day) bars. Everything downstream — indicators, the
  // legend, drawings — follows the plotted bars, so they rewind for free and an indicator cannot
  // see bars from the future. Its paper trades stay in this tab (`replay/paper-broker.ts`).
  readonly replay = new ReplayController({
    bars: () => this.bars(),
    resolution: () => this.resolution(),
    digits: () => this.precision(),
    // UI03: the instrument's own money — 100 000 per FX lot as always, tick value ÷ tick off FX, inverse in the coin.
    symbolFacts: () => {
      const f = this.facts();
      return {
        pipSize: f.distanceUnit,
        unitLabel: f.distanceLabel,
        valuePerPrice: f.valuePerPrice,
        inverse: f.inverse,
        contractValue: f.contractValue,
      };
    },
    fetchIntrabar: (resolution, fromMs, toMs, count) =>
      this.feed.getBars(this.symbol(), resolution, fromMs, toMs, count).then((r) => r.bars),
    tickData: {
      history: (req) => this.mdApi.history(req),
      symbol: () => this.symbol(),
      // The consolidated book has no tick tape: tick replay then reads the automatic source.
      sourceId: (): string | null => {
        const s = this.orderFlow().sourceId;
        if (isConsolidatedId(s)) return null;
        // UF07: a picked source that does not carry this symbol (a crypto exchange on an FX chart) → automatic.
        const list: readonly MdSource[] = this.orderFlowFeed.mdSources() ?? [];
        const src = list.find((x) => x.sourceId === s);
        return src && !sourceCarries(src, this.symbol()) ? null : s;
      },
      now: () => this.serverClock.now(),
    },
  });
  readonly replayActive = this.replay.active;
  readonly replayIndex = this.replay.index;
  readonly replayPlaying = this.replay.playing;
  readonly replaySpeed = this.replay.speed;

  /** What the chart actually plots — the full series, or the replay's bars. */
  readonly displayBars = this.replay.view;

  readonly replayAtEnd = this.replay.atEnd;
  /** The last closed bar at the replay head (a bar forming from intrabar steps is not closed); null outside replay. */
  readonly replayClosedHead = this.replay.closedHead;
  /**
   * Bar Replay's head: the open (Unix ms) of the last closed bar the chart shows; null outside replay. The
   * scripts run to it (PC-08, PC-I8) — never a bar past it, nor the bar forming from intrabar steps.
   */
  readonly replayHead = computed(() => this.replayClosedHead()?.time ?? null);
  /** b9-maint: range presets, go-to-date and Bar Replay's controls ({@link ChartTimeNavigator}); the template reads `timeNav`. */
  readonly timeNav = new ChartTimeNavigator({
    bars: () => this.bars(),
    historyComplete: () => this.historyComplete(),
    resolution: () => this.resolution(),
    timezone: () => this.timezone(),
    host: () => this.host(),
    loadOlder: () => this.loadOlder(),
    selectResolution: (r) => this.selectResolution(r),
    replay: this.replay,
    stopReplayRuns: () => this.engine.replayRuns.stopAll(),
    barTimeLabel: (bar) => this.barTimeLabel(bar),
    formatTime: (ms) => this.formatTime(ms),
    notify: inject(NotificationService),
  });
  /** The indicators' engine replay sessions: a head moving forward executes only the new bars (CC-I4). */
  private readonly replayScripts = new ReplayScriptSessions(inject(ScriptingRunService));
  /** US02b: the drawing-tool state (armed tool, magnet, stay-in-drawing, the rail's families and flyouts). */
  readonly drawingTools = new ChartDrawingTools({
    readPref,
    writePref,
    favorites: inject(DrawingFavorites),
  });
  readonly tools = this.drawingTools.tools;
  readonly tool = this.drawingTools.tool;
  readonly magnet = this.drawingTools.magnet;
  readonly magnetMenuOpen = this.drawingTools.magnetMenuOpen;
  /** What the chart applies: off, or the chosen strength. */
  readonly magnetMode = this.drawingTools.magnetMode;
  /** TV "Stay in drawing mode". */
  readonly stayInDrawing = this.drawingTools.stayInDrawing;
  /** Group whose rail flyout is open, or null. */
  readonly railFlyout = this.drawingTools.railFlyout;
  /** Drawing whose Settings dialog is open. */
  readonly settingsFor = signal<string | null>(null);
  /** Built-in study whose Settings dialog is open (DR-I4). */
  readonly studySettingsFor = signal<string | null>(null);
  readonly studySettingsStudy = computed(
    () => this.active().find((i) => i.uid === this.studySettingsFor()) ?? null,
  );
  /**
   * What a new Long / Short Position is placed with (DR-I9): the account in scope (one account, or the only live
   * one), its equity and currency, and this symbol's contract size, pip and quote→account rate.
   */
  readonly positionFacts = computed(() => {
    const selected = this.accountScope.selected();
    const live = this.accountScope.liveAccounts();
    const account =
      typeof selected === 'number'
        ? (this.accountScope.accounts().find((a) => a.id === selected) ?? null)
        : live.length === 1
          ? live[0]
          : null;
    // US07: the instrument's facts (UI01), not the pair's contract size — a non-pair symbol had no money at all.
    const facts = positionAccountFacts({
      account,
      facts: this.facts(),
      price: this.bars().at(-1)?.close ?? 0,
    });
    return facts ? { ...facts } : null;
  });
  /** SP-I4 (trading): the order ticket is open, and the values a "Stage…" opens it with. */
  readonly ticketOpen = signal(false);
  /** The account scope's ids, for the chart's trading lines (the same filter the trade layer draws with). */
  readonly accountIdsInScope = computed(() => this.accountScope.accountIds());
  readonly ticketPrefill = signal<TicketPrefill | null>(null);

  /** A ticket went through: the trade layers show the new position / order once the engine reports it. */
  onTicketSubmitted(): void {
    this.scheduleTradeRefresh({ symbol: this.symbol() });
  }

  /** SP-I3: a position or order was changed from the chart (or a change was refused): re-read the trade layers. */
  onChartTradeChanged(): void {
    this.loadTradingOverlays();
  }

  /**
   * "Stage…" on a Long / Short Position (DR-I9 → SP-I4): the order ticket opens with the tool's side, stop and target,
   * in paper at market (the drawn entry is kept for a live "At price" order). The chart sends nothing until Submit,
   * and the engine judges the ticket again then.
   */
  stageOrder(id: string): void {
    const d = this.drawings.allDrawings().find((x) => x.id === id);
    const prefill = d ? positionOrderPrefill(d, this.symbol()) : null;
    if (!prefill?.direction) return;
    this.ticketPrefill.set({
      direction: prefill.direction,
      entry: prefill.entryPrice ?? null,
      stop: prefill.stopLoss ?? null,
      target: prefill.takeProfit ?? null,
    });
  }

  /** The studies' names by uid (the object tree names the pane a drawing is in, DR-I10). */
  readonly studyLabels = computed(() =>
    Object.fromEntries(this.active().map((i) => [i.uid, this.labelFor(i)])),
  );
  private readonly studyDialog = viewChild(StudySettingsDialogComponent);
  /** Right-click menu on a drawing (page-relative coordinates). */
  readonly drawingMenu = signal<{ id: string; x: number; y: number } | null>(null);
  readonly scaleMode = signal<ScaleMode>('normal');
  /** TradingView's "Invert scale" (CC-I9). */
  readonly invertScale = signal(false);
  /** The side the price scale sits on (CC-I9). */
  readonly scaleSide = signal<'right' | 'left'>('right');
  /** Whether the price scale fits the visible bars on its own, as the chart reports it (CC-19). */
  readonly autoScaleOn = signal(true);
  /** Lines where each trading day begins on intraday charts (CC-I9), saved with the layout. */
  readonly sessionBreaks = signal(false);
  /** TradingView's countdown to bar close under the last-price label (saved with the layout). */
  readonly showCountdown = signal(true);
  /** When this chart's symbol last had a live price (client ms): a silent feed hides the countdown. */
  readonly liveAt = signal<number | null>(null);
  readonly objectTreeOpen = signal(false);
  readonly dashOptions: DashStyle[] = ['solid', 'dashed', 'dotted'];

  // ── Workspace: layouts, templates, timezone, chrome ──────────────────────
  readonly layoutStore = inject(ChartLayoutStore);
  /** US07: per asset class, the timeframe and study template a symbol of that class opens with (opt-in). */
  readonly classDefaults = inject(AssetClassDefaultsService);
  readonly assetClassName = ASSET_CLASS_NAME;
  /** US07: the chart symbol's asset class, as the instrument facts say (null while resolving). */
  readonly symbolClass_ = computed(() => (this.facts().resolving ? null : this.facts().assetClass));
  /** US07: this class's default (the templates menu shows and edits it). */
  readonly classDefault = computed(() => {
    const cls = this.symbolClass_();
    return cls ? (this.classDefaults.defaults()[cls] ?? null) : null;
  });

  /** US07: use the current timeframe (or, again, none) for every symbol of this class. */
  toggleClassResolution(): void {
    const cls = this.symbolClass_();
    if (!cls) return;
    const on = this.classDefault()?.resolution === this.resolution();
    this.classDefaults.set(cls, 'resolution', on ? undefined : this.resolution());
  }

  /** US07: open every symbol of this class with `templateId` (or, again, with none). */
  toggleClassTemplate(templateId: string, ev: Event): void {
    ev.stopPropagation();
    const cls = this.symbolClass_();
    if (!cls) return;
    const on = this.classDefault()?.templateId === templateId;
    this.classDefaults.set(cls, 'templateId', on ? undefined : templateId);
  }
  readonly timezones = CHART_TIMEZONES;
  readonly timezone = signal<string>('UTC');
  readonly layoutMenuOpen = signal(false);
  readonly contextMenu = signal<{
    x: number;
    y: number;
    price: number | null;
    /** A derived level under the click (PR-7): its alert is offered at the level's exact price. */
    level?: AlertableLevel | null;
  } | null>(null);
  private readonly notify = inject(NotificationService);
  /** The page's questions (names, deletions) in the console's dialog, not the browser's (CC-I11). */
  private readonly dialogs = inject(ScriptDialogService);
  /**
   * Whether the page is fullscreen, as the browser says (CC-20): leaving with Esc fires only
   * `fullscreenchange`, so the button stayed lit and the assistant read the wrong state.
   */
  readonly isFullscreen = signal(false);
  private readonly followFullscreen = (() => {
    if (typeof document === 'undefined') return;
    const sync = () => this.isFullscreen.set(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('fullscreenchange', sync));
  })();

  /**
   * Box size for the price-based styles, as a multiple of ATR.
   *
   * An absolute price would be useless across timeframes — 10 pips is a
   * sensible Renko brick on H1 and absurd on D1 — so the operator scales the
   * ATR-derived default rather than replacing it.
   */
  readonly boxSizeAtr = signal(1);
  /**
   * The price-based styles' box (CC-I10): by ATR (`boxSizeAtr` × ATR(14), measured at load) or in pips
   * (`boxPips`, TradingView's "Traditional"). Saved with the layout.
   */
  readonly boxMethod = signal<'atr' | 'pips'>('atr');
  readonly boxPips = signal(10);
  /** Renko's "Show wicks". */
  readonly renkoWicks = signal(false);
  /** Line break: lines a reversal must break. */
  readonly lineBreakLines = signal(3);
  /** Point & Figure: the reversal, in boxes (CC-I10; TradingView's default 3). */
  readonly pnfReversal = signal(3);
  /** One display unit of this symbol, in price: the pip on FX (ten points on fractional quotes), else its tick/point. */
  readonly pipSize = computed(() => this.facts().distanceUnit);

  /**
   * Where the symbol's market stands (UD08): the ENGINE's session state (`MarketSessionService`, read at the next
   * open / close, paused while hidden) — pre / regular / post / break / closed with a countdown — plus what only the
   * chart sees: a stale feed, prices arriving while the calendar says closed, the closure's name. It replaced a guess
   * from the newest bar's age with FX rules (crypto "closed" on a quiet minute). Without an engine answer the old
   * reading from the data remains, labelled as such ({@link marketView}).
   */
  private readonly marketSessions = inject(MarketSessionService);
  private readonly marketWatch = effect((onCleanup) => {
    const symbol = this.symbol();
    onCleanup(untracked(() => this.marketSessions.watch(symbol)));
  });
  /** Re-evaluated every 30 s, so "Feed stale" and the data fallback follow the clock without a tick. */
  private readonly marketClock = (() => {
    const now = signal(Date.now());
    this.scheduler.every('market-clock', 30_000, () => now.set(Date.now()));
    return now;
  })();
  readonly marketView = computed<MarketView>(() => {
    const symbol = this.symbol();
    const bars = this.bars();
    const last = bars[bars.length - 1];
    const step = resolutionMs(this.resolution()) ?? 60_000;
    const state = this.marketSessions.stateOf(symbol);
    return marketView({
      state,
      calendarCode: state?.calendarCode ?? this.feed.factsOf(symbol)?.calendarCode ?? null,
      closures: this.sessionSpec()?.closures ?? null,
      liveAt: this.liveAt() ?? 0,
      lastBarEnd: last ? (last.closeTime ?? last.time + step) : null,
      nowMs: Math.max(this.marketClock(), this.liveAt() ?? 0),
    });
  });
  // ── UD11: continuous futures (adjusted / raw, roll markers) and equity adjustment ──
  readonly seriesAdjustments = new ChartSeriesAdjustments({
    symbol: () => this.symbol(),
    bars: () => this.bars(),
    precision: () => this.precision(),
    assetClass: () => this.facts().assetClass,
    selectSymbol: (symbol) => this.selectSymbol(symbol),
    reload: () => this.reload(),
    feed: this.feed,
    futuresRolls: inject(FuturesRollsService),
  });
  readonly rollMarkers = this.seriesAdjustments.rollMarkers;
  readonly seriesOptions = this.seriesAdjustments.seriesOptions;

  /** The legend's three-state tone (kept for older bindings): open / closed / stale. */
  readonly marketStatus = computed<'open' | 'closed' | 'stale'>(() => this.marketView().tone);

  /** US05: the polite live region's message (symbol + market state on a change, the price at most every 30 s). */
  readonly liveMessage = signal('');
  private readonly announcer = new ChartAnnouncer();
  private readonly announce = effect(() => {
    const close = this.bars().at(-1)?.close;
    const input = {
      symbol: this.synthetic() ? syntheticTitle(this.synthetic()!) : this.symbol(),
      interval: this.resolutionLabel(this.resolution()),
      market: this.marketView().label || null,
      price: close === undefined ? null : close.toFixed(this.precision()),
    };
    untracked(() => {
      const message = this.announcer.next(input, Date.now());
      if (message) this.liveMessage.set(message);
    });
  });
  /** What the bars are (UD07): kind, source, exchange, contract, perpetual, volume unit, adjustment. */
  readonly symbolChips = computed((): SymbolChip[] => {
    // US04: a spread / ratio symbol says what it is and how it was built.
    const syn = this.synthetic();
    if (syn)
      return [
        {
          id: 'synthetic',
          text: syn.kind === 'ratio' ? 'Synthetic ratio' : 'Synthetic spread',
          title: this.syntheticNote() ?? syntheticNotice(syn, { carriedA: 0, carriedB: 0, dropped: 0 }),
        },
      ];
    return symbolChips(
      this.feed.factsOf(this.symbol()),
      this.catalogueRow(this.symbol()),
      this.marketClock(),
    );
  });

  /** US04: the main symbol as a spread / ratio of two symbols (`RATIO(A,B)`, `SPREAD(A,B,m)`), or null. */
  readonly synthetic = computed(() => parseSynthetic(this.symbol()));
  /** US04: what the synthetic was built from (the legs held as of each bar), for its chip. */
  readonly syntheticNote = signal<string | null>(null);
  /** US04: the synthetic's live price from its legs' ticks. */
  private readonly syntheticTicks = new SyntheticTicks();

  /** US04: open a compare dialog's ratio / spread as the main chart's symbol. */
  openSynthetic(spec: SyntheticSpec): void {
    this.selectSymbol(syntheticSymbol(spec));
  }

  // ── Split view ───────────────────────────────────────────────────────────
  //
  // The primary chart keeps every tool. Comparison panels are their own charts
  // with their own symbol, timeframe, bars and drawings — drawings are scoped
  // per symbol+timeframe, so each panel renders only its own.
  /** US02: the split view's other charts ({@link SplitPanelsController}); the page keeps their ties to the main chart. */
  readonly split = new SplitPanelsController({
    feed: this.feed,
    isSessionResolution: (r) => isSessionResolution(r),
    noDataMessage: (symbol, r) => noDataMessage(symbol, this.resolutionLabel(r), this.catalogueRow(symbol)),
    candidates: (taken) => panelCandidates(this.symbols(), this.instruments.all(), taken),
    mainSymbol: () => this.symbol(),
    mainResolution: () => this.resolution(),
    hostAt: (index) => this.panelHosts()[index],
    now: () => this.serverClock.now(),
    calendarOf: (symbol) => this.calendarOf(symbol),
    calendarCodeOf: (symbol) =>
      this.feed.factsOf(symbol)?.calendarCode ?? this.panelFacts(symbol).instrument.tradingCalendarCode ?? null,
    loadCalendar: (code) => this.instruments.calendar(code).then((cal) => (cal ? exchangeSessionsOf(cal) : null)),
    linkSymbol: (id, symbol) => this.linked.linkSymbol(id, symbol),
    linkInterval: (id, r) => this.linked.linkInterval(id, r),
  });
  readonly splitLayout = this.split.layout;
  readonly comparePanels = this.split.panels;
  readonly splitLayouts = SPLIT_LAYOUTS;

  /**
   * The left rail, grouped as TradingView groups it: one button per family, the rest of the
   * family in a flyout. Fifty-odd single buttons in a column was a scroll hunt.
   */
  // ── Auto analysis (DR-I11) ────────────────────────────────────────────────────
  /** Which auto-analysis layers are on (a synced chart preference). */
  readonly autoAnalysis = signal<AutoAnalysisSettings>({
    trendlines: false,
    htfLevels: false,
    autoFib: false,
    ...readPref<Partial<AutoAnalysisSettings>>('autoAnalysis', {}),
  });
  readonly autoAnalysisOn = computed(() => {
    const a = this.autoAnalysis();
    return a.trendlines || a.htfLevels || a.autoFib;
  });
  readonly autoAnalysisLayers: { id: keyof AutoAnalysisSettings; label: string; hint: string }[] = [
    {
      id: 'trendlines',
      label: 'Trendlines',
      hint: 'Fitted trendlines, scored by touches, age and recency',
    },
    {
      id: 'htfLevels',
      label: 'HTF levels',
      hint: "The next higher timeframe's support and resistance",
    },
    { id: 'autoFib', label: 'Auto Fib', hint: 'Fibonacci retracement of the last zig-zag leg' },
  ];

  /** The menu's main switch: all layers on, or all off. */
  toggleAutoAnalysis(): void {
    const on = !this.autoAnalysisOn();
    this.setAutoAnalysis({ trendlines: on, htfLevels: on, autoFib: on });
  }

  toggleAutoLayer(id: keyof AutoAnalysisSettings): void {
    this.setAutoAnalysis({ ...this.autoAnalysis(), [id]: !this.autoAnalysis()[id] });
  }

  private setAutoAnalysis(next: AutoAnalysisSettings): void {
    this.autoAnalysis.set(next);
    writePref('autoAnalysis', next);
  }

  // ── Pattern & structure scorecard (DR-I8) ─────────────────────────────────────
  readonly scorecardOpen = signal(false);
  /** The live spread (ask − bid), for the scorecard's cost; null before a quote. */
  readonly liveSpread = computed(() => {
    const q = this.liveQuote();
    return q && q.ask !== null && q.ask > q.bid ? q.ask - q.bid : null;
  });
  /** The candlestick studies' trend filter (the first one's), as the scorecard reads them. */
  readonly scorecardTrend = computed<CandleTrendFilter>(() => {
    const c = this.active().find((a) => studyKind(a.defId) === 'candle-pattern');
    return c?.params['trend'] === 'none' ? 'none' : 'sma50';
  });
  /** The chart-pattern study's swing size (the first one's), else 5. */
  readonly scorecardDepth = computed(() => {
    const c = this.active().find((a) => studyKind(a.defId) === 'chart-pattern');
    const d = Number(c?.params['pivotDepth'] ?? 5);
    return Number.isFinite(d) && d >= 1 ? d : 5;
  });

  openScorecard(): void {
    this.openMenu.set(null);
    this.scorecardOpen.set(true);
  }

  /**
   * A scorecard row exported as a Pine strategy (DR-I8): a NEW, unsaved script in the Pine Editor — nothing is saved,
   * added to the chart or run until the operator does it.
   */
  openPineDraft(d: { name: string; source: string }): void {
    this.scorecardOpen.set(false);
    this.assistSource.set(null);
    this.editorKey.set(null);
    this.editorCleared.set(true);
    this.editorDraft.set({ key: null, text: d.source });
    this.editor.pushAssist(d.source);
    this.editorOpen.set(true);
    this.frontDock('editor');
    this.notify.success(`${d.name} is in the Pine Editor as an unsaved draft.`);
  }

  /** The favourite drawing tools (DR-I12): starred in the flyouts, on the Favourites bar. */
  readonly favoriteTools = inject(DrawingFavorites);

  closeRailFlyout(): void {
    this.railFlyout.set(null);
    this.magnetMenuOpen.set(false);
    this.drawingMenu.set(null);
    this.vpMenuOpen.set(false);
    this.openMenu.set(null);
    this.layoutMenuOpen.set(false);
    this.symbolMenuOpen.set(false);
  }


  setVolumeProfileMode(mode: VolumeProfileMode): void {
    this.volumeProfileMode.set(mode);
    this.showVolumeProfile.set(true);
    this.vpMenuOpen.set(false);
  }

  volumeProfileModeLabel(): string {
    return VOLUME_PROFILE_MODES.find((m) => m.id === this.volumeProfileMode())?.label ?? '';
  }

  /** The chart symbol's instrument facts (UI01): the ONE source of precision, tick, distance unit, sizing, ticket. */
  readonly facts = computed(
    () =>
      instrumentFacts(this.symbol(), {
        pair: this.currentPair() ?? null,
        // US04: a synthetic is no instrument — never looked up, and (as while resolving) no ticket, ladder or proposal
        // can place anything on it.
        lookup: this.synthetic() ? 'resolving' : this.instruments.lookupState(this.symbol()),
        refPrice: () => this.bars().at(-1)?.close ?? null,
        digitsHint: () => decimalsOfPrices(this.bars().slice(-50).map((b) => b.close)),
      }),
    { equal: sameFacts },
  );

  readonly precision = computed(() => this.facts().precision);

  readonly priceScale = computed(() => priceScaleFor(this.precision()));

  /** The bars on screen (the chart's visible window), or every loaded bar before it is up. */
  private visibleBars(): Bar[] {
    return this.host()?.visibleWindow() ?? this.bars();
  }

  /** The search's asset-class filter (null = all); the chips show only when the catalogue holds more than FX. */
  /** b9-maint: the symbol search's lists ({@link ChartSymbolSearch}); the template reads it as `symbolSearch`. */
  readonly symbolSearch = new ChartSymbolSearch({
    open: () => this.symbolMenuOpen(),
    query: () => this.symbolQuery(),
    symbols: () => this.symbols(),
    selectSymbol: (symbol) => this.selectSymbol(symbol),
    instruments: this.instruments,
    destroyRef: this.destroyRef,
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

  readonly workspace = inject(ChartWorkspaceSync);
  private readonly prefs = inject(ChartPrefsService);

  constructor() {
    this.loadSymbols();

    // ── Workspace: restore, then auto-save every change (engine `chart/layouts`). ──
    // The route resolver settled the engine's preferences and active layout before this render.
    drawingTemplates.useStorage(this.prefs.storage);
    prefsRef = this.prefs;
    this.layoutStore.reload();
    this.classDefaults.reload();
    this.favoriteTools.reload();
    this.drawingTools.reloadPrefs();
    const deepLink = !!this.route.snapshot.paramMap.get('symbol');
    // "My scripts" first, so a restored script runs its newest saved version.
    this.chartScripts
      .loadSaved()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyState(this.workspace.initialState, deepLink));
    // Switches, deletes and newer saves from elsewhere — only those made while this page is up.
    const seenSeq = this.workspace.incoming()?.seq ?? 0;
    // Trades & signals follow the header's account selection: switching account redraws the
    // positions, working orders and martingale rungs for that account only. Depend on the KEY —
    // accountIds() is rebuilt on the scope service's 30 s refresh and would loop — and keep the
    // body untracked (loadTradingOverlays reads accountIds() itself).
    effect(() => {
      this.accountScope.accountIdsKey();
      untracked(() => this.loadTradingOverlays());
    });
    // Each trade toggle (menu, assistant command, restored layout) loads or clears its own layer.
    effect(() => {
      this.showPositions();
      this.showOrders();
      this.showOverlays();
      this.showClosedTrades();
      untracked(() => this.loadTradingOverlays());
    });
    effect(() => {
      const incoming = this.workspace.incoming();
      if (incoming && incoming.seq > seenSeq) untracked(() => this.applyState(incoming.state));
    });
    effect(() => {
      const state = this.captureState();
      // Nothing saves before the saved state was applied, nor while applying it.
      if (!this.restored || this.applyingState) return;
      untracked(() => this.workspace.markDirty(state));
    });
    // CC-I11: one undo history. Drawing steps arrive from the drawing store; studies, scripts and chart settings are
    // recorded here as the operator changes them (a burst of changes within half a second is one step).
    this.drawings.undoHook = {
      recorded: (symbol) => this.chartUndo.undoHistory.record({ kind: 'drawing', symbol }),
      dropped: (symbol) => this.chartUndo.undoHistory.dropDrawing(symbol),
    };
    this.destroyRef.onDestroy(() => {
      this.drawings.undoHook = null;
      this.chartUndo.dispose();
    });
    effect(() => {
      const now = this.chartUndo.undoableState();
      untracked(() => this.chartUndo.noteUndoable(now));
    });
    // A live price belongs to one symbol: a switch waits for the new symbol's first tick.
    effect(() => {
      this.symbol();
      untracked(() => {
        this.liveAt.set(null);
        this.liveQuote.set(null);
      });
    });
    // Leaving the page (route change) saves what is pending.
    this.destroyRef.onDestroy(() => void this.workspace.flush());

    // FX-fundamental studies: fetched per symbol, drawn as their own panes.
    effect(() => {
      const items = this.active().filter((a) => a.visible && studyKind(a.defId) === 'fundamental');
      const symbol = this.symbol();
      this.paneScope();
      untracked(() => this.loadFundamentals(items, symbol));
    });

    // The other charts' scripts (CC-I5) run when their chart has bars and again at each new bar — not per tick —
    // unless the main chart's identical run covers them.
    effect(() => {
      const panels = this.comparePanels();
      const main = this.scriptRuns();
      untracked(() => {
        for (const p of panels) {
          const last = p.bars.at(-1)?.time;
          if (last === undefined) continue;
          for (const s of p.scripts)
            if (s.ranTo !== last && !sharedRun(main, s, p.symbol, p.resolution))
              this.linked.runPanelScript(p.id, s.item.key);
        }
      });
    });

    // Compare studies need the other symbol's bars on the same resolution.
    effect(() => {
      const symbols = this.compareSymbols();
      const resolution = this.resolution();
      untracked(() => void this.loadCompareBars(symbols, resolution));
    });

    // A Pine run describes ONE symbol+timeframe; re-run on a switch rather than paint
    // another instrument's plots over this one. Its outputs leave the chart at once
    // (scriptResults); these explicit runs supersede the old series' runs still in flight.
    effect(() => {
      const symbol = this.symbol();
      const resolution = this.resolution();
      untracked(() => {
        const runs = this.scriptRuns();
        if (runs.some((r) => r.symbol !== symbol || r.resolution !== resolution)) {
          for (const r of runs) this.runScript(r.item, r.values, true);
        }
        // Scripts whose first run was for the series the chart left start over on this one.
        for (const p of this.pendingScripts().values())
          if (p.symbol !== symbol || p.resolution !== resolution)
            this.runScript(p.item, p.values, true);
      });
    });

    // A run is computed on the bars the chart draws (PC-09): a switch between Heikin-Ashi and a
    // standard style runs every script again on the other bars — meanwhile its panes stay, nothing
    // drawn (scriptResults: suspended). A price-based style runs nothing (not available there); the
    // way back from one finds the runs as they were, and re-runs only those on the other basis.
    effect(() => {
      const basis = this.chartBasis();
      untracked(() => {
        if (basis === null) return;
        for (const r of this.scriptRuns())
          if ((r.chartType ?? 'standard') !== basis) this.runScript(r.item, r.values, true);
      });
    });

    // The quiet re-runs below (the minute timer, the forming bar, a theme switch) go through
    // `runScheduler`: one run per script in flight — an explicit run counts — spaced by its round
    // trip, held while the tab is hidden.
    const resumeReruns = () => this.runScheduler.resume();
    document.addEventListener('visibilitychange', resumeReruns);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', resumeReruns);
      this.runScheduler.dispose();
    });
    /**
     * Quiet re-runs of the scripts on this chart (`filter`: which of them). A hidden indicator is not
     * kept current — nothing of it shows — and runs again when shown (toggleScriptVisible); a hidden
     * strategy is, for its Strategy Tester.
     */
    const rerunScripts = (filter: (r: ChartScriptRun) => boolean) => {
      // Not on a chart type runs cannot sit on (a price-based style): nothing of them shows there.
      if (this.chartBasis() === null) return;
      const chart = { symbol: this.symbol(), resolution: this.resolution() };
      for (const r of this.scriptRuns()) {
        const hidden = r.result.kind !== 'strategy' && !resolveDisplay(r.display).visible;
        if (sameSeries(r, chart) && !hidden && filter(r)) this.runScheduler.request(r.item.key);
      }
    };

    // Scroll-back paging prepends history; a run only covers the bars it asked for, so its plots
    // would stop where its window began. Re-run (debounced: one page = one run, not one per
    // page while the operator keeps dragging) once the loaded history outgrows a run's window.
    let extendTimer: ReturnType<typeof setTimeout> | undefined;
    this.destroyRef.onDestroy(() => clearTimeout(extendTimer));
    effect(() => {
      const loaded = this.bars().length;
      untracked(() => {
        clearTimeout(extendTimer);
        const want = Math.min(loaded, MAX_SCRIPT_BARS);
        if (!this.scriptRuns().some((r) => r.requestedBars < want)) return;
        const extend = (): void => {
          const chart = { symbol: this.symbol(), resolution: this.resolution() };
          const short = this.scriptRuns().filter(
            (r) => sameSeries(r, chart) && r.requestedBars < want,
          );
          // A run in flight (live re-runs included) has not recorded its window yet: wait for it
          // rather than start a second one beside it — or abort it.
          if (short.some((r) => this.runsInFlight.has(r.item.key))) {
            extendTimer = setTimeout(extend, 600);
            return;
          }
          for (const r of short) this.runScript(r.item, r.values, true);
        };
        extendTimer = setTimeout(extend, 600);
      });
    });

    // Keep runs live. The engine runs the forming bar (folded from closed M1 candles) as the realtime bar,
    // so a run is current to the minute it was made — and only then: left alone, the overlay falls a bar
    // behind the chart every period. Re-run once a minute, the M1 cadence the forming bar moves at; not
    // during replay. Strategies (which backtest closed bars) are kept current by this alone. Through
    // the scheduler like every other re-run: a slow script's minute re-run used to start beside its
    // live re-run still in flight.
    this.scheduler.every('script-reruns', 60_000, () => {
      if (this.replayActive()) return;
      // PC-I1: a script whose warm session the hub keeps current is not run again — it is asked what changed instead
      // (a quiet market pushes nothing, and this is how a session that ended is found).
      rerunScripts((r) => !this.warmCovered(r.item.key));
      for (const s of this.warmSessions.all()) if (this.warmCovered(s.key)) this.resyncWarm(s.key);
    });

    // TradingView behaviour: an indicator's last value sits on the forming bar and moves with it.
    // Every change to the chart's newest bar (a tick, an M1 resync, a new period opening) re-runs
    // the indicators on this chart with that bar as `liveBar` — never two in flight per script, at
    // least 2 s apart and 4× the last run's round trip apart for a slow script (a heavy one ran
    // back to back: 40 runs of ~600 KB in 98 s), and not at all while the tab is hidden: the ticks
    // that arrive meanwhile collapse into one run when it is shown again.
    effect(() => {
      const bars = this.bars();
      const last = bars[bars.length - 1];
      // Track the newest bar's identity and values only.
      const sig = last ? `${last.time}|${last.open}|${last.high}|${last.low}|${last.close}` : '';
      untracked(() => {
        // A hidden tab still requests: the scheduler holds them until it is visible.
        if (!sig || this.replayActive()) return;
        // PC-I1: a warm session's frames keep its script current: no run per tick for it.
        rerunScripts((r) => r.result.kind !== 'strategy' && !this.warmCovered(r.item.key));
      });
    });

    // `chart.bg_color` / `chart.fg_color` answer with the theme a run was requested in (every run
    // sends it): a theme switch re-runs the scripts on the chart, quietly, so whatever they draw in
    // the chart's colours follows the chart.
    let runTheme = this.theme.theme();
    effect(() => {
      const theme = this.theme.theme();
      untracked(() => {
        if (theme === runTheme) return;
        runTheme = theme;
        rerunScripts(() => true);
      });
    });

    // Bar Replay (PC-08, PC-I8): the scripts run to the head — on the bars the chart shows, never
    // one past them — when replay starts and each time the head moves; leaving replay runs them to
    // now again. Quiet re-runs through the scheduler: stepping or playing faster than a run comes
    // back collapses into one run to wherever the head is when it starts. Meanwhile a run past the
    // head shows nothing (its future would be on the chart) and one short of it shows as far as it
    // goes (scriptResults).
    let replayedTo: number | null = null;
    effect(() => {
      const head = this.replayHead();
      untracked(() => {
        if (head === replayedTo) return;
        replayedTo = head;
        rerunScripts((r) => (r.until ?? null) !== head);
      });
    });

    // A pick on its way for a Settings dialog that closed (its script left the chart): the chart
    // stops waiting for the click (PC-I12).
    effect(() => {
      if (this.settings.run() === null) untracked(() => this.host()?.cancelPick());
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
        tradeOverlays: this.anyTradeOverlay(),
        positions: this.showPositions(),
        pendingOrders: this.showOrders(),
        signals: this.showOverlays(),
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

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    this.chartCommandList = chartCommands({
      symbol: this.symbol,
      resolution: this.resolution,
      style: this.style,
      showVolume: this.showVolume,
      // The assistant's single "trades" switch drives all three layers.
      showOverlays: Object.assign(() => host.anyTradeOverlay(), {
        set: (v: boolean) => {
          host.showPositions.set(v);
          host.showOrders.set(v);
          host.showOverlays.set(v);
        },
      }),
      showPositions: this.showPositions,
      showOrders: this.showOrders,
      showSignals: this.showOverlays,
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
      takeSnapshot: () => this.layoutActions.takeSnapshot(),
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

      layouts: () =>
        this.workspace.layouts().map((l) => ({
          id: String(l.id),
          name: l.name,
          symbol: l.isActive ? this.symbol() : '',
          resolution: l.isActive ? this.resolution() : '',
        })),
      // The toolbar asks for names in a dialog, which nothing outside the browser can answer —
      // so the workspace is called directly with the given name.
      saveLayout: (name) => {
        void this.workspace.duplicate(name);
        return '';
      },
      applyLayout: (id) => void this.workspace.switchTo(Number(id)),
      removeLayout: (id) => void this.workspace.remove(Number(id)),
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
        if (found) this.layoutActions.applyTemplate(found);
      },
      removeStudyTemplate: (id) => this.layoutStore.removeTemplate(id),

      replay: () => ({
        active: this.replayActive(),
        index: this.replayIndex(),
        total: this.bars().length,
        playing: this.replayPlaying(),
        speed: this.replaySpeed(),
      }),
      startReplay: () => this.timeNav.startReplay(),
      exitReplay: () => this.timeNav.exitReplay(),
      stepReplay: (d) => this.timeNav.stepReplay(d),
      toggleReplayPlay: () => this.timeNav.toggleReplayPlay(),
      setReplaySpeed: (x) => this.timeNav.setReplaySpeed(String(x)),
      setReplayIndex: (i) => this.timeNav.setReplayIndex(String(i)),

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
      toggleFullscreen: () => this.layoutActions.toggleFullscreen(),
      isFullscreen: () => this.isFullscreen(),
      showVolumeProfile: this.showVolumeProfile,
      showSupportResistance: this.showSupportResistance,
      showStructure: this.showStructure,
      // The window on screen — what the chart's own overlays describe (CC-21: these read every
      // loaded bar while the chart drew the visible ones, so the assistant quoted other levels).
      structureSummary: () =>
        marketStructure(this.visibleBars(), {
          pipSize: this.pipSize(),
          unitLabel: this.facts().distanceLabel,
          precision: this.precision(),
        }).summary,
      // Computed on demand rather than held in a signal: the assistant asks rarely, and a
      // second copy of this would be a second thing that can disagree with the chart.
      srLevels: () => supportResistance(this.visibleBars()),
      volumeProfile: () => {
        const p = profileWithValueArea(this.visibleBars());
        return p
          ? { poc: p.poc, valueAreaLow: p.valueAreaLow, valueAreaHigh: p.valueAreaHigh }
          : null;
      },
    });
    // The same commands drive the operator's command palette (CC-I11).
    this.uiCommands.register(this.chartCommandList, this.destroyRef);

    // Keep the live-price subscriptions in step with what is on screen: the
    // primary chart, every comparison panel, and — only while it is open —
    // the watchlist. The watchlist costs 23 rooms, which is the honest price
    // of a live watchlist and why it is not subscribed when closed.
    effect(() => {
      const wanted = new Set<string>([
        this.symbol().toUpperCase(),
        ...this.comparePanels().map((p) => p.symbol.toUpperCase()),
        // A compare study's other symbol follows its live price (CC-13).
        ...this.compareSymbols(),
        ...(this.watchlistOpen() ? this.watchlistSymbols() : []),
      ]);
      wanted.delete('');
      untracked(() => this.syncPriceSubscriptions(wanted));
    });

    // PC-I1: warm sessions' frames, and a resync after the scripting hub came back (frames may have been missed).
    this.scriptHub.frames$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((frame) => this.onScriptFrame(frame));
    this.scriptHub.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      for (const s of this.warmSessions.all()) this.resyncWarm(s.key);
    });
    this.destroyRef.onDestroy(() => {
      for (const s of this.warmSessions.all()) this.releaseWarm(s.key);
    });
    // EV-1: a headline labelled for the pair's currencies re-reads the news pane (and the watchlist's headline).
    this.newsPane.followIngested(this.realtime.on<NewsArticleIngestedPayload>('newsArticleIngested'));

    // UA01: the instrument resolved after the events were read (catalogue lookup, the first chart-bars answer): ask again.
    effect(() => {
      this.eventRelevance();
      untracked(() => {
        if (this.eventsState.holdsEventsFor(this.symbol())) this.loadEvents();
      });
    });
    // Ticking clock, and presets applied once their interval's bars are in.
    this.tickClock();
    this.scheduler.every('clock', 1_000, () => this.tickClock());
    effect(() => {
      this.bars();
      this.timezone();
      untracked(() => {
        this.tickClock();
        queueMicrotask(() => {
          this.timeNav.flushPendingRange();
          this.flushPendingView();
        });
      });
    });

    // Remember the dock state, and keep the headline under the watchlist on the current symbol.
    effect(() => {
      const open = this.watchlistOpen();
      try {
        appStorage.setItem(WATCHLIST_OPEN_KEY, open ? '1' : '0');
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
    this.destroyRef.onDestroy(() => {
      this.replay.pause();
      this.engine.replayRuns.stopAll();
    });

    // Deep link: /chart-analysis/EURUSD?tf=60 so a chart can be linked to from
    // a position or a signal without the operator re-selecting anything.
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => this.followRoute(params));

    // Live price → update the forming bar. The engine throttles these, so this
    // is a repaint of the last candle rather than a tick stream.
    this.realtime
      .on<PriceTick>('priceUpdated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tick) => {
        this.applyTick(tick);
        this.applyCompareTick(tick);
        this.applyPanelTick(tick);
        this.recordQuote(tick);
      });

    // The trade layers follow the engine (CC-09): a fill, a position opening, changing or closing, a
    // new working order or signal reloads them — they used to load once per symbol and never follow.
    for (const event of [
      'orderCreated',
      'orderFilled',
      'positionOpened',
      'positionClosed',
      'positionLifecycleEvent',
      'tradeSignalCreated',
    ] as const) {
      this.realtime
        .on<unknown>(event)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((payload) => this.scheduleTradeRefresh(payload));
    }
    this.destroyRef.onDestroy(() => clearTimeout(this.tradeRefreshTimer));

    // Re-read the forming bar every minute — folded from M1 on 1m … 1h, the engine's newest bars on
    // the session grid. Ticks arrive throttled to ~1 Hz, so a spike between two of them never reaches
    // the live bar's high or low; and a bar that closed while the page was open was built entirely
    // from those throttled ticks. One small request a minute keeps the newest candle honest without
    // waiting for a reload.
    // US06: on the page's scheduler — not while the tab is hidden; re-read at once when it shows again.
    this.scheduler.every('forming-resync', 60_000, () => void this.session.syncFormingBars());
  }

  /** US02: the trade layers' loads ({@link TradeLayersLoader}). */
  private loadTradingOverlays(): void {
    this.tradeLayers.load();
  }

  /**
   * The engine reported a fill, a position change or a new signal: reload the trade layers once the
   * burst settles (a fill brings orderFilled, positionOpened and a lifecycle event together). Events
   * that name another symbol are not this chart's.
   */
  private tradeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleTradeRefresh(payload: unknown): void {
    if (!this.anyTradeOverlay() && !this.showClosedTrades()) return;
    if (!concernsSymbol(payload, this.symbol())) return;
    clearTimeout(this.tradeRefreshTimer);
    this.tradeRefreshTimer = setTimeout(() => this.loadTradingOverlays(), 400);
  }

  setBoxSize(raw: string): void {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) this.boxSizeAtr.set(value);
  }

  setBoxPips(raw: string): void {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) this.boxPips.set(value);
  }

  setPnfReversal(raw: string): void {
    const value = Math.round(Number(raw));
    if (Number.isFinite(value) && value >= 1 && value <= 10) this.pnfReversal.set(value);
  }

  setLineBreakLines(raw: string): void {
    const value = Math.round(Number(raw));
    if (Number.isFinite(value) && value >= 1 && value <= 10) this.lineBreakLines.set(value);
  }

  /**
   * The price-based styles that take a box — Renko's brick, Point & Figure's box, Kagi's reversal,
   * Range's range — so the box control appears. Line break takes none; it has its lines (CC-17: the
   * box was shown for Line break, which ignores it, and hidden for Range, which uses it).
   */
  readonly boxStyle = computed(() => ['renko', 'kagi', 'pnf', 'range'].includes(this.style()));
  /** What the box is called on the current style. */
  readonly boxLabel = computed(() =>
    this.style() === 'kagi' ? 'Reversal' : this.style() === 'range' ? 'Range' : 'Box size',
  );

  /** b9-maint: {@link ChartEventsState.loadEvents} (the history pager, the session store and the specs call it here). */
  private loadEvents(extend = false): void {
    this.eventsState.loadEvents(extend);
  }

  toggleEvents(): void {
    this.eventsState.toggleEvents();
  }

  cycleEventImpact(): void {
    this.eventsState.cycleEventImpact();
  }

  openSidePane(pane: 'details' | 'news' | 'calendar' | 'datawindow'): void {
    this.newsPane.openSidePane(pane);
  }

  openPanel(panel: SidePanel): void {
    this.newsPane.openPanel(panel);
  }

  private loadNews(): void {
    this.newsPane.loadNews();
  }

  /**
   * Keep the watchlist's last price and a reference for the change column.
   *
   * `prev` is seeded once per symbol and then left alone, so the percentage is
   * the move since this page opened rather than since the previous tick — a
   * per-tick delta reads as permanent noise around zero.
   */
  private recordQuote(tick: PriceTick): void {
    const symbol = tick?.symbol?.toUpperCase();
    // UD05: a venue's last trade (its bid/ask may be null); MT5 the bid, as before.
    const bid = tickPrice(tick);
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
    void this.instruments.load();
    this.pairs
      .list({ currentPage: 1, itemCountPerPage: 200, filter: {} })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter((p) => p.isActive && p.symbol);
        this.symbols.set(rows);
      });
  }

  /**
   * The URL's symbol and timeframe onto the chart: a deep link, or a link to another symbol
   * followed while the chart is open. The chart's own switches navigate as well
   * ({@link selectSymbol}), and come back here with the series the switch is already loading —
   * loading it a second time sent every history and forming-bar request of a symbol switch twice
   * (`reload` starts by invalidating the feed's cache, so the second load shared nothing).
   */
  private followRoute(params: ParamMap): void {
    const symbol = params.get('symbol')?.toUpperCase() || this.symbol();
    const tf = this.route.snapshot.queryParamMap.get('tf');
    const resolution = tf && isSupportedResolution(tf) ? (tf as TvResolution) : this.resolution();
    if (sameSeries(this.session.requested, { symbol, resolution })) return;
    this.symbol.set(symbol);
    this.resolution.set(resolution);
    void this.reload();
  }

  async reload(): Promise<void> {
    const symbol = this.symbol();
    const resolution = this.resolution();
    // Bar Replay stays at its instant across a symbol or timeframe switch (CC-I4).
    const replayAnchor = this.replayHead();
    /** Still the chart's series? A switch made while this loads has a reload of its own. */
    const current = () => this.session.isCurrent(symbol, resolution);
    this.session.beginLoad(symbol, resolution);
    // Drawings belong to a symbol AND timeframe, so the scope has to move with
    // the chart before any drawing is read or written.
    this.drawings.setScope(symbol, resolution);
    this.loadTradingOverlays();
    // The symbol's session, which the day-based studies count trading days by, comes with every
    // session-grid load; the stored grid's candles carry none, so it is asked for once beside them.
    if (!isSessionResolution(resolution) && !parseSynthetic(symbol)) void this.feed.learnSession(symbol);
    const now = Date.now();
    try {
      const { bars } = await this.feed.getBars(symbol, resolution, 0, now, PAGE_BARS);
      // Landing after a switch, these would go on screen under the next symbol's name.
      if (!current()) return;
      this.session.acceptBars(symbol, resolution, bars);
      // US04: a synthetic's legs seed its live price; its chip says how it was built.
      const syn = parseSynthetic(symbol);
      const build = syn ? this.feed.syntheticBuildOf(symbol, resolution) : null;
      this.syntheticTicks.reset(syn, build?.lastA ?? null, build?.lastB ?? null);
      this.syntheticNote.set(syn && build ? syntheticNotice(syn, build) : null);
      if (this.replayActive() && replayAnchor !== null) void this.timeNav.reanchorReplay(replayAnchor);
      this.session.resetFormingState(bars, resolution);
      // After the bars, so the calendar window matches what is on screen.
      this.loadEvents();
      if (bars.length === 0) {
        // UD10: why there is nothing — "no data yet (no source enabled)" from the catalogue — never a blank chart.
        this.error.set(
          noDataMessage(symbol, this.resolutionLabel(resolution), this.catalogueRow(symbol)),
        );
      }
    } catch (e) {
      if (current()) {
        this.error.set(
          e instanceof Error && e.message
            ? `Could not load candles: ${e.message}`
            : 'Could not load candles.',
        );
      }
    } finally {
      if (current()) {
        this.loading.set(false);
        this.host()?.historyLoaded();
      }
    }
  }

  /** Scroll-back paging (CC-11, CC-14) — {@link ChartSessionStore.loadOlder}. */
  loadOlder(): Promise<void> {
    return this.session.loadOlder();
  }

  private applyTick(tick: PriceTick): void {
    // US04: a leg of the synthetic main series moves it (its price from both legs' latest).
    if (this.synthetic() && tick?.symbol && this.syntheticTicks.isLeg(tick.symbol)) {
      const leg = tickPrice(tick);
      const price = leg === null ? null : this.syntheticTicks.price(tick.symbol, leg);
      if (price === null) return;
      tick = { symbol: this.symbol(), bid: price, timeUtc: tick.timeUtc };
    }
    if (!tick?.symbol || tick.symbol.toUpperCase() !== this.symbol().toUpperCase()) return;
    // UD04/UD05: MT5 = the bid (bid bars, unchanged); a venue = its last trade / mid. Placed at the tick's own time.
    const price = tickPrice(tick);
    if (price === null) return;
    const at = tickTimeMs(tick, this.serverClock.now());
    this.liveAt.set(Date.now());
    // The open positions' P&L reads both sides: a long exits at the bid, a short at the ask.
    const ask = typeof tick.ask === 'number' && Number.isFinite(tick.ask) ? tick.ask : null;
    const bid = typeof tick.bid === 'number' && Number.isFinite(tick.bid) ? tick.bid : price;
    this.liveQuote.set({ bid, ask });

    this.session.applyPrice(price, at);
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────

  startDockResize(ev: PointerEvent): void {
    ev.preventDefault();
    const startX = ev.clientX;
    // From the width on screen: the dock is capped at 40% of the chart (the SCSS), so a narrow
    // chart shows less than the remembered width and a drag from it would jump.
    const shown = (ev.currentTarget as HTMLElement | null)?.parentElement?.getBoundingClientRect()
      .width;
    const startW = shown ? Math.round(shown) : this.dockWidth();
    const move = (e: PointerEvent) =>
      this.dockWidth.set(Math.min(640, Math.max(240, startW + (startX - e.clientX))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        appStorage.setItem(DOCK_WIDTH_KEY, String(this.dockWidth()));
      } catch {
        // Per-viewer convenience only.
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Switch the main chart's symbol — and, with symbol sync on, the charts linked to it (CC-I5). */
  selectSymbol(symbol: string, propagate = true): void {
    this.symbolMenuOpen.set(false);
    this.symbolQuery.set('');
    if (symbol === this.symbol()) return;
    // Layout memory per symbol (CC-I11): the symbol left is remembered as it is; the one switched to opens as it was left.
    this.symbolMemory.update((m) =>
      rememberSymbol(m, this.symbol(), {
        resolution: this.resolution(),
        ...(this.viewSnapshot() ? { view: this.viewSnapshot()! } : {}),
      }),
    );
    const memory = this.rememberPerSymbol() ? recalled(this.symbolMemory(), symbol) : null;
    if (memory && isSupportedResolution(memory.resolution)) this.resolution.set(memory.resolution);
    // US07: a symbol of another asset class opens with that class's default, when the operator set one.
    const classDefault = defaultOnSwitch(
      this.classDefaults.defaults(),
      this.facts().resolving ? null : this.facts().assetClass,
      this.panelFacts(symbol).resolving ? null : this.panelFacts(symbol).assetClass,
      !!memory,
    );
    if (classDefault?.resolution) this.resolution.set(classDefault.resolution);
    const classTemplate = classDefault?.templateId
      ? this.layoutStore.templates().find((t) => t.id === classDefault.templateId)
      : undefined;
    if (classTemplate) this.active.set(this.layoutStore.instantiate(classTemplate));
    if (memory?.view) {
      this.pendingView = memory.view;
      this.pendingViewFor = { symbol, resolution: this.resolution() };
    }
    this.symbol.set(symbol);
    void this.router.navigate(['/chart-analysis', symbol], {
      queryParams: { tf: this.resolution() },
      replaceUrl: true,
    });
    void this.reload();
    if (propagate) this.linked.linkSymbol('main', symbol);
  }

  /** Switch the main chart's timeframe — and, with interval sync on, the charts linked to it (CC-I5). */
  selectResolution(r: TvResolution, propagate = true): void {
    if (r === this.resolution()) return;
    if (propagate) this.linked.linkInterval('main', r);
    this.resolution.set(r);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tf: r },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.reload();
  }

  /** Compare studies' other symbols' bars — {@link ChartCompareState}. */
  private loadCompareBars(symbols: string[], resolution: TvResolution): Promise<void> {
    return this.compareState.loadBars(symbols, resolution);
  }

  private extendCompareBars(oldestMs: number): Promise<void> {
    return this.compareState.extendBars(oldestMs);
  }

  private applyCompareTick(tick: PriceTick): void {
    this.compareState.applyTick(tick);
  }

  /** A live price moves the split panels that show its symbol (CC-12: they were static). */
  private applyPanelTick(tick: PriceTick): void {
    this.split.applyTick(tick);
  }

  /** A symbol's trading calendar, once the engine has reported its session. */
  private readonly calendars = new Map<string, TradingCalendar>();
  private calendarOf(symbol: string): TradingCalendar | null {
    const spec = this.feed.sessionOf(symbol);
    if (!spec) return null;
    const key = `${spec.session}|${spec.timeZone}`;
    let calendar = this.calendars.get(key);
    if (!calendar) {
      calendar = new TradingCalendar(spec);
      this.calendars.set(key, calendar);
    }
    return calendar;
  }

  private loadFundamentals(items: ActiveIndicator[], symbol: string): void {
    this.fundamentalPanes.load(items, symbol);
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

  /** Delete a "My scripts" entry (saved script or unsaved draft) confirmed in the dialog. */
  onDialogDelete(item: DialogItem): void {
    const script = this.scriptItemByKey(item.id);
    if (!script || script.source !== 'mine') return;
    const id = script.key.slice('mine:'.length);
    this.chartScripts
      .deleteScript(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.scriptCatalog.update((cat) =>
            cat ? { ...cat, mine: cat.mine.filter((m) => m.key !== script.key) } : cat,
          );
          this.notify.success(`Deleted “${script.name}”.`);
        },
        error: (e: Error) => this.notify.error(e?.message || 'Deleting the script failed.'),
      });
  }

  onDialogPick(item: DialogItem): void {
    if (item.kind === 'strategy' || item.kind === 'script') {
      const script = this.scriptItemByKey(item.id);
      // A saved script starts with its default inputs; one already on the chart keeps its own.
      if (script)
        this.runScript(
          script,
          this.scriptRuns().find((r) => r.item.key === script.key)?.values ??
            startingValues(script, this.chartScripts.savedScripts()),
        );
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

  // ── U13 (fu-ui): the script-run engine is ChartScriptEngine ({@link engine}); these delegate to it. ──
  /** What the engine reads and drives on the page: getters, so it can be built before the page's later fields. */
  private engineHost(): ScriptEngineHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const page = this;
    return {
      get scriptRuns() {
        return page.scriptRuns;
      },
      get symbol() {
        return page.symbol;
      },
      get resolution() {
        return page.resolution;
      },
      get chartBasis() {
        return page.chartBasis;
      },
      get bars() {
        return page.bars;
      },
      get barsFor() {
        return page.barsFor;
      },
      get replayActive() {
        return page.replayActive;
      },
      get replayClosedHead() {
        return page.replayClosedHead;
      },
      get replayHead() {
        return page.replayHead;
      },
      get replay() {
        return page.replay;
      },
      get replayScripts() {
        return page.replayScripts;
      },
      get serverClock() {
        return page.serverClock;
      },
      get chartScripts() {
        return page.chartScripts;
      },
      get scriptHub() {
        return page.scriptHub;
      },
      get scriptingApi() {
        return page.scriptingApi;
      },
      get destroyRef() {
        return page.destroyRef;
      },
      get scriptEditor() {
        return page.scriptEditor;
      },
      get notify() {
        return page.notify;
      },
      get restoringScripts() {
        return page.restoringScripts;
      },
      get settings() {
        return page.settings;
      },
      get editorKey() {
        return page.editorKey;
      },
      get editorDraft() {
        return page.editorDraft;
      },
      get logsKey() {
        return page.logsKey;
      },
      get testerOpen() {
        return page.testerOpen;
      },
      frontDock: (which) => page.frontDock(which),
      offerUndoReplace: (previous, replacement) => page.offerUndoReplace(previous, replacement),
    };
  }

  /** The run scheduler and runs in flight — aliases of the engine's. */
  private readonly runScheduler = this.engine.runScheduler;
  private readonly runsInFlight = this.engine.runsInFlight;

  private rerunQuietly(key: string, ticket: number): void {
    this.engine.rerunQuietly(key, ticket);
  }

  /** Run a Pine script/strategy over the loaded window and paint it ({@link ChartScriptEngine.runScript}). */
  runScript(
    item: ChartScriptItem,
    values: ScriptInputValues,
    replace = false,
    done?: (r: RunOutcome) => void,
    quiet?: number,
    update?: ScriptUpdate,
  ): void {
    this.engine.runScript(item, values, replace, done, quiet, update);
  }

  // ── PC-I1 warm sessions · PC-I9 realtime truthfulness — the engine's ({@link engine}); aliases + delegates ──
  private readonly warmSessions = this.engine.warmSessions;
  /** The scripts their warm session keeps current — the chip's live mark. */
  readonly warmKeys = this.engine.warmKeys;
  /** PC-I9: per script, the first repaint seen — its chip says it until the script leaves the chart. */
  readonly scriptRepaints = this.engine.scriptRepaints;

  private warmCovered(key: string): boolean {
    return this.engine.warmCovered(key);
  }

  private forgetTruth(key: string): void {
    this.engine.forgetTruth(key);
  }

  private releaseWarm(key: string): void {
    this.engine.releaseWarm(key);
  }

  private onScriptFrame(frame: ScriptSessionFrame): void {
    this.engine.onScriptFrame(frame);
  }

  private resyncWarm(key: string): void {
    this.engine.resyncWarm(key);
  }

  // ── PC-I14 alerts on a script ────────────

  /** "Create alert on <script>" (PC-I14): the alert form for a script on the chart, in a dialog. */
  readonly scriptAlertTarget = signal<ScriptAlertTarget | null>(null);
  private readonly scriptAlertDialog =
    viewChild<ElementRef<HTMLDialogElement>>('scriptAlertDialog');

  openScriptAlert(key: string): void {
    const run = this.scriptRuns().find((r) => r.item.key === key);
    if (!run) return;
    const id = savedScriptId(run.item);
    if (id === null) {
      this.notify.warning(
        run.item.source === 'strategy'
          ? `“${run.item.name}” is an engine strategy: its alerts are set on the strategy (its Live tab).`
          : `Save “${run.item.name}” to My scripts first: an alert runs a saved copy of the script, whether or not this chart is open.`,
      );
      return;
    }
    const source = run.item.pineSource ?? '';
    this.scriptAlertTarget.set({
      chartScriptId: Number(id),
      scriptName: run.result.title || run.item.name,
      alertConditions: (run.result.run?.outputs?.alertConditions ?? [])
        .map((a) => a.title)
        .filter(Boolean),
      // A library it imports may call alert() too: the engine checks and says so when it does not.
      callsAlert: /(?<![\w.])alert\s*\(/.test(source) || /^\s*import\s+/m.test(source),
      isStrategy: run.result.kind === 'strategy',
      symbol: this.symbol(),
      timeframe: runTimeframeFor(this.resolution()),
      inputs: Object.keys(run.values).length ? { ...run.values } : null,
    });
    queueMicrotask(() => this.scriptAlertDialog()?.nativeElement.showModal());
  }

  closeScriptAlert(saved?: ChartScriptAlertDto): void {
    this.scriptAlertDialog()?.nativeElement.close();
    this.scriptAlertTarget.set(null);
    if (saved)
      this.notify.success(
        `Alert “${saved.displayName}” armed — the engine watches it whether or not this chart is open.`,
      );
  }

  // Failures, pending / waiting / "Update on chart" state, aborts — the engine's ({@link engine}).
  private dropFailure(key: string): void {
    this.engine.dropFailure(key);
  }

  private dropPending(key: string): void {
    this.engine.dropPending(key);
  }

  private clearWaiting(key: string): void {
    this.engine.clearWaiting(key);
  }

  private abortRun(key: string, why: string): void {
    this.engine.abortRun(key, why);
  }

  private abortAllRuns(why: string): void {
    this.engine.abortAllRuns(why);
  }

  /** The eye on a script's chip or status line: hide it or show it again — no re-run to hide. */
  toggleScriptVisible(key: string): void {
    const run = this.scriptRuns().find((r) => r.item.key === key);
    if (!run) return;
    const visible = !resolveDisplay(run.display).visible;
    this.setScriptDisplay(key, { visible });
    // A hidden indicator is not kept current: shown again, it catches up.
    if (visible) this.runScheduler.request(key);
  }

  /**
   * Change how a script on the chart is shown (the eye, its Style and Visibility tabs): applied on
   * the client to its render model — no re-run — and saved with the layout (PC-01, PC-13).
   */
  setScriptDisplay(key: string, patch: Partial<ScriptDisplaySettings>): void {
    this.scriptRuns.update((runs) =>
      runs.map((r) =>
        r.item.key !== key
          ? r
          : { ...r, display: displayOverrides(resolveDisplay({ ...r.display, ...patch })) },
      ),
    );
  }

  /** A failure's "Line N": the script in the Pine Editor, at that line (PC-I7). */
  openScriptAt(key: string, where: { line: number; column: number }): void {
    this.openScriptSource(key);
    // The editor shows the script's text first (a fresh panel renders a frame later).
    const reveal = (tries: number): void => {
      const editor = this.scriptEditor();
      if (editor) editor.revealLine(where.line, where.column);
      else if (tries > 0) setTimeout(() => reveal(tries - 1), 50);
    };
    setTimeout(() => reveal(10), 0);
  }

  /** The trades the Strategy Tester is asked to show (a fill arrow clicked on the chart). */
  readonly testerReveal = signal<TradeReveal | null>(null);

  /**
   * A strategy's fill arrow clicked on the chart (PC-I5): its trades, selected on the Strategy
   * Tester's List of trades — opened if it was not.
   */
  onScriptTradeClick(e: { key: string; trades: readonly number[] }): void {
    if (this.strategyRun()?.item.key !== e.key || !e.trades.length) return;
    this.testerOpen.set(true);
    this.frontDock('tester');
    this.testerReveal.set({ numbers: e.trades, seq: (this.testerReveal()?.seq ?? 0) + 1 });
  }

  /**
   * The engine strategy on the chart, as "Deep backtest…" queues it: its own market and timeframe,
   * the chart's as overrides. Null for a script that is not an engine strategy.
   */
  readonly deepBacktestTarget = computed<DeepBacktestTarget | null>(() => {
    const item = this.strategyRun()?.item;
    if (!item || item.strategyId === undefined || item.strategyId === null) return null;
    const chartTimeframe = backtestTimeframeOf(this.resolution());
    return {
      strategyId: item.strategyId,
      strategySymbol: item.symbol || this.symbol(),
      strategyTimeframe: item.timeframe || chartTimeframe || 'H1',
      chartSymbol: this.symbol(),
      chartTimeframe,
    };
  });

  /** Frame a strategy trade on the chart (List of trades click), TradingView-style. */
  focusTrade(t: ChartTrade): void {
    const step = (resolutionMs(this.resolution()) ?? 3_600_000) / 1000;
    const w = tradeWindow(t, step, Math.floor(Date.now() / 1000));
    // Pan only: the operator's zoom is theirs (the toolbar has zoom buttons).
    this.host()?.panToRange(w.fromMs, w.toMs);
  }

  zoomChart(factor: number): void {
    this.host()?.zoomBy(factor);
  }

  /**
   * The Strategy Tester's Re-run: as its Settings apply them — the strategy's values from now on (the
   * live re-runs and the saved layout take them at once), and a run with them.
   */
  rerunStrategy(values: ScriptInputValues): void {
    const run = this.strategyRun();
    if (run) this.settings.apply(run.item.key, values);
  }

  /**
   * The Strategy Tester's inputs, with the defaults the strategy runs on: an engine strategy's
   * stored inputs in place of its source's, as its Settings dialog shows them. Null while those are
   * read. Compared by content: each live re-run brings an equal copy.
   */
  readonly testerInputs = computed(() => this.settings.inputsOf(this.strategyRun()), {
    equal: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  });

  removeScript(key: string): void {
    // Its run in flight must not bring it back, nor a re-run waiting to start — nor an edit of it
    // still on its way ("Update on chart").
    const edit = this.scriptUpdates().get(key);
    if (edit) {
      this.abortRun(edit, 'The script it updates was removed from the chart.');
      this.runScheduler.cancel(edit);
      this.dropPending(edit);
    }
    this.abortRun(key, 'The script was removed from the chart.');
    this.runScheduler.cancel(key);
    this.releaseWarm(key);
    this.forgetTruth(key);
    this.restoringScripts.update((l) => l.filter((w) => w.key !== key));
    this.dropPending(key);
    this.dropFailure(key);
    this.clearWaiting(key);
    // Its Pine Logs close with it (added back later, it does not reopen them).
    if (this.logsKey() === key) this.closeLogs();
    this.scriptRuns.update((runs) => runs.filter((r) => r.item.key !== key));
  }

  /**
   * Shown when a strategy the operator added took the place of the one on the chart (one strategy at
   * a time): what happened, and Undo — which puts the previous one back with its own inputs and takes
   * the new one off.
   */
  readonly replacedNotice = signal<{
    message: string;
    previous: { item: ChartScriptItem; values: ScriptInputValues };
    replacementKey: string;
  } | null>(null);

  private offerUndoReplace(previous: ChartScriptRun, replacement: ChartScriptRun): void {
    const name = (r: ChartScriptRun) => r.result.title || r.item.name;
    this.replacedNotice.set({
      message: `Replaced ${name(previous)} with ${name(replacement)}: one strategy at a time on the chart`,
      previous: { item: previous.item, values: previous.values },
      replacementKey: replacement.item.key,
    });
  }

  /** The notice's Undo: the strategy that was replaced comes back, the one that replaced it goes. */
  undoReplace(): void {
    const notice = this.replacedNotice();
    if (!notice) return;
    this.replacedNotice.set(null);
    this.removeScript(notice.replacementKey);
    // A run like a layout's restore: it lands in the tester already open, with no notice of its own.
    this.runScript(notice.previous.item, notice.previous.values, true);
  }

  /**
   * The chip's Remove: the operator takes the script off the chart. When the Pine Editor shows it
   * — in front, behind the tester or closed — the editor goes with it: closed and unlinked, its
   * draft and any text the assistant wrote into it dropped (unsaved edits too: the script was
   * removed), so the next open starts from the starter template. Removing any other script leaves
   * the editor exactly as it is. Its Settings close too.
   *
   * <p>Not part of {@link removeScript}: "Update on chart" and the assistant's run replace the
   * script the editor shows through it, and the editor follows them to the edited copy.</p>
   */
  removeScriptFromChart(key: string): void {
    if (this.settings.run()?.item.key === key) this.settings.close();
    this.removeScript(key);
    if (this.editorKey() !== key) return;
    this.editorOpen.set(false);
    this.editorKey.set(null);
    this.editorDraft.set(null);
    this.assistSource.set(null);
    this.editorCleared.set(true);
  }

  /** A script's input overrides on the chart, or on its way there (none when it is neither). */
  private scriptValues(key: string | null | undefined): ScriptInputValues {
    return (
      this.scriptRuns().find((r) => r.item.key === key)?.values ??
      (key ? this.pendingScripts().get(key)?.values : undefined) ??
      {}
    );
  }

  /**
   * The editor's "Add to chart" / "Update on chart". An edit of a script on the chart runs FIRST
   * and takes the edited script's place only once it lands (PC-06): when it does not compile or
   * fails at run time, the script on the chart stays as it was and the editor marks why — it used
   * to be removed first and lost. Its inputs carry over; those the edit removed or retyped are
   * dropped by the run. The run's key is the edit's own (PC-07: every editor script used to share
   * `editor:current`, so adding a second replaced the first), or the saved script's when the text is
   * exactly what is saved.
   */
  onEditorAdd(submit: ScriptEditorSubmit): void {
    const target = this.editorTarget();
    const values = this.scriptValues(target?.key);
    const key = editorRunKey(target, submit.source, this.chartScripts.savedScripts());
    const item = this.chartScripts.itemForSource(submit.source, submit.kind, submit.name, key);
    this.editorCleared.set(false); // it shows a chart script again
    this.runScript(item, values, false, undefined, undefined, { replaces: target?.key ?? null });
  }

  /**
   * The assistant's `pine.run`, as "Update on chart": the edited copy replaces the script the
   * editor shows once it lands, keeps its inputs, and the editor follows it.
   */
  private runDraftOnChart(source: string, done: (r: RunOutcome) => void): void {
    const target = this.editorTarget();
    const values = this.scriptValues(target?.key);
    const key = editorRunKey(target, source, this.chartScripts.savedScripts());
    const item = this.chartScripts.itemForSource(
      source,
      detectScriptKind(source),
      target?.name ?? 'Untitled script',
      key,
    );
    this.editorCleared.set(false);
    this.editorDraft.set({ key: this.editorKey(), text: source });
    this.runScript(item, values, false, done, undefined, { replaces: target?.key ?? null });
  }

  /** The open Settings dialog's display settings (its Style and Visibility tabs). */
  readonly settingsDisplay = computed(
    () => {
      const run = this.settings.run();
      return run ? resolveDisplay(run.display) : null;
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  /** The outputs its Style tab lists, as the run draws them before any style (their own colours). */
  readonly settingsOutputs = computed(
    () => {
      const run = this.settings.run();
      const model = run ? scriptRenderModel(run.result, this.precision()) : null;
      return model ? styleOutputsOf(model) : [];
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  readonly settingsHasTables = computed(() => {
    const model = this.settings.run()?.result.run?.outputs;
    return (model?.tables.length ?? 0) > 0;
  });

  /** A Pine script's Settings dialog (TradingView's study Settings): its inputs, applied live. */
  readonly settings = new ScriptSettings(this.scriptRuns, {
    run: (item, values) => this.runScript(item, values, true),
    storedInputs: (id) =>
      this.strategies.getById(id).pipe(
        map((res) => parseSavedInputs(res?.data?.scriptInputs)),
        takeUntilDestroyed(this.destroyRef),
      ),
    saveDefault: (id, values) =>
      this.chartScripts.saveDefaultInputs(id, values).pipe(takeUntilDestroyed(this.destroyRef)),
    notify: (kind, message) =>
      kind === 'success' ? this.notify.success(message) : this.notify.error(message),
    // Named input templates live with the chart preferences the engine syncs (PC-I12).
    prefs: this.prefs.storage,
  });
  /** The open Settings dialog (a picked time or price goes back to it). */
  private readonly settingsDialog = viewChild(ScriptSettingsDialogComponent);
  /** A time or price input can be picked on the chart: there is one. */
  readonly canPickOnChart = computed(() => !!this.host());
  /** The symbols a script's `input.symbol` suggests: the console's currency pairs (PC-11). */
  readonly scriptSymbols = computed(() =>
    this.symbols()
      .map((p) => p.symbol)
      .filter((s): s is string => !!s),
  );

  /**
   * A time or price input picked on the chart (PC-I12, PC-11): the dialog has stepped aside; the
   * chart takes the next click (Esc cancels) and the dialog the value — the bar's open for a time,
   * the price for a price.
   */
  async onScriptPick(req: InputPick): Promise<void> {
    const host = this.host();
    const point = host ? await host.pickPoint(req.kind) : null;
    this.settingsDialog()?.finishPick(
      point === null ? null : req.kind === 'price' ? point.price : point.time,
    );
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
    // Studies read from its plots go back to the close (DR-I5), rather than keeping a reference to nothing.
    this.active.update((list) =>
      list
        .filter((i) => i.uid !== uid)
        .map((i) =>
          parseStudySource(i.params['source'])?.uid === uid
            ? { ...i, params: { ...i.params, source: 'close' } }
            : i,
        ),
    );
    if (this.studySettingsFor() === uid) this.studySettingsFor.set(null);
  }

  /** A study as its Settings dialog left it (live preview; Cancel sends back the one it opened with). */
  replaceStudy(next: ActiveIndicator): void {
    this.active.update((list) => list.map((i) => (i.uid === next.uid ? next : i)));
  }

  /** The Settings dialog asks for a time on the chart (DR-22): the next click's bar. */
  async onStudyPick(req: StudyPick): Promise<void> {
    const host = this.host();
    const point = host ? await host.pickPoint(req.kind) : null;
    this.studyDialog()?.finishPick(point === null ? null : point.time);
  }

  /** A time input picked straight from the studies bar (DR-22: it was typed as UTC milliseconds). */
  async pickStudyTime(uid: string, key: string): Promise<void> {
    const host = this.host();
    const point = host ? await host.pickPoint('time') : null;
    if (point !== null) this.setParam(uid, key, String(point.time));
  }

  toggleIndicator(uid: string): void {
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, visible: !i.visible } : i)),
    );
  }

  setParam(uid: string, key: string, raw: string): void {
    const item = this.active().find((i) => i.uid === uid);
    const input = item ? studyMeta(item.defId)?.inputs.find((i) => i.key === key) : undefined;
    // By the input's type (DR-16: a Source went through Number and became NaN, so 38 built-ins were stuck on close);
    // a value the input does not take is ignored.
    const value = parseStudyInput(input, raw);
    if (value === null) return;
    this.active.update((list) =>
      list.map((i) => {
        if (i.uid !== uid) return i;
        const next: ActiveIndicator = { ...i, params: { ...i.params, [key]: value } };
        // On another study's plot it is on that one's bars: no timeframe of its own.
        if (key === 'source' && parseStudySource(value)) delete next.timeframe;
        return next;
      }),
    );
  }

  labelFor(item: ActiveIndicator): string {
    return studyLabel(item.defId, item.params);
  }

  onLegend(snapshot: LegendSnapshot): void {
    this.legend.set(snapshot);
  }

  /** The legend's change from the previous close: "−0.00002 / −0.2 pip (−0.00%)" (CC-18). */
  readonly legendChange = computed(() => {
    const l = this.legend();
    return l
      ? changeText(l.change ?? null, l.changePct, this.pipSize(), this.precision(), this.facts())
      : null;
  });
  /** The legend's bar time: its date label, else its open on the chart's display clock ({@link formatTime}). */
  readonly legendTime = computed(() => {
    const l = this.legend();
    return l ? (l.dateLabel ?? this.formatTime(l.time)) : '';
  });
  readonly legendVolume = computed(() => {
    const v = this.legend()?.volume;
    return v === null || v === undefined ? null : formatVolume(v);
  });
  /**
   * UD06: what the volume counts (C1 `volumeKind`): MT5 tick volume, the coin, contracts, shares. Studies read it
   * from here (ui-analysis labels them); null before a chart-bars answer / from an engine before C1.
   */
  readonly volumeKind = computed(() => this.feed.factsOf(this.symbol())?.volumeKind ?? null);
  /** The legend's tag after "Vol": `ticks`, `BTC`, `contracts`, `shares`; "unit?" when the engine said it is unknown. */
  readonly legendVolumeUnit = computed(() => {
    const facts = this.feed.factsOf(this.symbol());
    if (!facts) return null;
    return volumeUnitTag(facts.volumeKind, this.facts().instrument.baseCurrency) ?? 'unit?';
  });

  /** The data window's sections at the crosshair (CC-I6), from the chart's value providers. */
  readonly dataWindowSections = computed(() => this.host()?.dataWindow() ?? []);

  // ── Split view ───────────────────────────────────────────────────────────

  setSplitLayout(id: SplitLayoutId): void {
    this.split.setLayout(id);
  }

  private loadPanel(id: string): Promise<void> {
    return this.split.load(id);
  }

  /** US03: ask again for a panel that failed or had nothing. */
  retryPanel(id: string): void {
    void this.split.load(id);
  }

  /** US03: the symbols a panel's select offers — the broker's, then the catalogue's chartable instruments. */
  readonly panelSymbolChoices = computed(() => panelSymbolGroups(this.symbols(), this.instruments.all()));
  readonly panelSymbolKnown = computed(
    () => new Set(this.panelSymbolChoices().flatMap((g) => g.options.map((o) => o.symbol))),
  );

  readonly panelScales = PANEL_SCALES;

  /** US03: what a panel draws — its own style / scale / volume over the main chart's. */
  panelLook(panel: ComparePanel) {
    return panelLook(panel.view, { style: this.style(), scaleMode: this.scaleMode() });
  }

  setPanelView<K extends keyof PanelView>(id: string, key: K, value: PanelView[K] | '' | undefined): void {
    this.split.setView(id, key, value);
  }

  /** US03: a panel symbol's trading session (the day-based studies, the time axis), as the main chart has its own. */
  panelSession(symbol: string): SessionSpec | null {
    return this.feed.sessionOf(symbol);
  }

  /** US03 (UA02/UA07 on panels): what a panel's volume counts, for its studies. */
  panelVolumeKind(symbol: string): VolumeKind | null {
    return this.feed.factsOf(symbol)?.volumeKind ?? null;
  }

  panelExchangeSessions(symbol: string): ExchangeSessions | null {
    return this.split.exchangeSessionsOf(symbol);
  }
  private readonly panelCalendarsLoad = effect(() => this.split.loadCalendars());

  /** The split panels' chart hosts, in panel order. */
  private readonly panelHosts = viewChildren<ChartHostComponent>('panelHost');

  loadPanelOlder(id: string): Promise<void> {
    return this.split.loadOlder(id);
  }

  readonly panelLegends = this.split.legends;
  onPanelLegend(id: string, snapshot: LegendSnapshot): void {
    this.split.onLegend(id, snapshot);
  }

  setPanelSymbol(id: string, symbol: string, propagate = true): void {
    this.split.setSymbol(id, symbol, propagate);
  }

  setPanelResolution(id: string, resolution: string, propagate = true): void {
    this.split.setResolution(id, resolution, propagate);
  }

  /** Promote a comparison panel to the primary chart. */
  focusPanel(id: string): void {
    const panel = this.comparePanels().find((p) => p.id === id);
    if (!panel) return;
    const previous = { symbol: this.symbol(), resolution: this.resolution() };
    this.comparePanels.update((list) =>
      list.map((p) =>
        p.id === id ? { ...p, ...previous, bars: [], scripts: freshRuns(p.scripts) } : p,
      ),
    );
    this.symbol.set(panel.symbol);
    this.resolution.set(panel.resolution);
    void this.reload();
    void this.loadPanel(id);
  }

  panelPrecision(symbol: string): number {
    return this.panelFacts(symbol).precision;
  }

  private readonly panelFactsMemo = new Map<string, InstrumentFacts>();
  /** A split panel's instrument facts (UI01), the same object while nothing in them changed. */
  panelFacts(symbol: string): InstrumentFacts {
    const key = symbol.toUpperCase();
    const next = instrumentFacts(key, {
      pair: this.symbols().find((p) => (p.symbol ?? '').toUpperCase() === key) ?? null,
      lookup: this.instruments.lookupState(key),
    });
    const prev = this.panelFactsMemo.get(key);
    if (prev && sameFacts(prev, next)) return prev;
    this.panelFactsMemo.set(key, next);
    return next;
  }

  // ── Workspace actions ────────────────────────────────────────────────────

  /**
   * The split layout as a layout saves it (CC-12: it was not saved): the arrangement and each
   * panel's symbol and timeframe — not their bars, which move with every tick.
   */
  private readonly splitState = computed(() => ({ layout: this.splitLayout() }), {
    equal: (a, b) => a.layout === b.layout,
  });

  /** The other charts as the layout saves them (v2 `charts`): series, studies, link — not their bars. */
  private readonly panelStates = computed<ChartPanelState[]>(
    () =>
      this.comparePanels().map((p) => ({
        symbol: p.symbol,
        resolution: p.resolution,
        ...(p.indicators.length
          ? { indicators: p.indicators.map((i) => ({ ...i, params: { ...i.params } })) }
          : {}),
        ...(p.scripts.length
          ? { scripts: p.scripts.map((s) => workspaceScriptOf({ item: s.item, values: s.values })) }
          : {}),
        ...(p.link ? { link: p.link } : {}),
        ...(p.view ? { view: { ...p.view } } : {}),
      })),
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  /** The main chart's link group (CC-I5): 1 … 3, 0 not linked. */
  readonly mainLink = signal(0);
  /** What linked charts follow of each other (CC-I5). */
  readonly chartSync = signal<Required<ChartSync>>(restoredSync(undefined));

  // ── Linked charts and the other charts' studies / scripts (CC-I5) ──────────
  /** b10-ui: link groups + sync, and each other chart's studies / scripts ({@link ChartLinkedCharts}); the template reads `linked`. */
  readonly linked = new ChartLinkedCharts({
    comparePanels: this.comparePanels,
    mainLink: this.mainLink,
    chartSync: this.chartSync,
    symbol: () => this.symbol(),
    resolution: () => this.resolution(),
    host: () => this.host(),
    panelHosts: () => this.panelHosts(),
    selectSymbol: (symbol, propagate) => this.selectSymbol(symbol, propagate),
    selectResolution: (r, propagate) => this.selectResolution(r, propagate),
    setPanelSymbol: (id, symbol, propagate) => this.setPanelSymbol(id, symbol, propagate),
    setPanelResolution: (id, r, propagate) => this.setPanelResolution(id, r, propagate),
    scriptCatalog: () => this.scriptCatalog(),
    scriptRuns: () => this.scriptRuns(),
    chartScripts: this.chartScripts,
    destroyRef: this.destroyRef,
  });

  /** A layout's split view, restored: the arrangement, then each other chart's series and studies, loaded. */
  private restoreSplit(
    split: ChartWorkspaceState['split'],
    charts: ChartPanelState[] | undefined,
  ): void {
    const layout = this.splitLayouts.find((l) => l.id === split?.layout)?.id ?? '1';
    const wanted = this.splitLayouts.find((l) => l.id === layout)?.panels ?? 0;
    const saved: ComparePanel[] = (charts ?? []).slice(0, wanted).map((p, i) => ({
      id: `p${Date.now().toString(36)}${i}`,
      symbol: p.symbol.toUpperCase(),
      resolution: isSupportedResolution(p.resolution)
        ? (p.resolution as TvResolution)
        : this.resolution(),
      bars: [],
      indicators: (p.indicators ?? []).map((ind) => ({ ...ind, params: { ...ind.params } })),
      link: linkGroupOf(p.link),
      ...(p.view ? { view: restoredPanelView(p.view) } : {}),
      scripts: (p.scripts ?? []).map((w) => ({
        item: restoredScriptItem(w, this.chartScripts.savedScripts()),
        values: { ...w.values },
        result: null,
        error: null,
        ranTo: null,
      })),
    }));
    this.comparePanels.set(saved);
    // The arrangement; a layout saved with fewer panels than it shows gets the rest as new ones.
    this.setSplitLayout(layout);
    for (const panel of saved) void this.loadPanel(panel.id);
  }

  /** The whole chart set-up, as the engine saves it (`ChartLayout.state`). */
  captureState(): ChartWorkspaceState {
    return {
      v: WORKSPACE_VERSION,
      symbol: this.symbol(),
      resolution: this.resolution(),
      style: this.style(),
      showVolume: this.showVolume(),
      scaleMode: this.scaleMode(),
      invertScale: this.invertScale(),
      scaleSide: this.scaleSide(),
      sessionBreaks: this.sessionBreaks(),
      countdown: this.showCountdown(),
      ...(this.appearance() ? { appearance: { ...this.appearance()! } } : {}),
      ...(this.compareSeries().length
        ? { compare: this.compareSeries().map((c) => ({ ...c })) }
        : {}),
      ...(this.rememberPerSymbol() || Object.keys(this.symbolMemory()).length
        ? { symbolMemory: { on: this.rememberPerSymbol(), symbols: this.symbolMemory() } }
        : {}),
      timezone: this.timezone(),
      priceBased: {
        boxMethod: this.boxMethod(),
        boxSizeAtr: this.boxSizeAtr(),
        boxPips: this.boxPips(),
        renkoWicks: this.renkoWicks(),
        lineBreakLines: this.lineBreakLines(),
        pnfReversal: this.pnfReversal(),
      },
      indicators: this.active().map((i) => ({ ...i, params: { ...i.params } })),
      scripts: this.savedScriptsState(),
      view: this.viewSnapshot() ?? this.pendingView ?? null,
      overlays: this.overlaySettings.snapshot(),
      layerGroups: this.overlaySettings.persistedLayerGroups(),
      split: this.splitState(),
      ...(this.panelStates().length ? { charts: this.panelStates() } : {}),
      ...(this.mainLink() ? { link: this.mainLink() } : {}),
      sync: this.chartSync(),
      panel: {
        watchlistOpen: this.watchlistOpen(),
        width: this.dockWidth(),
        sidePane: this.sidePane(),
        calendarAll: this.calendarAll(),
        calendarMinImpact: this.calendarMinImpact(),
      },
      dock: dockStateOf(this.dockView()),
    };
  }

  /** The Pine Editor and Strategy Tester dock as it stands, for the layout. */
  private dockView(): DockView {
    return {
      editorOpen: this.editorOpen(),
      testerOpen: this.testerOpen(),
      preference: this.dockPreference(),
      editorKey: this.editorKey(),
      editorText: this.editorDraft()?.text ?? null,
      editorCleared: this.editorCleared(),
    };
  }

  /** A layout's dock, after its scripts were started again ({@link applyState}). */
  private applyDock(d: DockView): void {
    this.testerOpen.set(d.testerOpen);
    this.testerPrompt.set(false);
    this.frontDock(d.preference);
    this.editorOpen.set(false);
    // Removed with its script before the layout was saved: unlinked, the editor still opens blank.
    this.editorCleared.set(d.editorCleared);
    if (d.editorCleared) this.editorKey.set(null);
    if (d.editorOpen) {
      this.editorKey.set(d.editorKey);
      this.editorOpen.set(true);
      if (d.editorText) {
        this.editorDraft.set({ key: d.editorKey, text: d.editorText });
        this.editor.pushAssist(d.editorText);
      }
    }
  }

  /** Scripts on the chart plus restored ones still running, in a stable order. */
  private workspaceScripts(): WorkspaceScript[] {
    const runs = this.scriptRuns().map(workspaceScriptOf);
    const waiting = this.restoringScripts().filter((w) => !runs.some((r) => r.key === w.key));
    return [...waiting, ...runs].sort((a, b) => a.key.localeCompare(b.key));
  }

  // ── Chart settings dialog (CC-I11) ───────────────────────────────────────

  /** Candle colours, grid lines and background over the theme's; null: the theme's look. */
  readonly appearance = signal<ChartAppearance | null>(null);
  /** How far down the floating legend reaches (px in the chart area): the chart keeps its top-left tables below it. */
  readonly legendBottom = signal<number | null>(null);
  readonly chartSettingsOpen = signal(false);
  /** Layout memory per symbol (CC-I11): on, and what each symbol was left on. */
  readonly rememberPerSymbol = signal(false);
  readonly symbolMemory = signal<SymbolMemory>({});

  /** The chart's settings as the dialog edits them. */
  chartSettings(): ChartSettings {
    return {
      appearance: this.appearance(),
      rememberPerSymbol: this.rememberPerSymbol(),
      showVolume: this.showVolume(),
      countdown: this.showCountdown(),
      scaleMode: this.scaleMode(),
      invertScale: this.invertScale(),
      scaleSide: this.scaleSide(),
      timezone: this.timezone(),
      sessionBreaks: this.sessionBreaks(),
      showEvents: this.showEvents(),
      minEventImpact: this.minEventImpact(),
      showBlackout: this.showBlackout(),
      showPositions: this.showPositions(),
      showOrders: this.showOrders(),
      showOverlays: this.showOverlays(),
      showClosedTrades: this.showClosedTrades(),
      fitTradeLines: this.fitTradeLines(),
    };
  }

  /** The dialog's edit (or its Cancel putting the opening settings back), applied at once. */
  applySettingsFromDialog(s: ChartSettings): void {
    this.appearance.set(restoredAppearance(s.appearance));
    this.rememberPerSymbol.set(s.rememberPerSymbol);
    this.showVolume.set(s.showVolume);
    this.showCountdown.set(s.countdown);
    this.scaleMode.set(s.scaleMode);
    this.invertScale.set(s.invertScale);
    this.scaleSide.set(s.scaleSide);
    this.timezone.set(s.timezone);
    this.sessionBreaks.set(s.sessionBreaks);
    this.showEvents.set(s.showEvents);
    this.minEventImpact.set(s.minEventImpact);
    this.showBlackout.set(s.showBlackout);
    this.showPositions.set(s.showPositions);
    this.showOrders.set(s.showOrders);
    this.showOverlays.set(s.showOverlays);
    this.showClosedTrades.set(s.showClosedTrades);
    this.fitTradeLines.set(s.fitTradeLines);
  }

  // ── Compare overlays and synthetic series (CC-I12) ───────────────────────

  readonly compareSeries = this.compareState.series;
  readonly compareOpen = signal(false);
  readonly compareTitleOf = compareTitle;
  readonly symbolNames = computed(() =>
    this.symbols()
      .map((p) => p.symbol ?? '')
      .filter((s) => !!s),
  );
  /** The compare lines, from the chart's bars and the other symbols' (live, extended on scroll-back). */
  private readonly comparePaneList = computed(() => {
    const specs = this.compareSeries();
    if (!specs.length) return [];
    const own = this.symbol().toUpperCase();
    const bars = this.bars();
    const others = this.compareBars();
    const digits = new Map(
      this.symbols().map((p) => [p.symbol ?? '', Math.trunc(p.decimalPlaces) || 5]),
    );
    return comparePanes(
      specs,
      (sym) => (sym === own ? bars : others[sym]),
      // A pair's digits as before; any other symbol at its instrument's precision (US04), not 5.
      (sym) => digits.get(sym) ?? this.panelFacts(sym).precision,
      (sym) => this.joinCalendarOf(sym),
    );
  });
  /**
   * US04: the calendar a compare leg trades on, for the join — every FX pair the same (so FX legs join exactly as
   * before), else the instrument's calendar (C1, then the catalogue), else its own (unknown: joined as of).
   */
  private joinCalendarOf(symbol: string): string {
    const facts = this.panelFacts(symbol);
    if (facts.isFx) return 'fx';
    return this.feed.factsOf(symbol)?.calendarCode ?? facts.instrument.tradingCalendarCode ?? `own:${symbol}`;
  }

  /** What the chart draws in panes of their own or over the price: the fundamentals and the compare series. */
  readonly chartExternalPanes = computed(() => [
    ...this.externalPanes(),
    ...this.comparePaneList(),
  ]);

  /** US04: what the compare dialog offers — the broker's symbols, then the catalogue's chartable instruments. */
  readonly compareSymbolNames = computed(() =>
    this.panelSymbolChoices().flatMap((g) => g.options.map((o) => o.symbol)),
  );

  /** US04: a ratio / spread from the compare dialog, charted as the main symbol. */
  openCompareAsChart(spec: CompareSeriesSpec): void {
    const [a, b] = spec.symbols.map((x) => x.toUpperCase());
    if (!a || !b || (spec.kind !== 'ratio' && spec.kind !== 'spread')) return;
    this.compareOpen.set(false);
    this.openSynthetic({ kind: spec.kind, a, b, mult: spec.kind === 'spread' ? (spec.mult ?? 1) : 1 });
  }

  /** Add a compare series (the scale rule: {@link ChartCompareState.add}). */
  addCompare(spec: CompareSeriesSpec): void {
    this.compareState.add(spec);
  }

  removeCompare(id: string): void {
    this.compareState.remove(id);
  }

  // ── Command palette (CC-I11) ─────────────────────────────────────────────

  /** The chart's commands (the assistant's), which the palette offers too. */
  private chartCommandList: UiCommand[] = [];
  readonly paletteOpen = signal(false);
  /** Palette entries run lately, newest first (this page's session). */
  readonly paletteRecent = signal<string[]>([]);
  readonly paletteActions = computed(() =>
    this.paletteOpen()
      ? buildPaletteActions(this.chartCommandList, {
          symbols: this.symbols()
            .map((p) => p.symbol ?? '')
            .filter((s) => !!s),
          indicators: INDICATORS.map((d) => ({ id: d.id, name: d.name })),
          active: this.active().map((i) => ({ uid: i.uid, label: this.labelFor(i) })),
          tools: TOOLS.map((t) => ({ label: t.label })),
          timezones: this.timezones,
          styleLabel: (id) => CHART_STYLES.find((s) => s.id === id)?.label ?? id,
        })
      : [],
  );

  /** Run a palette entry through its chart command — asking first for one that destroys work — and say what happened. */
  async runPaletteAction(a: PaletteAction): Promise<void> {
    this.paletteOpen.set(false);
    const cmd = this.chartCommandList.find((c) => c.id === a.commandId);
    if (!cmd) return;
    if (
      a.confirm &&
      !(await this.dialogs.confirm({
        title: `${a.title}?`,
        message: cmd.description,
        confirmLabel: 'Go ahead',
        tone: 'danger',
      }))
    )
      return;
    this.paletteRecent.update((l) => [a.id, ...l.filter((id) => id !== a.id)].slice(0, 8));
    try {
      const r = await cmd.run(a.args);
      if (r.ok) this.notify.success(r.message);
      else this.notify.error(r.message);
    } catch (e) {
      this.notify.error(e instanceof Error && e.message ? e.message : `${a.title} failed.`);
    }
  }

  /** Zoom/scroll/pane heights waiting for the chart's first data. */
  private pendingView: ChartWorkspaceState['view'] = null;
  /** The series a pending view is for (a symbol's remembered zoom); null: whatever loads next. */
  private pendingViewFor: SeriesId | null = null;
  /** True while a saved state is being applied, so applying it does not save it back. */
  private applyingState = false;
  /** Set once the saved state (or the defaults) has been applied; nothing saves before. */
  private restored = false;
  /** Restored scripts whose run has not come back yet — still part of the layout. */
  private readonly restoringScripts = signal<WorkspaceScript[]>([]);

  // ── One undo history (CC-I11) ────────────────────────────────────────────

  /** b10-ui: the undo history, undo / redo and their titles ({@link ChartUndoController}); the template reads `chartUndo`. */
  readonly chartUndo = new ChartUndoController({
    captureState: () => this.captureState(),
    symbol: () => this.symbol(),
    drawings: this.drawings,
    restored: () => this.restored,
    applyingState: () => this.applyingState,
    labelFor: (i) => this.labelFor(i),
    applyChartSettings: (s) => this.applyChartSettings(s),
    active: this.active,
    workspaceScripts: () => this.workspaceScripts(),
    removeScriptFromChart: (key) => this.removeScriptFromChart(key),
    scriptRuns: this.scriptRuns,
    restoringScripts: this.restoringScripts,
    runScript: (item, values, replace) => this.runScript(item, values, replace),
    savedScripts: () => this.chartScripts.savedScripts(),
  });

  /**
   * Apply a saved workspace. Missing fields fall back to the chart's defaults, so a new layout
   * (`{ v: 1 }`) opens a clean chart. `keepSymbol` lets a deep link's symbol/timeframe win.
   */
  applyState(st: ChartWorkspaceState | null, keepSymbol = false): void {
    // v1 layouts (one chart and split panels) read as v2 (CC-I5): nothing is lost.
    const s = migrateWorkspaceState(st ?? { v: WORKSPACE_VERSION });
    this.applyingState = true;
    try {
      const symbolBefore = this.symbol();
      const resBefore = this.resolution();
      if (!keepSymbol) {
        this.symbol.set(s.symbol ?? 'EURUSD');
        if (s.resolution && isSupportedResolution(s.resolution)) this.resolution.set(s.resolution);
        else this.resolution.set('60');
      }
      this.applyChartSettings(s);
      this.rememberPerSymbol.set(s.symbolMemory?.on === true);
      this.symbolMemory.set(restoredSymbolMemory(s.symbolMemory?.symbols));
      this.active.set((s.indicators ?? []).map((i) => ({ ...i, params: { ...i.params } })));
      const p = s.panel ?? {};
      if (p.watchlistOpen !== undefined) this.watchlistOpen.set(p.watchlistOpen);
      if (p.width && p.width >= 240 && p.width <= 640) this.dockWidth.set(p.width);
      this.sidePane.set(p.sidePane ?? 'none');
      this.calendarAll.set(p.calendarAll ?? false);
      this.calendarMinImpact.set(p.calendarMinImpact ?? 'Low');
      this.pendingView = s.view ?? null;
      this.pendingViewFor = null;
      this.viewSnapshot.set(s.view ? normaliseView(s.view) : null);
      this.mainLink.set(linkGroupOf(s.link));
      this.chartSync.set(restoredSync(s.sync));
      this.restoreSplit(s.split, s.charts);

      // Pine scripts: the newest saved version of "My scripts", else the inline copy. Runs of the
      // layout being replaced that are still in flight must not land on this one, nor an Undo for
      // a strategy it replaced.
      this.abortAllRuns('The chart layout was replaced.');
      this.scriptRuns.set([]);
      this.replacedNotice.set(null);
      this.restoringScripts.set(s.scripts ?? []);
      for (const w of s.scripts ?? [])
        this.runScript(
          restoredScriptItem(w, this.chartScripts.savedScripts()),
          w.values ?? {},
          true,
        );
      this.applyDock(restoredDock(s.dock));
      if (!keepSymbol && (this.symbol() !== symbolBefore || this.resolution() !== resBefore))
        void this.reload();
      else queueMicrotask(() => this.flushPendingView());
    } finally {
      // Applying is over once the signals settled: the state as this chart reads it back is the
      // new baseline, not an edit — so a load or a switch never writes itself back.
      queueMicrotask(() => {
        this.workspace.rebase(this.captureState());
        this.applyingState = false;
        this.restored = true;
        // Another layout's chart: its steps are not this one's to undo (drawing steps stay, they are per symbol).
        this.chartUndo.rebase();
      });
    }
  }

  /**
   * A layout's chart settings — style, volume, scales, session breaks, countdown, zone, price-based boxes, overlays —
   * with the chart's defaults for whatever it leaves out (a layout, or an undo step: CC-I11).
   */
  private applyChartSettings(s: UndoableChart['settings']): void {
    this.style.set(s.style ?? 'candles');
    this.showVolume.set(s.showVolume ?? true);
    this.scaleMode.set(s.scaleMode ?? 'normal');
    this.invertScale.set(s.invertScale === true);
    this.scaleSide.set(s.scaleSide === 'left' ? 'left' : 'right');
    this.sessionBreaks.set(s.sessionBreaks === true);
    this.showCountdown.set(s.countdown ?? true);
    this.appearance.set(restoredAppearance(s.appearance));
    this.compareSeries.set(restoredCompare(s.compare));
    this.timezone.set(s.timezone ?? 'UTC');
    const pb = restoredPriceBased(s.priceBased);
    this.boxMethod.set(pb.boxMethod);
    this.boxSizeAtr.set(pb.boxSizeAtr);
    this.boxPips.set(pb.boxPips);
    this.renkoWicks.set(pb.renkoWicks);
    this.lineBreakLines.set(pb.lineBreakLines);
    this.pnfReversal.set(pb.pnfReversal);
    this.overlaySettings.restore(s.overlays, s.layerGroups);
  }

  private flushPendingView(): void {
    const v = this.pendingView;
    const host = this.host();
    if (!v || !host || !this.bars().length) return;
    // A remembered zoom waits for its symbol's bars, not the ones still on screen.
    if (this.pendingViewFor && !sameSeries(this.barsFor(), this.pendingViewFor)) return;
    this.pendingView = null;
    this.pendingViewFor = null;
    host.applyViewState(v);
    // Indicator panes are created a moment after the data; size them once they exist.
    setTimeout(() => host.applyViewState({ ...v, barSpacing: NaN, rightOffset: NaN }), 1_200);
  }

  /** Auto-save trigger for changes no signal sees (zoom, scroll, pane resize). */
  onViewChanged(): void {
    if (!this.restored || this.applyingState || this.pendingView) return;
    const v = this.host()?.viewState();
    if (v) this.viewSnapshot.set(normaliseView(v));
  }

  /**
   * The zoom / scroll / pane heights as last set by the operator. A signal updated only by
   * {@link onViewChanged}, so unrelated re-reads of the state (a live script re-run every 2 s)
   * never pick up a drifting value and save again — that kept the header on "Saving…".
   */
  private readonly viewSnapshot = signal<ChartViewState | null>(null, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  /**
   * The scripts as a layout saves them, changing only when the list or inputs change — not on every
   * live re-run of a script's result.
   */
  private readonly savedScriptsState = computed(() => this.workspaceScripts(), {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  // ── Layout menu (server-backed), templates, exports, fullscreen ─────────────
  /** b9-maint: {@link ChartLayoutActions}; the template and the assistant's commands call it as `layoutActions`. */
  readonly layoutActions = new ChartLayoutActions({
    layoutMenuOpen: this.layoutMenuOpen,
    active: this.active,
    isFullscreen: this.isFullscreen,
    // The snapshot's title: symbol, timeframe and style, as the chart's title reads.
    title: () => `${this.symbol()} · ${this.resolutionLabel(this.resolution())} · ${this.styleLabel()}`,
    fileStem: () => `${this.symbol()}-${this.resolutionLabel(this.resolution())}`,
    closeContextMenu: () => this.contextMenu.set(null),
    host: () => this.host(),
    workspace: this.workspace,
    layoutStore: this.layoutStore,
    dialogs: this.dialogs,
    notify: this.notify,
  });

  openContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const host = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const y = ev.clientY - host.top;
    // The price under the cursor is captured HERE, while the pointer position
    // is still meaningful. Reading it when the menu item is clicked would
    // measure wherever the pointer had drifted to by then.
    const x = ev.clientX - host.left;
    this.contextMenu.set({
      x,
      y,
      price: this.host()?.priceAtY(y) ?? null,
      level: this.host()?.derivedLevelAt(x, y) ?? null,
    });
  }

  /**
   * "Add alert at POC 1.16234" (PR-7): the right-clicked profile or structure level's exact price into the
   * same alert form as "Add alert at …" — nothing is armed until the operator saves it.
   */
  /** The bell links and the alert lines (their effects keep this place in the page's effect order). */
  private readonly alertEffects = this.alerts.connect();
  private readonly alertMoveDialog = viewChild<ElementRef<HTMLDialogElement>>('alertMoveDialog');

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
    this.drawingTools.selectTool(kind);
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

  /**
   * Keyboard shortcuts, matching TradingView's where they exist.
   *
   * Bound on the host rather than on `document` so typing in the symbol search
   * or an indicator input never deletes the selected drawing.
   */
  onKeydown(ev: KeyboardEvent): void {
    // Ctrl/Cmd+Shift+M: maximise ⇄ restore the Pine Editor / Tester dock — before the editable check, so it also
    // works while typing in the editor (CodeMirror binds nothing to it).
    if (
      this.dockTab() &&
      (ev.ctrlKey || ev.metaKey) &&
      ev.shiftKey &&
      !ev.altKey &&
      ev.key.toLowerCase() === 'm'
    ) {
      ev.preventDefault();
      this.setDockMode('max');
      return;
    }
    const target = ev.target as HTMLElement | null;
    // The Pine editor is a contenteditable, not a field: typing "m" there toggled the magnet, and
    // Backspace deleted the selected drawing.
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable))
      return;

    // The Technicals view covers the chart: Esc returns to it, and no chart shortcut acts
    // on drawings the operator cannot see.
    if (this.technicalsOpen() || this.seasonalsOpen()) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.technicalsOpen.set(false);
        this.seasonalsOpen.set(false);
      }
      return;
    }

    const mod = ev.metaKey || ev.ctrlKey;
    // The chart's command palette (CC-I11): ⌘⇧K / Ctrl+Shift+K (⌘K alone is the console's page search).
    if (mod && ev.shiftKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      // The console's palette listens on the document for ⌘K with or without Shift: not this one.
      ev.stopPropagation();
      this.paletteOpen.set(true);
      return;
    }
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) this.chartUndo.redo();
      else this.chartUndo.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.chartUndo.redo();
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
      // An Esc this branch acts on is consumed (preventDefault): the open order ticket
      // (appModalA11y, a document listener that skips handled keys) closes on the NEXT one.
      // An open toolbar menu (interval, style, templates, overlays, layouts) is what Esc closes
      // first; it used to stay open while Esc went to the drawings behind it.
      if (this.openMenu() !== null || this.layoutMenuOpen() || this.symbolMenuOpen()) {
        ev.preventDefault();
        this.openMenu.set(null);
        this.layoutMenuOpen.set(false);
        this.symbolMenuOpen.set(false);
        return;
      }
      // TV: Esc first abandons a drawing in progress and drops the tool, then
      // clears the selection.
      const acted =
        this.tool() !== null ||
        this.railFlyout() !== null ||
        this.magnetMenuOpen() ||
        this.drawingMenu() !== null ||
        this.drawings.selectedId() !== null;
      if (this.host()?.cancelDrawing() || acted) ev.preventDefault();
      this.railFlyout.set(null);
      this.magnetMenuOpen.set(false);
      this.drawingMenu.set(null);
      this.tool.set(null);
      this.drawings.selectedId.set(null);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (this.drawings.selectedIds().size) {
        ev.preventDefault();
        // Locked drawings stay: the lock is what stops a stray key deleting one (DR-06). Every other
        // selected drawing goes (a multi-selection, DR-I10).
        this.drawings.removeSelectedUnlocked();
      }
      return;
    }
    // TradingView's drawing hotkeys (DR-I12), by physical key so Alt's characters on a Mac
    // (Alt+T types "†") do not get in the way.
    if (ev.altKey && !mod) {
      // TradingView's chart keys (CC-I11): reset the view, invert / log / percent scale, snapshot.
      const action = CHART_HOTKEYS[ev.code];
      if (action) {
        ev.preventDefault();
        if (action === 'reset') this.resetScales();
        else if (action === 'invert') this.invertScale.set(!this.invertScale());
        else if (action === 'log')
          this.scaleMode.set(this.scaleMode() === 'log' ? 'normal' : 'log');
        else if (action === 'percent')
          this.scaleMode.set(this.scaleMode() === 'percent' ? 'normal' : 'percent');
        else this.layoutActions.takeSnapshot();
        return;
      }
      const kind = DRAWING_HOTKEYS[ev.code];
      if (kind) {
        ev.preventDefault();
        this.tool.set(kind);
        return;
      }
    }
    // Bar Replay, TradingView's keys: Shift+→ forward, Shift+← back, Shift+↓ play / pause (CC-I4).
    if (this.replayActive() && ev.shiftKey && !mod && !ev.altKey) {
      const replayKey =
        ev.key === 'ArrowRight'
          ? () => void this.replay.step(1)
          : ev.key === 'ArrowLeft'
            ? () => void this.replay.step(-1)
            : ev.key === 'ArrowDown'
              ? () => this.replay.togglePlay()
              : null;
      if (replayKey) {
        ev.preventDefault();
        replayKey();
        return;
      }
    }
    if (ev.key.startsWith('Arrow') && this.drawings.selectedId() && !mod) {
      // Nudge: one bar sideways / one pixel vertically; Shift ×10.
      const k = ev.shiftKey ? 10 : 1;
      const bars = ev.key === 'ArrowLeft' ? -k : ev.key === 'ArrowRight' ? k : 0;
      const px = ev.key === 'ArrowUp' ? -k : ev.key === 'ArrowDown' ? k : 0;
      if (this.host()?.nudgeSelectedDrawing(bars, px)) ev.preventDefault();
      return;
    }
    // TradingView: "/" opens the indicators.
    if (ev.key === '/' && !mod && !ev.altKey) {
      ev.preventDefault();
      this.openStudiesDialog();
      return;
    }
    if (ev.key.toLowerCase() === 'm' && !mod) {
      this.magnet.set(!this.magnet());
      return;
    }
    if (/^[0-9]$/.test(ev.key) && !mod && !ev.altKey) {
      ev.preventDefault();
      this.openIntervalBox(ev.key);
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

  /**
   * How the page prints one of the chart's bars (the Details pane, the replay head): its trading
   * date on 1D/1W/1M — a calendar date, so no clock time and no time zone — else its open on the
   * chart's display clock. These bars are the page's own, in UTC: handed to `formatTime` as they
   * were, their UTC clock was printed under the display zone's name.
   */
  barTimeLabel(bar: Bar): string {
    const date = tradingDateLabel(bar, this.resolution());
    if (date !== null) return date;
    const zone = this.timezone();
    const shift = zone === 'UTC' ? 0 : timezoneOffsetMinutes(zone, bar.time) * 60_000;
    return this.formatTime(bar.time + shift);
  }
}

/** Small per-browser drawing preferences (magnet strength, stay-in-drawing). */
function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = appStorage.getItem(`lascodia.chart.pref.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

let prefsRef: ChartPrefsService | null = null;
function writePref(key: string, value: unknown): void {
  // Synced across machines (engine `chart/preferences`); the cache is localStorage.
  if (prefsRef) prefsRef.setItem(`lascodia.chart.pref.${key}`, JSON.stringify(value));
  else
    try {
      appStorage.setItem(`lascodia.chart.pref.${key}`, JSON.stringify(value));
    } catch {
      /* preference not remembered */
    }
}
