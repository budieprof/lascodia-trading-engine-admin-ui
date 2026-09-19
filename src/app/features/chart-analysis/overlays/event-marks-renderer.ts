import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesPrimitive, Time } from 'lightweight-charts';

/**
 * Economic events on the time axis — TradingView's "timescale marks".
 *
 * These matter more here than on a generic chart: positions held across Tier-1
 * prints are already known to be where a large share of this system's losses
 * come from, so seeing where those prints land relative to a setup is the
 * point of the feature, not decoration.
 *
 * Drawn as a vertical band plus a flag at the bottom rather than a bar marker,
 * because an event belongs to an INSTANT on the axis, not to a candle: a
 * 13:30 print has no H4 bar of its own, and pinning it to the nearest bar
 * would put an NFP release two hours from where it happened.
 */

export type EventImpact = 'High' | 'Medium' | 'Low';

export interface EventMark {
  /** Scheduled time, in the same (possibly shifted) clock as the bars. */
  time: number;
  title: string;
  currency: string;
  impact: EventImpact;
}

const IMPACT_COLOR: Record<EventImpact, string> = {
  High: '#EF5350',
  Medium: '#FFA726',
  Low: '#787B86',
};

export class EventMarksRenderer implements ISeriesPrimitive<Time> {
  private marks: EventMark[] = [];
  private requestUpdate?: () => void;
  private minImpact: EventImpact = 'Medium';

  constructor(private readonly chart: () => IChartApi | null) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setMarks(marks: EventMark[], minImpact: EventImpact = 'Medium'): void {
    this.marks = marks;
    this.minImpact = minImpact;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected per frame */
  }

  paneViews() {
    return [
      {
        // `normal`, not `bottom`. At `bottom` the band renders beneath the
        // pane's own background and is simply invisible; the alpha below is
        // what keeps it from obscuring the candles an operator is reading.
        zOrder: () => 'normal' as const,
        renderer: () => ({
          draw: (target: CanvasRenderingTarget2D) => this.draw(target),
        }),
      },
    ];
  }

  private passes(impact: EventImpact): boolean {
    const rank: Record<EventImpact, number> = { Low: 0, Medium: 1, High: 2 };
    return rank[impact] >= rank[this.minImpact];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart();
    if (!chart || this.marks.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const h = scope.bitmapSize.height / scope.verticalPixelRatio;
      const w = scope.bitmapSize.width / scope.horizontalPixelRatio;
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';

      let lastLabelX = -Infinity;
      for (const mark of this.marks) {
        if (!this.passes(mark.impact)) continue;
        const x = chart.timeScale().timeToCoordinate((mark.time / 1000) as Time);
        if (x === null || x < 0 || x > w) continue;

        const color = IMPACT_COLOR[mark.impact];
        ctx.strokeStyle = color;
        ctx.globalAlpha = mark.impact === 'High' ? 0.5 : 0.28;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillRect(x - 1, h - 16, 2, 12);

        // Labels are suppressed when they would collide: a busy calendar day
        // otherwise renders a solid strip of overlapping currency codes.
        if (x - lastLabelX > 44) {
          ctx.fillText(mark.currency, x + 3, h - 4);
          lastLabelX = x;
        }
      }
      ctx.restore();
    });
  }
}
