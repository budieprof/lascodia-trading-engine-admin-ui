import type { PaintCtx } from '../paint-ctx';
import type { Pt } from '../geometry';
import { barIndexAt, medianInterval, resolutionMs } from './forecast-math';

/**
 * Canvas plumbing shared by the forecasting/measurement tools: a time → x map
 * (PaintCtx only offers x → time), price → y, and TradingView's label boxes.
 */

export const TV_GREEN = '#089981';
export const TV_RED = '#F23645';
export const TV_BLUE = '#2962FF';
export const TV_GREY = '#787B86';
export const FONT = '12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

export function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function intervalOf(p: PaintCtx): number {
  return resolutionMs(p.drawing.resolution) ?? medianInterval(p.bars ?? []) ?? 3_600_000;
}

export interface Axis {
  /** Bar interval (ms). */
  interval: number;
  /** Pixels per bar. */
  spacing: number;
  xOf(time: number): number;
  yOf(price: number): number | null;
}

/**
 * Build the time/price axis for a drawing.
 *
 * The x map is anchored on the first projected anchor and walks bar indices at
 * the chart's bar spacing, so times past the last bar (where the library's
 * `timeToCoordinate` gives up) still land where TradingView would draw them.
 * Spacing comes from two anchors on different bars when possible, otherwise
 * from probing `timeAt` for the bar's half-width.
 */
export function axisOf(p: PaintCtx): Axis | null {
  const { drawing, pts } = p;
  const bars = p.bars ?? [];
  const interval = intervalOf(p);
  if (pts.length === 0 || drawing.points.length === 0) return null;
  // Projected anchors only line up with model anchors when none were dropped.
  const aligned = pts.length >= drawing.points.length;
  const refX = pts[0].x;
  const refT = aligned ? drawing.points[0].time : (p.timeAt?.(refX) ?? drawing.points[0].time);
  const refI = barIndexAt(bars, refT, interval);

  let spacing = 0;
  if (aligned) {
    for (let i = 1; i < drawing.points.length && i < pts.length; i++) {
      const di = barIndexAt(bars, drawing.points[i].time, interval) - refI;
      if (Math.abs(di) >= 1) {
        spacing = (pts[i].x - refX) / di;
        break;
      }
    }
  }
  if (!(spacing > 0) && p.timeAt) {
    const t0 = p.timeAt(refX);
    if (t0 !== null) {
      // Smallest offset whose bar differs = half a bar.
      let lo = 0;
      let hi = 400;
      const differs = (d: number) => p.timeAt!(refX + d) !== t0 && p.timeAt!(refX - d) !== t0;
      if (differs(hi)) {
        for (let k = 0; k < 20; k++) {
          const mid = (lo + hi) / 2;
          if (p.timeAt(refX + mid) !== t0 || p.timeAt(refX - mid) !== t0) hi = mid;
          else lo = mid;
        }
        spacing = hi * 2;
      }
    }
  }
  if (!(spacing > 0)) spacing = 6;

  return {
    interval,
    spacing,
    xOf: (t) => refX + (barIndexAt(bars, t, interval) - refI) * spacing,
    yOf: (price) => yForPrice(p, price),
  };
}

/** Price → y by bisecting `priceAt` (exact under log scales too). */
export function yForPrice(p: PaintCtx, price: number): number | null {
  let top = -p.height * 4;
  let bottom = p.height * 5;
  const pTop = p.priceAt(top);
  const pBottom = p.priceAt(bottom);
  if (pTop === null || pBottom === null || pTop === pBottom) return null;
  const decreasing = pTop > pBottom;
  for (let i = 0; i < 40 && bottom - top > 0.05; i++) {
    const mid = (top + bottom) / 2;
    const pm = p.priceAt(mid);
    if (pm === null) return null;
    if (pm > price === decreasing) top = mid;
    else bottom = mid;
  }
  return (top + bottom) / 2;
}

export function strokeLine(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** A line with a filled TradingView-style arrow head at `b`. */
export function arrow(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, width = 1): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  strokeLine(ctx, a, b);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = 4 + width * 2;
  ctx.beginPath();
  ctx.moveTo(b.x - s * Math.cos(ang - Math.PI / 5), b.y - s * Math.sin(ang - Math.PI / 5));
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x - s * Math.cos(ang + Math.PI / 5), b.y - s * Math.sin(ang + Math.PI / 5));
  ctx.stroke();
  ctx.restore();
}

export interface LabelOpts {
  bg: string;
  fg?: string;
  /** Which point of the box `at` names. */
  align?: 'center' | 'above' | 'below';
  font?: string;
  border?: string;
}

/** Rounded multi-line label box; returns its rectangle. */
export function labelBox(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  at: Pt,
  o: LabelOpts,
): { x: number; y: number; w: number; h: number } {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = o.font ?? FONT;
  const lh = 16;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
  const h = lines.length * lh + 8;
  const x = at.x - w / 2;
  const y = o.align === 'above' ? at.y - h : o.align === 'below' ? at.y : at.y - h / 2;
  ctx.fillStyle = o.bg;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 4);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  if (o.border) {
    ctx.strokeStyle = o.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = o.fg ?? '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, at.x, y + 4 + lh * i + lh / 2));
  ctx.restore();
  return { x, y, w, h };
}

/** Axis-aligned point-in-rect with tolerance. */
export function inRect(at: Pt, x0: number, y0: number, x1: number, y1: number, tol = 0): boolean {
  return (
    at.x >= Math.min(x0, x1) - tol &&
    at.x <= Math.max(x0, x1) + tol &&
    at.y >= Math.min(y0, y1) - tol &&
    at.y <= Math.max(y0, y1) + tol
  );
}
