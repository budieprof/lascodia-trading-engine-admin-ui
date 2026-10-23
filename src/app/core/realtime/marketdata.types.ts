/**
 * Market-data program wire shapes (engine PROGRAM.md §3): the live hub `/api/hubs/marketdata` (C4), history / replay
 * `POST md/history` (C5) and the source registry `GET md/sources` (C7). Times are epoch ms UTC; book levels are
 * `[price, size]` with size as the SOURCE reports it (an MT5 broker's DOM volume, CME contracts, a venue's units).
 */

export type MdKind = 'ticks' | 'book' | 'trades';

/** C1 tick columns: equal-length arrays, ascending `t`. `f` = MqlTick flags, `v` = volume_real or 0. */
export interface MdTicksWire {
  t: number[];
  b: number[];
  a: number[];
  f?: number[];
  v?: number[];
}

/** One price level: `[price, size]`; size 0 in a `D` event removes the level. */
export type MdLevel = [number, number];

/** A C2 book event: `S` full snapshot (every level), `D` changed levels only. */
export interface MdBookEventWire {
  t: number;
  k: 'S' | 'D';
  b: MdLevel[];
  a: MdLevel[];
}

/** C3 trade columns; side `B` buyer-initiated, `S` seller-initiated, `''` unknown. */
export interface MdTradesWire {
  t: number[];
  p: number[];
  s: number[];
  side: string[];
  id?: (string | null)[] | null;
}

/** A C4 `md` frame: one (symbol, source, kind) coalesced over ≤ 100 ms. */
export interface MdFrame {
  symbol: string;
  sourceId: string;
  ticks?: MdTicksWire | null;
  book?: MdBookEventWire[] | null;
  trades?: MdTradesWire | null;
}

/** What `Subscribe(symbol, sourceIds, kinds)` answers (C4 + the engine's additive fields). */
export interface MdSubscribeResult {
  ok: boolean;
  denied: string[];
  subscribed?: string[];
  unknown?: string[];
  error?: string | null;
}

/** C5 request. */
export interface MdHistoryRequest {
  symbol: string;
  sourceIds?: string[];
  from: number;
  to: number;
  kinds: MdKind[];
  /**
   * Additive (cme-tier2): map FUTURES sources onto the spot symbol (CME 6J/6C/6S inverted with sides swapped, every
   * price minus the basis of its minute). Broker / venue sources are untouched. The API service sends `true`.
   */
  spot?: boolean;
}

/** C5 additive: how a futures source was mapped onto the spot symbol (`spot: true`). */
export interface MdSpotMappingWire {
  root: string;
  inverted: boolean;
  basisAdjusted: boolean;
  rowsWithoutBasis: number;
  basis?: number | null;
  contractSize: number;
  contractCurrency: string;
  /** "CME 6E (futures, basis-adjusted)". */
  label: string;
}

/** C5: the book as it stood at `from` (folded from the latest snapshot ≤ 2 h before it). */
export interface MdKeyframeWire {
  t: number;
  b: MdLevel[];
  a: MdLevel[];
}

export interface MdHistorySourceWire {
  sourceId: string;
  keyframe?: MdKeyframeWire | null;
  ticks?: MdTicksWire | null;
  book?: MdBookEventWire[] | null;
  trades?: MdTradesWire | null;
  /** Additive (cme-tier2): present when a futures source was mapped onto the spot symbol. */
  spot?: MdSpotMappingWire | null;
}

export interface MdHistoryWire {
  sources: MdHistorySourceWire[];
  truncated: boolean;
  denied?: string[];
}

/** C5 answer with the envelope's message (notes: missing keyframe, not entitled, truncated). */
export interface MdHistory extends MdHistoryWire {
  message: string | null;
}

/** C5 caps (engine `GetMarketDataHistoryQuery`). */
export const MD_HISTORY_MAX_BOOK_MS = 2 * 3_600_000;
export const MD_HISTORY_MAX_ROWS = 1_000_000;

/** C7: one registry source the caller is entitled to. */
export interface MdSource {
  sourceId: string;
  /** `Mt5Broker` | `CmeFutures` | `FixVenue`. */
  kind: string;
  displayName: string;
  feedId: string;
  /** Entitled feeds per kind, e.g. `{ ticks: 'broker-ticks', book: 'broker-dom' }`. */
  feeds: Partial<Record<MdKind, string>>;
  enabled: boolean;
  /** `Lots` | `Units` | `Contracts` — what this source's sizes count (as registered). */
  sizeUnit: string;
  contractSize: number;
  priceTransform: string;
  symbolMap: Record<string, string>;
  /** Additive (cme-tier2): per engine symbol, how a FUTURES source maps onto it (null for broker / venue sources). */
  symbols?: MdSourceSymbol[] | null;
}

/** C7 additive (cme-tier2): one engine symbol of a futures source. */
export interface MdSourceSymbol {
  symbol: string;
  /** The source's own symbol (CME root, e.g. 6J). */
  sourceSymbol: string;
  /** `None` | `Invert` (spot = 1 / futures; book sides and trade aggressors swap). */
  priceTransform: string;
  /** Units of `contractCurrency` per contract (sizes are contracts). */
  contractSize: number;
  contractCurrency: string;
  tickSize: number;
  /** The front-month contract now (e.g. 6EZ6). */
  frontContract: string;
  /** "CME 6E (futures, basis-adjusted)". */
  spotLabel: string;
}

// ── cme-tier2: GET md/basis, POST md/orderflow ────────────────────────────────

export interface CmeBasisPoint {
  t: number;
  basis: number | null;
  rolling: number | null;
  samples: number;
  mad: number;
  contract: string;
  /** `ticks` (1-second paired quotes) | `candles` (spot M1 close + half spread). */
  method: string;
}

/** `GET md/basis`: the futures − spot basis a chart subtracts from (transformed) CME prices. */
export interface CmeBasis {
  sourceId: string;
  symbol: string;
  root: string;
  inverted: boolean;
  spotSourceId: string;
  latest: CmeBasisPoint | null;
  ageSeconds: number | null;
  stale: boolean;
  minutes: CmeBasisPoint[];
}

export interface CmeOrderFlowRequest {
  symbol: string;
  sourceId?: string | null;
  from: number;
  to: number;
  barSeconds: number;
  spot?: boolean;
  includeBook?: boolean;
  cvdAnchor?: 'window' | 'session';
  largeLotContracts?: number | null;
}

export interface CmeDeltaBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  buy: number;
  sell: number;
  delta: number;
  cvd: number;
  trades: number;
  /** `[price, buy, sell]` per traded price, ascending. */
  footprint: [number, number, number][];
}

/** An aggressor order (the prints of one side in one millisecond): a trade bubble / large lot. */
export interface CmeAggressorOrder {
  t: number;
  /** `B` buyer-initiated, `S` seller-initiated, `''` unknown (spot terms when mapped). */
  side: string;
  size: number;
  price: number;
  low: number;
  high: number;
  prints: number;
  levels: number;
}

export interface CmeSweep {
  t: number;
  endT: number;
  side: string;
  levels: number;
  size: number;
  fromPrice: number;
  toPrice: number;
  orders: number;
}

export interface CmeLevelEvent {
  t: number;
  endT: number;
  /** The resting side: `bid` | `ask`. */
  side: string;
  price: number;
  volume: number;
  maxDisplayed: number;
  refills: number;
  heldMs: number;
}

export interface CmeOrderFlowThresholds {
  barSeconds: number;
  bubbleMinContracts: number;
  largeLotContracts: number;
  sweepWindowMs: number;
  sweepMinLevels: number;
  icebergMinRatio: number;
  icebergMinContracts: number;
  absorptionMinContracts: number;
  absorptionHoldMs: number;
  episodeIdleMs: number;
  maxItems: number;
}

/** `POST md/orderflow` (research): order-flow analytics of a CME source's real tape + MBP-10 book. */
export interface CmeOrderFlow {
  sourceId: string;
  symbol: string;
  from: number;
  to: number;
  barSeconds: number;
  /** "CME 6E (futures, basis-adjusted)". */
  label: string;
  spot: {
    mapped: boolean;
    inverted: boolean;
    basisAdjusted: boolean;
    basis: number | null;
    rowsWithoutBasis: number;
    sizeUnit: string;
    contractSize: number;
    contractCurrency: string;
  };
  contracts: string[];
  thresholds: CmeOrderFlowThresholds;
  cvdAnchor: string;
  bars: CmeDeltaBar[];
  bubbles: CmeAggressorOrder[];
  largeLots: CmeAggressorOrder[];
  sweeps: CmeSweep[];
  icebergs: CmeLevelEvent[];
  absorptions: CmeLevelEvent[];
  bookAnalysed: boolean;
  notes: string[];
}

/** The kinds a source offers the caller. */
export function sourceKinds(s: MdSource): MdKind[] {
  return (['ticks', 'book', 'trades'] as const).filter((k) => !!s.feeds?.[k]);
}

/** A short label for a source: its display name without the trailing "(MT5 broker)" style suffix. */
export function sourceLabel(
  s: Pick<MdSource, 'displayName' | 'sourceId'> | null | undefined,
): string {
  if (!s) return 'unknown source';
  const name = (s.displayName || s.sourceId).replace(/\s*\([^)]*\)\s*$/, '').trim();
  return name || s.sourceId;
}
