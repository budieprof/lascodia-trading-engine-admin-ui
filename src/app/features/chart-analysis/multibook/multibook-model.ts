import type {
  MdConsolidatedLevelWire,
  MdConsolidatedSourceWire,
  MdConsolidatedWire,
} from '@core/realtime/marketdata.types';

/**
 * The multibook (engine `ConsolidatedBookService`, hub source `consolidated`) as the panel draws it — pure, so the
 * arithmetic is tested without Angular. Prices are spot-equivalent (inverted futures flipped, futures basis-adjusted),
 * sizes are BASE-CURRENCY UNITS (the engine converts lots/contracts; a source whose unit cannot be converted shows its
 * price with no size — never a guess). A per-source toggle filters the entitled sources client-side: the engine sends
 * every source's share of every level, so turning one off needs no new subscription.
 */

/** A fixed, colour-blind-friendly categorical palette; a source keeps its colour by its position in the source list. */
export const SOURCE_COLOURS = [
  '#2f7ed8', // blue
  '#e8a33b', // amber
  '#3aa57a', // green
  '#c4568a', // magenta
  '#7b68d8', // violet
  '#4fb3c9', // teal
  '#d0643a', // vermilion
  '#8a8f98', // grey
] as const;

export function sourceColour(index: number): string {
  return SOURCE_COLOURS[((index % SOURCE_COLOURS.length) + SOURCE_COLOURS.length) % SOURCE_COLOURS.length];
}

/** One coloured share of a level. */
export interface MultibookSegment {
  sourceId: string;
  colour: string;
  /** Base units; null = this source's size is unknown (shown as a hatched tick, not counted). */
  size: number | null;
  /** Share of the widest level shown (0–1) — the segment's width. */
  width: number;
}

export interface MultibookRow {
  side: 'bid' | 'ask';
  price: number;
  /** Base units of the enabled sources with known sizes. */
  total: number;
  /** A contributor's size is unknown. */
  partial: boolean;
  segments: MultibookSegment[];
  /** The best bid / ask of the enabled sources. */
  best: boolean;
  /** Sources quoting top of book only (no size) that sit exactly at this price. */
  quotes: { sourceId: string; colour: string }[];
}

export interface MultibookSourceLine {
  sourceId: string;
  name: string;
  colour: string;
  enabled: boolean;
  /** `live` | `stale` | `no-data` | `no-basis`. */
  state: string;
  mode: string;
  kind: string;
  bid: number | null;
  ask: number | null;
  /** Mid − median mid of the live sources, in points (null when not live). */
  devPoints: number | null;
  spreadPoints: number | null;
  ageMs: number;
  lagMs: number;
  levels: number;
  sizeUnit: string;
  sizeKnown: boolean;
  basis: number | null;
}

export interface MultibookView {
  /** Asks (highest first, so the best ask sits just above the bids), then bids (best first). */
  rows: MultibookRow[];
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSources: string[];
  bestAskSources: string[];
  /** Best bid ≥ best ask across the enabled sources. */
  crossed: boolean;
  locked: boolean;
  /** Pairs of enabled sources whose quotes cross / lock. */
  crosses: { bidSource: string; askSource: string; locked: boolean }[];
  /** Spread of mids across the enabled live sources, in points. */
  midRangePoints: number | null;
  sources: MultibookSourceLine[];
  point: number;
  t: number;
}

type RowDraft = Omit<MultibookRow, 'segments'> & { level: MdConsolidatedLevelWire };

const EMPTY: MultibookView = {
  rows: [],
  bestBid: null,
  bestAsk: null,
  bestBidSources: [],
  bestAskSources: [],
  crossed: false,
  locked: false,
  crosses: [],
  midRangePoints: null,
  sources: [],
  point: 0,
  t: 0,
};

/**
 * The view of a consolidated frame for the enabled sources. `colourOrder` fixes each source's colour (pass every source
 * ever seen, in a stable order). `maxRows` per side.
 */
export function buildMultibook(
  c: MdConsolidatedWire | null,
  disabled: ReadonlySet<string>,
  colourOrder: readonly string[],
  maxRows = 20,
): MultibookView {
  if (!c) return EMPTY;
  const colour = (id: string): string => {
    const i = colourOrder.indexOf(id);
    return sourceColour(i < 0 ? colourOrder.length : i);
  };
  const on = (id: string): boolean => !disabled.has(id);
  const point = c.point > 0 ? c.point : 0;
  const pts = (v: number | null): number | null => (v === null || !point ? v : v / point);

  const live = c.sources.filter((s) => on(s.sourceId) && s.state === 'live' && s.bid !== null && s.ask !== null);
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const s of live) {
    if (bestBid === null || s.bid! > bestBid) bestBid = s.bid;
    if (bestAsk === null || s.ask! < bestAsk) bestAsk = s.ask;
  }
  const mids = live.map((s) => (s.bid! + s.ask!) / 2).sort((x, y) => x - y);
  const median = mids.length
    ? mids.length % 2
      ? mids[(mids.length - 1) / 2]
      : (mids[mids.length / 2 - 1] + mids[mids.length / 2]) / 2
    : null;

  const side = (levels: MdConsolidatedLevelWire[], kind: 'bid' | 'ask'): RowDraft[] => {
    const out: RowDraft[] = [];
    for (const l of levels) {
      if (out.length >= maxRows) break;
      let total = 0;
      let partial = false;
      let any = false;
      for (let i = 0; i < l.src.length; i++) {
        if (!on(l.src[i])) continue;
        any = true;
        const sz = l.sz[i];
        if (sz === null || !Number.isFinite(sz)) partial = true;
        else total += sz;
      }
      if (any) out.push({ side: kind, price: l.p, total, partial, best: false, quotes: [], level: l });
    }
    return out;
  };

  const bids = side(c.b, 'bid');
  const asks = side(c.a, 'ask');
  const widest = Math.max(1, ...bids.map((r) => r.total), ...asks.map((r) => r.total));

  const quoteOnly = c.sources.filter((s) => on(s.sourceId) && s.state === 'live' && s.mode === 'quote');
  const toRow = (r: RowDraft): MultibookRow => ({
    side: r.side,
    price: r.price,
    total: r.total,
    partial: r.partial,
    best: r.side === 'bid' ? r.price === bestBid : r.price === bestAsk,
    quotes: quoteOnly
      .filter((s) => (r.side === 'bid' ? s.bid === r.price : s.ask === r.price))
      .map((s) => ({ sourceId: s.sourceId, colour: colour(s.sourceId) })),
    segments: r.level.src
      .map((id, i) => ({ id, sz: r.level.sz[i] }))
      .filter((x) => on(x.id))
      .map((x) => ({
        sourceId: x.id,
        colour: colour(x.id),
        size: x.sz === null || !Number.isFinite(x.sz) ? null : x.sz,
        width: x.sz === null || !Number.isFinite(x.sz) ? 0 : x.sz / widest,
      })),
  });

  const crosses: MultibookView['crosses'] = [];
  for (const a of live)
    for (const b of live) {
      if (a === b) continue;
      if (a.bid! > b.ask!) crosses.push({ bidSource: a.sourceId, askSource: b.sourceId, locked: false });
      else if (a.bid === b.ask) crosses.push({ bidSource: a.sourceId, askSource: b.sourceId, locked: true });
    }

  const sources: MultibookSourceLine[] = c.sources.map((s) => sourceLine(s, on(s.sourceId), colour(s.sourceId), median, point));

  return {
    rows: [...asks.reverse().map(toRow), ...bids.map(toRow)],
    bestBid,
    bestAsk,
    bestBidSources: live.filter((s) => s.bid === bestBid).map((s) => s.sourceId),
    bestAskSources: live.filter((s) => s.ask === bestAsk).map((s) => s.sourceId),
    crossed: bestBid !== null && bestAsk !== null && bestBid > bestAsk,
    locked: bestBid !== null && bestAsk !== null && bestBid === bestAsk,
    crosses,
    midRangePoints: mids.length >= 2 ? pts(mids[mids.length - 1] - mids[0]) : null,
    sources,
    point,
    t: c.t,
  };
}

function sourceLine(
  s: MdConsolidatedSourceWire,
  enabled: boolean,
  colour: string,
  median: number | null,
  point: number,
): MultibookSourceLine {
  const live = s.state === 'live' && s.bid !== null && s.ask !== null;
  const mid = live ? (s.bid! + s.ask!) / 2 : null;
  return {
    sourceId: s.sourceId,
    name: (s.name || s.sourceId).replace(/\s*\([^)]*\)\s*$/, '') || s.sourceId,
    colour,
    enabled,
    state: s.state,
    mode: s.mode,
    kind: s.kind,
    bid: s.bid,
    ask: s.ask,
    devPoints: enabled && mid !== null && median !== null && point ? (mid - median) / point : null,
    spreadPoints: live && point ? (s.ask! - s.bid!) / point : null,
    ageMs: s.ageMs,
    lagMs: s.lagMs,
    levels: s.bidLevels + s.askLevels,
    sizeUnit: s.sizeUnit,
    sizeKnown: s.sizeKnown,
    basis: s.basis,
  };
}

// ── Dispersion strip: each source's mid deviation from the cross-source median over time ─────────────────────────

/** One sample of the strip: engine time and each live source's deviation (points). */
export interface DispersionSample {
  t: number;
  dev: Map<string, number>;
}

/** A bounded ring of dispersion samples (the last {@link STRIP_WINDOW_MS}). Not reactive. */
export class DispersionStrip {
  private samples: DispersionSample[] = [];

  constructor(readonly windowMs = STRIP_WINDOW_MS) {}

  get size(): number {
    return this.samples.length;
  }

  /** Adds the view's deviations (enabled live sources); drops samples older than the window. Same t twice = replaced. */
  push(view: MultibookView): void {
    if (!view.t) return;
    const dev = new Map<string, number>();
    for (const s of view.sources) if (s.devPoints !== null) dev.set(s.sourceId, s.devPoints);
    const last = this.samples[this.samples.length - 1];
    if (last && last.t === view.t) last.dev = dev;
    else if (!last || view.t > last.t) this.samples.push({ t: view.t, dev });
    const cutoff = view.t - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  clear(): void {
    this.samples = [];
  }

  all(): readonly DispersionSample[] {
    return this.samples;
  }

  /** The largest |deviation| in the window (the strip's vertical scale), at least `floor`. */
  maxAbs(floor = 0.5): number {
    let m = floor;
    for (const s of this.samples) for (const v of s.dev.values()) if (Math.abs(v) > m) m = Math.abs(v);
    return m;
  }
}

export const STRIP_WINDOW_MS = 5 * 60_000;

/** "1.2 s", "350 ms", "—". */
export function formatAge(ms: number): string {
  if (!(ms >= 0)) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Signed points with one decimal: "+0.4", "−1.0", "0.0". */
export function formatPoints(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}

/** Plain words for a source state. */
export function stateLabel(state: string): string {
  switch (state) {
    case 'live':
      return 'live';
    case 'stale':
      return 'stale — left out';
    case 'no-basis':
      return 'no futures basis — left out';
    case 'no-data':
      return 'no data';
    default:
      return state;
  }
}
