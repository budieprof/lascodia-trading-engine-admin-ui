import type { Bar } from '../datafeed/candle-feed.service';
import type { ExternalPane } from '../chart/chart-host.component';
import type { PanePoint } from '../panels/fx-fundamentals';

/**
 * Compare overlays and synthetic series (CC-I12), computed in the browser from the bars the chart already loads for
 * other symbols (the compare bars: same timeframe, live, extended on scroll-back):
 *
 * - **Compare** — another symbol's price on the price pane, on the price's scale in Percent mode, so each line is
 *   rebased at the first bar on screen and moves live (TradingView's "Compare symbol").
 * - **Ratio** A ÷ B and **Spread** A − m × B — any two symbols (the chart's own included), in a pane of their own.
 * - **Basket** — a weighted index of several symbols, each rebased to 100 at the first bar they all have, in a pane.
 *
 * For display only: nothing here is an instrument the engine knows, and no script or order can run on it.
 */
export type CompareKind = 'compare' | 'ratio' | 'spread' | 'basket';

export interface CompareSeriesSpec {
  id: string;
  kind: CompareKind;
  /** compare: [other]; ratio / spread: [A, B]; basket: its members. Engine symbols, upper case. */
  symbols: string[];
  /** basket: one weight per member (absent: equal). */
  weights?: number[];
  /** spread: A − mult × B (absent: 1). */
  mult?: number;
  color: string;
}

export const COMPARE_COLOURS = ['#FF6D00', '#AB47BC', '#00897B', '#F06292', '#5C6BC0', '#8D6E63'] as const;

/** Most compare series on one chart (each loads a symbol's bars). */
export const MAX_COMPARE_SERIES = 6;
/** Most members of a basket. */
export const MAX_BASKET = 8;

/** What a series is called on the chart: "GBPUSD", "EURUSD ÷ GBPUSD", "EURUSD − 1.2 × GBPUSD", "Basket (3)". */
export function compareTitle(s: CompareSeriesSpec): string {
  switch (s.kind) {
    case 'compare':
      return s.symbols[0] ?? '';
    case 'ratio':
      return `${s.symbols[0]} ÷ ${s.symbols[1]}`;
    case 'spread': {
      const m = s.mult ?? 1;
      return `${s.symbols[0]} − ${m === 1 ? '' : `${m} × `}${s.symbols[1]}`;
    }
    case 'basket':
      return `Basket: ${s.symbols
        .map((sym, i) => (s.weights && s.weights[i] !== 1 ? `${s.weights[i]}×${sym}` : sym))
        .join(' + ')}`;
  }
}

/** Why a spec cannot be drawn, in plain words; null when it can. */
export function specProblem(s: CompareSeriesSpec): string | null {
  const syms = s.symbols.map((x) => x.trim()).filter(Boolean);
  if (s.kind === 'compare' && syms.length !== 1) return 'Pick the symbol to compare.';
  if ((s.kind === 'ratio' || s.kind === 'spread') && (syms.length !== 2 || syms[0] === syms[1]))
    return 'Pick two different symbols.';
  if (s.kind === 'basket') {
    if (syms.length < 2) return 'A basket needs at least two symbols.';
    if (syms.length > MAX_BASKET) return `A basket takes at most ${MAX_BASKET} symbols.`;
    if (new Set(syms).size !== syms.length) return 'Each symbol once in a basket.';
    if (s.weights && (s.weights.length !== syms.length || s.weights.some((w) => !Number.isFinite(w) || w <= 0)))
      return 'Every weight must be above 0.';
  }
  if (s.kind === 'spread' && s.mult !== undefined && !Number.isFinite(s.mult)) return 'The multiplier must be a number.';
  return null;
}

/** The symbols whose bars a set of specs needs, besides the chart's own. */
export function compareSymbolsOf(specs: readonly CompareSeriesSpec[], chartSymbol: string): string[] {
  const own = chartSymbol.toUpperCase();
  const out = new Set<string>();
  for (const s of specs) for (const sym of s.symbols) if (sym && sym.toUpperCase() !== own) out.add(sym.toUpperCase());
  return [...out].sort();
}

/** Closes by bar open time. */
function closesByTime(bars: readonly Bar[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of bars) if (Number.isFinite(b.close)) m.set(b.time, b.close);
  return m;
}

/**
 * The points of `spec` from the bars it reads (`barsOf(symbol)`: the chart's own for its symbol, the compare bars for
 * the others; ascending, UTC opens). Combined series have a point at every bar time all their legs share.
 */
export function compareSeriesPoints(
  spec: CompareSeriesSpec,
  barsOf: (symbol: string) => readonly Bar[] | undefined,
): PanePoint[] {
  if (specProblem(spec)) return [];
  const legs = spec.symbols.map((sym) => barsOf(sym.toUpperCase()) ?? []);
  if (legs.some((l) => l.length === 0)) return [];
  if (spec.kind === 'compare') return legs[0].map((b) => ({ time: b.time, value: b.close }));
  const maps = legs.map(closesByTime);
  const times = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort((a, b) => a - b);
  if (spec.kind === 'ratio')
    return times.flatMap((t) => {
      const b = maps[1].get(t)!;
      return b === 0 ? [] : [{ time: t, value: maps[0].get(t)! / b }];
    });
  if (spec.kind === 'spread') {
    const m = spec.mult ?? 1;
    return times.map((t) => ({ time: t, value: maps[0].get(t)! - m * maps[1].get(t)! }));
  }
  // Basket: each member rebased to 100 at the first time they all have, weighted.
  if (!times.length) return [];
  const base = maps.map((m) => m.get(times[0])!);
  if (base.some((b) => b === 0)) return [];
  const weights = spec.weights?.length === maps.length ? spec.weights : maps.map(() => 1);
  const total = weights.reduce((a, w) => a + w, 0);
  return times.map((t) => ({
    time: t,
    value: maps.reduce((sum, m, i) => sum + (weights[i] * 100 * m.get(t)!) / base[i], 0) / total,
  }));
}

/** The chart lines of the specs: compare series on the price pane, the others each in a pane. */
export function comparePanes(
  specs: readonly CompareSeriesSpec[],
  barsOf: (symbol: string) => readonly Bar[] | undefined,
  precisionOf: (symbol: string) => number,
): ExternalPane[] {
  return specs.map((s) => ({
    uid: `compare:${s.id}`,
    target: s.kind === 'compare' ? 'price' : 'pane',
    stepped: false,
    lines: [
      {
        title: compareTitle(s),
        color: s.color,
        points: compareSeriesPoints(s, barsOf),
        precision: s.kind === 'compare' || s.kind === 'spread' ? precisionOf(s.symbols[0]) : s.kind === 'ratio' ? 5 : 2,
      },
    ],
  }));
}

/** A layout's compare series with anything malformed dropped. */
export function restoredCompare(raw: unknown): CompareSeriesSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: CompareSeriesSpec[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || out.length >= MAX_COMPARE_SERIES) continue;
    const o = r as Partial<CompareSeriesSpec>;
    if (!['compare', 'ratio', 'spread', 'basket'].includes(String(o.kind))) continue;
    if (!Array.isArray(o.symbols) || !o.symbols.every((x) => typeof x === 'string' && /^[A-Z0-9._-]{1,20}$/i.test(x)))
      continue;
    const spec: CompareSeriesSpec = {
      id: typeof o.id === 'string' && o.id ? o.id : `c${out.length}`,
      kind: o.kind as CompareKind,
      symbols: o.symbols.map((x) => x.toUpperCase()),
      color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : COMPARE_COLOURS[out.length % COMPARE_COLOURS.length],
      ...(Array.isArray(o.weights) ? { weights: o.weights.map(Number) } : {}),
      ...(typeof o.mult === 'number' ? { mult: o.mult } : {}),
    };
    if (!specProblem(spec)) out.push(spec);
  }
  return out;
}
