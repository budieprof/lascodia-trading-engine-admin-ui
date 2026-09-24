/**
 * Min/max of a value series over a slot range in O(range / block + block).
 *
 * Autoscale asks every layer for its range on every frame of a pan or zoom; a linear scan of the
 * visible window across dozens of plots is fine at 200 visible bars and noticeable at 20,000
 * (zoomed all the way out), so each series keeps per-block extremes. NaN (na) is ignored.
 */
export class BlockMinMax {
  private readonly blockMin: Float64Array;
  private readonly blockMax: Float64Array;

  constructor(
    private readonly lows: Float64Array,
    private readonly highs: Float64Array = lows,
    private readonly block = 64,
  ) {
    const blocks = Math.ceil(lows.length / block);
    this.blockMin = new Float64Array(blocks).fill(NaN);
    this.blockMax = new Float64Array(blocks).fill(NaN);
    for (let b = 0; b < blocks; b++) {
      let mn = Infinity;
      let mx = -Infinity;
      const end = Math.min(lows.length, (b + 1) * block);
      for (let i = b * block; i < end; i++) {
        const lo = lows[i];
        const hi = highs[i];
        if (lo === lo && lo < mn) mn = lo; // lo === lo: not NaN
        if (hi === hi && hi > mx) mx = hi;
      }
      if (mn !== Infinity) this.blockMin[b] = mn;
      if (mx !== -Infinity) this.blockMax[b] = mx;
    }
  }

  get length(): number {
    return this.lows.length;
  }

  /** Extremes over slots [from, to] (inclusive, clamped), or null when all na. */
  range(from: number, to: number): { min: number; max: number } | null {
    const n = this.lows.length;
    let a = Math.max(0, Math.floor(from));
    const z = Math.min(n - 1, Math.ceil(to));
    if (n === 0 || a > z) return null;
    let mn = Infinity;
    let mx = -Infinity;
    const scan = (s: number, e: number) => {
      for (let i = s; i <= e; i++) {
        const lo = this.lows[i];
        const hi = this.highs[i];
        if (lo === lo && lo < mn) mn = lo;
        if (hi === hi && hi > mx) mx = hi;
      }
    };
    const bs = this.block;
    // Leading partial block.
    const firstFull = Math.ceil(a / bs);
    const lastFullExclusive = Math.floor((z + 1) / bs);
    if (firstFull >= lastFullExclusive) {
      scan(a, z);
    } else {
      if (a < firstFull * bs) scan(a, firstFull * bs - 1);
      for (let b = firstFull; b < lastFullExclusive; b++) {
        const bmn = this.blockMin[b];
        const bmx = this.blockMax[b];
        if (bmn === bmn && bmn < mn) mn = bmn;
        if (bmx === bmx && bmx > mx) mx = bmx;
      }
      a = lastFullExclusive * bs;
      if (a <= z) scan(a, z);
    }
    return mn === Infinity || mx === -Infinity ? null : { min: mn, max: mx };
  }
}
