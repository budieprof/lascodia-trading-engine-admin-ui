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
  /** Multibook: on a `consolidated` source's frames, the whole consolidated view (≤ 10 Hz on change, else 1 Hz). */
  consolidated?: MdConsolidatedWire | null;
  /** Engine WS8 8.3: the frame is DELAYED by this many minutes (a delayed-only licence); absent on real-time frames. */
  delayedMinutes?: number | null;
}

// ── Multibook (engine `ConsolidatedBookService`): the consolidated pseudo-source ─────────────────────────────────

/** The consolidated pseudo-source: every enabled source the caller is entitled to. */
export const CONSOLIDATED_SOURCE = 'consolidated';
/** A subset: `consolidated:a,b` (sorted ids). */
export const CONSOLIDATED_PREFIX = 'consolidated:';

export function isConsolidatedId(id: string | null | undefined): boolean {
  return !!id && (id === CONSOLIDATED_SOURCE || id.startsWith(CONSOLIDATED_PREFIX));
}

/** The registry sources a consolidated id names (null = all entitled). */
export function consolidatedSubset(id: string): string[] | null {
  if (id === CONSOLIDATED_SOURCE || !id.startsWith(CONSOLIDATED_PREFIX)) return null;
  return [
    ...new Set(
      id
        .slice(CONSOLIDATED_PREFIX.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/** "Consolidated — all your sources" / "Consolidated — A + B" (registry display names when known). */
export function consolidatedLabel(
  id: string,
  sources: readonly Pick<MdSource, 'sourceId' | 'displayName'>[] | null,
): string {
  const subset = consolidatedSubset(id);
  if (!subset) return 'Consolidated — all your sources';
  const names = subset.map((s) =>
    sourceLabel(sources?.find((x) => x.sourceId === s) ?? { sourceId: s, displayName: '' }),
  );
  return `Consolidated — ${names.join(' + ')}`;
}

/** The canonical consolidated id for `enabled` out of `all` sources (every one enabled = `consolidated`). */
export function consolidatedId(all: readonly string[], enabled: readonly string[]): string {
  const on = [...new Set(enabled)].filter((s) => all.includes(s)).sort();
  if (!on.length || on.length === new Set(all).size) return CONSOLIDATED_SOURCE;
  return CONSOLIDATED_PREFIX + on.join(',');
}

/**
 * One consolidated level: spot price, total size in BASE-CURRENCY UNITS (known sizes only), `partial` when a contributor's
 * size is unknown, and each source's share (`src[i]` holds `sz[i]`; null = unknown size).
 */
export interface MdConsolidatedLevelWire {
  p: number;
  s: number;
  partial: boolean;
  src: string[];
  sz: (number | null)[];
}

export interface MdConsolidatedCrossWire {
  bidSource: string;
  askSource: string;
  bid: number;
  ask: number;
  locked: boolean;
}

/** One source's health in the consolidated view. */
export interface MdConsolidatedSourceWire {
  sourceId: string;
  name: string;
  /** `Mt5Broker` | `CmeFutures` | `FixVenue`. */
  kind: string;
  /** `live` | `stale` | `no-data` | `no-basis`. */
  state: string;
  /** `book` (levels with sizes) | `quote` (top of book only). */
  mode: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** Source stamp of the top shown (epoch ms), -1 none. */
  topT: number;
  /** Server now − the source's newest stamp (ms), -1 unknown. */
  ageMs: number;
  /** Server receive − source stamp of its newest row (ms; includes clock offset), -1 unknown. */
  lagMs: number;
  bidLevels: number;
  askLevels: number;
  sizeUnit: string;
  sizeKnown: boolean;
  /** Mid − the median mid of the live sources (price). */
  dev: number | null;
  /** Futures basis applied (spot = futures − basis). */
  basis: number | null;
}

/** The consolidated view (engine time `t`): prices spot-equivalent, sizes in base-currency units. */
export interface MdConsolidatedWire {
  t: number;
  point: number;
  sizeUnit: string;
  b: MdConsolidatedLevelWire[];
  a: MdConsolidatedLevelWire[];
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSources: string[];
  bestAskSources: string[];
  crossed: boolean;
  locked: boolean;
  crosses: MdConsolidatedCrossWire[];
  medianMid: number | null;
  midRange: number | null;
  sources: MdConsolidatedSourceWire[];
}

/** `GET md/dispersion`: one source's statistics in one minute. */
export interface MdDispersionSourceWire {
  sourceId: string;
  samples: number;
  liveSamples: number;
  staleSamples: number;
  meanMid?: number | null;
  meanDev?: number | null;
  meanAbsDev?: number | null;
  maxAbsDev?: number | null;
  meanSpread?: number | null;
  maxAgeMs: number;
  meanLagMs?: number | null;
  maxLagMs: number;
}

/** `GET md/dispersion`: one minute (aggregates null when a source you may not read took part). */
export interface MdDispersionMinuteWire {
  t: number;
  samples: number;
  sampleIntervalMs: number;
  meanLiveSources: number;
  midRangeMean: number | null;
  midRangeMax: number | null;
  rangeSamples: number | null;
  crossedSamples: number | null;
  lockedSamples: number | null;
  point: number;
  sources: MdDispersionSourceWire[];
}

export interface MdDispersionWire {
  symbol: string;
  minutes: MdDispersionMinuteWire[];
  denied: string[];
}

/** What `Subscribe(symbol, sourceIds, kinds)` answers (C4 + the engine's additive fields). */
export interface MdSubscribeResult {
  ok: boolean;
  denied: string[];
  /** Why each denied feed was refused, by feed id (engine C6: not entitled, plan, licence expired, usage). */
  deniedReasons?: Record<string, string> | null;
  subscribed?: string[];
  unknown?: string[];
  error?: string | null;
  /** Engine WS8 8.3: subscriptions served DELAYED (`sourceId:kind` → minutes) — a delayed-only licence. */
  delayed?: Record<string, number> | null;
}

/** The server event that ends subscriptions whose feed the organisation lost (engine C6, additive to C4). */
export const MD_REVOKED_EVENT = 'mdRevoked';

/** `mdRevoked`: the feeds lost, the subscriptions ended (`SYMBOL|sourceId|kind`) and why. */
export interface MdRevokedWire {
  feeds: string[];
  subscriptions: string[];
  message: string;
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
  /** Multibook: the registry sources a `consolidated` answer was built from. */
  contributors?: string[] | null;
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
  /** Engine WS8 8.3: sources served DELAYED (sourceId → minutes); their rows end at now minus the delay. */
  delayed?: Record<string, number> | null;
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
