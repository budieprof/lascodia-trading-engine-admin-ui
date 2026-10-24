/**
 * The engine's instrument master (multi-asset program WS1, phase 1 contract `briefs/p1.md`).
 *
 * `GET instruments?assetClass=&search=&exchange=` and `GET instruments/{symbol}` answer {@link InstrumentDto};
 * `GET calendars/{code}` answers {@link TradingCalendarDto}; `GET instruments/{symbol}/session-state?at=` answers
 * {@link SessionStateDto}. Until the engine serves them the console derives an FX instrument from each currency pair
 * (`instrumentFromCurrencyPair`), so every FX number it shows is the one it showed before.
 */

export type InstrumentAssetClass =
  | 'Fx'
  | 'Future'
  | 'Crypto'
  | 'Equity'
  | 'Index'
  | 'Commodity'
  | 'Etf';

export type QuantityUnit = 'Lots' | 'Contracts' | 'Shares' | 'Coins';

/** The unit a price distance is shown in: pips only for FX. */
export type DisplayDistance = 'Pips' | 'Ticks' | 'Points' | 'Cents' | 'Bps';

export interface FutureInstrumentInfo {
  root: string;
  contractCode: string;
  expiry: string | null;
  lastTradeDate: string | null;
  isFront: boolean;
  continuousSymbol: string | null;
}

export interface CryptoInstrumentInfo {
  kind: 'Spot' | 'Perpetual';
  settleAsset: string | null;
  fundingIntervalHours: number | null;
}

export interface EquityInstrumentInfo {
  primaryExchange: string | null;
  shortable: boolean;
}

export interface InstrumentDto {
  symbol: string;
  assetClass: InstrumentAssetClass;
  exchange: string | null;
  description: string | null;
  quoteCurrency: string | null;
  baseCurrency?: string | null;
  /** Smallest price increment, in price units. */
  tickSize: number;
  /** Money (quote currency) one tick is worth on ONE quantity unit. */
  tickValue: number;
  /** Units of the underlying per quantity unit (contract size; 100 000 for an FX lot). */
  multiplier: number;
  quantityUnit: QuantityUnit;
  quantityStep: number;
  minQuantity: number;
  maxQuantity: number;
  priceDecimals: number;
  displayDistance: DisplayDistance;
  tradingCalendarCode: string | null;
  status: string | null;
  future?: FutureInstrumentInfo | null;
  crypto?: CryptoInstrumentInfo | null;
  equity?: EquityInstrumentInfo | null;
}

export type CalendarSessionKind = 'Regular' | 'Pre' | 'Post' | 'Maintenance';

export interface CalendarSessionDto {
  /**
   * The weekday the session OPENS on: `Sunday` … `Saturday` (or 0 = Sunday … 6). A session whose close is at or
   * before its open runs overnight and closes the next day.
   */
  day: string | number;
  /** `HH:mm` on the calendar's clock. */
  open: string;
  close: string;
  kind: CalendarSessionKind;
}

export interface CalendarHolidayDto {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm` when the market closes early that day; absent = closed all day. */
  earlyClose?: string | null;
}

export interface TradingCalendarDto {
  code: string;
  timeZone: string;
  is24x7: boolean;
  sessions: CalendarSessionDto[];
  holidays: CalendarHolidayDto[];
}

export interface SessionStateDto {
  open: boolean;
  sessionKind: CalendarSessionKind | null;
  nextOpen: string | null;
  nextClose: string | null;
  tradingDay: string | null;
}
