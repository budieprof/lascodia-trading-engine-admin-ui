import type { Pt } from '../geometry';

/**
 * Pure screen-space maths for the TradingView "Trend line tools" family.
 *
 * Everything here takes projected points and returns projected points, so it
 * is unit-testable without a canvas or a chart. `trend.ts` paints with it and
 * `moveHandle` uses it after projecting the stored anchors.
 */

export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const add = (a: Pt, d: Pt): Pt => ({ x: a.x + d.x, y: a.y + d.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

/** y of the (infinite) line a→b at x. Vertical lines return a.y. */
export function yOnLine(a: Pt, b: Pt, x: number): number {
  if (b.x === a.x) return a.y;
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/**
 * The visible segment for a line through a→b with optional extension past
 * either end. Extensions run far past the canvas so the line reads as infinite
 * (the canvas clips). Returns [start, end] in drawing order.
 */
export function extendSegment(
  a: Pt,
  b: Pt,
  left: boolean,
  right: boolean,
  w: number,
  h: number,
): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [a, b];
  const k = ((Math.abs(w) + Math.abs(h)) * 4) / len;
  // "Left/right" on TradingView is in chart terms (time), not anchor order.
  const aIsLeft = a.x <= b.x;
  const extA = aIsLeft ? left : right;
  const extB = aIsLeft ? right : left;
  return [
    extA ? { x: a.x - dx * k, y: a.y - dy * k } : a,
    extB ? { x: b.x + dx * k, y: b.y + dy * k } : b,
  ];
}

/** Screen angle of a→b in degrees, counter-clockwise positive (up = positive), as TV prints it. */
export function screenAngle(a: Pt, b: Pt): number {
  return (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
}

export interface Regression {
  slope: number;
  intercept: number;
  /** Standard deviation of the closes about the fitted line. */
  stdev: number;
  /** Pearson's correlation coefficient of (index, value). */
  pearson: number;
}

/**
 * Least-squares fit of `values` against their index 0..n-1 — what TV's
 * Regression Trend computes over the bars between its two anchors.
 */
export function linearRegression(values: readonly number[]): Regression | null {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    const dy = values[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = values[i] - (intercept + slope * i);
    ss += r * r;
  }
  return {
    slope,
    intercept,
    stdev: Math.sqrt(ss / n),
    pearson: syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy),
  };
}

export type PitchforkVariant = 'pitchfork' | 'schiff-pitchfork' | 'modified-schiff-pitchfork' | 'inside-pitchfork';

/**
 * Origin ("handle") of the median line.
 *
 *   Andrews          P1
 *   Schiff           P1's time, halfway between P1 and P2 in price
 *   Modified Schiff  midpoint of P1 and P2 (half the time AND half the price)
 *   Inside           midpoint of P1 and P2, with rails drawn back to it
 */
export function pitchforkOrigin(variant: PitchforkVariant, p1: Pt, p2: Pt): Pt {
  switch (variant) {
    case 'schiff-pitchfork':
      return { x: p1.x, y: (p1.y + p2.y) / 2 };
    case 'modified-schiff-pitchfork':
    case 'inside-pitchfork':
      return mid(p1, p2);
    default:
      return p1;
  }
}

export interface PitchforkGeometry {
  origin: Pt;
  /** Midpoint of P2–P3: where the median crosses the tines. */
  center: Pt;
  /** Unit-length-agnostic direction of the median (origin → center). */
  dir: Pt;
}

export function pitchforkGeometry(variant: PitchforkVariant, p1: Pt, p2: Pt, p3: Pt): PitchforkGeometry {
  const origin = pitchforkOrigin(variant, p1, p2);
  const center = mid(p2, p3);
  return { origin, center, dir: sub(center, origin) };
}

/**
 * Start points of the two lines for level `r`: on the P2–P3 tine segment,
 * `r` times the half-width either side of the centre (r = 1 hits P2 and P3).
 */
export function pitchforkLevelStarts(g: PitchforkGeometry, p2: Pt, p3: Pt, r: number): [Pt, Pt] {
  return [
    { x: g.center.x + (p2.x - g.center.x) * r, y: g.center.y + (p2.y - g.center.y) * r },
    { x: g.center.x + (p3.x - g.center.x) * r, y: g.center.y + (p3.y - g.center.y) * r },
  ];
}

/**
 * Parallel channel in screen space. Anchors are [P1, P2, P3]; the second rail
 * is the P1→P2 line shifted VERTICALLY so it passes through P3 (TV channels
 * keep price offset, not perpendicular distance).
 */
export function channelOffset(p1: Pt, p2: Pt, p3: Pt): number {
  return p3.y - yOnLine(p1, p2, p3.x);
}

/**
 * Disjoint channel: the second line starts at P3 (at P1's x) and mirrors the
 * slope of P1→P2, so the two lines converge or diverge symmetrically.
 */
export function disjointSecond(p1: Pt, p2: Pt, p3: Pt): [Pt, Pt] {
  const q1 = { x: p1.x, y: p3.y };
  return [q1, { x: p2.x, y: p3.y - (p2.y - p1.y) }];
}

/** "1d 4h" / "15h" / "30m" — TradingView's compact span format. */
export function formatSpan(ms: number): string {
  let m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}
