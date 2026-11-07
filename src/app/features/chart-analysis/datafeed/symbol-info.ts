/**
 * Symbol helpers the chart page still needs: the price scale and the symbol search's ranking.
 *
 * Everything else that used to live here moved (multi-asset chart program UI08): the pip / tick / point and every
 * other instrument fact come from `instrument-facts.ts` (the ONE source); the TradingView `LibrarySymbolInfo` builder
 * (`toSymbolInfo`, `FOREX_SESSION`) was never wired — the chart is Lightweight Charts, its session comes from the
 * engine's chart-bars answer — and was deleted rather than left to drift.
 */

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
