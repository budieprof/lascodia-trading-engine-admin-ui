import type {
  MdBookEventWire,
  MdFrame,
  MdLevel,
  MdSource,
  MdSourceSymbol,
  MdTicksWire,
  MdTradesWire,
} from './marketdata.types';

/**
 * CME futures on the SPOT chart (market-data program, cme-tier2) — the live half of the engine's `CmeSpotMapping`
 * (history reads arrive already mapped: `md/history` with `spot: true`). The store and the hub carry what CME published
 * (futures prices, contracts); a chart of EURUSD / USDJPY needs them in spot terms:
 * - **Inversion** (6J/6C/6S quote USD per JPY/CAD/CHF; the spot pairs are USDxxx): spot = 1 / futures. The book's sides
 *   swap (a futures bid to buy JPY is an offer of USD), so do a trade's aggressor and the MT5 tick bid/ask flags.
 * - **Basis**: spot-equivalent = transformed price − basis (`GET md/basis`, rolling median of CME mid − spot mid). Unknown
 *   basis (not estimated yet): transformed only, and every legend says "not basis-adjusted".
 * Sizes stay contracts. Pure functions; `spec` pins them to the engine's test vectors.
 */

export interface SpotMapping {
  inverted: boolean;
  /** Spot price units; null = not known yet (mapped without it). */
  basis: number | null;
}

const TICK_FLAG_BID = 2;
const TICK_FLAG_ASK = 4;

export function mapPrice(p: number, m: SpotMapping): number {
  if (!(p > 0)) return p;
  return (m.inverted ? 1 / p : p) - (m.basis ?? 0);
}

function mapLevels(levels: readonly MdLevel[], m: SpotMapping): MdLevel[] {
  return levels.map(([p, s]) => [mapPrice(p, m), s] as MdLevel);
}

/** Book event: inverted → futures asks become spot bids (best-first order holds: lowest ask = highest 1/p). */
export function mapBookEvent(e: MdBookEventWire, m: SpotMapping): MdBookEventWire {
  return m.inverted
    ? { t: e.t, k: e.k, b: mapLevels(e.a ?? [], m), a: mapLevels(e.b ?? [], m) }
    : { t: e.t, k: e.k, b: mapLevels(e.b ?? [], m), a: mapLevels(e.a ?? [], m) };
}

export function mapTicks(t: MdTicksWire, m: SpotMapping): MdTicksWire {
  const n = t.t.length;
  const b = new Array<number>(n);
  const a = new Array<number>(n);
  const f = t.f ? new Array<number>(n) : undefined;
  for (let i = 0; i < n; i++) {
    if (m.inverted) {
      b[i] = mapPrice(t.a[i], m);
      a[i] = mapPrice(t.b[i], m);
      if (f && t.f) {
        const fl = t.f[i];
        f[i] =
          (fl & ~(TICK_FLAG_BID | TICK_FLAG_ASK)) |
          (fl & TICK_FLAG_BID ? TICK_FLAG_ASK : 0) |
          (fl & TICK_FLAG_ASK ? TICK_FLAG_BID : 0);
      }
    } else {
      b[i] = mapPrice(t.b[i], m);
      a[i] = mapPrice(t.a[i], m);
      if (f && t.f) f[i] = t.f[i];
    }
  }
  return { t: t.t, b, a, f, v: t.v };
}

export function swapSide(side: string): string {
  return side === 'B' ? 'S' : side === 'S' ? 'B' : side;
}

export function mapTrades(t: MdTradesWire, m: SpotMapping): MdTradesWire {
  return {
    t: t.t,
    p: t.p.map((p) => mapPrice(p, m)),
    s: t.s,
    side: m.inverted ? t.side.map(swapSide) : t.side,
    id: t.id,
  };
}

export function mapFrame(f: MdFrame, m: SpotMapping): MdFrame {
  return {
    symbol: f.symbol,
    sourceId: f.sourceId,
    ticks: f.ticks ? mapTicks(f.ticks, m) : f.ticks,
    book: f.book ? f.book.map((e) => mapBookEvent(e, m)) : f.book,
    trades: f.trades ? mapTrades(f.trades, m) : f.trades,
  };
}

/** The futures spec of `symbol` on a source (C7 `symbols`), or null for broker / venue sources and unmapped symbols. */
export function futuresSymbolOf(source: MdSource | null | undefined, symbol: string): MdSourceSymbol | null {
  if (!source || source.kind !== 'CmeFutures') return null;
  const s = symbol.toUpperCase();
  return source.symbols?.find((x) => x.symbol.toUpperCase() === s) ?? null;
}

/** The legend of a CME source drawn on the spot chart. */
export function cmeSpotLabel(root: string, basisAdjusted: boolean, contract?: string | null): string {
  return `CME ${root}${contract ? ` ${contract}` : ''} (futures, ${basisAdjusted ? 'basis-adjusted' : 'not basis-adjusted'})`;
}
