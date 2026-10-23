import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesPrimitive, MouseEventParams, Time } from 'lightweight-charts';

import { drawHoverCard, formatUtcShort } from './canvas-text';
import { slippageText, type FillMark, type SlippageKind } from './fills';
import type { OrderFlowPrimitiveDeps } from './heatmap-primitive';

const KIND_COLOR: Record<SlippageKind, string> = {
  adverse: '#EF5350',
  favourable: '#26A69A',
  none: '#787B86',
};
const PAPER = '#9C27B0';

/**
 * OF-6 — fills on the price pane: a marker at each fill's price, at the moment it was recorded, with a thin tie to the
 * price that was requested; red when the fill was worse than requested, green when better, grey when even. Hovering a
 * marker shows requested vs filled and the slippage in pips and points.
 */
export class FillsPrimitive implements ISeriesPrimitive<Time> {
  private fills: readonly FillMark[] = [];
  private requestUpdate?: () => void;
  private alpha = 1;
  private chart: IChartApi | null = null;
  private hover: { x: number; y: number } | null = null;
  private placed: { x: number; y: number; fill: FillMark }[] = [];
  private readonly onCrosshair = (p: MouseEventParams<Time>) => {
    const next = p.point && (p.paneIndex ?? 0) === 0 ? { x: p.point.x, y: p.point.y } : null;
    if (!next && !this.hover) return;
    this.hover = next;
    if (this.fills.length) this.requestUpdate?.();
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

  /** The Order flow layer group's opacity (0..1). */
  setAlpha(alpha: number): void {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.requestUpdate?.();
  }

  setFills(fills: readonly FillMark[]): void {
    if (fills === this.fills) return;
    this.fills = fills;
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
    const series = this.deps.series();
    this.placed = [];
    if (!series || this.fills.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      for (const f of this.fills) {
        const x = this.deps.xAt(f.time);
        const y = series.priceToCoordinate(f.filledPrice);
        if (x === null || y === null || x < -10 || x > mediaSize.width + 10) continue;
        const color = f.isPaper ? PAPER : KIND_COLOR[f.kind];
        const ry = series.priceToCoordinate(f.requestedPrice);
        if (ry !== null && Math.abs(ry - y) >= 1) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(x, ry);
          ctx.lineTo(x, y);
          ctx.moveTo(x - 4, ry);
          ctx.lineTo(x + 4, ry);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = color;
        ctx.strokeStyle = this.deps.dark() ? '#131722' : '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (f.side === 'Buy') {
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 5, y + 4);
          ctx.lineTo(x - 5, y + 4);
        } else if (f.side === 'Sell') {
          ctx.moveTo(x, y + 5);
          ctx.lineTo(x + 5, y - 4);
          ctx.lineTo(x - 5, y - 4);
        } else {
          ctx.arc(x, y, 4, 0, Math.PI * 2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this.placed.push({ x, y, fill: f });
      }
      const hover = this.hover;
      const hit = hover
        ? this.placed
            .map((p) => ({ p, d: Math.hypot(p.x - hover.x, p.y - hover.y) }))
            .filter((h) => h.d <= 8)
            .sort((a, b) => a.d - b.d)[0]?.p
        : undefined;
      if (hit && hover) {
        const f = hit.fill;
        const digits = this.deps.precision();
        const lines = [
          `${f.isPaper ? 'Paper ' : ''}${f.side ?? 'Order'} fill · order #${f.orderId}${f.accountId !== null ? ` · account ${f.accountId}` : ''}`,
          `Requested ${f.requestedPrice.toFixed(digits)} → filled ${f.filledPrice.toFixed(digits)}`,
          `Slippage ${slippageText(f)}`,
          `${formatUtcShort(f.time)} · ${f.submitToFillMs} ms submit → fill${f.partial ? ' · partial' : ''}`,
        ];
        drawHoverCard(ctx, lines, hit.x, hit.y, mediaSize, this.deps.dark());
      }
      ctx.restore();
    });
  }
}
