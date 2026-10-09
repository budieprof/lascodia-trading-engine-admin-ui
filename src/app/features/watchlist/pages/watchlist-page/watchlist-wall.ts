/**
 * Pure helpers of the /watchlist wall (SP-I6): where its symbols come from now that it reads the engine's watchlists,
 * the one-time import of the browser-only wall it used to keep, and folding pushed ticks into the quote map.
 */
import type { LivePriceDto } from '@core/api/api.types';
import type { WatchQuote } from '@features/chart-analysis/watchlist/watchlist.model';

/** The browser-only wall of the old page (`[{symbol, timeframe}]`). Kept only to offer an import. */
export const LEGACY_WALL_KEY = 'tradingChart.watchlist.v1';

/** Uppercase, letters and digits only: "eur/usd" → "EURUSD". */
export function canonicalSymbol(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The symbols of the old browser wall, once each, in order; [] for nothing usable. */
export function readLegacyWall(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const sym = canonicalSymbol((item as { symbol?: unknown })?.symbol as string);
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        out.push(sym);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** A pushed `priceUpdated` payload. */
export interface PriceTick {
  symbol?: string;
  bid?: number;
  ask?: number;
  timeUtc?: string;
}

/** Fold one pushed tick into the per-symbol quotes; the same map back when the tick carries nothing usable. */
export function applyTick(
  quotes: Readonly<Record<string, LivePriceDto>>,
  tick: PriceTick | null | undefined,
  nowIso: string,
): Readonly<Record<string, LivePriceDto>> {
  const symbol = canonicalSymbol(tick?.symbol);
  const bid = tick?.bid;
  const ask = tick?.ask ?? bid;
  if (!symbol || typeof bid !== 'number' || !Number.isFinite(bid) || typeof ask !== 'number' || !Number.isFinite(ask))
    return quotes;
  const prev = quotes[symbol];
  if (prev && prev.bid === bid && prev.ask === ask) return quotes;
  return {
    ...quotes,
    [symbol]: { symbol, bid, ask, spread: ask - bid, timestamp: tick?.timeUtc ?? nowIso },
  };
}

/**
 * Seed quotes from the day snapshot (one request for the whole wall): a symbol the stream has already priced keeps
 * its pushed quote — the snapshot is older. Symbols without a bid/ask stay absent ("No live quote").
 */
export function seedFromSnapshot(
  quotes: Readonly<Record<string, LivePriceDto>>,
  snapshot: readonly WatchQuote[],
): Readonly<Record<string, LivePriceDto>> {
  let next: Record<string, LivePriceDto> | null = null;
  for (const q of snapshot) {
    const symbol = canonicalSymbol(q.symbol);
    if (!symbol || quotes[symbol] || q.bid == null || q.ask == null) continue;
    next ??= { ...quotes };
    next[symbol] = { symbol, bid: q.bid, ask: q.ask, spread: q.ask - q.bid, timestamp: q.asOfUtc ?? '' };
  }
  return next ?? quotes;
}
