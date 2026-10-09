import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { CurrencyPairDto, OrderDto } from '@core/api/api.types';
import { CandleFeedService, type Bar } from '../../datafeed/candle-feed.service';
import {
  LiveRerunScheduler,
  barCloseMs,
  formingLiveBar,
  sameSeries,
  type SeriesId,
} from '../../scripts/live-bar';
import { ThemeService } from '@core/theme/theme.service';

/**
 * Quiet script re-runs (live ticks, the minute timer, a theme switch): at least this many ms between
 * two runs of a script — longer for a slow one, whose runs are spaced by 4× their round trip
 * (LiveRerunScheduler).
 */
const LIVE_RERUN_MS = 2_000;
/** What a script run hands whoever waits on it: its result, or why there is none. */
type RunOutcome = ChartScriptResult | { error: string };
/** Told to whoever waits on a run that a newer run of the same script replaced. */
const SUPERSEDED = 'A newer run of this script replaced this one.';
import {
  SUPPORTED_RESOLUTIONS,
  formatResolution,
  isSessionResolution,
  isSupportedResolution,
  parseInterval,
  resolutionMs,
  type TvResolution,
} from '../../datafeed/resolution';
import {
  applyStoredTick,
  foldBars,
  lastCompleteBarTime,
  mergeForming,
} from '../../datafeed/aggregate';
import {
  SessionRollover,
  applySessionTick,
  currentDayBars,
  isCurrentPeriod,
  mergeSessionTail,
} from '../../datafeed/session-bars';
import { TradingCalendar, nextSessionPeriod } from '../../datafeed/session-calendar';
import { liveTick } from '../../datafeed/live-tick';
import { ServerClock } from '@core/time/server-clock';
import { tradingDateLabel } from '../../chart/trading-date';
import { pipSizeFor, priceScaleFor, rankSymbols } from '../../datafeed/symbol-info';
import { changeText, formatVolume } from '../../chart/legend-format';
import { DataWindowComponent } from '../../chart/data-window.component';
import { toCsv } from '../../chart/snapshot';
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
import { SeasonalsViewComponent } from '../../panels/seasonals-view.component';
import { NewsAnalysisModalComponent } from '../../panels/news-analysis-modal.component';
import { LongPressDirective } from '../../panels/long-press.directive';
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
import type { ChartViewState, ExternalPane } from '../../chart/chart-host.component';
import {
  catchError,
  forkJoin,
  from,
  map,
  of,
  switchMap as switchMapTo,
  type Observable,
  type Subscription,
} from 'rxjs';
import {
  ChartScriptService,
  editorRunKey,
  savedScriptId,
  startingValues,
  type ChartScriptCatalog,
  type ChartScriptItem,
} from '../../scripts/chart-script.service';
import {
  MAX_BUSY_RETRIES,
  busyWaitMs,
  failureOfError,
  failureOfResult,
  isBusy,
  type ScriptFailure,
} from '../../scripts/script-run-state';
import { ScriptChipComponent, type ScriptChip } from '../../scripts/script-chip.component';
import {
  displayOverrides,
  resolveDisplay,
  styleOutputsOf,
  type ScriptDisplaySettings,
} from '../../scripts/script-display';
import { scriptRenderModel } from '../../scripts/script-model-cache';
import { WarmSessionBook, applyFrame, formingIndexOf } from '../../scripts/warm-sessions';
import { detectRepaint, markUnconfirmed, repaintText } from '../../scripts/realtime-truth';
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
  editorReport,
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
import { parseSavedInputs, pruneInputValues } from '@features/scripting/pine/pine-inputs';
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
import { placeRun } from '../../scripts/run-on-host';
import {
  REPLAY_AHEAD,
  chartScriptLayers,
  hiddenOnTimeframe,
  replayLag,
  sameLayers,
  type ChartScriptLayer,
} from '../../scripts/script-layers';
import { inputsSummary, type ScriptAction } from '../../scripts/script-status';
import { ScriptStatusLineComponent } from '../../scripts/script-status-line.component';
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
  type ScaleMode,
} from '../../chart/chart-host.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { PositionsService } from '@core/services/positions.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ChartEventsService } from '../../overlays/chart-events.service';
import {
  blackoutBands,
  eventsWindow,
  mergeMarks,
  missingOnTheLeft,
  type BlackoutWindow,
} from '../../overlays/chart-events';
import { ChartAlertsService } from '../../alerts/chart-alerts.service';
import { ChartAlertFormComponent } from '../../alerts/chart-alert-form.component';
import { ChartAlertManagerComponent } from '../../alerts/chart-alert-manager.component';
import { ObjectTreeComponent } from '../../drawings/ui/object-tree.component';
import {
  StudySettingsDialogComponent,
  type StudyPick,
} from '../../indicators/study-settings-dialog.component';
import { drawingAlertDraft } from '../../drawings/drawing-alert';
import { DrawingFavorites } from '../../drawings/drawing-favorites.service';
import { FavoritesBarComponent } from '../../drawings/ui/favorites-bar.component';
import { PatternScorecardDialogComponent } from '../../patterns/scorecard-dialog.component';
import type { CandleTrendFilter } from '../../patterns/candlestick-patterns';
import type { AutoAnalysisSettings } from '../../overlays/auto-analysis';
import { positionAccountFacts, positionOrderPrefill } from '../../drawings/position-link';
import type { ChartAlertDto } from '../../alerts/chart-alerts.types';
import {
  parseStudyInput,
  parseStudySource,
  sourceGroups,
  type SourceGroup,
} from '../../indicators/study-settings';
import { AlertLinesPrimitive, type AlertLineMove } from '../../alerts/alert-lines-primitive';
import { alertLinesFor, movedBounds } from '../../alerts/alert-lines-geometry';
import { inputOf } from '../../alerts/chart-alert-rules';
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
import {
  closedTradeMarkers,
  concernsSymbol,
  orderLines,
  positionLines,
  type ChartPosition,
  type LiveQuote,
} from '../../overlays/trade-layer';
import type { ChartMarker } from '../../chart/chart-host.component';
import {
  CHART_TIMEZONES,
  midnightOnClock,
  timezoneOffsetMinutes,
  ChartLayoutStore,
  type StudyTemplate,
} from '../../workspace/layout-store.service';
import { ChartWorkspaceSync } from '../../workspace/workspace-sync.service';
import { EconomicCalendarPaneComponent } from '../../panels/economic-calendar-pane.component';
import { EconomicEventModalComponent } from '../../panels/economic-event-modal.component';
import { ZonedDatePipe } from '../../panels/zoned-time';
import {
  ArticleFlagsPipe,
  concernsPane,
  headlineAge,
  mergeArticles,
  type NewsArticleIngestedPayload,
} from '../../panels/news-pane';
import { ChartPanelsDockComponent } from '../../panels/side/chart-panels-dock.component';
import { ReplayController } from '../../replay/replay-controller';
import type { UiCommand } from '@core/assistant/ui-command.types';
import { buildPaletteActions, type PaletteAction } from '../../palette/chart-palette';
import { ChartPaletteComponent } from '../../palette/chart-palette.component';
import { MeasuredBottomDirective } from '../../chart/measured-bottom.directive';
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
import { askName, confirmDelete } from '../../dialog/chart-dialogs';
import {
  UndoHistory,
  describeChange,
  sameUndoable,
  undoableOf,
  type UndoEntry,
  type UndoableChart,
} from '../../workspace/undo-history';
import { ReplayScriptSessions } from '../../replay/replay-script-sessions';
import { ScriptingRunService } from '@shared/pine-chart/api/scripting-run.service';
import type { PineRunRequest } from '@shared/pine-chart/model/pine-outputs.types';
import { ReplayPanelComponent } from '../../replay/replay-panel.component';
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import type { SidePanel } from '../../panels/side/chart-panels.types';
import type {
  EconomicImpact,
  UpcomingEconomicEvent,
} from '@core/services/economic-calendar.service';
import { ChartPrefsService } from '../../workspace/chart-prefs.service';
import { ChartTradingComponent } from '../../trading/chart-trading.component';
import { timelineMarkers, timelineSummary, timelineWindow } from '../../trading/trade-timeline';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { TicketPrefill } from '../../trading/ticket-model';
import {
  dockStateOf,
  restoredDock,
  restoredPriceBased,
  restoredScriptItem,
  workspaceScriptOf,
  type ChartWorkspaceState,
  type DockView,
  type WorkspaceScript,
} from '../../workspace/workspace-state';
import { drawingTemplates } from '../../drawings/drawing-templates';
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

/** "Update on chart" (PC-06): the run of the editor's text and the chart script it was edited from. */
interface ScriptUpdate {
  /** The script on the chart it replaces once it lands; null for a new script. */
  replaces: string | null;
}

/** One comparison chart in a split layout. */
export interface ComparePanel {
  id: string;
  symbol: string;
  resolution: TvResolution;
  bars: Bar[];
  /** Its oldest bar is the start of the engine's history: scroll-back stops asking (CC-14). */
  historyComplete?: boolean;
}

const RESOLUTION_GROUPS: Array<{
  label: string;
  items: Array<{ id: TvResolution; name: string }>;
}> = [
  {
    label: 'Minutes',
    items: [
      { id: '1', name: '1 minute' },
      { id: '2', name: '2 minutes' },
      { id: '3', name: '3 minutes' },
      { id: '5', name: '5 minutes' },
      { id: '10', name: '10 minutes' },
      { id: '15', name: '15 minutes' },
      { id: '30', name: '30 minutes' },
      { id: '45', name: '45 minutes' },
    ],
  },
  {
    label: 'Hours',
    items: [
      { id: '60', name: '1 hour' },
      { id: '120', name: '2 hours' },
      { id: '180', name: '3 hours' },
      { id: '240', name: '4 hours' },
      { id: '360', name: '6 hours' },
      { id: '480', name: '8 hours' },
      { id: '720', name: '12 hours' },
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
/** Pages of history go-to-date loads at most to reach a date (1,500 bars each). */
const GO_TO_DATE_PAGES = 12;

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

type ToolbarMenu =
  | 'interval'
  | 'style'
  | 'templates'
  | 'overlays'
  | 'alert'
  | 'split'
  | 'more'
  | BottomBarMenu;

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
/** A chart script run covers the loaded history up to the engine's preview cap. */
const MAX_SCRIPT_BARS = 20_000;

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

/** TradingView's drawing hotkeys (Alt + key), by `KeyboardEvent.code` (DR-I12). */
const DRAWING_HOTKEYS: Readonly<Record<string, DrawingKind>> = {
  KeyT: 'trend-line',
  KeyH: 'horizontal-line',
  KeyJ: 'horizontal-ray',
  KeyV: 'vertical-line',
  KeyC: 'cross-line',
  KeyF: 'fib-retracement',
};

/** TradingView's chart hotkeys (Alt + key), by `KeyboardEvent.code` (CC-I11). */
const CHART_HOTKEYS: Readonly<Record<string, 'reset' | 'invert' | 'log' | 'percent' | 'snapshot'>> = {
  KeyR: 'reset',
  KeyI: 'invert',
  KeyL: 'log',
  KeyP: 'percent',
  KeyS: 'snapshot',
};

@Component({
  selector: 'app-chart-analysis-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DecimalPipe,
    ChartHostComponent,
    ChartTradingComponent,
    DataWindowComponent,
    IndicatorsDialogComponent,
    ChartIconComponent,
    DrawingToolbarComponent,
    DrawingSettingsDialogComponent,
    WatchlistPanelComponent,
    StrategyTesterPanelComponent,
    ScriptLogsPanelComponent,
    ScriptEditorPanelComponent,
    ScriptSettingsDialogComponent,
    ChartBottomBarComponent,
    PerformanceTilesComponent,
    SeasonalsComponent,
    TechnicalsGaugeComponent,
    TechnicalsViewComponent,
    SeasonalsViewComponent,
    NewsAnalysisModalComponent,
    EconomicCalendarPaneComponent,
    EconomicEventModalComponent,
    ZonedDatePipe,
    ArticleFlagsPipe,
    ChartPanelsDockComponent,
    LongPressDirective,
    UndoNoticeComponent,
    ScriptChipComponent,
    ScriptStatusLineComponent,
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
    MeasuredBottomDirective,
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
  private readonly feed = inject(CandleFeedService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pageContext = inject(PageContextService);
  private readonly uiCommands = inject(UiCommandService);
  private readonly chartScripts = inject(ChartScriptService);
  private readonly theme = inject(ThemeService);
  private readonly fundamentals = inject(FxFundamentalsService);
  private readonly dailyBars = inject(DailyBarsService);
  /**
   * The engine's clock, for "is the newest bar's period still open" on the session grid: its
   * periods' opens and closes are the engine's instants, and a browser clock a few seconds off would
   * roll a bar early or late (the countdown reads the same clock).
   */
  private readonly serverClock = inject(ServerClock);
  /** PC-I1: warm sessions' frames (`/api/hubs/scripting`), and their resync and end calls. */
  private readonly scriptHub = inject(ScriptingRealtimeService);
  private readonly scriptingApi = inject(ScriptingService);

  /** Fetched FX-fundamental series, keyed by the study's uid. */
  readonly externalPanes = signal<ExternalPane[]>([]);

  private readonly host = viewChild<ChartHostComponent>('host');

  readonly resolutions = SUPPORTED_RESOLUTIONS;
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
        this.showPositions(),
        this.showOrders(),
        this.showOverlays(),
        this.showEvents(),
        this.showVolumeProfile(),
        this.showSupportResistance(),
        this.showStructure(),
        this.deltaOn(),
      ].filter(Boolean).length,
  );

  /** A level picked on the chart for the alert form (right-click "Add alert at …"); null = 10 points off the live price. */
  readonly alertPreset = signal<number | null>(null);
  /** A drawing's alert the form starts from (DR-I6: "Add alert" on the drawing toolbar); null = a price alert. */
  readonly alertDraft = signal<ChartAlertDto | null>(null);
  openAlertDraft(ev: Event): void {
    this.alertPreset.set(null);
    this.alertDraft.set(null);
    this.toggleMenu('alert', ev);
  }

  /**
   * "Add alert" on a selected line / channel / Fib level (DR-I6): the alert form opens pre-filled with the drawing's
   * anchors (the engine follows the shape bar by bar on this timeframe); nothing is armed until the operator saves.
   */
  addDrawingAlert(e: { id: string; level?: number }): void {
    const d = this.drawings.allDrawings().find((x) => x.id === e.id);
    const draft = d
      ? drawingAlertDraft(d, {
          timeframe: this.resolution(),
          level: e.level,
          logScale: this.scaleMode() === 'log',
        })
      : null;
    if (!draft) {
      this.notify.error(
        'An alert can watch a line, a channel or a Fib level drawn on the price, with two different times.',
      );
      return;
    }
    this.alertPreset.set(null);
    this.alertDraft.set(draft);
    this.openMenu.set('alert');
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
              p.spanMs === 'ytd'
                ? midnightOnClock(new Date(now).getUTCFullYear(), 0, 1, this.timezone())
                : now - p.spanMs,
            toMs: now,
          };
    if (this.resolution() !== p.resolution) this.selectResolution(p.resolution);
    else this.flushPendingRange();
  }

  /**
   * Centre the chart on a day (`yyyy-mm-dd`) — midnight on the CHART's clock, not UTC's (CC-15) —
   * loading history back to it first: a date before the loaded bars did nothing. At most
   * {@link GO_TO_DATE_PAGES} pages of history; past that the oldest loaded bars show, and the
   * operator is told.
   */
  async goToDate(value: string): Promise<void> {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return;
    const t = midnightOnClock(Number(m[1]), Number(m[2]) - 1, Number(m[3]), this.timezone());
    // Centre the day: a window the width of what is on screen, around the date.
    const span = Math.max((resolutionMs(this.resolution()) ?? DAY) * 120, DAY);
    const from = t - span / 2;
    for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
      const held = this.bars();
      if (!held.length || held[0].time <= from || this.historyComplete()) break;
      await this.loadOlder();
      if (this.bars()[0]?.time === held[0].time) break; // nothing older came back
    }
    const oldest = this.bars()[0]?.time;
    if (oldest !== undefined && oldest > t && !this.historyComplete())
      this.notify.warning(
        `History before ${this.barTimeLabel(this.bars()[0])} is not loaded: showing the oldest bars.`,
      );
    this.pendingRange = { fromMs: from, toMs: t + span / 2 };
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
      this.closeTester();
    } else {
      this.testerOpen.set(true);
      // With no strategy on the chart it opens on how to add one, as TradingView's does.
      this.testerPrompt.set(!this.strategyRun());
      this.frontDock('tester');
    }
  }

  closeTester(): void {
    this.testerOpen.set(false);
    this.testerPrompt.set(false);
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
  readonly catalogue = INDICATORS;

  readonly symbols = signal<CurrencyPairDto[]>([]);
  readonly symbol = signal<string>('EURUSD');
  readonly resolution = signal<TvResolution>('60');
  readonly style = signal<ChartStyle>('candles');
  readonly showVolume = signal(true);
  readonly bars = signal<Bar[]>([]);
  /**
   * The symbol and resolution `bars` hold. A switch changes the chart's at once, but the previous
   * series stays on screen until the new one loads — so whatever takes the bars to be this
   * symbol's (a run's forming bar, a run's drawings, a tick) checks this first.
   */
  private readonly barsFor = signal<SeriesId | null>(null, {
    equal: (a, b) => a === b || sameSeries(a, b),
  });
  /**
   * The series on screen, for the chart: it rebuilds every series when this changes, rather than
   * diffing one instrument's bars against another's (CC-I1).
   */
  readonly dataKey = computed(() => {
    const b = this.barsFor();
    return b ? `${b.symbol}|${b.resolution}` : '';
  });
  /**
   * The series whose oldest loaded bar is the start of the engine's history (a scroll-back page came
   * back empty): the chart stops asking for more (CC-14). Cleared by every load of a series.
   */
  private readonly historyStart = signal<string | null>(null);
  readonly historyComplete = computed(
    () => !!this.dataKey() && this.historyStart() === this.dataKey(),
  );
  /**
   * The symbol's session as the engine reports it with its chart bars: the trading days the chart's
   * day-based studies and the Details pane count in, and the calendar a live price opens the next
   * session-grid period by. Null until it is known — and for a symbol without one: UTC days.
   */
  readonly sessionSpec = computed(() => this.feed.sessionOf(this.symbol()));
  private readonly tradingCalendar = computed(() => {
    const spec = this.sessionSpec();
    return spec ? new TradingCalendar(spec) : null;
  });
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
    () => this.host()?.scriptStatus().filter((r) => r.pane === 'main') ?? [],
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
  /** Scripts with an explicit run in flight, by key, with its ticket ({@link runScript}). */
  private readonly runningKeys = signal<ReadonlyMap<string, number>>(new Map());
  readonly scriptRunning = computed(() => this.runningKeys().size > 0);
  /**
   * The chart's non-script notices (an FX-fundamentals pane that could not load, a study with no
   * data). A Pine script's failure is its own, on its chip ({@link scriptFailures}).
   */
  readonly scriptError = signal<string | null>(null);
  /** Each script's last failed run, by key (PC-05, PC-13): never one line for all of them. */
  readonly scriptFailures = signal<ReadonlyMap<string, ScriptFailure>>(new Map());
  /**
   * Scripts asked onto the chart whose first run has not landed — on its way, or failed (a dialog
   * pick, a restored layout): their chips show it, with the way to open or remove them.
   */
  private readonly pendingScripts = signal<
    ReadonlyMap<
      string,
      { item: ChartScriptItem; values: ScriptInputValues; symbol: string; resolution: TvResolution }
    >
  >(new Map());
  /** Explicit runs the engine refused as busy (C5), by key: sent again at this time (client ms). */
  private readonly waitingScripts = signal<ReadonlyMap<string, number>>(new Map());
  /** "Update on chart" in flight, by the chart script it replaces: its chip shows it updating. */
  private readonly scriptUpdates = signal<ReadonlyMap<string, string>>(new Map());

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
  readonly testerOpen = signal(true);
  /**
   * The operator opened the Strategy Tester with no strategy on the chart: it shows how to add
   * one. The tab used to be disabled then, explained only by a tooltip — which touch never shows.
   */
  readonly testerPrompt = signal(false);
  readonly testerShown = computed(
    () => this.testerOpen() && (!!this.strategyRun() || this.testerPrompt()),
  );
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
    // A script whose first run failed is not on the chart yet, but its source can be fixed here.
    const pending = run || key === null ? null : (this.pendingScripts().get(key) ?? null);
    const item = run?.item ?? pending?.item;
    if (!item) return null;
    const id = item.strategyId ?? null;
    const source = item.pineSource ?? (id !== null ? (this.strategySources()[id] ?? null) : null);
    return {
      key: item.key,
      name: run?.result.title || item.name,
      source,
      strategyId: id,
      loading: id !== null && source === null,
    };
  });

  /**
   * The operator removed the script the editor showed ({@link removeScriptFromChart}): until it
   * is pointed at a script again, the editor opens on the starter template. Saved with the layout's
   * dock, so a reload does not bring a chart script back into it.
   */
  private readonly editorCleared = signal(false);

  /** Point the editor at a chart script, loading an engine strategy's source when needed. */
  openScriptSource(key: string | null): void {
    if (key !== this.editorKey()) this.assistSource.set(null);
    const runs = this.scriptRuns();
    // Unlinked, it shows the chart's strategy or newest script — unless a removal cleared it.
    const fallback = this.editorCleared()
      ? null
      : ((runs.find((r) => r.result.kind === 'strategy') ?? runs[runs.length - 1])?.item.key ??
        null);
    const target = key ?? fallback;
    if (target !== null) this.editorCleared.set(false);
    this.editorKey.set(target);
    const item =
      runs.find((r) => r.item.key === target)?.item ??
      (target !== null ? this.pendingScripts().get(target)?.item : undefined);
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
    this.frontDock('editor');
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
    this.frontDock('editor');
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

  /** Which dock tab wins when both the editor and the tester are open. */
  readonly dockPreference = signal<'editor' | 'tester'>('tester');
  /**
   * Pine Logs (PC-I6) is the dock's front tab — opened, or its tab clicked — until the editor or
   * the tester is brought up ({@link frontDock}). Session only, as is which script's logs it shows:
   * a layout keeps the editor and the tester, not this.
   */
  readonly logsFront = signal(false);
  /** The script whose Pine Logs, trace and profiler the dock shows; null: closed. */
  readonly logsKey = signal<string | null>(null);
  /** That script's run on the chart (the dock closes with it). */
  readonly logsRun = computed(() => {
    const key = this.logsKey();
    return key === null ? null : (this.scriptRuns().find((r) => r.item.key === key) ?? null);
  });
  readonly dockTab = computed<'editor' | 'tester' | 'logs' | null>(() => {
    const editor = this.editorOpen();
    const tester = this.testerShown();
    if (this.logsRun() && (this.logsFront() || (!editor && !tester))) return 'logs';
    if (editor && tester) return this.dockPreference();
    return editor ? 'editor' : tester ? 'tester' : null;
  });
  /** The dock's tabs: the panels open in it (its strip shows when there are two or more). */
  readonly dockTabs = computed(() => {
    const out: { id: 'editor' | 'tester' | 'logs'; label: string }[] = [];
    if (this.editorOpen()) out.push({ id: 'editor', label: 'Pine Editor' });
    if (this.testerShown()) out.push({ id: 'tester', label: 'Strategy Tester' });
    if (this.logsRun()) out.push({ id: 'logs', label: 'Pine Logs' });
    return out;
  });

  /** Bring the editor or the tester to the dock's front (Pine Logs goes behind). */
  frontDock(which: 'editor' | 'tester'): void {
    this.logsFront.set(false);
    this.dockPreference.set(which);
  }

  /** A dock tab clicked. */
  showDock(id: 'editor' | 'tester' | 'logs'): void {
    if (id === 'logs') this.logsFront.set(true);
    else this.frontDock(id);
  }

  /** A script's Pine Logs, trace and profiler, in the dock's front (its chip or status line). */
  openLogs(key: string): void {
    this.logsKey.set(key);
    this.logsFront.set(true);
  }

  closeLogs(): void {
    this.logsKey.set(null);
    this.logsFront.set(false);
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
  private readonly accountScope = inject(AccountScopeService);
  private readonly signals = inject(TradeSignalsService);

  /**
   * Engine state drawn on the chart, each layer held and refreshed on its own: the symbol's open
   * positions, working orders and closed positions as the engine last sent them, and the signal and
   * martingale-rung markers. The position lines are re-drawn from these on every live price (their
   * P&L), never re-fetched for it.
   */
  protected readonly openPositions = signal<ChartPosition[]>([]);
  protected readonly workingOrders = signal<OrderDto[]>([]);
  private readonly closedPositions = signal<ChartPosition[]>([]);
  private readonly signalMarkers = signal<ChartMarker[]>([]);
  private readonly rungMarkers = signal<ChartMarker[]>([]);
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
          this.pipSize(),
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
          this.pipSize(),
        )
      : [],
  );

  readonly overlays = computed(() => [...this.positionOverlays(), ...this.orderOverlays()]);
  readonly markers = computed(() => [
    ...this.signalMarkers(),
    ...this.rungMarkers(),
    ...this.closedTradeMarkers(),
    ...this.timelineMarkers(),
    ...this.replay.markers(),
  ]);

  // ── BX-1 (trading): the chart strategy's trade timeline — backtest, live session, paper and broker fills ──
  private readonly scriptStrategies = inject(ScriptStrategyService);
  /** The timeline is drawn (overlays menu "Trade timeline"); it needs an engine strategy script on the chart. */
  readonly showTradeTimeline = signal(false);
  readonly tradeTimelineStrategyId = computed(() => this.strategyRun()?.item.strategyId ?? null);
  private readonly timelineMarkers = signal<ChartMarker[]>([]);
  /** What the drawn timeline holds, or why nothing is drawn (the overlays menu shows it). */
  readonly tradeTimelineInfo = signal<string | null>(null);
  private timelineSeq = 0;
  private readonly loadTradeTimeline = effect((onCleanup) => {
    const show = this.showTradeTimeline();
    const strategyId = this.tradeTimelineStrategyId();
    const symbol = this.symbol();
    const seq = ++this.timelineSeq;
    if (!show || strategyId === null) {
      this.timelineMarkers.set([]);
      this.tradeTimelineInfo.set(show ? 'Add an engine strategy script to the chart to draw its trades.' : null);
      return;
    }
    const oldest = untracked(() => this.bars()[0]?.time ?? null);
    const sub = this.scriptStrategies
      .getParityTimeline(strategyId, timelineWindow(oldest, Date.now()))
      .subscribe({
        next: (res) => {
          if (seq !== this.timelineSeq) return;
          if (!res?.status || !res.data) {
            this.timelineMarkers.set([]);
            this.tradeTimelineInfo.set(res?.message || 'The trade timeline could not be loaded.');
            return;
          }
          this.timelineMarkers.set(timelineMarkers(res.data, symbol));
          this.tradeTimelineInfo.set(
            res.data.symbol.toUpperCase() === symbol.toUpperCase()
              ? [timelineSummary(res.data), ...res.data.notes].join(' — ')
              : `The strategy trades ${res.data.symbol}, not ${symbol}.`,
          );
        },
        error: () => {
          if (seq === this.timelineSeq) this.tradeTimelineInfo.set('The engine did not answer.');
        },
      });
    onCleanup(() => sub.unsubscribe());
  });
  /**
   * Engine state on the chart, each toggled on its own (all off until the operator asks):
   * open positions (entry/SL/TP), pending orders (working limit/stop orders and their O·SL/O·TP),
   * and signals (trade-signal markers + martingale rungs). `showOverlays` is the signals toggle —
   * the name predates the split and is what saved layouts and the assistant already use.
   */
  readonly showPositions = signal(false);
  readonly showOrders = signal(false);
  readonly showOverlays = signal(false);
  /** Fill markers of the symbol's closed trades (entry and exit; paper apart). Off by default. */
  readonly showClosedTrades = signal(false);
  /**
   * Whether the trade lines widen the price scale's fit (CC-10). On by default: a stop below the
   * visible low stays in view. Off: a distant take-profit no longer squashes the candles.
   */
  readonly fitTradeLines = signal(true);
  /** Any of the three on — the assistant's single "trades" switch reads and drives all three. */
  readonly anyTradeOverlay = computed(
    () => this.showPositions() || this.showOrders() || this.showOverlays(),
  );

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
  private readonly eventsFeed = inject(ChartEventsService);
  readonly events = signal<EventMark[]>([]);
  readonly showEvents = signal(true);
  readonly minEventImpact = signal<'High' | 'Medium' | 'Low'>('Medium');
  /**
   * Shade the news blackout around Tier-1 events (CC-I2): the minutes live refuses new entries in,
   * around each High event of the pair's currencies. Saved with the layout.
   */
  readonly showBlackout = signal(true);
  /** The blackout window live applies (`economic-event/news-blackout`), and when it was read. */
  readonly blackout = signal<BlackoutWindow | null>(null);
  private blackoutAt = 0;
  /**
   * The pair's two currencies — the events the chart asks for, and the ones the blackout listens to.
   * From the pair's metadata; otherwise the symbol's first and next three letters, the engine's
   * `NewsBlackoutRules.CurrenciesOf` (a symbol shorter than six letters has none).
   */
  readonly pairCurrencies = computed(
    () => {
      const pair = this.currentPair();
      const fromPair = [pair?.baseCurrency, pair?.quoteCurrency]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase());
      if (fromPair.length) return fromPair;
      const symbol = this.symbol().toUpperCase();
      return symbol.length >= 6 ? [symbol.slice(0, 3), symbol.slice(3, 6)] : [];
    },
    { equal: (a, b) => a.join() === b.join() },
  );
  /**
   * The events the chart draws: in replay, none after the head — the calendar of the replayed past,
   * not its future (their actuals would be look-ahead).
   */
  readonly chartEvents = computed(() => {
    const events = this.events();
    if (!this.replayActive()) return events;
    const shown = this.displayBars();
    const head = shown[shown.length - 1];
    return head ? events.filter((e) => e.time <= head.time) : [];
  });
  /** What the blackout chip shades, in the policy's numbers. */
  readonly blackoutTitle = computed(() => {
    const w = this.blackout();
    if (!w) return 'Shade the news blackout around high-impact events';
    if (!w.active)
      return `The news blackout is off (${w.explanation ?? 'no window'}): nothing is refused around events`;
    const ccy = this.pairCurrencies().join('/') || 'this symbol';
    return `Shade the ${w.minutesBefore} min before and ${w.minutesAfter} min after each high-impact ${ccy} event: live refuses new entries then`;
  });
  /** The blackout spans to shade (UTC ms). */
  readonly eventBands = computed(() =>
    this.showEvents() && this.showBlackout()
      ? blackoutBands(this.chartEvents(), this.blackout(), this.pairCurrencies())
      : [],
  );

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
  private readonly headlineTick = effect((onCleanup) => {
    const t = setInterval(() => {
      if (!document.hidden) this.headlineClock.set(Date.now());
    }, 30_000);
    onCleanup(() => clearInterval(t));
  });
  readonly watchHeadline = computed<WatchHeadline | null>(() => {
    const a = this.articles()[0];
    if (!a) return null;
    return { title: a.title, source: a.sourceName, at: headlineAge(a.publishedAtUtc, this.headlineClock()) };
  });
  /** The SP-I9 side panels (notes, broker depth, sentiment, account), one at a time beside the page's own panes. */
  readonly chartPanels = inject(ChartPanelsState);

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
  private readonly newsIntel = inject(NewsIntelService);
  readonly sidePane = signal<'none' | 'details' | 'news' | 'calendar' | 'datawindow'>('none');
  /** Economic calendar pane: every currency rather than the pair's two; minimum importance. */
  readonly calendarAll = signal(false);
  readonly calendarMinImpact = signal<EconomicImpact>('Low');
  /** The calendar event whose AI reading is open. */
  readonly calendarEvent = signal<UpcomingEconomicEvent | null>(null);
  readonly calendarCurrencies = computed(
    () => [this.details().base, this.details().quote].filter((c) => c && c !== '—'),
    { equal: (a, b) => a.join() === b.join() },
  );
  readonly articles = signal<NewsArticleView[]>([]);
  /** The news item long-pressed for its AI analysis modal. */
  readonly newsAnalysis = signal<NewsArticleView | null>(null);

  /** Long-press on a news item: the article itself, in a new tab. */
  openArticle(a: NewsArticleView): void {
    if (a.url) window.open(a.url, '_blank', 'noopener,noreferrer');
  }
  readonly newsLoading = signal(false);
  readonly newsFocus = signal<NewsFocusResult | null>(null);

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
    symbolFacts: () => ({
      pipSize: this.pipSize(),
      contractSize: this.currentPair()?.contractSize || 100_000,
    }),
    fetchIntrabar: (resolution, fromMs, toMs, count) =>
      this.feed.getBars(this.symbol(), resolution, fromMs, toMs, count).then((r) => r.bars),
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
  /** The indicators' engine replay sessions: a head moving forward executes only the new bars (CC-I4). */
  private readonly replayScripts = new ReplayScriptSessions(inject(ScriptingRunService));
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
    const facts = positionAccountFacts({
      account,
      pair: this.currentPair() ?? null,
      pipSize: this.pipSize(),
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
    const prefill = d ? positionOrderPrefill(d) : null;
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
  readonly timezones = CHART_TIMEZONES;
  readonly timezone = signal<string>('UTC');
  readonly layoutMenuOpen = signal(false);
  readonly contextMenu = signal<{ x: number; y: number; price: number | null } | null>(null);
  protected readonly chartAlerts = inject(ChartAlertsService);
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
  /** One pip of this symbol, in price (the engine's rule: ten points on fractional FX quotes). */
  readonly pipSize = computed(() =>
    pipSizeFor(
      this.precision(),
      (this.currentPair() as (CurrencyPairDto & { assetClass?: string | null }) | undefined)
        ?.assetClass,
    ),
  );

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
    const last = bars[bars.length - 1];
    // A session-grid bar says where its period ends: open while it lasts, closed after — a weekly
    // bar opened on Sunday no longer reads "open" through Saturday.
    if (last.closeTime !== undefined) {
      const now = this.serverClock.now();
      if (isCurrentPeriod(last, now)) return 'open';
      return now - last.closeTime <= 3 * 86_400_000 ? 'closed' : 'stale';
    }
    const step = resolutionMs(this.resolution()) ?? 60_000;
    const age = Date.now() - last.time;
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
    { id: 'trendlines', label: 'Trendlines', hint: 'Fitted trendlines, scored by touches, age and recency' },
    { id: 'htfLevels', label: 'HTF levels', hint: "The next higher timeframe's support and resistance" },
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
    this.assistSource.set({ text: d.source, seq: ++this.assistSeq });
    this.editorOpen.set(true);
    this.frontDock('editor');
    this.notify.success(`${d.name} is in the Pine Editor as an unsaved draft.`);
  }

  /** The favourite drawing tools (DR-I12): starred in the flyouts, on the Favourites bar. */
  readonly favoriteTools = inject(DrawingFavorites);

  /** Star / unstar a tool in a rail flyout (the click does not arm it). */
  toggleFavoriteTool(kind: DrawingKind, ev: Event): void {
    ev.stopPropagation();
    this.favoriteTools.toggle(kind);
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

  /** The bars on screen (the chart's visible window), or every loaded bar before it is up. */
  private visibleBars(): Bar[] {
    return this.host()?.visibleWindow() ?? this.bars();
  }

  readonly filteredSymbols = computed(() => rankSymbols(this.symbols(), this.symbolQuery()));

  /** Enter in the symbol search: the first (best) match, as on TradingView (CC-I13). */
  pickFirstSymbol(): void {
    const first = this.filteredSymbols()[0]?.symbol;
    if (first) this.selectSymbol(first);
  }

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
    this.favoriteTools.reload();
    this.magnetStrength.set(readPref('magnetStrength', 'weak'));
    this.stayInDrawing.set(readPref('stayInDrawing', false));
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
      recorded: (symbol) => this.undoHistory.record({ kind: 'drawing', symbol }),
      dropped: (symbol) => this.undoHistory.dropDrawing(symbol),
    };
    this.destroyRef.onDestroy(() => {
      this.drawings.undoHook = null;
      clearTimeout(this.undoTimer);
    });
    effect(() => {
      const now = this.undoableState();
      untracked(() => this.noteUndoable(now));
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
      untracked(() => this.loadFundamentals(items, symbol));
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
    const liveTimer = setInterval(() => {
      if (this.replayActive()) return;
      // PC-I1: a script whose warm session the hub keeps current is not run again — it is asked what changed instead
      // (a quiet market pushes nothing, and this is how a session that ended is found).
      rerunScripts((r) => !this.warmCovered(r.item.key));
      for (const s of this.warmSessions.all()) if (this.warmCovered(s.key)) this.resyncWarm(s.key);
    }, 60_000);
    this.destroyRef.onDestroy(() => clearInterval(liveTimer));

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
        // The window on screen — what the chart's own overlays describe (CC-21: these read every
        // loaded bar while the chart drew the visible ones, so the assistant quoted other levels).
        structureSummary: () => marketStructure(this.visibleBars()).summary,
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
    this.scriptHub.reconnected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        for (const s of this.warmSessions.all()) this.resyncWarm(s.key);
      });
    this.destroyRef.onDestroy(() => {
      for (const s of this.warmSessions.all()) this.releaseWarm(s.key);
    });
    // EV-1: a headline labelled for the pair's currencies re-reads the news pane (and the watchlist's headline).
    let newsTimer: ReturnType<typeof setTimeout> | undefined;
    this.destroyRef.onDestroy(() => clearTimeout(newsTimer));
    this.realtime
      .on<NewsArticleIngestedPayload>('newsArticleIngested')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((article) => {
        if (this.sidePane() !== 'news' && !this.watchlistOpen()) return;
        if (!concernsPane(article, this.pairCurrencies())) return;
        // A classification batch pushes several at once: one re-read for all of them.
        clearTimeout(newsTimer);
        newsTimer = setTimeout(() => this.loadNews(), 1500);
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
        queueMicrotask(() => {
          this.flushPendingRange();
          this.flushPendingView();
        });
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
    this.destroyRef.onDestroy(() => {
      this.replay.pause();
      this.replayScripts.stopAll();
    });

    // Deep link: /chart-analysis/EURUSD?tf=60 so a chart can be linked to from
    // a position or a signal without the operator re-selecting anything.
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => this.followRoute(params));

    // Live price → update the forming bar. The engine throttles these, so this
    // is a repaint of the last candle rather than a tick stream.
    this.realtime
      .on<{ symbol?: string; bid?: number; ask?: number; price?: number }>('priceUpdated')
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
    const resync = setInterval(() => void this.syncFormingBars(), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(resync));
  }

  /**
   * Each trade layer's newest request: a reply for an older one — another symbol, another account
   * scope, a toggle since switched off — is dropped (CC-09: a slow EURUSD reply painted EURUSD's
   * stop and target on GBPUSD).
   */
  private readonly tradeLoads = { positions: 0, orders: 0, closed: 0, rungs: 0, signals: 0 };

  /**
   * Load this symbol's trade layers onto the chart: open positions, working orders, closed trades,
   * martingale rungs and signals — each only when its toggle is on. Called on a symbol switch, an
   * account switch, a toggle, and whenever the engine reports a fill, a position change or a new
   * signal (realtime, {@link scheduleTradeRefresh}); before CC-09 they loaded once and never
   * followed a fill.
   *
   * Filtered by symbol and account server-side via the nested `filter` object — sent flat the
   * criteria are discarded in silence and the handler answers with page 1 of the whole table — and
   * re-checked here (`positionLines` / `orderLines`).
   */
  private loadTradingOverlays(): void {
    const symbol = this.symbol();
    // The header's account scope. Positions and orders belong to an account, so only the selected
    // account's are drawn (an aggregate scope draws its accounts'). An empty scope means no live
    // account — draw none rather than falling back to the whole fleet.
    const accountIds = Array.from(this.accountScope.accountIds());
    const accountKey = this.accountScope.accountIdsKey();
    /** The chart still shows what this request was for. */
    const current = () =>
      symbol === this.symbol() && accountKey === this.accountScope.accountIdsKey();
    const loads = this.tradeLoads;

    if (!this.showPositions()) {
      loads.positions++;
      this.openPositions.set([]);
    } else {
      const seq = ++loads.positions;
      this.positions
        .list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { symbol, status: 'Open', tradingAccountIds: accountIds },
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.positions || !current() || !res?.status || !res.data) return;
          this.openPositions.set((res.data.data ?? []) as ChartPosition[]);
        });
    }

    // ── Working orders ────────────────────────────────────────────────────
    //
    // Only orders that can still fill (orderLines). A filled order is already a
    // position and is drawn as one; a cancelled one is history.
    if (!this.showOrders()) {
      loads.orders++;
      this.workingOrders.set([]);
    } else {
      const seq = ++loads.orders;
      this.orders
        .list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { symbol, tradingAccountIds: accountIds },
          sortBy: 'id',
          sortDirection: 'desc',
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.orders || !current() || !res?.status || !res.data) return;
          this.workingOrders.set(res.data.data ?? []);
        });
    }

    // ── Closed trades ─────────────────────────────────────────────────────
    //
    // The most recent closed positions of the symbol in scope; their fills are pinned to the bars
    // they happened in, and those before the loaded history drop off the chart (applyMarkers).
    if (!this.showClosedTrades()) {
      loads.closed++;
      this.closedPositions.set([]);
    } else {
      const seq = ++loads.closed;
      this.positions
        .list({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: { symbol, status: 'Closed', tradingAccountIds: accountIds },
          sortBy: 'openedAt',
          sortDirection: 'desc',
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.closed || !current() || !res?.status || !res.data) return;
          this.closedPositions.set((res.data.data ?? []) as ChartPosition[]);
        });
    }

    if (!this.showOverlays()) {
      loads.rungs++;
      loads.signals++;
      this.signalMarkers.set([]);
      this.rungMarkers.set([]);
      return;
    }
    const inScope = this.inTradeScope();

    // ── Martingale rungs ──────────────────────────────────────────────────
    //
    // Each closed rung is pinned to the BAR it closed on, not to a price line:
    // a chain's rungs are events in sequence, and stacking six horizontal lines
    // on the price scale buries the candles the operator is reading.
    const rungSeq = ++loads.rungs;
    this.martingale
      .getOverview({ maxChains: 40 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (overview) => {
          if (rungSeq !== loads.rungs || !current()) return;
          const chains = (overview?.chains ?? []).filter(
            (c) =>
              (c.symbol ?? '').toUpperCase() === symbol.toUpperCase() &&
              inScope(c.tradingAccountId),
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
        error: () => {
          if (rungSeq === loads.rungs) this.rungMarkers.set([]);
        },
      });

    const signalSeq = ++loads.signals;
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
        if (signalSeq !== loads.signals || !current() || !res?.status || !res.data) return;
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

  // ── Replay controls ──────────────────────────────────────────────────────

  /**
   * Bar Replay on: the whole chart shows and the next click on it picks the bar replay starts at
   * (TradingView's "Select bar"); the replay bar also takes a date and time.
   */
  startReplay(): void {
    const total = this.bars().length;
    if (total === 0) return;
    this.replay.start(total);
    void this.pickReplayStart();
  }

  /** The next click on the chart picks the bar replay starts at; Esc keeps where it is. */
  async pickReplayStart(): Promise<void> {
    const host = this.host();
    if (!host || !this.replayActive()) return;
    this.replay.pause();
    this.replay.selecting.set(true);
    const pick = await host.pickPoint('time');
    this.replay.selecting.set(false);
    if (pick && this.replayActive()) this.replay.startAt(pick.time);
  }

  /**
   * Start replay at a date and time on the chart's clock (`yyyy-mm-ddThh:mm`), loading history back to
   * it first — as go-to-date does, at most {@link GO_TO_DATE_PAGES} pages — and showing it.
   */
  async startReplayAt(value: string): Promise<void> {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
    if (!m) return;
    const t =
      midnightOnClock(Number(m[1]), Number(m[2]) - 1, Number(m[3]), this.timezone()) +
      Number(m[4] ?? 0) * 3_600_000 +
      Number(m[5] ?? 0) * 60_000;
    this.host()?.cancelPick();
    await this.loadBackTo(t);
    const oldest = this.bars()[0];
    if (!oldest) return;
    if (oldest.time > t && !this.historyComplete())
      this.notify.warning(
        `History before ${this.barTimeLabel(oldest)} is not loaded: replay starts at the oldest bar.`,
      );
    if (!this.replayActive()) this.replay.start(this.bars().length);
    this.replay.startAt(t);
    const span = Math.max((resolutionMs(this.resolution()) ?? DAY) * 120, DAY);
    this.pendingRange = { fromMs: t - span * 0.8, toMs: t + span * 0.2 };
    this.flushPendingRange();
  }

  /** Load history pages until the bars reach back to `t` (at most {@link GO_TO_DATE_PAGES} pages). */
  private async loadBackTo(t: number): Promise<void> {
    for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
      const held = this.bars();
      if (!held.length || held[0].time <= t || this.historyComplete()) break;
      await this.loadOlder();
      if (this.bars()[0]?.time === held[0].time) break; // nothing older came back
    }
  }

  /** The series changed in replay: history back to the head's instant, and the head on its bar there. */
  private async reanchorReplay(anchor: number): Promise<void> {
    this.replayScripts.stopAll();
    this.replay.reanchor(anchor);
    if ((this.bars()[0]?.time ?? anchor) > anchor) {
      await this.loadBackTo(anchor);
      if (this.replayActive()) this.replay.reanchor(anchor);
    }
  }

  exitReplay(): void {
    this.host()?.cancelPick();
    this.replay.exit();
    this.replayScripts.stopAll();
  }

  stepReplay(delta: number): void {
    const dir = delta < 0 ? -1 : 1;
    const n = Math.max(1, Math.abs(Math.trunc(delta)) || 1);
    if (n === 1) {
      void this.replay.step(dir);
      return;
    }
    // Many at once (the assistant): whole bars.
    const c = this.replay.cursor();
    this.replay.moveTo({ index: c.index + dir * n, sub: null });
  }

  toggleReplayPlay(): void {
    this.replay.togglePlay();
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

  setReplaySpeed(raw: string): void {
    this.replay.setSpeed(Number(raw));
  }

  setReplayIndex(raw: string): void {
    this.replay.setIndex(Number(raw));
  }

  /**
   * The time at the replay head, for the replay bar: the bar's, or — while a bar forms from intrabar
   * steps — the last intrabar bar's open on the chart's clock.
   */
  replayTime(): string {
    const head = this.replay.headBar();
    if (!head) return '';
    if (this.replay.cursor().sub === null) return this.barTimeLabel(head);
    const zone = this.timezone();
    return this.formatTime(head.time + (zone === 'UTC' ? 0 : timezoneOffsetMinutes(zone, head.time) * 60_000));
  }

  /** What the events on the chart were fetched for, and the window they cover (UTC ms). */
  private eventsHeld: { key: string; from: number; to: number } | null = null;
  /** Bumped by every full load: a reply for an older one (another symbol, importance) is dropped. */
  private eventsLoad = 0;

  /**
   * Load the pair's economic events onto the time axis (CC-07, SP-08, contract C3): the loaded bars'
   * window through two weeks ahead, the pair's currencies and the chart's minimum importance filtered
   * on the engine. `extend` (scroll-back loaded older bars): fetch only what the held window does not
   * cover on the left, and merge it — the events used to stay at the first load's window.
   */
  private loadEvents(extend = false): void {
    if (!this.showEvents()) {
      this.eventsLoad++;
      this.eventsHeld = null;
      this.events.set([]);
      return;
    }
    const currencies = this.pairCurrencies();
    const minImpact = this.minEventImpact();
    const symbol = this.symbol().toUpperCase();
    const key = `${symbol}|${currencies.join(',')}|${minImpact}`;
    const loaded = this.bars();
    const wanted = eventsWindow(loaded.length ? loaded[0].time : null, Date.now());
    const held = this.eventsHeld?.key === key ? this.eventsHeld : null;
    const span = extend ? (held ? missingOnTheLeft(held, wanted) : null) : wanted;
    if (!span) return;
    const load = extend ? this.eventsLoad : ++this.eventsLoad;
    if (!extend) this.eventsHeld = null;
    this.refreshBlackout();
    void this.eventsFeed
      .load({ currencies, minImpact, from: span.from, to: span.to })
      .then((marks) => {
        // A newer load (another symbol, importance or toggle) owns the layer now.
        if (load !== this.eventsLoad || !marks) return;
        if (extend) {
          const now = this.eventsHeld;
          if (!now || now.key !== key) return;
          this.events.set(mergeMarks(this.events(), marks));
          this.eventsHeld = { key, from: Math.min(now.from, span.from), to: now.to };
        } else {
          this.events.set(marks);
          this.eventsHeld = { key, from: span.from, to: span.to };
          // History loaded on the left while this was in flight.
          this.loadEvents(true);
        }
      });
  }

  /** Read the blackout window again when it is older than ten minutes (it is config). */
  private refreshBlackout(): void {
    if (Date.now() - this.blackoutAt < 600_000) return;
    this.blackoutAt = Date.now();
    void this.eventsFeed.blackout().then((w) => {
      if (w) this.blackout.set(w);
      else this.blackoutAt = 0;
    });
  }

  toggleEvents(): void {
    this.showEvents.set(!this.showEvents());
    this.loadEvents();
  }

  /** The minimum importance is filtered on the engine: a change asks again. */
  cycleEventImpact(): void {
    const order: Array<'High' | 'Medium' | 'Low'> = ['High', 'Medium', 'Low'];
    const next = order[(order.indexOf(this.minEventImpact()) + 1) % order.length];
    this.minEventImpact.set(next);
    this.loadEvents();
  }

  openSidePane(pane: 'details' | 'news' | 'calendar' | 'datawindow'): void {
    this.sidePane.set(this.sidePane() === pane ? 'none' : pane);
    // One side pane at a time: the page's own close the SP-I9 panels.
    if (this.sidePane() !== 'none') this.chartPanels.close();
    if (this.sidePane() === 'news') this.loadNews();
  }

  /** A right-rail SP-I9 panel (notes, broker depth, sentiment, account) — it replaces any open side pane. */
  openPanel(panel: SidePanel): void {
    this.sidePane.set('none');
    this.chartPanels.toggle(panel);
  }

  private newsSeq = 0;

  /**
   * Headlines for the charted pair's currencies — the base AND the quote (SP-07: it read the base only).
   *
   * Filtered to the two currencies the pair is made of, for the same reason the
   * economic events are: an operator charting EURUSD does not want JPY
   * headlines competing for the same space. Each currency is read separately so
   * each gets its own budget (a busy USD tape cannot crowd EUR out), then merged
   * once per article, newest first.
   */
  private loadNews(): void {
    const pair = this.symbols().find(
      (p) => (p.symbol ?? '').toUpperCase() === this.symbol().toUpperCase(),
    );
    const currencies = [...new Set([pair?.baseCurrency, pair?.quoteCurrency])]
      .map((c) => c?.toUpperCase())
      .filter((c): c is string => !!c);
    const n = ++this.newsSeq;
    this.newsLoading.set(true);
    // The news module can be disabled entirely; an empty pane says that
    // better than an error toast the operator cannot act on.
    const reads = (currencies.length ? currencies : [undefined]).map((currency) =>
      this.newsIntel.getArticles({ currency, hours: 48, take: 40 }).pipe(catchError(() => of([]))),
    );
    forkJoin(reads)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((lists) => {
        // A slower reply for the previous symbol must not replace this one's headlines.
        if (n !== this.newsSeq) return;
        this.articles.set(mergeArticles(...lists.map((rows) => (Array.isArray(rows) ? rows : []))).slice(0, 60));
        this.newsLoading.set(false);
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
  }

  togglePositions(): void {
    this.showPositions.set(!this.showPositions());
  }

  toggleOrders(): void {
    this.showOrders.set(!this.showOrders());
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

  /** The series the newest {@link reload} loads (or loaded). */
  private requested: SeriesId | null = null;

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
    if (sameSeries(this.requested, { symbol, resolution })) return;
    this.symbol.set(symbol);
    this.resolution.set(resolution);
    void this.reload();
  }

  async reload(): Promise<void> {
    const symbol = this.symbol();
    const resolution = this.resolution();
    this.requested = { symbol, resolution };
    // Bar Replay stays at its instant across a symbol or timeframe switch (CC-I4).
    const replayAnchor = this.replayHead();
    /** Still the chart's series? A switch made while this loads has a reload of its own. */
    const current = () => symbol === this.symbol() && resolution === this.resolution();
    this.loading.set(true);
    this.error.set(null);
    // Drawings belong to a symbol AND timeframe, so the scope has to move with
    // the chart before any drawing is read or written.
    this.drawings.setScope(symbol, resolution);
    this.loadTradingOverlays();
    this.feed.invalidate(symbol, resolution);
    this.rollover.reset();
    // The symbol's session, which the day-based studies count trading days by, comes with every
    // session-grid load; the stored grid's candles carry none, so it is asked for once beside them.
    if (!isSessionResolution(resolution)) void this.feed.learnSession(symbol);
    const now = Date.now();
    try {
      const { bars } = await this.feed.getBars(symbol, resolution, 0, now, PAGE_BARS);
      // Landing after a switch, these would go on screen under the next symbol's name.
      if (!current()) return;
      this.historyStart.set(null);
      this.bars.set(bars);
      this.barsFor.set({ symbol, resolution });
      if (this.replayActive() && replayAnchor !== null) void this.reanchorReplay(replayAnchor);
      this.tailMergedAt = this.ticksApplied;
      this.lastStored = lastCompleteBarTime(bars, resolution);
      // The stored history ends at the last CLOSED bar; build the one still forming from real data
      // rather than from whatever tick happens to arrive first. (The session grid's came with it.)
      if (!isSessionResolution(resolution)) void this.syncFormingBars();
      // After the bars, so the calendar window matches what is on screen.
      this.loadEvents();
      if (bars.length === 0) {
        this.error.set(`No ${this.resolutionLabel(resolution)} candles stored for ${symbol}.`);
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

  /**
   * Scroll-back paging: fetch the window ENDING just before the oldest bar we hold
   * and prepend it. Asking by `to` rather than by `from` matches how the engine
   * pages (newest-first from a cutoff), so each page is a clean extension
   * backwards with no gap and no overlap to reconcile.
   *
   * The cutoff is the oldest bar's open less 1 ms, not less one bar width: on the
   * session grid a period is not a fixed width (a month, a week across a DST
   * change), and `oldest − width` skipped the bar before; on 30m it cut the M15
   * page between the two halves of the bar before, which then joined the chart
   * half-built.
   */
  async loadOlder(): Promise<void> {
    const series: SeriesId = { symbol: this.symbol(), resolution: this.resolution() };
    const held = this.bars();
    // Nothing to extend, a load under way, or the bars on screen are not this series' yet.
    if (held.length === 0 || this.loading() || !sameSeries(this.barsFor(), series)) {
      this.host()?.historyLoaded();
      return;
    }
    const oldest = held[0].time;
    this.loading.set(true);
    try {
      const { bars } = await this.feed.getBars(
        series.symbol,
        series.resolution,
        0,
        oldest - 1,
        PAGE_BARS,
      );
      // After a switch made meanwhile these are another series' history: not prepended.
      if (sameSeries(this.barsFor(), series)) {
        const older = bars.filter((b) => b.time < oldest);
        if (older.length === 0) {
          // Nothing before the oldest bar: the start of history. Stop asking at the left edge.
          this.historyStart.set(`${series.symbol}|${series.resolution}`);
        } else {
          const merged = new Map<number, Bar>();
          for (const b of older) merged.set(b.time, b);
          // The bars as they are now: ticks may have moved the newest one during the load.
          for (const b of this.bars()) merged.set(b.time, b);
          const next = [...merged.values()].sort((a, b) => a.time - b.time);
          const added = next.length - this.bars().length;
          this.bars.set(next);
          // Replay counts bars from the left: the head stays on its bar (CC-11 — it jumped ~1,500
          // bars into the future with every page of history).
          this.replay.shift(added);
          // The events of the history just loaded (the layer covered the first window only), and the
          // compare studies' other symbols over it.
          this.loadEvents(true);
          void this.extendCompareBars(next[0].time);
        }
      }
    } catch {
      // The engine refused or could not be reached: the history stays as it is, and the next
      // scroll to the left edge asks again.
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
   *
   * <p>On the session grid (2h … 1M) the engine builds the forming bar itself, on its own calendar:
   * this re-reads the newest bars from it instead ({@link syncSessionTail}).</p>
   */
  private async syncFormingBars(): Promise<void> {
    const resolution = this.resolution();
    const symbol = this.symbol();
    if (isSessionResolution(resolution)) return this.syncSessionTail();
    const stored = this.lastStored;
    // While a switch loads, the bars (and `lastStored`) are still the previous series'.
    const onScreen = () => sameSeries(this.barsFor(), { symbol, resolution });
    if (resolution === '1' || stored === null || this.bars().length === 0 || !onScreen()) return;

    const minutes = await this.feed.minuteBarsSince(symbol, stored + 1);
    if (!minutes || minutes.length === 0) return;
    // The operator may have switched symbol or timeframe while the request was in flight.
    if (
      symbol !== this.symbol() ||
      resolution !== this.resolution() ||
      stored !== this.lastStored ||
      !onScreen()
    )
      return;

    this.bars.set(mergeForming(this.bars(), foldBars(minutes, resolution), stored));
  }

  /** Ticks applied to the chart's newest bar, ever; against {@link tailMergedAt}: any since the last merge. */
  private ticksApplied = 0;
  /** {@link ticksApplied} when the engine's newest bars were last laid over the chart's. */
  private tailMergedAt = 0;
  /** The request for the newest session bars in flight, by series — shared by the minute resync and a rollover. */
  private tailInFlight: { series: string; done: Promise<void> } | null = null;
  /** One request per bar change when ticks pass the newest session bar's close (`SessionRollover`). */
  private readonly rollover = new SessionRollover(() => Date.now());

  /**
   * Re-read the newest session-grid bars from the engine — the bar still forming, the one or two
   * before it (a period that just closed may have been built before its last minute was stored), and
   * any period that opened since the chart last asked — and lay them over the chart's
   * ({@link mergeSessionTail}). Shared by the minute resync and a tick past the newest bar's close:
   * one request at a time per series.
   */
  private syncSessionTail(): Promise<void> {
    const series = `${this.symbol()}|${this.resolution()}`;
    if (this.tailInFlight?.series === series) return this.tailInFlight.done;
    const done: Promise<void> = this.fetchSessionTail().finally(() => {
      if (this.tailInFlight?.done === done) this.tailInFlight = null;
    });
    this.tailInFlight = { series, done };
    return done;
  }

  private async fetchSessionTail(): Promise<void> {
    const symbol = this.symbol();
    const resolution = this.resolution();
    const onScreen = () =>
      symbol === this.symbol() &&
      resolution === this.resolution() &&
      sameSeries(this.barsFor(), { symbol, resolution });
    const held = this.bars();
    if (held.length === 0 || !onScreen()) return;

    const tail = await this.feed.sessionTail(symbol, resolution, held[held.length - 1].time);
    // A failed request leaves the chart as it is; a switch made meanwhile has bars of its own.
    if (!tail || !onScreen()) return;
    // Ticks since the last merge are newer than the engine's forming bar: they keep its close.
    const ticked = this.ticksApplied !== this.tailMergedAt;
    this.tailMergedAt = this.ticksApplied;
    this.bars.set(mergeSessionTail(this.bars(), tail, ticked));
  }

  private applyTick(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    if (!tick?.symbol || tick.symbol.toUpperCase() !== this.symbol().toUpperCase()) return;
    const price = tick.bid ?? tick.price ?? tick.ask;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    this.liveAt.set(Date.now());
    // The open positions' P&L reads both sides: a long exits at the bid, a short at the ask.
    const ask = typeof tick.ask === 'number' && Number.isFinite(tick.ask) ? tick.ask : null;
    this.liveQuote.set({ bid: price, ask });

    // Right after a switch the bars on screen are still the previous series': not this tick's.
    if (!sameSeries(this.barsFor(), { symbol: this.symbol(), resolution: this.resolution() }))
      return;
    const current = this.bars();
    if (current.length === 0) return;

    if (isSessionResolution(this.resolution())) {
      this.applyTickOnSessionGrid(current, price);
      return;
    }

    // The same bucketing the stored history uses — the UTC epoch grid, exact for 1m … 1h — on the
    // engine's clock, as the countdown and a run's live bar read it. A price past the newest bar's
    // bucket opens its own bucket's bar, so the chart never stalls a timeframe behind the market.
    const next = applyStoredTick(current, price, this.serverClock.now(), this.resolution());
    if (next) this.bars.set(next);
  }

  /**
   * A live price on the session grid (2h … 1M), on the engine's clock: it moves the newest bar while
   * that bar's period lasts. From the bar's close on, it opens the next period's bar itself — at the
   * old bar's close, or with the session it is in after the weekend, laid out by the symbol's session
   * (`nextSessionPeriod`) — as TradingView does on a period's first tick: the engine's forming bar is
   * folded from closed M1, so for a period's first minute there is none to ask for. The minute
   * resync then lays the engine's own bar over it. Where the chart cannot tell the period (a gap of
   * a whole period, no session known), it asks for the newest bars instead, once per bar
   * ({@link SessionRollover}).
   */
  private applyTickOnSessionGrid(current: Bar[], price: number): void {
    const calendar = this.tradingCalendar();
    const resolution = this.resolution();
    const outcome = applySessionTick(
      current,
      price,
      this.serverClock.now(),
      calendar ? (last, now) => nextSessionPeriod(calendar, resolution, last, now) : undefined,
    );
    if (outcome.kind === 'update' || outcome.kind === 'open') {
      this.ticksApplied++;
      this.bars.set(outcome.bars);
      return;
    }
    if (outcome.kind !== 'rollover') return;
    const key = `${this.symbol()}|${this.resolution()}|${current[current.length - 1].time}`;
    if (!this.rollover.request(key)) return;
    void this.syncSessionTail().finally(() => this.rollover.done(key));
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
    // Layout memory per symbol (CC-I11): the symbol left is remembered as it is; the one switched to opens as it was left.
    this.symbolMemory.update((m) =>
      rememberSymbol(m, this.symbol(), {
        resolution: this.resolution(),
        ...(this.viewSnapshot() ? { view: this.viewSnapshot()! } : {}),
      }),
    );
    const memory = this.rememberPerSymbol() ? recalled(this.symbolMemory(), symbol) : null;
    if (memory && isSupportedResolution(memory.resolution)) this.resolution.set(memory.resolution);
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

  /**
   * The compare studies' other symbols, on this resolution, back to the chart's oldest bar (CC-13:
   * they read the first 1,500 bars only, never extended nor updated). Ticks keep them live
   * ({@link applyCompareTick}); scroll-back extends them ({@link extendCompareBars}).
   */
  private compareRequest = 0;
  private async loadCompareBars(symbols: string[], resolution: TvResolution): Promise<void> {
    const request = ++this.compareRequest;
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
    if (request !== this.compareRequest || resolution !== this.resolution()) return;
    this.compareBars.set(next);
    const oldest = this.bars()[0]?.time;
    if (oldest !== undefined) void this.extendCompareBars(oldest);
  }

  /** Extend every compare series back to `oldestMs` (the chart's oldest bar), a page at a time. */
  private async extendCompareBars(oldestMs: number): Promise<void> {
    const resolution = this.resolution();
    const request = this.compareRequest;
    for (const sym of Object.keys(this.compareBars())) {
      for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
        const held = this.compareBars()[sym];
        if (!held?.length || held[0].time <= oldestMs) break;
        let older: Bar[] = [];
        try {
          const res = await this.feed.getBars(sym, resolution, 0, held[0].time - 1, PAGE_BARS);
          older = res.bars.filter((b) => b.time < held[0].time);
        } catch {
          break;
        }
        if (request !== this.compareRequest || resolution !== this.resolution()) return;
        if (!older.length) break;
        this.compareBars.update((all) => {
          const current = all[sym] ?? [];
          return {
            ...all,
            [sym]: [...older.filter((b) => b.time < (current[0]?.time ?? Infinity)), ...current],
          };
        });
      }
    }
  }

  /** A live price of a compare study's other symbol moves its bars (CC-13). */
  private applyCompareTick(tick: {
    symbol?: string;
    bid?: number;
    price?: number;
    ask?: number;
  }): void {
    const symbol = tick?.symbol?.toUpperCase();
    const price = tick?.bid ?? tick?.price ?? tick?.ask;
    if (!symbol || typeof price !== 'number') return;
    const held = this.compareBars()[symbol];
    if (!held?.length) return;
    const next = liveTick(
      held,
      price,
      this.serverClock.now(),
      this.resolution(),
      this.calendarOf(symbol),
    );
    if (next) this.compareBars.update((all) => ({ ...all, [symbol]: next }));
  }

  /** A live price moves the split panels that show its symbol (CC-12: they were static). */
  private applyPanelTick(tick: {
    symbol?: string;
    bid?: number;
    price?: number;
    ask?: number;
  }): void {
    const symbol = tick?.symbol?.toUpperCase();
    const price = tick?.bid ?? tick?.price ?? tick?.ask;
    if (!symbol || typeof price !== 'number') return;
    const panels = this.comparePanels();
    if (!panels.some((p) => p.symbol.toUpperCase() === symbol && p.bars.length)) return;
    const now = this.serverClock.now();
    this.comparePanels.set(
      panels.map((p) => {
        if (p.symbol.toUpperCase() !== symbol || !p.bars.length) return p;
        const next = liveTick(p.bars, price, now, p.resolution, this.calendarOf(symbol));
        return next ? { ...p, bars: next } : p;
      }),
    );
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

  /**
   * Orders every run of the chart's scripts ({@link LiveRerunScheduler}): only a script's newest run
   * is drawn; an explicit run starts at once and supersedes the one in flight; quiet re-runs (the
   * forming bar ticking, the minute timer, a theme switch) go one at a time per script, spaced by
   * its round trip, and wait for an explicit run in flight.
   */
  private readonly runScheduler = new LiveRerunScheduler(
    (key, ticket) => this.rerunQuietly(key, ticket),
    LIVE_RERUN_MS,
    () => Date.now(),
    () => document.hidden,
  );
  /**
   * Each script's run in flight, so that a newer run, or removing the script, aborts its request —
   * or the retry it waits for after a busy refusal.
   */
  private readonly runsInFlight = new Map<
    string,
    { ticket: number; sub: { unsubscribe(): void }; done?: (r: RunOutcome) => void }
  >();

  /**
   * A quiet re-run the scheduler started: the script as it is on the chart, on the bar forming now
   * — or, in Bar Replay, to the head.
   */
  private rerunQuietly(key: string, ticket: number): void {
    const run = this.scriptRuns().find((r) => r.item.key === key);
    const chart = { symbol: this.symbol(), resolution: this.resolution() };
    if (!run || !sameSeries(run, chart)) {
      this.runScheduler.settle(key, ticket);
      return;
    }
    if (this.replayActive() && this.stepReplayRun(run, ticket)) return;
    this.runScript(run.item, run.values, true, undefined, ticket);
  }

  /**
   * Bar Replay moved forward (CC-I4): an indicator's run on the chart follows through its engine replay session —
   * only the bars the head moved over are executed — instead of a full run to the new head. False (the caller runs
   * it in full) for a strategy (its tester result is not in a frame), a basis other than the standard bars, a run
   * that is not at an earlier head, or a move the step endpoint does not take; a step that fails also ends in a full
   * run.
   */
  private stepReplayRun(run: ChartScriptRun, ticket: number): boolean {
    const head = this.replayClosedHead();
    const until = run.until ?? null;
    const runBars = run.result.run?.bars ?? [];
    if (
      run.result.kind === 'strategy' ||
      (run.chartType ?? 'standard') !== 'standard' ||
      until === null ||
      !head ||
      head.time <= until ||
      !runBars.length
    )
      return false;
    const bars = this.bars();
    const untilIdx = bars.findIndex((b) => b.time === until);
    const headIdx = this.replay.cursor().index - 1;
    const steps = headIdx - untilIdx;
    // The session's window reaches the last closed bar loaded, so later steps need no new session.
    const now = this.serverClock.now();
    let lastClosed = bars.length - 1;
    while (lastClosed > headIdx && barCloseMs(bars[lastClosed], run.resolution) > now) lastClosed--;
    const lastBars = runBars.length + (lastClosed - untilIdx);
    const signature = JSON.stringify([
      run.item.strategyId ?? run.item.pineSource ?? '',
      run.values,
      run.symbol,
      run.resolution,
    ]);
    if (untilIdx < 0 || lastBars > MAX_SCRIPT_BARS || !this.replayScripts.usable(signature, steps)) return false;
    const request: PineRunRequest = {
      symbol: run.symbol,
      timeframe: runTimeframeFor(run.resolution),
      lastBars,
      mode: 'preview',
      toUtc: new Date(barCloseMs(bars[lastClosed], run.resolution)).toISOString(),
      ...(run.item.strategyId !== undefined ? { strategyId: run.item.strategyId } : { source: run.item.pineSource ?? '' }),
      ...(Object.keys(run.values).length ? { inputs: run.values } : {}),
    };
    const key = run.item.key;
    void this.replayScripts
      .step(
        {
          key,
          signature,
          request,
          startBar: runBars.length - 1,
          firstTime: runBars[0].t,
          fromTime: until,
          toTime: head.time,
          steps,
        },
        run.result,
      )
      .then((result) => {
        if (!this.runScheduler.isCurrent(key, ticket)) {
          this.runScheduler.settle(key, ticket);
          return;
        }
        const held = this.scriptRuns().find((r) => r.item.key === key);
        if (!result || held !== run) {
          // The step failed, or the run changed meanwhile: in full, as before.
          this.runScript(run.item, run.values, true, undefined, ticket);
          return;
        }
        this.scriptRuns.update((list) =>
          list.map((r) => (r === run ? { ...r, result, until: head.time, landedAt: Date.now() } : r)),
        );
        this.runScheduler.settle(key, ticket);
        // The head moved on (or replay ended) while it stepped: once more, to where it is now.
        if (head.time !== this.replayHead()) this.runScheduler.request(key);
      });
    return true;
  }

  /**
   * Run a Pine script/strategy over the loaded window and paint it.
   *
   * <p>An explicit run (no `quiet` ticket: adding a script, "Update on chart", new inputs, a symbol
   * switch, a restored layout, more history) shows on its chip, and supersedes the script's run in
   * flight — that request is aborted, and its result would not be drawn: a slow live re-run of an
   * old source landing after "Update on chart" never puts the old source back.</p>
   *
   * <p>A failure is the script's own (PC-05, PC-13): an explicit run's marks its chip with the error
   * (the line to open the editor at, its library, the call stack); a quiet re-run's marks it stale —
   * the chart keeps the run before it, and says how old it is. "Update on chart" (`update`, PC-06)
   * runs the edited text first and puts it in the edited script's place only once it lands: when it
   * fails, the script on the chart stays as it was and the editor shows why. A busy engine (contract
   * C5, `-429`) is never a failure: a quiet re-run backs off for the wait it asks; an explicit run
   * waits on its chip and is sent again, at most {@link MAX_BUSY_RETRIES} times.</p>
   */
  runScript(
    item: ChartScriptItem,
    values: ScriptInputValues,
    replace = false,
    done?: (r: RunOutcome) => void,
    /** The scheduler's ticket for a quiet re-run: no spinner, and a failure keeps the last plots. */
    quiet?: number,
    /** "Update on chart": the editor's text, and the chart script it replaces once it lands. */
    update?: ScriptUpdate,
  ): void {
    const key = item.key;
    const explicit = quiet === undefined;
    const symbol = this.symbol();
    const resolution = this.resolution();
    // The bars it computes on: the chart's Heikin-Ashi candles, else the standard bars — also on
    // a price-based style, where it is not drawn but ready for the operator's way back (PC-09).
    const basis: ScriptBasis = this.chartBasis() ?? 'standard';
    if (explicit) {
      this.abortRun(key, SUPERSEDED);
      // A new attempt: what failed before is not what this run will say. An edit's failure goes to
      // the editor, so the chip it would update keeps its own state meanwhile.
      if (!update) this.dropFailure(key);
    }
    const ticket = quiet ?? this.runScheduler.begin(key);
    if (explicit) {
      this.runningKeys.update((m) => new Map(m).set(key, ticket));
      if (!this.scriptRuns().some((r) => r.item.key === key))
        this.pendingScripts.update((m) =>
          new Map(m).set(key, { item, values, symbol, resolution }),
        );
      const target = update?.replaces;
      if (target && target !== key) this.scriptUpdates.update((m) => new Map(m).set(target, key));
    }
    // Never less than a full page: a run started while the chart is still loading would
    // otherwise cover only a sliver of history and stop short when the operator pans back.
    const requestedBars = Math.min(Math.max(this.bars().length, PAGE_BARS), MAX_SCRIPT_BARS);
    let over = false;
    let busyRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let request: Subscription | null = null;
    /** The Bar Replay head the request in flight runs to (its open, Unix ms); null: to now. */
    let until: number | null = null;
    /** The run is over: off the spinner and out of flight. Whether its result may be drawn. */
    const finish = (): boolean => {
      over = true;
      clearTimeout(retryTimer);
      if (this.runsInFlight.get(key)?.ticket === ticket) this.runsInFlight.delete(key);
      this.clearRunning(key, ticket);
      this.clearWaiting(key);
      this.clearUpdatesBy(key);
      return this.runScheduler.isCurrent(key, ticket);
    };
    const send = (): void => {
      // In Bar Replay, up to the head (PC-08, PC-I8): the bars opening before its close, so the
      // head is the run's last bar and nothing past it is computed. Else up to now, with the
      // chart's forming bar — only once the bars on screen are this symbol's and timeframe's, on
      // the engine's clock (the session grid's periods open and close at the engine's instants).
      // Both taken again for a retry after a busy refusal: it runs to the head, or on the bar
      // forming, then.
      const head = this.replayActive() ? this.replayClosedHead() : null;
      until = head?.time ?? null;
      const liveBar = head
        ? null
        : formingLiveBar(this.bars(), this.barsFor(), { symbol, resolution }, this.serverClock.now());
      request = this.chartScripts
        .runOnChart(item, symbol, resolution, values, requestedBars, {
          liveBar,
          chartType: basis,
          toMs: head ? barCloseMs(head, resolution) : null,
          // PC-I1: an indicator on the live chart stays warm on the engine, which then streams what changes.
          ...(!head && item.kind !== 'strategy' && basis === 'standard' && this.scriptHub.usable()
            ? { keepWarm: true }
            : {}),
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (result) => {
            const current = finish();
            try {
              // A newer run of this script, or its removal, superseded this one.
              if (!current) {
                done?.({ error: SUPERSEDED });
                return;
              }
              // A run for a symbol the operator has since left is stale (the switch ran it again).
              if (symbol !== this.symbol() || resolution !== this.resolution()) {
                done?.({ error: 'The chart moved to another symbol or timeframe during the run.' });
                return;
              }
              if (result.error) {
                this.runFailed(key, explicit, update, failureOfResult(result, 'error', Date.now()));
                if (update) {
                  // PC-06: the editor marks the diagnostics (a runtime error at its line too).
                  const report = editorReport(result);
                  if (report) this.scriptEditor()?.showCompile(report);
                }
                done?.({ error: result.error });
                return;
              }
              this.landRun(
                item,
                result,
                values,
                { symbol, resolution, requestedBars, basis, until, forming: liveBar !== null },
                replace,
                update,
              );
              done?.(result);
            } finally {
              // After the result is in: a re-run waiting on this one reads the script as it is now.
              this.runScheduler.settle(key, ticket);
            }
          },
          error: (err: unknown) => {
            if (isBusy(err)) {
              const wait = busyWaitMs(err, busyRetries);
              if (!explicit) {
                // C5: a quiet re-run backs off for the wait the engine asked — never an error.
                const current = finish();
                if (current) this.runScheduler.backoff(key, wait);
                this.runScheduler.settle(key, ticket);
                done?.({ error: current ? err.message : SUPERSEDED });
                return;
              }
              if (busyRetries < MAX_BUSY_RETRIES && this.runScheduler.isCurrent(key, ticket)) {
                // An explicit run waits on its chip and goes again: the operator asked for it.
                busyRetries++;
                this.waitingScripts.update((m) => new Map(m).set(key, Date.now() + wait));
                retryTimer = setTimeout(send, wait);
                return;
              }
            }
            const current = finish();
            this.runScheduler.settle(key, ticket);
            const message = err instanceof Error ? err.message : 'run failed';
            done?.({ error: current ? message : SUPERSEDED });
            if (!current) return;
            this.runFailed(key, explicit, update, failureOfError(err, 'error', Date.now()));
            if (update) this.notify.error(`${item.name}: ${message}`);
          },
        });
    };
    send();
    if (!over)
      this.runsInFlight.set(key, {
        ticket,
        sub: {
          unsubscribe: () => {
            clearTimeout(retryTimer);
            request?.unsubscribe();
          },
        },
        done,
      });
  }

  /**
   * A run came back with its result: it goes on the chart — in its own place for a re-run, in the
   * edited script's for "Update on chart" (which leaves the chart then), last for a new script, and
   * in the place of the strategy on the chart for another strategy (one at a time).
   */
  private landRun(
    item: ChartScriptItem,
    result: ChartScriptResult,
    values: ScriptInputValues,
    /** The series, window and bars it ran on, and the Bar Replay head it ran to (null: now). */
    on: {
      symbol: string;
      resolution: TvResolution;
      requestedBars: number;
      basis: ScriptBasis;
      until?: number | null;
      /** The run ended on the chart's forming bar (it was sent as `liveBar`): its last bar is unconfirmed (PC-I9). */
      forming?: boolean;
    },
    replace: boolean,
    update: ScriptUpdate | undefined,
  ): void {
    const { symbol, resolution, requestedBars, basis } = on;
    const until = on.until ?? null;
    const key = item.key;
    // PC-I9: what is on the forming bar shows as unconfirmed, and a closed bar whose value moved since the run on the
    // chart is a repaint. PC-I1: its warm session (if the engine kept one) streams its changes from here on.
    const before = this.scriptRuns().find((r) => r.item.key === key);
    const comparable =
      !!before &&
      !update &&
      before.symbol === symbol &&
      before.resolution === resolution &&
      (before.chartType ?? 'standard') === basis &&
      (before.until ?? null) === until &&
      before.item.pineSource === item.pineSource &&
      JSON.stringify(before.values) === JSON.stringify(values);
    result = this.truthful(key, result, result.session?.lastBarForming ?? on.forming === true, comparable ? 'run' : null);
    this.attachWarm(key, result);
    // The overrides as they apply to the script that ran: one for an input its source no longer
    // declares, or declares with another type, range or options, is dropped — that input runs on
    // its default (the run fell back to that) and leaves the layout.
    const fitting = result.compile ? pruneInputValues(result.inputs, values) : values;
    const runs = this.scriptRuns();
    // How it was shown: its own run's, the edited script's for an edit, a restored layout's.
    const display =
      runs.find((r) => r.item.key === key)?.display ??
      (update?.replaces ? runs.find((r) => r.item.key === update.replaces)?.display : undefined) ??
      this.restoringScripts().find((w) => w.key === key)?.display;
    const entry: ChartScriptRun = {
      item,
      result,
      values: fitting,
      symbol,
      resolution,
      requestedBars,
      landedAt: Date.now(),
      chartType: basis,
      ...(until !== null ? { until } : {}),
      ...(display && Object.keys(display).length ? { display } : {}),
    };
    // Added just now — not a re-run, an edit of a script on the chart, or a restored layout: a
    // script with `confirm = true` inputs asks for them (PC-I12).
    const added =
      !replace &&
      !(update?.replaces ?? null) &&
      !runs.some((r) => r.item.key === key) &&
      !this.restoringScripts().some((w) => w.key === key);
    // One strategy at a time (its tester owns the bottom panel), in place for a re-run.
    const placed = placeRun(runs, entry, update?.replaces ?? null);
    this.scriptRuns.set(placed.runs);
    // A strategy this one replaced is off the chart: its run in flight and its quiet re-runs go
    // with it — one landing late would put it back in place of this one.
    for (const r of placed.replaced) {
      this.abortRun(r.item.key, 'Another strategy took its place on the chart.');
      this.runScheduler.cancel(r.item.key);
      this.dropFailure(r.item.key);
    }
    // An edit took the place of the script it was edited from: that one leaves the chart, and the
    // editor follows its text onto the new one.
    const edited = update?.replaces ?? null;
    if (edited !== null && edited !== key) this.retireScript(edited, key);
    else if (update && edited === null && this.editorKey() === null) this.editorKey.set(key);
    this.restoringScripts.update((l) => l.filter((w) => w.key !== key));
    this.dropPending(key);
    this.dropFailure(key);
    // Bar Replay's head moved, or replay ended, while it ran (PC-08): it runs again to where the
    // chart is now. The head effect judged the run on the chart, not this one in flight, so it
    // may not have asked. A hidden indicator waits until it is shown, as every quiet re-run does.
    if (
      until !== this.replayHead() &&
      this.chartBasis() !== null &&
      (result.kind === 'strategy' || resolveDisplay(entry.display).visible)
    )
      this.runScheduler.request(key);
    // TradingView asks for a script's `confirm = true` inputs as it is added; Cancel takes it off.
    if (added && result.inputs.some((i) => i.confirm)) this.settings.open(key, true);
    if (result.kind === 'strategy') {
      // The defaults its Strategy Tester inputs are measured against (engine strategies).
      this.settings.loadStoredInputs(item);
      if (!replace && edited === null) {
        this.testerOpen.set(true);
        this.frontDock('tester');
        // Added by the operator over another strategy: say so, with the way back.
        const previous = placed.replaced[0];
        if (previous) this.offerUndoReplace(previous, entry);
      }
    }
  }

  // ── PC-I1 warm sessions · PC-I9 realtime truthfulness · PC-I14 alerts on a script ────────────

  /** Each script's warm session on the engine (PC-I1). */
  private readonly warmSessions = new WarmSessionBook();
  /** The scripts their warm session keeps current — the chip's live mark. */
  readonly warmKeys = signal<ReadonlySet<string>>(new Set());
  /** PC-I9: per script, the first repaint seen — its chip says it until the script leaves the chart. */
  readonly scriptRepaints = signal<ReadonlyMap<string, string>>(new Map());
  /** PC-I9: per script, the bar_index of the forming bar of the run on the chart (null: none). */
  private readonly formingByKey = new Map<string, number | null>();
  /** Resyncs in flight, by script. */
  private readonly resyncing = new Set<string>();

  /** Whether `key`'s warm session keeps it current: one is attached and the scripting hub is connected. */
  private warmCovered(key: string): boolean {
    return this.warmSessions.get(key) !== null && this.scriptHub.isConnected();
  }

  /**
   * PC-I9: the run with what sits on its forming bar marked unconfirmed (faded; drawings made there provisional), and —
   * when `compareWith` says the run on the chart is the same script on the same window — a plot that changed its value
   * on a bar that was already closed recorded as a repaint (a full re-run's newest closed bar is left out: it can be a
   * candle the engine replaced with the stored one, not a repaint).
   */
  private truthful(
    key: string,
    result: ChartScriptResult,
    lastBarForming: boolean,
    compareWith: 'run' | 'frame' | null,
  ): ChartScriptResult {
    const outputs = result.run?.outputs;
    if (!result.run || !outputs) {
      this.formingByKey.delete(key);
      return result;
    }
    const forming = formingIndexOf(result, lastBarForming);
    if (compareWith && !this.scriptRepaints().has(key)) {
      const previous = this.scriptRuns().find((r) => r.item.key === key)?.result.run?.outputs ?? null;
      const prevForming = this.formingByKey.get(key) ?? null;
      const prevEnd = previous ? previous.bars.firstIndex + previous.bars.times.length : null;
      const closedBefore = prevForming ?? prevEnd;
      const limit = closedBefore === null ? null : compareWith === 'run' ? closedBefore - 1 : closedBefore;
      const found = detectRepaint(previous, outputs, limit);
      if (found)
        this.scriptRepaints.update((m) =>
          new Map(m).set(key, repaintText(found, (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')),
        );
    }
    this.formingByKey.set(key, forming);
    return forming === null ? result : { ...result, run: { ...result.run, outputs: markUnconfirmed(outputs, forming) } };
  }

  private forgetTruth(key: string): void {
    this.formingByKey.delete(key);
    if (!this.scriptRepaints().has(key)) return;
    this.scriptRepaints.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  /**
   * PC-I1: a run landed — its warm session (if the engine kept one) streams the script's changes from now on, and the
   * session it replaces is let go. A session the hub cannot take is let go at once: the script is re-run per tick as
   * before.
   */
  private attachWarm(key: string, result: ChartScriptResult): void {
    const replaced = this.warmSessions.attach(key, result.session, Date.now());
    if (replaced) this.letGo(replaced.sessionId);
    const now = this.warmSessions.get(key);
    this.setWarmKey(key, now !== null);
    if (!now) return;
    const id = now.sessionId;
    void this.scriptHub.subscribe(id).then((sub) => {
      if (this.warmSessions.get(key)?.sessionId !== id) return;
      if (!sub) {
        this.releaseWarm(key);
        return;
      }
      // Frames went out before the room was joined: catch up.
      if (sub.seq > now.seq) this.resyncWarm(key);
    });
  }

  /** Lets go of `key`'s warm session (the script left, was re-run without one, or its session cannot be followed). */
  private releaseWarm(key: string): void {
    const s = this.warmSessions.detach(key);
    if (s) this.letGo(s.sessionId);
    this.setWarmKey(key, false);
  }

  private letGo(sessionId: string): void {
    void this.scriptHub.unsubscribe(sessionId);
    this.scriptingApi.endSession(sessionId).subscribe();
  }

  private setWarmKey(key: string, warm: boolean): void {
    if (this.warmKeys().has(key) === warm) return;
    this.warmKeys.update((set) => {
      const next = new Set(set);
      if (warm) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** A pushed frame: folded into its script's run, a resync after a gap, or a full re-run when its session ended. */
  private onScriptFrame(frame: ScriptSessionFrame): void {
    const d = this.warmSessions.decide(frame);
    switch (d.kind) {
      case 'apply':
        if (!this.applyWarmFrame(d.key, frame)) this.resyncWarm(d.key);
        return;
      case 'resync':
        this.resyncWarm(d.key);
        return;
      case 'ended':
        this.endWarm(d.key);
        return;
    }
  }

  /** Folds a frame into the run on the chart; false when it cannot (the run is not there or the frame leaves a hole). */
  private applyWarmFrame(key: string, frame: ScriptSessionFrame): boolean {
    const chart = { symbol: this.symbol(), resolution: this.resolution() };
    const run = this.scriptRuns().find((r) => r.item.key === key);
    if (!run || !sameSeries(run, chart)) return false;
    const merged = applyFrame(run.result, frame);
    if (!merged) return false;
    const next = this.truthful(key, merged, frame.lastBarForming, 'frame');
    this.scriptRuns.update((runs) =>
      runs.map((r) => (r.item.key === key ? { ...r, result: next, landedAt: Date.now() } : r)),
    );
    this.warmSessions.applied(key, frame, Date.now());
    return true;
  }

  /**
   * Asks the session for everything since the last frame folded in (`GET scripting/sessions/{id}/frame?sinceSeq=`): after
   * a gap, a reconnect, and once a minute (a quiet market pushes nothing; a session that ended is found this way).
   */
  private resyncWarm(key: string): void {
    const s = this.warmSessions.get(key);
    if (!s || this.resyncing.has(key)) return;
    this.resyncing.add(key);
    const sessionId = s.sessionId;
    this.scriptingApi
      .sessionFrame(sessionId, s.seq)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (frame) => {
          this.resyncing.delete(key);
          if (this.warmSessions.get(key)?.sessionId !== sessionId) return;
          if (frame.reset) {
            this.endWarm(key);
            return;
          }
          if (!this.applyWarmFrame(key, frame)) this.endWarm(key);
        },
        error: (err: unknown) => {
          this.resyncing.delete(key);
          if (this.warmSessions.get(key)?.sessionId !== sessionId) return;
          // Busy (C5): asked again at the next minute; anything else (-14: it ended) runs the script again.
          if (!isBusy(err)) this.endWarm(key);
        },
      });
  }

  /** The warm session ended (or cannot be followed): let it go and run the script again — a new session comes with it. */
  private endWarm(key: string): void {
    this.releaseWarm(key);
    if (this.scriptRuns().some((r) => r.item.key === key)) this.runScheduler.request(key);
  }

  /** "Create alert on <script>" (PC-I14): the alert form for a script on the chart, in a dialog. */
  readonly scriptAlertTarget = signal<ScriptAlertTarget | null>(null);
  private readonly scriptAlertDialog = viewChild<ElementRef<HTMLDialogElement>>('scriptAlertDialog');

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
      alertConditions: (run.result.run?.outputs?.alertConditions ?? []).map((a) => a.title).filter(Boolean),
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
      this.notify.success(`Alert “${saved.displayName}” armed — the engine watches it whether or not this chart is open.`);
  }

  /**
   * A run failed. An edit's failure is the editor's (it shows the diagnostics; the script on the
   * chart stays as it was), and a new script from the editor leaves no chip behind; an explicit
   * run's marks the script's chip; a quiet re-run's marks it stale, unless it already shows an error.
   */
  private runFailed(
    key: string,
    explicit: boolean,
    update: ScriptUpdate | undefined,
    failure: ScriptFailure,
  ): void {
    if (update) {
      if (update.replaces === null || update.replaces !== key) this.dropPending(key);
      return;
    }
    if (explicit) {
      this.setFailure(key, failure);
      return;
    }
    if (this.scriptFailures().get(key)?.kind === 'error') return;
    this.setFailure(key, { ...failure, kind: 'stale' });
  }

  /**
   * The script an edit replaced leaves the chart (PC-06): its run in flight, its re-runs and its
   * state go with it, its Settings close, and the editor showing it moves to the edit.
   */
  private retireScript(oldKey: string, newKey: string): void {
    this.abortRun(oldKey, 'An edit of this script took its place on the chart.');
    this.runScheduler.cancel(oldKey);
    this.restoringScripts.update((l) => l.filter((w) => w.key !== oldKey));
    this.dropPending(oldKey);
    this.dropFailure(oldKey);
    this.clearWaiting(oldKey);
    if (this.settings.run()?.item.key === oldKey) this.settings.close();
    // Its Pine Logs follow it onto the edit, as the editor does.
    if (this.logsKey() === oldKey) this.logsKey.set(newKey);
    if (this.editorKey() === oldKey) {
      this.editorKey.set(newKey);
      const draft = this.editorDraft();
      if (draft?.key === oldKey) this.editorDraft.set({ key: newKey, text: draft.text });
    }
  }

  private setFailure(key: string, failure: ScriptFailure): void {
    this.scriptFailures.update((m) => new Map(m).set(key, failure));
  }

  private dropFailure(key: string): void {
    if (!this.scriptFailures().has(key)) return;
    this.scriptFailures.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  private dropPending(key: string): void {
    if (!this.pendingScripts().has(key)) return;
    this.pendingScripts.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  private clearWaiting(key: string): void {
    if (!this.waitingScripts().has(key)) return;
    this.waitingScripts.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  /** Forget the "Update on chart" `key` is the run of (it ended), and any update OF `key`. */
  private clearUpdatesBy(key: string): void {
    const m = this.scriptUpdates();
    if (![...m].some(([target, run]) => target === key || run === key)) return;
    this.scriptUpdates.set(
      new Map([...m].filter(([target, run]) => target !== key && run !== key)),
    );
  }

  /** Abort the run of `key` in flight, if any; whoever waits on it is told `why`. */
  private abortRun(key: string, why: string): void {
    // Its replay session follows the run on the chart; an explicit run replaces that run.
    this.replayScripts.stop(key);
    const run = this.runsInFlight.get(key);
    if (!run) return;
    this.runsInFlight.delete(key);
    run.sub.unsubscribe();
    this.clearRunning(key, run.ticket);
    this.clearWaiting(key);
    this.clearUpdatesBy(key);
    run.done?.({ error: why });
  }

  /** Abort every run in flight and forget every script's sequence (a layout is being replaced). */
  private abortAllRuns(why: string): void {
    for (const key of [...this.runsInFlight.keys()]) this.abortRun(key, why);
    this.runScheduler.cancelAll();
    for (const s of this.warmSessions.all()) this.releaseWarm(s.key);
    this.runningKeys.set(new Map());
    this.waitingScripts.set(new Map());
    this.scriptUpdates.set(new Map());
    this.pendingScripts.set(new Map());
    this.scriptFailures.set(new Map());
  }

  private clearRunning(key: string, ticket: number): void {
    if (this.runningKeys().get(key) !== ticket) return;
    this.runningKeys.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
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

  /** A time input's value on the studies bar: the picked bar (UTC), or what to do. */
  studyTimeLabel(v: number | string | undefined): string {
    const ms = Number(v);
    return Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : 'Pick on chart';
  }

  /** The Source dropdown's choices for a study (DR-16 / DR-I5). */
  sourceGroupsFor(item: ActiveIndicator): SourceGroup[] {
    return sourceGroups(item, this.active(), (s) => {
      const def = indicatorById(s.defId);
      return def ? { label: indicatorLabel(def, s.params), plots: def.plots } : null;
    });
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

  /** A candlestick- or chart-pattern study (its row offers the scorecard, DR-I8). */
  isPatternStudy(item: ActiveIndicator): boolean {
    const k = studyKind(item.defId);
    return k === 'candle-pattern' || k === 'chart-pattern';
  }

  inputsFor(item: ActiveIndicator) {
    return studyMeta(item.defId)?.inputs ?? [];
  }

  onLegend(snapshot: LegendSnapshot): void {
    this.legend.set(snapshot);
  }

  /** The legend's change from the previous close: "−0.00002 / −0.2 pip (−0.00%)" (CC-18). */
  readonly legendChange = computed(() => {
    const l = this.legend();
    return l ? changeText(l.change ?? null, l.changePct, this.pipSize(), this.precision()) : null;
  });
  readonly legendVolume = computed(() => {
    const v = this.legend()?.volume;
    return v === null || v === undefined ? null : formatVolume(v);
  });

  /** The data window's sections at the crosshair (CC-I6), from the chart's value providers. */
  readonly dataWindowSections = computed(() => this.host()?.dataWindow() ?? []);

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

  /** The split panels' chart hosts, in panel order. */
  private readonly panelHosts = viewChildren<ChartHostComponent>('panelHost');

  /**
   * Scroll-back on a split panel (CC-12: panels held their first 1,500 bars and never loaded more):
   * the page before its oldest bar, prepended; an empty page is the start of its history.
   */
  async loadPanelOlder(id: string): Promise<void> {
    const index = this.comparePanels().findIndex((p) => p.id === id);
    const panel = this.comparePanels()[index];
    const host = () => this.panelHosts()[index];
    if (!panel?.bars.length || panel.historyComplete) {
      host()?.historyLoaded();
      return;
    }
    const oldest = panel.bars[0].time;
    try {
      const { bars } = await this.feed.getBars(
        panel.symbol,
        panel.resolution,
        0,
        oldest - 1,
        PAGE_BARS,
      );
      const older = bars.filter((b) => b.time < oldest);
      this.comparePanels.update((list) =>
        list.map((p) => {
          // A panel switched meanwhile has bars of its own.
          if (p.id !== id || p.symbol !== panel.symbol || p.resolution !== panel.resolution)
            return p;
          return older.length
            ? { ...p, bars: [...older, ...p.bars.filter((b) => b.time >= oldest)] }
            : { ...p, historyComplete: true };
        }),
      );
    } catch {
      // Unreachable: the panel keeps what it has, and the next scroll to the edge asks again.
    } finally {
      host()?.historyLoaded();
    }
  }

  /** Each split panel's legend: the bar under its crosshair (CC-12). */
  readonly panelLegends = signal<Record<string, LegendSnapshot>>({});
  onPanelLegend(id: string, snapshot: LegendSnapshot): void {
    this.panelLegends.update((all) => ({ ...all, [id]: snapshot }));
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

  /**
   * The split layout as a layout saves it (CC-12: it was not saved): the arrangement and each
   * panel's symbol and timeframe — not their bars, which move with every tick.
   */
  private readonly splitState = computed(
    () => ({
      layout: this.splitLayout(),
      panels: this.comparePanels().map((p) => ({ symbol: p.symbol, resolution: p.resolution })),
    }),
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  /** A layout's split view, restored: the arrangement, then each panel's series, loaded. */
  private restoreSplit(split: ChartWorkspaceState['split']): void {
    const layout = this.splitLayouts.find((l) => l.id === split?.layout)?.id ?? '1';
    const wanted = this.splitLayouts.find((l) => l.id === layout)?.panels ?? 0;
    const saved: ComparePanel[] = (split?.panels ?? []).slice(0, wanted).map((p, i) => ({
      id: `p${Date.now().toString(36)}${i}`,
      symbol: p.symbol.toUpperCase(),
      resolution: isSupportedResolution(p.resolution)
        ? (p.resolution as TvResolution)
        : this.resolution(),
      bars: [],
    }));
    this.comparePanels.set(saved);
    // The arrangement; a layout saved with fewer panels than it shows gets the rest as new ones.
    this.setSplitLayout(layout);
    for (const panel of saved) void this.loadPanel(panel.id);
  }

  /** The whole chart set-up, as the engine saves it (`ChartLayout.state`). */
  captureState(): ChartWorkspaceState {
    return {
      v: 1,
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
      overlays: {
        showPositions: this.showPositions(),
        showOrders: this.showOrders(),
        showOverlays: this.showOverlays(),
        showVolumeProfile: this.showVolumeProfile(),
        volumeProfileMode: this.volumeProfileMode(),
        showSupportResistance: this.showSupportResistance(),
        showStructure: this.showStructure(),
        showEvents: this.showEvents(),
        minEventImpact: this.minEventImpact(),
        showBlackout: this.showBlackout(),
        showClosedTrades: this.showClosedTrades(),
        fitTradeLines: this.fitTradeLines(),
      },
      split: this.splitState(),
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
        this.assistSource.set({ text: d.editorText, seq: ++this.assistSeq });
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

  // ── One undo history (CC-I11) ────────────────────────────────────────────

  readonly undoHistory = new UndoHistory();
  /** What undo covers of the chart as it stands (studies, scripts, settings), changing only when that changes. */
  private readonly undoableState = computed(() => undoableOf(this.captureState()), { equal: sameUndoable });
  /** The chart as the last recorded step left it. */
  private undoBaseline: UndoableChart | null = null;
  /** The chart before a burst of changes still settling; recorded as one step when it settles. */
  private undoPending: UndoableChart | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while an undo / redo puts the chart back: that is not a new step. */
  private undoing = false;

  /** A step of the history applies to the chart on screen: chart steps always, drawing steps of this symbol. */
  private readonly undoApplies = (e: UndoEntry): boolean =>
    e.kind === 'chart' || e.symbol === this.symbol();

  readonly undoTitle = computed(() => {
    this.undoHistory.revision();
    const e = this.undoHistory.peekUndo(this.undoApplies);
    return e ? `Undo ${this.undoEntryLabel(e)} (⌘Z)` : 'Nothing to undo';
  });
  readonly redoTitle = computed(() => {
    this.undoHistory.revision();
    const e = this.undoHistory.peekRedo(this.undoApplies);
    return e ? `Redo ${this.undoEntryLabel(e)} (⇧⌘Z)` : 'Nothing to redo';
  });
  readonly canUndo = computed(() => {
    this.undoHistory.revision();
    this.drawings.canUndo();
    return this.undoHistory.peekUndo(this.undoApplies) !== null;
  });
  readonly canRedo = computed(() => {
    this.undoHistory.revision();
    this.drawings.canRedo();
    return this.undoHistory.peekRedo(this.undoApplies) !== null;
  });

  private undoEntryLabel(e: UndoEntry): string {
    return e.kind === 'drawing' ? 'drawing' : e.label;
  }

  /** The undoable chart changed: a new step once the burst settles (not while a layout or an undo is applied). */
  private noteUndoable(now: UndoableChart): void {
    if (!this.restored || this.applyingState || this.undoing) {
      if (!this.undoPending) this.undoBaseline = now;
      return;
    }
    if (!this.undoBaseline) {
      this.undoBaseline = now;
      return;
    }
    if (sameUndoable(now, this.undoBaseline)) return;
    this.undoPending ??= this.undoBaseline;
    this.undoBaseline = now;
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.commitUndoStep(), 500);
  }

  private commitUndoStep(): void {
    clearTimeout(this.undoTimer);
    const before = this.undoPending;
    const after = this.undoBaseline;
    this.undoPending = null;
    if (!before || !after || sameUndoable(before, after)) return;
    this.undoHistory.record({
      kind: 'chart',
      before,
      after,
      label: describeChange(before, after, (i) => this.labelFor(i)),
    });
  }

  /** Ctrl+Z, the toolbar and the context menu: the newest step that applies to this chart goes back. */
  undo(): void {
    this.commitUndoStep();
    const e = this.undoHistory.undo(this.undoApplies);
    if (!e) return;
    if (e.kind === 'drawing') this.drawings.undo();
    else this.restoreUndoable(e.before);
  }

  redo(): void {
    this.commitUndoStep();
    const e = this.undoHistory.redo(this.undoApplies);
    if (!e) return;
    if (e.kind === 'drawing') this.drawings.redo();
    else this.restoreUndoable(e.after);
  }

  /**
   * Put the chart's studies, scripts and settings back as `u` held them. Scripts that left come back (run again
   * with their inputs), scripts that came go, scripts whose inputs changed run again with the old ones; a change of
   * display only is applied in place.
   */
  private restoreUndoable(u: UndoableChart): void {
    this.undoing = true;
    try {
      this.applyChartSettings(u.settings);
      this.active.set(u.indicators.map((i) => ({ ...i, params: { ...i.params } })));
      const target = new Map(u.scripts.map((w) => [w.key, w]));
      for (const w of this.workspaceScripts()) if (!target.has(w.key)) this.removeScriptFromChart(w.key);
      for (const w of u.scripts) {
        const run = this.scriptRuns().find((r) => r.item.key === w.key);
        if (run && JSON.stringify(run.values) === JSON.stringify(w.values)) {
          if (JSON.stringify(run.display ?? {}) !== JSON.stringify(w.display ?? {}))
            this.scriptRuns.update((list) =>
              list.map((r) => (r === run ? { ...r, display: w.display ? { ...w.display } : undefined } : r)),
            );
          continue;
        }
        if (!run) this.restoringScripts.update((l) => [...l.filter((x) => x.key !== w.key), w]);
        this.runScript(
          run?.item ?? restoredScriptItem(w, this.chartScripts.savedScripts()),
          { ...w.values },
          true,
        );
      }
    } finally {
      queueMicrotask(() => {
        this.undoBaseline = this.undoableState();
        this.undoing = false;
      });
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

  /**
   * Apply a saved workspace. Missing fields fall back to the chart's defaults, so a new layout
   * (`{ v: 1 }`) opens a clean chart. `keepSymbol` lets a deep link's symbol/timeframe win.
   */
  applyState(st: ChartWorkspaceState | null, keepSymbol = false): void {
    const s = st ?? { v: 1 as const };
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
      this.restoreSplit(s.split);

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
        clearTimeout(this.undoTimer);
        this.undoPending = null;
        this.undoBaseline = this.undoableState();
        this.undoHistory.clearChart();
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
    this.timezone.set(s.timezone ?? 'UTC');
    const pb = restoredPriceBased(s.priceBased);
    this.boxMethod.set(pb.boxMethod);
    this.boxSizeAtr.set(pb.boxSizeAtr);
    this.boxPips.set(pb.boxPips);
    this.renkoWicks.set(pb.renkoWicks);
    this.lineBreakLines.set(pb.lineBreakLines);
    this.pnfReversal.set(pb.pnfReversal);
    const o = s.overlays ?? {};
    // Layouts saved before the split had one "Trades & signals" switch: it drove all three.
    this.showPositions.set(o.showPositions ?? o.showOverlays ?? false);
    this.showOrders.set(o.showOrders ?? o.showOverlays ?? false);
    this.showOverlays.set(o.showOverlays ?? false);
    this.showVolumeProfile.set(o.showVolumeProfile ?? false);
    if (o.volumeProfileMode) this.volumeProfileMode.set(o.volumeProfileMode as VolumeProfileMode);
    this.showSupportResistance.set(o.showSupportResistance ?? false);
    this.showStructure.set(o.showStructure ?? false);
    this.showEvents.set(o.showEvents ?? true);
    this.minEventImpact.set(o.minEventImpact ?? 'Medium');
    this.showBlackout.set(o.showBlackout ?? true);
    this.showClosedTrades.set(o.showClosedTrades ?? false);
    this.fitTradeLines.set(o.fitTradeLines ?? true);
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

  // ── Layout menu (server-backed) ──────────────────────────────────────────

  async newLayout(): Promise<void> {
    this.layoutMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'New layout',
      label: 'Layout name',
      value: 'Unnamed',
      confirmLabel: 'Create',
    });
    if (name !== null) void this.workspace.newLayout(name);
  }

  async renameLayout(): Promise<void> {
    this.layoutMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'Rename layout',
      label: 'Layout name',
      value: this.workspace.active().name,
      confirmLabel: 'Rename',
    });
    if (name !== null) void this.workspace.rename(name);
  }

  async duplicateLayout(): Promise<void> {
    this.layoutMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'Copy layout',
      message: 'The copy keeps this layout’s symbol, studies, scripts and drawings settings.',
      label: 'Name of the copy',
      value: `${this.workspace.active().name} copy`,
      confirmLabel: 'Copy',
    });
    if (name !== null) void this.workspace.duplicate(name);
  }

  switchLayout(id: number): void {
    this.layoutMenuOpen.set(false);
    void this.workspace.switchTo(id);
  }

  removeLayout(id: number, ev: Event): void {
    ev.stopPropagation();
    const l = this.workspace.layouts().find((x) => x.id === id);
    void confirmDelete(this.dialogs, `layout “${l?.name ?? id}”`).then((yes) => {
      if (yes) void this.workspace.remove(id);
    });
  }

  async saveTemplate(): Promise<void> {
    if (this.active().length === 0) return;
    this.layoutMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'Save indicator template',
      message: 'The studies on this chart, with their inputs and styles.',
      label: 'Template name',
      value: 'My studies',
      confirmLabel: 'Save',
    });
    if (name !== null) this.layoutStore.saveTemplate(name, this.active());
  }

  applyTemplate(template: StudyTemplate): void {
    this.layoutMenuOpen.set(false);
    this.active.set(this.layoutStore.instantiate(template));
  }

  removeTemplate(id: string, ev: Event): void {
    ev.stopPropagation();
    this.layoutStore.removeTemplate(id);
  }

  /** The snapshot's title: symbol, timeframe and style, as the chart's title reads. */
  private snapshotTitle(): string {
    return `${this.symbol()} · ${this.resolutionLabel(this.resolution())} · ${this.styleLabel()}`;
  }

  private exportName(ext: string): string {
    return `${this.symbol()}-${this.resolutionLabel(this.resolution())}-${new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, '')}.${ext}`;
  }

  /**
   * Download the chart as a PNG — the chart with its legend, the scripts' tables and a title
   * (CC-22). Says when it could not: the assistant's chart.snapshot reported success with no image.
   */
  takeSnapshot(): { ok: boolean; message: string } {
    this.contextMenu.set(null);
    const canvas = this.host()?.snapshotCanvas(this.snapshotTitle());
    let data: string | null = null;
    try {
      data = canvas ? canvas.toDataURL('image/png') : null;
    } catch {
      data = null;
    }
    if (!data || data === 'data:,') {
      const message =
        'The chart could not be captured: it is not drawn yet, or the browser refused.';
      this.notify.error(message);
      return { ok: false, message };
    }
    const name = this.exportName('png');
    const a = document.createElement('a');
    a.href = data;
    a.download = name;
    a.click();
    return { ok: true, message: `Snapshot saved as ${name}.` };
  }

  /** Copy the snapshot to the clipboard as an image (CC-I7), where the browser allows it. */
  async copySnapshot(): Promise<void> {
    this.contextMenu.set(null);
    const canvas = this.host()?.snapshotCanvas(this.snapshotTitle());
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!canvas) {
      this.notify.error('The chart could not be captured: it is not drawn yet.');
      return;
    }
    if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
      this.notify.error('This browser does not allow copying images; use Save image instead.');
      return;
    }
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no image');
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.notify.success('Chart image copied to the clipboard.');
    } catch {
      this.notify.error('The image could not be copied to the clipboard.');
    }
  }

  /**
   * Download the chart's data as CSV (CC-I7): each bar's UTC time, prices and volume, and every
   * value the data window lists for it — studies, and scripts' plots when they provide them.
   */
  exportChartData(): void {
    this.contextMenu.set(null);
    const rows = this.host()?.exportRows() ?? [];
    if (rows.length < 2) {
      this.notify.error('There are no bars to export yet.');
      return;
    }
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.exportName('csv');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
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

  // ── Chart alerts (alerts v2) ─────────────────────────────────────────────
  //
  // ChartAlert rows evaluated by the engine on every tick (a CROSSING of the price on the alert's side, bid by
  // default), not the old polled PriceLevel rule that compared the mid price every 30 s and fired at once when set at
  // the last close (SP-02/SP-03).

  /**
   * Add an alert at the right-clicked price: opens the alert form at that level. The operator still sees the direction
   * (pre-set to the way price must travel to reach it), the side and the rest before anything is armed.
   */
  createAlertHere(): void {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    const price = menu?.price;
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return;
    this.alertPreset.set(price);
    this.alertDraft.set(null);
    this.openMenu.set('alert');
  }

  /** The form saved an alert. */
  onAlertSaved(): void {
    this.openMenu.set(null);
    const drawing = this.alertDraft() !== null;
    this.alertDraft.set(null);
    this.notify.success(
      drawing
        ? 'Alert set — it fires when price crosses the drawing.'
        : 'Alert set — it fires when price crosses the level.',
    );
  }

  /** The alert manager (right rail) and the alert a bell link asked to show. */
  readonly alertManagerOpen = signal(false);
  readonly alertFocusId = signal<number | null>(null);

  toggleAlertManager(): void {
    if (this.alertManagerOpen()) this.closeAlertManager();
    else this.alertManagerOpen.set(true);
  }

  closeAlertManager(): void {
    this.alertManagerOpen.set(false);
    this.alertFocusId.set(null);
    this.scriptAlertFocusId.set(null);
  }

  /** The alert on a chart script a bell link asked to show (`?scriptAlert=12`, SS-I1). */
  readonly scriptAlertFocusId = signal<number | null>(null);
  private readonly scriptAlertQuery = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('scriptAlert'))),
    { initialValue: null },
  );
  private readonly followScriptAlertQuery = effect(() => {
    const id = Number(this.scriptAlertQuery());
    if (!Number.isFinite(id) || id <= 0) return;
    untracked(() => {
      this.scriptAlertFocusId.set(id);
      this.alertManagerOpen.set(true);
    });
  });

  /** `?alert=12` (the bell's link to a fired chart alert): open the manager on it. */
  private readonly alertQuery = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('alert'))),
    {
      initialValue: null,
    },
  );
  private readonly followAlertQuery = effect(() => {
    const id = Number(this.alertQuery());
    if (!Number.isFinite(id) || id <= 0) return;
    untracked(() => {
      this.alertFocusId.set(id);
      this.alertManagerOpen.set(true);
    });
  });

  /** The price alerts of this symbol as dashed lines; dragging one asks before moving the alert. */
  private readonly alertLines = new AlertLinesPrimitive(
    () => this.precision(),
    (move) => this.askMoveAlert(move),
  );
  private readonly attachAlertLines = effect((onCleanup) => {
    const host = this.host();
    if (!host) return;
    untracked(() => this.chartAlerts.ensureLoaded());
    onCleanup(host.attachPricePrimitive(this.alertLines));
  });
  private readonly drawAlertLines = effect(() =>
    this.alertLines.setLines(
      alertLinesFor(this.chartAlerts.alerts(), this.symbol(), this.precision()),
    ),
  );

  readonly pendingAlertMove = signal<{
    alertId: number;
    label: string;
    from: number;
    to: number;
    move: AlertLineMove;
  } | null>(null);
  private readonly alertMoveDialog = viewChild<ElementRef<HTMLDialogElement>>('alertMoveDialog');

  private askMoveAlert(move: AlertLineMove): void {
    const alert = this.chartAlerts.alerts().find((a) => a.id === move.line.alertId);
    if (!alert) return;
    if (!movedBounds(alert, move.line.bound, move.price)) {
      this.notify.warning('The upper level of a channel must stay above its lower level.');
      return;
    }
    this.pendingAlertMove.set({
      alertId: alert.id,
      label: alert.name || alert.symbol,
      from: move.line.price,
      to: move.price,
      move,
    });
    this.alertMoveDialog()?.nativeElement.showModal();
  }

  confirmAlertMove(): void {
    const pending = this.pendingAlertMove();
    this.alertMoveDialog()?.nativeElement.close();
    const alert = pending ? this.chartAlerts.alerts().find((a) => a.id === pending.alertId) : null;
    if (!pending || !alert) return;
    const bounds = movedBounds(alert, pending.move.line.bound, pending.to);
    if (!bounds) return;
    this.chartAlerts
      .update(alert.id, { ...inputOf(alert), price: bounds.price, upperPrice: bounds.upperPrice })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          res?.status
            ? this.notify.success('Alert moved.')
            : this.notify.error(res?.message || 'The alert could not be moved.'),
        error: () => this.notify.error('The alert could not be moved — the engine did not answer.'),
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
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.redo();
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
        else if (action === 'log') this.scaleMode.set(this.scaleMode() === 'log' ? 'normal' : 'log');
        else if (action === 'percent')
          this.scaleMode.set(this.scaleMode() === 'percent' ? 'normal' : 'percent');
        else this.takeSnapshot();
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
        ev.key === 'ArrowRight' ? () => void this.replay.step(1)
        : ev.key === 'ArrowLeft' ? () => void this.replay.step(-1)
        : ev.key === 'ArrowDown' ? () => this.replay.togglePlay()
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

let prefsRef: ChartPrefsService | null = null;
function writePref(key: string, value: unknown): void {
  // Synced across machines (engine `chart/preferences`); the cache is localStorage.
  if (prefsRef) prefsRef.setItem(`lascodia.chart.pref.${key}`, JSON.stringify(value));
  else
    try {
      localStorage.setItem(`lascodia.chart.pref.${key}`, JSON.stringify(value));
    } catch {
      /* preference not remembered */
    }
}

/**
 * A view state as layouts save it: whole bars of scroll and whole pixels, so sub-pixel jitter and
 * fractional scroll positions never register as a change.
 */
export function normaliseView(v: ChartViewState): ChartViewState {
  return {
    barSpacing: Math.round(v.barSpacing * 100) / 100,
    rightOffset: Math.round(v.rightOffset),
    paneHeights: v.paneHeights.map((h) => Math.round(h)),
  };
}
