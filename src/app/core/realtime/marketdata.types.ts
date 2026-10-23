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
  /** Why each denied feed was refused, by feed id (engine C6: not entitled, plan, licence expired, usage). */
  deniedReasons?: Record<string, string> | null;
  subscribed?: string[];
  unknown?: string[];
  error?: string | null;
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
