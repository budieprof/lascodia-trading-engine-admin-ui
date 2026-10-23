import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesPrimitive, Time } from 'lightweight-charts';

import type { OrderFlowPrimitiveDeps } from './heatmap-primitive';
import type { FootprintCell } from './tick-flow';

export interface FootprintBar {
  /** The bar's UTC open and exclusive end (ms). */
  t: number;
  end: number;
  cells: FootprintCell[];
}

export interface FootprintLayerModel {
  bars: FootprintBar[];
  /** Price height of a row. */
  rowPrice: number;
}

const UP = '#26A69A';
const DOWN = '#EF5350';

/**
 * OF-3 — the footprint: inside each bar, one cell per price row with its down (left) and up (right) TICK COUNTS (tick rule over the
 * broker's quotes — not traded volume, which spot FX does not publish). Diagonal 3:1 imbalances are shaded (green:
 * up-ticks against the row below, red: down-ticks against the row above) and the bar's busiest row is outlined.
 * Drawn above the candles; the page only hands it bars wide enough to read (≥ 60 px).
 */
export class FootprintPrimitive implements ISeriesPrimitive<Time> {
  private model: FootprintLayerModel | null = null;
  private requestUpdate?: () => void;
  private alpha = 1;

  constructor(private readonly deps: OrderFlowPrimitiveDeps) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  /** The Order flow layer group's opacity (0..1). */
  setAlpha(alpha: number): void {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.requestUpdate?.();
  }

  setModel(model: FootprintLayerModel | null): void {
    if (model === this.model) return;
    this.model = model;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected per frame */
  }

  private readonly views = [
    {
      zOrder: () => 'top' as const,
      renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
    },
  ];

  paneViews() {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const model = this.model;
    const series = this.deps.series();
    if (!model || !series || model.bars.length === 0) return;
    const dark = this.deps.dark();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const bar of model.bars) {
        const x0 = this.deps.xAt(bar.t);
        const x1 = this.deps.xAt(bar.end);
        if (x0 === null || x1 === null || x1 < 0 || x0 > mediaSize.width) continue;
        const left = x0 + 2;
        const w = x1 - x0 - 4;
        if (w < 20) continue;
        for (const c of bar.cells) {
          const yTop = series.priceToCoordinate(c.price + model.rowPrice);
          const yBot = series.priceToCoordinate(c.price);
          if (yTop === null || yBot === null) continue;
          const top = Math.min(yTop, yBot);
          const h = Math.max(1, Math.abs(yBot - yTop));
          if (top > mediaSize.height || top + h < 0) continue;
          // Light enough that the candle reads through: an imbalance shades only its own side of the cell (buyers'
          // up-ticks on the right, sellers' down-ticks on the left), a quiet cell is just a hairline frame.
          const half = w / 2;
          if (c.sellImbalance) {
            ctx.fillStyle = 'rgba(239,83,80,0.28)';
            ctx.fillRect(left, top + 0.5, half, Math.max(1, h - 1));
          }
          if (c.buyImbalance) {
            ctx.fillStyle = 'rgba(38,166,154,0.28)';
            ctx.fillRect(left + half, top + 0.5, w - half, Math.max(1, h - 1));
          }
          ctx.strokeStyle = c.maxActivity
            ? '#FFB300'
            : dark
              ? 'rgba(120,123,134,0.28)'
              : 'rgba(120,123,134,0.22)';
          ctx.lineWidth = 1;
          ctx.strokeRect(left + 0.5, top + 1, w - 1, Math.max(1, h - 2));
          if (h >= 10) {
            const cy = top + h / 2;
            // Counts at the cell's edges, each on a halo of the background, so the candle body in the middle stays
            // visible and the numbers stay legible over it.
            ctx.lineWidth = 3;
            ctx.strokeStyle = dark ? 'rgba(19,23,34,0.85)' : 'rgba(255,255,255,0.9)';
            ctx.textAlign = 'left';
            ctx.strokeText(String(c.down), left + 3, cy);
            ctx.fillStyle = DOWN;
            ctx.fillText(String(c.down), left + 3, cy);
            ctx.textAlign = 'right';
            ctx.strokeText(String(c.up), left + w - 3, cy);
            ctx.fillStyle = UP;
            ctx.fillText(String(c.up), left + w - 3, cy);
            ctx.textAlign = 'center';
          }
        }
      }
      ctx.restore();
    });
  }
}
