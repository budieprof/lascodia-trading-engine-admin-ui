import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Logical,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import type { PaneKey, PineRenderModel } from '../render/render-model';
import type { HitRegion } from './paint-drawings';
import { PineLayersPrimitive } from './pine-layers-primitive';

/** Chart chrome colors (the console's chart palette, as the analysis chart uses). */
export interface PineChartColors {
  background: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  highlight: string;
}

export const PINE_CHART_LIGHT: PineChartColors = {
  background: '#FFFFFF',
  text: '#131722',
  grid: '#F0F3FA',
  border: '#D6DCDE',
  up: '#26A69A',
  down: '#EF5350',
  highlight: 'rgba(41, 98, 255, 0.14)',
};

export const PINE_CHART_DARK: PineChartColors = {
  background: '#131722',
  text: '#D1D4DC',
  grid: '#1E222D',
  border: '#2A2E39',
  up: '#26A69A',
  down: '#EF5350',
  highlight: 'rgba(41, 98, 255, 0.22)',
};

export interface PaneRect {
  index: number;
  key: PaneKey;
  /** Relative to the renderer's container, CSS px. */
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CrosshairEvent {
  logical: number | null;
  paneIndex: number | null;
  /** Pane-relative point. */
  point: { x: number; y: number } | null;
}

export interface RendererEvents {
  crosshair?(e: CrosshairEvent): void;
  click?(e: { logical: number; paneIndex: number; point: { x: number; y: number } }): void;
  /** Pane geometry changed (resize, pane added/removed, separator dragged). */
  layout?(): void;
}

/** Bars shown when a result first loads. */
export const INITIAL_VISIBLE_BARS = 180;

/**
 * Lightweight Charts wired to a Pine render model.
 *
 * The price bars are a built-in candlestick series (barcolor() recolors them per bar); every script
 * output is painted by one `PineLayersPrimitive` per pane. A non-overlay script gets a second pane
 * anchored by an invisible line series whose autoscale is the script's own value range. Positive
 * offsets and future drawings extend the time scale with whitespace so the future is reachable.
 *
 * Replaying a result that extends the current one (same first bar) keeps the operator's view, and
 * follows the right edge when it was showing the newest bar — how Bar Replay feels in TradingView.
 */
export class PineChartRenderer {
  private chart: IChartApi | null = null;
  private candles: ISeriesApi<'Candlestick'> | null = null;
  private anchor: ISeriesApi<'Line'> | null = null;
  private readonly mainLayers: PineLayersPrimitive;
  private readonly scriptLayers: PineLayersPrimitive;
  private model: PineRenderModel | null = null;
  private highlight: number | null = null;
  private tradesVisible = true;
  private readonly resizeObserver: ResizeObserver | null;
  private paneObserver: ResizeObserver | null = null;
  private observedRows: HTMLElement[] = [];

  constructor(
    private readonly el: HTMLElement,
    private colors: PineChartColors,
    private readonly events: RendererEvents = {},
    /** Display-timezone shift of a bar time (ms → ms); the axis draws the shifted instants. */
    private readonly timeShift: (ms: number) => number = () => 0,
  ) {
    const hooks = {
      highlight: () => this.highlight,
      highlightColor: () => this.colors.highlight,
      showTrades: () => this.tradesVisible,
    };
    this.mainLayers = new PineLayersPrimitive(hooks);
    this.scriptLayers = new PineLayersPrimitive(hooks);
    this.createChart();
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(el);
  }

  get current(): PineRenderModel | null {
    return this.model;
  }

  private createChart(): void {
    const c = this.colors;
    this.chart = createChart(this.el, {
      width: Math.max(1, this.el.clientWidth),
      height: Math.max(1, this.el.clientHeight),
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: c.background },
        textColor: c.text,
        attributionLogo: false,
        fontSize: 11,
        panes: { separatorColor: c.border, separatorHoverColor: c.border, enableResize: true },
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.12, bottom: 0.1 } },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, rightOffset: 8 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: c.border, labelBackgroundColor: c.border, style: LineStyle.Dashed },
        horzLine: { color: c.border, labelBackgroundColor: c.border, style: LineStyle.Dashed },
      },
      handleScroll: true,
      handleScale: true,
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    this.candles.attachPrimitive(this.mainLayers);
    this.chart.subscribeCrosshairMove(this.onCrosshair);
    this.chart.subscribeClick(this.onClick);
  }

  private readonly onCrosshair = (param: MouseEventParams<Time>): void => {
    if (!this.events.crosshair) return;
    const inside = param.point !== undefined && param.logical !== undefined;
    this.events.crosshair({
      logical: inside ? Math.round(param.logical as number) : null,
      paneIndex: param.paneIndex ?? null,
      point: param.point ? { x: param.point.x, y: param.point.y } : null,
    });
  };

  private readonly onClick = (param: MouseEventParams<Time>): void => {
    if (!this.events.click || param.logical === undefined || !param.point) return;
    this.events.click({
      logical: Math.round(param.logical as number),
      paneIndex: param.paneIndex ?? 0,
      point: { x: param.point.x, y: param.point.y },
    });
  };

  /** LWC time (seconds) of a bar time, in the display timezone. */
  private toTime(ms: number): UTCTimestamp {
    return Math.floor((ms + this.timeShift(ms)) / 1000) as UTCTimestamp;
  }

  /** Bar + future-whitespace times, strictly increasing as the library requires. */
  private chartTimes(model: PineRenderModel): UTCTimestamp[] {
    const n = model.bars.time.length;
    const total = n + (n > 0 ? model.futureSlots : 0);
    const out = new Array<UTCTimestamp>(total);
    let prev = -Infinity;
    for (let i = 0; i < total; i++) {
      const ms = i < n ? model.bars.time[i] : model.timeline.timeOfLogical(i);
      let t = this.toTime(ms);
      if (t <= prev) t = (prev + 1) as UTCTimestamp;
      out[i] = t;
      prev = t;
    }
    return out;
  }

  setModel(model: PineRenderModel): void {
    const chart = this.chart;
    const candles = this.candles;
    if (!chart || !candles) return;
    const prev = this.model;
    const ts = chart.timeScale();
    const range = prev ? ts.getVisibleLogicalRange() : null;
    const sameSeries =
      !!prev &&
      prev.bars.time.length > 0 &&
      model.bars.time.length >= prev.bars.time.length &&
      model.bars.time[0] === prev.bars.time[0];
    this.model = model;

    const times = this.chartTimes(model);
    const b = model.bars;
    const n = b.time.length;
    const data: Array<CandlestickData<Time> | WhitespaceData<Time>> = new Array(times.length);
    for (let i = 0; i < times.length; i++) {
      if (i >= n) {
        data[i] = { time: times[i] };
        continue;
      }
      const d: CandlestickData<Time> = { time: times[i], open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i] };
      const color = b.colors?.[i];
      if (color) {
        d.color = color;
        d.borderColor = color;
        d.wickColor = color;
      }
      data[i] = d;
    }
    const precision = model.pricePrecision;
    candles.applyOptions({
      priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) },
    });
    candles.setData(data);
    this.mainLayers.setData(model.panes.main, model);
    this.syncScriptPane(model, times);

    if (!prev || !sameSeries || !range) {
      this.showLatest(INITIAL_VISIBLE_BARS);
    } else {
      const added = n - prev.bars.time.length;
      const prevLast = prev.bars.time.length - 1;
      if (added > 0 && range.to >= prevLast - 0.5) {
        ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      } else {
        ts.setVisibleLogicalRange(range);
      }
    }
    this.observePanes();
    this.events.layout?.();
  }

  private syncScriptPane(model: PineRenderModel, times: UTCTimestamp[]): void {
    const chart = this.chart!;
    const pane = model.panes.script;
    if (!pane) {
      if (this.anchor) {
        this.anchor.detachPrimitive(this.scriptLayers);
        chart.removeSeries(this.anchor);
        this.anchor = null;
      }
      this.scriptLayers.setData(null, null);
      return;
    }
    if (!this.anchor) {
      this.anchor = chart.addSeries(
        LineSeries,
        {
          color: 'rgba(0,0,0,0)',
          lineVisible: false,
          pointMarkersVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
          // The anchor's own (constant) value must not shape the scale: the script's outputs do.
          autoscaleInfoProvider: () => this.scriptAutoscale(),
        },
        1,
      );
      this.anchor.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
      this.anchor.attachPrimitive(this.scriptLayers);
      const panes = chart.panes();
      // TradingView gives an indicator pane roughly a third of the chart.
      panes[0]?.setStretchFactor(2.2);
      panes[1]?.setStretchFactor(1);
    }
    const fmt = model.format;
    this.anchor.applyOptions({
      priceFormat:
        fmt.format === 'percent'
          ? { type: 'percent', precision: fmt.precision, minMove: Math.pow(10, -fmt.precision) }
          : fmt.format === 'volume'
            ? { type: 'volume', precision: fmt.precision, minMove: Math.pow(10, -fmt.precision) }
            : { type: 'price', precision: fmt.precision, minMove: Math.pow(10, -fmt.precision) },
    });
    const base = firstPaneValue(model) ?? 1;
    const n = model.bars.time.length;
    const line: LineData<Time>[] = new Array(n);
    for (let i = 0; i < n; i++) line[i] = { time: times[i], value: base };
    this.anchor.setData(line);
    this.scriptLayers.setData(pane, model);
  }

  private scriptAutoscale() {
    const r = this.chart?.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    const range = this.scriptLayers.valueRange(Math.floor(r.from), Math.ceil(r.to));
    if (!range) return null;
    if (range.min === range.max) {
      const pad = Math.abs(range.min) * 0.01 || 1;
      return { priceRange: { minValue: range.min - pad, maxValue: range.max + pad } };
    }
    return { priceRange: { minValue: range.min, maxValue: range.max } };
  }

  /** Show the newest `count` bars with a little room on the right. */
  showLatest(count = INITIAL_VISIBLE_BARS): void {
    const n = this.model?.bars.time.length ?? 0;
    if (!this.chart || n === 0) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - count), to: n + 6 });
  }

  fitContent(): void {
    this.chart?.timeScale().fitContent();
  }

  /** Bring a logical index into view (centred) unless it already is. */
  scrollToLogical(logical: number): void {
    const ts = this.chart?.timeScale();
    if (!ts || !Number.isFinite(logical)) return;
    const r = ts.getVisibleLogicalRange();
    const span = r ? Math.max(20, r.to - r.from) : INITIAL_VISIBLE_BARS;
    if (r && logical >= r.from + 2 && logical <= r.to - 2) return;
    ts.setVisibleLogicalRange({ from: logical - span / 2, to: logical + span / 2 });
  }

  setHighlight(logical: number | null): void {
    if (this.highlight === logical) return;
    this.highlight = logical;
    this.redraw();
  }

  setTradesVisible(visible: boolean): void {
    if (this.tradesVisible === visible) return;
    this.tradesVisible = visible;
    this.redraw();
  }

  setColors(colors: PineChartColors): void {
    this.colors = colors;
    const chart = this.chart;
    if (!chart) return;
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        panes: { separatorColor: colors.border, separatorHoverColor: colors.border },
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border },
      crosshair: {
        vertLine: { color: colors.border, labelBackgroundColor: colors.border },
        horzLine: { color: colors.border, labelBackgroundColor: colors.border },
      },
    });
    this.candles?.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    this.redraw();
  }

  redraw(): void {
    this.mainLayers.redraw();
    this.scriptLayers.redraw();
  }

  /** Where each pane's plotting area sits in the container (for HTML overlays: legends, tables). */
  paneRects(): PaneRect[] {
    const chart = this.chart;
    if (!chart) return [];
    const host = this.el.getBoundingClientRect();
    let left = 0;
    try {
      left = chart.priceScale('left').width();
    } catch {
      left = 0;
    }
    return chart.panes().map((pane, index) => {
      const row = pane.getHTMLElement();
      const r = row?.getBoundingClientRect();
      const size = chart.paneSize(index);
      return {
        index,
        key: index === 0 ? 'main' : 'script',
        top: r ? r.top - host.top : 0,
        left,
        width: size.width,
        height: size.height,
      };
    });
  }

  /** Tooltip region under a pane-relative point, topmost first. */
  hitAt(paneIndex: number, x: number, y: number): HitRegion | null {
    const layers = paneIndex === 0 ? this.mainLayers : this.scriptLayers;
    for (let i = layers.hits.length - 1; i >= 0; i--) {
      const h = layers.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    }
    return null;
  }

  /** Logical index at a container-relative x (for clicks outside the library's own events). */
  logicalAt(x: number): number | null {
    const l = this.chart?.timeScale().coordinateToLogical(x);
    return l === null || l === undefined ? null : Math.round(l as Logical);
  }

  resize(): void {
    const chart = this.chart;
    if (!chart) return;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w > 0 && h > 0) chart.resize(w, h);
    this.events.layout?.();
  }

  /** Pane separators can be dragged: watch the pane rows so overlays follow. */
  private observePanes(): void {
    if (typeof ResizeObserver === 'undefined' || !this.chart) return;
    const rows = this.chart
      .panes()
      .map((p) => p.getHTMLElement())
      .filter((r): r is HTMLElement => !!r);
    if (rows.length === this.observedRows.length && rows.every((r, i) => r === this.observedRows[i])) return;
    this.paneObserver?.disconnect();
    this.paneObserver = new ResizeObserver(() => this.events.layout?.());
    for (const r of rows) this.paneObserver.observe(r);
    this.observedRows = rows;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.paneObserver?.disconnect();
    if (this.chart) {
      this.chart.unsubscribeCrosshairMove(this.onCrosshair);
      this.chart.unsubscribeClick(this.onClick);
      this.chart.remove();
    }
    this.chart = null;
    this.candles = null;
    this.anchor = null;
  }
}

function firstPaneValue(model: PineRenderModel): number | null {
  for (const s of model.panes.script?.series ?? []) {
    if (s.type === 'plot' && s.valid.length) {
      const v = s.values[s.valid[0]];
      if (v !== 0) return v;
    }
  }
  return null;
}
