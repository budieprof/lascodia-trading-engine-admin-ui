import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesPrimitive, MouseEventParams, Time } from 'lightweight-charts';

import { formatUnits } from '../panels/side/depth';
import { drawHoverCard, formatUtcMs } from './canvas-text';
import type { OrderFlowPrimitiveDeps } from './heatmap-primitive';
import { bubbleAt, placeBubbles, type PlacedBubble, type TradeFeed } from './trade-bubbles';

/** What the bubbles layer draws: a trade feed (pulled per frame), its source's label, the filter, and the clip. */
export interface TradeBubblesModel {
  feed: TradeFeed;
  label: string;
  minSize: number;
  /** Nothing at or after this instant (the replay head); null live. */
  clipUtc: number | null;
}

const SIDE_FILL: Record<number, string> = { 1: 'rgba(38,166,154,0.55)', [-1]: 'rgba(239,83,80,0.55)', 0: 'rgba(120,123,134,0.5)' };
const SIDE_STROKE: Record<number, string> = { 1: '#26A69A', [-1]: '#EF5350', 0: '#787B86' };

/**
 * Trade bubbles over the candles: each REAL trade of a CME / venue source as a circle (area ∝ size, colour = aggressor
 * side). Hovering one shows its time (ms), price, size and side, and the source.
 */
export class TradeBubblesPrimitive implements ISeriesPrimitive<Time> {
  private model: TradeBubblesModel | null = null;
  private requestUpdate?: () => void;
  private chart: IChartApi | null = null;
  private alpha = 1;
  private hover: { x: number; y: number } | null = null;
  private placed: PlacedBubble[] = [];
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

  setModel(model: TradeBubblesModel | null): void {
    if (model === this.model) return;
    this.model = model;
    this.requestUpdate?.();
  }

  setAlpha(alpha: number): void {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.requestUpdate?.();
  }

  redraw(): void {
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
    const m = this.model;
    const series = this.deps.series();
    this.placed = [];
    if (!m || !series || m.feed.ring.size === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ring = m.feed.ring;
      const t1 = m.clipUtc ?? Infinity;
      this.placed = placeBubbles(ring, -Infinity, t1, m.minSize, m.feed.refMax, this.deps.xAt, (p) => series.priceToCoordinate(p), mediaSize.width, mediaSize.height);
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineWidth = 1;
      for (const b of this.placed) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = SIDE_FILL[b.side] ?? SIDE_FILL[0];
        ctx.fill();
        ctx.strokeStyle = SIDE_STROKE[b.side] ?? SIDE_STROKE[0];
        ctx.stroke();
      }
      ctx.restore();
      const hover = this.hover;
      const hit = hover ? bubbleAt(this.placed, hover.x, hover.y) : null;
      if (hit && hover) {
        const digits = this.deps.precision();
        const side = hit.side === 1 ? 'buyer-initiated' : hit.side === -1 ? 'seller-initiated' : 'aggressor not reported';
        drawHoverCard(
          ctx,
          [`${m.label} trade · ${hit.price.toFixed(digits)}`, `${formatUnits(hit.size)} (size as reported) · ${side}`, formatUtcMs(hit.t)],
          hover.x,
          hover.y,
          mediaSize,
          this.deps.dark(),
        );
      }
    });
  }
}
