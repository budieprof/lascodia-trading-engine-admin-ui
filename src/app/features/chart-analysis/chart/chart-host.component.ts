import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
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
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesDataItemTypeMap,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { ThemeService } from '@core/theme/theme.service';
import type { Bar } from '../datafeed/candle-feed.service';
import { indicatorById, indicatorLabel, type IndicatorDef } from '../indicators/registry';
import type { Ohlc } from '../indicators/math';
import { HiLoSeries, VolCandleSeries, type OhlcvData } from './custom-series';
import {
  averageTrueRange,
  toKagi,
  toRangeBars,
  toLineBreak,
  toPointAndFigure,
  toRenko,
} from './price-transforms';
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
import { ProfileRenderer } from '../profiles/profile-renderer';
import { computeProfileStudy } from '../profiles/profile-studies';
import { PatternRenderer } from '../patterns/pattern-renderer';
import {
  detectCandlestickPatterns,
  type CandleTrendFilter,
} from '../patterns/candlestick-patterns';
import { detectChartPatterns } from '../patterns/chart-patterns';
import { renderScriptResult, type ScriptRenderHandle } from '../scripts/script-renderer';
import {
  DEFAULT_RIGHT_OFFSET,
  marginCap,
  marginMovesView,
  mergeBarColors,
  restoredRightOffset,
  sameBarColors,
  savedRightOffset,
  scriptRightOffset,
  withBarColor,
  type BarPaint,
} from '../scripts/run-on-host';
import { PineTableOverlayComponent } from '@shared/pine-chart/components/pine-table-overlay.component';
import type { TableLayout } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult } from '../scripts/chart-script.model';
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
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  changePct: number | null;
  indicators: Array<{
    uid: string;
    label: string;
    values: Array<{ title: string; value: number | null; color: string }>;
  }>;
}

interface IndicatorSeries {
  uid: string;
  paneIndex: number;
  series: Array<{
    key: string;
    api: ISeriesApi<'Line' | 'Histogram'>;
    color: string;
    title: string;
  }>;
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
  /** Price scale mode — normal, logarithmic or percentage. */
  readonly scaleMode = input<'normal' | 'log' | 'percent'>('normal');
  /** Engine-derived price levels: position entry/SL/TP and pending orders. */
  readonly overlays = input<PriceOverlay[]>([]);
  /** Bar markers for trade signals, fills and economic events. */
  readonly markers = input<ChartMarker[]>([]);
  /** IANA zone for the time axis; bar data itself stays UTC. */
  readonly timezone = input<string>('UTC');
  /** Economic events on the time axis. Times are UTC; shifted like the bars. */
  readonly events = input<EventMark[]>([]);
  readonly minEventImpact = input<'High' | 'Medium' | 'Low'>('Medium');
  /** Multiplier on the ATR-derived Renko / P&F / Kagi box size. */
  readonly boxSizeAtr = input<number>(1);
  /** Which chart this panel is, so it renders only its own drawings. */
  readonly symbol = input<string>('');
  /** Bars of other symbols, keyed by symbol, for compare studies (correlation, spread…). */
  readonly compareBars = input<Record<string, Bar[]>>({});
  /** Pine indicator / strategy runs to paint on this chart. */
  readonly scriptResults = input<ChartScriptResult[]>([]);
  /** Externally sourced series (FX fundamentals), each in its own pane. */
  readonly externalPanes = input<ExternalPane[]>([]);
  /** Whether strategy entry/exit arrows are drawn. */
  readonly showScriptTrades = input<boolean>(true);
  readonly resolution = input<string>('');
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

  private chart: IChartApi | null = null;
  // Includes 'Histogram' because the Column style plots the close as bars on
  // the price scale — it is a price series here, not the volume overlay.
  private price: ISeriesApi<
    'Candlestick' | 'Bar' | 'Line' | 'Area' | 'Baseline' | 'Histogram' | 'Custom'
  > | null = null;
  private volume: ISeriesApi<'Histogram'> | null = null;
  private indicatorSeries: IndicatorSeries[] = [];
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
    const shifted = new Date(s.time + this.timezoneShiftMs(s.time));
    const date = shifted.toISOString().replace('T', ' ').slice(0, 16);
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
          )
        : null;
    const p = this.palette(this.theme.theme() === 'dark');
    const lineLike = LINE_LIKE.has(this.style());
    const color = lineLike ? p.line : (shown?.close ?? 0) >= (shown?.open ?? 0) ? p.up : p.down;
    this.countdown.set(text, shown ? shown.close : null, color, axisLabelHeight(12));
  }
  private computedCache = new Map<string, Record<string, Array<number | null>>>();
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
  private readonly eventRenderer = new EventMarksRenderer(() => this.chart);
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
    // Create once the view exists, then keep it in step with inputs. Each
    // effect reads exactly one input and does its work untracked, so changing
    // the bar set never rebuilds the indicator panes and vice versa.
    effect(() => {
      const el = this.container().nativeElement;
      const dark = this.theme.theme() === 'dark';
      untracked(() => (this.chart ? this.retheme(dark) : this.rebuildChart(el, dark)));
    });

    effect(() => {
      const bars = this.bars();
      const style = this.style();
      const showVolume = this.showVolume();
      const precision = this.precision();
      this.boxSizeAtr();
      untracked(() => this.applyData(bars, style, showVolume, precision));
    });

    effect(() => {
      const active = this.indicators();
      // Depend on style as well: a price-based style replaces the bar array,
      // and the studies have to be recomputed against what is actually drawn.
      this.bars();
      this.style();
      this.compareBars();
      untracked(() => {
        this.applyIndicators(active, this.plotted);
        this.applyPatterns(active);
        this.applyProfiles(active);
      });
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
      untracked(() => this.applyScaleMode(mode));
    });

    effect(() => {
      // Re-plot on a timezone change: the shift is applied to the bar TIMES
      // handed to the library, since Lightweight Charts has no timezone option
      // of its own and renders whatever instants it is given.
      this.timezone();
      untracked(() =>
        this.applyData(this.bars(), this.style(), this.showVolume(), this.precision()),
      );
    });

    // Pine runs. Re-rendered when the price series is replaced (style, timezone, theme),
    // because the script's primitives and panes hang off that series.
    effect(() => {
      const results = this.scriptResults();
      const trades = this.showScriptTrades();
      this.style();
      this.timezone();
      this.theme.theme();
      untracked(() => this.applyScripts(results, trades));
    });

    effect(() => {
      const panes = this.externalPanes();
      this.timezone();
      this.theme.theme();
      this.bars();
      untracked(() => this.applyExternalPanes(panes));
    });

    effect(() => {
      const overlays = this.overlays();
      untracked(() => this.overlayRenderer.setOverlays(overlays));
    });

    // Analytical overlays. Recomputed when the bars or the toggles change, and — via
    // `onVisibleRangeChanged` — whenever the operator pans or zooms.
    effect(() => {
      this.bars();
      this.showVolumeProfile();
      this.volumeProfileMode();
      this.showSupportResistance();
      this.showStructure();
      untracked(() => this.recomputeAnalysis());
    });

    effect(() => {
      const markers = this.markers();
      untracked(() => this.applyMarkers(markers));
    });

    effect(() => {
      const events = this.events();
      const minImpact = this.minEventImpact();
      // Shifted with the bars so an event sits where it happened on the
      // displayed clock, not where it happened in UTC.
      this.timezone();
      untracked(() =>
        this.eventRenderer.setMarks(
          events.map((e) => ({ ...e, time: e.time + this.timezoneShiftMs(e.time) })),
          minImpact,
        ),
      );
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.countdownTimer);
    this.cancelGlide();
    for (const h of this.scriptHandles) h.dispose();
    this.scriptHandles = [];
    cancelAnimationFrame(this.tablesFrame);
    this.paneObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.controller.detach();
    this.chart?.remove();
    this.chart = null;
  }

  /**
   * Price scale mode. Percentage and indexed-to-100 are relative to the first
   * visible bar, which is why switching mode rescales rather than re-fetching.
   */
  private applyScaleMode(mode: 'normal' | 'log' | 'percent'): void {
    this.chart?.priceScale('right').applyOptions({
      mode: mode === 'log' ? 1 : mode === 'percent' ? 2 : 0,
    });
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
    // re-slicing on pan would split a session in two at the viewport edge.
    this.analysisRenderer.setPeriodProfiles(
      wantProfile && mode !== 'visible' ? periodProfiles(bars, mode) : [],
    );
    this.analysisRenderer.setLevels(wantLevels ? supportResistance(window) : []);
    this.analysisRenderer.setStructure(wantStructure ? marketStructure(window) : null);
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
    try {
      scale.setVisibleRange({
        from: Math.floor(from / 1000) as unknown as Time,
        to: Math.floor(to / 1000) as unknown as Time,
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

  /** Fractional bar index of a UTC instant on the plotted (zone-shifted) bars; extrapolates past either end. */
  private logicalAtMs(utcMs: number): number | null {
    const bars = this.plotted;
    if (bars.length < 2) return null;
    const t = utcMs + this.timezoneShiftMs(utcMs);
    const last = bars.length - 1;
    const step = (bars[last].time - bars[0].time) / last || 3_600_000;
    if (t <= bars[0].time) return (t - bars[0].time) / step;
    if (t >= bars[last].time) return last + (t - bars[last].time) / step;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }

  /** Show the most recent `count` bars. */
  showLastBars(count: number): boolean {
    const scale = this.chart?.timeScale();
    const total = this.bars().length;
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
      timeScale: { borderColor: p.border },
      crosshair: {
        vertLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
        horzLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
      },
    });
    // Series colours come from the palette when the data is applied. Replacing the price
    // series drops the profile primitives that hang off it, so the studies are re-applied as
    // a style change does.
    this.applyData(this.bars(), this.style(), this.showVolume(), this.precision());
    const active = this.indicators();
    this.applyIndicators(active, this.plotted);
    this.applyPatterns(active);
    this.applyProfiles(active);
  }

  private rebuildChart(el: HTMLElement, dark: boolean): void {
    this.chart?.remove();
    // Every series handle died with that chart. Left set, applyData below hands
    // the old price series to the NEW chart's removeSeries, which throws "Value
    // is undefined" for a series it never owned — a theme switch then left the
    // chart empty — and the old volume series would be written to, not re-added.
    this.price = null;
    this.volume = null;
    this.markerApi = null;
    this.indicatorSeries = [];
    const p = this.palette(dark);

    this.chart = createChart(el, {
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
      timeScale: {
        borderColor: p.border,
        timeVisible: true,
        secondsVisible: false,
        // TradingView's defaults: ~5 bars of empty space right of the last bar,
        // 6px per bar. Scripts drawing into the future widen the margin (syncScriptMargin).
        rightOffset: DEFAULT_RIGHT_OFFSET,
        barSpacing: 6,
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
    });

    this.sizeToContainer(el);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.sizeToContainer(el);
      this.layoutScriptTables();
    });
    this.resizeObserver.observe(el);

    this.chart.subscribeCrosshairMove((param) => this.emitLegend(param));
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
      if (range.from < 10 && !this.loadMorePending()) {
        this.loadMorePending.set(true);
        this.loadMore.emit();
      }
      // The analytical overlays describe the VISIBLE window, so panning and zooming change
      // what they say. Debounced: this fires on every frame of a drag, and recomputing a
      // profile per frame would make the pan stutter.
      this.scheduleAnalysis();
      this.scheduleVisibleProfiles();
      this.scheduleViewChanged();
    });
    // Pane separators are dragged with the pointer; heights have no change event of their own.
    el.addEventListener('pointerup', () => this.scheduleViewChanged());

    this.applyData(this.bars(), this.style(), this.showVolume(), this.precision());
    this.applyIndicators(this.indicators(), this.bars());
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

  /** PNG data URL of the chart as currently drawn. */
  snapshot(): string | null {
    const el = this.container().nativeElement;
    const sources = [...el.querySelectorAll('canvas')] as HTMLCanvasElement[];
    if (sources.length === 0) return null;
    // Lightweight Charts paints across SEVERAL stacked canvases (panes, scales,
    // the crosshair layer). Grabbing one gives a chart with no axes, so they
    // are composited in DOM order onto a single surface.
    const rect = el.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
    out.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = this.palette(this.theme.theme() === 'dark').background;
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of sources) {
      const cr = c.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) continue;
      ctx.drawImage(
        c,
        (cr.left - rect.left) * window.devicePixelRatio,
        (cr.top - rect.top) * window.devicePixelRatio,
        cr.width * window.devicePixelRatio,
        cr.height * window.devicePixelRatio,
      );
    }
    try {
      return out.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  /** Price at a y offset inside the chart, for click-to-act features. */
  priceAtY(y: number): number | null {
    return this.price?.coordinateToPrice(y) ?? null;
  }

  /** Reset both scales to fit the data, as double-clicking the axis does. */
  /** Fit the price axis to the visible data, leaving the time window alone (TradingView's "auto"). */
  autoScalePrice(): void {
    this.chart?.priceScale('right').applyOptions({ autoScale: true });
  }

  resetScales(): void {
    this.chart?.timeScale().fitContent();
    this.chart?.priceScale('right').applyOptions({ autoScale: true });
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

  private applyData(bars: Bar[], style: ChartStyle, showVolume: boolean, precision: number): void {
    if (!this.chart) return;
    this.plotted = bars;
    this.computedCache.clear();

    const p = this.palette(this.theme.theme() === 'dark');
    const source = this.shiftForTimezone(this.transformed(bars, style), this.timezone());
    // Indicators and the legend follow the PLOTTED bars, so a price-based
    // style recomputes both against its synthetic series rather than against
    // the time bars underneath — otherwise an RSI on a Renko chart would be
    // reading a different series from the one on screen.
    this.plotted = source;
    // Scripts' barcolor() goes into the rows themselves. The series is rebuilt on every tick, so
    // colours applied to it afterwards would drop out and back with each one. The handles still
    // hold the current runs (re-rendered below) and read no chart state, so they can be asked now.
    const barColors = this.scriptBarColors(style, source);
    this.barColors = barColors;
    this.priceStyle = style;

    // Series type is part of the chart's structure, not its options, so a style
    // change means replacing the series rather than setting an option.
    if (this.price) {
      this.chart.removeSeries(this.price);
      this.price = null;
    }

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

    if (
      style === 'line' ||
      style === 'area' ||
      style === 'baseline' ||
      style === 'stepline' ||
      style === 'line-markers' ||
      style === 'hlc-area' ||
      style === 'kagi'
    ) {
      // HLC area plots the close but autoscales to the high/low, so its value
      // series is the close while the band it occupies comes from the bar.
      const data = source.map((b) => ({ time: asTime(b.time), value: b.close }));
      if (style === 'line' || style === 'kagi') {
        this.price = this.chart.addSeries(LineSeries, {
          color: style === 'kagi' ? '#787B86' : p.line,
          lineWidth: 2,
          priceFormat,
          ...lastPrice,
        });
      } else if (style === 'stepline') {
        this.price = this.chart.addSeries(LineSeries, {
          color: p.line,
          lineWidth: 2,
          lineType: 1, // with-steps
          priceFormat,
          ...lastPrice,
        });
      } else if (style === 'line-markers') {
        this.price = this.chart.addSeries(LineSeries, {
          color: p.line,
          lineWidth: 2,
          pointMarkersVisible: true,
          priceFormat,
          ...lastPrice,
        });
      } else if (style === 'hlc-area') {
        this.price = this.chart.addSeries(AreaSeries, {
          lineColor: p.line,
          topColor: 'rgba(41,98,255,0.28)',
          bottomColor: 'rgba(41,98,255,0)',
          priceFormat,
          ...lastPrice,
        });
      } else if (style === 'area') {
        this.price = this.chart.addSeries(AreaSeries, {
          lineColor: p.line,
          topColor: 'rgba(41,98,255,0.28)',
          bottomColor: 'rgba(41,98,255,0)',
          priceFormat,
          ...lastPrice,
        });
      } else {
        // TradingView's baseline defaults to the price at 50% of the visible
        // price range. Lightweight Charts' base value is a fixed price, so the
        // midpoint of the loaded bars' high/low range stands in for it.
        let lo = Infinity;
        let hi = -Infinity;
        for (const b of source) {
          lo = Math.min(lo, b.low);
          hi = Math.max(hi, b.high);
        }
        const base = source.length ? (lo + hi) / 2 : 0;
        this.price = this.chart.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: base },
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
      }
      this.price.setData(data as SeriesDataItemTypeMap['Line'][]);
    } else if (style === 'bars' || style === 'hlc-bars') {
      // Dropping the open tick is what makes a bar series HLC bars. True
      // HiLo (no ticks at all) needs a custom series and is not shipped.
      this.price = this.chart.addSeries(BarSeries, {
        upColor: p.up,
        downColor: p.down,
        openVisible: style !== 'hlc-bars',
        thinBars: style !== 'hlc-bars',
        priceFormat,
        ...lastPrice,
      });
      this.price.setData(ohlcRows(source, barColors, 'bar') as SeriesDataItemTypeMap['Bar'][]);
    } else if (style === 'hilo' || style === 'vol-candle') {
      // The only two styles with no built-in series: HiLo draws the range with
      // neither tick, and VolCandle varies body width by volume. Both are
      // custom series — see custom-series.ts.
      const view = style === 'hilo' ? new HiLoSeries() : new VolCandleSeries();
      const custom = this.chart.addCustomSeries(view, {
        upColor: p.up,
        downColor: p.down,
        priceFormat,
        ...lastPrice,
      });
      custom.setData(ohlcvRows(source, barColors));
      this.price = custom;
    } else if (style === 'column') {
      const column = this.chart.addSeries(HistogramSeries, {
        color: p.up,
        priceFormat,
        ...lastPrice,
      });
      column.setData(
        source.map((b) => ({
          time: asTime(b.time),
          value: b.close,
          color: b.close >= b.open ? p.up : p.down,
        })),
      );
      this.price = column;
    } else {
      const hollow = style === 'hollow';
      this.price = this.chart.addSeries(CandlestickSeries, {
        upColor: hollow ? 'rgba(0,0,0,0)' : p.up,
        downColor: hollow ? 'rgba(0,0,0,0)' : p.down,
        borderUpColor: p.up,
        borderDownColor: p.down,
        wickUpColor: p.up,
        wickDownColor: p.down,
        priceFormat,
        ...lastPrice,
      });
      this.price.setData(
        ohlcRows(source, barColors, hollow ? 'hollow' : 'candle') as CandlestickData<Time>[],
      );
    }

    // Re-bind drawings: the series above is a NEW object whenever the style
    // changes, and primitives live on the series, not the chart.
    if (this.price) {
      this.controller.bindSeries(this.price);
      this.controller.sync(
        this.drawings.forScope(this.symbol(), this.resolution()),
        this.drawings.selectedId(),
      );
      // Overlays and markers live on the series too, so they follow it through
      // every style change for the same reason drawings do.
      this.price.attachPrimitive(this.overlayRenderer);
      this.price.attachPrimitive(this.analysisRenderer);
      this.price.attachPrimitive(this.eventRenderer);
      this.price.attachPrimitive(this.patternRenderer);
      this.price.attachPrimitive(this.countdown);
      this.tickCountdown();
      // The series was replaced (style change, or new bars), and every primitive hanging off
      // the old one went with it: profiles are re-made by the indicators effect, Pine runs here.
      this.profileRenderers.clear();
      this.applyScripts(this.scriptResults(), this.showScriptTrades());
      this.markerApi = createSeriesMarkers(this.price, []);
      this.applyMarkers(this.markers());
    }

    if (showVolume) {
      if (!this.volume) {
        this.volume = this.chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
        });
        // Pin volume to the bottom fifth of the price pane, the way TradingView
        // overlays it, rather than giving it a pane and halving the chart.
        this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      this.volume.setData(
        source.map((b) => ({
          time: asTime(b.time),
          value: b.volume,
          color: b.close >= b.open ? p.volumeUp : p.volumeDown,
        })),
      );
    } else if (this.volume) {
      this.chart.removeSeries(this.volume);
      this.volume = null;
    }

    this.emitLegend(null);
  }

  /**
   * Rebuild the bar array for styles that are not time-based.
   *
   * Brick and box sizes default to a fraction of ATR rather than a fixed price:
   * a 10-pip brick is reasonable on EURUSD H1 and absurd on the same pair's D1,
   * so a constant would make these chart types useless on most timeframes.
   */
  private transformed(bars: Bar[], style: ChartStyle): Bar[] {
    if (!PRICE_BASED.has(style)) {
      return style === 'heikin-ashi' ? toHeikinAshi(bars) : bars;
    }
    if (bars.length === 0) return bars;
    const atr = averageTrueRange(bars, 14);
    const base = atr > 0 ? atr : Math.abs(bars[bars.length - 1].close) * 0.001;
    const unit = base * Math.max(0.1, this.boxSizeAtr());

    switch (style) {
      case 'renko':
        return toRenko(bars, unit);
      case 'line-break':
        return toLineBreak(bars, 3);
      case 'pnf':
        return toPointAndFigure(bars, unit, 3);
      case 'kagi':
        return toKagi(bars, unit * 2);
      case 'range':
        return toRangeBars(bars, unit);
      default:
        return bars;
    }
  }

  /**
   * Bar markers for signals, fills and events.
   *
   * Snapped to the nearest plotted bar: a signal fired at 10:37 has no H1 bar
   * of its own, and an unsnapped marker is dropped by the library without a
   * word rather than drawn at the nearest candle.
   */
  private applyMarkers(markers: ChartMarker[]): void {
    if (!this.markerApi) return;
    const bars = this.plotted;
    if (bars.length === 0) {
      this.markerApi.setMarkers([]);
      return;
    }
    const snapped = markers
      .map((m) => {
        const bar = nearestBarTime(bars, m.time);
        if (bar === null) return null;
        return {
          time: asTime(bar),
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => (a.time as number) - (b.time as number));
    this.markerApi.setMarkers(snapped);
  }

  private applyIndicators(active: ActiveIndicator[], bars: Bar[]): void {
    if (!this.chart) return;

    // Drop series for indicators that are gone or hidden.
    const wanted = new Set(active.filter((a) => a.visible).map((a) => a.uid));
    for (const held of [...this.indicatorSeries]) {
      if (!wanted.has(held.uid)) this.removeIndicatorSeries(held);
    }

    const ohlc: Ohlc[] = bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    for (const item of active) {
      if (!item.visible) continue;
      const def = indicatorById(item.defId);
      if (!def) continue;
      const computed = this.computeFor(item, def, ohlc);
      const existing = this.indicatorSeries.find((s) => s.uid === item.uid);
      const target = existing ?? this.createIndicatorSeries(item, def);
      if (!target) continue;

      for (const s of target.series) {
        const values = computed[s.key] ?? [];
        s.api.setData(
          bars
            .map((b, i) => ({ time: asTime(b.time), value: values[i] }))
            .filter(
              (d): d is { time: Time; value: number } => d.value !== null && d.value !== undefined,
            ),
        );
      }
    }

    this.emitLegend(null);
  }

  private computeFor(
    item: ActiveIndicator,
    def: IndicatorDef,
    ohlc: Ohlc[],
  ): Record<string, Array<number | null>> {
    // Compare studies also depend on the other symbol's bars, so those are part of the key.
    const symbol = def.needsCompare ? String(item.params['symbol'] ?? '').toUpperCase() : '';
    const compare = symbol ? this.compareBars()[symbol] : undefined;
    const cacheKey = `${item.uid}:${JSON.stringify(item.params)}:${ohlc.length}:${ohlc[0]?.time ?? 0}:${symbol}:${compare?.length ?? 0}`;
    const hit = this.computedCache.get(cacheKey);
    if (hit) return hit;
    const computed = def.compute(
      ohlc,
      item.params,
      // Same zone shift as the plotted bars, or alignByTime would pair the wrong bars.
      compare ? { compareBars: this.shiftForTimezone(compare, this.timezone()) } : undefined,
    );
    this.computedCache.set(cacheKey, computed);
    return computed;
  }

  private externalSeries: ISeriesApi<'Line'>[] = [];
  private applyExternalPanes(panes: ExternalPane[]): void {
    if (!this.chart) return;
    for (const s of this.externalSeries) {
      try {
        this.chart.removeSeries(s);
      } catch {
        // Went with a rebuilt chart.
      }
    }
    this.externalSeries = [];
    for (const pane of panes) {
      const paneIndex = this.chart.panes().length;
      for (const line of pane.lines) {
        const s = this.chart.addSeries(
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
        // Sampled onto the chart's own bars: every distinct time a series carries becomes a
        // slot on the SHARED time axis, so a feed with its own cadence (news roll-ups every few
        // minutes) would otherwise wedge thousands of slots between the bars and squash them.
        const raw = this.bars();
        const values = alignToBars(line.points, raw);
        s.setData(
          raw
            .map((b, i) => ({
              time: asTime(b.time + this.timezoneShiftMs(b.time)),
              value: values[i],
            }))
            .filter(
              (d): d is { time: Time; value: number } => d.value !== null && d.value !== undefined,
            ),
        );
        this.externalSeries.push(s);
      }
    }
  }

  private scriptHandles: ScriptRenderHandle[] = [];
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
      for (const h of this.scriptHandles)
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

  private applyScripts(results: ChartScriptResult[], showTrades: boolean): void {
    for (const h of this.scriptHandles) {
      try {
        h.dispose();
      } catch {
        // Pane already gone with a rebuilt chart.
      }
    }
    this.scriptHandles = [];
    if (!this.chart || !this.price) return;
    // In the order the scripts were added: a later script's barcolor() wins (mergeBarColors).
    for (const r of results) {
      this.scriptHandles.push(
        renderScriptResult(this.chart, this.price, r, {
          shiftMs: (ms) => this.timezoneShiftMs(ms),
          showTrades,
          pricePrecision: this.precision(),
        }),
      );
    }
    this.refreshBarColors();
    this.syncScriptMargin();
    this.layoutScriptTables();
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
    if (!BAR_COLOR_STYLES.has(style) || this.scriptHandles.length === 0) return null;
    const times = plottedSeconds(plotted);
    return mergeBarColors(this.scriptHandles.map((h) => h.barColors(times)));
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
  }

  /**
   * Room right of the last bar for what the scripts draw ahead of it (labels, lines and boxes in
   * the future, positive plot offsets): the furthest plus two bars, capped (scriptRightOffset);
   * the default again once nothing reaches past the last bar.
   *
   * <p>It is the time scale's own `rightOffset` that changes, so "scroll to realtime" and "fit"
   * keep the room. The view follows only at the live edge: an operator who scrolled into history,
   * or set the space themselves, keeps their view (marginMovesView), and a layout never saves the
   * margin as their scroll (viewState).</p>
   */
  private syncScriptMargin(): void {
    const scale = this.chart?.timeScale();
    if (!scale) return;
    let reach = 0;
    if (this.scriptHandles.length) {
      const times = plottedSeconds(this.plotted);
      for (const h of this.scriptHandles) reach = Math.max(reach, h.futureBars(times));
    }
    const { rightOffset: current, barSpacing } = scale.options();
    const next = scriptRightOffset(current, reach, marginCap(scale.width(), barSpacing));
    if (next === current) return;
    const position = scale.scrollPosition();
    // Setting the option scrolls to it as well; put a view that is not ours to move back.
    scale.applyOptions({ rightOffset: next });
    if (!marginMovesView(current, next, position)) scale.scrollToPosition(position, false);
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
    if (!this.chart) return null;
    // Overlays live on the price pane (0); everything else gets its own pane,
    // which is what makes RSI and MACD behave like TradingView studies rather
    // than lines squashed onto the price scale.
    const paneIndex = def.target === 'overlay' ? 0 : this.chart.panes().length;

    const series = def.plots.map((plot) => {
      const api =
        plot.kind === 'histogram'
          ? this.chart!.addSeries(
              HistogramSeries,
              { color: plot.color, priceFormat: { type: 'price', precision: 5, minMove: 0.00001 } },
              paneIndex,
            )
          : this.chart!.addSeries(
              LineSeries,
              {
                color: plot.color,
                lineWidth: (plot.lineWidth ?? 2) as DeepPartial<1 | 2 | 3 | 4>,
                priceLineVisible: false,
                lastValueVisible: def.target === 'overlay',
                // An overlay shares the price scale; without the symbol's precision the axis
                // falls back to the library default of 2 decimals (1.14 for EURUSD).
                ...(def.target === 'overlay'
                  ? {
                      priceFormat: {
                        type: 'price' as const,
                        precision: this.precision(),
                        minMove: 1 / 10 ** this.precision(),
                      },
                    }
                  : {}),
              },
              paneIndex,
            );
      return {
        key: plot.key,
        api: api as ISeriesApi<'Line' | 'Histogram'>,
        color: plot.color,
        title: plot.title,
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

    const entry: IndicatorSeries = { uid: item.uid, paneIndex, series };
    this.indicatorSeries.push(entry);
    return entry;
  }

  private removeIndicatorSeries(held: IndicatorSeries): void {
    if (!this.chart) return;
    for (const s of held.series) {
      try {
        this.chart.removeSeries(s.api);
      } catch {
        // Series already detached with its pane; nothing to undo.
      }
    }
    this.indicatorSeries = this.indicatorSeries.filter((s) => s !== held);
  }

  /**
   * Build the legend for the crosshair position, or for the last bar when the
   * pointer is away — which is what TradingView shows at rest.
   */
  private emitLegend(param: MouseEventParams<Time> | null): void {
    const bars = this.plotted;
    if (bars.length === 0) {
      this.legend.emit({
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

    let index = bars.length - 1;
    if (param?.time !== undefined && param.time !== null) {
      const t = (param.time as number) * 1000;
      const found = bars.findIndex((b) => b.time === t);
      if (found >= 0) index = found;
    }

    const bar = bars[index];
    const prev = index > 0 ? bars[index - 1] : null;
    const ohlc: Ohlc[] = bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

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

    this.emitSnapshot({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      changePct: prev && prev.close !== 0 ? ((bar.close - prev.close) / prev.close) * 100 : null,
      indicators,
    });
  }

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

/** Nearest plotted bar time to `timeMs`, or null when there are no bars. */
function nearestBarTime(bars: Bar[], timeMs: number): number | null {
  if (bars.length === 0) return null;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const candidate = bars[lo];
  const previous = bars[Math.max(0, lo - 1)];
  return Math.abs(candidate.time - timeMs) <= Math.abs(previous.time - timeMs)
    ? candidate.time
    : previous.time;
}

/** Lightweight Charts takes seconds; our bars carry milliseconds. */
export function asTime(ms: number): Time {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toOhlcData(b: Bar) {
  return { time: asTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close };
}

/** The plotted bars' times as the time scale holds them (zone-shifted seconds). */
function plottedSeconds(bars: readonly Bar[]): number[] {
  return bars.map((b) => Math.floor(b.time / 1000));
}

/** How a script's colour paints a bar of `style` (one of BAR_COLOR_STYLES). */
function barPaint(style: ChartStyle): BarPaint {
  if (style === 'hollow') return 'hollow';
  return style === 'candles' || style === 'heikin-ashi' ? 'candle' : 'bar';
}

/** Candle / bar rows, each bar a script coloured painted per `paint` (body, border, wick…). */
function ohlcRows(
  source: readonly Bar[],
  colors: readonly (string | null)[] | null,
  paint: BarPaint,
) {
  return source.map((b, i) => withBarColor(toOhlcData(b), colors?.[i], paint));
}

/** Rows of the HiLo and volume-candle custom series; a script's colour is the bar's one colour. */
function ohlcvRows(source: readonly Bar[], colors: readonly (string | null)[] | null): OhlcvData[] {
  return source.map((b, i) =>
    withBarColor<OhlcvData>(
      {
        time: asTime(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      },
      colors?.[i],
      'bar',
    ),
  );
}

/**
 * Heikin-Ashi transform.
 *
 * Close is the bar's own average; open is the running average of the PREVIOUS
 * HA bar, so the series is recursive and cannot be computed per-bar in
 * isolation — which is why it is a transform over the whole array here rather
 * than a formatting option on the series.
 */
export function toHeikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: b.time,
      open,
      close,
      high: Math.max(b.high, open, close),
      low: Math.min(b.low, open, close),
      volume: b.volume,
    });
  }
  return out;
}
