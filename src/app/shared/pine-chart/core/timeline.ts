/**
 * The chart's horizontal axis in the three coordinates the renderer juggles:
 *
 * - **logical index** — position on the chart, 0 = the first bar the chart holds. Lightweight Charts
 *   lays its time scale out by index, so every drawing is placed by logical index and converted to
 *   pixels with `timeScale().logicalToCoordinate()`, which extrapolates past both ends.
 * - **bar_index** — Pine's bar number: `logical + firstBarIndex`.
 * - **time** — bar open time, Unix ms. Past the data it is extrapolated by the chart timeframe, the
 *   same way the engine resolves drawing coordinates (`OutputX`), so a future label and a future plot
 *   point agree on where "10 bars from now" is.
 */
export class BarTimeline {
  readonly times: Float64Array;

  constructor(
    times: ArrayLike<number>,
    /** bar_index of `times[0]`. */
    readonly firstBarIndex: number,
    /** Bar duration used to extrapolate times beyond the data. */
    readonly stepMs: number,
  ) {
    this.times = Float64Array.from(times as ArrayLike<number>);
  }

  get length(): number {
    return this.times.length;
  }

  /** bar_index of the last bar, or `firstBarIndex - 1` when empty. */
  get lastBarIndex(): number {
    return this.firstBarIndex + this.times.length - 1;
  }

  logicalOfBarIndex(barIndex: number): number {
    return barIndex - this.firstBarIndex;
  }

  barIndexOfLogical(logical: number): number {
    return Math.round(logical) + this.firstBarIndex;
  }

  /** Bar time at a (possibly fractional, possibly out-of-range) logical index. */
  timeOfLogical(logical: number): number {
    const n = this.times.length;
    if (n === 0) return NaN;
    const lo = Math.floor(logical);
    const frac = logical - lo;
    const t0 = this.timeOfIndex(lo);
    if (frac === 0) return t0;
    return t0 + (this.timeOfIndex(lo + 1) - t0) * frac;
  }

  private timeOfIndex(i: number): number {
    const n = this.times.length;
    if (i >= 0 && i < n) return this.times[i];
    if (i >= n) return this.times[n - 1] + (i - n + 1) * this.stepMs;
    return this.times[0] + i * this.stepMs;
  }

  /**
   * Logical index of a time: exact for a bar's open time, fractional between two bars, extrapolated
   * by the step outside the data. NaN when the timeline is empty.
   */
  logicalOfTime(t: number): number {
    const n = this.times.length;
    if (n === 0 || !Number.isFinite(t)) return NaN;
    const first = this.times[0];
    const last = this.times[n - 1];
    if (t >= last) return n - 1 + (t - last) / this.stepMs;
    if (t <= first) return (t - first) / this.stepMs;
    const i = this.floorIndex(t);
    const t0 = this.times[i];
    const t1 = this.times[i + 1];
    return t1 > t0 ? i + (t - t0) / (t1 - t0) : i;
  }

  /**
   * Index of the first bar opening exactly at `t`, or -1. Renko / Kagi / Point & Figure bricks can
   * share an open time, so this is the first of them, not any.
   */
  indexOfTime(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.times.length && this.times[lo] === t ? lo : -1;
  }

  /** Largest index whose time is <= t (-1 when t precedes the first bar). */
  floorIndex(t: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    if (hi < 0 || t < this.times[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * Duration of a timeframe in ms. Accepts Pine spellings ("1", "60", "240", "1D", "D", "1W", "1M",
 * "15S") and the engine's ("M1", "M15", "H1", "H4", "D1", "W1", "MN1"). Null when unrecognised.
 */
export function timeframeMs(timeframe: string | null | undefined): number | null {
  if (!timeframe) return null;
  const tf = timeframe.trim().toUpperCase();
  const MIN = 60_000;
  const DAY = 86_400_000;
  let m = /^(\d+)$/.exec(tf);
  if (m) return +m[1] * MIN;
  m = /^(\d*)([SDWM])$/.exec(tf);
  if (m) {
    const n = m[1] === '' ? 1 : +m[1];
    switch (m[2]) {
      case 'S':
        return n * 1000;
      case 'D':
        return n * DAY;
      case 'W':
        return n * 7 * DAY;
      default:
        return n * 30 * DAY;
    }
  }
  m = /^(M|H|D|W|MN)(\d+)$/.exec(tf);
  if (m) {
    const n = +m[2];
    switch (m[1]) {
      case 'M':
        return n * MIN;
      case 'H':
        return n * 60 * MIN;
      case 'D':
        return n * DAY;
      case 'W':
        return n * 7 * DAY;
      default:
        return n * 30 * DAY;
    }
  }
  return null;
}

/** The most common gap between consecutive times (robust to weekend gaps), or null with < 2 times. */
export function typicalStepMs(times: ArrayLike<number>): number | null {
  const n = times.length;
  if (n < 2) return null;
  const counts = new Map<number, number>();
  const limit = Math.min(n - 1, 500);
  for (let i = n - limit; i < n; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && d < best)) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}
