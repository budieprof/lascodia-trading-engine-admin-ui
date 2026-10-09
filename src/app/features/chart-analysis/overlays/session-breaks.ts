import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesPrimitive, Time } from 'lightweight-charts';
import { xAtLogical } from '../chart/time-x';

/**
 * TradingView's "Session breaks" (CC-I9): a line where each trading day begins on an intraday chart —
 * for FX the 17:00 New York roll, wherever the axis is drawn — so a day's bars read as a day.
 */

/**
 * Indexes of the bars that open a new trading day: bar `i` whose day (`dayOf` of its UTC open)
 * differs from bar `i − 1`'s. Pure; `utcTimes` ascending.
 */
export function sessionBreakIndexes(
  utcTimes: readonly number[],
  dayOf: (utcMs: number) => number,
): number[] {
  const out: number[] = [];
  let previous: number | null = null;
  for (let i = 0; i < utcTimes.length; i++) {
    const day = dayOf(utcTimes[i]);
    if (previous !== null && day !== previous) out.push(i);
    previous = day;
  }
  return out;
}

/** The UTC day of an instant (00:00 UTC ms) — the trading day when the symbol's session is unknown. */
export function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/**
 * The lines, drawn between the last bar of a day and the first of the next — on the price pane as a series primitive,
 * on each study or script pane below it as a pane primitive (the same breaks), so a day reads as a day in every pane.
 */
export class SessionBreaksRenderer implements ISeriesPrimitive<Time> {
  private indexes: number[] = [];
  private requestUpdate?: () => void;

  constructor(
    private readonly chart: () => IChartApi | null,
    private readonly dark: () => boolean,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  /** The bars that open a day (plotted indexes); empty: no lines. The same breaks again change nothing. */
  setBreaks(indexes: readonly number[]): void {
    if (indexes.length === this.indexes.length && indexes.every((v, i) => v === this.indexes[i])) return;
    this.indexes = [...indexes];
    this.requestUpdate?.();
  }

  /** The breaks drawn now (the study and script panes draw the price pane's). */
  breaks(): readonly number[] {
    return this.indexes;
  }

  updateAllViews(): void {
    /* projected per frame */
  }

  paneViews() {
    return [
      {
        zOrder: () => 'bottom' as const,
        renderer: () => ({
          draw: () => undefined,
          drawBackground: (target: CanvasRenderingTarget2D) => this.draw(target),
        }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const scale = this.chart()?.timeScale();
    if (!scale || this.indexes.length === 0) return;
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.strokeStyle = this.dark() ? 'rgba(149,152,161,0.35)' : 'rgba(120,123,134,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (const i of this.indexes) {
        if (i < range.from - 1 || i > range.to + 1) continue;
        // Half a bar before the day's first bar (the library answers whole indexes only: xAtLogical).
        const x = xAtLogical(scale, i - 0.5);
        if (x === null) continue;
        const px = Math.round(x) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, mediaSize.height);
      }
      ctx.stroke();
      ctx.restore();
    });
  }
}
