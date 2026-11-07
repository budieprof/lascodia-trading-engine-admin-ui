import type { VolumeKind } from '../datafeed/chart-facts';

/**
 * What a volume-based study is built from (UA07), said in the studies strip beside it: MT5 bars carry TICK volume (a
 * count of price changes, not traded size), a crypto venue the base coin, futures contracts, equities shares — C1
 * `volumeKind`. The delta studies say they are estimated from bar shape (no aggressor tape reaches them). Pure.
 */

/** Built-in studies whose values are made of the bars' volume. */
export const VOLUME_STUDIES: ReadonlySet<string> = new Set([
  'vwap',
  'obv',
  'mfi',
  'vwma',
  'cmf',
  'adl',
  'chaikin-osc',
  'force-index',
  'eom',
  'pvt',
  'volume-osc',
  'nvi-pvi',
  'est-delta',
  'est-cum-delta',
  'net-volume',
  'klinger',
  'volume',
  'vwap-bands',
  'anchored-vwap',
  'up-down-volume',
  'cvd',
]);

/** Studies whose buy/sell split is inferred from the bar (close vs open, close in range), not order flow. */
export const ESTIMATED_DELTA: ReadonlySet<string> = new Set([
  'est-delta',
  'est-cum-delta',
  'cvd',
  'up-down-volume',
  'net-volume',
]);

/** "tick volume", "BTC volume", "contracts", "shares", "volume (unit unknown)". */
export function volumeWords(
  kind: VolumeKind | null | undefined,
  baseAsset?: string | null,
): string {
  switch (kind) {
    case 'tick':
      return 'tick volume (MT5 price-change count, not traded size)';
    case 'base':
      return baseAsset ? `traded volume in ${baseAsset}` : 'traded volume in the base asset';
    case 'contracts':
      return 'traded volume in contracts';
    case 'shares':
      return 'traded volume in shares';
    default:
      return 'volume (unit not reported)';
  }
}

/** The strip's line for a study, or null when it is not volume-based. */
export function volumeStudyNote(
  defId: string,
  kind: VolumeKind | null | undefined,
  baseAsset?: string | null,
  params: Record<string, number | string> = {},
): string | null {
  const profile = defId.startsWith('profile:') && !defId.endsWith(':tpo');
  if (!VOLUME_STUDIES.has(defId) && !profile) return null;
  if (defId === 'volume' && params['measure'] === QUOTE_NOTIONAL) {
    return notionalAllowed(kind)
      ? 'Quote notional: volume × typical price (hlc3), per bar'
      : `Quote notional needs volume in coins or shares; this chart has ${volumeWords(kind, baseAsset)}`;
  }
  const words = `Built on ${volumeWords(kind, baseAsset)}`;
  return ESTIMATED_DELTA.has(defId)
    ? `${words}; buy/sell split estimated from the bar, not trades`
    : words;
}

/** The Volume study's notional choice. */
export const QUOTE_NOTIONAL = 'Quote notional';
export const VOLUME_MEASURES = ['Volume', QUOTE_NOTIONAL] as const;

/**
 * Whether volume × price is a quote notional: coins and shares are. Contracts need the multiplier (and inverse
 * contracts are quoted in coin); tick counts have no size at all.
 */
export function notionalAllowed(kind: VolumeKind | null | undefined): boolean {
  return kind === 'base' || kind === 'shares';
}
