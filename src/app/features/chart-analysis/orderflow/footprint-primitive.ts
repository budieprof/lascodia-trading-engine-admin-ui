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
 * OF-3 — the footprint: inside each bar, one cell per price row with its "down × up" TICK COUNTS (tick rule over the
 * broker's quotes — not traded volume, which spot FX does not publish). Diagonal 3:1 imbalances are shaded (green:
 * up-ticks against the row below, red: down-ticks against the row above) and the bar's busiest row is outlined.
 * Drawn above the candles; the page only hands it bars wide enough to read (≥ 60 px).
 */
export class FootprintPrimitive implements ISeriesPrimitive<Time> {
  private model: FootprintLayerModel | null = null;
  private requestUpdate?: () => void;

  constructor(private readonly deps: OrderFlowPrimitiveDeps) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
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
          ctx.fillStyle = c.buyImbalance
            ? 'rgba(38,166,154,0.38)'
            : c.sellImbalance
              ? 'rgba(239,83,80,0.38)'
              : dark
                ? 'rgba(42,46,57,0.55)'
                : 'rgba(240,243,250,0.7)';
          ctx.fillRect(left, top + 0.5, w, Math.max(1, h - 1));
          if (c.maxActivity) {
            ctx.strokeStyle = '#FFB300';
            ctx.lineWidth = 1;
            ctx.strokeRect(left + 0.5, top + 1, w - 1, Math.max(1, h - 2));
          }
          if (h >= 10) {
            const cy = top + h / 2;
            const mid = left + w / 2;
            ctx.fillStyle = dark ? '#787b86' : '#9598a1';
            ctx.fillText('×', mid, cy);
            ctx.textAlign = 'right';
            ctx.fillStyle = DOWN;
            ctx.fillText(String(c.down), mid - 5, cy);
            ctx.textAlign = 'left';
            ctx.fillStyle = UP;
            ctx.fillText(String(c.up), mid + 5, cy);
            ctx.textAlign = 'center';
          }
        }
      }
      ctx.restore();
    });
  }
}
