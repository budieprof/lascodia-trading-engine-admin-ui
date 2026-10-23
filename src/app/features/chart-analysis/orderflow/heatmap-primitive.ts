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
import { heatLutColor, type HeatColumn, type HeatGrid } from './heatmap-grid';

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

/** A column as placed on the last frame (media px). */
interface PlacedColumn {
  x0: number;
  x1: number;
  column: HeatColumn;
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
  private placed: PlacedColumn[] = [];
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
      const width = mediaSize.width;
      const half = grid.rowStep / 2;
      // Rows share keys across columns: each row's y is projected once per frame.
      const rowY = new Map<number, [number, number] | null>();
      const yOf = (key: number): [number, number] | null => {
        let hit = rowY.get(key);
        if (hit !== undefined) return hit;
        const p = key * grid.rowStep;
        const top = series.priceToCoordinate(p + half);
        const bottom = series.priceToCoordinate(p - half);
        hit =
          top === null || bottom === null
            ? null
            : [Math.min(top, bottom), Math.max(1, Math.abs(bottom - top))];
        rowY.set(key, hit);
        return hit;
      };
      ctx.save();
      ctx.globalAlpha = model.opacity;
      for (const c of grid.columns) {
        const x0 = this.deps.xAt(c.t);
        const x1 = this.deps.xAt(c.end);
        if (x0 === null || x1 === null || x1 < 0 || x0 > width) continue;
        const left = Math.floor(x0);
        const w = Math.max(1, Math.ceil(x1) - left);
        this.placed.push({ x0: left, x1: left + w, column: c });
        for (let i = 0; i < c.rows.length; i++) {
          const v = c.volumes[i];
          if (!(v > 0)) continue;
          const y = yOf(c.rows[i]);
          if (!y || y[0] > mediaSize.height || y[0] + y[1] < 0) continue;
          ctx.fillStyle = heatLutColor(v, grid.robustMax);
          ctx.fillRect(left, y[0], w, y[1]);
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
    const placed = this.placed.find((p) => hover.x >= p.x0 && hover.x < p.x1);
    if (!placed) return;
    const price = series.coordinateToPrice(hover.y);
    if (price === null) return;
    const { grid } = model;
    const c = placed.column;
    const key = Math.round(Number(price) / grid.rowStep);
    let volume = 0;
    for (let i = 0; i < c.rows.length; i++) if (c.rows[i] === key) volume = c.volumes[i];
    const digits = this.deps.precision();
    const lines = [
      `Broker DOM · ${(key * grid.rowStep).toFixed(digits)}`,
      volume > 0 ? `${formatUnits(volume)} units resting` : 'No liquidity shown at this price',
      `Book captured ${formatUtcShort(c.capturedAt)}`,
    ];
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) =>
      drawHoverCard(ctx, lines, hover.x, hover.y, mediaSize, this.deps.dark()),
    );
  }
}
