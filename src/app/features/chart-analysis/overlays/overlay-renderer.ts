import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesType,
  Time,
} from 'lightweight-charts';

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
 *
 * Laid out as TradingView's trading lines (CC-10): the label sits at the
 * RIGHT, next to the price axis, with the price itself as a chip ON the axis —
 * at x = 0 it covered the oldest candles and said nothing on the scale. An
 * entry line carries the position's live P&L.
 */

export type OverlayKind = 'entry' | 'stop' | 'target' | 'order';

export interface PriceOverlay {
  kind: OverlayKind;
  price: number;
  /** The line's name, e.g. `LONG 0.50` or `SL`. */
  label: string;
  color: string;
  /** An entry line's live P&L ("+12.4 pips · +0.62R · ≈ +12.40 USD"). */
  pnl?: string | null;
  /** Whether that P&L is a gain (its colour). */
  pnlUp?: boolean;
}

const KIND_ORDER: Record<OverlayKind, number> = { stop: 0, entry: 1, target: 2, order: 3 };

export class OverlayRenderer implements ISeriesPrimitive<Time> {
  private overlays: PriceOverlay[] = [];
  private requestUpdate?: () => void;
  private fit = true;

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

  /**
   * Whether the lines widen the price scale's fit (CC-10). On: a stop below the visible low is
   * kept on screen — the line the operator most needs to see. Off: a distant take-profit no
   * longer squashes the candles into a sliver; the lines show when the price range reaches them.
   */
  setFit(fit: boolean): void {
    if (fit === this.fit) return;
    this.fit = fit;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected per frame in draw() */
  }

  autoscaleInfo() {
    if (!this.fit || this.overlays.length === 0) return null;
    const prices = this.overlays.map((o) => o.price);
    return {
      priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) },
    };
  }

  /** The lines' prices as chips on the price axis, in each line's colour. */
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const series = this.series();
    if (!series) return [];
    const dp = this.precision();
    // Read at paint time: the views may outlive a scroll or a zoom of the price scale.
    const y = (o: PriceOverlay) => series.priceToCoordinate(o.price);
    return this.overlays.map((o) => ({
      coordinate: () => y(o) ?? -1000,
      text: () => o.price.toFixed(dp),
      textColor: () => '#FFFFFF',
      backColor: () => o.color,
      visible: () => y(o) !== null,
      tickVisible: () => true,
    }));
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

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const w = mediaSize.width;
      ctx.save();
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
        ctx.setLineDash([]);

        // The label at the right, against the axis (its price is the axis chip): name, then the
        // P&L in its own colour.
        const name = o.label;
        const pnl = o.pnl ?? '';
        const nameW = ctx.measureText(name).width;
        const pnlW = pnl ? ctx.measureText(pnl).width + 10 : 0;
        const boxW = nameW + 10 + pnlW;
        const x = Math.max(0, w - boxW - 6);
        ctx.fillStyle = o.color;
        ctx.fillRect(x, y - 8, nameW + 10, 16);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(name, x + 5, y);
        if (pnl) {
          const px = x + nameW + 10;
          ctx.fillStyle = o.pnlUp ? '#089981' : '#F23645';
          ctx.fillRect(px, y - 8, pnlW, 16);
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(pnl, px + 5, y);
        }
      }
      ctx.restore();
    });
  }
}
