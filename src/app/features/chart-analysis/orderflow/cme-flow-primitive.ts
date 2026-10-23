import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesPrimitive, MouseEventParams, Time } from 'lightweight-charts';

import { drawHoverCard } from './canvas-text';
import { cmeMarkerAt, cmeMarkerText, placeCmeMarkers, type CmeFlowFeed, type PlacedCmeMarker } from './cme-flow';
import type { OrderFlowPrimitiveDeps } from './heatmap-primitive';

/** What the CME layer draws: the feed (pulled per frame), its legend label, which marker kinds, and the clip. */
export interface CmeFlowLayerModel {
  feed: CmeFlowFeed;
  /** "CME 6E (futures, basis-adjusted)". */
  label: string;
  show: { large: boolean; sweeps: boolean; levels: boolean };
  /** Nothing at or after this instant (the replay head); null live. */
  clipUtc: number | null;
}

const BUY = '#26A69A';
const SELL = '#EF5350';
const NEUTRAL = '#787B86';
const ICE = '#4FC3F7';
const ABSORB = '#FFB300';

/**
 * CME order-flow markers over the candles (cme-tier2), all from the engine's analysis of the REAL CME tape + book:
 * ◆ large lot (an aggressor order ≥ the threshold; area ∝ contracts, green buy / red sell), ↗ sweep / stop run (a
 * line from the first to the last level taken, arrow at the end), ▭ ICE iceberg-like level (traded beyond what it showed
 * while refilling — MBP-10 cannot prove a hidden order), ■ ABS absorption (aggression into a level that held). Hover:
 * the detail, in spot terms, sizes in contracts.
 */
export class CmeFlowPrimitive implements ISeriesPrimitive<Time> {
  private model: CmeFlowLayerModel | null = null;
  private requestUpdate?: () => void;
  private chart: IChartApi | null = null;
  private alpha = 1;
  private hover: { x: number; y: number } | null = null;
  private placed: PlacedCmeMarker[] = [];
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

  setModel(model: CmeFlowLayerModel | null): void {
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
    const data = m?.feed.data;
    if (!m || !series || !data) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.placed = placeCmeMarkers(data, m.show, this.deps.xAt, (p) => series.priceToCoordinate(p),
        mediaSize.width, mediaSize.height, m.clipUtc);
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineWidth = 1.5;
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const k of this.placed) {
        const colour = k.side > 0 ? BUY : k.side < 0 ? SELL : NEUTRAL;
        switch (k.kind) {
          case 'large':
            ctx.beginPath();
            ctx.moveTo(k.x, k.y - k.r);
            ctx.lineTo(k.x + k.r, k.y);
            ctx.lineTo(k.x, k.y + k.r);
            ctx.lineTo(k.x - k.r, k.y);
            ctx.closePath();
            ctx.fillStyle = `${colour}66`;
            ctx.fill();
            ctx.strokeStyle = colour;
            ctx.stroke();
            break;
          case 'sweep': {
            ctx.strokeStyle = colour;
            ctx.beginPath();
            ctx.moveTo(k.x, k.y);
            ctx.lineTo(k.x2 + 0.01, k.y2);
            ctx.stroke();
            const ang = Math.atan2(k.y2 - k.y, k.x2 + 0.01 - k.x);
            ctx.beginPath();
            ctx.moveTo(k.x2, k.y2);
            ctx.lineTo(k.x2 - 6 * Math.cos(ang - 0.45), k.y2 - 6 * Math.sin(ang - 0.45));
            ctx.lineTo(k.x2 - 6 * Math.cos(ang + 0.45), k.y2 - 6 * Math.sin(ang + 0.45));
            ctx.closePath();
            ctx.fillStyle = colour;
            ctx.fill();
            break;
          }
          case 'iceberg':
            ctx.strokeStyle = ICE;
            ctx.fillStyle = `${ICE}33`;
            ctx.fillRect(k.x, k.y - 4, Math.max(8, k.x2 - k.x), 8);
            ctx.strokeRect(k.x, k.y - 4, Math.max(8, k.x2 - k.x), 8);
            ctx.fillStyle = ICE;
            ctx.fillText('ICE', Math.max(k.x2, k.x + 8) + 3, k.y);
            break;
          default:
            ctx.fillStyle = `${ABSORB}55`;
            ctx.strokeStyle = ABSORB;
            ctx.fillRect(k.x - k.r / 2, k.y - k.r / 2, k.r, k.r);
            ctx.strokeRect(k.x - k.r / 2, k.y - k.r / 2, k.r, k.r);
            ctx.fillStyle = ABSORB;
            ctx.fillText('ABS', k.x + k.r / 2 + 3, k.y);
        }
      }
      ctx.restore();
      const hover = this.hover;
      const hit = hover ? cmeMarkerAt(this.placed, hover.x, hover.y) : null;
      if (hit && hover)
        drawHoverCard(ctx, cmeMarkerText(hit, m.label, this.deps.precision()), hover.x, hover.y, mediaSize, this.deps.dark());
    });
  }
}
