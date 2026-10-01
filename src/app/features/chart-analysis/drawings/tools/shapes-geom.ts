import { distanceToSegment, pointInPolygon, type Pt } from '../geometry';

/**
 * Screen-space geometry shared by the "Geometric shapes" family (shapes*.ts).
 * Pure functions, unit-tested in shapes.spec.ts.
 */

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Unit normal (left-hand) of a→b; +y-down screen space. */
export function normalOf(a: Pt, b: Pt): Pt {
  const len = dist(a, b) || 1;
  return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
}

/** Signed perpendicular offset of `c` from the a→b axis, along `normalOf(a, b)`. */
export function perpOffset(a: Pt, b: Pt, c: Pt): number {
  return dot(sub(c, a), normalOf(a, b));
}

// ── Ellipse (TradingView: two clicks = one axis, third = the other radius) ──

export interface EllipseGeom {
  c: Pt;
  rx: number;
  ry: number;
  /** Rotation of the first axis, radians. */
  angle: number;
}

/** `a`,`b` are the ends of the first axis; `c` sets the second radius (its distance from that axis). */
export function ellipseFrom3(a: Pt, b: Pt, c: Pt): EllipseGeom {
  return {
    c: mid(a, b),
    rx: dist(a, b) / 2,
    ry: Math.abs(perpOffset(a, b, c)),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Axis-aligned ellipse inscribed in the box a–b (pre-TradingView-parity drawings). */
export function ellipseFromBox(a: Pt, b: Pt): EllipseGeom {
  return {
    c: mid(a, b),
    rx: Math.abs(b.x - a.x) / 2,
    ry: Math.abs(b.y - a.y) / 2,
    angle: 0,
  };
}

/** The four perimeter handles at the axis ends: [axis1 start, axis1 end, axis2 +, axis2 −]. */
export function ellipseHandles(e: EllipseGeom): Pt[] {
  const u = { x: Math.cos(e.angle), y: Math.sin(e.angle) };
  const n = { x: -u.y, y: u.x };
  return [
    add(e.c, mul(u, -e.rx)),
    add(e.c, mul(u, e.rx)),
    add(e.c, mul(n, e.ry)),
    add(e.c, mul(n, -e.ry)),
  ];
}

/** Normalised radial coordinate: 1 on the perimeter, <1 inside. */
export function ellipseNorm(e: EllipseGeom, p: Pt): number {
  const d = sub(p, e.c);
  const cos = Math.cos(-e.angle);
  const sin = Math.sin(-e.angle);
  const lx = d.x * cos - d.y * sin;
  const ly = d.x * sin + d.y * cos;
  const rx = Math.max(e.rx, 1e-6);
  const ry = Math.max(e.ry, 1e-6);
  return Math.sqrt((lx / rx) ** 2 + (ly / ry) ** 2);
}

export function hitEllipseGeom(e: EllipseGeom, p: Pt, filled: boolean, tol: number): boolean {
  const n = ellipseNorm(e, p);
  if (filled && n <= 1) return true;
  // Distance to the perimeter ≈ |n−1| × local radius; use the radius along the ray to p.
  const r = dist(p, e.c) / Math.max(n, 1e-6);
  return Math.abs(n - 1) * r <= tol;
}

// ── Rectangles ──────────────────────────────────────────────────────────────

/** Corners of the rotated rectangle with base a→b and width set by c: [a, b, b', a']. */
export function rotatedRectCorners(a: Pt, b: Pt, c: Pt): Pt[] {
  const n = normalOf(a, b);
  const off = perpOffset(a, b, c);
  return [a, b, add(b, mul(n, off)), add(a, mul(n, off))];
}

/** Rectangle handles: TL, TR, BR, BL corners then top, right, bottom, left edge midpoints. */
export function rectHandles(a: Pt, b: Pt): Pt[] {
  const l = Math.min(a.x, b.x);
  const r = Math.max(a.x, b.x);
  const t = Math.min(a.y, b.y);
  const bo = Math.max(a.y, b.y);
  const mx = (l + r) / 2;
  const my = (t + bo) / 2;
  return [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: bo },
    { x: l, y: bo },
    { x: mx, y: t },
    { x: r, y: my },
    { x: mx, y: bo },
    { x: l, y: my },
  ];
}

export function hitPolygonOutline(p: Pt, pts: Pt[], closed: boolean, filled: boolean, tol: number): boolean {
  const n = pts.length;
  if (n === 0) return false;
  if (n === 1) return dist(p, pts[0]) <= tol;
  for (let i = 0; i + 1 < n; i++) if (distanceToSegment(p, pts[i], pts[i + 1]) <= tol) return true;
  if (closed && distanceToSegment(p, pts[n - 1], pts[0]) <= tol) return true;
  return filled && n >= 3 && pointInPolygon(p, pts);
}

// ── Curves ──────────────────────────────────────────────────────────────────

export function quadAt(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

export function sample(f: (t: number) => Pt, steps = 48): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(f(i / steps));
  return out;
}

/** Circle through three points, or null when collinear. */
export function circleThrough(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
}

/** Points along the circular arc from a through m to b. */
export function arcThrough(a: Pt, m: Pt, b: Pt, steps = 64): Pt[] {
  const circ = circleThrough(a, m, b);
  if (!circ) return [a, b];
  const ang = (p: Pt) => Math.atan2(p.y - circ.c.y, p.x - circ.c.x);
  const a0 = ang(a);
  let a1 = ang(b);
  const am = ang(m);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Sweep counter-clockwise from a0; if m is not on that sweep, go the other way.
  let sweep = norm(a1 - a0);
  if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
  a1 = a0 + sweep;
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    out.push({ x: circ.c.x + circ.r * Math.cos(t), y: circ.c.y + circ.r * Math.sin(t) });
  }
  return out;
}

/**
 * TradingView "Arc": chord a→b, the third point sets how far the half-ellipse bulges
 * (its signed distance from the chord). Returns the outline from a to b.
 */
export function arcOutline(a: Pt, b: Pt, c: Pt, steps = 64): Pt[] {
  const m = mid(a, b);
  const u = mul(sub(b, a), 0.5);
  const n = normalOf(a, b);
  const h = perpOffset(a, b, c);
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI - (Math.PI * i) / steps; // a (π) → b (0)
    out.push(add(add(m, mul(u, Math.cos(t))), mul(n, h * Math.sin(t))));
  }
  return out;
}

/** Moving-average smoothing of a freehand stroke (TradingView brush "smooth", 0–20). */
export function smoothStroke(pts: Pt[], amount: number): Pt[] {
  const k = Math.max(0, Math.round(amount));
  if (k === 0 || pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) {
      sx += pts[j].x;
      sy += pts[j].y;
      n++;
    }
    out.push({ x: sx / n, y: sy / n });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Drop consecutive points closer than `eps` px (double-click finishing adds duplicates). */
export function dedupe(pts: Pt[], eps = 0.5): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > eps) out.push(p);
  return out;
}
