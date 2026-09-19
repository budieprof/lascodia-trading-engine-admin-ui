import type { Drawing, DrawingKind } from './model';

/**
 * Hit-testing and layout maths in SCREEN space.
 *
 * Kept pure and separate from the renderer because this is where "the drawing
 * is there but I can't grab it" bugs live, and those are almost impossible to
 * chase through a canvas. Everything here takes plain numbers and is unit
 * tested.
 */

export interface Pt {
  x: number;
  y: number;
}

/** How close the pointer must get, in px, to grab a line or a handle. */
export const HIT_TOLERANCE = 6;
export const HANDLE_RADIUS = 4;
/** Handles are easier to grab than the line they sit on, as in TradingView. */
export const HANDLE_TOLERANCE = 7;

/**
 * Distance from a point to a finite segment.
 *
 * The clamp on `t` is what makes it a SEGMENT rather than an infinite line —
 * without it a trendline stays grabbable far past its own end points, which
 * feels like the chart is grabbing the wrong object.
 */
export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance to an infinite line through a and b. */
export function distanceToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/**
 * Distance to a ray that starts at `a` and passes through `b`, extending only
 * forwards. Behind the origin the nearest point is the origin itself.
 */
export function distanceToRay(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (t <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function rectOf(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/**
 * A rectangle is grabbable on its EDGES, and on its interior only when filled.
 * An unfilled rectangle that swallows clicks anywhere inside it would block
 * every drawing and every candle beneath it.
 */
export function hitRect(p: Pt, a: Pt, b: Pt, filled: boolean, tol = HIT_TOLERANCE): boolean {
  const r = rectOf(a, b);
  const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (filled && inside) return true;
  const corners: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (distanceToSegment(p, corners[i], corners[(i + 1) % 4]) <= tol) return true;
  }
  return false;
}

export function hitEllipse(p: Pt, a: Pt, b: Pt, filled: boolean, tol = HIT_TOLERANCE): boolean {
  const r = rectOf(a, b);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = Math.max(r.w / 2, 0.0001);
  const ry = Math.max(r.h / 2, 0.0001);
  const norm = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
  if (filled) return norm <= 1;
  // Band around the perimeter, scaled so the tolerance stays roughly constant
  // in pixels regardless of how large the ellipse is.
  const scale = Math.max(rx, ry);
  const band = (tol / scale) * 2;
  return Math.abs(norm - 1) <= band;
}

export function hitPolygon(p: Pt, pts: Pt[], filled: boolean, tol = HIT_TOLERANCE): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    if (distanceToSegment(p, pts[i], next) <= tol) return true;
  }
  return filled && pointInPolygon(p, pts);
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function hitPolyline(p: Pt, pts: Pt[], tol = HIT_TOLERANCE): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (distanceToSegment(p, pts[i], pts[i + 1]) <= tol) return true;
  }
  return false;
}

/** Which handle (point index) the pointer is over, or -1. */
export function hitHandle(p: Pt, pts: Pt[], tol = HANDLE_TOLERANCE): number {
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(p.x - pts[i].x, p.y - pts[i].y) <= tol) return i;
  }
  return -1;
}

/**
 * Hit-test a drawing given its points already projected to screen space.
 *
 * Handles are checked by the caller first, so this is body-only. Kinds that
 * extend beyond their points (rays, extended and horizontal/vertical lines)
 * are tested against their extension, not just the segment between the points
 * the operator clicked — otherwise the visible line is not grabbable along
 * most of its length.
 */
export function hitTestDrawing(
  p: Pt,
  kind: DrawingKind,
  pts: Pt[],
  filled: boolean,
  bounds: { width: number; height: number },
  tol = HIT_TOLERANCE,
): boolean {
  if (pts.length === 0) return false;
  const [a, b, c] = pts;

  switch (kind) {
    case 'trend-line':
    case 'arrow':
    case 'measure':
      return pts.length >= 2 && distanceToSegment(p, a, b) <= tol;

    case 'ray':
      return pts.length >= 2 && distanceToRay(p, a, b) <= tol;

    case 'extended-line':
      return pts.length >= 2 && distanceToLine(p, a, b) <= tol;

    case 'horizontal-line':
      return Math.abs(p.y - a.y) <= tol;

    case 'horizontal-ray':
      return pts.length >= 2 && Math.abs(p.y - a.y) <= tol && p.x >= Math.min(a.x, b.x) - tol;

    case 'vertical-line':
      return Math.abs(p.x - a.x) <= tol;

    case 'cross-line':
      return Math.abs(p.x - a.x) <= tol || Math.abs(p.y - a.y) <= tol;

    case 'rectangle':
    case 'price-range':
    case 'date-range':
      return pts.length >= 2 && hitRect(p, a, b, filled, tol);

    case 'ellipse':
      return pts.length >= 2 && hitEllipse(p, a, b, filled, tol);

    case 'triangle':
      return pts.length >= 3 && hitPolygon(p, [a, b, c], filled, tol);

    case 'path':
    case 'brush':
      return hitPolyline(p, pts, tol);

    case 'parallel-channel':
      if (pts.length < 3) return pts.length >= 2 && distanceToSegment(p, a, b) <= tol;
      // Both rails: the second is the first offset by the third point.
      return (
        distanceToSegment(p, a, b) <= tol ||
        distanceToSegment(p, { x: a.x, y: a.y + (c.y - a.y) }, { x: b.x, y: b.y + (c.y - a.y) }) <=
          tol
      );

    case 'fib-retracement':
    case 'fib-extension':
      // Grabbable anywhere in the band the levels span, which is how a Fib
      // behaves on TradingView — the levels are the object, not the anchor.
      if (pts.length < 2) return false;
      return hitRect(p, { x: Math.min(a.x, b.x), y: a.y }, { x: bounds.width, y: b.y }, true, tol);

    case 'long-position':
    case 'short-position':
      if (pts.length < 2) return false;
      return hitRect(p, a, { x: b.x, y: (c ?? b).y }, true, tol);

    // ── Analytical families ────────────────────────────────────────────
    case 'pitchfork':
    case 'schiff-pitchfork':
    case 'modified-schiff-pitchfork':
    case 'inside-pitchfork':
    case 'fib-wedge':
    case 'disjoint-angle':
      // Grabbable along any of the legs the operator actually placed, rather
      // than along the derived median — the pivots are what they reason about.
      return hitPolyline(p, pts, tol);

    case 'gann-box':
    case 'gann-square':
    case 'flat-channel':
      return pts.length >= 2 && hitRect(p, a, b, true, tol);

    case 'gann-fan':
    case 'fib-speed-fan':
      // A fan is a sheaf of rays from one anchor; the outermost pair bounds it.
      return pts.length >= 2 && (distanceToRay(p, a, b) <= tol || hitRect(p, a, b, true, tol));

    case 'fib-circles':
      return pts.length >= 2 && hitEllipse(p, a, { x: 2 * a.x - b.x, y: 2 * a.y - b.y }, true, tol);

    case 'fib-arcs':
      return (
        pts.length >= 2 && Math.hypot(p.x - b.x, p.y - b.y) <= Math.hypot(b.x - a.x, b.y - a.y)
      );

    case 'fib-timezone':
      return pts.length >= 2 && Math.abs(p.x - a.x) <= tol * 2;

    case 'fib-channel':
    case 'regression-channel':
      return pts.length >= 2 && distanceToSegment(p, a, b) <= tol * 3;

    case 'elliott-impulse':
    case 'elliott-correction':
    case 'elliott-triangle':
    case 'three-drives':
    case 'head-and-shoulders':
    case 'polyline':
    case 'curve':
    case 'arc':
      return hitPolyline(p, pts, tol);

    case 'abcd-pattern':
    case 'xabcd-pattern':
    case 'triangle-pattern':
      return hitPolygon(p, pts, filled, tol);

    case 'fib-spiral':
    case 'time-cycles':
      // Radial shapes: grabbable within the first ring rather than by outline,
      // which on a spiral is a hairline the pointer can never find.
      return (
        pts.length >= 2 && Math.hypot(p.x - a.x, p.y - a.y) <= Math.hypot(b.x - a.x, b.y - a.y)
      );

    case 'fib-resistance-arcs':
      return (
        pts.length >= 2 && Math.hypot(p.x - b.x, p.y - b.y) <= Math.hypot(b.x - a.x, b.y - a.y)
      );

    case 'cyclic-lines':
      // Any of the repeated verticals, not just the first two.
      if (pts.length < 2) return false;
      {
        const step = b.x - a.x;
        if (step === 0) return Math.abs(p.x - a.x) <= tol;
        const index = Math.round((p.x - a.x) / step);
        return index >= 0 && index <= 12 && Math.abs(p.x - (a.x + step * index)) <= tol;
      }

    case 'sine-line':
    case 'arc-curve':
    case 'double-curve':
    case 'projection':
    case 'elliott-double-combo':
    case 'elliott-triple-combo':
    case 'elliott-minor':
    case 'elliott-intermediate':
    case 'head-and-shoulders-inverse':
    case 'highlighter':
      return hitPolyline(p, pts, tol * 2);

    case 'cypher-pattern':
    case 'five-point-pattern':
      return hitPolygon(p, pts, filled, tol);

    case 'bars-pattern':
    case 'ghost-feed':
    case 'gann-grid':
    case 'rotated-rectangle':
      return pts.length >= 2 && hitRect(p, a, b, true, tol);

    case 'gann-fan-fixed':
      return Math.hypot(p.x - a.x, p.y - a.y) <= 40;

    case 'pitchfan':
      return hitPolyline(p, pts, tol);

    case 'flag':
    case 'signpost':
    case 'price-label':
    case 'comment':
    case 'balloon':
    case 'sticker':
    case 'table':
    case 'idea':
    case 'anchored-note':
    case 'anchored-vwap':
      // Pinned markers draw a 26px stem with a label above it.
      return Math.abs(p.x - a.x) <= 30 && p.y <= a.y + tol && p.y >= a.y - 44;

    case 'text':
    case 'callout':
      // Approximate box around the anchor; the renderer keeps the same shape.
      return Math.abs(p.x - a.x) <= 60 && Math.abs(p.y - a.y) <= 14;

    default:
      return pts.length >= 2 ? distanceToSegment(p, a, b) <= tol : false;
  }
}

/** Fib level price for a ratio between two anchor prices. */
export function fibPrice(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

/**
 * Snap a price to the nearest OHLC value of the nearest bar (magnet mode).
 *
 * Magnet is what makes a trendline actually sit on the wick instead of one
 * pixel off it, which matters when the line is the basis for a trade.
 */
export function magnetPrice(
  price: number,
  bar: { open: number; high: number; low: number; close: number } | null,
  thresholdPrice: number,
): number {
  if (!bar) return price;
  const candidates = [bar.open, bar.high, bar.low, bar.close];
  let best = price;
  let bestDelta = thresholdPrice;
  for (const c of candidates) {
    const delta = Math.abs(c - price);
    if (delta <= bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best;
}

/** Bounding box of a drawing's points, for the object tree and selection. */
export function boundsOf(drawing: Drawing): { from: number; to: number } {
  const times = drawing.points.map((p) => p.time);
  return { from: Math.min(...times), to: Math.max(...times) };
}
