import { atr, volumeProfile, type Ohlc, type VolumeProfileBin } from '../indicators/math';

/**
 * Analytical overlays computed from the loaded bars: volume profile, auto-detected
 * support/resistance, and an ESTIMATED order-flow delta.
 *
 * <p>Pure functions, so the arithmetic that decides where a level is drawn can be tested
 * without a chart. Everything here is derived from OHLCV — nothing is fetched.</p>
 */

// ── Volume profile ───────────────────────────────────────────────────────────

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  /** Highest-volume bin: the price this window actually transacted at. */
  poc: number;
  /** Value area — the contiguous band around the POC holding `valueAreaPct` of volume. */
  valueAreaLow: number;
  valueAreaHigh: number;
  peak: number;
}

/**
 * Volume by price for a window of bars, with its POC and value area.
 *
 * <p>Delegates the bucketing to {@link volumeProfile} rather than re-deriving it. That
 * matters: this app briefly had TWO volume profiles that disagreed — the indicator spread
 * each bar's volume across its high-low range, while the drawing tool dumped it all at the
 * close — so drawing the tool and adding the study on the same chart produced two different
 * shapes. Spreading is the convention and the better answer; one implementation is the
 * point.</p>
 */
export function profileWithValueArea(
  bars: readonly Ohlc[],
  bins = 40,
  valueAreaPct = 0.7,
): VolumeProfileResult | null {
  const computed = volumeProfile(bars as Ohlc[], bins);
  if (computed.length === 0) return null;

  const total = computed.reduce((sum, b) => sum + b.volume, 0);
  if (total <= 0) return null;

  let pocIndex = 0;
  for (let i = 1; i < computed.length; i++) {
    if (computed[i].volume > computed[pocIndex].volume) pocIndex = i;
  }

  // Grow outward from the POC, always taking the fuller neighbour, until the band holds the
  // target share. This is the standard construction; taking a fixed number of bins either
  // side would centre the band on the POC rather than on where volume actually sits.
  let low = pocIndex;
  let high = pocIndex;
  let inside = computed[pocIndex].volume;
  const target = total * valueAreaPct;
  while (inside < target && (low > 0 || high < computed.length - 1)) {
    const below = low > 0 ? computed[low - 1].volume : -1;
    const above = high < computed.length - 1 ? computed[high + 1].volume : -1;
    if (above >= below) {
      high += 1;
      inside += computed[high].volume;
    } else {
      low -= 1;
      inside += computed[low].volume;
    }
  }

  return {
    bins: computed,
    poc: computed[pocIndex].price,
    valueAreaLow: computed[low].price,
    valueAreaHigh: computed[high].price,
    peak: computed[pocIndex].volume,
  };
}

// ── Support and resistance ───────────────────────────────────────────────────

export interface SrLevel {
  price: number;
  /** Relative to the latest close. A level price has crossed becomes the other kind. */
  kind: 'support' | 'resistance';
  /** How many swing pivots formed this level. */
  touches: number;
  /** 0..1, combining touch count and recency. Drives line weight. */
  strength: number;
  /** Time of the most recent touch. */
  lastMs: number;
}

export interface SrOptions {
  /** Half-width of the fractal window: a pivot is the extreme of `2*lookback+1` bars. */
  lookback?: number;
  /** Cluster tolerance as a multiple of ATR. */
  toleranceAtr?: number;
  /** Most levels to return, across both sides. */
  max?: number;
  /** Ignore levels formed by fewer than this many pivots. */
  minTouches?: number;
  /**
   * Minimum gap between REPORTED levels, as a multiple of ATR.
   *
   * <p>Separate from `toleranceAtr`, which decides what counts as one cluster. Without it
   * the output was four levels inside twenty pips — 1.15457, 1.15353, 1.15311, 1.15255 on
   * live EURUSD — which is chop rendered as structure. Each is a real cluster; reporting
   * all four is still wrong.</p>
   */
  separationAtr?: number;
}

/**
 * Support and resistance from swing pivots.
 *
 * <p>Three steps, each deliberately simple enough to argue with:</p>
 * <ol>
 *   <li>Find fractal pivots — a bar whose high is the highest of the `2*lookback+1` bars
 *       centred on it, and the same for lows.</li>
 *   <li>Cluster pivots that sit within `toleranceAtr × ATR` of each other. A tolerance in
 *       ATR rather than pips is what makes the same settings work on EURUSD and on a pair
 *       that moves five times as far.</li>
 *   <li>Score by touches and recency, and keep the strongest.</li>
 * </ol>
 *
 * <p>A pivot is only knowable `lookback` bars after it forms — that is inherent, not a bug,
 * and it is why the most recent bars never produce a level.</p>
 */
export function supportResistance(bars: readonly Ohlc[], opts: SrOptions = {}): SrLevel[] {
  const lookback = opts.lookback ?? 3;
  const toleranceAtr = opts.toleranceAtr ?? 0.5;
  const max = opts.max ?? 8;
  const minTouches = opts.minTouches ?? 2;

  if (bars.length < lookback * 2 + 3) return [];

  const atrSeries = atr(bars as Ohlc[], 14);
  const lastAtr = [...atrSeries].reverse().find((v) => v !== null && v > 0) ?? null;
  // Without a usable ATR there is no scale to cluster on, and a fixed tolerance would be
  // meaningless across instruments. Say nothing rather than guess.
  if (lastAtr === null) return [];
  const tolerance = lastAtr * toleranceAtr;
  if (tolerance <= 0) return [];

  const pivots: { price: number; time: number }[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isHigh = false;
      if (bars[k].low <= bars[i].low) isLow = false;
    }
    if (isHigh) pivots.push({ price: bars[i].high, time: bars[i].time });
    if (isLow) pivots.push({ price: bars[i].low, time: bars[i].time });
  }
  if (pivots.length === 0) return [];

  // Cluster by price. Sorting first makes this one pass instead of N².
  //
  // A pivot joins only if the cluster's TOTAL span stays within the tolerance — measured
  // against the cluster's lowest member, not against the last one added. Chaining off the
  // last member lets a dense region merge into one enormous cluster whose width is
  // unbounded: on 1500 EURUSD hourly bars that produced "levels" with 94 touches spanning
  // far more than the tolerance, which is not a level at all, it is the busiest half of the
  // range wearing a price tag.
  pivots.sort((a, b) => a.price - b.price);
  const clusters: { prices: number[]; lastMs: number }[] = [];
  for (const pivot of pivots) {
    const current = clusters[clusters.length - 1];
    if (current && pivot.price - current.prices[0] <= tolerance) {
      current.prices.push(pivot.price);
      current.lastMs = Math.max(current.lastMs, pivot.time);
    } else {
      clusters.push({ prices: [pivot.price], lastMs: pivot.time });
    }
  }

  const firstMs = bars[0].time;
  const lastMs = bars[bars.length - 1].time;
  const span = Math.max(1, lastMs - firstMs);
  const close = bars[bars.length - 1].close;
  const maxTouches = Math.max(...clusters.map((c) => c.prices.length));

  const scored: SrLevel[] = clusters
    .filter((c) => c.prices.length >= minTouches)
    .map((c) => {
      const price = c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
      const recency = (c.lastMs - firstMs) / span;
      // Touches carry more weight than recency: a level tested five times last month is
      // more real than one touched twice yesterday.
      const strength = Math.min(1, (c.prices.length / maxTouches) * 0.7 + recency * 0.3);
      return {
        price,
        kind: price >= close ? ('resistance' as const) : ('support' as const),
        touches: c.prices.length,
        strength,
        lastMs: c.lastMs,
      };
    })
    .sort((a, b) => b.strength - a.strength);

  const separation = lastAtr * (opts.separationAtr ?? 1.5);

  /** Strongest first, skipping anything too close to a level already taken. */
  const pick = (from: SrLevel[], limit: number, taken: SrLevel[]): SrLevel[] => {
    const out: SrLevel[] = [];
    for (const level of from) {
      if (out.length >= limit) break;
      const clash = [...taken, ...out].some((k) => Math.abs(k.price - level.price) < separation);
      if (!clash) out.push(level);
    }
    return out;
  };

  // Balanced: an S/R overlay showing seven resistances and no support is not telling the
  // operator where price might hold. Take the best of each side, then let the stronger side
  // use whatever the weaker one could not fill.
  const half = Math.max(1, Math.floor(max / 2));
  const above = scored.filter((l) => l.kind === 'resistance');
  const below = scored.filter((l) => l.kind === 'support');
  const resistances = pick(above, half, []);
  const supports = pick(below, half, resistances);
  const chosen = [...resistances, ...supports];
  if (chosen.length < max) {
    chosen.push(...pick(scored, max - chosen.length, chosen));
  }
  return chosen.sort((a, b) => b.price - a.price);
}

// ── Estimated order-flow delta ───────────────────────────────────────────────
//
// Lives in `indicators/math.ts` with the rest of the indicator maths — it is plotted as a
// study, not drawn on the price pane — and is re-exported here so the overlay surface has
// one import.
export { estimatedDelta, type DeltaBar } from '../indicators/math';
