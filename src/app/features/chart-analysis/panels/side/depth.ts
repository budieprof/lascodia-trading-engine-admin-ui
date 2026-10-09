import type { OrderBookSnapshot } from './chart-panels.types';

/**
 * The broker's depth of book (DOM) as a ladder (SP-I9). This is ONE broker's MT5 market depth as an EA reports it
 * (~1/s) — liquidity that broker shows, not the interbank market — so the panel calls it "broker depth".
 */

export interface DepthLevel {
  price: number;
  /** Units at this price (a broker lot is usually 100,000). */
  volume: number;
  /** Units at this price and every better one. */
  cumulative: number;
  /** `cumulative` as a share of the deeper side's total, for the bar width (0–1). */
  share: number;
}

export interface DepthLadder {
  /** Best (highest) first. */
  bids: DepthLevel[];
  /** Best (lowest) first. */
  asks: DepthLevel[];
  /** Best ask − best bid; 0 for a locked book. Null without both sides. */
  spread: number | null;
  /** Bid volume ÷ (bid + ask volume) over the levels shown, 0–1. */
  bidShare: number | null;
  /** False for a top-of-book-only broker (no levels in the snapshot). */
  hasLevels: boolean;
}

interface RawLevel {
  P?: number;
  V?: number;
}

function levels(raw: unknown): { price: number; volume: number }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawLevel[])
    .map((l) => ({ price: Number(l?.P), volume: Number(l?.V) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.volume) && l.volume >= 0);
}

function cumulate(side: { price: number; volume: number }[]): DepthLevel[] {
  let run = 0;
  return side.map((l) => {
    run += l.volume;
    return { ...l, cumulative: run, share: 0 };
  });
}

/** Parse a snapshot into a ladder of at most `maxLevels` per side (the broker's own order is not trusted). */
export function parseDepth(snapshot: OrderBookSnapshot | null, maxLevels = 10): DepthLadder {
  const empty: DepthLadder = { bids: [], asks: [], spread: null, bidShare: null, hasLevels: false };
  if (!snapshot) return empty;
  let parsed: { bids?: unknown; asks?: unknown } = {};
  try {
    parsed = snapshot.levelsJson ? (JSON.parse(snapshot.levelsJson) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  let bidsRaw = levels(parsed.bids).sort((a, b) => b.price - a.price);
  let asksRaw = levels(parsed.asks).sort((a, b) => a.price - b.price);
  const hasLevels = bidsRaw.length > 0 || asksRaw.length > 0;
  // Top of book only: show the best bid / ask the snapshot carries.
  if (!hasLevels) {
    bidsRaw = snapshot.bidPrice > 0 ? [{ price: snapshot.bidPrice, volume: snapshot.bidVolume }] : [];
    asksRaw = snapshot.askPrice > 0 ? [{ price: snapshot.askPrice, volume: snapshot.askVolume }] : [];
  }
  const bids = cumulate(bidsRaw.slice(0, maxLevels));
  const asks = cumulate(asksRaw.slice(0, maxLevels));
  const deepest = Math.max(bids.at(-1)?.cumulative ?? 0, asks.at(-1)?.cumulative ?? 0);
  for (const l of [...bids, ...asks]) l.share = deepest > 0 ? l.cumulative / deepest : 0;
  const bidTotal = bids.at(-1)?.cumulative ?? 0;
  const askTotal = asks.at(-1)?.cumulative ?? 0;
  return {
    bids,
    asks,
    spread: bids.length && asks.length ? Math.max(0, asks[0].price - bids[0].price) : null,
    bidShare: bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) : null,
    hasLevels,
  };
}

/** `1.2M`, `350K`, `800` units. */
export function formatUnits(v: number): string {
  if (v >= 1_000_000) return `${(Math.round(v / 100_000) / 10).toString()}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(Math.round(v));
}

/** How old a snapshot is, in seconds (never negative); null for an unparseable time. */
export function snapshotAgeSeconds(capturedAt: string, nowMs: number): number | null {
  const t = Date.parse(capturedAt);
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null;
}
