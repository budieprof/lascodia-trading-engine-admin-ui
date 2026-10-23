import { utcMs } from '../panels/fx-fundamentals';
import type { FootprintRowDto, TickBarDto, TickBarsRequest } from './orderflow.types';

/**
 * OF-2 / OF-3 / OF-4 — the tick-flow maths, free of the chart: which of the chart's own bars to ask C2 about (so a
 * session grid's 17:00 New York bars line up exactly), the "liquidity pulled" detector, the footprint's diagonal
 * imbalances and its row height.
 */

/** The engine's caps (C2): bars per request, and the footprint's narrower window. */
export const MAX_FLOW_BARS = 2000;
export const MAX_FOOTPRINT_BARS = 500;
export const MAX_FOOTPRINT_SPAN_MS = 3 * 86_400_000;

/** A bar as the chart holds it: its UTC open and, on the session grid, its exclusive close. */
export interface FlowBar {
  time: number;
  closeTime?: number;
}

/** The bars a request covers: plotted indexes `[from, to]` and the exclusive end of the last. */
export interface FlowSpan {
  from: number;
  to: number;
  endUtc: number;
}

/**
 * Plotted indexes to ask about for a view: the visible bars plus half as many again to the left (a small pan needs
 * no new request), through the newest bar when it is on screen, at most `maxBars` — the newest kept.
 */
export function flowIndexes(
  view: { fromIndex: number; toIndex: number; rightEdgeInView: boolean },
  barCount: number,
  maxBars: number,
): { from: number; to: number } | null {
  if (barCount === 0) return null;
  const last = barCount - 1;
  const visible = Math.max(1, view.toIndex - view.fromIndex + 1);
  const to = view.rightEdgeInView ? last : Math.min(last, Math.ceil(view.toIndex + visible * 0.25));
  let from = Math.max(0, Math.floor(view.fromIndex - visible * 0.5));
  if (to - from + 1 > maxBars) from = to - maxBars + 1;
  return from <= to ? { from: Math.max(0, from), to } : null;
}

/**
 * The exclusive end of bar `i`: the next bar's open; for the newest, its own close on the session grid or its
 * fixed width — never past `capUtc` (now, or the replay head), and always after its open.
 */
export function barEnd(
  bars: readonly FlowBar[],
  i: number,
  barMs: number | null,
  capUtc: number,
): number {
  const next = bars[i + 1];
  if (next) return next.time;
  const bar = bars[i];
  const close = bar.closeTime ?? (barMs ? bar.time + barMs : capUtc);
  return Math.max(bar.time + 1, Math.min(close, capUtc));
}

/** The C2 body for bars `[from, to]` of the chart's own series. */
export function tickBarsRequest(
  symbol: string,
  bars: readonly FlowBar[],
  span: { from: number; to: number },
  barMs: number | null,
  capUtc: number,
  footprint: { rowPoints: number } | null,
): TickBarsRequest | null {
  const from = Math.max(0, span.from);
  const to = Math.min(bars.length - 1, span.to);
  if (!symbol || to < from) return null;
  const slice = bars.slice(from, to + 1);
  const endUtc = barEnd(bars, to, barMs, capUtc);
  return {
    symbol,
    barTimes: slice.map((b) => new Date(b.time).toISOString()),
    endUtc: new Date(endUtc).toISOString(),
    footprint: footprint !== null,
    ...(footprint ? { footprintRowPoints: footprint.rowPoints } : {}),
  };
}

/** Whether the engine allows a footprint over these bars (C2: ≤ 3 days and ≤ 500 bars). */
export function footprintAllowed(barCount: number, fromUtc: number, endUtc: number): boolean {
  return (
    barCount > 0 && barCount <= MAX_FOOTPRINT_BARS && endUtc - fromUtc <= MAX_FOOTPRINT_SPAN_MS
  );
}

/** The response's bars by their UTC open (ms). */
export function tickBarsByTime(bars: readonly TickBarDto[]): Map<number, TickBarDto> {
  const out = new Map<number, TickBarDto>();
  for (const b of bars) {
    const t = utcMs(b.t);
    if (Number.isFinite(t)) out.set(t, b);
  }
  return out;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The detector's rules: a bar's spread at least `spreadX` × the median of the `window` bars before it, … */
export interface PulledRules {
  window: number;
  spreadX: number;
  /** … AND its tick rate at least `rateX` × the median tick rate over the same bars. */
  rateX: number;
  /** Fewer earlier bars than this with a value: no judgement. */
  minHistory: number;
}

export const PULLED_RULES: PulledRules = { window: 20, spreadX: 2, rateX: 2, minHistory: 5 };

/**
 * "Liquidity pulled" (OF-4): bars where the spread is at least twice its rolling median AND the tick rate spikes to at
 * least twice its own — quotes flickering while the broker widens, as around a news print. Only bars built from ticks
 * are judged (a candle-filled bar has a spread but no tick rate). Returns one flag per bar.
 */
export function liquidityPulled(
  bars: readonly TickBarDto[],
  rules: PulledRules = PULLED_RULES,
): boolean[] {
  const out: boolean[] = new Array(bars.length).fill(false);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.source !== 'ticks' || b.spreadAvgPoints === null || b.ticksPerMinute === null) continue;
    const spreads: number[] = [];
    const rates: number[] = [];
    for (let j = Math.max(0, i - rules.window); j < i; j++) {
      const p = bars[j];
      if (p.spreadAvgPoints !== null && p.spreadAvgPoints > 0) spreads.push(p.spreadAvgPoints);
      if (p.source === 'ticks' && p.ticksPerMinute !== null && p.ticksPerMinute > 0)
        rates.push(p.ticksPerMinute);
    }
    if (spreads.length < rules.minHistory || rates.length < rules.minHistory) continue;
    const ms = median(spreads)!;
    const mr = median(rates)!;
    out[i] = b.spreadAvgPoints >= rules.spreadX * ms && b.ticksPerMinute >= rules.rateX * mr;
  }
  return out;
}

// ── Footprint (OF-3) ──────────────────────────────────────────────────────────

/** ATAS / Sierra's diagonal ratio: one side's ticks at least 3× the other side's on the neighbouring row. */
export const IMBALANCE_RATIO = 3;

export interface FootprintCell {
  /** Row bottom; the row spans `[price, price + rowPrice)`. */
  price: number;
  up: number;
  down: number;
  /** Up-ticks here ≥ ratio × down-ticks one row BELOW (buyers lifting through the row). */
  buyImbalance: boolean;
  /** Down-ticks here ≥ ratio × up-ticks one row ABOVE. */
  sellImbalance: boolean;
  /** The bar's busiest row (most ticks). */
  maxActivity: boolean;
}

/**
 * A bar's rows, highest price first, with the diagonal imbalances and the busiest row marked. An empty neighbour
 * counts as one tick, so a lone tick is never an "imbalance" — it takes at least `ratio` ticks against nothing.
 */
export function footprintCells(
  rows: readonly FootprintRowDto[],
  rowPrice: number,
  ratio = IMBALANCE_RATIO,
): FootprintCell[] {
  if (rows.length === 0 || !(rowPrice > 0)) return [];
  const byKey = new Map<number, FootprintRowDto>();
  for (const r of rows) {
    if (!Number.isFinite(r.price)) continue;
    const k = Math.round(r.price / rowPrice);
    const held = byKey.get(k);
    byKey.set(
      k,
      held ? { price: held.price, up: held.up + r.up, down: held.down + r.down } : { ...r },
    );
  }
  let maxKey: number | null = null;
  let maxTicks = 0;
  for (const [k, r] of byKey) {
    const total = r.up + r.down;
    if (total > maxTicks) {
      maxTicks = total;
      maxKey = k;
    }
  }
  return [...byKey.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([k, r]) => {
      const below = byKey.get(k - 1)?.down ?? 0;
      const above = byKey.get(k + 1)?.up ?? 0;
      return {
        price: k * rowPrice,
        up: r.up,
        down: r.down,
        buyImbalance: r.up > 0 && r.up >= ratio * Math.max(1, below),
        sellImbalance: r.down > 0 && r.down >= ratio * Math.max(1, above),
        maxActivity: k === maxKey && maxTicks > 0,
      };
    });
}

/** Footprint row heights in MT5 points (1 point = 0.1 pip on a 5-digit pair): the "nice" steps a row snaps to. */
export const ROW_POINT_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
/** Rows a typical bar is cut into (ATAS / Sierra Chart keep a bar to about ten). */
export const TARGET_ROWS = 10;
/** A held row size is kept while a typical bar still has this many rows (no flapping at a step's edge). */
export const KEEP_ROWS: readonly [number, number] = [6, 16];

/** The median high − low of bars `[from, to]` (price); 0 for none. */
export function medianBarRange(
  bars: readonly { high: number; low: number }[],
  from: number,
  to: number,
): number {
  const ranges: number[] = [];
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const r = bars[i].high - bars[i].low;
    if (Number.isFinite(r) && r > 0) ranges.push(r);
  }
  return median(ranges) ?? 0;
}

/**
 * The footprint's row height in MT5 points, adaptive like ATAS / Sierra Chart: the nice step that cuts the median
 * visible bar into about {@link TARGET_ROWS} rows (never under one point). A `held` size is kept while it still gives
 * between 6 and 16 rows, so a small zoom or pan does not re-ask. `point` is 10^-digits.
 */
export function footprintRowPoints(
  medianRange: number,
  point: number,
  held: number | null = null,
): number {
  const p = point > 0 ? point : 0.00001;
  if (!(medianRange > 0)) return held ?? ROW_POINT_STEPS[0];
  const rowsAt = (points: number) => medianRange / (points * p);
  if (held !== null && held >= 1) {
    const rows = rowsAt(held);
    if (rows >= KEEP_ROWS[0] && rows <= KEEP_ROWS[1]) return held;
  }
  let best = ROW_POINT_STEPS[0];
  let bestErr = Infinity;
  for (const step of ROW_POINT_STEPS) {
    const err = Math.abs(Math.log(rowsAt(step) / TARGET_ROWS));
    if (err < bestErr) {
      bestErr = err;
      best = step;
    }
  }
  return best;
}

/** "0.2 pip", "1 pip", "5 pips" — a row size for the caption. */
export function formatRowSize(points: number, point: number, pip: number): string {
  const pips = pip > 0 ? (points * point) / pip : points;
  const text = pips >= 10 ? String(Math.round(pips)) : String(Math.round(pips * 10) / 10);
  return `${text} pip${pips === 1 || pips < 1 ? '' : 's'}`;
}

/** Bars at least this wide (px) can hold a footprint's numbers. */
export const FOOTPRINT_MIN_BAR_PX = 60;
