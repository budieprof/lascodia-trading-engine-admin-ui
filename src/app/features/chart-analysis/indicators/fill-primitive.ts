import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';

/** One fill between two plots of a study, per bar: the two values and the colour of that stretch. */
export interface FillModel {
  /** Plotted time (LWC seconds) per point, ascending. */
  times: number[];
  a: (number | null)[];
  b: (number | null)[];
  /** Colour while `a` is at or above `b`; `colorBelow` (or the same) while it is below. */
  color: string;
  colorBelow?: string;
}

/**
 * The band / cloud between two plots of a built-in study (DR-I4): Ichimoku's cloud green while Span A is over Span B
 * and red while under, the Bollinger / Keltner / Donchian band. A series primitive on the study's first plot, so it
 * paints in that plot's pane under its lines; the points are projected each frame through the series and the time
 * scale, like the drawings.
 */
export class FillPrimitive implements ISeriesPrimitive<Time> {
  private models: FillModel[] = [];
  private requestUpdate?: () => void;
  private chartTimeToX: ((t: number) => number | null) | null = null;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    timeToX: (t: number) => number | null,
  ) {
    this.chartTimeToX = timeToX;
  }

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setFills(models: FillModel[]): void {
    this.models = models;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projected in draw() */
  }

  paneViews() {
    return [
      {
        zOrder: () => 'bottom' as const,
        renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const series = this.series();
    const toX = this.chartTimeToX;
    if (!series || !toX || !this.models.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const m of this.models) {
        // Runs of bars where both values exist and `a` stays on one side of `b`: one polygon each.
        let run: { x: number; ya: number; yb: number }[] = [];
        let above: boolean | null = null;
        const flush = () => {
          if (run.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(run[0].x, run[0].ya);
            for (const p of run) ctx.lineTo(p.x, p.ya);
            for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k].x, run[k].yb);
            ctx.closePath();
            ctx.fillStyle = above === false ? (m.colorBelow ?? m.color) : m.color;
            ctx.fill();
          }
          run = [];
        };
        for (let i = 0; i < m.times.length; i++) {
          const a = m.a[i];
          const b = m.b[i];
          const x = toX(m.times[i]);
          if (a === null || b === null || x === null) {
            flush();
            above = null;
            continue;
          }
          const ya = series.priceToCoordinate(a);
          const yb = series.priceToCoordinate(b);
          if (ya === null || yb === null) {
            flush();
            continue;
          }
          const side = a >= b;
          if (above !== null && side !== above) {
            // The cross: close this run at this bar and start the next one from it.
            run.push({ x, ya, yb });
            flush();
          }
          above = side;
          run.push({ x, ya, yb });
        }
        flush();
      }
    });
  }
}
