import type { TickBarsDto } from './orderflow.types';

/**
 * UF02 — what a tick-flow answer (C4 `chart-flow/tick-bars`) is built from, in words. Data honesty: real aggressor
 * trades are called "trade delta"; everything the tick rule produced (every MT5 symbol, a quote-only venue, or a venue
 * whose prints carry no side) says "estimated (tick rule)". Pure, so the captions are pinned by tests.
 */

/** How the answer's delta was made. */
export type FlowOrigin =
  /** The aggressor side of every print, as the venue reported it. */
  | 'trades'
  /** The tick rule over TRADE prices (some prints carry no side); sizes are still traded volume. */
  | 'tickRuleTrades'
  /** The tick rule over quotes (MT5, a quote-only venue): counts, not volume. */
  | 'tickRuleQuotes';

export function flowOrigin(d: Pick<TickBarsDto, 'deltaSource' | 'volumeUnit'>): FlowOrigin {
  const volume = (d.volumeUnit ?? 'ticks') !== 'ticks';
  if (d.deltaSource === 'trades' && volume) return 'trades';
  return volume ? 'tickRuleTrades' : 'tickRuleQuotes';
}

/** Whether the answer is a venue's (C4 `source.kind === "venue"`); older engines / MT5 = false. */
export function isVenueFlow(d: Pick<TickBarsDto, 'source'>): boolean {
  return d.source?.kind === 'venue';
}

/** The word for the answer's volumes: `ticks`, the base coin (`BTC`) / `base units`, `contracts`, `shares`. */
export function flowUnitWord(d: Pick<TickBarsDto, 'volumeUnit'>, baseCurrency?: string | null): string {
  switch (d.volumeUnit) {
    case 'base':
      return baseCurrency?.trim() ? baseCurrency.trim().toUpperCase() : 'base units';
    case 'contracts':
      return 'contracts';
    case 'shares':
      return 'shares';
    default:
      return 'ticks';
  }
}

function venueName(d: Pick<TickBarsDto, 'source'>): string {
  return d.source?.label?.trim() || d.source?.id || 'the venue';
}

/** The CVD pane's title for the answer. */
export function cvdTitle(d: Pick<TickBarsDto, 'deltaSource' | 'volumeUnit' | 'source'>, baseCurrency?: string | null): string {
  const unit = flowUnitWord(d, baseCurrency);
  switch (flowOrigin(d)) {
    case 'trades':
      return `Trade delta (CVD) — ${venueName(d)} trades, ${unit} (aggressor side as reported)`;
    case 'tickRuleTrades':
      return `Delta (CVD) — estimated (tick rule over ${venueName(d)} trade prices), ${unit}`;
    default:
      return isVenueFlow(d)
        ? `Tick delta (CVD) — estimated (tick rule over ${venueName(d)} quotes)`
        : 'Tick delta (CVD) — estimated (tick rule)';
  }
}

/** The footprint caption's first line; `rows` = "rows of 0.2 pip (auto)" / "rows of 5 ticks". */
export function footprintCaption(
  d: Pick<TickBarsDto, 'deltaSource' | 'volumeUnit' | 'source'>,
  rows: string,
  baseCurrency?: string | null,
): string {
  const unit = flowUnitWord(d, baseCurrency);
  const tail = `${rows}; shaded: 3:1 diagonal imbalance`;
  switch (flowOrigin(d)) {
    case 'trades':
      return `Footprint — ${venueName(d)} trades: ${unit} traded (sell × buy, aggressor side as reported), ${tail}`;
    case 'tickRuleTrades':
      return `Footprint — estimated (tick rule over ${venueName(d)} trade prices: some prints carry no side): ${unit} (down × up), ${tail}`;
    default:
      return isVenueFlow(d)
        ? `Footprint — estimated (tick rule over ${venueName(d)} quotes): tick counts (down × up), ${tail}`
        : `Footprint — estimated (tick rule on broker quotes): tick counts (down × up), ${tail}`;
  }
}

/**
 * Where the answer's tick-built bars stop (C4 `tickCoverageFromUtc`): MT5 keeps ticks 14 days; a venue answer reads the
 * last 24 h of the store, older bars carry the candles' trade counts only. `fromUtc` = the first bar asked about.
 */
export function coverageNote(
  d: Pick<TickBarsDto, 'source'>,
  kind: 'cvd' | 'ribbon',
  coverage: number | null,
  fromUtc: number,
  when: (ms: number) => string,
): string | null {
  const venue = isVenueFlow(d);
  if (coverage === null)
    return venue ? `no ${venueName(d)} trades or quotes stored for this window` : 'no ticks retained for this symbol';
  if (fromUtc >= coverage) return null;
  if (venue)
    return kind === 'cvd'
      ? `no ${venueName(d)} data read before ${when(coverage)} (the last 24 h are read; older bars: candle trade counts only)`
      : `${venueName(d)} data from ${when(coverage)} (the last 24 h are read)`;
  return kind === 'cvd'
    ? `no ticks before ${when(coverage)} (ticks are kept 14 days)`
    : `ticks from ${when(coverage)} (kept 14 days); older bars: candle spread only`;
}
