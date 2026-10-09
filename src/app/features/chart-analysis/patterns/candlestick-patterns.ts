import { sma, type Ohlc } from '../indicators/math';

/**
 * Candlestick pattern recognition — pure functions over ASCENDING bars.
 *
 * <p>Rules follow TradingView's built-in candlestick library closely: "long" and "small"
 * bodies are judged against the average body of the 14 bars BEFORE the pattern starts, and
 * with the `sma50` trend filter a reversal pattern only fires when the bar preceding it
 * closed on the right side of the 50-period SMA (a hammer needs a downtrend, a hanging man an
 * uptrend). With `trend: 'none'` the shape alone decides, so a hammer and a hanging man fire
 * on the same bar — exactly as TradingView does with its trend filter off.</p>
 */

export type CandleDirection = 'bullish' | 'bearish' | 'neutral';
export type CandleTrendFilter = 'sma50' | 'none';

export interface CandlestickPatternMeta {
  id: string;
  name: string;
  abbr: string;
  direction: CandleDirection;
  /** Number of bars the pattern spans (the hit's `index` is its LAST bar). */
  bars: number;
  /** Prior trend the pattern needs under the `sma50` filter; absent = no trend needed. */
  trend?: 'up' | 'down';
}

export interface CandlestickHit {
  index: number;
  id: string;
  name: string;
  abbr: string;
  direction: CandleDirection;
}

export interface CandlestickOptions {
  /** Restrict to these pattern ids; omitted/empty = all. */
  ids?: string[];
  trend?: CandleTrendFilter;
}

interface Shape {
  o: number;
  h: number;
  l: number;
  c: number;
  body: number;
  range: number;
  upper: number;
  lower: number;
  top: number;
  bot: number;
  white: boolean;
  black: boolean;
  doji: boolean;
}

/**
 * Pine's float comparison rule (the engine's `PineOps`, as TradingView compares): both sides rounded half away from
 * zero to nine decimals first, so a shadow that is exactly 5% of the range in decimal terms counts as 5% whatever the
 * binary noise — the chart marks what a Pine script of the same rule marks (the scorecard's Pine export, DR-I8).
 */
export function round9(x: number): number {
  return Math.sign(x) * (Math.round(Math.abs(x) * 1e9) / 1e9);
}
const lt = (x: number, y: number) => round9(x) < round9(y);
const le = (x: number, y: number) => round9(x) <= round9(y);
const gt = (x: number, y: number) => round9(x) > round9(y);
const ge = (x: number, y: number) => round9(x) >= round9(y);

function shape(b: Ohlc): Shape {
  const top = Math.max(b.open, b.close);
  const bot = Math.min(b.open, b.close);
  const range = b.high - b.low;
  const body = top - bot;
  return {
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    body,
    range,
    upper: b.high - top,
    lower: bot - b.low,
    top,
    bot,
    white: gt(b.close, b.open),
    black: lt(b.close, b.open),
    doji: gt(range, 0) && le(body, 0.05 * range),
  };
}

interface Ctx {
  /** Shape of bar `i`. */
  s: (i: number) => Shape;
  /** Average body of the 14 bars before `i` (falls back to bar i's own body). */
  avgBody: (i: number) => number;
}

type Test = (x: Ctx, i: number) => boolean;

interface Def extends CandlestickPatternMeta {
  test: Test;
}

const marubozuShape = (a: Shape) =>
  gt(a.range, 0) && le(a.upper, 0.05 * a.range) && le(a.lower, 0.05 * a.range) && !a.doji;
const long = (x: Ctx, i: number, start: number) => gt(x.s(i).body, x.avgBody(start));
const isDragonfly = (a: Shape) => a.doji && le(a.upper, 0.1 * a.range);
const isGravestone = (a: Shape) => a.doji && le(a.lower, 0.1 * a.range);
const hammerShape = (x: Ctx, i: number) => {
  const a = x.s(i);
  return !a.doji && gt(a.range, 0) && lt(a.body, x.avgBody(i)) && ge(a.lower, 2 * a.body) && le(a.upper, 0.1 * a.range);
};
const invHammerShape = (x: Ctx, i: number) => {
  const a = x.s(i);
  return !a.doji && gt(a.range, 0) && lt(a.body, x.avgBody(i)) && ge(a.upper, 2 * a.body) && le(a.lower, 0.1 * a.range);
};
const inside = (inner: Shape, outer: Shape) => le(inner.top, outer.top) && ge(inner.bot, outer.bot);
const mid = (a: Shape) => a.bot + a.body / 2;

const DEFS: Def[] = [
  // ── single bar ───────────────────────────────────────────────────────────
  {
    id: 'doji', name: 'Doji', abbr: 'D', direction: 'neutral', bars: 1,
    test: (x, i) => { const a = x.s(i); return a.doji && !isDragonfly(a) && !isGravestone(a); },
  },
  { id: 'dragonfly-doji', name: 'Dragonfly Doji', abbr: 'DD', direction: 'bullish', bars: 1, test: (x, i) => isDragonfly(x.s(i)) },
  { id: 'gravestone-doji', name: 'Gravestone Doji', abbr: 'GD', direction: 'bearish', bars: 1, test: (x, i) => isGravestone(x.s(i)) },
  {
    id: 'long-legged-doji', name: 'Long-Legged Doji', abbr: 'LLD', direction: 'neutral', bars: 1,
    test: (x, i) => { const a = x.s(i); return a.doji && ge(a.upper, 0.3 * a.range) && ge(a.lower, 0.3 * a.range); },
  },
  { id: 'hammer', name: 'Hammer', abbr: 'H', direction: 'bullish', bars: 1, trend: 'down', test: hammerShape },
  { id: 'inverted-hammer', name: 'Inverted Hammer', abbr: 'IH', direction: 'bullish', bars: 1, trend: 'down', test: invHammerShape },
  { id: 'hanging-man', name: 'Hanging Man', abbr: 'HM', direction: 'bearish', bars: 1, trend: 'up', test: hammerShape },
  { id: 'shooting-star', name: 'Shooting Star', abbr: 'SS', direction: 'bearish', bars: 1, trend: 'up', test: invHammerShape },
  {
    id: 'marubozu-white', name: 'Marubozu White', abbr: 'MW', direction: 'bullish', bars: 1,
    test: (x, i) => { const a = x.s(i); return a.white && marubozuShape(a) && long(x, i, i); },
  },
  {
    id: 'marubozu-black', name: 'Marubozu Black', abbr: 'MB', direction: 'bearish', bars: 1,
    test: (x, i) => { const a = x.s(i); return a.black && marubozuShape(a) && long(x, i, i); },
  },
  {
    id: 'spinning-top', name: 'Spinning Top', abbr: 'ST', direction: 'neutral', bars: 1,
    test: (x, i) => {
      const a = x.s(i);
      return !a.doji && gt(a.range, 0) && le(a.body, 0.35 * a.range) && ge(a.upper, a.body) && ge(a.lower, a.body);
    },
  },
  {
    id: 'long-lower-shadow', name: 'Long Lower Shadow', abbr: 'LLS', direction: 'bullish', bars: 1,
    test: (x, i) => { const a = x.s(i); return gt(a.range, 0) && ge(a.lower, 0.7 * a.range); },
  },
  {
    id: 'long-upper-shadow', name: 'Long Upper Shadow', abbr: 'LUS', direction: 'bearish', bars: 1,
    test: (x, i) => { const a = x.s(i); return gt(a.range, 0) && ge(a.upper, 0.7 * a.range); },
  },

  // ── two bars ─────────────────────────────────────────────────────────────
  {
    id: 'bullish-engulfing', name: 'Bullish Engulfing', abbr: 'BE', direction: 'bullish', bars: 2, trend: 'down',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.black && c.white && ge(c.c, p.o) && le(c.o, p.c) && gt(c.body, p.body); },
  },
  {
    id: 'bearish-engulfing', name: 'Bearish Engulfing', abbr: 'BE', direction: 'bearish', bars: 2, trend: 'up',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.white && c.black && ge(c.o, p.c) && le(c.c, p.o) && gt(c.body, p.body); },
  },
  {
    id: 'bullish-harami', name: 'Bullish Harami', abbr: 'BH', direction: 'bullish', bars: 2, trend: 'down',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.black && long(x, i - 1, i - 1) && c.white && !c.doji && inside(c, p) && lt(c.body, p.body); },
  },
  {
    id: 'bearish-harami', name: 'Bearish Harami', abbr: 'BH', direction: 'bearish', bars: 2, trend: 'up',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.white && long(x, i - 1, i - 1) && c.black && !c.doji && inside(c, p) && lt(c.body, p.body); },
  },
  {
    id: 'bullish-harami-cross', name: 'Bullish Harami Cross', abbr: 'BHC', direction: 'bullish', bars: 2, trend: 'down',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.black && long(x, i - 1, i - 1) && c.doji && inside(c, p); },
  },
  {
    id: 'bearish-harami-cross', name: 'Bearish Harami Cross', abbr: 'BHC', direction: 'bearish', bars: 2, trend: 'up',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.white && long(x, i - 1, i - 1) && c.doji && inside(c, p); },
  },
  {
    id: 'piercing', name: 'Piercing', abbr: 'P', direction: 'bullish', bars: 2, trend: 'down',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.black && long(x, i - 1, i - 1) && c.white && lt(c.o, p.c) && gt(c.c, mid(p)) && lt(c.c, p.o); },
  },
  {
    id: 'dark-cloud-cover', name: 'Dark Cloud Cover', abbr: 'DCC', direction: 'bearish', bars: 2, trend: 'up',
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.white && long(x, i - 1, i - 1) && c.black && gt(c.o, p.c) && lt(c.c, mid(p)) && gt(c.c, p.o); },
  },
  {
    id: 'tweezer-top', name: 'Tweezer Top', abbr: 'TT', direction: 'bearish', bars: 2, trend: 'up',
    test: (x, i) => {
      const p = x.s(i - 1), c = x.s(i);
      return p.white && c.black && !p.doji && !c.doji && le(Math.abs(p.h - c.h), 0.05 * Math.max(p.range, c.range));
    },
  },
  {
    id: 'tweezer-bottom', name: 'Tweezer Bottom', abbr: 'TB', direction: 'bullish', bars: 2, trend: 'down',
    test: (x, i) => {
      const p = x.s(i - 1), c = x.s(i);
      return p.black && c.white && !p.doji && !c.doji && le(Math.abs(p.l - c.l), 0.05 * Math.max(p.range, c.range));
    },
  },
  {
    id: 'kicking-bull', name: 'Kicking Bull', abbr: 'K', direction: 'bullish', bars: 2,
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.black && marubozuShape(p) && c.white && marubozuShape(c) && gt(c.l, p.h); },
  },
  {
    id: 'kicking-bear', name: 'Kicking Bear', abbr: 'K', direction: 'bearish', bars: 2,
    test: (x, i) => { const p = x.s(i - 1), c = x.s(i); return p.white && marubozuShape(p) && c.black && marubozuShape(c) && lt(c.h, p.l); },
  },

  // ── three bars ───────────────────────────────────────────────────────────
  {
    id: 'morning-star', name: 'Morning Star', abbr: 'MS', direction: 'bullish', bars: 3, trend: 'down',
    test: (x, i) => {
      const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i);
      return a.black && long(x, i - 2, i - 2) && !m.doji && lt(m.body, 0.5 * a.body) && lt(m.top, a.c) && c.white && gt(c.c, mid(a));
    },
  },
  {
    id: 'evening-star', name: 'Evening Star', abbr: 'ES', direction: 'bearish', bars: 3, trend: 'up',
    test: (x, i) => {
      const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i);
      return a.white && long(x, i - 2, i - 2) && !m.doji && lt(m.body, 0.5 * a.body) && gt(m.bot, a.c) && c.black && lt(c.c, mid(a));
    },
  },
  {
    id: 'morning-doji-star', name: 'Morning Doji Star', abbr: 'MDS', direction: 'bullish', bars: 3, trend: 'down',
    test: (x, i) => {
      const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i);
      return a.black && long(x, i - 2, i - 2) && m.doji && lt(m.top, a.c) && c.white && gt(c.c, mid(a));
    },
  },
  {
    id: 'evening-doji-star', name: 'Evening Doji Star', abbr: 'EDS', direction: 'bearish', bars: 3, trend: 'up',
    test: (x, i) => {
      const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i);
      return a.white && long(x, i - 2, i - 2) && m.doji && gt(m.bot, a.c) && c.black && lt(c.c, mid(a));
    },
  },
  {
    id: 'three-white-soldiers', name: 'Three White Soldiers', abbr: '3WS', direction: 'bullish', bars: 3,
    test: (x, i) => {
      for (let k = i - 2; k <= i; k++) {
        const a = x.s(k);
        if (!a.white || le(a.body, x.avgBody(i - 2)) || gt(a.upper, 0.3 * a.body)) return false;
        if (k > i - 2) {
          const p = x.s(k - 1);
          if (le(a.c, p.c) || lt(a.o, p.o) || gt(a.o, p.c)) return false;
        }
      }
      return true;
    },
  },
  {
    id: 'three-black-crows', name: 'Three Black Crows', abbr: '3BC', direction: 'bearish', bars: 3,
    test: (x, i) => {
      for (let k = i - 2; k <= i; k++) {
        const a = x.s(k);
        if (!a.black || le(a.body, x.avgBody(i - 2)) || gt(a.lower, 0.3 * a.body)) return false;
        if (k > i - 2) {
          const p = x.s(k - 1);
          if (ge(a.c, p.c) || gt(a.o, p.o) || lt(a.o, p.c)) return false;
        }
      }
      return true;
    },
  },
  {
    id: 'abandoned-baby-bull', name: 'Abandoned Baby Bull', abbr: 'AB', direction: 'bullish', bars: 3, trend: 'down',
    test: (x, i) => { const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i); return a.black && m.doji && lt(m.h, a.l) && c.white && gt(c.l, m.h); },
  },
  {
    id: 'abandoned-baby-bear', name: 'Abandoned Baby Bear', abbr: 'AB', direction: 'bearish', bars: 3, trend: 'up',
    test: (x, i) => { const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i); return a.white && m.doji && gt(m.l, a.h) && c.black && lt(c.h, m.l); },
  },
  {
    id: 'tri-star-bull', name: 'Tri-Star Bull', abbr: '3S', direction: 'bullish', bars: 3, trend: 'down',
    test: (x, i) => { const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i); return a.doji && m.doji && c.doji && lt(m.top, a.bot) && lt(m.top, c.bot); },
  },
  {
    id: 'tri-star-bear', name: 'Tri-Star Bear', abbr: '3S', direction: 'bearish', bars: 3, trend: 'up',
    test: (x, i) => { const a = x.s(i - 2), m = x.s(i - 1), c = x.s(i); return a.doji && m.doji && c.doji && gt(m.bot, a.top) && gt(m.bot, c.top); },
  },
  {
    id: 'upside-tasuki-gap', name: 'Upside Tasuki Gap', abbr: 'UTG', direction: 'bullish', bars: 3, trend: 'up',
    test: (x, i) => {
      const a = x.s(i - 2), b = x.s(i - 1), c = x.s(i);
      return a.white && long(x, i - 2, i - 2) && b.white && gt(b.l, a.h) && c.black && gt(c.o, b.o) && lt(c.o, b.c) && gt(c.c, a.h) && lt(c.c, b.l);
    },
  },
  {
    id: 'downside-tasuki-gap', name: 'Downside Tasuki Gap', abbr: 'DTG', direction: 'bearish', bars: 3, trend: 'down',
    test: (x, i) => {
      const a = x.s(i - 2), b = x.s(i - 1), c = x.s(i);
      return a.black && long(x, i - 2, i - 2) && b.black && lt(b.h, a.l) && c.white && lt(c.o, b.o) && gt(c.o, b.c) && lt(c.c, a.l) && gt(c.c, b.h);
    },
  },

  // ── five bars ────────────────────────────────────────────────────────────
  {
    id: 'rising-three-methods', name: 'Rising Three Methods', abbr: 'R3M', direction: 'bullish', bars: 5, trend: 'up',
    test: (x, i) => {
      const a = x.s(i - 4), c = x.s(i);
      if (!a.white || !long(x, i - 4, i - 4) || !c.white || !long(x, i, i - 4) || le(c.c, a.c)) return false;
      for (let k = i - 3; k <= i - 1; k++) {
        const m = x.s(k);
        if (ge(m.body, a.body) || gt(m.h, a.h) || lt(m.l, a.l)) return false;
      }
      return true;
    },
  },
  {
    id: 'falling-three-methods', name: 'Falling Three Methods', abbr: 'F3M', direction: 'bearish', bars: 5, trend: 'down',
    test: (x, i) => {
      const a = x.s(i - 4), c = x.s(i);
      if (!a.black || !long(x, i - 4, i - 4) || !c.black || !long(x, i, i - 4) || ge(c.c, a.c)) return false;
      for (let k = i - 3; k <= i - 1; k++) {
        const m = x.s(k);
        if (ge(m.body, a.body) || gt(m.h, a.h) || lt(m.l, a.l)) return false;
      }
      return true;
    },
  },
];

/** The catalogue, in display order. */
export const CANDLESTICK_PATTERNS: readonly CandlestickPatternMeta[] = DEFS.map(
  ({ id, name, abbr, direction, bars, trend }) => (trend ? { id, name, abbr, direction, bars, trend } : { id, name, abbr, direction, bars }),
);

const AVG_BODY_PERIOD = 14;

/** Detect candlestick patterns; hits are ordered by index, then catalogue order. */
export function detectCandlestickPatterns(bars: readonly Ohlc[], options: CandlestickOptions = {}): CandlestickHit[] {
  const n = bars.length;
  if (n === 0) return [];
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  const defs = wanted ? DEFS.filter((d) => wanted.has(d.id)) : DEFS;
  if (defs.length === 0) return [];
  const trendMode = options.trend ?? 'sma50';

  const shapes = bars.map(shape);
  // Prefix sums of bodies → O(1) trailing average.
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + shapes[i].body;
  const ctx: Ctx = {
    s: (i) => shapes[i],
    avgBody: (i) => {
      const from = Math.max(0, i - AVG_BODY_PERIOD);
      return i > from ? (prefix[i] - prefix[from]) / (i - from) : shapes[i].body;
    },
  };
  const ma = trendMode === 'sma50' ? sma(bars.map((b) => b.close), 50) : null;
  const trendOk = (need: 'up' | 'down' | undefined, before: number): boolean => {
    if (!need || !ma) return true;
    if (before < 0) return false;
    const m = ma[before];
    if (m === null) return false;
    return need === 'up' ? gt(bars[before].close, m) : lt(bars[before].close, m);
  };

  const out: CandlestickHit[] = [];
  for (let i = 0; i < n; i++) {
    for (const d of defs) {
      if (i < d.bars - 1) continue;
      if (!d.test(ctx, i)) continue;
      if (!trendOk(d.trend, i - d.bars)) continue;
      out.push({ index: i, id: d.id, name: d.name, abbr: d.abbr, direction: d.direction });
    }
  }
  return out;
}
