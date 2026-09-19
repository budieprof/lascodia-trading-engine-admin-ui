import type { CurrencyPairDto } from '@core/api/api.types';
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
  type: 'forex';
  session: string;
  timezone: 'Etc/UTC';
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

export function toSymbolInfo(pair: CurrencyPairDto): LascodiaSymbolInfo {
  const symbol = pair.symbol ?? '';
  const description =
    pair.baseCurrency && pair.quoteCurrency ? `${pair.baseCurrency}/${pair.quoteCurrency}` : symbol;

  return {
    name: symbol,
    ticker: symbol,
    description,
    type: 'forex',
    session: FOREX_SESSION,
    timezone: 'Etc/UTC',
    exchange: 'Lascodia',
    listed_exchange: 'Lascodia',
    format: 'price',
    minmov: 1,
    pricescale: priceScaleFor(pair.decimalPlaces),
    has_intraday: true,
    has_weekly_and_monthly: true,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    // Engine candle volume is broker tick volume — whole numbers.
    volume_precision: 0,
    data_status: 'streaming',
  };
}
