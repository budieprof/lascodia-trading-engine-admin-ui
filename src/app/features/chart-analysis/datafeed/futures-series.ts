import type { ChartMarker } from '../chart/chart-host.component';

/**
 * Continuous futures and their rolls on the chart (multi-asset chart program UD11). The engine stitches `ES1!`
 * (back-adjusted) and `ES1!U` (unadjusted) from the contracts' candles and records every roll
 * (`GET instrument-candles/state?symbol=ES` → `rolls`: from / to contract, roll instant, gap, ratio). Pure.
 *
 * The live engine holds no futures trades yet (0 rolls): the chart then says so ("no rolls recorded") instead of an
 * unexplained empty series; the markers appear as soon as the engine records rolls.
 */

export interface ContinuousInfo {
  root: string;
  adjusted: boolean;
  /** The other series of the pair: `ES1!U` for `ES1!` and back. */
  counterpart: string;
}

/** `ES1!` → back-adjusted, `ES1!U` → unadjusted; null for any other symbol. */
export function continuousInfo(symbol: string | null | undefined): ContinuousInfo | null {
  const m = /^([A-Z0-9]{1,4})1!(U)?$/.exec((symbol ?? '').trim().toUpperCase());
  if (!m) return null;
  const adjusted = !m[2];
  return { root: m[1], adjusted, counterpart: adjusted ? `${m[1]}1!U` : `${m[1]}1!` };
}

/** One roll as the engine records it (`ContinuousFutureRollDto`). */
export interface FutureRoll {
  continuousSymbol: string;
  root: string;
  fromContract: string;
  toContract: string;
  rollUtc: string;
  gap: number;
  ratio: number;
}

/**
 * A marker per roll of `symbol`'s series, on the bar holding the roll instant (the newest bar opening at or before it);
 * rolls outside the loaded bars are left out. The text says which contracts and the price gap the back-adjustment
 * removed (unadjusted: the gap the series jumps by).
 */
export function rollMarkers(
  rolls: readonly FutureRoll[],
  info: ContinuousInfo,
  bars: readonly { time: number }[],
  digits: number,
): ChartMarker[] {
  if (!bars.length) return [];
  const out: ChartMarker[] = [];
  for (const r of rolls) {
    if ((r.root ?? '').toUpperCase() !== info.root) continue;
    const at = Date.parse(r.rollUtc);
    if (!Number.isFinite(at) || at < bars[0].time) continue;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].time <= at) lo = mid;
      else hi = mid - 1;
    }
    const gap = Number.isFinite(r.gap) ? r.gap : 0;
    out.push({
      time: bars[lo].time,
      position: 'aboveBar',
      shape: 'square',
      color: '#7e57c2',
      text: `Roll ${r.fromContract}→${r.toContract} (${info.adjusted ? 'adjusted by' : 'gap'} ${gap >= 0 ? '+' : ''}${gap.toFixed(digits)})`,
    });
  }
  return out;
}
