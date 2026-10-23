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
import { drawHoverCard, formatUtcShort } from './canvas-text';
import {
  heatHitAt,
  heatLutColor,
  placeHeatGrid,
  type HeatGrid,
  type PlacedHeatColumn,
} from './heatmap-grid';

/** What the heatmap draws: the (replay-clipped) grid and its opacity. */
export interface HeatmapLayerModel {
  grid: HeatGrid;
  opacity: number;
}

export interface OrderFlowPrimitiveDeps {
  series: () => ISeriesApi<SeriesType> | null;
  /** UTC ms → x on the pane (media px), where a bar's OPEN is its left edge; null with no bars. */
  xAt: (utcMs: number) => number | null;
  dark: () => boolean;
  precision: () => number;
}

/**
 * OF-1 — the liquidity heatmap (Bookmap): one broker's DOM per time bucket painted BEHIND the candles (`zOrder`
 * bottom). Each bucket's levels fill their own bucket only — a gap where no snapshot was captured stays empty — coloured
 * on a log scale against the grid's robust max, so resting walls glow and liquidity that is pulled visibly fades out
 * of the next column. The best bid / ask run over it as step lines. Hovering shows the cell's price, units and time.
 *
 * The grid is binned once per answer (heatmap-grid.ts); a frame only projects it, and a crosshair move only repaints.
 */
export class HeatmapPrimitive implements ISeriesPrimitive<Time> {
  private model: HeatmapLayerModel | null = null;
  private requestUpdate?: () => void;
  private chart: IChartApi | null = null;
  private hover: { x: number; y: number } | null = null;
  private placed: PlacedHeatColumn[] = [];
  private readonly onCrosshair = (p: MouseEventParams<Time>) => {
    const next = p.point && (p.paneIndex ?? 0) === 0 ? { x: p.point.x, y: p.point.y } : null;
    if (!next && !this.hover) return;
    this.hover = next;
    if (this.model) this.requestUpdate?.();
  };

  constructor(private readonly deps: OrderFlowPrimitiveDeps) {}

  attached(param: { chart: IChartApi; requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
    this.chart = param.chart;
    this.chart.subscribeCrosshairMove(this.onCrosshair);
  }

  detached(): void {
    this.chart?.unsubscribeCrosshairMove(this.onCrosshair);
    this.chart = null;
    this.requestUpdate = undefined;
  }

  setModel(model: HeatmapLayerModel | null): void {
    if (model === this.model) return;
    this.model = model;
    this.requestUpdate?.();
  }

  /** Repaint (the bars under it moved). */
  redraw(): void {
    this.requestUpdate?.();
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
    const series = this.deps.series();
    this.placed = [];
    if (!model || !series || model.grid.columns.length === 0 || model.opacity <= 0) return;
    const { grid } = model;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.placed = placeHeatGrid(
        grid,
        this.deps.xAt,
        (p) => series.priceToCoordinate(p),
        mediaSize.width,
        mediaSize.height,
      );
      ctx.save();
      ctx.globalAlpha = model.opacity;
      for (const col of this.placed) {
        const w = col.x1 - col.x0;
        for (const cell of col.cells) {
          ctx.fillStyle = heatLutColor(cell.volume, grid.robustMax);
          ctx.fillRect(col.x0, cell.y, w, cell.h);
        }
      }
      // Best bid / ask as step lines over the buckets that have a book.
      ctx.globalAlpha = Math.min(1, model.opacity + 0.3);
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

  private drawHover(target: CanvasRenderingTarget2D): void {
    const model = this.model;
    const series = this.deps.series();
    const hover = this.hover;
    if (!model || !series || !hover) return;
    // The same rectangles the frame painted (placeHeatGrid): what the card names is what is under the pointer.
    const hit = heatHitAt(this.placed, hover.x, hover.y);
    if (!hit) return;
    const c = hit.column;
    const price = hit.cell?.price ?? Number(series.coordinateToPrice(hover.y));
    const volume = hit.cell?.volume ?? 0;
    if (!Number.isFinite(price)) return;
    const digits = this.deps.precision();
    const lines = [
      `Broker DOM · ${price.toFixed(digits)}`,
      volume > 0 ? `${formatUnits(volume)} units resting` : 'No liquidity shown at this price',
      `Book captured ${formatUtcShort(c.capturedAt)}`,
    ];
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) =>
      drawHoverCard(ctx, lines, hover.x, hover.y, mediaSize, this.deps.dark()),
    );
  }
}
