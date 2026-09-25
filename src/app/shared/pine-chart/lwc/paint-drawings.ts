import type {
  BoxDrawing,
  DrawingSet,
  LabelDrawing,
  LineDrawing,
  PolylineDrawing,
} from '../render/render-model';
import {
  applyStroke,
  cssFont,
  curvePath,
  drawArrowHead,
  drawShape,
  drawTextBlock,
  measureBlock,
  roundRectPath,
  splitLines,
  wrapText,
  type Ctx,
  type TextBlock,
} from './canvas-kit';
import type { BarLookup } from './paint-markers';
import type { Projection } from './projection';

/**
 * label / line / box / polyline / linefill drawings, in Pine's stacking order (linefills under the
 * lines they join, boxes, polylines, lines, labels on top), plus the hit regions of labels that carry
 * a tooltip.
 */

export interface HitRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  tooltip: string;
}

export interface Point {
  x: number;
  y: number;
}

export function paintDrawings(
  ctx: Ctx,
  p: Projection,
  set: DrawingSet,
  bars: BarLookup | null,
  hits: HitRegion[],
): void {
  if (
    !set.linefills.length &&
    !set.boxes.length &&
    !set.polylines.length &&
    !set.lines.length &&
    !set.labels.length
  )
    return;
  ctx.save();
  for (const f of set.linefills) paintLinefill(ctx, p, f.line1, f.line2, f.color);
  for (const b of set.boxes) paintBox(ctx, p, b);
  for (const pl of set.polylines) paintPolyline(ctx, p, pl);
  for (const l of set.lines) paintLine(ctx, p, l);
  for (const l of set.labels) paintLabel(ctx, p, l, bars, hits);
  ctx.restore();
}

// ── lines ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The drawn segment of a line after `extend`: extend.right is the ray from point 1 through point 2,
 * extend.left the ray from point 2 through point 1, both the whole line. Rays are cut at a distance
 * that is always past the pane, so the canvas clips them.
 */
export function extendedSegment(
  a: Point,
  b: Point,
  extend: string,
  width: number,
  height: number,
): [Point, Point] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || extend === 'none') return [a, b];
  const ux = dx / len;
  const uy = dy / len;
  const reach = (from: Point) =>
    Math.hypot(
      Math.max(Math.abs(from.x), Math.abs(width - from.x)),
      Math.max(Math.abs(from.y), Math.abs(height - from.y)),
    ) + 10;
  let p1 = a;
  let p2 = b;
  if (extend === 'right' || extend === 'both') {
    const t = reach(b);
    p2 = { x: b.x + ux * t, y: b.y + uy * t };
  }
  if (extend === 'left' || extend === 'both') {
    const t = reach(a);
    p1 = { x: a.x - ux * t, y: a.y - uy * t };
  }
  return [p1, p2];
}

function lineEnds(
  p: Projection,
  l: LineDrawing,
): { a: Point; b: Point; seg: [Point, Point] } | null {
  const a = { x: p.x(l.x1), y: p.y(l.y1) };
  const b = { x: p.x(l.x2), y: p.y(l.y2) };
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  return { a, b, seg: extendedSegment(a, b, l.extend, p.width, p.height) };
}

export function paintLine(ctx: Ctx, p: Projection, l: LineDrawing): void {
  if (!l.color) return;
  const ends = lineEnds(p, l);
  if (!ends) return;
  const [s, e] = ends.seg;
  if (!segmentMayBeVisible(s, e, p)) return;
  const dashStyle = l.style === 'dotted' || l.style === 'dashed' ? l.style : 'solid';
  applyStroke(ctx, l.color, l.width, dashStyle);
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(e.x, e.y);
  ctx.stroke();
  if (l.style === 'arrow_right' || l.style === 'arrow_both')
    drawArrowHead(ctx, ends.a.x, ends.a.y, ends.b.x, ends.b.y, l.width, l.color);
  if (l.style === 'arrow_left' || l.style === 'arrow_both')
    drawArrowHead(ctx, ends.b.x, ends.b.y, ends.a.x, ends.a.y, l.width, l.color);
}

function segmentMayBeVisible(a: Point, b: Point, p: Projection): boolean {
  const margin = 50;
  if (Math.max(a.x, b.x) < -margin || Math.min(a.x, b.x) > p.width + margin) return false;
  if (Math.max(a.y, b.y) < -margin || Math.min(a.y, b.y) > p.height + margin) return false;
  return true;
}

/** linefill: the polygon between two lines' drawn segments (extensions included). */
export function paintLinefill(
  ctx: Ctx,
  p: Projection,
  l1: LineDrawing,
  l2: LineDrawing,
  color: string | null,
): void {
  if (!color) return;
  const e1 = lineEnds(p, l1);
  const e2 = lineEnds(p, l2);
  if (!e1 || !e2) return;
  const [a1, b1] = e1.seg[0].x <= e1.seg[1].x ? e1.seg : [e1.seg[1], e1.seg[0]];
  const [a2, b2] = e2.seg[0].x <= e2.seg[1].x ? e2.seg : [e2.seg[1], e2.seg[0]];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a1.x, a1.y);
  ctx.lineTo(b1.x, b1.y);
  ctx.lineTo(b2.x, b2.y);
  ctx.lineTo(a2.x, a2.y);
  ctx.closePath();
  ctx.fill();
}

// ── polylines ────────────────────────────────────────────────────────────────────────────────────

export function paintPolyline(ctx: Ctx, p: Projection, pl: PolylineDrawing): void {
  if (!pl.lineColor && !pl.fillColor) return;
  const n = pl.xs.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < n; i++) {
    xs[i] = p.x(pl.xs[i]);
    ys[i] = p.y(pl.ys[i]);
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) return;
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
  }
  if (maxX < -50 || minX > p.width + 50) return;
  const path = () => {
    ctx.beginPath();
    if (pl.curved) curvePath(ctx, xs, ys, pl.closed);
    else {
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]);
    }
    if (pl.closed) ctx.closePath();
  };
  if (pl.fillColor) {
    ctx.fillStyle = pl.fillColor;
    path();
    ctx.fill();
  }
  if (pl.lineColor) {
    const dash = pl.lineStyle === 'dotted' || pl.lineStyle === 'dashed' ? pl.lineStyle : 'solid';
    applyStroke(ctx, pl.lineColor, pl.lineWidth, dash);
    path();
    ctx.stroke();
    if (!pl.closed && n >= 2) {
      if (pl.lineStyle === 'arrow_right' || pl.lineStyle === 'arrow_both')
        drawArrowHead(ctx, xs[n - 2], ys[n - 2], xs[n - 1], ys[n - 1], pl.lineWidth, pl.lineColor);
      if (pl.lineStyle === 'arrow_left' || pl.lineStyle === 'arrow_both')
        drawArrowHead(ctx, xs[1], ys[1], xs[0], ys[0], pl.lineWidth, pl.lineColor);
    }
  }
}

// ── boxes ────────────────────────────────────────────────────────────────────────────────────────

const BOX_PAD = 3;

export function paintBox(ctx: Ctx, p: Projection, b: BoxDrawing): void {
  let xL = p.x(b.left);
  let xR = p.x(b.right);
  if (b.extend === 'left' || b.extend === 'both') xL = Math.min(xL, -2);
  if (b.extend === 'right' || b.extend === 'both') xR = Math.max(xR, p.width + 2);
  const yT = p.y(b.top);
  const yB = p.y(b.bottom);
  if (![xL, xR, yT, yB].every(Number.isFinite)) return;
  if (xR < -10 || xL > p.width + 10) return;
  const top = Math.min(yT, yB);
  const h = Math.abs(yB - yT);
  const w = xR - xL;
  if (b.bgColor) {
    ctx.fillStyle = b.bgColor;
    ctx.fillRect(xL, top, w, h);
  }
  if (b.borderColor && b.borderWidth > 0) {
    const dash = b.borderStyle === 'dotted' || b.borderStyle === 'dashed' ? b.borderStyle : 'solid';
    applyStroke(ctx, b.borderColor, b.borderWidth, dash);
    ctx.lineJoin = 'miter';
    const inset = b.borderWidth % 2 === 1 ? 0.5 : 0;
    ctx.strokeRect(Math.round(xL) + inset, Math.round(top) + inset, Math.round(w), Math.round(h));
  }
  if (b.text && b.textColor) paintBoxText(ctx, b, xL, top, w, h);
}

function paintBoxText(ctx: Ctx, b: BoxDrawing, x: number, y: number, w: number, h: number): void {
  const innerW = Math.max(0, w - 2 * BOX_PAD);
  const innerH = Math.max(0, h - 2 * BOX_PAD);
  let size = b.fontSize;
  let block: TextBlock;
  if (size > 0) {
    ctx.font = cssFont(size, b.fontFamily, b.bold, b.italic);
    block = measureBlock(ctx, b.wrap ? wrapText(ctx, b.text, innerW) : splitLines(b.text), size);
  } else {
    // size.auto: the largest text that fits the box.
    size = 40;
    for (;;) {
      ctx.font = cssFont(size, b.fontFamily, b.bold, b.italic);
      block = measureBlock(ctx, b.wrap ? wrapText(ctx, b.text, innerW) : splitLines(b.text), size);
      if ((block.width <= innerW && block.height <= innerH) || size <= 6) break;
      size = Math.max(6, Math.floor(size * 0.85));
    }
  }
  const clip = b.wrap;
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  drawTextBlock(
    ctx,
    block,
    x + BOX_PAD,
    y + BOX_PAD,
    innerW,
    innerH,
    b.hAlign,
    b.vAlign,
    b.textColor!,
  );
  if (clip) ctx.restore();
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────────

export type LabelShapeStyle =
  | 'xcross'
  | 'cross'
  | 'triangleup'
  | 'triangledown'
  | 'flag'
  | 'circle'
  | 'arrowup'
  | 'arrowdown'
  | 'square'
  | 'diamond';

const SHAPE_STYLES = new Set<string>([
  'xcross',
  'cross',
  'triangleup',
  'triangledown',
  'flag',
  'circle',
  'arrowup',
  'arrowdown',
  'square',
  'diamond',
]);

export interface LabelGeometry {
  /** Bubble / text box. */
  box: { x: number; y: number; w: number; h: number };
  /** Pointer triangle, or null. */
  pointer: [Point, Point, Point] | null;
  /** Shape styles: the shape's centre and size (the text sits beside it in `box`). */
  shape: { cx: number; cy: number; size: number } | null;
  /** Whether the style draws a filled bubble. */
  bubble: boolean;
}

/**
 * Where a label draws relative to its anchor for each label.style_*: bubbles point at the anchor
 * from the named side (label_down sits above it, label_up below, label_left to its right, …),
 * label_center/none/text_outline centre on it, and shape styles put the shape on the anchor with the
 * text beneath (above for the downward shapes).
 */
export function labelGeometry(
  style: string,
  ax: number,
  ay: number,
  textW: number,
  textH: number,
  fontSize: number,
): LabelGeometry {
  const padX = Math.max(4, fontSize * 0.5);
  const padY = Math.max(2, fontSize * 0.3);
  const w = textW > 0 ? textW + 2 * padX : 0;
  const h = textH > 0 ? textH + 2 * padY : 0;
  const bw = Math.max(w, fontSize * 1.2);
  const bh = Math.max(h, fontSize * 1.2);
  const ptr = Math.max(4, fontSize * 0.5);
  const tri = (a: Point, b: Point, c: Point): [Point, Point, Point] => [a, b, c];
  switch (style) {
    case 'label_up': {
      const y = ay + ptr;
      return {
        box: { x: ax - bw / 2, y, w: bw, h: bh },
        pointer: tri({ x: ax - ptr, y: y + 0.5 }, { x: ax, y: ay }, { x: ax + ptr, y: y + 0.5 }),
        shape: null,
        bubble: true,
      };
    }
    case 'label_left': {
      const x = ax + ptr;
      return {
        box: { x, y: ay - bh / 2, w: bw, h: bh },
        pointer: tri({ x: x + 0.5, y: ay - ptr }, { x: ax, y: ay }, { x: x + 0.5, y: ay + ptr }),
        shape: null,
        bubble: true,
      };
    }
    case 'label_right': {
      const x = ax - ptr - bw;
      return {
        box: { x, y: ay - bh / 2, w: bw, h: bh },
        pointer: tri(
          { x: x + bw - 0.5, y: ay - ptr },
          { x: ax, y: ay },
          { x: x + bw - 0.5, y: ay + ptr },
        ),
        shape: null,
        bubble: true,
      };
    }
    case 'label_lower_left': {
      const x = ax + ptr * 0.6;
      const y = ay - ptr * 0.6 - bh;
      return {
        box: { x, y, w: bw, h: bh },
        pointer: tri({ x, y: y + bh - ptr }, { x: ax, y: ay }, { x: x + ptr, y: y + bh }),
        shape: null,
        bubble: true,
      };
    }
    case 'label_lower_right': {
      const x = ax - ptr * 0.6 - bw;
      const y = ay - ptr * 0.6 - bh;
      return {
        box: { x, y, w: bw, h: bh },
        pointer: tri(
          { x: x + bw, y: y + bh - ptr },
          { x: ax, y: ay },
          { x: x + bw - ptr, y: y + bh },
        ),
        shape: null,
        bubble: true,
      };
    }
    case 'label_upper_left': {
      const x = ax + ptr * 0.6;
      const y = ay + ptr * 0.6;
      return {
        box: { x, y, w: bw, h: bh },
        pointer: tri({ x, y: y + ptr }, { x: ax, y: ay }, { x: x + ptr, y }),
        shape: null,
        bubble: true,
      };
    }
    case 'label_upper_right': {
      const x = ax - ptr * 0.6 - bw;
      const y = ay + ptr * 0.6;
      return {
        box: { x, y, w: bw, h: bh },
        pointer: tri({ x: x + bw, y: y + ptr }, { x: ax, y: ay }, { x: x + bw - ptr, y }),
        shape: null,
        bubble: true,
      };
    }
    case 'label_center':
      return {
        box: { x: ax - bw / 2, y: ay - bh / 2, w: bw, h: bh },
        pointer: null,
        shape: null,
        bubble: true,
      };
    case 'none':
    case 'text_outline':
      return {
        box: { x: ax - w / 2, y: ay - h / 2, w, h },
        pointer: null,
        shape: null,
        bubble: false,
      };
    default: {
      if (SHAPE_STYLES.has(style)) {
        const size = Math.max(8, Math.round(fontSize * 1.3));
        const textAbove = style === 'triangledown' || style === 'arrowdown';
        const ty = textAbove ? ay - size / 2 - 2 - h : ay + size / 2 + 2;
        return {
          box: { x: ax - w / 2, y: ty, w, h },
          pointer: null,
          shape: { cx: ax, cy: ay, size },
          bubble: false,
        };
      }
      // label_down (default): bubble above the anchor, pointer down to it.
      const y = ay - ptr - bh;
      return {
        box: { x: ax - bw / 2, y, w: bw, h: bh },
        pointer: tri(
          { x: ax - ptr, y: y + bh - 0.5 },
          { x: ax, y: ay },
          { x: ax + ptr, y: y + bh - 0.5 },
        ),
        shape: null,
        bubble: true,
      };
    }
  }
}

/** Anchor y of a label: its price, or the bar's high/low (pane edge in a separate pane) for yloc above/below. */
function labelAnchorY(p: Projection, l: LabelDrawing, bars: BarLookup | null): number {
  if (l.yloc === 'price') return l.y === null ? NaN : p.y(l.y);
  const logical = Math.round(l.x);
  if (!bars) return l.yloc === 'abovebar' ? 16 : p.height - 16;
  if (l.yloc === 'abovebar') {
    const hi = bars.high(logical);
    return hi === hi ? p.y(hi) - 3 : NaN;
  }
  const lo = bars.low(logical);
  return lo === lo ? p.y(lo) + 3 : NaN;
}

export function paintLabel(
  ctx: Ctx,
  p: Projection,
  l: LabelDrawing,
  bars: BarLookup | null,
  hits: HitRegion[],
): void {
  const ax = p.x(l.x);
  if (!Number.isFinite(ax) || ax < -400 || ax > p.width + 400) return;
  const ay = labelAnchorY(p, l, bars);
  if (!Number.isFinite(ay)) return;
  // yloc above/below re-anchors the shape styles so the bubble or shape clears the bar.
  let style = l.style;
  if (l.yloc === 'belowbar' && style === 'label_down') style = 'label_up';
  ctx.font = cssFont(l.fontSize, l.fontFamily, l.bold, l.italic);
  const lines = splitLines(l.text);
  const block = measureBlock(ctx, lines, l.fontSize);
  const g = labelGeometry(style, ax, ay, block.width, block.height, l.fontSize);

  if (g.bubble && l.color) {
    ctx.fillStyle = l.color;
    ctx.beginPath();
    roundRectPath(ctx, g.box.x, g.box.y, g.box.w, g.box.h, Math.min(3, l.fontSize / 4));
    ctx.fill();
    if (g.pointer) {
      ctx.beginPath();
      ctx.moveTo(g.pointer[0].x, g.pointer[0].y);
      ctx.lineTo(g.pointer[1].x, g.pointer[1].y);
      ctx.lineTo(g.pointer[2].x, g.pointer[2].y);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (g.shape && l.color) drawShape(ctx, style, g.shape.cx, g.shape.cy, g.shape.size, l.color);

  if (lines.length && l.textColor) {
    ctx.font = cssFont(l.fontSize, l.fontFamily, l.bold, l.italic);
    const padX = g.bubble ? Math.max(4, l.fontSize * 0.5) : 0;
    const outline =
      style === 'text_outline' && l.color
        ? { color: l.color, width: Math.max(2, l.fontSize / 5) }
        : null;
    drawTextBlock(
      ctx,
      block,
      g.box.x + padX,
      g.box.y,
      Math.max(block.width, g.box.w - 2 * padX),
      g.box.h,
      l.textAlign,
      'center',
      l.textColor,
      outline,
    );
  }

  if (l.tooltip) {
    const r = g.shape
      ? {
          x: g.shape.cx - g.shape.size / 2,
          y: g.shape.cy - g.shape.size / 2,
          w: g.shape.size,
          h: g.shape.size,
        }
      : g.box;
    const pad = 2;
    hits.push({
      x: Math.min(r.x, g.box.x) - pad,
      y: Math.min(r.y, g.box.y) - pad,
      w: Math.max(r.w, g.box.w, 8) + 2 * pad,
      h: Math.max(r.h + (g.shape ? g.box.h : 0), 8) + 2 * pad,
      tooltip: l.tooltip,
    });
  }
}
