import type { Pt } from '../geometry';
import type { Drawing, DrawingPoint } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolGeometry } from './types';
import {
  add,
  dist,
  ellipseFrom3,
  ellipseFromBox,
  ellipseHandles,
  hitEllipseGeom,
  hitPolygonOutline,
  mid,
  mul,
  normalOf,
  perpOffset,
  rectHandles,
  rotatedRectCorners,
  type EllipseGeom,
} from './shapes-geom';
import { FILL_OPTION, TEXT_ALIGN_OPTIONS, boxText, fillAndStroke, fillOf, tracePath, type Opts } from './shapes-paint';
import { LINE_BEHAVIORS } from './shapes-lines';
import { MARK_BEHAVIORS } from './shapes-marks';

/**
 * TradingView rail family "Geometric shapes" — Brushes, Arrows, Shapes.
 *
 * Defaults are TradingView's own (Charting Library `*LineToolOverrides`):
 * rectangle #9C27B0, rotated rectangle #4CAF50, ellipse #F23645, circle #FF9800,
 * triangle #089981 — each with its colour at 20 % as the background, line width 2.
 * Closed shapes live here; strokes/curves in shapes-lines.ts; arrow marks in shapes-marks.ts.
 */

const TEXT_SIZE = 14;

// ── Rectangle ───────────────────────────────────────────────────────────────

function rectBox(p: { pts: Pt[]; width: number }, o: Opts) {
  const [a, b] = p.pts;
  let l = Math.min(a.x, b.x);
  let r = Math.max(a.x, b.x);
  if (o['extendLeft']) l = Math.min(l, 0);
  if (o['extendRight']) r = Math.max(r, p.width);
  const t = Math.min(a.y, b.y);
  return { x: l, y: t, w: r - l, h: Math.abs(b.y - a.y) };
}

/**
 * Rectangle handle drag, in DATA space so it survives an off-screen/future anchor.
 * Handles 0-3 are corners TL, TR, BR, BL; 4-7 are the top, right, bottom, left edge
 * midpoints, which move that one side only (TradingView behaviour).
 */
export function moveRectHandle(d: Drawing, index: number, to: DrawingPoint, geo?: ToolGeometry): DrawingPoint[] {
  const [p0, p1] = d.points;
  if (!p0 || !p1) return d.points;
  let left = Math.min(p0.time, p1.time);
  let right = Math.max(p0.time, p1.time);
  const hi = Math.max(p0.price, p1.price);
  const lo = Math.min(p0.price, p1.price);
  // Screen-top is the high price unless the price scale is inverted.
  let invert = false;
  if (geo) {
    const ph = geo.project({ time: left, price: hi });
    const pl = geo.project({ time: left, price: lo });
    if (ph && pl) invert = ph.y > pl.y;
  }
  let top = invert ? lo : hi;
  let bottom = invert ? hi : lo;
  const setTop = () => (top = to.price);
  const setBottom = () => (bottom = to.price);
  const setLeft = () => (left = to.time);
  const setRight = () => (right = to.time);
  switch (index) {
    case 0: setLeft(); setTop(); break;
    case 1: setRight(); setTop(); break;
    case 2: setRight(); setBottom(); break;
    case 3: setLeft(); setBottom(); break;
    case 4: setTop(); break;
    case 5: setRight(); break;
    case 6: setBottom(); break;
    case 7: setLeft(); break;
    default: return d.points;
  }
  return [
    { time: left, price: top },
    { time: right, price: bottom },
  ];
}

const rectangle: ToolBehavior = {
  points: 2,
  defaultStyle: { color: '#9C27B0', fill: 'rgba(156,39,176,0.2)', width: 2, textColor: '#9C27B0', fontSize: TEXT_SIZE },
  options: [
    FILL_OPTION,
    { key: 'extendLeft', label: 'Extend left', type: 'bool', default: false },
    { key: 'extendRight', label: 'Extend right', type: 'bool', default: false },
    { key: 'middleLine', label: 'Middle line', type: 'bool', default: false },
    { key: 'middleLineColor', label: 'Middle line colour', type: 'color', default: '#9C27B0' },
    ...TEXT_ALIGN_OPTIONS,
  ],
  paint(p) {
    const { ctx, pts, drawing, options } = p;
    if (pts.length < 2) return;
    const r = rectBox(p, options);
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    fillAndStroke(ctx, fillOf(drawing, options));
    if (options['middleLine']) {
      ctx.save();
      ctx.strokeStyle = String(options['middleLineColor'] ?? drawing.style.color);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      tracePath(ctx, [{ x: r.x, y: r.y + r.h / 2 }, { x: r.x + r.w, y: r.y + r.h / 2 }], false);
      ctx.stroke();
      ctx.restore();
    }
    boxText(ctx, drawing, r, String(options['horzLabelsAlign']), String(options['vertLabelsAlign']));
  },
  handles: (p) => (p.pts.length >= 2 ? rectHandles(p.pts[0], p.pts[1]) : p.pts),
  moveHandle: (d, i, to, geo) => moveRectHandle(d, i, to, geo),
  hitTest(p, at, tol) {
    if (p.pts.length < 2) return false;
    const r = rectBox(p, p.options);
    const poly = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
    return hitPolygonOutline(at, poly, true, fillOf(p.drawing, p.options) !== null, tol);
  },
};

// ── Rotated rectangle (TV: two clicks set one side, the third its width) ───

export function rotatedRectHandles(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const [a, b, c] = pts;
  const [, , b2, a2] = rotatedRectCorners(a, b, c);
  // Base ends + midpoint of the far side (drags the width), as TradingView.
  return [a, b, mid(a2, b2)];
}

export function moveRotatedRectHandle(d: Drawing, index: number, to: DrawingPoint, geo: ToolGeometry): DrawingPoint[] {
  const pts = d.points.slice();
  if (index === 2 || pts.length < 3) {
    pts[index] = to;
    return pts;
  }
  // Moving a base end keeps the width: rebuild the width anchor from the new base.
  const sa = geo.project(pts[0]);
  const sb = geo.project(pts[1]);
  const sc = geo.project(pts[2]);
  pts[index] = to;
  const na = geo.project(pts[0]);
  const nb = geo.project(pts[1]);
  if (!sa || !sb || !sc || !na || !nb) return pts;
  const off = perpOffset(sa, sb, sc);
  const c = geo.unproject(add(mid(na, nb), mul(normalOf(na, nb), off)));
  if (c) pts[2] = c;
  return pts;
}

const rotatedRectangle: ToolBehavior = {
  points: 3,
  defaultStyle: { color: '#4CAF50', fill: 'rgba(76,175,80,0.2)', width: 2 },
  options: [FILL_OPTION],
  paint({ ctx, pts, drawing, options }) {
    if (pts.length < 2) return;
    if (pts.length === 2) {
      tracePath(ctx, pts, false);
      ctx.stroke();
      return;
    }
    tracePath(ctx, rotatedRectCorners(pts[0], pts[1], pts[2]), true);
    fillAndStroke(ctx, fillOf(drawing, options));
  },
  handles: (p) => rotatedRectHandles(p.pts),
  moveHandle: moveRotatedRectHandle,
  hitTest(p, at, tol) {
    const { pts } = p;
    if (pts.length < 3) return pts.length === 2 && hitPolygonOutline(at, pts, false, false, tol);
    return hitPolygonOutline(at, rotatedRectCorners(pts[0], pts[1], pts[2]), true, fillOf(p.drawing, p.options) !== null, tol);
  },
};

// ── Ellipse (TV: two clicks = one axis, third click = the other radius) ────

/** Ellipse geometry for 1-3 projected points. Two stored points = a legacy bounding box. */
export function ellipseOf(pts: Pt[], preview: boolean): EllipseGeom | null {
  if (pts.length >= 3) return ellipseFrom3(pts[0], pts[1], pts[2]);
  if (pts.length === 2) {
    // While placing, the first axis is set and the shape previews as a circle on it.
    if (preview) return { ...ellipseFrom3(pts[0], pts[1], pts[0]), ry: dist(pts[0], pts[1]) / 2 };
    return ellipseFromBox(pts[0], pts[1]);
  }
  return null;
}

/**
 * Perimeter-handle drag. 0/1 are the ends of the first axis — dragging one moves that end
 * (rotating and resizing about the fixed opposite end) and keeps the second radius; 2/3 are
 * the ends of the second axis and change only that radius.
 */
export function moveEllipseHandle(d: Drawing, index: number, to: DrawingPoint, geo: ToolGeometry): DrawingPoint[] {
  const proj = d.points.map((p) => geo.project(p));
  if (proj.some((p) => !p)) return d.points;
  const e = ellipseOf(proj as Pt[], false);
  if (!e) return d.points;
  const [h0, h1] = ellipseHandles(e);
  const target = geo.project(to);
  if (!target) return d.points;
  let a = h0;
  let b = h1;
  let ry = e.ry;
  if (index === 0) a = target;
  else if (index === 1) b = target;
  else if (index === 2 || index === 3) ry = Math.abs(perpOffset(h0, h1, target));
  else return d.points;
  const c = add(mid(a, b), mul(normalOf(a, b), ry));
  const out = [a, b, c].map((p) => geo.unproject(p));
  if (out.some((p) => !p)) return d.points;
  // Keep the dragged anchor exactly where the pointer put it (no round-trip drift).
  if (index === 0) out[0] = to;
  if (index === 1) out[1] = to;
  return out as DrawingPoint[];
}

function ellipsePath(ctx: CanvasRenderingContext2D, e: EllipseGeom): void {
  ctx.beginPath();
  ctx.ellipse(e.c.x, e.c.y, Math.max(e.rx, 0.01), Math.max(e.ry, 0.01), e.angle, 0, Math.PI * 2);
}

const ellipse: ToolBehavior = {
  points: 3,
  defaultStyle: { color: '#F23645', fill: 'rgba(242,54,69,0.2)', width: 2, textColor: '#F23645', fontSize: TEXT_SIZE },
  options: [FILL_OPTION],
  paint({ ctx, pts, drawing, options }) {
    const e = ellipseOf(pts, drawing.id === 'preview');
    if (!e) return;
    ellipsePath(ctx, e);
    fillAndStroke(ctx, fillOf(drawing, options));
    boxText(ctx, drawing, { x: e.c.x - e.rx, y: e.c.y - e.ry, w: e.rx * 2, h: e.ry * 2 }, 'center', 'middle');
  },
  handles(p) {
    const e = ellipseOf(p.pts, p.drawing.id === 'preview');
    return e ? ellipseHandles(e) : p.pts;
  },
  moveHandle: moveEllipseHandle,
  hitTest(p, at, tol) {
    const e = ellipseOf(p.pts, false);
    return !!e && hitEllipseGeom(e, at, fillOf(p.drawing, p.options) !== null, tol);
  },
};

// ── Circle (centre + a point on the perimeter) ─────────────────────────────

export function moveCircleHandle(d: Drawing, index: number, to: DrawingPoint): DrawingPoint[] {
  const [c, r] = d.points;
  if (index === 1 || !r) return [c, to];
  // The centre handle moves the whole circle, keeping its radius.
  return [to, { time: r.time + (to.time - c.time), price: r.price + (to.price - c.price) }];
}

const circle: ToolBehavior = {
  points: 2,
  defaultStyle: { color: '#FF9800', fill: 'rgba(255,152,0,0.2)', width: 2, textColor: '#FF9800', fontSize: TEXT_SIZE },
  options: [FILL_OPTION],
  paint({ ctx, pts, drawing, options }) {
    if (pts.length < 2) return;
    const r = dist(pts[0], pts[1]);
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
    fillAndStroke(ctx, fillOf(drawing, options));
    boxText(ctx, drawing, { x: pts[0].x - r, y: pts[0].y - r, w: 2 * r, h: 2 * r }, 'center', 'middle');
  },
  moveHandle: (d, i, to) => moveCircleHandle(d, i, to),
  hitTest(p, at, tol) {
    if (p.pts.length < 2) return false;
    const r = dist(p.pts[0], p.pts[1]);
    const d = dist(at, p.pts[0]);
    return (fillOf(p.drawing, p.options) !== null && d <= r) || Math.abs(d - r) <= tol;
  },
};

// ── Triangle ───────────────────────────────────────────────────────────────

const triangle: ToolBehavior = {
  points: 3,
  defaultStyle: { color: '#089981', fill: 'rgba(8,153,129,0.2)', width: 2 },
  options: [FILL_OPTION],
  paint({ ctx, pts, drawing, options }) {
    if (pts.length < 2) return;
    tracePath(ctx, pts.slice(0, 3), pts.length >= 3);
    if (pts.length >= 3) fillAndStroke(ctx, fillOf(drawing, options));
    else ctx.stroke();
  },
  hitTest: (p, at, tol) =>
    hitPolygonOutline(at, p.pts.slice(0, 3), p.pts.length >= 3, p.pts.length >= 3 && fillOf(p.drawing, p.options) !== null, tol),
};

export const BEHAVIORS: ToolBehaviorMap = {
  rectangle,
  'rotated-rectangle': rotatedRectangle,
  ellipse,
  circle,
  triangle,
  ...LINE_BEHAVIORS,
  ...MARK_BEHAVIORS,
};
