/**
 * Quantities, each with its unit (engine UNITS change).
 *
 * Pine counts a position in contracts, and on the engine one contract is one unit of the
 * underlying, as on TradingView: 100,000 units is one standard EURUSD lot. The engine converts to
 * broker lots only where an order reaches a broker, so the trade sizes, position sizes and order
 * quantities of a Pine run — backtest, preview, replay, live emulator — are units, while a broker's
 * positions and orders stay in lots. The console prints every quantity with its unit so the two
 * never read alike: a bare "100000" next to a bare "1.00" is exactly the confusion to avoid.
 */

const MINUS = '−';

const UNITS_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const LOTS_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A Pine quantity: "100,000 units", "1 unit", "0.5 units"; a negative one (a short position size)
 * carries a real minus. Up to four decimals, trailing zeros dropped.
 */
export function formatUnits(qty: number): string {
  const body = UNITS_FORMAT.format(Math.abs(qty));
  const sign = qty < 0 && body !== '0' ? MINUS : '';
  return `${sign}${body} ${body === '1' ? 'unit' : 'units'}`;
}

/** A broker quantity: "1.00 lot", "0.50 lots" (two decimals, the lot step brokers quote). */
export function formatLots(lots: number): string {
  const body = LOTS_FORMAT.format(Math.abs(lots));
  const sign = lots < 0 && body !== '0.00' ? MINUS : '';
  return `${sign}${body} ${body === '1.00' ? 'lot' : 'lots'}`;
}
