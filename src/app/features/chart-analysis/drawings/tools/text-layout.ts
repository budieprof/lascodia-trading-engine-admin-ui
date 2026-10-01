import type { Pt } from '../geometry';
import type { DrawingStyle } from '../model';
import type { ToolOption } from './types';

/**
 * Shared text layout for the "Text and annotation tools" family.
 *
 * Every tool in the family is "a box of wrapped text, maybe with a tail", so the
 * measuring, wrapping and box geometry live here once. Painting and hit-testing
 * both call `layoutText`, which is what keeps the clickable area identical to
 * what is on screen.
 */

/** TradingView's chart UI font stack. */
export const TV_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
export const TV_BLUE = '#2962FF';
export const DEFAULT_TEXT = 'Text';

export type Measure = (text: string) => number;
export type TextAlign = 'left' | 'center' | 'right';

export function fontOf(style: Pick<DrawingStyle, 'fontSize' | 'bold' | 'italic'>): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${TV_FONT_FAMILY}`;
}

let scratch: CanvasRenderingContext2D | null | undefined;

/**
 * A text measurer for `font`. Hit-testing is called with a null canvas context
 * (the controller has no canvas), so this falls back to a scratch canvas, and
 * finally to a width estimate when no canvas exists at all (tests, SSR).
 */
export function measurerFor(ctx: CanvasRenderingContext2D | null | undefined, font: string, fontSize: number): Measure {
  let c = ctx ?? null;
  if (!c) {
    if (scratch === undefined) {
      try {
        scratch = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
      } catch {
        scratch = null;
      }
    }
    c = scratch ?? null;
  }
  if (!c || typeof c.measureText !== 'function') return (t) => t.length * fontSize * 0.6;
  const target = c;
  return (t) => {
    const prev = target.font;
    target.font = font;
    const w = target.measureText(t).width;
    target.font = prev;
    return w;
  };
}

/**
 * Split on explicit newlines, then (when `maxWidth` is set) word-wrap each
 * paragraph. A single word wider than the box is broken by characters, which is
 * what TradingView does with a long URL in a wrapped text.
 */
export function wrapText(measure: Measure, text: string, maxWidth: number | null): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!maxWidth || maxWidth <= 0 || measure(para) <= maxWidth) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      // Break an over-long word by characters.
      let chunk = '';
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

export interface TextLayout {
  lines: string[];
  lineWidths: number[];
  /** Box size including padding. */
  width: number;
  height: number;
  lineHeight: number;
  padX: number;
  padY: number;
  font: string;
}

export interface LayoutOpts {
  padX?: number;
  padY?: number;
  /** Fixed content width when word wrap is on; the box is then exactly this wide. */
  wrapWidth?: number | null;
  minWidth?: number;
}

export function layoutText(measure: Measure, text: string, fontSize: number, font: string, o: LayoutOpts = {}): TextLayout {
  const padX = o.padX ?? 0;
  const padY = o.padY ?? 0;
  const lines = wrapText(measure, text, o.wrapWidth ?? null);
  const lineWidths = lines.map(measure);
  const lineHeight = Math.round(fontSize * 1.25);
  const content = o.wrapWidth ? o.wrapWidth : Math.max(0, ...lineWidths);
  return {
    lines,
    lineWidths,
    width: Math.max(o.minWidth ?? 0, content + padX * 2),
    height: lines.length * lineHeight + padY * 2,
    lineHeight,
    padX,
    padY,
    font,
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inRect(p: Pt, r: Rect, tol = 0): boolean {
  return p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
}

/** Paint the lines of `l` into box `r`, honouring alignment. */
export function fillLines(ctx: CanvasRenderingContext2D, l: TextLayout, r: Rect, color: string, align: TextAlign): void {
  ctx.font = l.font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const inner = r.w - l.padX * 2;
  l.lines.forEach((line, i) => {
    const lw = l.lineWidths[i];
    const dx = align === 'center' ? (inner - lw) / 2 : align === 'right' ? inner - lw : 0;
    ctx.fillText(line, r.x + l.padX + dx, r.y + l.padY + l.lineHeight * (i + 0.5));
  });
}

/** Rounded rectangle path (no fill/stroke). */
export function roundRectPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

/**
 * Rounded box with a speech-bubble tail ending at `tip`. The tail leaves from
 * the box edge nearest the tip, with a base `base` px wide, so it reads as one
 * outline when stroked (callout / comment / balloon).
 */
export function bubblePath(ctx: CanvasRenderingContext2D, r: Rect, radius: number, tip: Pt, base = 12): void {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (inRect(tip, r)) {
    roundRectPath(ctx, r, radius);
    return;
  }
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  // Pick the side: compare normalised offsets so a wide box prefers top/bottom.
  const dx = (tip.x - cx) / (r.w / 2);
  const dy = (tip.y - cy) / (r.h / 2);
  const side: 'top' | 'bottom' | 'left' | 'right' =
    Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const half = base / 2;
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  if (side === 'top') {
    const m = clamp(tip.x, r.x + rad + half, r.x + r.w - rad - half);
    ctx.lineTo(m - half, r.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(m + half, r.y);
  }
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  if (side === 'right') {
    const m = clamp(tip.y, r.y + rad + half, r.y + r.h - rad - half);
    ctx.lineTo(r.x + r.w, m - half);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(r.x + r.w, m + half);
  }
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  if (side === 'bottom') {
    const m = clamp(tip.x, r.x + rad + half, r.x + r.w - rad - half);
    ctx.lineTo(m + half, r.y + r.h);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(m - half, r.y + r.h);
  }
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  if (side === 'left') {
    const m = clamp(tip.y, r.y + rad + half, r.y + r.h - rad - half);
    ctx.lineTo(r.x, m + half);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(r.x, m - half);
  }
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

/** Distance from p to segment ab (for tail/pole hit tests). */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ── Options shared by the family (TradingView's Text tab) ──────────────────

export const opt = {
  align: (d: TextAlign = 'left'): ToolOption => ({
    key: 'align',
    label: 'Text alignment',
    type: 'select',
    default: d,
    choices: ['left', 'center', 'right'],
    tab: 'text',
  }),
  background: (on: boolean): ToolOption => ({ key: 'background', label: 'Background', type: 'bool', default: on, tab: 'text' }),
  backgroundColor: (c: string): ToolOption => ({
    key: 'backgroundColor',
    label: 'Background color',
    type: 'color',
    default: c,
    tab: 'text',
  }),
  border: (on: boolean): ToolOption => ({ key: 'border', label: 'Border', type: 'bool', default: on, tab: 'text' }),
  borderColor: (c: string): ToolOption => ({ key: 'borderColor', label: 'Border color', type: 'color', default: c, tab: 'text' }),
  wordWrap: (on = false): ToolOption => ({ key: 'wordWrap', label: 'Text wrap', type: 'bool', default: on, tab: 'text' }),
  wordWrapWidth: (w = 200): ToolOption => ({
    key: 'wordWrapWidth',
    label: 'Wrap width',
    type: 'number',
    default: w,
    min: 20,
    max: 1000,
    step: 10,
    tab: 'text',
  }),
};

export const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
export const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
export function alignOf(v: unknown): TextAlign {
  return v === 'center' || v === 'right' ? v : 'left';
}
export function wrapWidthOf(o: Record<string, unknown>): number | null {
  return bool(o['wordWrap'], false) ? num(o['wordWrapWidth'], 200) : null;
}
