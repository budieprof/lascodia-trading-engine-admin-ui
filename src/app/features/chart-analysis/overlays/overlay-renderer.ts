import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';

/**
 * Trading overlays: the system's own state drawn on the price scale.
 *
 * This is the half of the chart a generic TradingView cannot give you — open
 * positions with their entry, stop and target, and pending orders — and in
 * Advanced Charts it needed the paid Trading Platform (`createPositionLine`
 * and `createOrderLine` moved there in v29). Here they are just another
 * primitive.
 *
 * Kept separate from `DrawingRenderer` on purpose: these lines are DERIVED
 * from engine state, not authored by the operator. They must never be
 * selectable, draggable, undoable or persisted, and mixing them into the
 * drawing store would make all four possible by accident.
 */

export type OverlayKind = 'entry' | 'stop' | 'target' | 'order';

export interface PriceOverlay {
  kind: OverlayKind;
  price: number;
  /** Left-hand label, e.g. `LONG 0.50` or `SL`. */
  label: string;
  color: string;
}

const KIND_ORDER: Record<OverlayKind, number> = { stop: 0, entry: 1, target: 2, order: 3 };

export class OverlayRenderer implements ISeriesPrimitive<Time> {
  private overlays: PriceOverlay[] = [];
  private requestUpdate?: () => void;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly precision: () => number,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setOverlays(overlays: PriceOverlay[]): void {
    // Sorted so a stop and an entry at nearly the same price stack in a stable
    // order rather than flickering as the fetch order changes.
    this.overlays = [...overlays].sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.price - b.price,
    );
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected per frame in draw() */
  }

  /**
   * Keep every overlay inside the autoscale range.
   *
   * Without this, a stop below the visible low is simply clipped — the line
   * the operator most needs to see is the one that silently disappears.
   */
  autoscaleInfo() {
    if (this.overlays.length === 0) return null;
    const prices = this.overlays.map((o) => o.price);
    return {
      priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) },
    };
  }

  paneViews() {
    return [
      {
        zOrder: () => 'top' as const,
        renderer: () => ({
          draw: (target: CanvasRenderingTarget2D) => this.draw(target),
        }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const series = this.series();
    if (!series || this.overlays.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const w = scope.bitmapSize.width / scope.horizontalPixelRatio;
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      for (const o of this.overlays) {
        const y = series.priceToCoordinate(o.price);
        if (y === null) continue;

        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.kind === 'entry' ? 2 : 1;
        // Stops and targets are dashed so they read as levels price has not
        // reached, while the entry is solid because it already happened.
        ctx.setLineDash(o.kind === 'entry' ? [] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        const text = `${o.label}  ${o.price.toFixed(this.precision())}`;
        const tw = ctx.measureText(text).width + 10;
        ctx.setLineDash([]);
        ctx.fillStyle = o.color;
        ctx.fillRect(0, y - 8, tw, 16);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, 5, y);
      }
      ctx.restore();
    });
  }
}
