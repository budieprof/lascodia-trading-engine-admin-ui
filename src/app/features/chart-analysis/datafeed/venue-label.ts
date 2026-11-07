import type { InstrumentDto } from '@core/instruments/instrument.types';
import { isExchangeTraded } from '@features/venues/venues.logic';
import type { ChartSource } from './chart-facts';

/**
 * US08: venue words never contradict where the bars come from. An instrument row's `exchange` is whichever reference
 * sync created it (BTC-USD's says BINANCE), not the feed the chart's candles are read from (Coinbase Advanced Trade).
 * So the VENUE shown is the candle source; the listing exchange is shown only where it differs from it, and then as a
 * reference ("ref: Binance") — and a description's trailing "(Binance)" is that same reference, so it goes.
 */

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** An exchange name as words: all-caps names of five letters or more read as names (BINANCE → Binance). */
export function exchangeName(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length >= 5 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Whether `exchange` names the same venue as the candle source (`COINBASE` ~ "Coinbase Advanced Trade" / `crypto-coinbase`). */
export function sameVenue(exchange: string | null | undefined, source: Pick<ChartSource, 'id' | 'label'> | null | undefined): boolean {
  const e = norm(exchange);
  if (!e || !source) return false;
  return norm(source.label).includes(e) || norm(source.id).includes(e) || e.includes(norm(source.label));
}

/**
 * The listing exchange to show beside the source, or null: none on the row, OTC, an MT5 / CFD row (it lists nowhere),
 * or the same venue as the source.
 */
export function referenceExchange(
  inst: Pick<InstrumentDto, 'exchange'> & Partial<InstrumentDto> | null | undefined,
  source: Pick<ChartSource, 'id' | 'label'> | null | undefined,
): string | null {
  const exchange = (inst?.exchange ?? '').trim();
  if (!exchange || exchange.toUpperCase() === 'OTC') return null;
  if (inst && 'assetClass' in inst && inst.assetClass && !isExchangeTraded(inst as InstrumentDto)) return null;
  if (sameVenue(exchange, source)) return null;
  return exchangeName(exchange);
}

/** A description without a trailing "(<listing exchange>)": the venue is said by the source (and the ref chip). */
export function withoutListingSuffix(description: string, exchange: string | null | undefined): string {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(description);
  if (!m || !norm(exchange) || norm(m[2]) !== norm(exchange)) return description;
  return m[1];
}

/** A search / watchlist row's venue words: the source, then "ref: <listing>" where it differs; null when neither. */
export function venueWords(source: string | null, reference: string | null): string | null {
  if (source && reference) return `${source} · ref: ${reference}`;
  if (source) return source;
  return reference ? `ref: ${reference}` : null;
}
