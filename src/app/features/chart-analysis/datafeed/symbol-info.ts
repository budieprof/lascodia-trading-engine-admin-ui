import type { CurrencyPairDto } from '@core/api/api.types';
import { pineSessionFromCalendar } from '@core/instruments/calendar-session';
import {
  assetClassFromEngine,
  fxPipSize,
  instrumentFromCurrencyPair,
  normaliseDecimals,
} from '@core/instruments/instrument-math';
import type {
  InstrumentAssetClass,
  InstrumentDto,
  TradingCalendarDto,
} from '@core/instruments/instrument.types';
import { SUPPORTED_RESOLUTIONS } from './resolution';

/**
 * The subset of TradingView's `LibrarySymbolInfo` we populate.
 *
 * Declared locally rather than imported from the charting library's types: the
 * library is proprietary, vendored at build time and absent from a fresh clone
 * (see docs/CHART_ANALYSIS_PLAN.md §1.2), so importing its types here would make
 * `npm test` and the production build depend on files that are not in the repo.
 * The datafeed boundary casts to the real type once the library is present.
 */
export interface LascodiaSymbolInfo {
  name: string;
  ticker: string;
  description: string;
  type: LibrarySymbolType;
  session: string;
  /** IANA zone of `session` (`Etc/UTC` for FX, as always). */
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: 'price';
  minmov: number;
  pricescale: number;
  has_intraday: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: readonly string[];
  volume_precision: number;
  data_status: 'streaming';
}

/** TradingView's `LibrarySymbolInfo.type` values the console uses. */
export type LibrarySymbolType =
  | 'forex'
  | 'futures'
  | 'crypto'
  | 'stock'
  | 'index'
  | 'commodity'
  | 'fund';

const LIBRARY_TYPE: Record<InstrumentAssetClass, LibrarySymbolType> = {
  Fx: 'forex',
  Future: 'futures',
  Crypto: 'crypto',
  Equity: 'stock',
  Etf: 'fund',
  Index: 'index',
  Commodity: 'commodity',
};

/**
 * FX trades continuously from Sunday's open to Friday's close, so the session is
 * five 24-hour days and NOT `24x7`.
 *
 * With `24x7` the library reserves space for Saturday bars that will never
 * arrive and renders the weekend as a gap in the data rather than a closed
 * market — every week gets a visible hole and the time axis drifts out of step
 * with other platforms.
 *
 * `1` = Sunday … `6` = Friday in TradingView's day numbering, matching the
 * Sunday→Friday week the engine's D1 bars actually contain.
 */
export const FOREX_SESSION = '0000-0000:123456';

/**
 * Price scale from the pair's decimal places: 5 decimals → 100000, JPY pairs
 * (3 decimals) → 1000.
 *
 * Derived from `CurrencyPairDto.decimalPlaces` rather than hardcoded per symbol,
 * because a wrong scale does not error — it renders every price at the wrong
 * precision, which on a JPY pair looks like a plausible number and on EURUSD
 * looks like a rounding bug.
 */
export function priceScaleFor(decimalPlaces: number): number {
  const digits =
    Number.isFinite(decimalPlaces) && decimalPlaces > 0 ? Math.trunc(decimalPlaces) : 5;
  return 10 ** digits;
}

/**
 * One pip, in price, from the quote's decimals — the engine's rule (`InstrumentMath.ResolvePipSize`):
 * for FX a pip is ten points on today's fractional quotes (5 decimals → 0.0001, JPY's 3 → 0.01) and
 * one point on the old 4- and 2-decimal ones; for anything else (`assetClass` an index, a commodity,
 * crypto) a pip is the point. An unknown asset class counts as FX, as the engine counts it.
 */
export function pipSizeFor(decimalPlaces: number, assetClass?: string | null): number {
  // One rule book (core/instruments): FX → the FX pip, anything else → the point.
  return assetClassFromEngine(assetClass) === 'Fx'
    ? fxPipSize(decimalPlaces)
    : 10 ** -normaliseDecimals(decimalPlaces);
}

/**
 * The symbol search's matches, best first (CC-I13): the symbol itself, then symbols that start with
 * the query, then any that contain it — each group in its list order. Typing "usd" lists USDJPY and
 * USDCHF before EURUSD, and Enter takes the first.
 */
export function rankSymbols<T extends { symbol: string | null }>(
  all: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toUpperCase();
  if (!q) return [...all];
  const exact: T[] = [];
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const p of all) {
    const s = (p.symbol ?? '').toUpperCase();
    if (s === q) exact.push(p);
    else if (s.startsWith(q)) prefix.push(p);
    else if (s.includes(q)) contains.push(p);
  }
  return [...exact, ...prefix, ...contains];
}

/**
 * The library's symbol info for an instrument (or today's currency pair, read as its FX instrument), its session from
 * the instrument's trading calendar when one is given.
 *
 * FX is unchanged: an `fx-24x5` instrument keeps the library's UTC weekday session ({@link FOREX_SESSION} in `Etc/UTC`)
 * the chart has always declared — the calendar's own form (`1700-1700:23456` New York) is what the day-based studies
 * use (`session-calendar.ts`), but moving the library's bar boundaries is not part of this change. Without a calendar a
 * non-FX instrument is declared 24×7 in UTC (a closed market then shows as missing bars, never as a shifted axis).
 */
export function toSymbolInfo(
  source: CurrencyPairDto | InstrumentDto,
  calendar?: TradingCalendarDto | null,
): LascodiaSymbolInfo {
  const inst: InstrumentDto = 'tickSize' in source ? source : instrumentFromCurrencyPair(source);
  const symbol = inst.symbol;
  const description =
    inst.baseCurrency && inst.quoteCurrency
      ? `${inst.baseCurrency}/${inst.quoteCurrency}`
      : inst.description || symbol;
  const fx24x5 = inst.assetClass === 'Fx' && (inst.tradingCalendarCode ?? 'fx-24x5') === 'fx-24x5';
  const fromCalendar = fx24x5 ? null : pineSessionFromCalendar(calendar);
  const exchange = inst.exchange || 'Lascodia';
  const pricescale = priceScaleFor(inst.priceDecimals);

  return {
    name: symbol,
    ticker: symbol,
    description,
    type: LIBRARY_TYPE[inst.assetClass] ?? 'forex',
    session: fromCalendar?.session ?? (fx24x5 || inst.assetClass === 'Fx' ? FOREX_SESSION : '24x7'),
    timezone: fromCalendar?.timeZone ?? 'Etc/UTC',
    exchange,
    listed_exchange: exchange,
    format: 'price',
    // The tick in price-scale steps: 1 for FX (tick = point), 25 for a 0.25-tick future at 2 decimals.
    minmov: Math.max(1, Math.round((inst.tickSize || 0) * pricescale)),
    pricescale,
    has_intraday: true,
    has_weekly_and_monthly: true,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    // Engine candle volume is broker tick volume — whole numbers.
    volume_precision: 0,
    data_status: 'streaming',
  };
}
