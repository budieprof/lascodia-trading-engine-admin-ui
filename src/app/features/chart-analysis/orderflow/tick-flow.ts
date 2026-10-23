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

/** Footprint rows in pips: the smallest of these that leaves a row tall enough to read its numbers. */
const ROW_PIPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * The footprint's row height in MT5 points for the price scale on screen: the smallest "nice" number of pips whose
 * row is at least `minRowPx` tall, so the "down × up" counts fit. `point` is 10^-digits, `pip` the symbol's pip.
 */
export function footprintRowPoints(
  pricePerPx: number | null,
  point: number,
  pip: number,
  minRowPx = 14,
): number {
  const p = point > 0 ? point : 0.00001;
  const pipPrice = pip > 0 ? pip : p * 10;
  const need = pricePerPx !== null && pricePerPx > 0 ? pricePerPx * minRowPx : pipPrice;
  const pips = ROW_PIPS.find((n) => n * pipPrice >= need) ?? ROW_PIPS[ROW_PIPS.length - 1];
  return Math.max(1, Math.round((pips * pipPrice) / p));
}

/** Bars at least this wide (px) can hold a footprint's numbers. */
export const FOOTPRINT_MIN_BAR_PX = 60;
