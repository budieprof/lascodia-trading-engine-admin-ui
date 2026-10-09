import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  NgZone,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  OnDestroy,
} from '@angular/core';
import { ServerClock } from '@core/time/server-clock';
import { BarCountdownPrimitive, axisLabelHeight } from './bar-countdown-primitive';
import { countdownText } from './bar-countdown';
import { labelTextColor, lastValueLabelColor, opaqueOver } from './axis-label-color';
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  MismatchDirection,
  PriceScaleMode,
  createChartEx,
  createSeriesMarkers,
  type CandlestickData,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  type MouseEventParams,
  type SeriesMarker,
  type TickMarkType,
  type Time,
} from 'lightweight-charts';
import {
  TradingDateTimeScale,
  formatTradingDate,
  labelsByTradingDate,
  tradingDateOf,
  tradingDateTick,
  tradingDatesByPlottedTime,
} from './trading-date';
import { ThemeService } from '@core/theme/theme.service';
import type { Bar } from '../datafeed/candle-feed.service';
import { TradingCalendar, tradingMsBetween, type SessionSpec } from '../datafeed/session-calendar';
import {
  indicatorById,
  indicatorLabel,
  type IndicatorDef,
  type PlotSpec,
} from '../indicators/registry';
import type { DayOf, Maybe, Ohlc } from '../indicators/math';
import { HiLoSeries, HlcAreaSeries, VolCandleSeries } from './custom-series';
import {
  boxUnit,
  toKagi,
  toRangeBars,
  toLineBreak,
  toPointAndFigure,
  toRenko,
} from './price-transforms';
import {
  asTime,
  barPaint,
  firstChangedValue,
  ohlcOf,
  ohlcRows,
  ohlcvRows,
  plottedSeconds,
  priceRowsFrom,
  samePriceRow,
  valueRowsFrom,
  volumeRowsFrom,
  type GapPolicy,
  type PriceRow,
  type RowPalette,
  type ValueRow,
  type VolumeRow,
} from './chart-rows';
import {
  PlottedBars,
  barContaining,
  indexAtTime,
  type PlotTransform,
  type PlotUpdate,
} from './plotted-bars';
import { SeriesSync, sameValueRow, type SyncTarget } from './series-sync';
import { xAtLogical } from './time-x';
import { resolutionMs } from '../datafeed/resolution';
import { pipSizeFor } from '../datafeed/symbol-info';
import { DrawingStore } from '../drawings/drawing-store.service';
import { DrawingController } from '../drawings/drawing-controller';
import type { MagnetMode } from '../drawings/drawing-ops';
import type { Drawing, DrawingKind } from '../drawings/model';
import { OverlayRenderer, type PriceOverlay } from '../overlays/overlay-renderer';
import { AnalysisOverlayRenderer } from '../overlays/analysis-overlay-renderer';
import {
  periodProfiles,
  profileWithValueArea,
  type VolumeProfileMode,
  supportResistance,
  type SrLevel,
} from '../overlays/analysis-overlays';
import { marketStructure } from '../overlays/market-structure';
import { timezoneOffsetMinutes } from '../workspace/layout-store.service';
import { EventMarksRenderer, type EventMark } from '../overlays/event-marks-renderer';
import { eventCard, formatEventTime, type EventCard } from '../overlays/chart-events';
import { SessionBreaksRenderer, sessionBreakIndexes, utcDay } from '../overlays/session-breaks';
import { changeText, formatStudyValue, formatVolume } from './legend-format';
import { paintLegend, paintTable, placeTable, type LegendRun } from './snapshot';
import { ValueProviders, type DataWindowSection, type ValueProvider } from './value-providers';
import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import { ProfileRenderer } from '../profiles/profile-renderer';
import { computeProfileStudy } from '../profiles/profile-studies';
import { PatternRenderer } from '../patterns/pattern-renderer';
import {
  detectCandlestickPatterns,
  type CandleTrendFilter,
} from '../patterns/candlestick-patterns';
import { detectChartPatterns } from '../patterns/chart-patterns';
import { ScriptLayers, type ChartScriptLayer } from '../scripts/script-layers';
import { scriptRenderModel } from '../scripts/script-model-cache';
import {
  placeTooltip,
  topHit,
  type ScriptHit,
  type ScriptTooltip,
} from '../scripts/script-hover';
import {
  DEFAULT_RIGHT_OFFSET,
  marginCap,
  marginMovesView,
  mergeBarColors,
  restoredRightOffset,
  sameBarColors,
  savedRightOffset,
  scriptRightOffset,
} from '../scripts/run-on-host';
import { PineTableOverlayComponent } from '@shared/pine-chart/components/pine-table-overlay.component';
import type { TableLayout } from '@shared/pine-chart/render/render-model';
import { alignToBars, type PanePoint } from '../panels/fx-fundamentals';
import { ALL_PATTERNS, profileIdOf, studyKind, studySubId } from '../studies';

/**
 * Chart styles the toolbar can switch between — the 18 of TradingView's
 * `ChartStyle` enum that apply to this data.
 *
 * The last four are price-based rather than time-based: they rebuild the bar
 * array (see `price-transforms.ts`) instead of re-skinning it.
 */
export type ChartStyle =
  | 'candles'
  | 'hollow'
  | 'bars'
  | 'line'
  | 'area'
  | 'baseline'
  | 'heikin-ashi'
  | 'hlc-bars'
  | 'hilo'
  | 'vol-candle'
  | 'column'
  | 'line-markers'
  | 'stepline'
  | 'hlc-area'
  | 'renko'
  | 'kagi'
  | 'pnf'
  | 'line-break'
  | 'range';

/** The price scale's modes (TradingView's Regular, Logarithmic, Percent, Indexed to 100). */
export type ScaleMode = 'normal' | 'log' | 'percent' | 'indexed';

/** Styles whose bars are built from price movement, not time. */
/** Styles whose last-value label is the line colour rather than the bar's up/down colour. */
const LINE_LIKE: ReadonlySet<ChartStyle> = new Set<ChartStyle>([
  'line',
  'area',
  'baseline',
  'stepline',
  'line-markers',
  'hlc-area',
  'column',
]);

const PRICE_BASED: ReadonlySet<ChartStyle> = new Set<ChartStyle>([
  'renko',
  'kagi',
  'pnf',
  'line-break',
  'range',
]);

/**
 * Styles a script's `barcolor()` recolours: those drawn from each time bar's own OHLC (Heikin-Ashi
 * recomputes them one for one). Lines, areas and columns show no bar to colour, and the
 * price-based styles' bricks are not the script's bars.
 */
const BAR_COLOR_STYLES: ReadonlySet<ChartStyle> = new Set<ChartStyle>([
  'candles',
  'hollow',
  'heikin-ashi',
  'bars',
  'hlc-bars',
  'hilo',
  'vol-candle',
]);

/**
 * The price series. Includes 'Histogram' because the Column style plots the close as bars on the
 * price scale — it is a price series here, not the volume overlay.
 */
type PriceSeries = ISeriesApi<
  'Candlestick' | 'Bar' | 'Line' | 'Area' | 'Baseline' | 'Histogram' | 'Custom'
>;

/** A pane of externally fetched series (FX fundamentals). */
export interface ExternalPane {
  uid: string;
  lines: { title: string; color: string; points: PanePoint[]; precision?: number }[];
}

/** An indicator the operator has added to this chart. */
/** Zoom, scroll and pane heights of a chart, as layouts save them. */
export interface ChartViewState {
  barSpacing: number;
  /** Bars from the realtime edge (negative = scrolled back). */
  rightOffset: number;
  /** Height of each pane in px, main pane first. */
  paneHeights: number[];
}

export interface ActiveIndicator {
  /** Instance id — an indicator can be added more than once with different inputs. */
  uid: string;
  defId: string;
  params: Record<string, number | string>;
  visible: boolean;
}

/** What the legend shows for the bar under the crosshair. */
export interface LegendSnapshot {
  time: number | null;
  /**
   * The bar's trading date as the chart prints it on 1D/1W/1M ("Tue 6 Oct 2026"); null where its
   * `time` prints as a clock time.
   */
  dateLabel?: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** Close minus the previous bar's close (null on the first bar). */
  change?: number | null;
  changePct: number | null;
  indicators: Array<{
    uid: string;
    label: string;
    values: Array<{ title: string; value: number | null; color: string }>;
  }>;
}

export type {
  DataWindowContext,
  DataWindowRow,
  DataWindowSection,
  ValueProvider,
} from './value-providers';

/** One plot of a study on the chart, and what was last written to it. */
interface IndicatorPlotSeries {
  key: string;
  api: ISeriesApi<'Line' | 'Histogram'>;
  color: string;
  title: string;
  gaps: GapPolicy;
  /** A `markers` plot: its shapes, through the markers plugin on its (invisible) series. */
  markers: {
    api: ISeriesMarkersPluginApi<Time>;
    spec: NonNullable<PlotSpec['marker']>;
    last: string;
  } | null;
  sync: SeriesSync<ValueRow>;
  /** The values its rows were built from. */
  values: Maybe[];
}

/** A study's series on the chart (CC-I1: kept across ticks; only their tails are written). */
interface IndicatorSeries {
  uid: string;
  /** The inputs the series show; other inputs recompute every value. */
  paramsKey: string;
  /** Drawn on the price pane, on its scale (takes the symbol's precision). */
  overlay: boolean;
  series: IndicatorPlotSeries[];
}

/** An external pane's line on the chart, kept across ticks (CC-02). */
interface ExternalLineSeries {
  api: ISeriesApi<'Line'>;
  sync: SeriesSync<ValueRow>;
  /** The points it was sampled from; new points re-sample every bar. */
  points: readonly PanePoint[];
  values: Maybe[];
}

/**
 * The chart surface: Lightweight Charts v5 wrapped for Angular.
 *
 * Owns the chart instance, the price and volume series, and one pane per
 * pane-target indicator. Deliberately dumb about *where bars come from* — it
 * takes `bars` as an input and raises `loadMore` when the operator scrolls past
 * the start of what it holds — so the page can own fetching, caching and live
 * updates without this component knowing about HTTP or SignalR.
 */
@Component({
  selector: 'app-chart-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PineTableOverlayComponent],
  template: `<div class="chart-host" #container></div>
    @for (o of scriptTables(); track o.key) {
      <div
        class="script-tables"
        [style.top.px]="o.top"
        [style.left.px]="o.left"
        [style.width.px]="o.width"
        [style.height.px]="o.height"
      >
        <app-pine-table-overlay [tables]="o.tables" [paneWidth]="o.width" [paneHeight]="o.height" />
      </div>
    }
    @if (scriptTip(); as t) {
      <div
        class="script-tip"
        role="tooltip"
        data-testid="script-tooltip"
        [class.flip-x]="t.flipX"
        [class.flip-y]="t.flipY"
        [style.left.px]="t.left"
        [style.top.px]="t.top"
      >
        {{ t.text }}
      </div>
    }
    @if (inlineEdit(); as ie) {
      <textarea
        class="inline-edit"
        [style.left.px]="ie.rect.x"
        [style.top.px]="ie.rect.y"
        [style.width.px]="ie.rect.w"
        [style.height.px]="ie.rect.h"
        [value]="ie.value"
        (keydown)="onInlineKey($event)"
        (blur)="commitInline($any($event.target).value)"
        aria-label="Edit text"
        autofocus
      ></textarea>
    }
    @if (holdTip(); as tip) {
      <div
        class="hold-tip"
        [style.left.px]="tip.x"
        [style.top.px]="tip.y"
        role="tooltip"
        aria-live="polite"
      >
        <div class="row date">{{ tip.date }}</div>
        @for (r of tip.rows; track r.label) {
          <div class="row">
            <span>{{ r.label }}</span
            ><b [style.color]="r.color">{{ r.value }}</b>
          </div>
        }
      </div>
    }
    @if (eventTip(); as tip) {
      <div
        class="hold-tip event-tip"
        [style.left.px]="tip.x"
        [style.top.px]="tip.y"
        role="tooltip"
        aria-live="polite"
        data-testid="event-tip"
      >
        <div class="event-head">
          <span class="event-ccy" [class]="'event-' + tip.card.impact.toLowerCase()">{{
            tip.card.currency
          }}</span>
          <b>{{ tip.card.title }}</b>
        </div>
        <div class="row date">{{ tip.card.when }} · {{ tip.card.impact }} impact</div>
        @for (r of tip.card.rows; track r.label) {
          <div class="row">
            <span>{{ r.label }}</span
            ><b>{{ r.value }}</b>
          </div>
        }
        @if (tip.card.surprise) {
          <div class="event-surprise">{{ tip.card.surprise }}</div>
        }
        <div class="row date">Click for the event's reading</div>
      </div>
    }`,
  styles: [
    `
      .inline-edit {
        position: absolute;
        z-index: 30;
        min-width: 60px;
        min-height: 22px;
        padding: 2px 4px;
        box-sizing: border-box;
        resize: none;
        font: inherit;
        font-size: 13px;
        color: var(--tv-ink, #131722);
        background: var(--tv-bg, #fff);
        border: 1px solid #2962ff;
        border-radius: 2px;
        outline: none;
      }
      .chart-host {
        position: absolute;
        inset: 0;
      }
      .script-tables {
        position: absolute;
        z-index: 5;
        pointer-events: none;
      }
      .script-tip {
        position: absolute;
        z-index: 31;
        max-width: 320px;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(19, 23, 34, 0.92);
        color: #fff;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
        pointer-events: none;
      }
      .script-tip.flip-x {
        transform: translateX(-100%);
      }
      .script-tip.flip-y {
        transform: translateY(-100%);
      }
      .script-tip.flip-x.flip-y {
        transform: translate(-100%, -100%);
      }
      .hold-tip {
        position: absolute;
        z-index: 30;
        min-width: 170px;
        padding: 8px 10px;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e6e9ef);
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
        font-size: 12px;
        pointer-events: none;
      }
      .hold-tip .row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        line-height: 20px;
      }
      .hold-tip .date {
        color: var(--text-muted, #787b86);
      }
      .hold-tip b {
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .event-tip {
        width: 240px;
      }
      .event-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 2px;
        line-height: 18px;
      }
      .event-ccy {
        flex: none;
        padding: 0 4px;
        border-radius: 3px;
        color: #fff;
        font-size: 11px;
        background: #787b86;
      }
      .event-ccy.event-high {
        background: #ef5350;
      }
      .event-ccy.event-medium {
        background: #ffa726;
      }
      .event-surprise {
        margin-top: 2px;
        line-height: 18px;
        font-weight: 500;
      }
    `,
  ],
})
export class ChartHostComponent implements OnDestroy {
  private readonly theme = inject(ThemeService);
  private readonly drawings = inject(DrawingStore);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly controller = new DrawingController(
    this.drawings,
    () => this.precision(),
    () => ({ symbol: this.symbol(), resolution: this.resolution() }),
    (t) => t + this.timezoneShiftMs(t),
    (t) => t - this.timezoneShiftMs(t),
  );

  readonly bars = input.required<Bar[]>();
  /**
   * Which series `bars` hold (`symbol|resolution`), as the page knows it once they have LANDED — the
   * page's symbol switches before the new bars arrive. A change rebuilds every series rather than
   * diffing one instrument's bars against another's, and re-measures the price-based box. Empty:
   * this chart's symbol and resolution.
   */
  readonly dataKey = input<string>('');
  readonly style = input<ChartStyle>('candles');
  readonly showVolume = input<boolean>(true);
  /** Volume-by-price histogram down the right edge, with POC and value area. */
  readonly showVolumeProfile = input<boolean>(false);
  /** Visible range (one profile, right edge) or one profile per session / week / month. */
  readonly volumeProfileMode = input<VolumeProfileMode>('visible');
  /** Auto-detected support/resistance from swing pivots. */
  readonly showSupportResistance = input<boolean>(false);
  /** Balance range, value area, stop pools and the events that formed them. */
  readonly showStructure = input<boolean>(false);
  readonly indicators = input<ActiveIndicator[]>([]);
  readonly precision = input<number>(5);
  /** Armed drawing tool, or null for the cursor. */
  readonly tool = input<DrawingKind | null>(null);
  /** TradingView magnet: off / weak / strong (Ctrl/Cmd inverts it while drawing). */
  readonly magnet = input<MagnetMode>('off');
  /** TV "Stay in drawing mode": keep the tool armed after a drawing completes. */
  readonly stayInDrawingMode = input<boolean>(false);
  /** Price scale mode — normal, logarithmic, percentage or indexed to 100 (CC-I9). */
  readonly scaleMode = input<ScaleMode>('normal');
  /** Turn the price scale upside down (TradingView's "Invert scale"). */
  readonly invertScale = input<boolean>(false);
  /** Which side the price scale sits on; the studies on the price pane move with it. */
  readonly scaleSide = input<'right' | 'left'>('right');
  /** Lines where each trading day begins on an intraday chart (17:00 New York for FX). */
  readonly sessionBreaks = input<boolean>(false);
  /** Engine-derived price levels: position entry/SL/TP and pending orders. */
  readonly overlays = input<PriceOverlay[]>([]);
  /** Whether those lines widen the price scale's fit (CC-10); off keeps the candles' own range. */
  readonly fitTradeLines = input<boolean>(true);
  /** Bar markers for trade signals, fills and economic events. */
  readonly markers = input<ChartMarker[]>([]);
  /** IANA zone for the time axis; bar data itself stays UTC. */
  readonly timezone = input<string>('UTC');
  /** Economic events on the time axis. Times are UTC; placed on the display clock between bars. */
  readonly events = input<EventMark[]>([]);
  readonly minEventImpact = input<'High' | 'Medium' | 'Low'>('Medium');
  /**
   * Spans to shade (UTC ms): the news blackout around Tier-1 events — the window live refuses new
   * entries in (`GET economic-event/news-blackout`). Empty: no shading.
   */
  readonly eventBands = input<{ from: number; to: number }[]>([]);
  /** Multiplier on the ATR-derived Renko / P&F / Kagi / Range box size. */
  readonly boxSizeAtr = input<number>(1);
  /**
   * How the price-based box is sized (TradingView's "box size assignment method"): `atr` — a multiple
   * of ATR(14), measured once at load; `pips` — a fixed number of pips (`boxPips`), "Traditional".
   */
  readonly boxMethod = input<'atr' | 'pips'>('atr');
  readonly boxPips = input<number>(10);
  /** One pip in price (the page knows the symbol's asset class); null: from {@link precision}. */
  readonly pipSize = input<number | null>(null);
  /** Renko "Show wicks": the furthest price traded against each brick before it formed. */
  readonly renkoWicks = input<boolean>(false);
  /** Line break: how many lines a reversal must break (TradingView's default 3). */
  readonly lineBreakLines = input<number>(3);
  /** Which chart this panel is, so it renders only its own drawings. */
  readonly symbol = input<string>('');
  /** Bars of other symbols, keyed by symbol, for compare studies (correlation, spread…). */
  readonly compareBars = input<Record<string, Bar[]>>({});
  /**
   * Pine indicator / strategy runs to paint on this chart, by key, in the order they were added
   * (a later script's barcolor() wins), each with its display settings (eye, trades on chart, …).
   */
  readonly scriptResults = input<ChartScriptLayer[]>([]);
  /** Externally sourced series (FX fundamentals), each in its own pane. */
  readonly externalPanes = input<ExternalPane[]>([]);
  readonly resolution = input<string>('');
  /**
   * The symbol's session as the engine reports it (`scripting/chart-bars`): the trading days the
   * day-based studies count in — the session VWAP, daily pivots, the Day / Week / Month anchors,
   * session and periodic profiles. Null: UTC days.
   */
  readonly session = input<SessionSpec | null>(null);
  /**
   * The bars reach back to the start of the engine's history: scrolling to the left edge stops
   * asking for more (CC-14 — every pan to the edge used to fetch again, for nothing).
   */
  readonly historyComplete = input<boolean>(false);
  /** The data window is open: it is filled on every crosshair move (CC-I6), and only then. */
  readonly dataWindowOpen = input(false);
  /** TradingView's countdown to bar close under the last-price label. */
  readonly showCountdown = input(true);
  /** When the last live price arrived (client ms); null = no live feed. Stale ⇒ no countdown. */
  readonly liveAt = input<number | null>(null);

  /** Raised when the visible range reaches the oldest bar we hold. */
  /** Arrow-key nudge of the selected drawing (bars sideways, pixels vertically). */
  nudgeSelectedDrawing(bars: number, pixels: number): boolean {
    return this.controller.nudgeSelected(bars, pixels);
  }

  /** Paste the copied drawing onto this chart. */
  pasteDrawing(): boolean {
    return this.controller.paste() !== null;
  }

  /** Inline text editor over a drawing (double-click on a text-bearing tool). */
  readonly inlineEdit = signal<{
    id: string;
    rect: { x: number; y: number; w: number; h: number };
    value: string;
    commit: (v: string) => Partial<Drawing>;
  } | null>(null);

  onInlineKey(ev: KeyboardEvent): void {
    ev.stopPropagation(); // the page's shortcuts must not see typing
    if (ev.key === 'Escape') this.inlineEdit.set(null);
    else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.commitInline((ev.target as HTMLTextAreaElement).value);
    }
  }

  commitInline(value: string): void {
    const ie = this.inlineEdit();
    if (!ie) return;
    this.inlineEdit.set(null);
    if (value !== ie.value) this.controller.applyInlineEdit(ie.id, ie.commit(value));
  }

  /** Finish a multi-click drawing (Enter). */
  finishDrawing(): boolean {
    return this.controller.finishPending();
  }

  /** Abandon a drawing in progress. Returns whether one was. */
  cancelDrawing(): boolean {
    const was = this.controller.isPlacing;
    this.controller.cancelPending();
    return was;
  }

  readonly loadMore = output<void>();
  /** Crosshair readout for the legend; null time means "latest bar". */
  readonly legend = output<LegendSnapshot>();
  /** Raised when a drawing tool finishes, so the toolbar can disarm. */
  readonly toolComplete = output<void>();
  /** Double-click on a drawing — open its Settings dialog. */
  readonly drawingSettings = output<string>();
  /** Right-click on a drawing — open the drawing context menu (client coords). */
  readonly drawingContextMenu = output<{ id: string; clientX: number; clientY: number }>();
  /** Zoom/scroll or a pane resize settled — the page auto-saves {@link viewState}. */
  readonly viewChanged = output<void>();
  /** An economic event's flag (or the next-event chip) was clicked: open its reading. */
  readonly eventOpen = output<UpcomingEconomicEvent>();
  /**
   * Whether the price scale fits the visible bars on its own (TradingView's "auto"), as the chart
   * really is — dragging the scale turns it off, a double-click or "auto" back on (CC-19: the button
   * lit whenever the mode was "normal").
   */
  readonly autoScaleChange = output<boolean>();
  /**
   * A strategy's fill arrow was clicked on the chart: the run's key and the trades the arrow stands
   * for (one, or several merged into one order) — the Strategy Tester selects that row (PC-I5).
   */
  readonly scriptTradeClick = output<{ key: string; trades: readonly number[] }>();

  private chart: IChartApi | null = null;
  private price: PriceSeries | null = null;
  private volume: ISeriesApi<'Histogram'> | null = null;
  private indicatorSeries: IndicatorSeries[] = [];
  /**
   * The rows on the price and volume series, kept by {@link SeriesSync}: a tick is one `update()` of
   * the forming bar, not the whole series re-sent — and the price series is replaced only when the
   * style changes (CC-I1). Before, every tick removed and re-added it, re-sent every row and
   * re-rendered every script, marker and pane.
   */
  private readonly priceSync = new SeriesSync<PriceRow>(null, samePriceRow);
  private readonly volumeSync = new SeriesSync<VolumeRow>(null, sameValueRow);
  /** The style the price series was CREATED for (a style change replaces it). */
  private seriesStyle: ChartStyle | null = null;
  /** The script colours the price rows were built with ({@link adoptRepaintedRows}). */
  private rowsColors: (string | null)[] | null = null;
  /** The bars as plotted, kept in step from the first bar that changed. */
  private readonly plotter = new PlottedBars();
  /**
   * The price-based styles' box (Renko brick, P&F box, range size) in price, measured once per series
   * and style from the bars that had closed (CC-16): TradingView sizes an ATR box at load and keeps
   * it, rather than letting the forming bar move every brick on each tick.
   */
  private box: { key: string; unit: number } | null = null;
  /** Bumped on every change of the plotted bars: the studies' cache is keyed on it. */
  private dataVersion = 0;
  /**
   * The bar time (plotted seconds) the crosshair rests on, or null when it is off the chart: the
   * legend re-reads that bar after a tick instead of jumping to the newest one (CC-04).
   */
  private crosshairTime: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly loadMorePending = signal(false);
  /**
   * Press-and-hold values tooltip, as TradingView's "Values tooltip on long press": hold the
   * pointer still on the chart and the bar under it opens in a card that follows the
   * crosshair until release. A drag before the delay is a pan and never opens it.
   */
  readonly holdTip = signal<{
    x: number;
    y: number;
    date: string;
    rows: Array<{ label: string; value: string; color: string }>;
  } | null>(null);
  /** The economic event under the pointer, as a card above its flag (CC-I2). */
  readonly eventTip = signal<{ x: number; y: number; card: EventCard } | null>(null);
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdOrigin: { x: number; y: number } | null = null;
  private holding = false;
  private lastSnapshot: LegendSnapshot | null = null;
  private lastPointer = { x: 0, y: 0 };

  private holdBoundTo: HTMLElement | null = null;
  private bindHold(el: HTMLElement): void {
    if (this.holdBoundTo === el) return;
    this.holdBoundTo = el;
    const pos = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    el.addEventListener('pointerdown', (ev) => {
      // An armed drawing tool owns the press; so does any button but the primary.
      if (ev.button !== 0 || this.tool() !== null) return;
      this.cancelHold();
      this.holdOrigin = pos(ev);
      this.lastPointer = this.holdOrigin;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.holding = true;
        this.renderHoldTip();
      }, 350);
    });
    el.addEventListener('pointermove', (ev) => {
      const p = pos(ev);
      this.lastPointer = p;
      if (this.holdTimer && this.holdOrigin) {
        if (Math.hypot(p.x - this.holdOrigin.x, p.y - this.holdOrigin.y) > 5) this.cancelHold();
      } else if (this.holding) {
        this.renderHoldTip();
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      el.addEventListener(type, () => this.cancelHold());
    }
  }

  private cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdOrigin = null;
    this.holding = false;
    this.holdTip.set(null);
  }

  private renderHoldTip(): void {
    const s = this.lastSnapshot;
    if (!this.holding || !s || s.time === null) return;
    const dp = this.precision();
    const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(dp));
    const change = s.close !== null && s.open !== null ? s.close - s.open : null;
    const pct = change !== null && s.open ? (change / s.open) * 100 : null;
    const up = change === null || change >= 0;
    const tone = up ? '#089981' : '#F23645';
    // The snapshot's time is the plotted one, already on the display clock.
    const date = s.dateLabel ?? new Date(s.time).toISOString().replace('T', ' ').slice(0, 16);
    const rows = [
      { label: 'Open', value: fmt(s.open), color: tone },
      { label: 'High', value: fmt(s.high), color: tone },
      { label: 'Low', value: fmt(s.low), color: tone },
      { label: 'Close', value: fmt(s.close), color: tone },
      {
        label: 'Change',
        value:
          change === null
            ? '—'
            : `${change >= 0 ? '+' : ''}${change.toFixed(dp)} (${(pct ?? 0) >= 0 ? '+' : ''}${(pct ?? 0).toFixed(2)}%)`,
        color: tone,
      },
      { label: 'Vol', value: s.volume === null ? '—' : s.volume.toLocaleString(), color: tone },
      ...s.indicators.flatMap((ind) =>
        ind.values.map((v) => ({
          label: ind.values.length > 1 ? `${ind.label} ${v.title}` : ind.label,
          value: v.value === null ? '—' : v.value.toFixed(Math.min(dp, 4)),
          color: v.color,
        })),
      ),
    ];
    // Beside the pointer, flipped to the other side near the right/bottom edges so the card
    // never covers the candle being read or runs off the pane.
    const el = this.container().nativeElement;
    const W = 200;
    const H = 24 + rows.length * 20;
    const { x, y } = this.lastPointer;
    const left = x + 16 + W > el.clientWidth ? x - 16 - W : x + 16;
    const top = Math.max(4, Math.min(y - H / 2, el.clientHeight - H - 4));
    this.holdTip.set({ x: left, y: top, date, rows });
  }

  /** Bars currently on the chart, for legend lookups by time. */
  private plotted: Bar[] = [];
  /** {@link plotted} before the display zone's shift: the same bars, one for one, at their UTC times. */
  private plottedUtc: Bar[] = [];
  /** A plotted time → its UTC time, built the first time a study asks ({@link plottedDayOf}). */
  private utcByPlotted: Map<number, number> | null = null;

  /** The session's identity, so an equal spec from a later answer changes nothing downstream. */
  private readonly sessionKey = computed(() => {
    const s = this.session();
    return s ? `${s.session}|${s.timeZone}` : '';
  });
  /** The symbol's trading days; null without a session — the studies then count UTC days. */
  private readonly calendar = computed(() => {
    const [session, timeZone] = this.sessionKey().split('|');
    return session ? new TradingCalendar({ session, timeZone }) : null;
  });

  /**
   * The trading day of a PLOTTED bar time. Studies run on the plotted bars, whose times the display
   * zone shifted, while a trading day is a property of the instant: each time goes back to its bar's
   * UTC time first, so a session VWAP resets at 17:00 New York whatever zone the axis is drawn in.
   * Undefined without a session: the studies' own UTC days.
   */
  private plottedDayOf(): DayOf | undefined {
    const calendar = this.calendar();
    if (!calendar) return undefined;
    if (this.timezone() === 'UTC') return calendar.dayOf;
    this.utcByPlotted ??= new Map(
      this.plotted.map((b, i) => [b.time, this.plottedUtc[i]?.time ?? b.time]),
    );
    const byPlotted = this.utcByPlotted;
    return (t) => calendar.dayOf(byPlotted.get(t) ?? t - this.timezoneShiftMs(t));
  }
  /**
   * On 1D/1W/1M, each plotted bar's trading date (00:00 UTC ms) by its plotted time in seconds — what
   * the time axis, the crosshair, the legend and the hold tooltip print for it. Empty otherwise.
   */
  private tradingDates = new Map<number, number>();
  /** The resolution the time axis's tick labels were last formatted for. */
  private labelsFor: string | null = null;
  /** Tick labels on 1D/1W/1M: year, month or day of the bar's trading date. Null: the library's own. */
  private readonly tickMarkFormatter = (time: Time, type: TickMarkType): string | null => {
    const date = typeof time === 'number' ? this.tradingDateAt(time) : null;
    return date === null ? null : tradingDateTick(date, type);
  };

  /**
   * The trading date of whatever is plotted at `seconds` on 1D/1W/1M — a bar's from the engine's open
   * and close; anything else plotted there (a script's slot past the last bar, a price-based brick)
   * by the open it stands for. Null on a resolution labelled by clock time.
   */
  private tradingDateAt(seconds: number): number | null {
    const resolution = this.resolution();
    if (!labelsByTradingDate(resolution)) return null;
    const known = this.tradingDates.get(seconds);
    if (known !== undefined) return known;
    const plotted = seconds * 1000;
    return tradingDateOf({ time: plotted - this.timezoneShiftMs(plotted) }, resolution);
  }
  private readonly countdown = new BarCountdownPrimitive();
  private readonly serverClock = inject(ServerClock);
  private readonly zone = inject(NgZone);
  private countdownTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * One cheap tick: text + colour into the primitive, which repaints the axis label only. Runs
   * outside Angular (no change detection) and skips hidden tabs.
   */
  private tickCountdown(): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    const raw = this.bars();
    const last = raw[raw.length - 1];
    const shown = this.plotted[this.plotted.length - 1];
    const text =
      this.showCountdown() && last && shown
        ? countdownText(
            this.resolution(),
            this.style(),
            last.time,
            this.serverClock.now(),
            this.liveAt(),
            // The session grid's bars carry the engine's close for their period (2h … 1M).
            last.closeTime ?? null,
          )
        : null;
    const p = this.palette(this.theme.theme() === 'dark');
    const lineLike = LINE_LIKE.has(this.style());
    // The last-value label above takes the last bar's colour, a script's barcolor() included — but
    // not on hollow candles, where that colour paints only the border and wick.
    const scripted =
      this.priceStyle === 'hollow' ? null : (this.barColors?.[this.plotted.length - 1] ?? null);
    const up = (shown?.close ?? 0) >= (shown?.open ?? 0);
    // A faded bar's colour as it shows over the canvas: the label is opaque, as the one above it.
    const color = opaqueOver(lineLike ? p.line : (scripted ?? (up ? p.up : p.down)), p.background);
    const price = shown ? shown.close : null;
    this.countdown.set(text, price, color, labelTextColor(color), axisLabelHeight(12));
  }

  /** The `priceLineColor` the price series was last given ('' = the library's own colouring). */
  private lastValueColor = '';

  /**
   * The series' own last-value label is the colour of the bar it labels — the last one on screen,
   * as the library picks it (`lastValueData`: the visible range's right edge, nearest bar to its
   * left) — and the library drops that colour's alpha: a script's faded bar got a full-strength
   * label. A translucent colour is laid over the canvas instead, through `priceLineColor` (the
   * label's colour, and the price line's); an opaque one, or none, leaves the library to it.
   * After every new series, a change of the scripts' colours, and every pan or zoom.
   */
  private syncLastValueLabel(): void {
    const series = this.price;
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!series || !range) return;
    const bar = series.dataByIndex(Math.ceil(range.to), MismatchDirection.NearestLeft);
    const barColor = bar && 'color' in bar ? (bar.color as string | undefined) : undefined;
    const color = lastValueLabelColor(
      barColor,
      this.palette(this.theme.theme() === 'dark').background,
    );
    if (color === this.lastValueColor) return;
    this.lastValueColor = color;
    series.applyOptions({ priceLineColor: color });
  }
  private readonly overlayRenderer = new OverlayRenderer(
    () => this.price,
    () => this.precision(),
  );
  private readonly analysisRenderer = new AnalysisOverlayRenderer(
    () => this.price,
    () => this.precision(),
    (ms) => {
      const x = this.chart?.timeScale().timeToCoordinate(asTime(ms + this.timezoneShiftMs(ms)));
      return x === null || x === undefined ? null : Number(x);
    },
  );
  private markerApi: ISeriesMarkersPluginApi<Time> | null = null;
  private readonly sessionBreaksRenderer = new SessionBreaksRenderer(
    () => this.chart,
    () => this.theme.theme() === 'dark',
  );
  private readonly eventRenderer = new EventMarksRenderer(
    (ms) => this.eventX(ms),
    () => this.serverClock.now(),
  );
  /** One renderer per active profile study, keyed by the study's uid. */
  private profileRenderers = new Map<string, ProfileRenderer>();
  /** Every active pattern study paints through this one renderer. */
  private readonly patternRenderer = new PatternRenderer(
    () => this.price,
    // Patterns run on the PLOTTED bars, whose times are already zone-shifted.
    (ms) => {
      const x = this.chart?.timeScale().timeToCoordinate(asTime(ms));
      return x === null || x === undefined ? null : Number(x);
    },
    () => this.theme.theme() === 'dark',
  );
  /** UTC ms → x, for studies computed on the unshifted bars. */
  private readonly utcToX = (ms: number): number | null => {
    const x = this.chart?.timeScale().timeToCoordinate(asTime(ms + this.timezoneShiftMs(ms)));
    return x === null || x === undefined ? null : Number(x);
  };

  constructor() {
    this.zone.runOutsideAngular(() => {
      this.countdownTimer = setInterval(() => this.tickCountdown(), 1000);
    });
    // The data window's own sections go through the registry like any other provider's.
    this.registerValueProvider('bar', this.barValues);
    this.registerValueProvider('studies', this.studyValues);

    // Opening the data window fills it at once, for the bar the legend shows.
    effect(() => {
      if (this.dataWindowOpen()) untracked(() => this.emitLegend());
    });
    // Create once the view exists, then keep it in step with inputs. Each
    // effect reads exactly one input and does its work untracked, so changing
    // the bar set never rebuilds the indicator panes and vice versa.
    effect(() => {
      const el = this.container().nativeElement;
      const dark = this.theme.theme() === 'dark';
      untracked(() => (this.chart ? this.retheme(dark) : this.rebuildChart(el, dark)));
    });

    // The bars and everything drawn from them, by the least the chart has to redraw (CC-I1): a tick
    // rewrites the forming bar's rows on the price, volume and study series; a new series, style,
    // time zone, theme or box size, or history loaded on the left, rebuilds them (syncData).
    effect(() => {
      this.bars();
      this.dataKey();
      this.style();
      this.timezone();
      this.boxSizeAtr();
      this.boxMethod();
      this.boxPips();
      this.pipSize();
      this.renkoWicks();
      this.lineBreakLines();
      this.theme.theme();
      untracked(() => this.syncData());
    });

    effect(() => {
      const show = this.showVolume();
      untracked(() => this.syncVolumeSeries(show));
    });

    effect(() => {
      const precision = this.precision();
      untracked(() => this.applyPrecision(precision));
    });

    // Studies: their inputs, and the trading days the day-based ones count in (they recount when the
    // symbol's session becomes known). A change of the chart's own bars reaches them through syncData,
    // which writes only their tails.
    effect(() => {
      const active = this.indicators();
      this.calendar();
      untracked(() => this.applyStudies(active));
    });

    // The other symbols' bars the compare studies read: they follow those symbols' live prices and
    // scroll-back (CC-13), so only the series are rewritten here — not the patterns and profiles.
    effect(() => {
      this.compareBars();
      untracked(() => this.applyIndicators(this.indicators(), this.plotted.length));
    });

    // Drawing state → renderer. Reads the store's signals so any mutation
    // (add, drag, style change, undo) repaints without the page wiring an
    // explicit refresh for each one.
    effect(() => {
      // Filtered by THIS panel's symbol and timeframe rather than the store's
      // single global scope: in a split layout every panel is on screen at
      // once, and a global set would paint one panel's trendlines onto another.
      const all = this.drawings.hidden() ? [] : this.drawings.allDrawings();
      const symbol = this.symbol();
      const resolution = this.resolution();
      const selected = this.drawings.selectedId();
      untracked(() =>
        this.controller.sync(
          all.filter((d) => d.symbol === symbol && d.resolution === resolution),
          selected,
        ),
      );
    });

    effect(() => {
      const tool = this.tool();
      const magnet = this.magnet();
      const stay = this.stayInDrawingMode();
      const bars = this.bars();
      untracked(() => {
        this.controller.magnetMode = magnet;
        this.controller.stayInDrawingMode = stay;
        this.controller.bars = bars;
        if (this.controller.activeTool !== tool) this.controller.setTool(tool);
      });
    });

    effect(() => {
      const mode = this.scaleMode();
      const invert = this.invertScale();
      const side = this.scaleSide();
      untracked(() => this.applyScale(mode, invert, side));
    });

    effect(() => {
      this.sessionBreaks();
      this.calendar();
      untracked(() => this.syncSessionBreaks());
    });

    // Pine runs: synced when their results or settings change (and the symbol's precision, which
    // their values print with), and on a rebuild (syncData) — never on a tick (the contract with
    // pine-chart). Ticks write the forming bar's row, which carries its barcolor (priceRowsFrom),
    // and reach the scripts' panes as an anchor update (ScriptLayers).
    effect(() => {
      const layers = this.scriptResults();
      this.precision();
      untracked(() => {
        this.applyScripts(layers);
        this.adoptRepaintedRows();
      });
    });

    // Fundamentals panes: their series live as long as their study (CC-02), so a pane keeps the
    // height and place the operator gave it; the bars reach them through syncData.
    effect(() => {
      const panes = this.externalPanes();
      untracked(() => this.applyExternalPanes(panes));
    });

    effect(() => {
      const overlays = this.overlays();
      untracked(() => this.overlayRenderer.setOverlays(overlays));
    });

    effect(() => {
      const fit = this.fitTradeLines();
      untracked(() => this.overlayRenderer.setFit(fit));
    });

    // Analytical overlays. Recomputed when the toggles change, after ticks (syncData, throttled) and
    // — via `onVisibleRangeChanged` — whenever the operator pans or zooms.
    effect(() => {
      this.showVolumeProfile();
      this.volumeProfileMode();
      this.showSupportResistance();
      this.showStructure();
      this.calendar();
      untracked(() => this.recomputeAnalysis());
    });

    effect(() => {
      const markers = this.markers();
      untracked(() => this.applyMarkers(markers));
    });

    // Events are placed by their UTC instant between bars (eventX), so a zone change moves them with
    // the bars and needs nothing here.
    effect(() => {
      const events = this.events();
      const minImpact = this.minEventImpact();
      untracked(() => this.eventRenderer.setMarks(events, minImpact));
    });

    effect(() => {
      const bands = this.eventBands();
      untracked(() => this.eventRenderer.setBands(bands));
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.countdownTimer);
    clearTimeout(this.marginTimer);
    if (this.tailStudiesTimer !== null) clearTimeout(this.tailStudiesTimer);
    this.cancelGlide();
    this.scriptLayers.dispose();
    cancelAnimationFrame(this.tablesFrame);
    this.paneObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.controller.detach();
    this.chart?.remove();
    this.chart = null;
  }

  /**
   * The price scale: its side, mode and direction (CC-I9). Percentage and indexed-to-100 are
   * relative to the first visible bar, which is why switching mode rescales rather than re-fetching.
   * The price series and the studies drawn on its scale move to the chosen side together; the
   * volume overlay keeps its own scale.
   */
  private applyScale(mode: ScaleMode, invert: boolean, side: 'right' | 'left'): void {
    const chart = this.chart;
    if (!chart) return;
    chart.applyOptions({
      leftPriceScale: { visible: side === 'left' },
      rightPriceScale: { visible: side === 'right' },
    });
    this.price?.applyOptions({ priceScaleId: side });
    for (const s of this.indicatorSeries)
      if (s.overlay) for (const plot of s.series) plot.api.applyOptions({ priceScaleId: side });
    chart.priceScale(side).applyOptions({
      mode:
        mode === 'log'
          ? PriceScaleMode.Logarithmic
          : mode === 'percent'
            ? PriceScaleMode.Percentage
            : mode === 'indexed'
              ? PriceScaleMode.IndexedTo100
              : PriceScaleMode.Normal,
      invertScale: invert,
    });
    this.syncScriptScales();
    this.checkAutoScale();
  }

  /** The autoscale state as last reported ({@link autoScaleChange}). */
  private autoScaleOn: boolean | null = null;

  /** Report the price scale's real autoscale state when it changed. */
  private checkAutoScale(): void {
    const on = this.chart?.priceScale(this.scaleSide()).options().autoScale;
    if (on === undefined || on === this.autoScaleOn) return;
    this.autoScaleOn = on;
    this.autoScaleChange.emit(on);
  }

  /** Session breaks on the plotted bars: intraday only, on the symbol's trading days. */
  private syncSessionBreaks(): void {
    const resolution = this.resolution();
    const intraday = !['1D', '1W', '1M'].includes(resolution) && !PRICE_BASED.has(this.style());
    if (!this.sessionBreaks() || !intraday || this.plottedUtc.length < 2) {
      this.sessionBreaksRenderer.setBreaks([]);
      return;
    }
    const dayOf = this.calendar()?.dayOf ?? utcDay;
    this.sessionBreaksRenderer.setBreaks(
      sessionBreakIndexes(
        this.plottedUtc.map((b) => b.time),
        dayOf,
      ),
    );
  }

  /**
   * Recompute the analytical overlays for the VISIBLE window.
   *
   * <p>Not the loaded window. The chart holds 1500 bars — nearly three months of EURUSD
   * hourly — while the operator is usually looking at ten days of it, so profiling
   * everything loaded described mostly off-screen data: the POC landed at 1.14323 from a
   * range the visible candles never touched. A profile is a statement about the window you
   * are looking at, and an operator reasonably reads it as one.</p>
   *
   * <p>Falls back to all loaded bars only when the library cannot report a range yet, which
   * is the first frame before the scale settles.</p>
   */
  private recomputeAnalysis(): void {
    const bars = this.bars();
    const wantProfile = this.showVolumeProfile();
    const wantLevels = this.showSupportResistance();
    const wantStructure = this.showStructure();
    if (!wantProfile && !wantLevels && !wantStructure) {
      this.analysisRenderer.setProfile(null);
      this.analysisRenderer.setPeriodProfiles([]);
      this.analysisRenderer.setLevels([]);
      this.analysisRenderer.setStructure(null);
      return;
    }

    const window = this.visibleBars(bars);
    const mode = this.volumeProfileMode();
    this.analysisRenderer.setProfile(
      wantProfile && mode === 'visible' ? profileWithValueArea(window) : null,
    );
    // Period profiles cover every loaded bar — the renderer culls off-screen periods, and
    // re-slicing on pan would split a session in two at the viewport edge. Their sessions, weeks
    // and months are the symbol's trading ones (on the unshifted bars, where a day is an instant's).
    this.analysisRenderer.setPeriodProfiles(
      wantProfile && mode !== 'visible'
        ? periodProfiles(bars, mode, { dayOf: this.calendar()?.dayOf })
        : [],
    );
    this.analysisRenderer.setLevels(wantLevels ? supportResistance(window) : []);
    this.analysisRenderer.setStructure(wantStructure ? marketStructure(window) : null);
  }

  /**
   * The bars on screen — the window the analysis overlays describe. The assistant's levels read the
   * same window (CC-21: they were computed on every loaded bar while the chart drew the visible ones).
   */
  visibleWindow(): Bar[] {
    return this.visibleBars(this.bars());
  }

  /** The slice of `bars` currently on screen. */
  private visibleBars(bars: readonly Bar[]): Bar[] {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!range || bars.length === 0) return [...bars];
    // The logical range runs past both ends when the chart has whitespace margins, so it is
    // clamped rather than trusted as an index.
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length, Math.ceil(range.to) + 1);
    const slice = bars.slice(from, to);
    // A handful of bars produces a profile of noise and no usable pivots; showing the whole
    // window is a better answer than showing nonsense.
    return slice.length >= 20 ? slice : [...bars];
  }

  /**
   * Recompute the overlays after the pan settles.
   *
   * <p>`subscribeVisibleLogicalRangeChange` fires on every frame of a drag. The profile is
   * O(bars) and the pivot scan O(bars × lookback), so doing this per frame is what turns a
   * smooth pan into a stutter.</p>
   */
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleAnalysis(): void {
    if (!this.showVolumeProfile() && !this.showSupportResistance() && !this.showStructure()) return;
    if (this.analysisTimer !== null) clearTimeout(this.analysisTimer);
    this.analysisTimer = setTimeout(() => {
      this.analysisTimer = null;
      this.recomputeAnalysis();
    }, 120);
  }

  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleViewChanged(): void {
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => this.viewChanged.emit(), 400);
  }

  /**
   * Zoom, scroll and pane heights, as a layout saves them. Zoom is the bar spacing and the scroll
   * is the offset from the realtime edge (TradingView keeps the same): an absolute time window
   * would reopen tomorrow on yesterday's bars.
   */
  viewState(): ChartViewState | null {
    if (!this.chart) return null;
    const scale = this.chart.timeScale();
    const options = scale.options();
    // Sitting at the live edge of a margin the scripts opened saves as the default live edge: the
    // margin is theirs, not a scroll the operator chose (syncScriptMargin).
    const position = savedRightOffset(scale.scrollPosition(), options.rightOffset);
    return {
      barSpacing: options.barSpacing,
      rightOffset: Math.round(position * 100) / 100,
      paneHeights: this.chart.panes().map((p) => p.getHeight()),
    };
  }

  /** Re-apply a saved {@link viewState}; panes not created yet keep their default height. */
  applyViewState(v: ChartViewState | null | undefined): boolean {
    if (!this.chart || !v) return false;
    const scale = this.chart.timeScale();
    if (Number.isFinite(v.barSpacing) && v.barSpacing > 0)
      scale.applyOptions({ barSpacing: v.barSpacing });
    if (Number.isFinite(v.rightOffset))
      scale.scrollToPosition(
        restoredRightOffset(v.rightOffset, scale.options().rightOffset),
        false,
      );
    const panes = this.chart.panes();
    (v.paneHeights ?? []).forEach((h, i) => {
      if (i > 0 && panes[i] && Number.isFinite(h) && h > 20) panes[i].setHeight(h);
    });
    return true;
  }

  /** Scroll to the most recent bar. */
  scrollToRealtime(): void {
    this.chart?.timeScale().scrollToRealTime();
  }

  fitContent(): void {
    this.chart?.timeScale().fitContent();
  }

  /**
   * Show the window between two instants (ms), inclusive.
   *
   * <p>The library takes SECONDS on the time scale while everything in this feature is
   * milliseconds, and the conversion is the kind of thing that silently shows 1970 when it
   * is forgotten. Returns false when the chart is not up yet so a caller can say so rather
   * than reporting a move that did not happen.</p>
   */
  setVisibleRange(fromMs: number, toMs: number): boolean {
    const scale = this.chart?.timeScale();
    if (!scale) return false;
    const from = Math.min(fromMs, toMs);
    const to = Math.max(fromMs, toMs);
    // By bar index, on the display clock (CC-15): the bars' times are zone-shifted, so a window of
    // UTC seconds landed hours off on a New York axis — and between bars, or past the last one,
    // the time scale has no time to land on.
    const a = this.logicalAtMs(from);
    const b = this.logicalAtMs(to);
    if (a !== null && b !== null && b > a) {
      scale.setVisibleLogicalRange({ from: a as Logical, to: b as Logical });
      return true;
    }
    try {
      scale.setVisibleRange({
        from: Math.floor((from + this.timezoneShiftMs(from)) / 1000) as unknown as Time,
        to: Math.floor((to + this.timezoneShiftMs(to)) / 1000) as unknown as Time,
      });
      return true;
    } catch {
      // The library throws when the range holds no data at all.
      return false;
    }
  }

  /**
   * Glide the time axis to [fromMs, toMs] (UTC): the visible logical range is interpolated
   * frame by frame with an ease-in-out curve, so the chart pans and zooms in one continuous
   * motion instead of jumping. A new call continues from wherever the current glide is; grabbing
   * the chart cancels it; reduced-motion users get the jump.
   */
  /**
   * Pan, without zooming, so [fromMs, toMs] is centred: the visible span stays the operator's
   * own. Glides like `glideToRange`.
   */
  panToRange(fromMs: number, toMs: number): boolean {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    const a = this.logicalAtMs(Math.min(fromMs, toMs));
    const b = this.logicalAtMs(Math.max(fromMs, toMs));
    if (!range || a === null || b === null) return false;
    const half = (range.to - range.from) / 2;
    const mid = (a + b) / 2;
    return this.glideToLogical(mid - half, mid + half);
  }

  /** Zoom the time axis about the centre of the view: factor < 1 zooms in, > 1 out. */
  zoomBy(factor: number): void {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const mid = (range.from + range.to) / 2;
    const half = Math.max(5, ((range.to - range.from) / 2) * factor);
    this.glideToLogical(mid - half, mid + half, 220);
  }

  glideToRange(fromMs: number, toMs: number, durationMs = 520): boolean {
    const scale = this.chart?.timeScale();
    const start = scale?.getVisibleLogicalRange();
    const a = this.logicalAtMs(Math.min(fromMs, toMs));
    const b = this.logicalAtMs(Math.max(fromMs, toMs));
    if (!scale || !start || a === null || b === null) return this.setVisibleRange(fromMs, toMs);
    return this.glideToLogical(a, b, durationMs);
  }

  private glideToLogical(a: number, b: number, durationMs = 520): boolean {
    const scale = this.chart?.timeScale();
    const start = scale?.getVisibleLogicalRange();
    if (!scale || !start) return false;
    this.cancelGlide();
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      scale.setVisibleLogicalRange({ from: a, to: b });
      return true;
    }
    const s0 = start.from;
    const s1 = start.to;
    const t0 = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / durationMs);
      const e = ease(k);
      scale.setVisibleLogicalRange({ from: s0 + (a - s0) * e, to: s1 + (b - s1) * e });
      this.glideFrame = k < 1 ? requestAnimationFrame(step) : null;
    };
    this.glideFrame = requestAnimationFrame(step);
    // The operator taking hold of the chart ends the glide where it is.
    const el = this.container().nativeElement;
    const stop = () => this.cancelGlide();
    el.addEventListener('pointerdown', stop, { once: true });
    el.addEventListener('wheel', stop, { once: true, passive: true });
    this.glideCleanup = () => {
      el.removeEventListener('pointerdown', stop);
      el.removeEventListener('wheel', stop);
    };
    return true;
  }

  private glideFrame: number | null = null;
  private glideCleanup: (() => void) | null = null;

  private cancelGlide(): void {
    if (this.glideFrame !== null) cancelAnimationFrame(this.glideFrame);
    this.glideFrame = null;
    this.glideCleanup?.();
    this.glideCleanup = null;
  }

  /**
   * Fractional bar index of a UTC instant on the plotted (zone-shifted) bars: between two bars by
   * time; before the first by the average bar width; past the last one — an upcoming economic event —
   * inside the forming bar by its own span, and beyond it by the TRADING time to it in bars of this
   * resolution (the symbol's session, when known), so Monday's release lands on Monday's bar rather
   * than two days' worth of bars past Friday's.
   */
  private logicalAtMs(utcMs: number): number | null {
    const bars = this.plotted;
    if (bars.length < 2) return null;
    const t = utcMs + this.timezoneShiftMs(utcMs);
    const last = bars.length - 1;
    const avg = (bars[last].time - bars[0].time) / last || 3_600_000;
    if (t <= bars[0].time) return (t - bars[0].time) / avg;
    if (t >= bars[last].time) {
      const lastUtc = this.plottedUtc[last]?.time ?? utcMs;
      const step = resolutionMs(this.resolution()) ?? avg;
      const end = this.lastBarEnd();
      if (!Number.isFinite(end) || end <= lastUtc) return last + (utcMs - lastUtc) / step;
      if (utcMs < end) return last + (utcMs - lastUtc) / (end - lastUtc);
      // Weeks and months are counted on the calendar: their bars span the weekends anyway.
      const calendar =
        this.resolution() === '1W' || this.resolution() === '1M' ? null : this.calendar();
      const span = calendar ? tradingMsBetween(calendar, end, utcMs) : utcMs - end;
      return last + 1 + span / step;
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }

  /** UTC ms → x on the price pane: an economic event's place, between bars or past the last one. */
  private eventX(utcMs: number): number | null {
    const logical = this.logicalAtMs(utcMs);
    const scale = this.chart?.timeScale();
    return logical === null || !scale ? null : xAtLogical(scale, logical);
  }

  /**
   * The event card under the pointer (CC-I2), above its flag; none elsewhere. From the crosshair's
   * point on the price pane.
   */
  private updateEventTip(point: { x: number; y: number } | undefined, paneIndex?: number): void {
    const mark = point && (paneIndex ?? 0) === 0 ? this.eventRenderer.hit(point.x, point.y) : null;
    if (!mark) {
      if (this.eventTip()) this.eventTip.set(null);
      return;
    }
    const when = formatEventTime(mark.time, Math.round(this.timezoneShiftMs(mark.time) / 60_000));
    const card = eventCard(mark, when, this.serverClock.now());
    const el = this.container().nativeElement;
    const height = 92 + card.rows.length * 20 + (card.surprise ? 18 : 0);
    const x = Math.max(4, Math.min(point!.x + 10, el.clientWidth - 248));
    const y = Math.max(4, point!.y - height - 12);
    this.eventTip.set({ x, y, card });
  }

  /** Show the most recent `count` bars. */
  showLastBars(count: number): boolean {
    const scale = this.chart?.timeScale();
    // The plotted bars: on a price-based style the time scale's slots are its bricks.
    const total = this.plotted.length;
    if (!scale || total === 0) return false;
    const from = Math.max(0, total - count);
    scale.setVisibleLogicalRange({ from, to: total - 1 });
    return true;
  }

  /**
   * TradingView's 2026 chart palette.
   *
   * Light: white canvas, #131722 text, near-invisible #F0F3FA grid, #E0E3EB
   * scale borders. Dark: TradingView's current dark canvas is the neutral
   * #0F0F0F (it moved off the old blue-grey #131722 in the 2023 redesign) with
   * #DBDBDB text, #1F1F1F grid and #2E2E2E borders. Candles use TradingView's
   * current default pair #089981 / #F23645 for body, wick and border alike;
   * volume is the same pair at 50% alpha. The crosshair is a dashed #9598A1
   * line whose axis labels sit on a dark #131722 chip in light mode and a
   * #363A45 chip in dark mode, as TradingView draws them.
   */
  private palette(dark: boolean) {
    return {
      background: dark ? '#0F0F0F' : '#FFFFFF',
      text: dark ? '#DBDBDB' : '#131722',
      grid: dark ? '#1F1F1F' : '#F0F3FA',
      border: dark ? '#2E2E2E' : '#E0E3EB',
      up: '#089981',
      down: '#F23645',
      volumeUp: 'rgba(8,153,129,0.5)',
      volumeDown: 'rgba(242,54,69,0.5)',
      crosshair: '#9598A1',
      crosshairLabel: dark ? '#363A45' : '#131722',
      line: '#2962FF',
    };
  }

  /**
   * Re-colour the live chart for a theme switch, in place. It used to be torn
   * down and recreated, which threw away the operator's zoom and scroll — and
   * Lightweight Charts 5.2 can request a frame while destroying itself that then
   * lands on its disposed canvases ("Object is disposed", the second time the
   * theme was switched).
   */
  private retheme(dark: boolean): void {
    if (!this.chart) return;
    const p = this.palette(dark);
    this.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: p.background },
        textColor: p.text,
        panes: { separatorColor: p.border, separatorHoverColor: p.border },
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border },
      leftPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border },
      crosshair: {
        vertLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
        horzLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
      },
    });
    // The series keep their rows: the up/down colours are the same in both themes. The labels drawn
    // over the canvas (last value, countdown) blend with the background, and the data effect,
    // which tracks the theme, rebuilds what is drawn from the bars.
  }

  private rebuildChart(el: HTMLElement, dark: boolean): void {
    this.chart?.remove();
    // Every series handle died with that chart. Left set, syncData below would hand
    // the old price series to the NEW chart's removeSeries, which throws "Value
    // is undefined" for a series it never owned — a theme switch then left the
    // chart empty — and the old volume series would be written to, not re-added.
    this.price = null;
    this.volume = null;
    this.markerApi = null;
    this.indicatorSeries = [];
    this.externalSeries.clear();
    this.seriesStyle = null;
    this.priceSync.attach(null);
    this.volumeSync.attach(null);
    this.plotter.reset();
    this.plotKey = null;
    const p = this.palette(dark);

    // The library's time scale, but weighing and labelling 1D/1W/1M bars by trading date — the
    // bars' times stay their opens (see trading-date.ts).
    const timeScale = new TradingDateTimeScale();
    timeScale.source = {
      dateAt: (seconds) => this.tradingDateAt(seconds),
      resolution: () => this.resolution(),
    };
    // This chart's labels are not formatted yet, whatever an earlier chart's were.
    this.labelsFor = null;
    const options: DeepPartial<ChartOptions> = {
      // createChart()'s one default, which createChartEx() leaves to its caller.
      localization: { dateFormat: "dd MMM 'yy" },
      layout: {
        background: { type: ColorType.Solid, color: p.background },
        textColor: p.text,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
        fontSize: 12,
        attributionLogo: false,
        panes: { separatorColor: p.border, separatorHoverColor: p.border, enableResize: true },
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
      leftPriceScale: { borderColor: p.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: {
        borderColor: p.border,
        timeVisible: true,
        secondsVisible: false,
        // TradingView's defaults: ~5 bars of empty space right of the last bar,
        // 6px per bar. Scripts drawing into the future widen the margin (syncScriptMargin).
        rightOffset: DEFAULT_RIGHT_OFFSET,
        barSpacing: 6,
        tickMarkFormatter: this.tickMarkFormatter,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: p.crosshair,
          width: 1,
          labelBackgroundColor: p.crosshairLabel,
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: p.crosshair,
          width: 1,
          labelBackgroundColor: p.crosshairLabel,
          style: LineStyle.Dashed,
        },
      },
      autoSize: false,
      handleScroll: true,
      handleScale: true,
    };
    // createChart() is createChartEx() with the library's own time scale; the chart is the same.
    this.chart = createChartEx<Time, TradingDateTimeScale>(
      el,
      timeScale,
      options,
    ) as unknown as IChartApi;
    // The price pane stays when its last series goes: with volume off and only pane studies on, the
    // style switch's old price series used to be the pane's last, the library deleted the pane, and
    // the candles came back in the first study's pane (CC-03). syncData also adds the new series
    // before it removes the old one.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);

    this.sizeToContainer(el);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.sizeToContainer(el);
      this.layoutScriptTables();
    });
    this.resizeObserver.observe(el);

    this.chart.subscribeCrosshairMove((param) => {
      // Remembered so a tick re-reads the bar under the pointer rather than the newest (CC-04).
      this.crosshairTime =
        param.point && param.time !== undefined && param.time !== null
          ? (param.time as number)
          : null;
      this.emitLegend();
      this.updateEventTip(param.point, param.paneIndex);
    });
    // An event's flag (or the next-event chip) opens its reading; an armed drawing tool owns clicks.
    this.chart.subscribeClick((param) => {
      if (!param.point || this.tool() !== null || (param.paneIndex ?? 0) !== 0) return;
      const mark = this.eventRenderer.hit(param.point.x, param.point.y);
      if (mark) this.eventOpen.emit(mark.event);
    });
    this.bindHold(el);

    this.controller.attach(this.chart, el);
    this.controller.onToolComplete = () => this.toolComplete.emit();
    this.controller.onEditRequest = (id) => this.drawingSettings.emit(id);
    this.controller.onInlineEdit = (e) => {
      this.inlineEdit.set(e);
      // Focus once rendered; the textarea is created by the signal change.
      setTimeout(() =>
        (
          this.container().nativeElement.parentElement?.querySelector(
            '.inline-edit',
          ) as HTMLTextAreaElement | null
        )?.select(),
      );
    };
    this.controller.onDrawingContextMenu = (e) => this.drawingContextMenu.emit(e);
    this.controller.magnetMode = this.magnet();
    this.controller.stayInDrawingMode = this.stayInDrawingMode();
    this.controller.bars = this.bars();

    // Infinite history: when the left edge reaches the oldest bar we hold, ask
    // the page for more. The pending flag matters — the range fires on every
    // frame of a drag, and without it one flick queues dozens of fetches.
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || this.plotted.length === 0) return;
      if (range.from < 10 && !this.loadMorePending() && !this.historyComplete()) {
        this.loadMorePending.set(true);
        this.loadMore.emit();
      }
      // The analytical overlays describe the VISIBLE window, so panning and zooming change
      // what they say. Debounced: this fires on every frame of a drag, and recomputing a
      // profile per frame would make the pan stutter.
      this.scheduleAnalysis();
      this.scheduleVisibleProfiles();
      this.scheduleViewChanged();
      this.scheduleMarginSync();
      // The last-value label moves to the last bar on screen, and takes that bar's colour.
      this.syncLastValueLabel();
    });
    // Pane separators are dragged with the pointer; heights have no change event of their own.
    el.addEventListener('pointerup', () => this.scheduleViewChanged());
    // The price scale's autoscale has no change event either: dragging or wheeling the scale turns
    // it off, a double-click on it back on. Read it after each, once the chart has handled it.
    for (const type of ['pointerup', 'wheel', 'dblclick'] as const)
      el.addEventListener(type, () => requestAnimationFrame(() => this.checkAutoScale()), {
        passive: true,
      });

    this.syncVolumeSeries(this.showVolume());
    this.syncData();
    this.applyStudies(this.indicators());
    this.applyExternalPanes(this.externalPanes());
  }

  /**
   * Shift bar times into the display timezone.
   *
   * Lightweight Charts has no timezone setting — it draws the instants it is
   * given — so the axis is moved by offsetting the times. The offset is
   * computed per bar at that bar's own instant, because a fixed offset would
   * be an hour wrong either side of a DST change, which is exactly where an
   * operator cross-checking a session open would notice.
   */
  private timezoneShiftMs(atMs: number): number {
    const zone = this.timezone();
    return zone === 'UTC' ? 0 : timezoneOffsetMinutes(zone, atMs) * 60_000;
  }

  private shiftForTimezone(bars: Bar[], zone: string): Bar[] {
    if (zone === 'UTC' || bars.length === 0) return bars;
    return bars.map((b) => ({
      ...b,
      time: b.time + timezoneOffsetMinutes(zone, b.time) * 60_000,
    }));
  }

  /**
   * The chart as an image (CC-22): the library's own screenshot of every pane, scale and primitive
   * (`takeScreenshot`) under a title band, with the legend and the scripts' tables — HTML over the
   * canvas, so laid out and drawn here from their layout — painted in. Null when the chart is not
   * drawn or the browser will not render it; the caller says so rather than reporting a save that
   * did not happen.
   */
  snapshotCanvas(title: string): HTMLCanvasElement | null {
    const chart = this.chart;
    const el = this.container().nativeElement;
    if (!chart || el.clientWidth === 0) return null;
    let shot: HTMLCanvasElement;
    try {
      shot = chart.takeScreenshot(true, false);
    } catch {
      return null;
    }
    if (!shot.width || !shot.height) return null;
    const ratio = shot.width / el.clientWidth;
    const BAND = 28;
    const out = document.createElement('canvas');
    out.width = shot.width;
    out.height = shot.height + Math.round(BAND * ratio);
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const p = this.palette(this.theme.theme() === 'dark');
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(shot, 0, Math.round(BAND * ratio));
    ctx.scale(ratio, ratio);

    const font = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
    ctx.fillStyle = p.text;
    ctx.font = `600 13px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 10, BAND / 2);
    const stamp = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    ctx.font = `12px ${font}`;
    ctx.textAlign = 'right';
    ctx.fillText(stamp, el.clientWidth - 10, BAND / 2);
    ctx.textAlign = 'left';

    // The scripts' tables, where they sit over their panes.
    const measure = (text: string, cellFont: string) => {
      ctx.font = cellFont;
      return ctx.measureText(text).width;
    };
    for (const pane of this.scriptTables())
      for (const table of pane.tables)
        paintTable(
          ctx,
          placeTable(table, pane.width, pane.height, measure),
          pane.left,
          BAND + pane.top,
        );

    paintLegend(ctx, this.legendRuns(p.text), 12, BAND + 8, `12px ${font}`, 18);
    return out;
  }

  /** The legend as text runs: prices in the bar's colour, then each study's values in theirs. */
  private legendRuns(ink: string): LegendRun[][] {
    const s = this.lastSnapshot;
    if (!s || s.close === null || s.open === null) return [];
    const dp = this.precision();
    const tone = s.close >= s.open ? '#089981' : '#F23645';
    const price = (v: number | null) => (v === null ? '—' : v.toFixed(dp));
    const change = changeText(s.change ?? null, s.changePct, this.pipSize() ?? pipSizeFor(dp), dp);
    const lines: LegendRun[][] = [
      [
        { text: `O ${price(s.open)}`, color: tone },
        { text: `H ${price(s.high)}`, color: tone },
        { text: `L ${price(s.low)}`, color: tone },
        { text: `C ${price(s.close)}`, color: tone },
        ...(change ? [{ text: change, color: tone }] : []),
        { text: `Vol ${formatVolume(s.volume)}`, color: ink },
      ],
    ];
    for (const ind of s.indicators)
      lines.push([
        { text: ind.label, color: ink },
        ...ind.values.map((v) => ({
          text: v.value === null ? '—' : v.value.toFixed(Math.min(dp, 4)),
          color: v.color,
        })),
      ]);
    return lines;
  }

  /**
   * The chart's data as rows for a CSV export (CC-I7): each plotted bar's UTC time and prices, then
   * every value the data window lists for it — the studies' plots, and the scripts' once pine-chart
   * registers them — one column per value, named "Section · value".
   */
  exportRows(): (string | number | null)[][] {
    const columns: string[] = [];
    const index = new Map<string, number>();
    const body: (string | number | null)[][] = [];
    const precision = this.precision();
    this.plotted.forEach((bar, i) => {
      const utcTime = this.plottedUtc[i]?.time ?? bar.time;
      const values = new Map<number, string | number | null>();
      for (const section of this.valueProviders.collect({ index: i, bar, utcTime, precision })) {
        if (section.id === 'bar') continue;
        for (const row of section.rows) {
          const name = `${section.title} · ${row.label}`;
          let col = index.get(name);
          if (col === undefined) {
            col = columns.length;
            columns.push(name);
            index.set(name, col);
          }
          values.set(col, row.raw !== undefined ? row.raw : row.value);
        }
      }
      body.push([
        new Date(utcTime).toISOString(),
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        ...columns.map((_, c) => values.get(c) ?? null),
      ]);
    });
    const header = ['time (UTC)', 'open', 'high', 'low', 'close', 'volume', ...columns];
    // Rows written before a column first appeared are shorter: pad them to the header.
    return [header, ...body.map((r) => [...r, ...new Array(header.length - r.length).fill(null)])];
  }

  /** Price at a y offset inside the chart, for click-to-act features. */
  priceAtY(y: number): number | null {
    return this.price?.coordinateToPrice(y) ?? null;
  }

  /**
   * Primitives other features hang on the price series (the chart alert lines). Kept here so they are re-attached
   * every time the series is rebuilt (style change, new bars) — primitives live on the series, not the chart.
   */
  private readonly extraPricePrimitives = new Set<ISeriesPrimitive<Time>>();

  /** Attach `primitive` to the price series, now and after every rebuild. Returns the detach function. */
  attachPricePrimitive(primitive: ISeriesPrimitive<Time>): () => void {
    this.extraPricePrimitives.add(primitive);
    this.price?.attachPrimitive(primitive);
    return () => {
      this.extraPricePrimitives.delete(primitive);
      try {
        this.price?.detachPrimitive(primitive);
      } catch {
        /* the series it was on has been replaced */
      }
    };
  }

  /**
   * Fit the price axis to the visible data, leaving the time window — and the scale's mode: log,
   * percent, indexed — alone (TradingView's "auto"; CC-19: it used to switch the mode to normal).
   */
  autoScalePrice(): void {
    this.chart?.priceScale(this.scaleSide()).applyOptions({ autoScale: true });
    this.checkAutoScale();
  }

  /** Reset both scales to fit the data, as double-clicking the axis does. */
  resetScales(): void {
    this.chart?.timeScale().fitContent();
    this.autoScalePrice();
  }

  private sizeToContainer(el: HTMLElement): void {
    if (!this.chart) return;
    const { clientWidth, clientHeight } = el;
    if (clientWidth > 0 && clientHeight > 0) {
      this.chart.resize(clientWidth, clientHeight);
    }
  }

  /** Called by the page once new history has been prepended. */
  historyLoaded(): void {
    this.loadMorePending.set(false);
  }

  /** The key the plotted bars were last built under (series, style, zone, theme, box). */
  private plotKey: string | null = null;

  /**
   * Keep every series drawn from the bars in step with them, by the least the chart has to redraw
   * (CC-I1).
   *
   * <ul>
   *   <li>A tick or a minute resync changes the newest bar or two: the plotted bars are redone from
   *       the first bar that changed (`PlottedBars`), and each series is written from there — one
   *       `update()` of the forming bar on the price, volume and study series, nothing re-sent.</li>
   *   <li>A new series (`dataKey`), style, time zone, theme or box size, or history loaded on the
   *       left: every bar is redone and re-sent, and what hangs off the bars (studies, markers,
   *       scripts) is redrawn. Only a style change replaces the price series — its type is
   *       structural in Lightweight Charts — and the new one is added before the old goes, so the
   *       price pane never empties (CC-03).</li>
   * </ul>
   *
   * <p>Scripts are re-rendered on a rebuild and when their results change, never on a tick (the
   * contract with pine-chart): their `barcolor()` is in the price rows, so the forming bar keeps its
   * colour through `update()`.</p>
   */
  private syncData(): void {
    const chart = this.chart;
    if (!chart) return;
    const raw = this.bars();
    const style = this.style();
    const zone = this.timezone();
    const dark = this.theme.theme() === 'dark';
    const series = this.dataKey() || `${this.symbol()}|${this.resolution()}`;
    const unit = PRICE_BASED.has(style) ? this.boxUnitFor(raw, series, style) : null;
    // What else a price-based style is built with: Renko's wicks, Line break's lines.
    const shape =
      style === 'renko'
        ? `wicks:${this.renkoWicks()}`
        : style === 'line-break'
          ? `lines:${this.lineBreakLines()}`
          : '';
    const key = `${series}|${style}|${zone}|${dark ? 'dark' : 'light'}|${unit ?? ''}|${shape}`;
    // Another of the effect's inputs re-ran it with nothing changed.
    if (raw === this.plotter.raw && key === this.plotKey) return;

    const update = this.plotter.update(
      raw,
      key,
      this.plotTransform(style, unit ?? 0),
      zone === 'UTC' ? null : (t) => this.timezoneShiftMs(t),
    );
    this.plotKey = key;
    this.plotted = this.plotter.plotted;
    this.plottedUtc = this.plotter.utc;
    this.utcByPlotted = null;
    this.dataVersion++;
    this.studyBarsCache = null;
    // Before the series are written: the time scale weighs and labels their times by these.
    this.labelTradingDates(raw, update);

    const replaced = this.ensurePriceSeries(style);
    const full = update.rebuild || replaced;
    if (full) {
      // The scripts' colours on these bars, from the runs on the chart now (pine-chart's handles
      // read no chart state); the re-render below brings any change with it.
      this.barColors = this.scriptBarColors(style, this.plotted);
      if (style === 'baseline') this.applyBaseline();
    }
    this.priceStyle = style;
    this.writePriceRows(full ? 0 : update.from);
    this.writeVolumeRows(full ? 0 : update.from);

    if (full) {
      const active = this.indicators();
      this.applyIndicators(active, 0);
      this.applyPatterns(active);
      this.applyProfiles(active);
      this.recomputeAnalysis();
      this.applyMarkers(this.markers());
      this.writeExternalPanes(0);
      this.applyScripts();
      this.adoptRepaintedRows();
    } else {
      this.applyIndicators(this.indicators(), update.from);
      this.writeExternalPanes(update.from);
      // A bar opened (or replay moved): markers outside the range may be in it now.
      if (this.markersFor !== this.markerRangeKey()) this.applyMarkers(this.markers());
      this.scheduleTailStudies();
    }
    if (full || this.breaksFor !== this.plottedUtc.length) {
      this.breaksFor = this.plottedUtc.length;
      this.syncSessionBreaks();
    }
    this.tickCountdown();
    this.syncLastValueLabel();
    this.emitLegend();
  }

  /** The bar count the session breaks were last found for: a tick changes no day. */
  private breaksFor = -1;

  /** How the bars of `style` are plotted; `unit` is a price-based style's box. */
  private plotTransform(style: ChartStyle, unit: number): PlotTransform {
    if (style === 'heikin-ashi') return { kind: 'heikin-ashi' };
    if (!PRICE_BASED.has(style)) return { kind: 'none' };
    return { kind: 'full', build: (raw) => this.priceBasedBars(raw as Bar[], style, unit) };
  }

  /**
   * The price-based styles' box in price (CC-I10). By ATR: `boxSizeAtr` × ATR(14) of the bars that
   * had CLOSED when the series loaded (`boxBase`), kept until the series, the style or the multiplier
   * changes (CC-16) — re-measured per tick it moved with the forming bar and redrew every brick. By
   * pips ("Traditional"): `boxPips` pips, the same on every timeframe.
   */
  private boxUnitFor(raw: readonly Bar[], series: string, style: ChartStyle): number {
    const method = this.boxMethod();
    const opts = {
      method,
      bars: raw,
      atrMultiple: this.boxSizeAtr(),
      pips: this.boxPips(),
      pipSize: this.pipSize() ?? pipSizeFor(this.precision()),
    };
    if (method === 'pips') return boxUnit(opts);
    const key = `${series}|${style}|${this.boxSizeAtr()}`;
    if (this.box?.key === key) return this.box.unit;
    const unit = boxUnit(opts);
    // Not remembered before the bars arrive: the first real ones measure it.
    if (raw.length > 0) this.box = { key, unit };
    return unit;
  }

  /**
   * Rebuild the bar array for styles that are not time-based, with a box of `unit` (price).
   *
   * By ATR, brick and box sizes follow the timeframe: a 10-pip brick is reasonable on EURUSD H1 and
   * absurd on the same pair's D1. Line break takes no box: a reversal breaks `lineBreakLines` lines.
   */
  private priceBasedBars(bars: Bar[], style: ChartStyle, unit: number): Bar[] {
    if (bars.length === 0) return [];
    if (style === 'line-break')
      return toLineBreak(bars, Math.max(1, Math.round(this.lineBreakLines())));
    if (!(unit > 0)) return [];
    switch (style) {
      case 'renko':
        return toRenko(bars, unit, { wicks: this.renkoWicks() });
      case 'pnf':
        return toPointAndFigure(bars, unit, 3);
      case 'kagi':
        // The reversal amount is the box: ATR(14) at the default multiplier, TradingView's default.
        return toKagi(bars, unit);
      case 'range':
        return toRangeBars(bars, unit);
      default:
        return bars;
    }
  }

  /** The trading dates the time scale labels 1D/1W/1M bars by: all of them on a rebuild, else the changed tail. */
  private labelTradingDates(raw: readonly Bar[], update: PlotUpdate): void {
    const chart = this.chart;
    if (!chart) return;
    const resolution = this.resolution();
    const shift = (t: number) => this.timezoneShiftMs(t);
    if (update.rebuild) {
      this.tradingDates = tradingDatesByPlottedTime(raw, resolution, shift);
    } else {
      for (const [seconds, date] of tradingDatesByPlottedTime(
        raw.slice(update.fromRaw),
        resolution,
        shift,
      ))
        this.tradingDates.set(seconds, date);
    }
    if (this.labelsFor !== resolution) {
      this.labelsFor = resolution;
      // The library caches tick labels by time: re-setting the formatter clears them, so a switch
      // to or from 1D/1W/1M relabels every tick.
      chart.applyOptions({ timeScale: { tickMarkFormatter: this.tickMarkFormatter } });
    }
  }

  /**
   * Make the price series the one `style` needs. A style change REPLACES it (series type is part of
   * the chart's structure, not an option); everything hung on it — drawings, overlays, alert lines,
   * profiles, markers — moves to the new one. Returns whether it was replaced.
   */
  private ensurePriceSeries(style: ChartStyle): boolean {
    const chart = this.chart;
    if (!chart || (this.price && this.seriesStyle === style)) return false;
    const old = this.price;
    const next = this.createPriceSeries(chart, style);
    next.applyOptions({ priceScaleId: this.scaleSide() });
    this.price = next;
    this.seriesStyle = style;
    this.priceSync.attach(next as unknown as SyncTarget<PriceRow>);
    // Added before the old one goes, so pane 0 is never empty in between (CC-03); just above the
    // volume overlay, so studies draw over the candles as TradingView draws them.
    if (old) {
      try {
        chart.removeSeries(old);
      } catch {
        // Went with a rebuilt chart.
      }
    }
    next.setSeriesOrder(this.volume ? 1 : 0);
    this.attachToPriceSeries();
    return true;
  }

  /** A new price series for `style`, empty — {@link writePriceRows} fills it. */
  private createPriceSeries(chart: IChartApi, style: ChartStyle): PriceSeries {
    const p = this.palette(this.theme.theme() === 'dark');
    const precision = this.precision();
    const priceFormat = { type: 'price' as const, precision, minMove: 1 / 10 ** precision };
    // TradingView's last-price line: dotted, in the series colour (the
    // library colours it per the last bar's direction for OHLC series), with
    // the value chip on the axis.
    const lastPrice = {
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1 as const,
    };
    switch (style) {
      case 'line':
      case 'kagi':
        return chart.addSeries(LineSeries, {
          color: style === 'kagi' ? '#787B86' : p.line,
          lineWidth: 2,
          priceFormat,
          ...lastPrice,
        });
      case 'stepline':
        return chart.addSeries(LineSeries, {
          color: p.line,
          lineWidth: 2,
          lineType: 1, // with-steps
          priceFormat,
          ...lastPrice,
        });
      case 'line-markers':
        return chart.addSeries(LineSeries, {
          color: p.line,
          lineWidth: 2,
          pointMarkersVisible: true,
          priceFormat,
          ...lastPrice,
        });
      case 'area':
        return chart.addSeries(AreaSeries, {
          lineColor: p.line,
          topColor: 'rgba(41,98,255,0.28)',
          bottomColor: 'rgba(41,98,255,0)',
          priceFormat,
          ...lastPrice,
        });
      case 'hlc-area':
        // TradingView's HLC area: the high and low lines, the close, and the bands between them
        // (custom-series.ts). It was the Area series under another name until 2026-10 (CC-23).
        return chart.addCustomSeries(new HlcAreaSeries(), {
          upColor: p.up,
          downColor: p.down,
          priceFormat,
          ...lastPrice,
        });
      case 'baseline':
        return chart.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: this.baselinePrice() },
          topLineColor: p.up,
          topFillColor1: 'rgba(8,153,129,0.28)',
          topFillColor2: 'rgba(8,153,129,0.05)',
          bottomLineColor: p.down,
          bottomFillColor1: 'rgba(242,54,69,0.05)',
          bottomFillColor2: 'rgba(242,54,69,0.28)',
          lineWidth: 2,
          priceFormat,
          ...lastPrice,
        });
      case 'bars':
      case 'hlc-bars':
        // Dropping the open tick is what makes a bar series HLC bars. True
        // HiLo (no ticks at all) is the custom series below.
        return chart.addSeries(BarSeries, {
          upColor: p.up,
          downColor: p.down,
          openVisible: style !== 'hlc-bars',
          thinBars: style !== 'hlc-bars',
          priceFormat,
          ...lastPrice,
        });
      case 'hilo':
      case 'vol-candle':
        // The two styles with no built-in series: HiLo draws the range with
        // neither tick, and VolCandle varies body width by volume. Both are
        // custom series — see custom-series.ts.
        return chart.addCustomSeries(style === 'hilo' ? new HiLoSeries() : new VolCandleSeries(), {
          upColor: p.up,
          downColor: p.down,
          priceFormat,
          ...lastPrice,
        });
      case 'column':
        return chart.addSeries(HistogramSeries, { color: p.up, priceFormat, ...lastPrice });
      default: {
        const hollow = style === 'hollow';
        return chart.addSeries(CandlestickSeries, {
          upColor: hollow ? 'rgba(0,0,0,0)' : p.up,
          downColor: hollow ? 'rgba(0,0,0,0)' : p.down,
          borderUpColor: p.up,
          borderDownColor: p.down,
          wickUpColor: p.up,
          wickDownColor: p.down,
          priceFormat,
          ...lastPrice,
        });
      }
    }
  }

  /**
   * TradingView's baseline defaults to the price at 50% of the visible price range. Lightweight
   * Charts' base value is a fixed price, so the midpoint of the loaded bars' high/low range stands
   * in for it.
   */
  private baselinePrice(): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of this.plotted) {
      lo = Math.min(lo, b.low);
      hi = Math.max(hi, b.high);
    }
    return this.plotted.length ? (lo + hi) / 2 : 0;
  }

  /** Re-centre the baseline on new bars (another series, history loaded). */
  private applyBaseline(): void {
    if (this.seriesStyle !== 'baseline') return;
    (this.price as unknown as ISeriesApi<'Baseline'> | null)?.applyOptions({
      baseValue: { type: 'price', price: this.baselinePrice() },
    });
  }

  /**
   * Everything that lives on the price series rather than the chart, onto the price series: drawings,
   * trade overlays, analysis, economic events, patterns, the bar countdown, other features' primitives
   * (alert lines), the profile studies and the markers. After every replacement of the series.
   */
  private attachToPriceSeries(): void {
    if (!this.price) return;
    this.controller.bindSeries(this.price);
    this.controller.sync(
      this.drawings.forScope(this.symbol(), this.resolution()),
      this.drawings.selectedId(),
    );
    this.price.attachPrimitive(this.overlayRenderer);
    this.price.attachPrimitive(this.analysisRenderer);
    this.price.attachPrimitive(this.eventRenderer);
    this.price.attachPrimitive(this.patternRenderer);
    this.price.attachPrimitive(this.countdown);
    this.price.attachPrimitive(this.sessionBreaksRenderer);
    for (const primitive of this.extraPricePrimitives) this.price.attachPrimitive(primitive);
    for (const r of this.profileRenderers.values()) this.price.attachPrimitive(r);
    this.lastValueColor = ''; // a new series starts on the library's own colouring
    this.markerApi = createSeriesMarkers(this.price, []);
    this.markersFor = '';
  }

  /** The palette's bar colours (the same in both themes). */
  private rowPalette(): RowPalette {
    return this.palette(this.theme.theme() === 'dark');
  }

  /**
   * Write the price rows from plotted bar `from` on (0: all), with the scripts' colours. New colours
   * rebuild every row: the colour is part of each.
   */
  private writePriceRows(from: number): void {
    const style = this.seriesStyle;
    if (!this.price || !style) return;
    const colors = this.barColors;
    const all = from === 0 || colors !== this.rowsColors;
    const rows = priceRowsFrom(
      style,
      this.plotted,
      colors,
      this.rowPalette(),
      all ? 0 : from,
      this.priceSync.rows(),
    );
    this.rowsColors = colors;
    this.priceSync.apply(rows);
  }

  /**
   * The scripts re-painted the price series (pine-chart's `refreshBarColors`, from `applyScripts`):
   * it holds this chart's plotted bars in the scripts' new colours. Take those rows as written, so
   * the next tick is diffed against what is really on the series.
   */
  private adoptRepaintedRows(): void {
    const style = this.seriesStyle;
    if (!this.price || !style || this.barColors === this.rowsColors) return;
    this.priceSync.adopt(
      priceRowsFrom(style, this.plotted, this.barColors, this.rowPalette(), 0, []),
    );
    this.rowsColors = this.barColors;
  }

  private writeVolumeRows(from: number): void {
    if (!this.volume) return;
    this.volumeSync.apply(
      volumeRowsFrom(this.plotted, this.rowPalette(), from, this.volumeSync.rows()),
    );
  }

  /** Volume on or off: its series is added or removed, never re-made on a tick. */
  private syncVolumeSeries(show: boolean): void {
    const chart = this.chart;
    if (!chart) return;
    if (show && !this.volume) {
      this.volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        // The overlay's own last value ("17") and price line belong to no price scale anyone reads,
        // and sat on the price axis among the prices (CC-08).
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // Pin volume to the bottom fifth of the price pane, the way TradingView
      // overlays it, rather than giving it a pane and halving the chart.
      this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      // Behind the candles.
      this.volume.setSeriesOrder(0);
      this.volumeSync.attach(this.volume as unknown as SyncTarget<VolumeRow>);
      this.writeVolumeRows(0);
    } else if (!show && this.volume) {
      try {
        chart.removeSeries(this.volume);
      } catch {
        // Went with a rebuilt chart.
      }
      this.volume = null;
      this.volumeSync.attach(null);
    }
  }

  /** The symbol's decimals on the price scale and every study drawn on it. */
  private applyPrecision(precision: number): void {
    const priceFormat = { type: 'price' as const, precision, minMove: 1 / 10 ** precision };
    this.price?.applyOptions({ priceFormat });
    for (const s of this.indicatorSeries)
      if (s.overlay) for (const plot of s.series) plot.api.applyOptions({ priceFormat });
  }

  /** What the markers were last pinned to: the bar count and the newest bar. */
  private markersFor = '';
  private markerRangeKey(): string {
    const last = this.plottedUtc[this.plottedUtc.length - 1];
    return `${this.plottedUtc.length}|${last?.time ?? ''}|${this.lastBarEnd()}`;
  }

  /**
   * When the newest input bar's period ends (UTC ms): the session grid says so per bar; on the stored
   * grid it is a fixed width. Markers and events past it are outside the loaded range — in replay,
   * past the head.
   */
  private lastBarEnd(): number {
    const raw = this.bars();
    const last = raw[raw.length - 1];
    if (!last) return -Infinity;
    if (last.closeTime !== undefined && Number.isFinite(last.closeTime)) return last.closeTime;
    const step = resolutionMs(this.resolution());
    return step ? last.time + step : Infinity;
  }

  /**
   * After ticks, the studies that scan the whole window (patterns, profiles, the analysis overlays)
   * are recomputed once the ticks pause for 400 ms — not on each — and only when one is on.
   */
  private tailStudiesTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleTailStudies(): void {
    if (this.tailStudiesTimer !== null) return;
    const scanning =
      this.indicators().some((a) => a.visible && studyKind(a.defId) !== 'indicator') ||
      this.showVolumeProfile() ||
      this.showSupportResistance() ||
      this.showStructure();
    if (!scanning) return;
    this.tailStudiesTimer = setTimeout(() => {
      this.tailStudiesTimer = null;
      const active = this.indicators();
      this.applyPatterns(active);
      this.applyProfiles(active);
      this.recomputeAnalysis();
    }, 400);
  }

  /**
   * Bar markers for signals, fills and martingale rungs.
   *
   * Pinned to the bar the instant belongs to — the last plotted bar that opened at or before it, on
   * the bars' UTC times — and drawn at that bar's PLOTTED time, so they follow the display time zone
   * like the bars do (CC-05: they sat on UTC times, four H1 bars late on a New York axis). An instant
   * before the first bar or after the end of the last is dropped rather than stacked on the edge bar
   * (CC-06) — in replay, that is everything after the head.
   */
  private applyMarkers(markers: ChartMarker[]): void {
    if (!this.markerApi) return;
    const utc = this.plottedUtc;
    const plotted = this.plotted;
    this.markersFor = this.markerRangeKey();
    if (utc.length === 0) {
      this.markerApi.setMarkers([]);
      return;
    }
    const lastEnd = this.lastBarEnd();
    const pinned: SeriesMarker<Time>[] = [];
    for (const m of markers) {
      const i = barContaining(utc, m.time, lastEnd);
      if (i < 0) continue;
      pinned.push({
        time: asTime(plotted[i].time),
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      });
    }
    pinned.sort((a, b) => (a.time as number) - (b.time as number));
    this.markerApi.setMarkers(pinned);
  }

  /** The studies of `active`: their series, the patterns and the profiles. */
  private applyStudies(active: ActiveIndicator[]): void {
    // The bars' times are unchanged here: each plot is rewritten from its first changed value.
    this.applyIndicators(active, this.plotted.length);
    this.applyPatterns(active);
    this.applyProfiles(active);
  }

  /**
   * Keep every visible study's series in step (CC-I1): values are recomputed (cached per change of
   * the bars), and each plot is written from the first bar whose value — or time — changed: a tick
   * is an `update()` of the forming bar's value, not every value re-sent. `timesFrom`: the first
   * plotted bar whose TIME changed (0 on a rebuild).
   */
  private applyIndicators(active: ActiveIndicator[], timesFrom: number): void {
    if (!this.chart) return;

    // Drop series for indicators that are gone or hidden, or whose inputs moved them to another
    // place (an overlay never becomes a pane study, but a removed-and-re-added uid could).
    const wanted = new Set(active.filter((a) => a.visible).map((a) => a.uid));
    for (const held of [...this.indicatorSeries]) {
      if (!wanted.has(held.uid)) this.removeIndicatorSeries(held);
    }

    const bars = this.studyBars();
    for (const item of active) {
      if (!item.visible) continue;
      const def = indicatorById(item.defId);
      if (!def) continue;
      const computed = this.computeFor(item, def, bars);
      const target =
        this.indicatorSeries.find((s) => s.uid === item.uid) ??
        this.createIndicatorSeries(item, def);
      if (!target) continue;
      target.paramsKey = JSON.stringify(item.params);

      for (const s of target.series) {
        const values = computed[s.key] ?? [];
        const from = Math.min(timesFrom, firstChangedValue(s.values, values));
        s.values = values;
        s.sync.apply(valueRowsFrom(this.plotted, values, s.gaps, from, s.sync.rows()));
        if (s.markers) this.writePlotMarkers(s, values);
      }
    }

    this.emitLegend();
  }

  /** A `markers` plot's shapes: one per bar with a value, at that value. */
  private writePlotMarkers(s: IndicatorPlotSeries, values: readonly Maybe[]): void {
    const markers = s.markers;
    if (!markers) return;
    const out: SeriesMarker<Time>[] = [];
    for (let i = 0; i < this.plotted.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      out.push({
        time: asTime(this.plotted[i].time),
        position: markers.spec.position === 'above' ? 'atPriceTop' : 'atPriceBottom',
        price: v,
        shape: markers.spec.shape,
        color: s.color,
        size: 0.6,
      });
    }
    // Most ticks leave every fractal where it was.
    const key = out.map((m) => `${m.time as number}:${m.price}`).join(',');
    if (key === markers.last) return;
    markers.last = key;
    markers.api.setMarkers(out);
  }

  /** The plotted bars as the study maths takes them, made once per change of the bars. */
  private studyBarsCache: Ohlc[] | null = null;
  private studyBars(): Ohlc[] {
    return (this.studyBarsCache ??= ohlcOf(this.plotted));
  }

  /** Each study's values per change of the bars ({@link dataVersion}), inputs and context. */
  private computedCache = new Map<string, Record<string, Maybe[]>>();
  private computedFor = -1;

  private computeFor(
    item: ActiveIndicator,
    def: IndicatorDef,
    ohlc: Ohlc[],
  ): Record<string, Maybe[]> {
    if (this.computedFor !== this.dataVersion) {
      this.computedCache.clear();
      this.computedFor = this.dataVersion;
    }
    // Compare studies also depend on the other symbol's bars, so those are part of the key; the
    // day-based ones, on the trading days they count in.
    const symbol = def.needsCompare ? String(item.params['symbol'] ?? '').toUpperCase() : '';
    const compare = symbol ? this.compareBars()[symbol] : undefined;
    const cacheKey = `${item.uid}:${JSON.stringify(item.params)}:${symbol}:${compare?.length ?? 0}:${compare?.[compare.length - 1]?.close ?? ''}:${this.sessionKey()}`;
    const hit = this.computedCache.get(cacheKey);
    if (hit) return hit;
    const computed = def.compute(ohlc, item.params, {
      // Same zone shift as the plotted bars, or alignByTime would pair the wrong bars.
      ...(compare ? { compareBars: this.shiftForTimezone(compare, this.timezone()) } : {}),
      tradingDay: this.plottedDayOf(),
    });
    this.computedCache.set(cacheKey, computed);
    return computed;
  }

  /** External panes' lines by pane uid: made once, kept across ticks (CC-02). */
  private readonly externalSeries = new Map<string, ExternalLineSeries[]>();

  /**
   * The fundamentals panes. A pane is made when its study arrives and removed when it goes; its
   * series stay in between, so a resized pane keeps its height and its place (CC-02: every tick
   * removed and re-added them at the bottom at their default height, and a saved layout's heights
   * were overwritten). New points re-sample the line; the bars reach it through syncData.
   */
  private applyExternalPanes(panes: ExternalPane[]): void {
    const chart = this.chart;
    if (!chart) return;
    const byUid = new Map(panes.map((p) => [p.uid, p]));
    for (const [uid, lines] of [...this.externalSeries]) {
      const pane = byUid.get(uid);
      if (pane && pane.lines.length === lines.length) continue;
      for (const l of lines) {
        try {
          chart.removeSeries(l.api);
        } catch {
          // Went with a rebuilt chart.
        }
      }
      this.externalSeries.delete(uid);
    }
    for (const pane of panes) {
      let lines = this.externalSeries.get(pane.uid);
      if (!lines) {
        const paneIndex = chart.panes().length;
        lines = pane.lines.map((line) => {
          const api = chart.addSeries(
            LineSeries,
            {
              color: line.color,
              lineWidth: 2,
              // Policy rates, swaps and roll-ups are step functions: a value holds until the next.
              lineType: LineType.WithSteps,
              priceLineVisible: false,
              title: line.title,
              priceFormat: {
                type: 'price',
                precision: line.precision ?? 2,
                minMove: 10 ** -(line.precision ?? 2),
              },
            },
            paneIndex,
          );
          return {
            api,
            sync: new SeriesSync<ValueRow>(api as unknown as SyncTarget<ValueRow>, sameValueRow),
            points: [],
            values: [],
          };
        });
        this.externalSeries.set(pane.uid, lines);
      }
      pane.lines.forEach((line, i) => {
        const held = lines[i];
        held.api.applyOptions({ color: line.color, title: line.title });
        if (held.points !== line.points) {
          held.points = line.points;
          this.writeExternalLine(held, 0);
        }
      });
    }
  }

  /** Every external line, written from plotted bar `from` on (the bars changed). */
  private writeExternalPanes(from: number): void {
    for (const lines of this.externalSeries.values())
      for (const l of lines) this.writeExternalLine(l, from);
  }

  /**
   * One external line, sampled onto the chart's own bars: every distinct time a series carries
   * becomes a slot on the SHARED time axis, so a feed with its own cadence (news roll-ups every few
   * minutes) would otherwise wedge thousands of slots between the bars and squash them.
   */
  private writeExternalLine(l: ExternalLineSeries, timesFrom: number): void {
    const values = alignToBars(l.points, this.plottedUtc);
    const from = Math.min(timesFrom, firstChangedValue(l.values, values));
    l.values = values;
    l.sync.apply(valueRowsFrom(this.plotted, values, 'join', from, l.sync.rows()));
  }

  /**
   * The Pine scripts drawn on this chart, by key (PC-04/PC-I3): persistent renderers whose panes
   * and anchors live as long as their script, synced by {@link applyScripts}.
   */
  private readonly scriptLayers = new ScriptLayers(
    {
      chart: () => this.chart,
      price: () => this.price,
      shiftMs: (ms) => this.timezoneShiftMs(ms),
      hostTimes: () => {
        const plotted = this.plotted;
        return { length: plotted.length, at: (i) => Math.floor(plotted[i].time / 1000) };
      },
      priceSide: () => this.scaleSide(),
    },
    (result) => scriptRenderModel(result, this.precision()),
  );
  /** Pine tables of the runs on the chart, one entry per pane, placed over that pane's plot area. */
  readonly scriptTables = signal<
    {
      key: string;
      top: number;
      left: number;
      width: number;
      height: number;
      tables: readonly TableLayout[];
    }[]
  >([]);
  private paneObserver: ResizeObserver | null = null;
  private tablesFrame = 0;

  /** Re-place the script tables (after a render, a resize, or a pane being dragged taller). */
  private layoutScriptTables(): void {
    cancelAnimationFrame(this.tablesFrame);
    this.tablesFrame = requestAnimationFrame(() => {
      const chart = this.chart;
      const byPane = new Map<number, TableLayout[]>();
      for (const h of this.scriptLayers.list())
        for (const p of h.tables())
          byPane.set(p.paneIndex, [...(byPane.get(p.paneIndex) ?? []), ...p.tables]);
      if (!chart || byPane.size === 0) {
        if (this.scriptTables().length) this.scriptTables.set([]);
        return;
      }
      const host = this.container().nativeElement.getBoundingClientRect();
      let left = 0;
      try {
        left = chart.priceScale('left').width();
      } catch {
        left = 0;
      }
      const panes = chart.panes();
      const out: ReturnType<typeof this.scriptTables> = [];
      for (const [index, tables] of byPane) {
        const pane = panes[index];
        if (!pane) continue;
        const r = pane.getHTMLElement()?.getBoundingClientRect();
        const size = chart.paneSize(index);
        out.push({
          key: `pane-${index}`,
          top: r ? r.top - host.top : 0,
          left,
          width: size.width,
          height: size.height,
          tables,
        });
      }
      this.scriptTables.set(out);
      // Pane separators can be dragged with no chart event; watch the pane rows themselves.
      this.paneObserver?.disconnect();
      this.paneObserver ??= new ResizeObserver(() => this.layoutScriptTables());
      for (const p of panes) {
        const row = p.getHTMLElement();
        if (row) this.paneObserver.observe(row);
      }
    });
  }

  /**
   * Bring the Pine scripts on the chart in line with `layers` (default: the input) by the least
   * change (ScriptLayers): cheap and idempotent, so the chart may call it on every rebuild — a new
   * series, style, zone, theme or history — and on every change of the results. Scripts that stay
   * keep their panes, heights and anchors; only their drawings take the new result.
   */
  applyScripts(layers: readonly ChartScriptLayer[] = this.scriptResults()): void {
    if (!this.chart || !this.price) return;
    this.watchScriptEvents();
    // In the order the scripts were added: a later script's barcolor() wins (mergeBarColors).
    this.scriptLayers.sync(layers);
    this.syncScriptAxes();
    this.refreshBarColors();
    this.syncScriptMargin();
    this.layoutScriptTables();
  }

  /** The tooltip of the script drawing under the pointer (PC-10): a label's `tooltip`, a fill's. */
  readonly scriptTip = signal<ScriptTooltip | null>(null);
  /** The chart whose pointer events the scripts follow (a rebuilt chart is followed again). */
  private scriptEventsChart: IChartApi | null = null;

  private watchScriptEvents(): void {
    const chart = this.chart;
    if (!chart || chart === this.scriptEventsChart) return;
    this.scriptEventsChart = chart;
    chart.subscribeCrosshairMove((param) => this.onScriptPointer(param));
    chart.subscribeClick((param) => this.onScriptClick(param));
  }

  /**
   * The drawing under the pointer, by the regions the scripts' primitives recorded as they painted
   * (pane-relative px). They were collected for this but never read: tooltips never showed (PC-10).
   */
  private scriptHitAt(param: MouseEventParams<Time>): ScriptHit | null {
    if (!param.point || param.paneIndex === undefined || this.scriptLayers.size === 0) return null;
    return topHit(this.scriptLayers.list(), param.paneIndex, param.point.x, param.point.y);
  }

  private onScriptPointer(param: MouseEventParams<Time>): void {
    const found = this.scriptHitAt(param);
    let tip: ScriptTooltip | null = null;
    if (found && param.point && param.paneIndex !== undefined) {
      const el = this.container().nativeElement;
      const row = this.chart?.panes()[param.paneIndex]?.getHTMLElement();
      const paneTop = row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : 0;
      tip = placeTooltip(
        found.hit.tooltip,
        param.point.x,
        paneTop + param.point.y,
        el.clientWidth,
        el.clientHeight,
      );
    }
    const cur = this.scriptTip();
    if (cur?.text !== tip?.text || cur?.left !== tip?.left || cur?.top !== tip?.top)
      this.scriptTip.set(tip);
  }

  private onScriptClick(param: MouseEventParams<Time>): void {
    // An armed drawing tool owns clicks.
    if (this.tool() !== null) return;
    const found = this.scriptHitAt(param);
    if (found?.hit.trades?.length)
      this.scriptTradeClick.emit({ key: found.key, trades: found.hit.trades });
  }

  /** The price axes the scripts' own scales are on (`scale.left` / `scale.right`, PC-I10). */
  private scriptAxes = new Set<'left' | 'right'>();

  /**
   * Show the price axis on a side a script's own scale is on (`scale.left` while the price is on
   * the right, and the reverse) — and hide it again when no script needs it; the price's own side
   * is the chart's (applyScale). Scripts that follow the chart's side move with it.
   */
  private syncScriptAxes(force = false): void {
    const chart = this.chart;
    if (!chart) return;
    const need = this.scriptLayers.axisSides();
    const side = this.scaleSide();
    const same = need.size === this.scriptAxes.size && [...need].every((s) => this.scriptAxes.has(s));
    if (same && !force) return;
    // Nothing needed now or before: the chart's own scale settings stand as they are.
    if (need.size === 0 && this.scriptAxes.size === 0) return;
    this.scriptAxes = need;
    chart.applyOptions({
      leftPriceScale: { visible: side === 'left' || need.has('left') },
      rightPriceScale: { visible: side === 'right' || need.has('right') },
    });
  }

  /**
   * The price moved sides, or its axes were set again (applyScale): the scripts that follow the
   * chart's side move with it, and the axes their own scales are on stay shown.
   */
  private syncScriptScales(): void {
    if (this.scriptLayers.size === 0 && this.scriptAxes.size === 0) return;
    this.scriptLayers.syncScales();
    this.syncScriptAxes(true);
  }

  /** barcolor() per plotted bar as the price series draws it; null = the style's own colours. */
  private barColors: (string | null)[] | null = null;
  /** The style the price series was built for (the style input can be ahead of it mid-update). */
  private priceStyle: ChartStyle | null = null;

  /**
   * The scripts' barcolor() on `plotted`, a later-added script winning; null when none colours a
   * bar or the style has no time bars of its own to colour ({@link BAR_COLOR_STYLES}).
   */
  private scriptBarColors(style: ChartStyle, plotted: readonly Bar[]): (string | null)[] | null {
    if (!BAR_COLOR_STYLES.has(style) || this.scriptLayers.size === 0) return null;
    const times = plottedSeconds(plotted);
    return mergeBarColors(this.scriptLayers.list().map((h) => h.barColors(times)));
  }

  /**
   * Re-draw the bars when the scripts' colours changed without the bars changing — a run came
   * back, a script was added or removed. A tick goes through applyData, which builds them in.
   */
  private refreshBarColors(): void {
    const style = this.priceStyle;
    if (!this.price || !style || !BAR_COLOR_STYLES.has(style)) return;
    const colors = this.scriptBarColors(style, this.plotted);
    if (sameBarColors(colors, this.barColors)) return;
    this.barColors = colors;
    const rows =
      style === 'hilo' || style === 'vol-candle'
        ? ohlcvRows(this.plotted, colors)
        : ohlcRows(this.plotted, colors, barPaint(style));
    // Same bars, same times: the view and every primitive on the series stay as they are.
    this.price.setData(rows as CandlestickData<Time>[]);
    this.tickCountdown(); // the last bar's colour may have changed with them
    this.syncLastValueLabel();
  }

  /**
   * Room right of the last bar for what the scripts draw ahead of it (labels, lines and boxes in
   * the future, positive plot offsets, and labels' text — a label_left bubble runs its whole width
   * right of its anchor, so labels near the last bar count too): the furthest plus two bars, capped
   * (scriptRightOffset); the default again once nothing reaches past the last bar.
   *
   * <p>It is the time scale's own `rightOffset` that changes, so "scroll to realtime" and "fit"
   * keep the room. The view follows only at the live edge: an operator who scrolled into history,
   * or set the space themselves, keeps their view (marginMovesView), and a layout never saves the
   * margin as their scroll (viewState).</p>
   */
  private syncScriptMargin(): void {
    const scale = this.chart?.timeScale();
    if (!scale) return;
    const { rightOffset: current, barSpacing } = scale.options();
    // Labels' text is px wide, so how many bars it takes depends on the zoom: a zoom re-syncs.
    this.marginSpacing = barSpacing;
    let reach = 0;
    if (this.scriptLayers.size) {
      const times = plottedSeconds(this.plotted);
      for (const h of this.scriptLayers.list())
        reach = Math.max(reach, h.futureBars(times, barSpacing));
    }
    const next = scriptRightOffset(current, reach, marginCap(scale.width(), barSpacing));
    if (next === current) return;
    const position = scale.scrollPosition();
    // Setting the option scrolls to it as well; put a view that is not ours to move back.
    scale.applyOptions({ rightOffset: next });
    if (!marginMovesView(current, next, position)) scale.scrollToPosition(position, false);
  }

  /** The bar spacing the margin was last fitted at. */
  private marginSpacing = 0;
  private marginTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Re-fit the margin once a zoom settles (not on every frame of a pinch or wheel, which would fight
   * the gesture). Pans leave the spacing alone and cost nothing here.
   */
  private scheduleMarginSync(): void {
    const spacing = this.chart?.timeScale().options().barSpacing;
    if (!this.scriptLayers.size || spacing === undefined || spacing === this.marginSpacing) return;
    clearTimeout(this.marginTimer);
    this.marginTimer = setTimeout(() => this.syncScriptMargin(), 150);
  }

  /** Candlestick + chart-pattern studies → the shared pattern renderer. */
  private applyPatterns(active: ActiveIndicator[]): void {
    const bars = this.plotted;
    const studies = active.filter((a) => a.visible && studyKind(a.defId) !== 'indicator');
    const candles = studies.filter((a) => studyKind(a.defId) === 'candle-pattern');
    const charts = studies.filter((a) => studyKind(a.defId) === 'chart-pattern');
    this.patternRenderer.setBars(bars);

    const candleHits = candles.flatMap((a) => {
      const sub = studySubId(a.defId);
      return detectCandlestickPatterns(bars, {
        ids: sub === ALL_PATTERNS ? undefined : [sub],
        trend: (a.params['trend'] as CandleTrendFilter) ?? 'sma50',
      });
    });
    // Two studies can cover the same pattern ("All" plus one specific); mark each bar once.
    const seen = new Set<string>();
    this.patternRenderer.setCandlestickHits(
      candleHits.filter((h) => {
        const k = `${h.index}:${h.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    );

    const chartHits = charts.flatMap((a) => {
      const sub = studySubId(a.defId);
      return detectChartPatterns(bars, {
        ids: sub === ALL_PATTERNS ? undefined : [sub],
        pivotDepth: Number(a.params['pivotDepth'] ?? 5),
        tolerance: Number(a.params['tolerance'] ?? 0.1),
        maxPerType: Number(a.params['maxPerType'] ?? 3),
      });
    });
    const seenChart = new Set<string>();
    this.patternRenderer.setChartPatterns(
      chartHits.filter((h) => {
        const k = `${h.id}:${h.startIndex}:${h.endIndex}`;
        if (seenChart.has(k)) return false;
        seenChart.add(k);
        return true;
      }),
    );
  }

  /**
   * Profile studies. Computed on the UNSHIFTED bars, because session windows are
   * defined on the UTC clock; drawn through `utcToX`, which applies the shift.
   */
  private applyProfiles(active: ActiveIndicator[]): void {
    if (!this.price) return;
    const wanted = active.filter((a) => a.visible && studyKind(a.defId) === 'profile');
    const keep = new Set(wanted.map((a) => a.uid));
    for (const [uid, r] of [...this.profileRenderers]) {
      if (!keep.has(uid)) {
        this.price.detachPrimitive(r);
        this.profileRenderers.delete(uid);
      }
    }
    const bars = this.bars();
    const range = this.chart?.timeScale().getVisibleLogicalRange() ?? null;
    for (const a of wanted) {
      let r = this.profileRenderers.get(a.uid);
      if (!r) {
        r = new ProfileRenderer(() => this.price, this.utcToX);
        this.price.attachPrimitive(r);
        this.profileRenderers.set(a.uid, r);
      }
      r.setModel(
        computeProfileStudy(
          profileIdOf(a.defId),
          bars,
          a.params,
          range ? { from: range.from, to: range.to } : null,
          this.calendar() ?? undefined,
        ),
      );
    }
  }

  /** The visible-range profile follows pans; debounced like the analysis overlays. */
  private profileTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleVisibleProfiles(): void {
    if (!this.indicators().some((a) => a.visible && a.defId === 'profile:vp-visible')) return;
    if (this.profileTimer !== null) clearTimeout(this.profileTimer);
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null;
      this.applyProfiles(this.indicators());
    }, 120);
  }

  private createIndicatorSeries(item: ActiveIndicator, def: IndicatorDef): IndicatorSeries | null {
    const chart = this.chart;
    if (!chart) return null;
    // Overlays live on the price pane (0); everything else gets its own pane,
    // which is what makes RSI and MACD behave like TradingView studies rather
    // than lines squashed onto the price scale.
    const overlay = def.target === 'overlay';
    const paneIndex = overlay ? 0 : chart.panes().length;
    // An overlay shares the price scale; without the symbol's precision the axis
    // falls back to the library default of 2 decimals (1.14 for EURUSD).
    const overlayFormat = overlay
      ? {
          priceFormat: {
            type: 'price' as const,
            precision: this.precision(),
            minMove: 1 / 10 ** this.precision(),
          },
        }
      : {};

    const series = def.plots.map((plot): IndicatorPlotSeries => {
      const markers = plot.kind === 'markers';
      const api =
        plot.kind === 'histogram'
          ? chart.addSeries(
              HistogramSeries,
              { color: plot.color, priceFormat: { type: 'price', precision: 5, minMove: 0.00001 } },
              paneIndex,
            )
          : chart.addSeries(
              LineSeries,
              {
                color: plot.color,
                lineWidth: (plot.lineWidth ?? 2) as DeepPartial<1 | 2 | 3 | 4>,
                priceLineVisible: false,
                lastValueVisible: overlay && !markers,
                // A markers plot draws only its shapes: the series carries the values (for the
                // legend and the autoscale) with no line of its own (DR-17).
                ...(markers ? { lineVisible: false, crosshairMarkerVisible: false } : {}),
                ...overlayFormat,
                // On the price's own scale, whichever side it sits on.
                ...(overlay ? { priceScaleId: this.scaleSide() } : {}),
              },
              paneIndex,
            );
      return {
        key: plot.key,
        api: api as ISeriesApi<'Line' | 'Histogram'>,
        color: plot.color,
        title: plot.title,
        gaps: markers ? 'break' : (plot.gaps ?? 'join'),
        markers:
          markers && plot.marker
            ? {
                api: createSeriesMarkers(api, [], { autoScale: true }),
                spec: plot.marker,
                last: '',
              }
            : null,
        sync: new SeriesSync<ValueRow>(api as unknown as SyncTarget<ValueRow>, sameValueRow),
        values: [],
      };
    });

    // Reference levels (RSI 30/70, MACD zero) as price lines on the first plot.
    if (def.levels?.length && series.length) {
      for (const level of def.levels) {
        series[0].api.createPriceLine({
          price: level.value,
          color: level.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '',
        });
      }
    }

    const entry: IndicatorSeries = {
      uid: item.uid,
      paramsKey: JSON.stringify(item.params),
      overlay,
      series,
    };
    this.indicatorSeries.push(entry);
    return entry;
  }

  private removeIndicatorSeries(held: IndicatorSeries): void {
    if (!this.chart) return;
    for (const s of held.series) {
      try {
        s.markers?.api.detach();
        this.chart.removeSeries(s.api);
      } catch {
        // Series already detached with its pane; nothing to undo.
      }
    }
    this.indicatorSeries = this.indicatorSeries.filter((s) => s !== held);
  }

  /**
   * Build the legend for the bar under the crosshair, or for the last bar when the pointer is away —
   * which is what TradingView shows at rest. After a tick it re-reads the bar the pointer still
   * rests on ({@link crosshairTime}); it used to jump back to the newest bar every second (CC-04).
   */
  private emitLegend(): void {
    const bars = this.plotted;
    if (bars.length === 0) {
      this.emitSnapshot({
        time: null,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
        changePct: null,
        indicators: [],
      });
      return;
    }

    const under = this.crosshairTime === null ? -1 : indexAtTime(bars, this.crosshairTime * 1000);
    const index = under >= 0 ? under : bars.length - 1;
    const bar = bars[index];
    const prev = index > 0 ? bars[index - 1] : null;
    const ohlc = this.studyBars();

    const indicators = this.indicators()
      .filter((a) => a.visible)
      .map((item) => {
        const def = indicatorById(item.defId);
        if (!def) return null;
        const computed = this.computeFor(item, def, ohlc);
        return {
          uid: item.uid,
          label: indicatorLabel(def, item.params),
          values: def.plots.map((plot) => ({
            title: plot.title,
            value: computed[plot.key]?.[index] ?? null,
            color: plot.color,
          })),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const tradingDate = this.tradingDateAt(Math.floor(bar.time / 1000));
    this.emitSnapshot({
      time: bar.time,
      dateLabel: tradingDate === null ? null : formatTradingDate(tradingDate, this.resolution()),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      change: prev ? bar.close - prev.close : null,
      changePct: prev && prev.close !== 0 ? ((bar.close - prev.close) / prev.close) * 100 : null,
      indicators,
    });
    if (this.dataWindowOpen()) this.fillDataWindow(index);
  }

  // ── Data window (CC-I6) ──────────────────────────────────────────────────

  /** Every value at the crosshair, section by section, in the order the providers registered. */
  readonly dataWindow = signal<DataWindowSection[]>([]);
  private readonly valueProviders = new ValueProviders();

  /**
   * List `provider`'s sections in the data window under `id`, after the chart's own (the bar, the
   * studies); registering an id again replaces it. Returns the function that takes it out again.
   * This is how the scripts' plots reach the data window.
   */
  registerValueProvider(id: string, provider: ValueProvider): () => void {
    return this.valueProviders.register(id, provider);
  }

  private fillDataWindow(index: number): void {
    const bar = this.plotted[index];
    this.dataWindow.set(
      bar
        ? this.valueProviders.collect({
            index,
            bar,
            utcTime: this.plottedUtc[index]?.time ?? bar.time,
            precision: this.precision(),
          })
        : [],
    );
  }

  /** The bar itself: its date, prices, change and volume. */
  private readonly barValues: ValueProvider = ({ index, bar, utcTime, precision }) => {
    const prev = index > 0 ? this.plotted[index - 1] : null;
    const change = prev ? bar.close - prev.close : null;
    const pct = prev && prev.close !== 0 ? ((bar.close - prev.close) / prev.close) * 100 : null;
    const tradingDate = this.tradingDateAt(Math.floor(bar.time / 1000));
    const when =
      tradingDate === null
        ? formatEventTime(utcTime, Math.round(this.timezoneShiftMs(utcTime) / 60_000))
        : formatTradingDate(tradingDate, this.resolution());
    const price = (v: number) => v.toFixed(precision);
    return [
      {
        id: 'bar',
        title: this.symbol() || 'Bar',
        rows: [
          { label: tradingDate === null ? 'Time' : 'Date', value: when },
          { label: 'Open', value: price(bar.open) },
          { label: 'High', value: price(bar.high) },
          { label: 'Low', value: price(bar.low) },
          { label: 'Close', value: price(bar.close) },
          {
            label: 'Change',
            value:
              changeText(change, pct, this.pipSize() ?? pipSizeFor(precision), precision) ?? '—',
          },
          { label: 'Volume', value: formatVolume(bar.volume) },
        ],
      },
    ];
  };

  /** Each visible study's plots at the bar. */
  private readonly studyValues: ValueProvider = ({ index, precision }) => {
    const ohlc = this.studyBars();
    const out: DataWindowSection[] = [];
    for (const item of this.indicators()) {
      if (!item.visible) continue;
      const def = indicatorById(item.defId);
      if (!def) continue;
      const computed = this.computeFor(item, def, ohlc);
      out.push({
        id: `study:${item.uid}`,
        title: indicatorLabel(def, item.params),
        rows: def.plots.map((plot) => ({
          label: plot.title,
          value: formatStudyValue(computed[plot.key]?.[index], def.target === 'overlay', precision),
          color: plot.color,
          raw: computed[plot.key]?.[index] ?? null,
        })),
      });
    }
    return out;
  };

  private emitSnapshot(snap: LegendSnapshot): void {
    this.lastSnapshot = snap;
    this.legend.emit(snap);
    if (this.holding) this.renderHoldTip();
  }
}

/** A marker pinned to a bar — trade signals, fills, economic events. */
export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
}
