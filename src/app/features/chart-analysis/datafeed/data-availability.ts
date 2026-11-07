import type { InstrumentDto } from '@core/instruments/instrument.types';

/**
 * Saying where a symbol has no data, and why (multi-asset chart program UD10 + the "no data yet" empty states): from the
 * catalogue's C2 `hasCandles` / `candleSource` / `firstCandleUtc` and chart-bars' C1 `firstBarMs` per timeframe. Pure.
 * Never a silent empty chart, never zeros.
 */

export interface AvailabilityContext {
  /** The catalogue row (C2), when known. */
  instrument: Pick<InstrumentDto, 'hasCandles' | 'candleSource' | 'firstCandleUtc'> | null;
  /** C1 `firstBarMs` for this timeframe: a number, null (the engine said none), undefined (not known yet). */
  firstBarMs: number | null | undefined;
}

/** The note an interval menu row carries: "no data yet", "no stored bars"; null when nothing is known against it. */
export function intervalNote(ctx: AvailabilityContext): string | null {
  if (ctx.instrument?.hasCandles === false) return 'no data yet';
  if (ctx.firstBarMs === null) return 'no stored bars';
  return null;
}

/** The chart's message when a load returned no bars: what is missing and why. */
export function noDataMessage(
  symbol: string,
  intervalLabel: string,
  instrument: AvailabilityContext['instrument'],
): string {
  if (instrument?.hasCandles === false) {
    const src = instrument.candleSource;
    return src
      ? `No data yet for ${symbol}: nothing has been stored from ${src.label} so far.`
      : `No data yet for ${symbol}: no candle source is enabled for it.`;
  }
  const first = instrument?.firstCandleUtc ? Date.parse(instrument.firstCandleUtc) : Number.NaN;
  const since = Number.isFinite(first)
    ? ` (the engine's candles for it start ${new Date(first).toISOString().slice(0, 10)})`
    : '';
  return `No ${intervalLabel} candles stored for ${symbol}${since}.`;
}
