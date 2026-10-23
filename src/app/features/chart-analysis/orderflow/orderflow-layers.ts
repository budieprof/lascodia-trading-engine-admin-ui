import { signal } from '@angular/core';
import {
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  type LineData,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';

import type { Bar } from '../datafeed/candle-feed.service';
import { FillPrimitive } from '../indicators/fill-primitive';
import { xAtLogical } from '../chart/time-x';
import { CaptionPrimitive } from './caption-primitive';
import type { FillMark } from './fills';
import { FootprintPrimitive, type FootprintLayerModel } from './footprint-primitive';
import { FillsPrimitive } from './fills-primitive';
import { HeatmapPrimitive, type HeatmapLayerModel } from './heatmap-primitive';
import { TradeBubblesPrimitive, type TradeBubblesModel } from './trade-bubbles-primitive';
import type { OrderFlowView, TickBarDto } from './orderflow.types';
import { utcMs } from '../panels/fx-fundamentals';

/** A pane of per-bar tick flow: the response's bars, and the notes its title carries. */
export interface FlowPaneModel {
  bars: readonly TickBarDto[];
  /** OF-4 only: one flag per bar in `bars` — spread ≥ 2× median while the tick rate spikes. */
  pulled?: readonly boolean[];
  notes: readonly string[];
}

/** Everything the order-flow layers draw on one chart; the page builds it (orderflow-feed.ts). */
export interface OrderFlowModel {
  heatmap: HeatmapLayerModel | null;
  footprint: FootprintLayerModel | null;
  fills: readonly FillMark[];
  /** Price-pane notes: what each layer is built from, where its data stops, why one is not drawn. */
  captions: readonly string[];
  /** OF-2: the cumulative tick delta pane; null: no pane. */
  cvd: FlowPaneModel | null;
  /** OF-4: the spread and tick-rate pane; null: no pane. */
  ribbon: FlowPaneModel | null;
  /** Trade bubbles (sources with real trades); null: none drawn. */
  trades?: TradeBubblesModel | null;
  /**
   * The stream layers (event-level heatmap, trades) advance without the model changing: the layers register here to
   * redraw (called outside Angular, at most once per animation frame per source of change).
   */
  subscribeRedraw?: (fn: () => void) => () => void;
}

/** What the layers need of the chart host — read lazily, as the host replaces its chart and series. */
export interface OrderFlowSurface {
  chart(): IChartApi | null;
  price(): ISeriesApi<SeriesType> | null;
  /** Hang a primitive on the price series, now and after every replacement of it. */
  attachPricePrimitive(primitive: ISeriesPrimitive<Time>): () => void;
  /** UTC ms → fractional logical index (a bar's open is its index; between bars and past the last). */
  logicalAt(utcMs: number): number | null;
  /** The plotted bars (zone-shifted times) and the same bars' UTC opens, index for index. */
  plotted(): readonly Bar[];
  plottedUtc(): readonly Bar[];
  dark(): boolean;
  precision(): number;
  /** A flow pane was added or removed (the host re-hangs its per-pane renderers). */
  panesChanged?(): void;
}

const CVD_TITLE = 'Tick delta (CVD, tick rule)';
const RIBBON_TITLE = 'Spread (points: avg, min–max band) · ticks per minute';
const UP = '#26A69A';
const DOWN = '#EF5350';

interface CvdPane {
  line: ISeriesApi<'Line'>;
  hist: ISeriesApi<'Histogram'>;
  caption: CaptionPrimitive;
  written: FlowPaneModel | null;
  barsKey: string;
}

interface RibbonPane {
  spread: ISeriesApi<'Line'>;
  rate: ISeriesApi<'Histogram'>;
  band: FillPrimitive;
  markers: ISeriesMarkersPluginApi<Time>;
  caption: CaptionPrimitive;
  written: FlowPaneModel | null;
  barsKey: string;
}

/**
 * The order-flow layers on one chart (OF-1 … OF-6), owned by the chart host so they follow its rebuilds: the price
 * pane's primitives (heatmap behind the candles; footprint, fills and the notes above them) ride on the host's
 * re-attached price primitives, and the two flow panes (CVD, spread / tick rate) are series of their own, written onto the plotted
 * bars by their UTC open — so a session grid's bars and a display timezone line up without any re-fetch.
 *
 * It also reports what is on screen ({@link view}), debounced, for the page's fetches.
 */
export class OrderFlowLayers {
  /** The visible window, for the page's fetches; null before the first bars. */
  readonly view = signal<OrderFlowView | null>(null, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  /** What the page asked for, and what is drawn after the layer group's opacity / visibility. */
  private source: OrderFlowModel | null = null;
  private model: OrderFlowModel | null = null;
  private groupAlpha = 1;
  private readonly primitiveDeps = {
    series: () => this.surface.price(),
    // A bar's open is its LEFT edge on screen (half a bar before its centre), so a bucket or a fill inside the bar
    // lands inside the candle.
    xAt: (utcMs: number) => {
      const logical = this.surface.logicalAt(utcMs);
      const scale = this.surface.chart()?.timeScale();
      return logical === null || !scale ? null : xAtLogical(scale, logical - 0.5);
    },
    dark: () => this.surface.dark(),
    precision: () => this.surface.precision(),
    barTimes: () => this.barAxis().times,
    barMs: () => this.barAxis().barMs,
  };
  private axisCache: { bars: readonly Bar[]; times: number[]; barMs: number } | null = null;
  /** The plotted bars' UTC opens and their typical spacing, cached per bars array. */
  private barAxis(): { times: number[]; barMs: number } {
    const bars = this.surface.plottedUtc();
    if (this.axisCache?.bars === bars) return this.axisCache;
    const times = bars.map((b) => b.time);
    const gaps: number[] = [];
    for (let i = Math.max(1, times.length - 200); i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    const barMs = gaps.length ? gaps[gaps.length >> 1] : 0;
    this.axisCache = { bars, times, barMs };
    return this.axisCache;
  }
  private unsubscribeRedraw: (() => void) | null = null;
  private redrawFn: (() => void) | null = null;
  private readonly heatmap = new HeatmapPrimitive(this.primitiveDeps);
  private readonly footprint = new FootprintPrimitive(this.primitiveDeps);
  private readonly fills = new FillsPrimitive(this.primitiveDeps);
  private readonly bubbles = new TradeBubblesPrimitive(this.primitiveDeps);
  private readonly captions = new CaptionPrimitive('price', () => this.surface.dark());

  private chartRef: IChartApi | null = null;
  private cvd: CvdPane | null = null;
  private ribbon: RibbonPane | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onRange = () => this.scheduleView();

  constructor(private readonly surface: OrderFlowSurface) {
    // Through the host, so they are re-attached to every new price series (style switch, rebuilt chart).
    for (const p of [this.heatmap, this.footprint, this.fills, this.bubbles, this.captions])
      surface.attachPricePrimitive(p);
  }

  setModel(model: OrderFlowModel | null): void {
    this.source = model;
    this.apply();
    const sub = model?.subscribeRedraw ?? null;
    if (sub !== this.redrawFn) {
      this.unsubscribeRedraw?.();
      this.unsubscribeRedraw = null;
      this.redrawFn = sub;
      if (sub)
        this.unsubscribeRedraw = sub(() => {
          this.heatmap.redraw();
          this.bubbles.redraw();
        });
    }
  }

  /** The event-level heatmap's recent frame times (ms), for benchmarks / diagnostics. */
  heatmapFrameStats() {
    return this.heatmap.frameStats();
  }

  /**
   * The Order flow layer group (overlays/layer-groups.ts): its opacity fades every price-pane flow layer on top of
   * the heatmap's own opacity, and 0 (group hidden) takes the layers and their panes off the chart and stops
   * fetching, exactly as if every flow toggle were off — the toggles themselves are kept.
   */
  setGroupOpacity(opacity: number): void {
    const a = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    if (a === this.groupAlpha) return;
    this.groupAlpha = a;
    this.apply();
  }

  private apply(): void {
    const src = this.source;
    const a = this.groupAlpha;
    const model: OrderFlowModel | null =
      !src || a <= 0
        ? null
        : a >= 1 || !src.heatmap
          ? src
          : { ...src, heatmap: { ...src.heatmap, opacity: src.heatmap.opacity * a } };
    this.model = model;
    this.footprint.setAlpha(a);
    this.fills.setAlpha(a);
    this.bubbles.setAlpha(a);
    this.bubbles.setModel(model?.trades ?? null);
    this.heatmap.setModel(model?.heatmap ?? null);
    this.footprint.setModel(model?.footprint ?? null);
    this.fills.setFills(model?.fills ?? []);
    this.captions.setLines(model?.captions ?? []);
    this.syncPanes();
    // The window is only tracked while a layer is on (every chart host carries these layers).
    if (!model) {
      clearTimeout(this.viewTimer);
      this.view.set(null);
    } else if (!this.view()) this.scheduleView();
  }

  /** The plotted bars changed (a tick, a new bar, history, the zone or style): re-place the panes' rows. */
  barsChanged(): void {
    this.syncPanes();
    this.heatmap.redraw();
    this.scheduleView();
  }

  dispose(): void {
    clearTimeout(this.viewTimer);
    this.unsubscribeRedraw?.();
    this.unsubscribeRedraw = null;
    const chart = this.chartRef;
    if (chart) {
      this.removeCvd(chart);
      this.removeRibbon(chart);
    }
    this.unbindChart();
  }

  // ── Panes ───────────────────────────────────────────────────────────────

  /**
   * Create, remove and write the flow panes for the model. A pane is rewritten only when its model or the plotted bars
   * (count, ends, zone) changed — a tick inside the forming bar changes neither.
   */
  private syncPanes(): void {
    const chart = this.surface.chart();
    if (chart !== this.chartRef) {
      // A rebuilt chart (theme switch) took every series handle with it.
      this.unbindChart();
      this.cvd = null;
      this.ribbon = null;
      this.chartRef = chart;
      chart?.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    }
    if (!chart) return;
    const m = this.model;
    const hadCvd = !!this.cvd;
    const hadRibbon = !!this.ribbon;
    if (!m?.cvd && this.cvd) this.removeCvd(chart);
    if (!m?.ribbon && this.ribbon) this.removeRibbon(chart);
    if (m?.cvd && !this.cvd) this.cvd = this.createCvd(chart);
    if (m?.ribbon && !this.ribbon) this.ribbon = this.createRibbon(chart);
    if (hadCvd !== !!this.cvd || hadRibbon !== !!this.ribbon) this.surface.panesChanged?.();
    const plotted = this.surface.plotted();
    const utc = this.surface.plottedUtc();
    const barsKey = `${plotted.length}|${plotted[0]?.time}|${plotted.at(-1)?.time}|${utc[0]?.time}|${utc.at(-1)?.time}`;
    if (this.cvd && m?.cvd && (this.cvd.written !== m.cvd || this.cvd.barsKey !== barsKey)) {
      this.writeCvd(this.cvd, m.cvd);
      this.cvd.written = m.cvd;
      this.cvd.barsKey = barsKey;
    }
    if (
      this.ribbon &&
      m?.ribbon &&
      (this.ribbon.written !== m.ribbon || this.ribbon.barsKey !== barsKey)
    ) {
      this.writeRibbon(this.ribbon, m.ribbon);
      this.ribbon.written = m.ribbon;
      this.ribbon.barsKey = barsKey;
    }
  }

  private unbindChart(): void {
    try {
      this.chartRef?.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
    } catch {
      // The chart was removed.
    }
    this.chartRef = null;
  }

  private createCvd(chart: IChartApi): CvdPane {
    const pane = chart.panes().length;
    const line = chart.addSeries(
      LineSeries,
      {
        color: '#2962FF',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'CVD',
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
      },
      pane,
    );
    const hist = chart.addSeries(
      HistogramSeries,
      {
        priceScaleId: 'of-delta',
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'Δ',
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
      },
      pane,
    );
    hist.priceScale().applyOptions({ scaleMargins: { top: 0.6, bottom: 0 } });
    const caption = new CaptionPrimitive('pane', () => this.surface.dark());
    line.attachPrimitive(caption);
    line.getPane().setHeight(120);
    return { line, hist, caption, written: null, barsKey: '' };
  }

  private removeCvd(chart: IChartApi): void {
    const p = this.cvd;
    this.cvd = null;
    if (!p) return;
    for (const s of [p.line, p.hist]) {
      try {
        chart.removeSeries(s);
      } catch {
        // Went with a rebuilt chart.
      }
    }
  }

  private createRibbon(chart: IChartApi): RibbonPane {
    const pane = chart.panes().length;
    const spread = chart.addSeries(
      LineSeries,
      {
        color: '#FF9800',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'spread',
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      },
      pane,
    );
    const rate = chart.addSeries(
      HistogramSeries,
      {
        priceScaleId: 'of-rate',
        color: 'rgba(41,98,255,0.35)',
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'ticks/min',
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
      },
      pane,
    );
    rate.priceScale().applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });
    const band = new FillPrimitive(
      () => spread,
      (t) => {
        const x = this.chartRef?.timeScale().timeToCoordinate(t as Time);
        return x === null || x === undefined ? null : Number(x);
      },
    );
    spread.attachPrimitive(band);
    const caption = new CaptionPrimitive('pane', () => this.surface.dark());
    spread.attachPrimitive(caption);
    const markers = createSeriesMarkers(spread, []);
    spread.getPane().setHeight(80);
    return { spread, rate, band, markers, caption, written: null, barsKey: '' };
  }

  private removeRibbon(chart: IChartApi): void {
    const p = this.ribbon;
    this.ribbon = null;
    if (!p) return;
    p.markers.detach();
    for (const s of [p.spread, p.rate]) {
      try {
        chart.removeSeries(s);
      } catch {
        // Went with a rebuilt chart.
      }
    }
  }

  /**
   * The plotted bars that the response covers, in plotted order: each with its plotted time (LWC seconds) and its
   * row. Bars the response does not cover are left out (no row, not a zero).
   */
  private aligned(bars: readonly TickBarDto[]): { time: Time; bar: TickBarDto; k: number }[] {
    const byTime = new Map<number, number>();
    bars.forEach((b, k) => {
      const t = utcMs(b.t);
      if (Number.isFinite(t)) byTime.set(t, k);
    });
    const plotted = this.surface.plotted();
    const utc = this.surface.plottedUtc();
    const out: { time: Time; bar: TickBarDto; k: number }[] = [];
    for (let i = 0; i < utc.length; i++) {
      const k = byTime.get(utc[i].time);
      if (k !== undefined)
        out.push({ time: Math.floor(plotted[i].time / 1000) as Time, bar: bars[k], k });
    }
    return out;
  }

  private writeCvd(p: CvdPane, m: FlowPaneModel): void {
    const rows = this.aligned(m.bars);
    // Whitespace where a bar has no ticks: the line breaks there instead of joining across the gap.
    const line: (LineData<Time> | WhitespaceData<Time>)[] = rows.map((r) =>
      r.bar.cumDelta === null || r.bar.source !== 'ticks'
        ? { time: r.time }
        : { time: r.time, value: r.bar.cumDelta },
    );
    const hist: (HistogramData<Time> | WhitespaceData<Time>)[] = rows.map((r) =>
      r.bar.delta === null || r.bar.source !== 'ticks'
        ? { time: r.time }
        : { time: r.time, value: r.bar.delta, color: r.bar.delta >= 0 ? `${UP}b3` : `${DOWN}b3` },
    );
    p.line.setData(line);
    p.hist.setData(hist);
    p.caption.setLines([CVD_TITLE, ...m.notes]);
  }

  private writeRibbon(p: RibbonPane, m: FlowPaneModel): void {
    const rows = this.aligned(m.bars);
    p.spread.setData(
      rows.map((r) =>
        r.bar.spreadAvgPoints === null
          ? { time: r.time }
          : { time: r.time, value: r.bar.spreadAvgPoints },
      ),
    );
    // Candle-filled bars carry a spread only: no tick rate and no band.
    p.rate.setData(
      rows.map((r) =>
        r.bar.source !== 'ticks' || r.bar.ticksPerMinute === null
          ? { time: r.time }
          : { time: r.time, value: r.bar.ticksPerMinute },
      ),
    );
    p.band.setFills([
      {
        times: rows.map((r) => Number(r.time)),
        a: rows.map((r) => (r.bar.source === 'ticks' ? r.bar.spreadMaxPoints : null)),
        b: rows.map((r) => (r.bar.source === 'ticks' ? r.bar.spreadMinPoints : null)),
        color: 'rgba(255,152,0,0.16)',
      },
    ]);
    const marks: SeriesMarker<Time>[] = rows
      .filter((r) => m.pulled?.[r.k] === true)
      .map((r) => ({
        time: r.time,
        position: 'aboveBar',
        shape: 'circle',
        color: DOWN,
        size: 0.6,
      }));
    p.markers.setMarkers(marks);
    p.caption.setLines([RIBBON_TITLE, ...m.notes]);
  }

  // ── The view ─────────────────────────────────────────────────────────────

  private scheduleView(): void {
    if (!this.model) return;
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => this.view.set(this.readView()), 250);
  }

  private readView(): OrderFlowView | null {
    const chart = this.surface.chart();
    const price = this.surface.price();
    const utc = this.surface.plottedUtc();
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !range || utc.length === 0) return null;
    const last = utc.length - 1;
    const fromIndex = Math.max(0, Math.min(last, Math.floor(range.from)));
    const toIndex = Math.max(0, Math.min(last, Math.ceil(range.to)));
    const height = chart.panes()[0]?.getHeight() ?? 0;
    const top = price?.coordinateToPrice(0);
    const bottom = price?.coordinateToPrice(height);
    const pricePerPx =
      height > 0 && top !== null && top !== undefined && bottom !== null && bottom !== undefined
        ? Math.abs(Number(top) - Number(bottom)) / height
        : null;
    return {
      fromUtc: utc[fromIndex].time,
      toUtc: utc[toIndex].time,
      fromIndex,
      toIndex,
      widthPx: chart.timeScale().width(),
      barSpacing: chart.timeScale().options().barSpacing,
      rightEdgeInView: (range.to as number) >= last - 0.5,
      pricePerPx,
    };
  }
}
