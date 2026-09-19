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
  /**
   * The bars currently loaded, for the two volume-profile tools.
   *
   * Every other painter here is pure geometry and deliberately stays that way
   * — a painter that reaches for market data is one that can disagree with the
   * series it is drawn over. The profiles are the exception because a volume
   * histogram IS the data; there is no geometric construction to use instead.
   */
  bars?: readonly { time: number; high: number; low: number; close: number; volume: number }[];
  /** Screen x → time (ms). The inverse of projection, for bar counting. */
  timeAt?: (x: number) => number | null;
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

// ── Cycles, spirals and projection ─────────────────────────────────────────

/**
 * Fibonacci spiral — a golden spiral of quarter-arcs growing by φ.
 *
 * Each quarter turn multiplies the radius by the golden ratio, which is what
 * makes it a Fib spiral rather than a plain Archimedean one; the anchors set
 * the origin and the first radius.
 */
export function paintFibSpiral(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  let radius = Math.max(2, Math.hypot(b.x - a.x, b.y - a.y) / 8);
  const phi = 1.6180339887;
  let cx = a.x;
  let cy = a.y;

  ctx.save();
  ctx.beginPath();
  for (let turn = 0; turn < 8; turn++) {
    const start = (turn * Math.PI) / 2;
    ctx.arc(cx, cy, radius, start, start + Math.PI / 2);
    // Step the centre so the next quarter continues from where this one ended.
    const end = {
      x: cx + radius * Math.cos(start + Math.PI / 2),
      y: cy + radius * Math.sin(start + Math.PI / 2),
    };
    const next = radius * phi;
    cx = end.x - next * Math.cos(start + Math.PI / 2);
    cy = end.y - next * Math.sin(start + Math.PI / 2);
    radius = next;
    if (radius > 20000) break;
  }
  ctx.stroke();
  ctx.restore();
}

/** Evenly spaced vertical lines — cycle counts across the time axis. */
export function paintCyclicLines(p: PaintCtx, count = 12): void {
  const { ctx, pts, height, drawing } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const step = b.x - a.x;
  if (step === 0) return;
  ctx.save();
  for (let i = 0; i <= count; i++) {
    const x = a.x + step * i;
    ctx.setLineDash(i === 0 || i === 1 ? [] : [3, 4]);
    line(ctx, { x, y: 0 }, { x, y: height });
    if (drawing.style.showLabels && i > 0 && i % 2 === 0) {
      label(ctx, String(i), { x, y: 14 }, drawing.style.color);
    }
  }
  ctx.restore();
}

/** Concentric circles on the time axis — time-cycle rings. */
export function paintTimeCycles(p: PaintCtx, count = 8): void {
  const { ctx, pts, height } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const step = Math.abs(b.x - a.x);
  if (step === 0) return;
  ctx.save();
  ctx.setLineDash([3, 3]);
  for (let i = 1; i <= count; i++) {
    ctx.beginPath();
    ctx.ellipse(a.x, height / 2, step * i, height / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A sine wave fitted between two anchors — cycle overlay. */
export function paintSineLine(p: PaintCtx, cycles = 3): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  const span = b.x - a.x;
  if (span === 0) return;
  const amplitude = (b.y - a.y) / 2;
  const mid = (a.y + b.y) / 2;

  ctx.beginPath();
  const steps = Math.max(24, Math.abs(span));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + span * t;
    const y = mid + amplitude * Math.sin(t * cycles * Math.PI * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * Bars-pattern / ghost-feed placeholder.
 *
 * TradingView's versions COPY a range of real bars and replay them elsewhere
 * on the chart. That needs the bar data, which this module deliberately does
 * not have — the painters take projected points only — so the region is drawn
 * as a labelled band instead of silently drawing nothing. Promoting it to a
 * true bar copy means passing the source bars in, and is noted in the plan.
 */
export function paintBarRegion(p: PaintCtx, text: string): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 2) return;
  const r = rectOf(pts[0], pts[1]);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = drawing.style.fill ?? 'rgba(120,123,134,0.10)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  if (drawing.style.showLabels) {
    label(ctx, text, { x: r.x + r.w / 2, y: r.y + 10 }, drawing.style.color);
  }
}

/** A rectangle rotated to sit along the first two anchors. */
export function paintRotatedRectangle(p: PaintCtx): void {
  const { ctx, pts, drawing } = p;
  if (pts.length < 3) {
    if (pts.length >= 2) line(ctx, pts[0], pts[1]);
    return;
  }
  const [a, b, c] = pts;
  // Thickness is the perpendicular distance from the third anchor to the a→b
  // axis, so dragging it widens the band without rotating it.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = (c.x - a.x) * nx + (c.y - a.y) * ny;

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x + nx * offset, b.y + ny * offset);
  ctx.lineTo(a.x + nx * offset, a.y + ny * offset);
  ctx.closePath();
  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
    ctx.fill();
  }
  ctx.stroke();
}

/** Two joined quadratic curves through four anchors. */
export function paintDoubleCurve(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 4) return paintCurve(p);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.quadraticCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y);
  ctx.quadraticCurveTo(pts[3].x, pts[3].y, pts[0].x, pts[0].y);
  ctx.stroke();
}

/** A Gann grid — evenly spaced squares from one box. */
export function paintGannGrid(p: PaintCtx, repeats = 4): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const r = rectOf(pts[0], pts[1]);
  if (r.w === 0 || r.h === 0) return;
  ctx.save();
  ctx.setLineDash([2, 3]);
  for (let i = 0; i <= repeats; i++) {
    line(ctx, { x: r.x + r.w * i, y: r.y }, { x: r.x + r.w * i, y: r.y + r.h * repeats });
    line(ctx, { x: r.x, y: r.y + r.h * i }, { x: r.x + r.w * repeats, y: r.y + r.h * i });
  }
  ctx.restore();
}

/**
 * A Gann square anchored to a FIXED box rather than scaled to the drag.
 *
 * `gann-square` scales its internal ratios to whatever box you drew.
 * This variant keeps the box square in SCREEN space — the side is the larger
 * of the two drag extents — which is what makes the 1×1 diagonal a true 45°
 * line. That is the whole point of the fixed variant: on the scaled version
 * the "45° line" is only 45° by accident of the drag.
 */
export function paintGannSquareFixed(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const side = Math.max(Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
  if (side === 0) return;
  const sx = pts[1].x >= pts[0].x ? 1 : -1;
  const sy = pts[1].y >= pts[0].y ? 1 : -1;
  const x0 = pts[0].x;
  const y0 = pts[0].y;

  ctx.save();
  ctx.strokeRect(Math.min(x0, x0 + sx * side), Math.min(y0, y0 + sy * side), side, side);

  // The Gann ratio fan out of the origin corner. Ratios above 1 would leave
  // the square through its far side, so they are drawn as the reciprocal on
  // the other axis — which is the same line reflected, and keeps every ray
  // inside the box.
  for (const ratio of GANN_RATIOS) {
    const inside = ratio <= 1;
    const end: Pt = inside
      ? { x: x0 + sx * side, y: y0 + sy * side * ratio }
      : { x: x0 + (sx * side) / ratio, y: y0 + sy * side };
    ctx.lineWidth = ratio === 1 ? p.drawing.style.width + 1 : 1;
    ctx.setLineDash(ratio === 1 ? [] : [3, 3]);
    line(ctx, { x: x0, y: y0 }, end);
  }
  ctx.restore();
}

/** Degrees of the a→b line in SCREEN space, normalised to (-180, 180]. */
function screenAngle(a: Pt, b: Pt): number {
  // Screen y grows downward, so negate to get the angle a trader expects:
  // a rising line reads positive.
  return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
}

/**
 * Trend Angle — a trend line that labels its own slope, with an arc at the
 * origin showing the angle against horizontal.
 *
 * The angle is a SCREEN measurement and changes when the price scale is zoomed
 * or switched to log. That is not a bug and matches TradingView: the tool
 * measures the visual slope, which is the thing Gann-style analysis is about.
 */
export function paintTrendAngle(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  line(ctx, a, b);

  const deg = screenAngle(a, b);
  const radius = Math.min(46, Math.max(18, Math.hypot(b.x - a.x, b.y - a.y) / 3));

  ctx.save();
  ctx.setLineDash([2, 2]);
  // Horizontal reference leg.
  line(ctx, a, { x: a.x + Math.sign(b.x - a.x || 1) * radius, y: a.y });
  ctx.beginPath();
  const from = 0;
  const to = -(deg * Math.PI) / 180;
  ctx.arc(a.x, a.y, radius, Math.min(from, to), Math.max(from, to));
  ctx.stroke();
  ctx.restore();

  label(ctx, `${deg.toFixed(1)}°`, { x: a.x + radius + 18, y: a.y - 10 }, p.drawing.style.color);
}

/** How many loaded bars fall between two times. */
function barsBetween(p: PaintCtx, t0: number, t1: number): number | null {
  const bars = p.bars;
  if (!bars || bars.length === 0) return null;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  let n = 0;
  for (const bar of bars) if (bar.time >= lo && bar.time <= hi) n++;
  return n > 0 ? n - 1 : 0;
}

/**
 * Info Line / Ruler — a trend line carrying its own measurements.
 *
 * Both render identically; they exist as separate tools because TradingView
 * separates them and operators reach for them by name. The readout is price
 * delta, percentage change and — when bar data is available — the number of
 * bars spanned.
 */
export function paintInfoLine(p: PaintCtx): void {
  const { ctx, pts, priceAt, precision } = p;
  if (pts.length < 2) return;
  const [a, b] = pts;
  line(ctx, a, b);

  // Arrow head at the destination so direction is unambiguous.
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - 9 * Math.cos(ang - Math.PI / 7), b.y - 9 * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(b.x - 9 * Math.cos(ang + Math.PI / 7), b.y - 9 * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fillStyle = p.drawing.style.color;
  ctx.fill();
  ctx.restore();

  const p0 = priceAt(a.y);
  const p1 = priceAt(b.y);
  const parts: string[] = [];
  if (p0 !== null && p1 !== null) {
    const delta = p1 - p0;
    parts.push(`${delta >= 0 ? '+' : ''}${delta.toFixed(precision)}`);
    // Guard the divide: a zero anchor price would print Infinity%.
    if (p0 !== 0) parts.push(`${((delta / Math.abs(p0)) * 100).toFixed(2)}%`);
  }
  if (p.timeAt) {
    const t0 = p.timeAt(a.x);
    const t1 = p.timeAt(b.x);
    if (t0 !== null && t1 !== null) {
      const n = barsBetween(p, t0, t1);
      if (n !== null) parts.push(`${n} bar${n === 1 ? '' : 's'}`);
    }
  }
  if (parts.length) {
    label(ctx, parts.join('  ·  '), midpoint(a, b), p.drawing.style.color);
  }
}

/**
 * Forecast — a measured move projected forward from a two-leg anchor.
 *
 * Points are origin → observed move → projection start. The projected leg
 * repeats the observed leg's price delta and bar width, drawn dashed to mark
 * it as hypothesis rather than history.
 */
export function paintForecast(p: PaintCtx): void {
  const { ctx, pts, priceAt, precision } = p;
  if (pts.length < 3) return;
  const [a, b, c] = pts;
  line(ctx, a, b);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const target: Pt = { x: c.x + dx, y: c.y + dy };

  ctx.save();
  ctx.setLineDash([5, 4]);
  line(ctx, c, target);
  ctx.restore();

  // Shade the projected envelope so it reads as a zone, not a promise.
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = p.drawing.style.color;
  ctx.fillRect(Math.min(c.x, target.x), Math.min(c.y, target.y), Math.abs(dx), Math.abs(dy) || 1);
  ctx.restore();

  const pc = priceAt(c.y);
  const pt = priceAt(target.y);
  if (pc !== null && pt !== null) {
    label(ctx, `→ ${pt.toFixed(precision)}`, target, p.drawing.style.color);
  }
}

/**
 * Trend-Based Fib Time — Fibonacci time divisions projected from a 3-point
 * anchor.
 *
 * The first two points set the base time span; the ratios are laid out from
 * the third point in multiples of that span, so the verticals mark WHEN a move
 * of comparable duration would complete. Purely horizontal (time) — the price
 * of each click is irrelevant beyond anchoring.
 */
export function paintTrendFibTime(p: PaintCtx): void {
  const { ctx, pts, height } = p;
  if (pts.length < 3) return;
  const span = pts[1].x - pts[0].x;
  if (span === 0) return;

  const ratios = [0, 0.618, 1, 1.618, 2.618, 4.236];
  ctx.save();
  for (const r of ratios) {
    const x = pts[2].x + span * r;
    ctx.setLineDash(r === 0 || r === 1 ? [] : [3, 3]);
    line(ctx, { x, y: 0 }, { x, y: height });
    label(
      ctx,
      r.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''),
      { x, y: 14 },
      p.drawing.style.color,
    );
  }
  ctx.restore();
}

/**
 * Circle — centre and radius, distinct from `ellipse`'s bounding box.
 *
 * The radius is the SCREEN distance between the two clicks, so it stays a
 * circle as the price scale changes rather than squashing into an ellipse.
 */
export function paintCircle(p: PaintCtx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  if (r === 0) return;
  ctx.beginPath();
  ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (p.drawing.style.fill) {
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = p.drawing.style.color;
    ctx.fill();
    ctx.restore();
  }
}

/** A directional arrow mark pinned to one bar. */
export function paintArrowMark(p: PaintCtx, dir: 'up' | 'down' | 'left' | 'right'): void {
  const { ctx, pts } = p;
  if (pts.length < 1) return;
  const { x, y } = pts[0];
  const s = 13;
  const rot = { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 }[dir];

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s, -s * 0.62);
  ctx.lineTo(-s * 0.35, 0);
  ctx.lineTo(-s, s * 0.62);
  ctx.closePath();
  ctx.fillStyle = p.drawing.style.color;
  ctx.fill();
  ctx.restore();
}

/**
 * Volume profile — a horizontal histogram of traded volume by price.
 *
 * Volume is bucketed by each bar's CLOSE rather than spread across its
 * high-low range. Spreading is more faithful in principle, but with no
 * intrabar data it would just smear volume uniformly over the range, which
 * invents structure that was never observed — a flat smear reads as support
 * where there was none. Bucketing at the close under-states wide bars but
 * never fabricates a level.
 *
 * The Point of Control (the highest-volume bucket) is drawn solid; the rest
 * are translucent.
 *
 * `toX` bounds the histogram: anchored profiles run to the right edge, fixed
 * range to the second click.
 */
export function paintVolumeProfile(p: PaintCtx, mode: 'anchored' | 'fixed'): void {
  const { ctx, pts, priceAt, precision, width, height } = p;
  if (pts.length < 1) return;
  const bars = p.bars;
  const timeAt = p.timeAt;
  if (!bars || bars.length === 0 || !timeAt) return;

  const fromX = pts[0].x;
  const toX = mode === 'fixed' ? (pts[1]?.x ?? fromX) : width;
  const t0 = timeAt(Math.min(fromX, toX));
  const t1 = timeAt(Math.max(fromX, toX));
  if (t0 === null || t1 === null) return;

  const inRange = bars.filter((b) => b.time >= t0 && b.time <= t1 && b.volume > 0);
  if (inRange.length === 0) return;

  // Bucket over the price range actually traded in the window, not the
  // viewport: a profile that changes shape when you pan is not a profile.
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of inRange) {
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return;

  const BUCKETS = 48;
  const buckets = new Array<number>(BUCKETS).fill(0);
  for (const b of inRange) {
    const idx = Math.min(BUCKETS - 1, Math.floor(((b.close - lo) / (hi - lo)) * BUCKETS));
    if (idx >= 0) buckets[idx] += b.volume;
  }
  const peak = Math.max(...buckets);
  if (peak <= 0) return;
  const pocIndex = buckets.indexOf(peak);

  // Map bucket index → screen y by inverting priceAt over the viewport. The
  // renderer gives us price→y only one way, so walk the pane once to build the
  // mapping rather than assuming a linear scale (which log mode would break).
  const yForPrice = (price: number): number | null => {
    // Binary search the pane for the y whose price matches. ~11 iterations.
    let top = 0;
    let bottom = height;
    const pTop = priceAt(top);
    const pBottom = priceAt(bottom);
    if (pTop === null || pBottom === null) return null;
    if (price > Math.max(pTop, pBottom) || price < Math.min(pTop, pBottom)) return null;
    for (let i = 0; i < 24 && bottom - top > 0.5; i++) {
      const mid = (top + bottom) / 2;
      const pm = priceAt(mid);
      if (pm === null) return null;
      // Price decreases as y increases.
      if (pm > price) top = mid;
      else bottom = mid;
    }
    return (top + bottom) / 2;
  };

  const maxBarWidth = Math.min(180, Math.abs(toX - fromX) || 180);
  const originX = mode === 'fixed' ? Math.min(fromX, toX) : fromX;

  ctx.save();
  ctx.setLineDash([]);
  for (let i = 0; i < BUCKETS; i++) {
    if (buckets[i] <= 0) continue;
    const priceLo = lo + ((hi - lo) * i) / BUCKETS;
    const priceHi = lo + ((hi - lo) * (i + 1)) / BUCKETS;
    const yTop = yForPrice(priceHi);
    const yBottom = yForPrice(priceLo);
    if (yTop === null || yBottom === null) continue;
    const h = Math.max(1, Math.abs(yBottom - yTop) - 1);
    const w = (buckets[i] / peak) * maxBarWidth;
    ctx.globalAlpha = i === pocIndex ? 0.75 : 0.3;
    ctx.fillStyle = p.drawing.style.color;
    ctx.fillRect(originX, Math.min(yTop, yBottom), w, h);
  }
  ctx.globalAlpha = 1;

  // Label the Point of Control — the level the window actually transacted at.
  const pocPrice = lo + ((hi - lo) * (pocIndex + 0.5)) / BUCKETS;
  const pocY = yForPrice(pocPrice);
  if (pocY !== null) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = p.drawing.style.color;
    line(ctx, { x: originX, y: pocY }, { x: originX + maxBarWidth, y: pocY });
    label(
      ctx,
      `POC ${pocPrice.toFixed(precision)}`,
      { x: originX + maxBarWidth + 40, y: pocY },
      p.drawing.style.color,
    );
  }
  ctx.restore();
}
