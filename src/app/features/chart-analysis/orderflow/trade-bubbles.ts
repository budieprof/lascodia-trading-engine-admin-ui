import { TradeRing } from '@core/realtime/md-rings';
import type { MdWatch } from '@core/realtime/marketdata-stream.service';
import type { MdWatchSpec } from '@core/realtime/marketdata-stream';
import {
  MD_HISTORY_MAX_BOOK_MS,
  type MdHistory,
  type MdHistoryRequest,
} from '@core/realtime/marketdata.types';
import { percentile } from './heatmap-grid';

/**
 * Trade bubbles (Bookmap's "volume dots") for sources that publish REAL trades — CME futures and FIX venues (wave C);
 * an MT5 broker has none, and nothing here infers trades from quotes. One circle per trade at (time, price), area ∝
 * size against the window's robust max, green for buyer-initiated, red for seller-initiated, grey when the venue does not
 * say. A minimum-size filter hides the small prints. The data: C5 `trades` for the window, then the hub's live `trades`
 * frames (C4) for the same source.
 */

export const BUBBLE_MIN_R = 2;
export const BUBBLE_MAX_R = 18;
/** Most bubbles drawn in one frame (the largest win). */
export const MAX_BUBBLES = 4_000;

export interface PlacedBubble {
  x: number;
  y: number;
  r: number;
  side: number;
  size: number;
  price: number;
  t: number;
}

/** Radius for a size: area ∝ size, `refMax` (the window's 98th percentile) maps to the max radius. */
export function bubbleRadius(size: number, refMax: number): number {
  if (!(size > 0) || !(refMax > 0)) return BUBBLE_MIN_R;
  const r = BUBBLE_MAX_R * Math.sqrt(Math.min(1, size / refMax));
  return Math.max(BUBBLE_MIN_R, r);
}

/** The reference size of a ring's trades (98th percentile; sampled). */
export function tradeRefMax(ring: TradeRing): number {
  const step = Math.max(1, Math.floor(ring.size / 50_000));
  const vals: number[] = [];
  for (let i = 0; i < ring.size; i += step) vals.push(ring.sizeAt(i));
  return percentile(vals, 0.98);
}

/**
 * The bubbles to draw: trades in [t0, t1) with size ≥ `minSize`, placed by `xAt` / `yAt`, off-pane ones left out; when
 * more than {@link MAX_BUBBLES} qualify the largest are kept. Returned in paint order (small first, large on top).
 */
export function placeBubbles(
  ring: TradeRing,
  t0: number,
  t1: number,
  minSize: number,
  refMax: number,
  xAt: (t: number) => number | null,
  yAt: (p: number) => number | null,
  width: number,
  height: number,
): PlacedBubble[] {
  const out: PlacedBubble[] = [];
  const i0 = ring.lowerBound(t0);
  const i1 = ring.lowerBound(t1);
  for (let i = i0; i < i1; i++) {
    const size = ring.sizeAt(i);
    if (!(size >= minSize) || !(size > 0)) continue;
    const t = ring.timeAt(i);
    const price = ring.priceAt(i);
    const x = xAt(t);
    const y = yAt(price);
    if (x === null || y === null) continue;
    const r = bubbleRadius(size, refMax);
    if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
    out.push({ x, y, r, side: ring.sideAt(i), size, price, t });
  }
  out.sort((a, b) => a.size - b.size);
  return out.length > MAX_BUBBLES ? out.slice(out.length - MAX_BUBBLES) : out;
}

/** The bubble under (x, y): the topmost (last painted) containing it. */
export function bubbleAt(
  placed: readonly PlacedBubble[],
  x: number,
  y: number,
): PlacedBubble | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const b = placed[i];
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy <= (b.r + 1) * (b.r + 1)) return b;
  }
  return null;
}

export interface TradeFeedDeps {
  history(req: MdHistoryRequest): Promise<MdHistory>;
  watch(spec: MdWatchSpec): MdWatch | null;
  now(): number;
  changed(): void;
}

export type TradeFeedState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

/** The trades one source printed in the window (history + live), for the bubbles layer. */
export class TradeFeed {
  ring = new TradeRing(65_536);
  sourceId: string | null = null;
  refMax = 0;
  state: TradeFeedState = { kind: 'idle' };
  private held: { symbol: string; sourceId: string; fromUtc: number; toUtc: number } | null = null;
  private md: MdWatch | null = null;
  private mdKey = '';
  private seq = 0;

  constructor(private readonly deps: TradeFeedDeps) {}

  /** Point at a window; `head` = replay head (no live), `live` = the right edge is on screen. */
  update(opts: {
    symbol: string;
    sourceId: string;
    fromUtc: number;
    toUtc: number;
    head: number | null;
    live: boolean;
  }): void {
    const symbol = opts.symbol.toUpperCase();
    const cap = opts.head ?? this.deps.now();
    const from = Math.floor(opts.fromUtc);
    const to = Math.ceil(Math.min(cap, opts.toUtc));
    if (!(to > from) || to - from > MD_HISTORY_MAX_BOOK_MS) {
      this.state = { kind: 'idle' };
      return;
    }
    const h = this.held;
    const live = opts.live && opts.head === null;
    const covered =
      h &&
      h.symbol === symbol &&
      h.sourceId === opts.sourceId &&
      from >= h.fromUtc &&
      (live || to <= h.toUtc);
    this.syncLive(live ? `${symbol}|${opts.sourceId}` : '', symbol, opts.sourceId);
    if (covered) return;
    void this.fetch(symbol, opts.sourceId, from, to);
  }

  clear(): void {
    this.seq++;
    this.held = null;
    this.ring = new TradeRing(65_536);
    this.state = { kind: 'idle' };
    this.syncLive('', '', '');
  }

  private async fetch(symbol: string, sourceId: string, from: number, to: number): Promise<void> {
    const n = ++this.seq;
    this.state = { kind: 'loading' };
    this.deps.changed();
    try {
      const h = await this.deps.history({
        symbol,
        sourceIds: [sourceId],
        from,
        to,
        kinds: ['trades'],
      });
      if (n !== this.seq) return;
      const src = h.sources?.find((s) => s.sourceId === sourceId);
      const ring = new TradeRing(Math.max(65_536, (src?.trades?.t.length ?? 0) + 16_384));
      if (src?.trades) ring.pushColumns(src.trades);
      this.ring = ring;
      this.sourceId = sourceId;
      this.refMax = tradeRefMax(ring);
      this.held = { symbol, sourceId, fromUtc: from, toUtc: to };
      this.state =
        h.denied?.length && !src
          ? { kind: 'error', message: `not entitled to ${h.denied.join(', ')}` }
          : { kind: 'ready' };
    } catch (e) {
      if (n !== this.seq) return;
      const m = (e as { message?: unknown })?.message;
      this.state = {
        kind: 'error',
        message: typeof m === 'string' && m ? m : 'md/history did not answer',
      };
    }
    this.deps.changed();
  }

  private syncLive(key: string, symbol: string, sourceId: string): void {
    if (key === this.mdKey) return;
    this.md?.release();
    this.md = null;
    this.mdKey = key;
    if (!key) return;
    const md = this.deps.watch({ symbol, sources: [sourceId], kinds: ['trades'] });
    if (!md) return;
    this.md = md;
    md.onFrame((frame, stream) => {
      if (stream.sourceId !== sourceId || !frame.trades) return;
      this.ring.pushColumns(frame.trades);
      this.deps.changed();
    });
  }
}
