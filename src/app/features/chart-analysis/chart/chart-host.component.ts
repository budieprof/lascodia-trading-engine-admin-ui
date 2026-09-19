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
  type CandlestickData,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesDataItemTypeMap,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { ThemeService } from '@core/theme/theme.service';
import type { Bar } from '../datafeed/candle-feed.service';
import { indicatorById, indicatorLabel, type IndicatorDef } from '../indicators/registry';
import type { Ohlc } from '../indicators/math';

/** Chart styles the toolbar can switch between. */
export type ChartStyle =
  | 'candles'
  | 'hollow'
  | 'bars'
  | 'line'
  | 'area'
  | 'baseline'
  | 'heikin-ashi';

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
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');

  readonly bars = input.required<Bar[]>();
  readonly style = input<ChartStyle>('candles');
  readonly showVolume = input<boolean>(true);
  readonly indicators = input<ActiveIndicator[]>([]);
  readonly precision = input<number>(5);

  /** Raised when the visible range reaches the oldest bar we hold. */
  readonly loadMore = output<void>();
  /** Crosshair readout for the legend; null time means "latest bar". */
  readonly legend = output<LegendSnapshot>();

  private chart: IChartApi | null = null;
  private price: ISeriesApi<'Candlestick' | 'Bar' | 'Line' | 'Area' | 'Baseline'> | null = null;
  private volume: ISeriesApi<'Histogram'> | null = null;
  private indicatorSeries: IndicatorSeries[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private readonly loadMorePending = signal(false);
  /** Bars currently on the chart, for legend lookups by time. */
  private plotted: Bar[] = [];
  private computedCache = new Map<string, Record<string, Array<number | null>>>();

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
      const bars = this.bars();
      untracked(() => this.applyIndicators(active, bars));
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.remove();
    this.chart = null;
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
    const source = style === 'heikin-ashi' ? toHeikinAshi(bars) : bars;

    // Series type is part of the chart's structure, not its options, so a style
    // change means replacing the series rather than setting an option.
    if (this.price) {
      this.chart.removeSeries(this.price);
      this.price = null;
    }

    const priceFormat = { type: 'price' as const, precision, minMove: 1 / 10 ** precision };

    if (style === 'line' || style === 'area' || style === 'baseline') {
      const data = source.map((b) => ({ time: asTime(b.time), value: b.close }));
      if (style === 'line') {
        this.price = this.chart.addSeries(LineSeries, {
          color: '#2962FF',
          lineWidth: 2,
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
    } else if (style === 'bars') {
      this.price = this.chart.addSeries(BarSeries, {
        upColor: p.up,
        downColor: p.down,
        priceFormat,
      });
      this.price.setData(source.map(toOhlcData) as SeriesDataItemTypeMap['Bar'][]);
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
        bars.map((b) => ({
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
