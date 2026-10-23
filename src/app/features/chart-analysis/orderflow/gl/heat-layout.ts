import type { HeatQuad } from './heat-gl';
import type { HeatTextureSpec, TimeSegment } from './heat-texture';

/** Price slabs per quad column: the price axis is drawn piecewise linear, so a log scale stays right to < 1 px. */
export const PRICE_SLABS = 16;

/**
 * The quads that put a grid on the chart: one per (linear time run × price slab). `xAt` = UTC ms → x (media px),
 * `yAt` = price → y. Runs are clipped to the grid; quads entirely off the pane are left out.
 */
export function heatQuads(
  spec: HeatTextureSpec,
  segments: readonly TimeSegment[],
  xAt: (utcMs: number) => number | null,
  yAt: (price: number) => number | null,
  width: number,
  height: number,
): HeatQuad[] {
  const end = spec.t0 + spec.cols * spec.colMs;
  const ys: { r: number; y: number }[] = [];
  for (let k = 0; k <= PRICE_SLABS; k++) {
    const r = (k * spec.rows) / PRICE_SLABS;
    // Row coordinate r is the lower edge of row r: price p0 + (r − ½)·step.
    const y = yAt(spec.p0 + (r - 0.5) * spec.rowStep);
    if (y === null || !Number.isFinite(y)) return [];
    ys.push({ r, y });
  }
  const out: HeatQuad[] = [];
  for (const s of segments) {
    const a = Math.max(s.t0, spec.t0);
    const b = Math.min(s.t1, end);
    if (!(b > a)) continue;
    const x0 = xAt(a);
    const x1 = xAt(b);
    if (x0 === null || x1 === null || x1 < 0 || x0 > width || !(x1 > x0)) continue;
    const c0 = (a - spec.t0) / spec.colMs;
    const c1 = (b - spec.t0) / spec.colMs;
    for (let k = 0; k < PRICE_SLABS; k++) {
      const lo = ys[k];
      const hi = ys[k + 1];
      if (Math.max(lo.y, hi.y) < 0 || Math.min(lo.y, hi.y) > height) continue;
      out.push({ x0, x1, c0, c1, y0: lo.y, y1: hi.y, r0: lo.r, r1: hi.r });
    }
  }
  return out;
}

/** The instant under screen x (inverse of `xAt` within a linear run); null off every run. */
export function timeAtX(
  segments: readonly TimeSegment[],
  xAt: (utcMs: number) => number | null,
  x: number,
): number | null {
  for (const s of segments) {
    const x0 = xAt(s.t0);
    const x1 = xAt(s.t1);
    if (x0 === null || x1 === null || !(x1 > x0)) continue;
    if (x >= x0 && x < x1) return s.t0 + ((x - x0) / (x1 - x0)) * (s.t1 - s.t0);
  }
  return null;
}
