import type { Drawing } from './model';
import type { Pt } from './geometry';

/**
 * What every drawing tool's painter receives (tools/types.ts `PaintArgs` builds on it): the canvas, the drawing,
 * its anchors already projected to screen points, the pane's size and the conversions back to the model. Painters
 * are geometry — they draw from these and never touch the store.
 */
export interface PaintCtx {
  ctx: CanvasRenderingContext2D;
  drawing: Drawing;
  pts: Pt[];
  width: number;
  height: number;
  /** Price at a y coordinate, for tools that label levels. */
  priceAt: (y: number) => number | null;
  precision: number;
  /**
   * The bars currently loaded, for the two volume-profile tools.
   *
   * Every other painter here is pure geometry and deliberately stays that way
   * — a painter that reaches for market data is one that can disagree with the
   * series it is drawn over. The profiles are the exception because a volume
   * histogram IS the data; there is no geometric construction to use instead.
   */
  bars?: readonly {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  /** Screen x → time (ms). The inverse of projection, for bar counting. */
  timeAt?: (x: number) => number | null;
}
