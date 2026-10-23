import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesPrimitive, Time } from 'lightweight-charts';

import { OF_FONT, drawCaptions } from './canvas-text';

/** The economic-event flag strip at the bottom of the price pane: captions sit above it. */
const FLAG_STRIP = 30;

/**
 * What each order-flow layer is built from, and where its data stops, as text on the chart (data honesty): "Broker DOM
 * depth — <instance>, sampled every 5 min", "Depth history starts …", "Zoom in to see the footprint". On the price pane
 * the lines stack up from above the event flags; in an order-flow pane the first line is the pane's title, top left.
 */
export class CaptionPrimitive implements ISeriesPrimitive<Time> {
  private lines: readonly string[] = [];
  private requestUpdate?: () => void;

  constructor(
    private readonly place: 'price' | 'pane',
    private readonly dark: () => boolean,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setLines(lines: readonly string[]): void {
    if (lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i])) return;
    this.lines = [...lines];
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* drawn per frame */
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
    if (this.lines.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (this.place === 'price') {
        drawCaptions(ctx, this.lines, mediaSize.height - FLAG_STRIP, this.dark());
        return;
      }
      // A pane: its title in the top-left corner, notes after it on the same line when they fit, else below.
      ctx.save();
      ctx.font = OF_FONT;
      ctx.textBaseline = 'top';
      const [title, ...notes] = this.lines;
      ctx.fillStyle = this.dark() ? '#d1d4dc' : '#131722';
      ctx.fillText(title, 8, 6);
      ctx.fillStyle = '#787b86';
      let x = 8 + ctx.measureText(title).width + 12;
      let y = 6;
      for (const n of notes) {
        const w = ctx.measureText(n).width;
        if (x + w > mediaSize.width - 70) {
          x = 8;
          y += 15;
        }
        ctx.fillText(n, x, y);
        x += w + 12;
      }
      ctx.restore();
    });
  }
}
