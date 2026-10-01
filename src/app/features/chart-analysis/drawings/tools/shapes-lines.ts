import { distanceToSegment, type Pt } from '../geometry';
import type { Drawing } from '../model';
import type { ToolBehavior, ToolBehaviorMap } from './types';
import {
  add,
  arcOutline,
  arcThrough,
  cubicAt,
  dedupe,
  dist,
  hitPolygonOutline,
  mid,
  mul,
  normalOf,
  quadAt,
  sample,
  smoothStroke,
  sub,
} from './shapes-geom';
import {
  ENDS_OPTIONS,
  EXTEND_OPTIONS,
  fillOption,
  fillAndStroke,
  fillOf,
  fontOf,
  strokeEnds,
  tracePath,
  type Opts,
} from './shapes-paint';

/**
 * Open strokes and curves of the "Geometric shapes" family: Brush, Highlighter, Arrow,
 * Path, Polyline, Arc, Curve, Double Curve, Arc Curve. Defaults from TradingView's
 * Charting Library overrides (brush #00BCD4 smooth 5, highlighter rgba(242,54,69,0.2)
 * width 20, path/arrow/curve #2962FF with an arrow on the right end, polyline #00BCD4,
 * arc #E91E63 filled at 20 %, double curve #673AB7).
 */

/** Click-until-finish tools (path, polyline): double-click, or click the first point (polyline). */
const UNBOUNDED = Number.POSITIVE_INFINITY;

function hitStroke(pts: Pt[], at: Pt, tol: number): boolean {
  return hitPolygonOutline(at, pts, false, false, tol);
}

// ── Brushes ────────────────────────────────────────────────────────────────

function brushPts(pts: Pt[], o: Opts): Pt[] {
  return smoothStroke(dedupe(pts), Number(o['smooth'] ?? 5));
}

/** Draw a stroke through `pts` with quadratic midpoint joins — TradingView's soft brush look. */
function smoothTrace(ctx: CanvasRenderingContext2D, pts: Pt[], closed = false): void {
  ctx.beginPath();
  if (pts.length < 3) {
    tracePath(ctx, pts, closed);
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  if (closed) ctx.closePath();
}

const brush: ToolBehavior = {
  creation: 'freehand',
  defaultStyle: { color: '#00BCD4', width: 2, fill: 'rgba(0,188,212,0.5)' },
  options: [
    { key: 'smooth', label: 'Smooth', type: 'number', default: 5, min: 0, max: 20, step: 1 },
    ...ENDS_OPTIONS('Normal', 'Normal'),
    fillOption(false),
  ],
  paint({ ctx, pts, drawing, options }) {
    const s = brushPts(pts, options);
    if (s.length < 2) return;
    const fill = fillOf(drawing, options);
    smoothTrace(ctx, s, !!fill);
    fillAndStroke(ctx, fill);
    strokeEnds(ctx, s, drawing, options);
  },
  // A freehand stroke has no anchors worth grabbing one by one: TradingView shows its ends only.
  handles: (p) => (p.pts.length >= 2 ? [p.pts[0], p.pts[p.pts.length - 1]] : p.pts),
  moveHandle: (d, i, to) => {
    const pts = d.points.slice();
    pts[i === 0 ? 0 : pts.length - 1] = to;
    return pts;
  },
  hitTest(p, at, tol) {
    const s = brushPts(p.pts, p.options);
    const fill = fillOf(p.drawing, p.options);
    return hitPolygonOutline(at, s, !!fill, !!fill, Math.max(tol, p.drawing.style.width / 2 + 2));
  },
};

const highlighter: ToolBehavior = {
  creation: 'freehand',
  defaultStyle: { color: 'rgba(242,54,69,0.2)', width: 20, fill: null },
  options: [{ key: 'smooth', label: 'Smooth', type: 'number', default: 5, min: 0, max: 20, step: 1 }],
  paint({ ctx, pts, options }) {
    const s = brushPts(pts, options);
    if (s.length < 1) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // One path, so self-overlaps do not darken the translucent marker.
    smoothTrace(ctx, s.length === 1 ? [s[0], s[0]] : s);
    ctx.stroke();
    ctx.restore();
  },
  handles: (p) => (p.pts.length >= 2 ? [p.pts[0], p.pts[p.pts.length - 1]] : p.pts),
  moveHandle: (d, i, to) => {
    const pts = d.points.slice();
    pts[i === 0 ? 0 : pts.length - 1] = to;
    return pts;
  },
  hitTest: (p, at, tol) => hitStroke(brushPts(p.pts, p.options), at, Math.max(tol, p.drawing.style.width / 2)),
};

// ── Arrow (a trend line with an arrow head on its right end) ───────────────

function extendSegment(a: Pt, b: Pt, o: Opts, w: number, h: number): [Pt, Pt] {
  const d = sub(b, a);
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return [a, b];
  const far = (w + h) * 2;
  const u = mul(d, 1 / len);
  return [o['extendLeft'] ? sub(a, mul(u, far)) : a, o['extendRight'] ? add(b, mul(u, far)) : b];
}

function lineText(ctx: CanvasRenderingContext2D, d: Drawing, a: Pt, b: Pt): void {
  if (!d.style.text) return;
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI; // keep text upright
  const m = mid(a, b);
  ctx.save();
  ctx.setLineDash([]);
  ctx.translate(m.x, m.y);
  ctx.rotate(ang);
  ctx.font = fontOf(d);
  ctx.fillStyle = d.style.textColor ?? d.style.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(d.style.text, 0, -4);
  ctx.restore();
}

const arrow: ToolBehavior = {
  points: 2,
  defaultStyle: { color: '#2962FF', width: 2, fill: null, textColor: '#2962FF', fontSize: 14 },
  options: [...ENDS_OPTIONS('Normal', 'Arrow'), ...EXTEND_OPTIONS],
  paint({ ctx, pts, drawing, options, width, height }) {
    if (pts.length < 2) return;
    const [a, b] = pts;
    const [ea, eb] = extendSegment(a, b, options, width, height);
    tracePath(ctx, [ea, eb], false);
    ctx.stroke();
    // An extended end has no tip to put a head on.
    strokeEnds(ctx, [a, b], drawing, {
      leftEnd: options['extendLeft'] ? 'Normal' : options['leftEnd'],
      rightEnd: options['extendRight'] ? 'Normal' : options['rightEnd'],
    });
    lineText(ctx, drawing, a, b);
  },
  hitTest(p, at, tol) {
    if (p.pts.length < 2) return false;
    const [ea, eb] = extendSegment(p.pts[0], p.pts[1], p.options, p.width, p.height);
    return distanceToSegment(at, ea, eb) <= tol;
  },
};

// ── Path & Polyline (click points, finish with a double-click) ─────────────

/** Polyline closes when its last click lands back on the first point (TradingView). */
export function polylineClosed(pts: Pt[], tol = 7): { pts: Pt[]; closed: boolean } {
  const s = dedupe(pts);
  if (s.length >= 4 && dist(s[0], s[s.length - 1]) <= tol) return { pts: s.slice(0, -1), closed: true };
  return { pts: s, closed: false };
}

const path: ToolBehavior = {
  points: UNBOUNDED,
  creation: 'click',
  defaultStyle: { color: '#2962FF', width: 2, fill: null },
  options: ENDS_OPTIONS('Normal', 'Arrow'),
  paint({ ctx, pts, drawing, options }) {
    const s = dedupe(pts);
    if (s.length < 2) return;
    tracePath(ctx, s, false);
    ctx.stroke();
    strokeEnds(ctx, s, drawing, options);
  },
  hitTest: (p, at, tol) => hitStroke(dedupe(p.pts), at, tol),
};

const polyline: ToolBehavior = {
  points: UNBOUNDED,
  creation: 'click',
  defaultStyle: { color: '#00BCD4', width: 2, fill: 'rgba(0,188,212,0.2)' },
  // TradingView: polyline background is OFF until enabled ("filled": false).
  options: [fillOption(false)],
  paint({ ctx, pts, drawing, options }) {
    const { pts: s, closed } = polylineClosed(pts);
    if (s.length < 2) return;
    tracePath(ctx, s, closed);
    fillAndStroke(ctx, closed || s.length >= 3 ? fillOf(drawing, options) : null);
  },
  hitTest(p, at, tol) {
    const { pts: s, closed } = polylineClosed(p.pts);
    return hitPolygonOutline(at, s, closed, s.length >= 3 && fillOf(p.drawing, p.options) !== null, tol);
  },
};

// ── Arc (chord + bulge, filled) ────────────────────────────────────────────

/** Third arc anchor for 2-point arcs drawn before TradingView parity (fixed 40 % bulge). */
function arcPts(pts: Pt[], preview: boolean): Pt[] | null {
  if (pts.length >= 3) return arcOutline(pts[0], pts[1], pts[2]);
  if (pts.length === 2 && !preview) {
    const [a, b] = pts;
    const n = normalOf(a, b);
    // Legacy painter bulged "up" on screen; pick the normal pointing up.
    const sign = n.y <= 0 ? 1 : -1;
    return arcOutline(a, b, add(mid(a, b), mul(n, sign * dist(a, b) * 0.2)));
  }
  return pts.length === 2 ? pts : null;
}

const arc: ToolBehavior = {
  points: 3,
  defaultStyle: { color: '#E91E63', width: 2, fill: 'rgba(233,30,99,0.2)' },
  options: [fillOption(true)],
  paint({ ctx, pts, drawing, options }) {
    const o = arcPts(pts, drawing.id === 'preview');
    if (!o) return;
    tracePath(ctx, o, o.length > 2);
    fillAndStroke(ctx, o.length > 2 ? fillOf(drawing, options) : null);
  },
  handles(p) {
    // Ends + the apex of the bulge, which is where the third anchor's height shows.
    const o = arcPts(p.pts, p.drawing.id === 'preview');
    if (!o || o.length < 3) return p.pts;
    return [p.pts[0], p.pts[1], o[Math.floor(o.length / 2)]];
  },
  hitTest(p, at, tol) {
    const o = arcPts(p.pts, false);
    if (!o) return false;
    const fill = fillOf(p.drawing, p.options) !== null;
    return hitPolygonOutline(at, o, true, fill, tol);
  },
};

// ── Curve (quadratic Bézier) / Double curve (cubic Bézier) / Arc curve ─────
//
// Click order: start, end, then the control point(s). Handles are the anchors themselves,
// with each control handle sitting on its control point as on TradingView.

function curvePts(pts: Pt[]): Pt[] {
  if (pts.length >= 3) return sample((t) => quadAt(pts[0], pts[2], pts[1], t));
  return pts;
}

function doubleCurvePts(pts: Pt[]): Pt[] {
  if (pts.length >= 4) return sample((t) => cubicAt(pts[0], pts[2], pts[3], pts[1], t), 64);
  // Third click previews the first control mirrored to the second.
  if (pts.length === 3) return sample((t) => cubicAt(pts[0], pts[2], pts[2], pts[1], t), 64);
  return pts;
}

function arcCurvePts(pts: Pt[]): Pt[] {
  if (pts.length >= 3) return arcThrough(pts[0], pts[2], pts[1]);
  return pts;
}

function curveBehavior(color: string, fill: string, outline: (pts: Pt[]) => Pt[], points: number): ToolBehavior {
  return {
    points,
    defaultStyle: { color, width: 2, fill },
    options: [...ENDS_OPTIONS('Normal', 'Normal'), fillOption(false)],
    paint({ ctx, pts, drawing, options }) {
      const o = outline(pts);
      if (o.length < 2) return;
      const f = o.length > 2 ? fillOf(drawing, options) : null;
      tracePath(ctx, o, !!f);
      fillAndStroke(ctx, f);
      strokeEnds(ctx, o, drawing, options);
    },
    hitTest(p, at, tol) {
      const o = outline(p.pts);
      const f = o.length > 2 && fillOf(p.drawing, p.options) !== null;
      return hitPolygonOutline(at, o, f, f, tol);
    },
  };
}

export const LINE_BEHAVIORS: ToolBehaviorMap = {
  brush,
  highlighter,
  arrow,
  path,
  polyline,
  arc,
  curve: curveBehavior('#2962FF', 'rgba(41,98,255,0.2)', curvePts, 3),
  'double-curve': curveBehavior('#673AB7', 'rgba(103,58,183,0.2)', doubleCurvePts, 4),
  'arc-curve': curveBehavior('#2962FF', 'rgba(41,98,255,0.2)', arcCurvePts, 3),
};

export { curvePts, doubleCurvePts, arcCurvePts };
