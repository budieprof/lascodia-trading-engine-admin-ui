import type {
  CmeAggressorOrder,
  CmeDeltaBar,
  CmeLevelEvent,
  CmeOrderFlow,
  CmeOrderFlowRequest,
  CmeSweep,
} from '@core/realtime/marketdata.types';
import { entitlementRefusalMessage } from '@core/market-data/entitlement-refusal';
import type { FootprintRowDto, TickBarDto } from './orderflow.types';

/**
 * CME order flow on the spot chart (market-data program, cme-tier2): the engine's `md/orderflow` analytics of the REAL
 * aggressor-tagged CME tape + MBP-10 book — delta / CVD / footprint bars, large lots, sweeps / stop runs, iceberg-like
 * levels and absorption — already mapped onto the spot symbol (inversion + side swap for 6J/6C/6S, the basis of each
 * minute). This module holds the window's answer (re-read every {@link LIVE_REFRESH_MS} at the live edge — the store
 * flushes every ≤ 10 s), turns its bars into the CVD pane's / footprint's shapes, and places the markers.
 */

/** Live edge: the answer is re-read this often (the store sees new CME data within ~10 s). */
export const LIVE_REFRESH_MS = 10_000;
/** The engine's caps: trades ≤ 24 h, with the book (icebergs, absorption) ≤ 2 h. */
export const MAX_TRADES_WINDOW_MS = 24 * 3_600_000;
export const MAX_BOOK_WINDOW_MS = 2 * 3_600_000;

export type CmeFlowState =
  | { kind: 'idle'; message?: string }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export interface CmeFlowDeps {
  orderFlow(req: CmeOrderFlowRequest): Promise<CmeOrderFlow>;
  now(): number;
  changed(): void;
}

interface Asked {
  symbol: string;
  sourceId: string;
  from: number;
  to: number;
  barSeconds: number;
  at: number;
}

/** The md/orderflow answer for the window on screen. */
export class CmeFlowFeed {
  data: CmeOrderFlow | null = null;
  state: CmeFlowState = { kind: 'idle' };
  private asked: Asked | null = null;
  private seq = 0;

  constructor(private readonly deps: CmeFlowDeps) {}

  /**
   * Point at a window. `barSeconds` = the chart's bar (≤ 1 day); `live` = the right edge is on screen (re-read every
   * {@link LIVE_REFRESH_MS}); `head` = Bar Replay's head (nothing after it).
   */
  update(o: { symbol: string; sourceId: string; fromUtc: number; toUtc: number; barSeconds: number; live: boolean; head: number | null }): void {
    const now = this.deps.now();
    const to = Math.ceil(Math.min(o.head ?? now, o.live ? now : o.toUtc));
    const from = Math.floor(o.fromUtc);
    if (!(to > from)) return;
    if (to - from > MAX_TRADES_WINDOW_MS) {
      this.state = { kind: 'idle', message: 'CME order flow: zoom in to 24 h or less' };
      this.deps.changed();
      return;
    }
    const symbol = o.symbol.toUpperCase();
    const barSeconds = Math.max(1, Math.min(86_400, Math.round(o.barSeconds)));
    const a = this.asked;
    const covers =
      !!a &&
      a.symbol === symbol &&
      a.sourceId === o.sourceId &&
      a.barSeconds === barSeconds &&
      from >= a.from &&
      to <= a.to + (o.live ? LIVE_REFRESH_MS : 0) &&
      !(o.live && now - a.at >= LIVE_REFRESH_MS);
    if (covers) return;
    void this.fetch({ symbol, sourceId: o.sourceId, from, to, barSeconds, at: now });
  }

  clear(): void {
    this.seq++;
    this.asked = null;
    this.data = null;
    this.state = { kind: 'idle' };
  }

  private async fetch(a: Asked): Promise<void> {
    const n = ++this.seq;
    this.asked = a;
    if (!this.data) this.state = { kind: 'loading' };
    this.deps.changed();
    try {
      const d = await this.deps.orderFlow({
        symbol: a.symbol,
        sourceId: a.sourceId,
        from: a.from,
        to: a.to,
        barSeconds: a.barSeconds,
        spot: true,
        includeBook: a.to - a.from <= MAX_BOOK_WINDOW_MS,
      });
      if (n !== this.seq) return;
      this.data = d;
      this.state = { kind: 'ready' };
    } catch (e) {
      if (n !== this.seq) return;
      this.asked = null;
      const refusal = entitlementRefusalMessage(e);
      const m = (e as { message?: unknown })?.message;
      this.state = {
        kind: 'error',
        message: refusal ?? (typeof m === 'string' && m ? m : 'md/orderflow did not answer'),
      };
    }
    this.deps.changed();
  }
}

// ── bars → the CVD pane / footprint ───────────────────────────────────────────

/**
 * The answer's bars on the chart's bar opens (`barTimes`, ascending UTC ms; `barMs` the chart's bar): CME bars whose
 * start falls in [open, next open) are summed into it. Shaped as the tick-flow pane's rows (`TickBarDto`) with
 * `source: 'ticks'`, delta = real aggressor delta (contracts), cumDelta = the CVD carried from the answer's anchor.
 */
export function cmeBarsAsTickBars(data: CmeOrderFlow, barTimes: readonly number[], barMs: number): TickBarDto[] {
  const out: TickBarDto[] = [];
  const bars = data.bars;
  let j = 0;
  let cvd: number | null = null;
  for (let i = 0; i < barTimes.length; i++) {
    const open = barTimes[i];
    const end = i + 1 < barTimes.length ? barTimes[i + 1] : open + barMs;
    while (j < bars.length && bars[j].t < open) {
      cvd = bars[j].cvd;
      j++;
    }
    let delta = 0;
    let volume = 0;
    let trades = 0;
    let any = false;
    while (j < bars.length && bars[j].t < end) {
      delta += bars[j].delta;
      volume += bars[j].volume;
      trades += bars[j].trades;
      cvd = bars[j].cvd;
      any = true;
      j++;
    }
    out.push({
      t: new Date(open).toISOString(),
      source: any ? 'ticks' : 'none',
      ticks: any ? volume : null,
      upTicks: null,
      downTicks: null,
      delta: any ? delta : null,
      cumDelta: any ? cvd : null,
      spreadMinPoints: null,
      spreadAvgPoints: null,
      spreadMaxPoints: null,
      ticksPerMinute: any ? trades : null,
    });
  }
  return out;
}

/**
 * The footprint rows of [open, end) from the answer's bars: price → (sell × buy) contracts, as the footprint layer's
 * `FootprintRowDto` (`up` = buyer-initiated, `down` = seller-initiated).
 */
export function cmeFootprintRows(bars: readonly CmeDeltaBar[], open: number, end: number): FootprintRowDto[] | null {
  const acc = new Map<number, { up: number; down: number }>();
  let any = false;
  for (const b of bars) {
    if (b.t < open || b.t >= end) continue;
    any = true;
    for (const [price, buy, sell] of b.footprint) {
      const cell = acc.get(price) ?? { up: 0, down: 0 };
      cell.up += buy;
      cell.down += sell;
      acc.set(price, cell);
    }
  }
  if (!any) return null;
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([price, c]) => ({ price, up: c.up, down: c.down }));
}

// ── markers ───────────────────────────────────────────────────────────────────

export type CmeMarkerKind = 'large' | 'sweep' | 'iceberg' | 'absorption';

export interface PlacedCmeMarker {
  kind: CmeMarkerKind;
  x: number;
  y: number;
  /** Sweeps: the end of the take (x2, y2); others equal (x, y). */
  x2: number;
  y2: number;
  /** Buyer-initiated (+1) / seller-initiated (−1) for orders and sweeps; resting bid (+1) / ask (−1) for levels. */
  side: number;
  size: number;
  /** Marker radius / half-size (px). */
  r: number;
  item: CmeAggressorOrder | CmeSweep | CmeLevelEvent;
}

/** Most markers drawn per kind (the largest win). */
export const MAX_MARKERS_PER_KIND = 400;

function sideOf(side: string): number {
  return side === 'B' || side === 'bid' ? 1 : side === 'S' || side === 'ask' ? -1 : 0;
}

/** Marker radius: area ∝ size against the largest of the kind on screen, 4–14 px. */
export function markerRadius(size: number, max: number): number {
  if (!(size > 0) || !(max > 0)) return 4;
  return Math.max(4, 14 * Math.sqrt(Math.min(1, size / max)));
}

/** Every marker of the answer that falls on screen (and before `clipUtc`), largest kept per kind, paint order. */
export function placeCmeMarkers(
  data: CmeOrderFlow,
  show: { large: boolean; sweeps: boolean; levels: boolean },
  xAt: (t: number) => number | null,
  yAt: (p: number) => number | null,
  width: number,
  height: number,
  clipUtc: number | null,
): PlacedCmeMarker[] {
  const out: PlacedCmeMarker[] = [];
  const clip = clipUtc ?? Infinity;
  const on = (x: number, y: number) => x >= -20 && x <= width + 20 && y >= -20 && y <= height + 20;
  const take = <T extends { t: number }>(
    items: readonly T[],
    kind: CmeMarkerKind,
    size: (i: T) => number,
    at: (i: T) => { t: number; p: number; t2: number; p2: number; side: string },
  ) => {
    const visible: PlacedCmeMarker[] = [];
    let max = 0;
    for (const it of items) {
      const a = at(it);
      if (a.t >= clip) continue;
      const x = xAt(a.t);
      const y = yAt(a.p);
      if (x === null || y === null || !on(x, y)) continue;
      const x2 = xAt(Math.min(a.t2, clip)) ?? x;
      const y2 = yAt(a.p2) ?? y;
      max = Math.max(max, size(it));
      visible.push({ kind, x, y, x2, y2, side: sideOf(a.side), size: size(it), r: 0, item: it as never });
    }
    visible.sort((p, q) => q.size - p.size);
    const kept = visible.slice(0, MAX_MARKERS_PER_KIND);
    for (const m of kept) m.r = markerRadius(m.size, max);
    out.push(...kept.reverse());
  };
  if (show.levels) {
    take(data.absorptions, 'absorption', (a) => a.volume, (a) => ({ t: a.t, p: a.price, t2: a.endT, p2: a.price, side: a.side }));
    take(data.icebergs, 'iceberg', (i) => i.volume, (i) => ({ t: i.t, p: i.price, t2: i.endT, p2: i.price, side: i.side }));
  }
  if (show.sweeps)
    take(data.sweeps, 'sweep', (s) => s.size, (s) => ({ t: s.t, p: s.fromPrice, t2: s.endT, p2: s.toPrice, side: s.side }));
  if (show.large)
    take(data.largeLots, 'large', (o) => o.size, (o) => ({ t: o.t, p: o.price, t2: o.t, p2: o.price, side: o.side }));
  return out;
}

/** The marker under (x, y): the topmost (last painted) whose shape contains it. */
export function cmeMarkerAt(placed: readonly PlacedCmeMarker[], x: number, y: number): PlacedCmeMarker | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const m = placed[i];
    const dx = x - m.x;
    const dy = y - m.y;
    if (dx * dx + dy * dy <= (m.r + 2) * (m.r + 2)) return m;
  }
  return null;
}

/** Hover text of a marker (spot terms; sizes in contracts). */
export function cmeMarkerText(m: PlacedCmeMarker, label: string, digits: number): string[] {
  const px = (p: number) => p.toFixed(digits);
  const who = (s: number) => (s > 0 ? 'buyer-initiated' : s < 0 ? 'seller-initiated' : 'aggressor not reported');
  switch (m.kind) {
    case 'large': {
      const o = m.item as CmeAggressorOrder;
      return [
        `${label} large lot · ${o.size} contracts ${who(m.side)}`,
        `VWAP ${px(o.price)} · ${o.prints} print${o.prints === 1 ? '' : 's'} over ${o.levels} level${o.levels === 1 ? '' : 's'} (${px(o.low)}–${px(o.high)})`,
        new Date(o.t).toISOString().replace('T', ' ').replace('Z', ' UTC'),
      ];
    }
    case 'sweep': {
      const s = m.item as CmeSweep;
      return [
        `${label} sweep · ${s.levels} levels in ${Math.max(0, s.endT - s.t)} ms, ${who(m.side)}`,
        `${px(s.fromPrice)} → ${px(s.toPrice)} · ${s.size} contracts, ${s.orders} order${s.orders === 1 ? '' : 's'}`,
        new Date(s.t).toISOString().replace('T', ' ').replace('Z', ' UTC'),
      ];
    }
    case 'iceberg': {
      const l = m.item as CmeLevelEvent;
      return [
        `${label} iceberg-like ${l.side} ${px(l.price)}`,
        `traded ${l.volume} vs at most ${l.maxDisplayed} shown, ${l.refills} refill${l.refills === 1 ? '' : 's'} (MBP-10: a refill may be a new order)`,
        `${new Date(l.t).toISOString().slice(11, 23)}–${new Date(l.endT).toISOString().slice(11, 23)} UTC`,
      ];
    }
    default: {
      const l = m.item as CmeLevelEvent;
      return [
        `${label} absorption at ${l.side} ${px(l.price)}`,
        `${l.volume} contracts of aggression absorbed; the level held ≥ ${Math.round(l.heldMs / 1000)} s`,
        `${new Date(l.t).toISOString().slice(11, 23)}–${new Date(l.endT).toISOString().slice(11, 23)} UTC`,
      ];
    }
  }
}
