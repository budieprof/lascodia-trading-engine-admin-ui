import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  MouseEventParams,
  SeriesType,
  Time,
} from 'lightweight-charts';

import { formatUnits } from '../panels/side/depth';
import { drawHoverCard, formatUtcMs, formatUtcShort } from './canvas-text';
import { createWebGlHeatSurface, type HeatSurface } from './gl/heat-gl';
import { heatQuads, timeAtX } from './gl/heat-layout';
import { timeSegments, type TimeSegment } from './gl/heat-texture';
import {
  heatHitAt,
  heatLutColor,
  placeHeatGrid,
  type HeatGrid,
  type PlacedHeatColumn,
} from './heatmap-grid';
import type { StreamHeatLayer } from './stream-heatmap';

/** The event-level layer's data, pulled every frame (it changes without the model changing). */
export interface StreamHeatSource {
  layer(): StreamHeatLayer | null;
  /** What the hover card calls the source (e.g. "MetaQuotes-Demo DOM"). */
  label: string;
}

/**
 * What the heatmap draws: the bucketed C1 grid (canvas 2D), or the event-level stream layer (WebGL, `stream`), and
 * the opacity.
 */
export type HeatmapLayerModel =
  | { grid: HeatGrid; stream?: undefined; opacity: number }
  | { stream: StreamHeatSource; grid?: undefined; opacity: number };

export interface OrderFlowPrimitiveDeps {
  series: () => ISeriesApi<SeriesType> | null;
  /** UTC ms → x on the pane (media px), where a bar's OPEN is its left edge; null with no bars. */
  xAt: (utcMs: number) => number | null;
  dark: () => boolean;
  precision: () => number;
  /** The plotted bars' UTC opens and the bar width (ms): where the time axis is linear (the GPU layer's quads). */
  barTimes?: () => readonly number[];
  barMs?: () => number;
}

/** Frame-time samples kept for the GPU layer (`HeatmapPrimitive.frameStats`). */
const FRAME_SAMPLES = 120;

/**
 * OF-1 — the liquidity heatmap (Bookmap) painted BEHIND the candles (`zOrder` bottom), in one of two ways:
 * - **event-level (WebGL)**: every book event of the window (C5 history + the live hub) folded into a time × price
 *   texture with one column per screen pixel (`gl/heat-texture.ts`), coloured in a shader, drawn on an offscreen WebGL2
 *   canvas and `drawImage`d here inside `drawBackground`. Hover = the exact book at that instant and price.
 * - **bucketed (canvas 2D)**: one broker DOM snapshot per time bucket (C1) — wider views, and anywhere WebGL2 is not
 *   available.
 * Both colour on a log scale against a robust max and run the best bid / ask over the top as step lines.
 */
export class HeatmapPrimitive implements ISeriesPrimitive<Time> {
  private model: HeatmapLayerModel | null = null;
  private requestUpdate?: () => void;
  private chart: IChartApi | null = null;
  private hover: { x: number; y: number } | null = null;
  private placed: PlacedHeatColumn[] = [];
  private gpu: HeatSurface | null | undefined = undefined;
  private segments: TimeSegment[] = [];
  private readonly frameMs: number[] = [];
  private readonly onCrosshair = (p: MouseEventParams<Time>) => {
    const next = p.point && (p.paneIndex ?? 0) === 0 ? { x: p.point.x, y: p.point.y } : null;
    if (!next && !this.hover) return;
    this.hover = next;
    if (this.model) this.requestUpdate?.();
  };

  constructor(
    private readonly deps: OrderFlowPrimitiveDeps,
    /** Builds the GPU surface (tests pass a fake; null = no WebGL). */
    private readonly makeSurface: () => HeatSurface | null = () => createWebGlHeatSurface(),
  ) {}

  attached(param: { chart: IChartApi; requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
    this.chart = param.chart;
    this.chart.subscribeCrosshairMove(this.onCrosshair);
  }

  detached(): void {
    this.chart?.unsubscribeCrosshairMove(this.onCrosshair);
    this.chart = null;
    this.requestUpdate = undefined;
    this.gpu?.dispose();
    this.gpu = undefined;
  }

  setModel(model: HeatmapLayerModel | null): void {
    if (model === this.model) return;
    this.model = model;
    this.requestUpdate?.();
  }

  /** Repaint (the bars under it moved, or the stream layer advanced). */
  redraw(): void {
    this.requestUpdate?.();
  }

  /** Recent GPU-layer frame times (ms: projection + upload + draw + composite), for benchmarks. */
  frameStats(): { n: number; p50: number; p95: number; max: number } {
    const s = [...this.frameMs].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
    return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? 0 };
  }

  updateAllViews(): void {
    /* projected per frame */
  }

  /** The cells below the candles; the hover card above them. */
  private readonly views = [
    {
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: () => undefined,
        drawBackground: (target: CanvasRenderingTarget2D) => this.draw(target),
      }),
    },
    {
      zOrder: () => 'top' as const,
      renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.drawHover(target) }),
    },
  ];

  paneViews() {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const model = this.model;
    this.placed = [];
    this.segments = [];
    if (!model || model.opacity <= 0) return;
    if (model.stream) this.drawStream(target, model.stream, model.opacity);
    else this.drawGrid(target, model.grid, model.opacity);
  }

  // ── Event-level (WebGL) ─────────────────────────────────────────────────────

  private drawStream(target: CanvasRenderingTarget2D, src: StreamHeatSource, opacity: number): void {
    const series = this.deps.series();
    const layer = src.layer();
    if (!series || !layer) return;
    if (this.gpu === undefined) this.gpu = this.makeSurface();
    const gpu = this.gpu;
    if (!gpu) return;
    const started = performance.now();
    const spec = layer.folder.spec;
    // Draw up to the end of the column the fold reached (now live, the head in replay); nothing past it.
    const lastCol = Math.min(spec.cols, layer.folder.colOf(layer.foldedTo) + 1);
    const t1 = spec.t0 + lastCol * spec.colMs;
    this.segments = timeSegments(this.deps.barTimes?.() ?? [], this.deps.barMs?.() ?? 0, spec.t0, t1);
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const width = bitmapSize.width / hr;
      const height = bitmapSize.height / vr;
      const quads = heatQuads(spec, this.segments, this.deps.xAt, (p) => series.priceToCoordinate(p), width, height);
      gpu.sync(layer.folder);
      gpu.draw({
        width,
        height,
        pixelWidth: bitmapSize.width,
        pixelHeight: bitmapSize.height,
        quads,
        robustMax: layer.robustMax,
        opacity,
      });
      ctx.drawImage(gpu.canvas as CanvasImageSource, 0, 0, bitmapSize.width, bitmapSize.height);
      // Best bid / ask from the ticks.
      ctx.save();
      ctx.scale(hr, vr);
      ctx.globalAlpha = Math.min(1, opacity + 0.3);
      ctx.lineWidth = 1;
      this.drawQuoteLines(ctx, layer, series, t1, width);
      ctx.restore();
    });
    this.frameMs.push(performance.now() - started);
    if (this.frameMs.length > FRAME_SAMPLES) this.frameMs.shift();
  }

  private drawQuoteLines(
    ctx: CanvasRenderingContext2D,
    layer: StreamHeatLayer,
    series: ISeriesApi<SeriesType>,
    t1: number,
    width: number,
  ): void {
    const ticks = layer.ticks;
    if (!ticks.size) return;
    const spec = layer.folder.spec;
    const i0 = ticks.lowerBound(spec.t0);
    const i1 = ticks.lowerBound(Math.min(t1, layer.foldedTo + 1));
    for (const [which, color] of [
      ['bid', '#26A69A'],
      ['ask', '#EF5350'],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      let lastX = -Infinity;
      let lastY: number | null = null;
      for (let i = i0; i < i1; i++) {
        const x = this.deps.xAt(ticks.timeAt(i));
        const y = series.priceToCoordinate(which === 'bid' ? ticks.bidAt(i) : ticks.askAt(i));
        if (x === null || y === null) continue;
        if (x > width + 1) break;
        // A pause longer than the feed's snapshot cadence breaks the line (nothing carried across a gap).
        if (lastY === null || (i > i0 && ticks.timeAt(i) - ticks.timeAt(i - 1) > 65_000)) ctx.moveTo(x, y);
        else {
          ctx.lineTo(x, lastY);
          ctx.lineTo(x, y);
        }
        lastX = x;
        lastY = y;
      }
      if (lastY !== null) {
        const end = this.deps.xAt(Math.min(t1, layer.foldedTo));
        if (end !== null && end > lastX) ctx.lineTo(end, lastY);
      }
      ctx.stroke();
    }
  }

  // ── Bucketed (canvas 2D) ────────────────────────────────────────────────────

  private drawGrid(target: CanvasRenderingTarget2D, grid: HeatGrid, opacity: number): void {
    const series = this.deps.series();
    if (!series || grid.columns.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.placed = placeHeatGrid(
        grid,
        this.deps.xAt,
        (p) => series.priceToCoordinate(p),
        mediaSize.width,
        mediaSize.height,
      );
      ctx.save();
      ctx.globalAlpha = opacity;
      for (const col of this.placed) {
        const w = col.x1 - col.x0;
        for (const cell of col.cells) {
          ctx.fillStyle = heatLutColor(cell.volume, grid.robustMax);
          ctx.fillRect(col.x0, cell.y, w, cell.h);
        }
      }
      // Best bid / ask as step lines over the buckets that have a book.
      ctx.globalAlpha = Math.min(1, opacity + 0.3);
      ctx.lineWidth = 1;
      for (const [key, color] of [
        ['bid', '#26A69A'],
        ['ask', '#EF5350'],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        let open = false;
        let lastEnd = NaN;
        for (const p of this.placed) {
          const price = p.column[key];
          const y = price > 0 ? series.priceToCoordinate(price) : null;
          if (y === null) {
            open = false;
            continue;
          }
          // A gap (no snapshot in a bucket) breaks the line: nothing is carried forward.
          if (!open || Math.abs(p.x0 - lastEnd) > 1) ctx.moveTo(p.x0, y);
          else ctx.lineTo(p.x0, y);
          ctx.lineTo(p.x1, y);
          open = true;
          lastEnd = p.x1;
        }
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // ── Hover ───────────────────────────────────────────────────────────────────

  private drawHover(target: CanvasRenderingTarget2D): void {
    const model = this.model;
    const series = this.deps.series();
    const hover = this.hover;
    if (!model || !series || !hover) return;
    const lines = model.stream ? this.streamHoverLines(model.stream, series, hover) : this.gridHoverLines(series, hover);
    if (!lines) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) =>
      drawHoverCard(ctx, lines, hover.x, hover.y, mediaSize, this.deps.dark()),
    );
  }

  private gridHoverLines(series: ISeriesApi<SeriesType>, hover: { x: number; y: number }): string[] | null {
    // The same rectangles the frame painted (placeHeatGrid): what the card names is what is under the pointer.
    const hit = heatHitAt(this.placed, hover.x, hover.y);
    if (!hit) return null;
    const c = hit.column;
    const price = hit.cell?.price ?? Number(series.coordinateToPrice(hover.y));
    const volume = hit.cell?.volume ?? 0;
    if (!Number.isFinite(price)) return null;
    const digits = this.deps.precision();
    return [
      `Broker DOM · ${price.toFixed(digits)}`,
      volume > 0 ? `${formatUnits(volume)} units resting` : 'No liquidity shown at this price',
      `Book captured ${formatUtcShort(c.capturedAt)}`,
    ];
  }

  /** The exact book at the instant and price under the pointer (folded from the timeline), and the column's max. */
  private streamHoverLines(
    src: StreamHeatSource,
    series: ISeriesApi<SeriesType>,
    hover: { x: number; y: number },
  ): string[] | null {
    const layer = src.layer();
    if (!layer) return null;
    return streamHoverText(layer, src.label, timeAtX(this.segments, this.deps.xAt, hover.x), Number(series.coordinateToPrice(hover.y)), this.deps.precision());
  }
}

/** The stream layer's hover card at (t, price): the exact book then, and what the painted column holds. */
export function streamHoverText(
  layer: StreamHeatLayer,
  label: string,
  t: number | null,
  priceRaw: number,
  digits: number,
): string[] | null {
  if (t === null || !Number.isFinite(priceRaw) || t > layer.foldedTo) return null;
  const f = layer.folder;
  const cell = f.cellAt(t, priceRaw);
  if (!cell) return null;
  const book = layer.timeline.at(t);
  const half = f.spec.rowStep / 2;
  let size = 0;
  if (book.known)
    for (const m of [book.bids, book.asks])
      for (const [p, s] of m) if (p >= cell.price - half - 1e-12 && p < cell.price + half - 1e-12) size += s;
  const lines = [`${label} · ${cell.price.toFixed(digits)}`];
  if (!book.known || t - book.t > 65_000) {
    lines.push('Book unknown here (no snapshot yet, or the feed paused)');
    return lines;
  }
  lines.push(
    size > 0
      ? `${formatUnits(size)} resting (size as reported) at ${formatUtcMs(t)}`
      : `Nothing resting at ${formatUtcMs(t)}`,
  );
  if (cell.size > size) lines.push(`Most in this pixel column: ${formatUnits(cell.size)}`);
  const bb = book.bestBid();
  const ba = book.bestAsk();
  if (bb !== null && ba !== null)
    lines.push(`Best ${bb.toFixed(digits)} / ${ba.toFixed(digits)} · last change ${formatUtcMs(book.t)}`);
  return lines;
}
