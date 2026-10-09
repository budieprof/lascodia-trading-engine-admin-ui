import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesPrimitive, Time } from 'lightweight-charts';
import { eventCountdown, passesImpact, type EventImpact, type EventMark } from './chart-events';

export type { EventImpact, EventMark } from './chart-events';

/**
 * Economic events on the time axis — TradingView's "timescale marks".
 *
 * These matter more here than on a generic chart: positions held across Tier-1
 * prints are already known to be where a large share of this system's losses
 * come from, so seeing where those prints land relative to a setup is the
 * point of the feature, not decoration.
 *
 * Drawn as a vertical line plus a flag at the bottom rather than a bar marker,
 * because an event belongs to an INSTANT on the axis, not to a candle: a 13:30
 * print has no H4 bar of its own. Until 2026-10 the line was placed with
 * `timeToCoordinate`, which answers only for a bar's own open — so 12:30 and
 * 13:30 UTC releases never showed on 1h, most never on 4h and 1D, and upcoming
 * events (no bar yet) never at all (CC-07). The host now hands an `xAt` that
 * interpolates between bars and projects past the last one (CC-I2).
 *
 * <ul>
 *   <li>Upcoming events inside the right margin are drawn where they will
 *       land; the next one beyond the right edge is a chip at the edge with a
 *       countdown.</li>
 *   <li>Optional shading over the news blackout around Tier-1 events: the
 *       window live refuses new entries in (`bands`).</li>
 *   <li>Flags are hit-testable ({@link hit}) for the host's hover card and
 *       click → the event's reading.</li>
 * </ul>
 */

const IMPACT_COLOR: Record<EventImpact, string> = {
  High: '#EF5350',
  Medium: '#FFA726',
  Low: '#787B86',
};

/** The flag strip at the bottom of the pane, where marks are hovered and clicked. */
const FLAG_STRIP = 26;

/** Where a mark was drawn on the last frame (media px). */
export interface PlacedMark {
  mark: EventMark;
  x: number;
}

export class EventMarksRenderer implements ISeriesPrimitive<Time> {
  private marks: EventMark[] = [];
  private bands: { from: number; to: number }[] = [];
  private minImpact: EventImpact = 'Medium';
  private requestUpdate?: () => void;
  private placedMarks: PlacedMark[] = [];
  private nextChip: { mark: EventMark; x: number; y: number; w: number; h: number } | null = null;
  private paneHeight = 0;

  constructor(
    /** UTC ms → x on the pane (media px), between bars and past the last one; null with no bars. */
    private readonly xAt: (utcMs: number) => number | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setMarks(marks: readonly EventMark[], minImpact: EventImpact = 'Medium'): void {
    this.marks = [...marks].sort((a, b) => a.time - b.time);
    this.minImpact = minImpact;
    this.requestUpdate?.();
  }

  /** Spans to shade (UTC ms): the news blackout around Tier-1 events. Empty: no shading. */
  setBands(bands: readonly { from: number; to: number }[]): void {
    this.bands = [...bands];
    this.requestUpdate?.();
  }

  /** Repaint (the view moved, or the clock: the next event's countdown). */
  redraw(): void {
    this.requestUpdate?.();
  }

  /** The marks drawn on the last frame, left to right. */
  placed(): readonly PlacedMark[] {
    return this.placedMarks;
  }

  /**
   * The event under (x, y) — pane media px: a flag in the strip along the bottom of the pane, or
   * the "next event" chip at the right edge. Null elsewhere: hovering a candle near an event's line
   * is reading the candle.
   */
  hit(x: number, y: number): EventMark | null {
    const chip = this.nextChip;
    if (chip && x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h)
      return chip.mark;
    if (this.paneHeight <= 0 || y < this.paneHeight - FLAG_STRIP) return null;
    let best: PlacedMark | null = null;
    for (const p of this.placedMarks) {
      const d = Math.abs(p.x - x);
      if (d <= 6 && (!best || d < Math.abs(best.x - x))) best = p;
    }
    return best?.mark ?? null;
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

  private draw(target: CanvasRenderingTarget2D): void {
    this.placedMarks = [];
    this.nextChip = null;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const w = mediaSize.width;
      const h = mediaSize.height;
      this.paneHeight = h;
      ctx.save();

      // The blackout first, under the lines: the time live refuses new entries around Tier-1 prints.
      ctx.fillStyle = 'rgba(242,54,69,0.07)';
      for (const band of this.bands) {
        const a = this.xAt(band.from);
        const b = this.xAt(band.to);
        if (a === null || b === null) continue;
        const left = Math.max(0, Math.min(a, b));
        const right = Math.min(w, Math.max(a, b));
        if (right > left) ctx.fillRect(left, 0, right - left, h);
      }

      ctx.font = '10px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      const now = this.now();
      let next: EventMark | null = null;
      let lastLabelX = -Infinity;
      for (const mark of this.marks) {
        if (!passesImpact(mark.impact, this.minImpact)) continue;
        const x = this.xAt(mark.time);
        if (x === null || x < -2) continue;
        if (x > w + 2) {
          // Past the right edge: the first upcoming one becomes the edge chip.
          if (!next && mark.time > now) next = mark;
          continue;
        }

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
        // An upcoming event's flag is hollow: it has not printed yet.
        if (mark.time > now) {
          ctx.strokeRect(x - 1.5, h - 16, 3, 12);
        } else {
          ctx.fillRect(x - 1, h - 16, 2, 12);
        }
        this.placedMarks.push({ mark, x });

        // Labels are suppressed when they would collide: a busy calendar day
        // otherwise renders a solid strip of overlapping currency codes.
        if (x - lastLabelX > 44) {
          ctx.fillText(mark.currency, x + 3, h - 4);
          lastLabelX = x;
        }
      }

      if (next) this.drawNextChip(ctx, next, w, h, now);
      ctx.restore();
    });
  }

  /** The next upcoming event beyond the right edge: "USD Non-Farm Payrolls · in 2d 4h ▸". */
  private drawNextChip(
    ctx: CanvasRenderingContext2D,
    mark: EventMark,
    w: number,
    h: number,
    now: number,
  ): void {
    const title = mark.title.length > 26 ? `${mark.title.slice(0, 25)}…` : mark.title;
    const text = `${mark.currency} ${title} · ${eventCountdown(now, mark.time) ?? ''} ▸`;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 12;
    const chip = { mark, x: Math.max(0, w - tw - 4), y: h - FLAG_STRIP + 4, w: tw, h: 16 };
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = IMPACT_COLOR[mark.impact];
    ctx.fillRect(chip.x, chip.y, chip.w, chip.h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, chip.x + 6, chip.y + chip.h / 2 + 0.5);
    this.nextChip = chip;
  }
}
