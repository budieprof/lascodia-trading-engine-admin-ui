import { isConsolidatedId, sourceLabel, type MdSource } from '@core/realtime/marketdata.types';
import { quantityWord, type InstrumentFacts } from '../datafeed/instrument-facts';

/**
 * UF03 — what the DOM ladder's book IS, in words, and the ladder's order / position sizes in the instrument's unit.
 * An MT5 symbol keeps exactly the words and numbers it always had; a venue book names the venue, says it is that
 * venue's L2 book and in which unit its sizes are. Pure.
 */

export type LadderBookMode = 'stream' | 'poll' | 'connecting' | 'none';

/** Whether a source is a venue's own book (a crypto exchange or a FIX venue), not a broker's MT5 DOM. */
export function isVenueBook(src: Pick<MdSource, 'kind'> | null | undefined): boolean {
  return src?.kind === 'CryptoExchange' || src?.kind === 'FixVenue';
}

/**
 * The ladder's source line. `sourceId` = the source whose book is shown; `source` = its registry row (null while
 * `md/sources` has not answered, or for an id the registry does not list); `unit` = the size word of a venue book.
 */
export function ladderSourceLabel(
  mode: LadderBookMode,
  sourceId: string | null,
  source: MdSource | null,
  unit: string | null,
): string {
  switch (mode) {
    case 'stream': {
      if (isConsolidatedId(sourceId))
        return 'Consolidated book of your sources (spot prices, sizes in base-currency units summed across sources, every change).';
      if (isVenueBook(source))
        return `Live ${sourceLabel(source)} book (the venue's own L2 depth, every change${unit ? `; sizes in ${unit}` : ''}) — one venue, not the whole market.`;
      if (source?.kind === 'CmeFutures')
        return `Live CME book from ${sourceLabel(source)} (futures depth in spot terms, every change; sizes in contracts) — not the spot market.`;
      return `Live book from ${sourceId ?? 'the broker'} (one broker's MT5 depth, every change) — not the whole market.`;
    }
    case 'poll':
      return `Broker depth polled every 1.5 s (the live stream is not available) — one broker's MT5 book.`;
    case 'connecting':
      return 'Connecting to the market-data stream…';
    default:
      return 'No depth for this symbol.';
  }
}

/** Facts that size a quantity in the instrument's unit (a catalogue row); null keeps the MT5 lot text unchanged. */
function venueFacts(f: InstrumentFacts | null | undefined): InstrumentFacts | null {
  return f && !f.resolving && f.origin !== 'pair' ? f : null;
}

/** A chip / position-tag number: MT5 as it always was (`0.1`); a venue quantity at its step's decimals (`0.015`). */
export function ladderQuantityText(qty: number | null | undefined, f: InstrumentFacts | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return '·';
  const v = venueFacts(f);
  return v ? qty.toFixed(v.quantityDecimals) : String(qty);
}

/** The same quantity with its unit, for a title: `0.10 lots` (MT5), `0.015 BTC`, `2 contracts`, `10 shares`. */
export function ladderQuantityTitle(qty: number | null | undefined, f: InstrumentFacts | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return '';
  const v = venueFacts(f);
  if (!v) return `${qty} lot${qty === 1 ? '' : 's'}`;
  return `${qty.toFixed(v.quantityDecimals)} ${quantityWord(v, qty)}`;
}
