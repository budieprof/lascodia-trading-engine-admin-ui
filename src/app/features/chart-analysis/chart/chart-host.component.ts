import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  OnDestroy,
} from '@angular/core';
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
import {
  averageTrueRange,
  toKagi,
  toLineBreak,
  toPointAndFigure,
  toRenko,
} from './price-transforms';
import { DrawingStore } from '../drawings/drawing-store.service';
import { DrawingController } from '../drawings/drawing-controller';
import type { DrawingKind } from '../drawings/model';
import { OverlayRenderer, type PriceOverlay } from '../overlays/overlay-renderer';

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
  | 'column'
  | 'line-markers'
  | 'stepline'
  | 'hlc-area'
  | 'renko'
  | 'kagi'
  | 'pnf'
  | 'line-break';

/** Styles whose bars are built from price movement, not time. */
const PRICE_BASED: ReadonlySet<ChartStyle> = new Set<ChartStyle>([
  'renko',
  'kagi',
  'pnf',
  'line-break',
]);

/** An indicator the operator has added to this chart. */
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
  template: `<div class="chart-host" #container></div>`,
  styles: [
    `
      .chart-host {
        position: absolute;
        inset: 0;
      }
    `,
  ],
})
export class ChartHostComponent implements OnDestroy {
  private readonly theme = inject(ThemeService);
  private readonly drawings = inject(DrawingStore);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly controller = new DrawingController(this.drawings, () => this.precision());

  readonly bars = input.required<Bar[]>();
  readonly style = input<ChartStyle>('candles');
  readonly showVolume = input<boolean>(true);
  readonly indicators = input<ActiveIndicator[]>([]);
  readonly precision = input<number>(5);
  /** Armed drawing tool, or null for the cursor. */
  readonly tool = input<DrawingKind | null>(null);
  readonly magnet = input<boolean>(false);
  /** Price scale mode — normal, logarithmic or percentage. */
  readonly scaleMode = input<'normal' | 'log' | 'percent'>('normal');
  /** Engine-derived price levels: position entry/SL/TP and pending orders. */
  readonly overlays = input<PriceOverlay[]>([]);
  /** Bar markers for trade signals, fills and economic events. */
  readonly markers = input<ChartMarker[]>([]);

  /** Raised when the visible range reaches the oldest bar we hold. */
  readonly loadMore = output<void>();
  /** Crosshair readout for the legend; null time means "latest bar". */
  readonly legend = output<LegendSnapshot>();
  /** Raised when a drawing tool finishes, so the toolbar can disarm. */
  readonly toolComplete = output<void>();

  private chart: IChartApi | null = null;
  // Includes 'Histogram' because the Column style plots the close as bars on
  // the price scale — it is a price series here, not the volume overlay.
  private price: ISeriesApi<
    'Candlestick' | 'Bar' | 'Line' | 'Area' | 'Baseline' | 'Histogram'
  > | null = null;
  private volume: ISeriesApi<'Histogram'> | null = null;
  private indicatorSeries: IndicatorSeries[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private readonly loadMorePending = signal(false);
  /** Bars currently on the chart, for legend lookups by time. */
  private plotted: Bar[] = [];
  private computedCache = new Map<string, Record<string, Array<number | null>>>();
  private readonly overlayRenderer = new OverlayRenderer(
    () => this.price,
    () => this.precision(),
  );
  private markerApi: ISeriesMarkersPluginApi<Time> | null = null;

  constructor() {
    // Create once the view exists, then keep it in step with inputs. Each
    // effect reads exactly one input and does its work untracked, so changing
    // the bar set never rebuilds the indicator panes and vice versa.
    effect(() => {
      const el = this.container().nativeElement;
      const dark = this.theme.theme() === 'dark';
      untracked(() => this.rebuildChart(el, dark));
    });

    effect(() => {
      const bars = this.bars();
      const style = this.style();
      const showVolume = this.showVolume();
      const precision = this.precision();
      untracked(() => this.applyData(bars, style, showVolume, precision));
    });

    effect(() => {
      const active = this.indicators();
      // Depend on style as well: a price-based style replaces the bar array,
      // and the studies have to be recomputed against what is actually drawn.
      this.bars();
      this.style();
      untracked(() => this.applyIndicators(active, this.plotted));
    });

    // Drawing state → renderer. Reads the store's signals so any mutation
    // (add, drag, style change, undo) repaints without the page wiring an
    // explicit refresh for each one.
    effect(() => {
      const visible = this.drawings.visible();
      const selected = this.drawings.selectedId();
      untracked(() => this.controller.sync(visible, selected));
    });

    effect(() => {
      const tool = this.tool();
      const magnet = this.magnet();
      const bars = this.bars();
      untracked(() => {
        this.controller.magnet = magnet;
        this.controller.bars = bars;
        if (this.controller.activeTool !== tool) this.controller.setTool(tool);
      });
    });

    effect(() => {
      const mode = this.scaleMode();
      untracked(() => this.applyScaleMode(mode));
    });

    effect(() => {
      const overlays = this.overlays();
      untracked(() => this.overlayRenderer.setOverlays(overlays));
    });

    effect(() => {
      const markers = this.markers();
      untracked(() => this.applyMarkers(markers));
    });
  }

  ngOnDestroy(): void {
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

  /** Scroll to the most recent bar. */
  scrollToRealtime(): void {
    this.chart?.timeScale().scrollToRealTime();
  }

  fitContent(): void {
    this.chart?.timeScale().fitContent();
  }

  private palette(dark: boolean) {
    return {
      background: dark ? '#131722' : '#FFFFFF',
      text: dark ? '#D1D4DC' : '#131722',
      grid: dark ? '#1E222D' : '#E6E9EF',
      border: dark ? '#2A2E39' : '#D6DCDE',
      up: '#26A69A',
      down: '#EF5350',
      volumeUp: dark ? 'rgba(38,166,154,0.4)' : 'rgba(38,166,154,0.35)',
      volumeDown: dark ? 'rgba(239,83,80,0.4)' : 'rgba(239,83,80,0.35)',
    };
  }

  private rebuildChart(el: HTMLElement, dark: boolean): void {
    this.chart?.remove();
    this.indicatorSeries = [];
    const p = this.palette(dark);

    this.chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: p.background },
        textColor: p.text,
        attributionLogo: false,
        panes: { separatorColor: p.border, separatorHoverColor: p.border, enableResize: true },
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: {
        borderColor: p.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: p.border, labelBackgroundColor: p.border, style: LineStyle.Dashed },
        horzLine: { color: p.border, labelBackgroundColor: p.border, style: LineStyle.Dashed },
      },
      autoSize: false,
      handleScroll: true,
      handleScale: true,
    });

    this.sizeToContainer(el);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.sizeToContainer(el));
    this.resizeObserver.observe(el);

    this.chart.subscribeCrosshairMove((param) => this.emitLegend(param));

    this.controller.attach(this.chart, el);
    this.controller.onToolComplete = () => this.toolComplete.emit();
    this.controller.magnet = this.magnet();
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
    });

    this.applyData(this.bars(), this.style(), this.showVolume(), this.precision());
    this.applyIndicators(this.indicators(), this.bars());
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
    const source = this.transformed(bars, style);
    // Indicators and the legend follow the PLOTTED bars, so a price-based
    // style recomputes both against its synthetic series rather than against
    // the time bars underneath — otherwise an RSI on a Renko chart would be
    // reading a different series from the one on screen.
    this.plotted = source;

    // Series type is part of the chart's structure, not its options, so a style
    // change means replacing the series rather than setting an option.
    if (this.price) {
      this.chart.removeSeries(this.price);
      this.price = null;
    }

    const priceFormat = { type: 'price' as const, precision, minMove: 1 / 10 ** precision };

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
          color: style === 'kagi' ? '#787B86' : '#2962FF',
          lineWidth: 2,
          priceFormat,
        });
      } else if (style === 'stepline') {
        this.price = this.chart.addSeries(LineSeries, {
          color: '#2962FF',
          lineWidth: 2,
          lineType: 1, // with-steps
          priceFormat,
        });
      } else if (style === 'line-markers') {
        this.price = this.chart.addSeries(LineSeries, {
          color: '#2962FF',
          lineWidth: 2,
          pointMarkersVisible: true,
          priceFormat,
        });
      } else if (style === 'hlc-area') {
        this.price = this.chart.addSeries(AreaSeries, {
          lineColor: '#2962FF',
          topColor: 'rgba(41,98,255,0.28)',
          bottomColor: 'rgba(41,98,255,0.02)',
          priceFormat,
        });
      } else if (style === 'area') {
        this.price = this.chart.addSeries(AreaSeries, {
          lineColor: '#2962FF',
          topColor: 'rgba(41,98,255,0.35)',
          bottomColor: 'rgba(41,98,255,0.02)',
          priceFormat,
        });
      } else {
        const base = source.length ? source[0].close : 0;
        this.price = this.chart.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: base },
          priceFormat,
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
      });
      this.price.setData(source.map(toOhlcData) as SeriesDataItemTypeMap['Bar'][]);
    } else if (style === 'column') {
      const column = this.chart.addSeries(HistogramSeries, { color: p.up, priceFormat });
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
      });
      this.price.setData(source.map(toOhlcData) as CandlestickData<Time>[]);
    }

    // Re-bind drawings: the series above is a NEW object whenever the style
    // changes, and primitives live on the series, not the chart.
    if (this.price) {
      this.controller.bindSeries(this.price);
      this.controller.sync(this.drawings.visible(), this.drawings.selectedId());
      // Overlays and markers live on the series too, so they follow it through
      // every style change for the same reason drawings do.
      this.price.attachPrimitive(this.overlayRenderer);
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
    const unit = atr > 0 ? atr : Math.abs(bars[bars.length - 1].close) * 0.001;

    switch (style) {
      case 'renko':
        return toRenko(bars, unit);
      case 'line-break':
        return toLineBreak(bars, 3);
      case 'pnf':
        return toPointAndFigure(bars, unit, 3);
      case 'kagi':
        return toKagi(bars, unit * 2);
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
    const cacheKey = `${item.uid}:${JSON.stringify(item.params)}:${ohlc.length}:${ohlc[0]?.time ?? 0}`;
    const hit = this.computedCache.get(cacheKey);
    if (hit) return hit;
    const computed = def.compute(ohlc, item.params);
    this.computedCache.set(cacheKey, computed);
    return computed;
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

    this.legend.emit({
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
