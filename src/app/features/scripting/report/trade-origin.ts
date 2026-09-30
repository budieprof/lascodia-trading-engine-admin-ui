/**
 * Where a listed trade came from. A live session's emulator first replays history to warm the
 * script up — those trades are a historical replay, not paper or live evidence — and then trades
 * on paper (nothing sent to an account) or live (mirrored to the bound accounts). The live status
 * endpoint tags each trade with its origin; backtests never do, and an engine build that predates
 * the tag leaves it unknown (null).
 */
export type TradeOrigin = 'warmup' | 'paper' | 'live';

/** Short text for a badge. */
export const TRADE_ORIGIN_BADGES: Readonly<Record<TradeOrigin, string>> = {
  warmup: 'Warm-up',
  paper: 'Paper',
  live: 'Live',
};

/** What a badge's tooltip / a chart title says about the origin. */
export const TRADE_ORIGIN_TITLES: Readonly<Record<TradeOrigin, string>> = {
  warmup: 'Warm-up replay',
  paper: 'Paper',
  live: 'Live',
};

const TRADE_ORIGIN_HINTS: Readonly<Record<TradeOrigin, string>> = {
  warmup: 'Warm-up replay: a historical replay from before the session went live, not evidence',
  paper: 'Paper: traded in realtime, nothing sent to an account',
  live: 'Live: traded in realtime and mirrored to the bound accounts',
};

/** The wire value (`warmup` | `paper` | `live`, any casing) as an origin; null when unknown. */
export function parseTradeOrigin(v: unknown): TradeOrigin | null {
  if (typeof v !== 'string') return null;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return s === 'warmup' || s === 'paper' || s === 'live' ? s : null;
}

/** "Warm-up replay" / "Paper" / "Live", or "Origin unknown" when the engine did not say. */
export function tradeOriginTitle(origin: TradeOrigin | null): string {
  return origin ? TRADE_ORIGIN_TITLES[origin] : 'Origin unknown';
}

/** A sentence for a badge's tooltip. */
export function tradeOriginHint(origin: TradeOrigin | null): string {
  return origin
    ? TRADE_ORIGIN_HINTS[origin]
    : 'The engine did not report where this trade came from';
}
