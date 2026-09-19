import { ELLIOTT_LABELS, FIB_LEVELS, FIB_RADII, GANN_RATIOS, type Drawing } from './model';
import { rectOf, type Pt } from './geometry';

/**
 * Painters for the analytical tool families — pitchforks, Gann, the extended
 * Fibonacci set, Elliott wave and harmonic patterns.
 *
 * Split out of `DrawingRenderer` because these are geometry, not plumbing: the
 * renderer handles canvas state, projection and selection, and delegates the
 * actual shape of a pitchfork to here. Each painter takes ALREADY-PROJECTED
 * screen points and draws; none of them touches the model.
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
}

function line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** Extend a→b far past the canvas so the line appears infinite. */
function extend(a: Pt, b: Pt, w: number, h: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return b;
  const scale = (Math.abs(w) + Math.abs(h)) * 2;
  return { x: a.x + (dx / len) * scale, y: a.y + (dy / len) * scale };
}

function label(ctx: CanvasRenderingContext2D, text: string, at: Pt, color: string): void {
  if (!text) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(text).width + 8;
  ctx.fillStyle = color;
  ctx.fillRect(at.x - tw / 2, at.y - 8, tw, 16);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, at.x, at.y);
  ctx.restore();
}

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Pitchforks.
 *
 * All four variants share the same construction — a median line from a handle
 * through the midpoint of the other two pivots, with parallel rails — and
 * differ ONLY in where the handle sits:
 *
 *   Andrews          handle = P0
 *   Schiff           handle = midpoint of P0 and P1
 *   Modified Schiff  handle = midpoint of P0 and P1 on the time axis, at P0's
 *                    price — i.e. shifted in time but not in price
 *   Inside           handle = midpoint of P1 and P2
 *
 * Writing them as one painter keeps that relationship visible instead of
 * hiding it in four near-identical copies that can drift apart.
 */
export function paintPitchfork(p: PaintCtx, variant: string): void {
  const { ctx, pts, width, height, drawing } = p;
  if (pts.length < 3) {
    if (pts.length >= 2) line(ctx, pts[0], pts[1]);
    return;
  }
  const [p0, p1, p2] = pts;

  let handle: Pt;
  switch (variant) {
    case 'schiff-pitchfork':
      handle = midpoint(p0, p1);
      break;
    case 'modified-schiff-pitchfork':
      handle = { x: (p0.x + p1.x) / 2, y: p0.y };
      break;
    case 'inside-pitchfork':
      handle = midpoint(p1, p2);
      break;
    default:
      handle = p0;
  }

  const mid = midpoint(p1, p2);
  const far = extend(handle, mid, width, height);

  // The median line, then a rail through each pivot parallel to it.
  ctx.save();
  line(ctx, handle, far);
  const dx = far.x - handle.x;
  const dy = far.y - handle.y;
  for (const pivot of [p1, p2]) {
    line(ctx, pivot, { x: pivot.x + dx, y: pivot.y + dy });
  }

  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p1.x + dx, p1.y + dy);
    ctx.lineTo(p2.x + dx, p2.y + dy);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fill();
  }

  // The tines that make it a pitchfork rather than a channel.
  ctx.setLineDash([4, 3]);
  line(ctx, p1, p2);
  ctx.restore();
}

/**
 * Gann fan — rays at fixed rise:run ratios from the anchor.
 *
 * The ratios are price-per-bar, so they are computed from the box the two
 * points define rather than from screen angles: a "1×1" line must stay 1 unit
 * of price per unit of time under zoom, not 45° on screen.
 */
export function paintGannFan(p: PaintCtx): void {
  const { ctx, pts, width, height, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0) return;

  ctx.save();
  for (const ratio of GANN_RATIOS) {
    const target = { x: a.x + dx, y: a.y + dy * ratio };
    const far = extend(a, target, width, height);
    ctx.lineWidth = ratio === 1 ? drawing.style.width + 1 : 1;
    ctx.setLineDash(ratio === 1 ? [] : [3, 3]);
    line(ctx, a, far);
    if (drawing.style.showLabels && (ratio === 1 || ratio === 2 || ratio === 0.5)) {
      const at = { x: a.x + dx * 0.9, y: a.y + dy * ratio * 0.9 };
      label(
        ctx,
        ratio === 1 ? '1×1' : ratio > 1 ? `1×${ratio}` : `${1 / ratio}×1`,
        at,
        drawing.style.color,
      );
    }
  }
  ctx.restore();
}

/** Gann box — a grid at Fibonacci fractions of the box in both axes. */
export function paintGannBox(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const r = rectOf(pts[0], pts[1]);
  const fractions = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];

  ctx.save();
  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  for (const f of fractions) {
    ctx.setLineDash(f === 0 || f === 1 ? [] : [3, 3]);
    ctx.lineWidth = f === 0 || f === 1 ? drawing.style.width : 1;
    line(ctx, { x: r.x, y: r.y + r.h * f }, { x: r.x + r.w, y: r.y + r.h * f });
    line(ctx, { x: r.x + r.w * f, y: r.y }, { x: r.x + r.w * f, y: r.y + r.h });
  }
  ctx.restore();
}

/** Gann square — the box plus its two diagonals and the 1×1 cross. */
export function paintGannSquare(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  paintGannBox(p);
  const r = rectOf(pts[0], pts[1]);
  ctx.save();
  ctx.setLineDash([]);
  line(ctx, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y });
  line(ctx, { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
  ctx.restore();
}

/** Concentric Fibonacci circles centred on the first anchor. */
export function paintFibCircles(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const radius = Math.hypot(b.x - a.x, b.y - a.y);
  ctx.save();
  for (const ratio of FIB_RADII) {
    ctx.setLineDash(ratio === 1 ? [] : [4, 3]);
    ctx.beginPath();
    ctx.arc(a.x, a.y, radius * ratio, 0, Math.PI * 2);
    ctx.stroke();
    if (drawing.style.showLabels) {
      label(ctx, String(ratio), { x: a.x, y: a.y - radius * ratio }, drawing.style.color);
    }
  }
  ctx.restore();
}

/** Fibonacci arcs — half circles opening away from the trend. */
export function paintFibArcs(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const radius = Math.hypot(b.x - a.x, b.y - a.y);
  const rising = b.y < a.y;
  ctx.save();
  for (const ratio of FIB_RADII) {
    ctx.setLineDash(ratio === 1 ? [] : [4, 3]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, radius * ratio, rising ? 0 : Math.PI, rising ? Math.PI : 0);
    ctx.stroke();
    if (drawing.style.showLabels) {
      label(ctx, String(ratio), { x: b.x - radius * ratio, y: b.y }, drawing.style.color);
    }
  }
  ctx.restore();
}

/** Fibonacci speed/resistance fan — rays through the Fib fractions of the box. */
export function paintFibSpeedFan(p: PaintCtx): void {
  const { ctx, pts, width, height, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  ctx.save();
  for (const ratio of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
    const far = extend(a, { x: a.x + dx, y: a.y + dy * ratio }, width, height);
    ctx.setLineDash(ratio === 1 ? [] : [4, 3]);
    line(ctx, a, far);
    if (drawing.style.showLabels) {
      label(
        ctx,
        String(ratio),
        { x: a.x + dx * 0.85, y: a.y + dy * ratio * 0.85 },
        drawing.style.color,
      );
    }
  }
  ctx.restore();
}

/** Fibonacci time zones — vertical lines at Fibonacci bar counts. */
export function paintFibTimezone(p: PaintCtx): void {
  const { ctx, pts, height, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const unit = b.x - a.x;
  if (unit === 0) return;
  const sequence = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  ctx.save();
  for (const n of sequence) {
    const x = a.x + unit * n;
    ctx.setLineDash(n === 0 ? [] : [3, 4]);
    line(ctx, { x, y: 0 }, { x, y: height });
    if (drawing.style.showLabels) label(ctx, String(n), { x, y: 14 }, drawing.style.color);
  }
  ctx.restore();
}

/** Fibonacci channel — parallel rails at Fib fractions of the channel width. */
export function paintFibChannel(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 3) {
    if (pts.length >= 2) line(ctx, pts[0], pts[1]);
    return;
  }
  const [a, b, c] = pts;
  const offset = c.y - a.y;
  ctx.save();
  for (const level of FIB_LEVELS) {
    const dy = offset * level;
    ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
    ctx.lineWidth = level === 0 || level === 1 ? drawing.style.width : 1;
    line(ctx, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy });
    if (drawing.style.showLabels) {
      label(ctx, String(level), { x: b.x, y: b.y + dy }, drawing.style.color);
    }
  }
  ctx.restore();
}

/** Fibonacci wedge — rays from an apex at Fib fractions between two edges. */
export function paintFibWedge(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 3) {
    if (pts.length >= 2) line(ctx, pts[0], pts[1]);
    return;
  }
  const [apex, e1, e2] = pts;
  ctx.save();
  for (const ratio of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
    const target = {
      x: e1.x + (e2.x - e1.x) * ratio,
      y: e1.y + (e2.y - e1.y) * ratio,
    };
    ctx.setLineDash(ratio === 0 || ratio === 1 ? [] : [4, 3]);
    line(ctx, apex, target);
  }
  ctx.restore();
}

/**
 * Flat channel — a horizontal band between two prices.
 *
 * Unlike a parallel channel, both rails are level: only the PRICES of the two
 * anchors matter, the times just bound the drawing.
 */
export function paintFlatChannel(p: PaintCtx): void {
  const { ctx, pts, drawing, priceAt, precision } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  ctx.save();
  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
    ctx.fillRect(left, Math.min(a.y, b.y), right - left, Math.abs(b.y - a.y));
  }
  line(ctx, { x: left, y: a.y }, { x: right, y: a.y });
  line(ctx, { x: left, y: b.y }, { x: right, y: b.y });
  if (drawing.style.showLabels) {
    for (const y of [a.y, b.y]) {
      const price = priceAt(y);
      if (price !== null)
        label(ctx, price.toFixed(precision), { x: right, y }, drawing.style.color);
    }
  }
  ctx.restore();
}

/**
 * Regression channel.
 *
 * Fits a least-squares line through the anchors' bounding region and offsets
 * rails by the maximum deviation. With only two anchors there is nothing to
 * regress, so it degenerates to a parallel band around the connecting line —
 * which is exactly what the operator sees while still dragging it out.
 */
export function paintRegressionChannel(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const spread = Math.abs(b.y - a.y) * 0.5 || 20;
  ctx.save();
  line(ctx, a, b);
  ctx.setLineDash([4, 3]);
  line(ctx, { x: a.x, y: a.y - spread }, { x: b.x, y: b.y - spread });
  line(ctx, { x: a.x, y: a.y + spread }, { x: b.x, y: b.y + spread });
  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - spread);
    ctx.lineTo(b.x, b.y - spread);
    ctx.lineTo(b.x, b.y + spread);
    ctx.lineTo(a.x, a.y + spread);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Elliott wave sets and harmonic patterns.
 *
 * Both are polylines with labelled vertices; only the label set differs, so
 * they share a painter driven by `ELLIOTT_LABELS`. Harmonic patterns also
 * close the figure where the shape is a polygon rather than a zig-zag.
 */
export function paintLabelledPolyline(p: PaintCtx, closeShape: boolean): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const labels = ELLIOTT_LABELS[drawing.kind] ?? [];

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (closeShape && pts.length > 2) ctx.closePath();
  ctx.stroke();

  if (closeShape && drawing.style.fill && pts.length > 2) {
    ctx.fillStyle = drawing.style.fill;
    ctx.fill();
  }

  if (drawing.style.showLabels) {
    for (let i = 0; i < pts.length; i++) {
      const text = labels[i] ?? String(i);
      if (text) label(ctx, text, { x: pts[i].x, y: pts[i].y - 14 }, drawing.style.color);
    }
  }
  ctx.restore();
}

/** A quadratic curve through three points, or a line through two. */
export function paintCurve(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length >= 3) ctx.quadraticCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y);
  else ctx.lineTo(pts[1].x, pts[1].y);
  ctx.stroke();
}

/** A half-arc bulging from the first anchor to the second. */
export function paintArc(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const mid = midpoint(a, b);
  const bulge = Math.hypot(b.x - a.x, b.y - a.y) * 0.4;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(mid.x, mid.y - bulge, b.x, b.y);
  ctx.stroke();
}

/** A pinned marker — flag, signpost or price label. */
export function paintMarker(p: PaintCtx, glyph: string, withPrice: boolean): void {
  const { ctx, pts, drawing, priceAt, precision } = p;
  if (pts.length === 0) return;
  const at = pts[0];
  ctx.save();
  ctx.setLineDash([]);
  line(ctx, at, { x: at.x, y: at.y - 26 });
  const price = withPrice ? priceAt(at.y) : null;
  const text = drawing.style.text || (price !== null ? price.toFixed(precision) : glyph);
  label(ctx, `${glyph} ${text}`.trim(), { x: at.x, y: at.y - 34 }, drawing.style.color);
  ctx.restore();
}
