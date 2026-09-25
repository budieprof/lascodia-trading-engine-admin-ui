import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  AutoscaleInfo,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { contrastText, trackColor } from '../core/color';
import { formatValue } from '../core/format';
import type { PaneModel, PineRenderModel } from '../render/render-model';
import { MarkerStacks, paintMarkers, type BarLookup } from './paint-markers';
import { paintDrawings, type HitRegion } from './paint-drawings';
import {
  lowerBound,
  paintBackground,
  paintCandles,
  paintFill,
  paintHighlight,
  paintHline,
  paintPlot,
} from './paint-series';
import { paintTrades } from './paint-trades';
import { createProjection, type Projection } from './projection';

export interface LayersPrimitiveHooks {
  /** Logical index to highlight (selected log line / trace bar / replay start), or null. */
  highlight(): number | null;
  highlightColor(): string;
  showTrades(): boolean;
}

/**
 * Paints one pane's Pine outputs. Attached to the pane's anchor series (the price candles in the
 * main pane, an invisible line in the script's pane) so it shares that series' price scale.
 *
 * - bottom layer: bgcolor() bands and the highlight band (under the grid and the candles);
 * - normal layer: fills, hlines, plots and plotcandles in declaration order, markers, drawings, trades;
 * - price axis: last-value labels of plots shown on the price scale;
 * - autoscale: the pane's plots, plotcandles, hlines and absolute markers over the visible range.
 */
export class PineLayersPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private pane: PaneModel | null = null;
  private model: PineRenderModel | null = null;
  private axisViews: ISeriesPrimitiveAxisView[] = [];
  /** Tooltip regions painted in the last frame (pane-relative CSS px). */
  hits: HitRegion[] = [];

  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly hooks: LayersPrimitiveHooks) {
    const bottom: IPrimitivePaneRenderer = { draw: (t) => this.drawBottom(t) };
    const normal: IPrimitivePaneRenderer = { draw: (t) => this.drawNormal(t) };
    this.views = [
      { zOrder: (): PrimitivePaneViewZOrder => 'bottom', renderer: () => bottom },
      { zOrder: (): PrimitivePaneViewZOrder => 'normal', renderer: () => normal },
    ];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setData(pane: PaneModel | null, model: PineRenderModel | null): void {
    this.pane = pane;
    this.model = model;
    this.axisViews = this.buildAxisViews();
    this.redraw();
  }

  redraw(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected per frame in the renderers */
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  /** The pane's value range over logical [start, end] (the library's visible strict range). */
  autoscaleInfo(start: number, end: number): AutoscaleInfo | null {
    const range = this.valueRange(start, end);
    return range ? { priceRange: { minValue: range.min, maxValue: range.max } } : null;
  }

  valueRange(start: number, end: number): { min: number; max: number } | null {
    const pane = this.pane;
    if (!pane) return null;
    let min = Infinity;
    let max = -Infinity;
    const merge = (lo: number, hi: number) => {
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    };
    for (const s of pane.series) {
      if (!s.display.pane) continue;
      const r = s.scale.range(start - s.start, end - s.start);
      if (!r) continue;
      merge(r.min, r.max);
      if (s.type === 'plot' && s.includeBaseInScale) merge(s.histBase, s.histBase);
    }
    for (const h of pane.hlines) if (h.display.pane) merge(h.price, h.price);
    for (const m of pane.markers) {
      if (!m.display.pane || m.location !== 'absolute' || m.kind === 'arrow') continue;
      const i0 = lowerBound(m.logicals, start);
      const i1 = lowerBound(m.logicals, end + 1) - 1;
      for (let i = i0; i <= i1; i++) {
        const v = m.values[i];
        if (v === v) merge(v, v);
      }
    }
    return min <= max ? { min, max } : null;
  }

  private projection(width: number, height: number): Projection | null {
    if (!this.chart || !this.series || !this.model) return null;
    return createProjection(this.chart, this.series, width, height, this.model.timeline.length - 1);
  }

  private barLookup(): BarLookup | null {
    const model = this.model;
    if (!model || this.pane?.key !== 'main') return null;
    const { high, low } = model.bars;
    const n = high.length;
    return {
      high: (l) => (l >= 0 && l < n ? high[l] : NaN),
      low: (l) => (l >= 0 && l < n ? low[l] : NaN),
    };
  }

  private drawBottom(target: CanvasRenderingTarget2D): void {
    const pane = this.pane;
    if (!pane) return;
    const highlight = this.hooks.highlight();
    if (!pane.backgrounds.length && highlight === null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const p = this.projection(mediaSize.width, mediaSize.height);
      if (!p) return;
      for (const b of pane.backgrounds) paintBackground(ctx, p, b);
      if (highlight !== null && highlight >= p.from && highlight <= p.to) {
        paintHighlight(ctx, p, highlight, this.hooks.highlightColor());
      }
    });
  }

  private drawNormal(target: CanvasRenderingTarget2D): void {
    const pane = this.pane;
    const model = this.model;
    const hits: HitRegion[] = [];
    this.hits = hits;
    if (!pane || !model) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const p = this.projection(mediaSize.width, mediaSize.height);
      if (!p) return;
      const bars = this.barLookup();
      for (const f of pane.fills) paintFill(ctx, p, f);
      for (const h of pane.hlines) paintHline(ctx, p, h);
      for (const s of pane.series) {
        if (s.type === 'plot') paintPlot(ctx, p, s);
        else paintCandles(ctx, p, s);
      }
      const stacks = new MarkerStacks();
      for (const m of pane.markers) paintMarkers(ctx, p, m, bars, stacks);
      paintDrawings(ctx, p, pane.drawings, bars, hits);
      if (pane.trades.length && bars && this.hooks.showTrades()) {
        const close = model.bars.close;
        paintTrades(
          ctx,
          p,
          pane.trades,
          bars,
          close.length ? close[close.length - 1] : NaN,
          stacks,
          hits,
        );
      }
    });
  }

  /** Last-value labels of plots (and plotcandles) whose display includes the price scale. */
  private buildAxisViews(): ISeriesPrimitiveAxisView[] {
    const pane = this.pane;
    if (!pane) return [];
    const views: ISeriesPrimitiveAxisView[] = [];
    for (const s of pane.series) {
      if (!s.display.priceScale) continue;
      let value: number;
      let color: string | null;
      if (s.type === 'plot') {
        if (!s.last) continue;
        value = s.last.value;
        color = s.last.color;
      } else {
        let slot = -1;
        for (let i = s.close.length - 1; i >= 0; i--) {
          if (s.close[i] === s.close[i]) {
            slot = i;
            break;
          }
        }
        if (slot < 0) continue;
        value = s.close[slot];
        color = trackColor(s.colors, slot);
      }
      const back = color ?? '#787B86';
      const text = formatValue(value, s.format);
      const fore = contrastText(back);
      views.push({
        coordinate: () => this.series?.priceToCoordinate(value) ?? -10_000,
        text: () => text,
        textColor: () => fore,
        backColor: () => back,
        visible: () => this.series?.priceToCoordinate(value) !== null,
        tickVisible: () => true,
      });
    }
    return views;
  }
}
