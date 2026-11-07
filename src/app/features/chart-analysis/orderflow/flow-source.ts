import { futuresSymbolOf } from '@core/realtime/cme-spot';
import { sourceLabel, type MdSource, type MdSourceSymbol } from '@core/realtime/marketdata.types';

/**
 * Where the chart's order flow comes from (multi-asset chart program UF01/UF02). Three kinds of data, one set of layers:
 *
 * - `cme`    — a CME futures source's REAL aggressor-tagged tape + MBP-10 book (`md/orderflow`), mapped onto the spot
 *              symbol; sizes in contracts.
 * - `crypto` — a crypto exchange's REAL aggressor-tagged trades + L2 book (`md/crypto/orderflow`), the market's own
 *              prices; sizes in the base coin.
 * - none     — the chart's tick flow (`chart-flow/tick-bars`, C4): trades where the venue symbol's source publishes them
 *              (`deltaSource: "trades"`), else the tick rule over quotes — ESTIMATED.
 *
 * Pure: the page's sources list in, a decision out.
 */

export type RealFlowVenue = 'cme' | 'crypto';

export interface RealFlowSource {
  venue: RealFlowVenue;
  source: MdSource;
  /** CME only: how the futures source maps onto the spot symbol. */
  spec: MdSourceSymbol | null;
  /** The operator picked this source in the Order-flow menu (it then drives the CVD pane and the footprint). */
  picked: boolean;
}

/** A crypto exchange source (`md/sources` kind `CryptoExchange`). */
export function isCryptoSource(s: Pick<MdSource, 'kind'> | null | undefined): boolean {
  return s?.kind === 'CryptoExchange';
}

/** Whether a crypto source streams `symbol` (its symbol map is keyed by the engine symbol). */
export function cryptoCarries(s: MdSource | null | undefined, symbol: string): boolean {
  if (!s || !isCryptoSource(s) || !symbol) return false;
  const want = symbol.toUpperCase();
  return Object.keys(s.symbolMap ?? {}).some((k) => k.toUpperCase() === want);
}

/**
 * Whether a source can carry `symbol` at all: a CME source only for its mapped spot symbols, a crypto source only for
 * the symbols in its map; any other source (MT5 broker, FIX venue) as before — an empty map there means "every symbol".
 */
export function sourceCarries(s: MdSource | null | undefined, symbol: string): boolean {
  if (!s) return false;
  if (s.kind === 'CmeFutures') return futuresSymbolOf(s, symbol) !== null;
  if (isCryptoSource(s)) return cryptoCarries(s, symbol);
  const keys = Object.keys(s.symbolMap ?? {});
  if (keys.length === 0) return true;
  const want = symbol.toUpperCase();
  return keys.some((k) => k.toUpperCase() === want);
}

/**
 * The real order-flow source for `symbol`:
 * 1. the picked source when it is a CME source mapping the symbol or a crypto source streaming it (`picked: true`);
 * 2. else the symbol's pinned candle source when it is a crypto source streaming it (the instrument's own venue);
 * 3. else the first crypto source streaming it;
 * 4. else the first CME source mapping it.
 * Null when no source the organisation may see publishes real trades for the symbol (spot FX brokers have no tape).
 */
export function realFlowSource(
  list: readonly MdSource[] | null,
  symbol: string,
  pickedId: string | null,
  pinnedId: string | null = null,
): RealFlowSource | null {
  if (!list?.length || !symbol) return null;
  const picked = pickedId ? list.find((s) => s.sourceId === pickedId) : undefined;
  if (picked) {
    const spec = futuresSymbolOf(picked, symbol);
    if (spec) return { venue: 'cme', source: picked, spec, picked: true };
    if (cryptoCarries(picked, symbol)) return { venue: 'crypto', source: picked, spec: null, picked: true };
  }
  const pinned = pinnedId ? list.find((s) => s.sourceId === pinnedId) : undefined;
  if (pinned && cryptoCarries(pinned, symbol)) return { venue: 'crypto', source: pinned, spec: null, picked: false };
  const crypto = list.find((s) => cryptoCarries(s, symbol));
  if (crypto) return { venue: 'crypto', source: crypto, spec: null, picked: false };
  for (const s of list) {
    const spec = futuresSymbolOf(s, symbol);
    if (spec) return { venue: 'cme', source: s, spec, picked: false };
  }
  return null;
}

/** The size word of a real source's volumes: `contracts` (CME), the base coin (`BTC`) or `coins`. */
export function realFlowUnit(src: Pick<RealFlowSource, 'venue'>, baseCurrency?: string | null): string {
  if (src.venue === 'cme') return 'contracts';
  return baseCurrency?.trim() ? baseCurrency.trim().toUpperCase() : 'coins';
}

/** "Coinbase BTC-USD (exchange trades)" — the legend of a crypto source's real flow. */
export function cryptoFlowLabel(src: Pick<MdSource, 'displayName' | 'sourceId'>, symbol: string): string {
  return `${sourceLabel(src)} ${symbol.toUpperCase()} (exchange trades)`;
}

/**
 * A traded volume for a cell / hover: integers as they are, fractions to 3 significant digits (0.0153 BTC, 1.25,
 * 12.4), large values grouped (1,250). Never scientific notation.
 */
export function formatFlowVolume(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (Number.isInteger(v) || a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  const digits = Math.min(8, Math.max(0, 2 - Math.floor(Math.log10(a))));
  // Trailing zeros dropped by hand: Number(...) would print 2e-8 for a satoshi-sized fraction.
  return v.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
