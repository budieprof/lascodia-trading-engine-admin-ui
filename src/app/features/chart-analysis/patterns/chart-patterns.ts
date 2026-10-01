import type { Ohlc } from '../indicators/math';

/**
 * Chart-pattern recognition on swing pivots — pure functions over ASCENDING bars.
 *
 * <p>Pivots are fractal swing points (a high above `pivotDepth` bars on each side) collapsed
 * into an alternating zig-zag, so every detector reads a clean high/low/high… sequence.
 * Every geometric test is SCALE-FREE: `tolerance` is a fraction of the pattern's own height,
 * so the same settings work on EURUSD and on an index.</p>
 *
 * <p>Each detector is written once for its "up" orientation and run a second time over the
 * price-mirrored series (p → −p, highs ↔ lows) to get its mirror: double top ↔ double
 * bottom, ascending ↔ descending triangle, bull ↔ bear flag, rising ↔ falling wedge, …
 * One rule set means the two halves of a pair can never drift apart.</p>
 */

export type PatternDirection = 'bullish' | 'bearish' | 'neutral';
export type PatternStatus = 'forming' | 'confirmed';
export type ChartPatternGroup = 'reversal' | 'continuation' | 'bilateral' | 'wave' | 'harmonic';

export interface PatternPoint {
  index: number;
  price: number;
  /** Optional point label (Elliott wave numbers, harmonic X/A/B/C/D). */
  label?: string;
}

export interface ChartPatternMeta {
  id: string;
  name: string;
  /** Neutral for families whose direction is decided per hit (harmonics, Elliott, sym/rect). */
  direction: PatternDirection;
  group: ChartPatternGroup;
}

export interface ChartPatternHit {
  id: string;
  name: string;
  direction: PatternDirection;
  /** The pattern's defining pivots, in time order. */
  points: PatternPoint[];
  /** Outline polylines to draw (zig-zag, trendlines, cup curve, …). */
  lines: PatternPoint[][];
  /** Breakout / neckline level. */
  breakout?: number;
  /** Measured-move target. */
  target?: number;
  status: PatternStatus;
  /** Bar index where price closed through the breakout, when confirmed. */
  confirmedIndex?: number;
  startIndex: number;
  endIndex: number;
}

export interface ChartPatternOptions {
  ids?: string[];
  /** Bars each side a swing must dominate. Default 5. */
  pivotDepth?: number;
  /** Geometric tolerance as a fraction of pattern height. Default 0.1. */
  tolerance?: number;
  /** Absolute slack on harmonic Fibonacci ratios. Default 0.05. */
  fibTolerance?: number;
  /** Keep at most this many (most recent) hits per pattern type. Default 3. */
  maxPerType?: number;
}

export interface Pivot {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

export const CHART_PATTERNS: readonly ChartPatternMeta[] = [
  { id: 'double-top', name: 'Double Top', direction: 'bearish', group: 'reversal' },
  { id: 'double-bottom', name: 'Double Bottom', direction: 'bullish', group: 'reversal' },
  { id: 'head-and-shoulders', name: 'Head and Shoulders', direction: 'bearish', group: 'reversal' },
  { id: 'inverse-head-and-shoulders', name: 'Inverse Head and Shoulders', direction: 'bullish', group: 'reversal' },
  { id: 'ascending-triangle', name: 'Ascending Triangle', direction: 'bullish', group: 'continuation' },
  { id: 'descending-triangle', name: 'Descending Triangle', direction: 'bearish', group: 'continuation' },
  { id: 'symmetric-triangle', name: 'Symmetric Triangle', direction: 'neutral', group: 'bilateral' },
  { id: 'rectangle', name: 'Rectangle', direction: 'neutral', group: 'bilateral' },
  { id: 'bull-flag', name: 'Bull Flag', direction: 'bullish', group: 'continuation' },
  { id: 'bear-flag', name: 'Bear Flag', direction: 'bearish', group: 'continuation' },
  { id: 'bull-pennant', name: 'Bull Pennant', direction: 'bullish', group: 'continuation' },
  { id: 'bear-pennant', name: 'Bear Pennant', direction: 'bearish', group: 'continuation' },
  { id: 'rising-wedge', name: 'Rising Wedge', direction: 'bearish', group: 'reversal' },
  { id: 'falling-wedge', name: 'Falling Wedge', direction: 'bullish', group: 'reversal' },
  { id: 'cup-and-handle', name: 'Cup and Handle', direction: 'bullish', group: 'continuation' },
  { id: 'inverted-cup-and-handle', name: 'Inverted Cup and Handle', direction: 'bearish', group: 'continuation' },
  { id: 'elliott-impulse', name: 'Elliott Impulse Wave', direction: 'neutral', group: 'wave' },
  { id: 'abcd', name: 'ABCD', direction: 'neutral', group: 'harmonic' },
  { id: 'gartley', name: 'Gartley', direction: 'neutral', group: 'harmonic' },
  { id: 'bat', name: 'Bat', direction: 'neutral', group: 'harmonic' },
  { id: 'butterfly', name: 'Butterfly', direction: 'neutral', group: 'harmonic' },
  { id: 'crab', name: 'Crab', direction: 'neutral', group: 'harmonic' },
  { id: 'cypher', name: 'Cypher', direction: 'neutral', group: 'harmonic' },
];

const META = new Map(CHART_PATTERNS.map((m) => [m.id, m]));

/**
 * Fractal swing pivots collapsed into an alternating zig-zag. A bar is a pivot high when its
 * high is strictly above the `depth` bars before it and at least as high as the `depth`
 * after it (so a flat double-print top yields one pivot, not two or none).
 */
export function findPivots(bars: readonly Ohlc[], depth: number): Pivot[] {
  const d = Math.max(1, Math.floor(depth));
  const raw: Pivot[] = [];
  for (let i = d; i < bars.length - d; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - d; j <= i + d && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (j < i ? bars[j].high >= bars[i].high : bars[j].high > bars[i].high) isHigh = false;
      if (j < i ? bars[j].low <= bars[i].low : bars[j].low < bars[i].low) isLow = false;
    }
    const prev = raw.length ? raw[raw.length - 1].kind : null;
    const hi: Pivot = { index: i, price: bars[i].high, kind: 'high' };
    const lo: Pivot = { index: i, price: bars[i].low, kind: 'low' };
    if (isHigh && isLow) raw.push(...(prev === 'high' ? [lo, hi] : [hi, lo]));
    else if (isHigh) raw.push(hi);
    else if (isLow) raw.push(lo);
  }
  const zz: Pivot[] = [];
  for (const p of raw) {
    const last = zz[zz.length - 1];
    if (last && last.kind === p.kind) {
      const better = p.kind === 'high' ? p.price > last.price : p.price < last.price;
      if (better) zz[zz.length - 1] = p;
    } else zz.push(p);
  }
  return zz;
}

// ── oriented price space ────────────────────────────────────────────────────

/** Bars and pivots in an oriented space: s = 1 is real prices, s = −1 the mirror. */
interface Space {
  h: number[];
  l: number[];
  c: number[];
  piv: Pivot[];
  n: number;
  tol: number;
  ft: number;
  depth: number;
}

interface Raw {
  id: string;
  /** Direction override for families whose direction is per hit. */
  direction?: PatternDirection;
  points: PatternPoint[];
  lines: PatternPoint[][];
  breakout?: number;
  target?: number;
  confirmedIndex?: number;
}

function orient(bars: readonly Ohlc[], piv: Pivot[], s: 1 | -1, o: Required<Omit<ChartPatternOptions, 'ids'>>): Space {
  return {
    h: bars.map((b) => (s === 1 ? b.high : -b.low)),
    l: bars.map((b) => (s === 1 ? b.low : -b.high)),
    c: bars.map((b) => s * b.close),
    piv: piv.map((p) => ({ index: p.index, price: s * p.price, kind: s === 1 ? p.kind : p.kind === 'high' ? 'low' : 'high' })),
    n: bars.length,
    tol: o.tolerance,
    ft: o.fibTolerance,
    depth: o.pivotDepth,
  };
}

interface Line {
  at: (x: number) => number;
}
const lineThrough = (a: PatternPoint, b: PatternPoint): Line => {
  const slope = b.index === a.index ? 0 : (b.price - a.price) / (b.index - a.index);
  return { at: (x) => a.price + slope * (x - a.index) };
};
const pt = (p: Pivot, label?: string): PatternPoint => (label ? { index: p.index, price: p.price, label } : { index: p.index, price: p.price });
const kinds = (piv: Pivot[], k: number, seq: string): boolean => {
  if (k + seq.length > piv.length) return false;
  for (let j = 0; j < seq.length; j++) if (piv[k + j].kind !== (seq[j] === 'H' ? 'high' : 'low')) return false;
  return true;
};
const maxIn = (a: number[], from: number, to: number) => {
  let m = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(a.length - 1, to); i++) m = Math.max(m, a[i]);
  return m;
};
/** First bar in (from, to] where `pred` holds, or −1. */
const firstWhere = (n: number, from: number, to: number, pred: (i: number) => boolean) => {
  for (let i = from + 1; i <= Math.min(n - 1, to); i++) if (pred(i)) return i;
  return -1;
};
const within = (r: number, lo: number, hi: number, ft: number) => r >= lo - ft && r <= hi + ft;

// ── detectors (written for the "up" orientation) ────────────────────────────

type Scanner = (S: Space, s: 1 | -1) => Raw[];

/** Double top (s=1) / double bottom (s=−1): H L H with matching peaks. */
const doubleTop: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k < p.length; k++) {
    if (!kinds(p, k, 'HLH')) continue;
    const [a, b, c] = [p[k], p[k + 1], p[k + 2]];
    const top = Math.max(a.price, c.price);
    const h = top - b.price;
    if (h <= 0 || Math.abs(a.price - c.price) > S.tol * h) continue;
    if (k > 0 && p[k - 1].price >= b.price) continue; // needs a move INTO the top
    if (maxIn(S.h, a.index, c.index) > top + S.tol * h) continue;
    // Price trading back above the peaks before the neckline breaks voids the pattern.
    const fail = firstWhere(S.n, c.index, S.n, (i) => S.h[i] > top + S.tol * h);
    const conf = firstWhere(S.n, c.index, fail < 0 ? S.n : fail, (i) => S.c[i] < b.price);
    if (fail >= 0 && conf < 0) continue;
    const outline = [pt(a), pt(b), pt(c)];
    if (conf >= 0) outline.push({ index: conf, price: b.price });
    out.push({
      id: s === 1 ? 'double-top' : 'double-bottom',
      points: [pt(a), pt(b), pt(c)],
      lines: [outline],
      breakout: b.price,
      target: b.price - h,
      confirmedIndex: conf >= 0 ? conf : undefined,
    });
  }
  return out;
};

/** Head & shoulders (s=1) / inverse (s=−1). */
const headShoulders: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k < p.length; k++) {
    if (!kinds(p, k, 'HLHLH')) continue;
    const [ls, n1, hd, n2, rs] = p.slice(k, k + 5);
    const neck = lineThrough(n1, n2);
    const h = hd.price - neck.at(hd.index);
    if (h <= 0) continue;
    if (hd.price - Math.max(ls.price, rs.price) < S.tol * h) continue;
    if (Math.abs(ls.price - rs.price) > 2 * S.tol * h) continue;
    if (ls.price <= neck.at(ls.index) || rs.price <= neck.at(rs.index)) continue;
    if (Math.abs(n1.price - n2.price) > 0.5 * h) continue;
    if (k > 0 && p[k - 1].price >= Math.min(n1.price, n2.price)) continue;
    if (maxIn(S.h, ls.index, rs.index) > hd.price + S.tol * h) continue;
    const fail = firstWhere(S.n, rs.index, S.n, (i) => S.h[i] > hd.price);
    const conf = firstWhere(S.n, rs.index, fail < 0 ? S.n : fail, (i) => S.c[i] < neck.at(i));
    if (fail >= 0 && conf < 0) continue;
    const brk = neck.at(conf >= 0 ? conf : rs.index);
    const end = conf >= 0 ? conf : rs.index;
    out.push({
      id: s === 1 ? 'head-and-shoulders' : 'inverse-head-and-shoulders',
      points: [pt(ls, 'LS'), pt(n1), pt(hd, 'H'), pt(n2), pt(rs, 'RS')],
      lines: [
        [pt(ls), pt(n1), pt(hd), pt(n2), pt(rs)],
        [{ index: n1.index, price: neck.at(n1.index) }, { index: end, price: neck.at(end) }],
      ],
      breakout: brk,
      target: brk - h,
      confirmedIndex: conf >= 0 ? conf : undefined,
    });
  }
  return out;
};

/**
 * Five-pivot converging / parallel ranges: triangles, rectangle, wedges. In the mirror run
 * only the asymmetric shapes are emitted — a mirrored symmetric triangle or rectangle is the
 * same pattern again.
 */
const ranges: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k + 5 <= p.length; k++) {
    const w = p.slice(k, k + 5);
    const highs = w.filter((q) => q.kind === 'high');
    const lows = w.filter((q) => q.kind === 'low');
    const up = lineThrough(highs[0], highs[highs.length - 1]);
    const lo = lineThrough(lows[0], lows[lows.length - 1]);
    const x0 = w[0].index;
    const x1 = w[4].index;
    const h = up.at(x0) - lo.at(x0);
    if (h <= 0) continue;
    const T = S.tol * h;
    if (highs.some((q) => Math.abs(q.price - up.at(q.index)) > T)) continue;
    if (lows.some((q) => Math.abs(q.price - lo.at(q.index)) > T)) continue;
    if (up.at(x1) <= lo.at(x1)) continue;
    let contained = true;
    for (let i = x0; i <= x1 && contained; i++) if (S.h[i] > up.at(i) + T || S.l[i] < lo.at(i) - T) contained = false;
    if (!contained) continue;
    const du = up.at(x1) - up.at(x0);
    const dl = lo.at(x1) - lo.at(x0);
    const flat = (d: number) => Math.abs(d) <= T;
    let kind: 'asc' | 'sym' | 'rect' | 'rwedge' | null = null;
    if (flat(du) && dl > T) kind = 'asc';
    else if (du < -T && dl > T) kind = 'sym';
    else if (flat(du) && flat(dl)) kind = 'rect';
    else if (du > T && dl > T && dl > du) kind = 'rwedge';
    if (!kind || (s === -1 && (kind === 'sym' || kind === 'rect'))) continue;

    const span = x1 - x0;
    const upBreak = firstWhere(S.n, x1, x1 + span, (i) => S.c[i] > up.at(i));
    const dnBreak = firstWhere(S.n, x1, x1 + span, (i) => S.c[i] < lo.at(i));
    let raw: Raw;
    const lines = [w.map((q) => pt(q)), [pt({ ...highs[0] }), { index: x1, price: up.at(x1) }], [pt({ ...lows[0] }), { index: x1, price: lo.at(x1) }]];
    if (kind === 'asc') {
      const id = s === 1 ? 'ascending-triangle' : 'descending-triangle';
      const b = up.at(upBreak >= 0 ? upBreak : x1);
      raw = { id, points: w.map((q) => pt(q)), lines, breakout: b, target: b + h, confirmedIndex: upBreak >= 0 ? upBreak : undefined };
    } else if (kind === 'rwedge') {
      const id = s === 1 ? 'rising-wedge' : 'falling-wedge';
      const b = lo.at(dnBreak >= 0 ? dnBreak : x1);
      raw = { id, points: w.map((q) => pt(q)), lines, breakout: b, target: b - h, confirmedIndex: dnBreak >= 0 ? dnBreak : undefined };
    } else {
      const id = kind === 'sym' ? 'symmetric-triangle' : 'rectangle';
      raw = { id, points: w.map((q) => pt(q)), lines };
      const first = upBreak >= 0 && (dnBreak < 0 || upBreak < dnBreak) ? 'up' : dnBreak >= 0 ? 'down' : null;
      if (first === 'up') {
        raw.breakout = up.at(upBreak);
        raw.target = raw.breakout + h;
        raw.confirmedIndex = upBreak;
        raw.direction = 'bullish';
      } else if (first === 'down') {
        raw.breakout = lo.at(dnBreak);
        raw.target = raw.breakout - h;
        raw.confirmedIndex = dnBreak;
        raw.direction = 'bearish';
      }
    }
    out.push(raw);
  }
  return out;
};

/** Bull flag / pennant (s=1) and bear flag / pennant (s=−1): pole L→H, then H L H L consolidation. */
const flags: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k < p.length; k++) {
    if (!kinds(p, k, 'LHLHL')) continue;
    const [p0, p1, p2, p3, p4] = p.slice(k, k + 5);
    const pole = p1.price - p0.price;
    if (pole <= 0) continue;
    const up = lineThrough(p1, p3);
    const lo = lineThrough(p2, p4);
    const h = up.at(p1.index) - lo.at(p1.index);
    if (h <= 0 || h > 0.5 * pole) continue;
    if (Math.min(p2.price, p4.price) <= p0.price + 0.5 * pole) continue;
    if (p1.index - p0.index > 1.5 * (p4.index - p1.index)) continue;
    const T = S.tol * h;
    const du = up.at(p4.index) - up.at(p1.index);
    const dl = lo.at(p4.index) - lo.at(p1.index);
    const pennant = du < -T && dl > T;
    const flag = !pennant && du <= T && dl <= T && Math.abs(du - dl) <= 0.5 * h;
    if (!pennant && !flag) continue;
    let contained = true;
    for (let i = p1.index; i <= p4.index && contained; i++) if (S.h[i] > up.at(i) + T || S.l[i] < lo.at(i) - T) contained = false;
    if (!contained) continue;
    const span = p4.index - p1.index;
    const conf = firstWhere(S.n, p4.index, p4.index + span, (i) => S.c[i] > up.at(i));
    const b = up.at(conf >= 0 ? conf : p4.index);
    const id = pennant ? (s === 1 ? 'bull-pennant' : 'bear-pennant') : s === 1 ? 'bull-flag' : 'bear-flag';
    out.push({
      id,
      points: [pt(p0), pt(p1), pt(p2), pt(p3), pt(p4)],
      lines: [
        [pt(p0), pt(p1)],
        [pt(p1), { index: p4.index, price: up.at(p4.index) }],
        [{ index: p1.index, price: lo.at(p1.index) }, pt(p4)],
      ],
      breakout: b,
      target: b + pole,
      confirmedIndex: conf >= 0 ? conf : undefined,
    });
  }
  return out;
};

/** Cup & handle (s=1) / inverted (s=−1): rim H, rounded bottom L, rim H, shallow handle L. */
const cups: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k < p.length; k++) {
    if (!kinds(p, k, 'HLHL')) continue;
    const [a, b, c, d] = p.slice(k, k + 4);
    const depthPx = Math.min(a.price, c.price) - b.price;
    if (depthPx <= 0 || Math.abs(a.price - c.price) > 2 * S.tol * depthPx) continue;
    const span = c.index - a.index;
    if (span < 4 * S.depth) continue;
    // Roundness: a U spends a large share of its bars near the bottom; a V does not.
    let near = 0;
    for (let i = a.index; i <= c.index; i++) if (S.c[i] <= b.price + 0.3 * depthPx) near++;
    if (near / (span + 1) < 0.4) continue;
    if (d.price <= b.price + 0.5 * depthPx || d.price >= c.price) continue;
    if (d.index - c.index > span / 2) continue;
    const rim = Math.max(a.price, c.price);
    if (maxIn(S.h, a.index, d.index) > rim + S.tol * depthPx) continue;
    const conf = firstWhere(S.n, d.index, d.index + span, (i) => S.c[i] > rim);
    const curve: PatternPoint[] = [];
    const step = Math.max(1, Math.floor(span / 12));
    for (let i = a.index; i < c.index; i += step) curve.push({ index: i, price: S.c[i] });
    curve.push(pt(c), pt(d));
    curve[0] = pt(a);
    out.push({
      id: s === 1 ? 'cup-and-handle' : 'inverted-cup-and-handle',
      points: [pt(a), pt(b), pt(c), pt(d)],
      lines: [curve],
      breakout: rim,
      target: rim + depthPx,
      confirmedIndex: conf >= 0 ? conf : undefined,
    });
  }
  return out;
};

/** Elliott 5-wave impulse: wave 2 holds the origin, wave 3 not shortest, wave 4 clear of wave 1. */
const elliott: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  for (let k = 0; k < p.length; k++) {
    if (!kinds(p, k, 'LHLHLH')) continue;
    const w = p.slice(k, k + 6);
    const [p0, p1, p2, p3, p4, p5] = w;
    if (p2.price <= p0.price || p3.price <= p1.price || p4.price <= p1.price || p5.price <= p3.price) continue;
    const w1 = p1.price - p0.price;
    const w3 = p3.price - p2.price;
    const w5 = p5.price - p4.price;
    if (w3 < w1 && w3 < w5) continue;
    const pts = w.map((q, j) => pt(q, String(j)));
    out.push({ id: 'elliott-impulse', direction: s === 1 ? 'bullish' : 'bearish', points: pts, lines: [pts], confirmedIndex: p5.index });
  }
  return out;
};

interface HarmonicRule {
  id: string;
  ab: [number, number];
  bc: [number, number];
  cd: [number, number];
  ad: [number, number];
}
const HARMONICS: HarmonicRule[] = [
  { id: 'gartley', ab: [0.618, 0.618], bc: [0.382, 0.886], cd: [1.13, 1.618], ad: [0.786, 0.786] },
  { id: 'bat', ab: [0.382, 0.5], bc: [0.382, 0.886], cd: [1.618, 2.618], ad: [0.886, 0.886] },
  { id: 'butterfly', ab: [0.786, 0.786], bc: [0.382, 0.886], cd: [1.618, 2.24], ad: [1.27, 1.618] },
  { id: 'crab', ab: [0.382, 0.618], bc: [0.382, 0.886], cd: [2.24, 3.618], ad: [1.618, 1.618] },
];

/** Harmonics; in the up orientation the pattern completes at a LOW D, i.e. bullish. */
const harmonics: Scanner = (S, s) => {
  const out: Raw[] = [];
  const p = S.piv;
  const direction: PatternDirection = s === 1 ? 'bullish' : 'bearish';
  const finish = (id: string, w: Pivot[], labels: string[], c: Pivot, d: Pivot, target: number): Raw => {
    const pts = w.map((q, j) => pt(q, labels[j]));
    const conf = firstWhere(S.n, d.index, S.n, (i) => S.c[i] >= d.price + 0.382 * (c.price - d.price));
    return { id, direction, points: pts, lines: [pts], target, confirmedIndex: conf >= 0 ? conf : undefined };
  };
  for (let k = 0; k < p.length; k++) {
    // ABCD: A high, B low, C high, D low.
    if (kinds(p, k, 'HLHL')) {
      const [a, b, c, d] = p.slice(k, k + 4);
      const ab = a.price - b.price;
      const bc = c.price - b.price;
      const cd = c.price - d.price;
      if (ab > 0 && bc > 0 && cd > 0 && within(bc / ab, 0.382, 0.886, S.ft) && within(cd / bc, 1.13, 2.618, S.ft)) {
        out.push(finish('abcd', [a, b, c, d], ['A', 'B', 'C', 'D'], c, d, d.price + 0.618 * cd));
      }
    }
    if (!kinds(p, k, 'LHLHL')) continue;
    const [x, a, b, c, d] = p.slice(k, k + 5);
    const xa = a.price - x.price;
    const ab = a.price - b.price;
    const bc = c.price - b.price;
    const cd = c.price - d.price;
    if (xa <= 0 || ab <= 0 || bc <= 0 || cd <= 0) continue;
    const w = [x, a, b, c, d];
    const labels = ['X', 'A', 'B', 'C', 'D'];
    const rAB = ab / xa;
    const rBC = bc / ab;
    const rCD = cd / bc;
    const rAD = (a.price - d.price) / xa;
    const tgt = d.price + 0.618 * (a.price - d.price);
    for (const r of HARMONICS) {
      if (within(rAB, ...r.ab, S.ft) && within(rBC, ...r.bc, S.ft) && within(rCD, ...r.cd, S.ft) && within(rAD, ...r.ad, S.ft)) {
        out.push(finish(r.id, w, labels, c, d, tgt));
      }
    }
    // Cypher: C extends 1.272–1.414 of XA beyond X; D retraces 0.786 of XC.
    const xc = c.price - x.price;
    if (within(rAB, 0.382, 0.618, S.ft) && within(xc / xa, 1.272, 1.414, S.ft) && within((c.price - d.price) / xc, 0.786, 0.786, S.ft)) {
      out.push(finish('cypher', w, labels, c, d, d.price + 0.618 * (c.price - d.price)));
    }
  }
  return out;
};

const SCANNERS: { ids: string[]; scan: Scanner }[] = [
  { ids: ['double-top', 'double-bottom'], scan: doubleTop },
  { ids: ['head-and-shoulders', 'inverse-head-and-shoulders'], scan: headShoulders },
  {
    ids: ['ascending-triangle', 'descending-triangle', 'symmetric-triangle', 'rectangle', 'rising-wedge', 'falling-wedge'],
    scan: ranges,
  },
  { ids: ['bull-flag', 'bear-flag', 'bull-pennant', 'bear-pennant'], scan: flags },
  { ids: ['cup-and-handle', 'inverted-cup-and-handle'], scan: cups },
  { ids: ['elliott-impulse'], scan: elliott },
  { ids: ['abcd', 'gartley', 'bat', 'butterfly', 'crab', 'cypher'], scan: harmonics },
];

/**
 * Detect chart patterns. Per type, hits are de-duplicated so no two overlap in time (the
 * most recent wins) and capped to `maxPerType`; the result is ordered by end bar.
 */
export function detectChartPatterns(bars: readonly Ohlc[], options: ChartPatternOptions = {}): ChartPatternHit[] {
  const o = {
    pivotDepth: options.pivotDepth ?? 5,
    tolerance: options.tolerance ?? 0.1,
    fibTolerance: options.fibTolerance ?? 0.05,
    maxPerType: options.maxPerType ?? 3,
  };
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  const piv = findPivots(bars, o.pivotDepth);
  if (piv.length < 3) return [];

  const hits: ChartPatternHit[] = [];
  for (const sc of SCANNERS) {
    if (wanted && !sc.ids.some((id) => wanted.has(id))) continue;
    for (const s of [1, -1] as const) {
      const S = orient(bars, piv, s, o);
      for (const r of sc.scan(S, s)) {
        if (wanted && !wanted.has(r.id)) continue;
        const meta = META.get(r.id)!;
        const unflip = (q: PatternPoint): PatternPoint => ({ ...q, price: s * q.price });
        const points = r.points.map(unflip);
        const idx = points.map((q) => q.index);
        hits.push({
          id: r.id,
          name: meta.name,
          direction: r.direction ?? meta.direction,
          points,
          lines: r.lines.map((l) => l.map(unflip)),
          breakout: r.breakout === undefined ? undefined : s * r.breakout,
          target: r.target === undefined ? undefined : s * r.target,
          status: r.confirmedIndex !== undefined ? 'confirmed' : 'forming',
          confirmedIndex: r.confirmedIndex,
          startIndex: Math.min(...idx),
          endIndex: Math.max(...idx),
        });
      }
    }
  }

  const byType = new Map<string, ChartPatternHit[]>();
  for (const h of hits) byType.set(h.id, [...(byType.get(h.id) ?? []), h]);
  const out: ChartPatternHit[] = [];
  for (const list of byType.values()) {
    list.sort((a, b) => b.endIndex - a.endIndex || b.endIndex - b.startIndex - (a.endIndex - a.startIndex));
    const kept: ChartPatternHit[] = [];
    for (const h of list) {
      if (kept.length >= o.maxPerType) break;
      if (kept.some((k) => h.startIndex < k.endIndex && h.endIndex > k.startIndex)) continue;
      kept.push(h);
    }
    out.push(...kept);
  }
  return out.sort((a, b) => a.endIndex - b.endIndex || a.id.localeCompare(b.id));
}
