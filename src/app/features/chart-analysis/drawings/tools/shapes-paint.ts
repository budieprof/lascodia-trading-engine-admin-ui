import type { Pt } from '../geometry';
import type { Drawing } from '../model';
import type { ToolOption } from './types';

/** Canvas helpers shared by the Geometric-shapes tools. */

export type Opts = Record<string, unknown>;

/** TradingView's "Background" checkbox: fill only when enabled AND a colour exists. */
export function fillOf(d: Drawing, o: Opts): string | null {
  return o['fillBackground'] === false ? null : d.style.fill;
}

export function tracePath(ctx: CanvasRenderingContext2D, pts: Pt[], closed: boolean): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

export function fillAndStroke(ctx: CanvasRenderingContext2D, fill: string | null): void {
  if (fill) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }
  ctx.stroke();
}

/** TradingView line-end arrow: an open chevron at `tip`, pointing away from `from`. */
export function lineEndArrow(ctx: CanvasRenderingContext2D, from: Pt, tip: Pt, width: number): void {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  if (!Number.isFinite(ang) || (from.x === tip.x && from.y === tip.y)) return;
  const size = Math.max(8, width * 4);
  const spread = Math.PI / 6;
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tip.x - size * Math.cos(ang - spread), tip.y - size * Math.sin(ang - spread));
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(ang + spread), tip.y - size * Math.sin(ang + spread));
  ctx.stroke();
  ctx.restore();
}

/** Arrow ends for an open stroke, per the leftEnd / rightEnd options ('Normal' | 'Arrow'). */
export function strokeEnds(ctx: CanvasRenderingContext2D, pts: Pt[], d: Drawing, o: Opts): void {
  if (pts.length < 2) return;
  const back = (from: number, step: number): Pt => {
    // Use a point a few px away so the head follows the stroke's final direction.
    const tip = pts[from];
    for (let i = from + step; i >= 0 && i < pts.length; i += step) {
      if (Math.hypot(pts[i].x - tip.x, pts[i].y - tip.y) >= 4) return pts[i];
    }
    return pts[from + step];
  };
  if (o['leftEnd'] === 'Arrow') lineEndArrow(ctx, back(0, 1), pts[0], d.style.width);
  if (o['rightEnd'] === 'Arrow') lineEndArrow(ctx, back(pts.length - 1, -1), pts[pts.length - 1], d.style.width);
}

export function fontOf(d: Drawing, size = d.style.fontSize): string {
  return `${d.style.italic ? 'italic ' : ''}${d.style.bold ? 'bold ' : ''}${size}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
}

/** Text placed inside a box per TradingView's horizontal/vertical label alignment. */
export function boxText(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  box: { x: number; y: number; w: number; h: number },
  horz: string,
  vert: string,
): void {
  const text = d.style.text;
  if (!text) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = fontOf(d);
  ctx.fillStyle = d.style.textColor ?? d.style.color;
  const pad = 4;
  ctx.textAlign = horz === 'left' ? 'left' : horz === 'right' ? 'right' : 'center';
  const x = horz === 'left' ? box.x + pad : horz === 'right' ? box.x + box.w - pad : box.x + box.w / 2;
  const lines = text.split('\n');
  const lh = d.style.fontSize * 1.25;
  const total = lh * lines.length;
  const top =
    vert === 'top' ? box.y + pad : vert === 'bottom' ? box.y + box.h - pad - total : box.y + box.h / 2 - total / 2;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, top + i * lh));
  ctx.restore();
}

// ── Shared Style-tab option sets ───────────────────────────────────────────

export const END_CHOICES = ['Normal', 'Arrow'] as const;

export const fillOption = (on = true): ToolOption => ({ key: 'fillBackground', label: 'Background', type: 'bool', default: on });
export const FILL_OPTION: ToolOption = fillOption(true);

export const ENDS_OPTIONS = (left: 'Normal' | 'Arrow', right: 'Normal' | 'Arrow'): ToolOption[] => [
  { key: 'leftEnd', label: 'Left end', type: 'select', default: left, choices: END_CHOICES },
  { key: 'rightEnd', label: 'Right end', type: 'select', default: right, choices: END_CHOICES },
];

export const EXTEND_OPTIONS: ToolOption[] = [
  { key: 'extendLeft', label: 'Extend left', type: 'bool', default: false },
  { key: 'extendRight', label: 'Extend right', type: 'bool', default: false },
];

export const TEXT_ALIGN_OPTIONS: ToolOption[] = [
  { key: 'horzLabelsAlign', label: 'Text alignment', type: 'select', default: 'center', choices: ['left', 'center', 'right'], tab: 'text' },
  { key: 'vertLabelsAlign', label: 'Text position', type: 'select', default: 'middle', choices: ['top', 'middle', 'bottom'], tab: 'text' },
];
