import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import { isFuturesContractCode } from '@core/instruments/instrument-math';
import { continuousInfo } from '../datafeed/futures-series';
import { parseSynthetic, syntheticSymbol } from '../compare/synthetic';

/**
 * US07: what the chart remembers things BY — drawings, the per-symbol layout memory. A symbol is not always the
 * instrument the operator means: a level drawn on ESZ6 is a level on the S&P future, and must still be there on ESH7
 * after the roll, and on ES1! / ES1!U (the continuous series). So:
 *
 * - a futures contract (`ESZ6`, `CLF26`, `6EH6`) and the continuous series (`ES1!`, `ES1!U`) → the continuous root
 *   `ES1!`;
 * - a synthetic (`ratio(eurusd,gbpusd)`) → its canonical spelling;
 * - anything else → the engine symbol, upper case (FX, CFDs, crypto: the engine's names are already canonical — the
 *   EA maps broker suffixes away).
 *
 * `assetClass`, when the catalogue knows it, keeps a non-future that happens to look like a contract code its own.
 */
export function instrumentKey(symbol: string | null | undefined, assetClass?: InstrumentAssetClass | null): string {
  const s = (symbol ?? '').trim().toUpperCase();
  if (!s) return s;
  const synthetic = parseSynthetic(s);
  if (synthetic) return syntheticSymbol(synthetic);
  const continuous = continuousInfo(s);
  if (continuous) return `${continuous.root}1!`;
  if ((!assetClass || assetClass === 'Future') && isFuturesContractCode(s))
    return `${s.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '')}1!`;
  return s;
}

/** The keys a symbol memory / a layout accepts (engine symbols, continuous `ES1!`, synthetic `RATIO(A,B)`). */
export const KEY_PATTERN = /^[A-Z0-9._!(),-]{1,40}$/i;
