import { BookTimeline } from '@core/realtime/md-book';
import { TickRing } from '@core/realtime/md-rings';
import type { MdWatch } from '@core/realtime/marketdata-stream.service';
import type { MdWatchSpec } from '@core/realtime/marketdata-stream';
import {
  MD_HISTORY_MAX_BOOK_MS,
  type MdHistory,
  type MdHistoryRequest,
  type MdHistorySourceWire,
} from '@core/realtime/marketdata.types';
import { HeatFolder, bookLevelStep, bookPriceRange, heatSpecFor, type HeatTextureSpec } from './gl/heat-texture';

/**
 * The event-level heatmap's data side (no Angular, no GL): what one window of the chart needs —
 * - HISTORY: `md/history` (C5) ticks + book + keyframe for the visible window widened by a margin (≤ 2 h: the C5 book
 *   cap; a wider view uses the bucketed C1 heatmap instead), folded into a {@link HeatFolder} at the current zoom;
 * - LIVE (right edge on screen, not in replay): the hub's book events and ticks for the same source appended to the
 *   timeline and folded each frame, into columns reserved past "now";
 * - REPLAY: folded only up to the replay head (moving back re-folds from the timeline; nothing is refetched).
 * The chart's primitive pulls {@link layer} every frame; {@link changed} fires (outside Angular) when it should redraw.
 */

/** The window fetched reaches this share of the view past each side (a small pan needs nothing new). */
export const STREAM_WINDOW_MARGIN = 0.25;
/** Live: columns reserved past now, as a share of the view. */
export const LIVE_HEADROOM = 0.25;
/** Re-fold when the zoom makes columns (or rows) this much too wide / narrow. */
export const REFOLD_RATIO = 1.6;
/** Live: the colour scale is recomputed this often. */
const ROBUST_EVERY_MS = 5_000;

export interface StreamHeatView {
  fromUtc: number;
  toUtc: number;
  widthPx: number;
  pricePerPx: number | null;
}

export interface StreamHeatDeps {
  history(req: MdHistoryRequest): Promise<MdHistory>;
  /** Open a live watch (the stream service); null: no live stream wanted / available. */
  watch(spec: MdWatchSpec): MdWatch | null;
  now(): number;
  /** Symbol's MT5 point (finest row). */
  point(): number;
  /** Something visible changed (fold advanced, new window, state). Called outside Angular. */
  changed(): void;
}

export type StreamHeatState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

/** What the primitive draws. */
export interface StreamHeatLayer {
  folder: HeatFolder;
  timeline: BookTimeline;
  ticks: TickRing;
  sourceId: string;
  robustMax: number;
  /** The fold reaches this instant (now when live, the head in replay). */
  foldedTo: number;
  live: boolean;
}

interface Held {
  symbol: string;
  sourceId: string;
  /** What was fetched: [from, to). */
  fromUtc: number;
  toUtc: number;
  timeline: BookTimeline;
  ticks: TickRing;
  note: string | null;
}

/** The fetch window for a view: the view ± margin, ending at the cap; null when it is wider than C5 serves book for. */
export function streamWindowFor(view: StreamHeatView, capUtc: number): { fromUtc: number; toUtc: number } | null {
  const span = Math.max(10_000, view.toUtc - view.fromUtc);
  const fromUtc = Math.floor(view.fromUtc - span * STREAM_WINDOW_MARGIN);
  const toUtc = Math.ceil(Math.min(capUtc, view.toUtc + span * STREAM_WINDOW_MARGIN));
  if (!(toUtc > fromUtc)) return null;
  if (toUtc - fromUtc > MD_HISTORY_MAX_BOOK_MS) return null;
  return { fromUtc, toUtc };
}

/** Whether a view at this zoom can use the event-level layer at all (its window fits the C5 book cap). */
export function streamHeatFits(view: Pick<StreamHeatView, 'fromUtc' | 'toUtc'>): boolean {
  const span = Math.max(10_000, view.toUtc - view.fromUtc);
  return span * (1 + 2 * STREAM_WINDOW_MARGIN) <= MD_HISTORY_MAX_BOOK_MS;
}

/** Pick the source to draw from a C5 answer: the requested one, else the one with the most book events. */
export function pickHistorySource(sources: readonly MdHistorySourceWire[], wanted: string | null): MdHistorySourceWire | null {
  if (wanted) return sources.find((s) => s.sourceId === wanted) ?? null;
  let best: MdHistorySourceWire | null = null;
  for (const s of sources) {
    const n = (s.book?.length ?? 0) + (s.keyframe ? 1 : 0);
    if (n > 0 && (!best || n > (best.book?.length ?? 0) + (best.keyframe ? 1 : 0))) best = s;
  }
  return best;
}

export class StreamHeatmap {
  private held: Held | null = null;
  private folder: HeatFolder | null = null;
  private robust = 0;
  private robustAt = 0;
  private seq = 0;
  private md: MdWatch | null = null;
  private mdKey = '';
  private raf: number | null = null;
  private wantedSymbol = '';
  private wantedSource: string | null = null;
  private view: StreamHeatView | null = null;
  private head: number | null = null;
  private liveWanted = false;
  state: StreamHeatState = { kind: 'idle' };

  constructor(private readonly deps: StreamHeatDeps) {}

  /** The layer to draw now, or null. */
  layer(): StreamHeatLayer | null {
    const h = this.held;
    if (!h || !this.folder || h.symbol !== this.wantedSymbol) return null;
    const live = this.liveWanted && this.head === null;
    if (live) this.foldLive();
    const f = this.folder;
    return {
      folder: f,
      timeline: h.timeline,
      ticks: h.ticks,
      sourceId: h.sourceId,
      robustMax: this.robust,
      foldedTo: this.head ?? (live ? this.deps.now() : h.toUtc),
      live,
    };
  }

  /** The source drawn now (null before the first answer). */
  sourceId(): string | null {
    return this.held?.sourceId ?? null;
  }

  /** C5's notes for the window (missing keyframe, not entitled, truncated). */
  note(): string | null {
    return this.held?.note ?? null;
  }

  /**
   * Point the layer at a view. `head` = the replay head (null live), `live` = the right edge is on screen. Fetches when
   * the window moved off what is held; re-folds when the zoom changed; otherwise only advances.
   */
  update(opts: { symbol: string; sourceId: string | null; view: StreamHeatView; head: number | null; live: boolean }): void {
    this.wantedSymbol = opts.symbol.toUpperCase();
    this.wantedSource = opts.sourceId;
    this.view = opts.view;
    const headMoved = opts.head !== this.head;
    this.head = opts.head;
    this.liveWanted = opts.live && opts.head === null;
    this.syncLive();
    const cap = opts.head ?? this.deps.now();
    const window = streamWindowFor(opts.view, cap);
    if (!window) {
      this.state = { kind: 'idle' };
      return;
    }
    const h = this.held;
    const sameSeries = !!h && h.symbol === this.wantedSymbol && (!opts.sourceId || h.sourceId === opts.sourceId);
    const span = window.toUtc - window.fromUtc;
    // Live, the held window keeps growing with the stream: only its start matters.
    const covered =
      sameSeries &&
      window.fromUtc >= h!.fromUtc - span * 0.05 &&
      (this.liveWanted ? true : window.toUtc <= h!.toUtc + span * 0.05);
    if (!covered) {
      void this.fetch(this.wantedSymbol, opts.sourceId, window);
      return;
    }
    if (this.needsRefold() || (headMoved && this.head !== null)) this.refold();
  }

  /** Stop everything (the layer was turned off). */
  clear(): void {
    this.seq++;
    this.held = null;
    this.folder = null;
    this.state = { kind: 'idle' };
    this.view = null;
    this.liveWanted = false;
    this.syncLive();
  }

  dispose(): void {
    this.clear();
    if (this.raf !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
  }

  private async fetch(symbol: string, sourceId: string | null, window: { fromUtc: number; toUtc: number }): Promise<void> {
    const n = ++this.seq;
    this.state = { kind: 'loading' };
    this.deps.changed();
    try {
      const answer = await this.deps.history({
        symbol,
        sourceIds: sourceId ? [sourceId] : undefined,
        from: window.fromUtc,
        to: window.toUtc,
        kinds: ['book', 'ticks'],
      });
      if (n !== this.seq) return;
      const src = pickHistorySource(answer.sources ?? [], sourceId);
      if (!src) {
        this.held = null;
        this.folder = null;
        const denied = answer.denied?.length ? ` (not entitled to ${answer.denied.join(', ')})` : '';
        this.state = { kind: 'error', message: `no book stored for ${symbol} in this window${denied}` };
        this.deps.changed();
        return;
      }
      const timeline = new BookTimeline(src.keyframe ?? null);
      timeline.appendAll(src.book ?? []);
      const ticks = new TickRing(Math.max(65_536, (src.ticks?.t.length ?? 0) + 16_384));
      if (src.ticks) ticks.pushColumns(src.ticks);
      this.held = {
        symbol,
        sourceId: src.sourceId,
        fromUtc: window.fromUtc,
        toUtc: answer.truncated ? Math.max(timeline.lastTime, ticks.lastTime || 0) : window.toUtc,
        timeline,
        ticks,
        note: answer.message,
      };
      this.state = { kind: 'ready' };
      this.syncLive();
      this.refold();
    } catch (e) {
      if (n !== this.seq) return;
      const m = (e as { message?: unknown })?.message;
      this.state = { kind: 'error', message: typeof m === 'string' && m ? m : 'md/history did not answer' };
      this.deps.changed();
    }
  }

  /** The grid for the current view over what is held. */
  private specNow(): HeatTextureSpec | null {
    const h = this.held;
    const v = this.view;
    if (!h || !v) return null;
    const viewSpan = Math.max(10_000, v.toUtc - v.fromUtc);
    const pxPerMs = v.widthPx / viewSpan;
    const end = this.liveWanted ? Math.max(h.toUtc, this.deps.now()) + viewSpan * LIVE_HEADROOM : h.toUtc;
    const from = h.fromUtc;
    const range = bookPriceRange(h.timeline);
    const lastTick = h.ticks.last();
    const lo = Math.min(range?.lo ?? Infinity, lastTick?.bid ?? Infinity);
    const hi = Math.max(range?.hi ?? -Infinity, lastTick?.ask ?? -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const point = this.deps.point() > 0 ? this.deps.point() : 0.00001;
    return heatSpecFor({
      fromUtc: from,
      toUtc: end,
      widthPx: Math.max(1, (end - from) * pxPerMs),
      pLow: lo,
      pHigh: hi,
      levelStep: bookLevelStep(h.timeline.events, point),
      pricePerPx: v.pricePerPx,
    });
  }

  private needsRefold(): boolean {
    const f = this.folder;
    const v = this.view;
    if (!f || !v) return true;
    const viewSpan = Math.max(10_000, v.toUtc - v.fromUtc);
    const wantColMs = viewSpan / Math.max(1, v.widthPx);
    const r = wantColMs / f.spec.colMs;
    if (r > REFOLD_RATIO || r < 1 / REFOLD_RATIO) return true;
    if (v.pricePerPx && v.pricePerPx > f.spec.rowStep * REFOLD_RATIO * 2) return true;
    if (f.outOfRange > 0) return true;
    // Live past the reserved columns.
    if (this.liveWanted && this.deps.now() >= f.endUtc - f.spec.colMs * 2) return true;
    return false;
  }

  private refold(): void {
    const h = this.held;
    const spec = this.specNow();
    if (!h || !spec) return;
    const f = new HeatFolder(spec, h.timeline);
    f.advanceTo(this.head ?? (this.liveWanted ? this.deps.now() : h.toUtc));
    this.folder = f;
    this.robust = f.robustMax();
    this.robustAt = this.deps.now();
    this.deps.changed();
  }

  /** Live: fold what arrived; recompute the colour scale now and then. */
  private foldLive(): void {
    const f = this.folder;
    if (!f) return;
    if (this.needsRefold()) {
      this.refold();
      return;
    }
    f.advanceTo(this.deps.now());
    const now = this.deps.now();
    if (now - this.robustAt > ROBUST_EVERY_MS) {
      this.robust = Math.max(this.robust * 0.5, f.robustMax());
      this.robustAt = now;
    }
  }

  // ── Live stream ──────────────────────────────────────────────────────────

  private syncLive(): void {
    const h = this.held;
    const key = this.liveWanted && h ? `${h.symbol}|${h.sourceId}` : '';
    if (key === this.mdKey) return;
    this.md?.release();
    this.md = null;
    this.mdKey = key;
    if (!key || !h) return;
    const md = this.deps.watch({ symbol: h.symbol, sources: [h.sourceId], kinds: ['book', 'ticks'] });
    if (!md) return;
    this.md = md;
    md.onBook((stream, events, reset) => {
      const held = this.held;
      if (!held || stream.sourceId !== held.sourceId || held.symbol !== stream.symbol) return;
      if (reset && events.length === 0) {
        // The book was re-keyed (keyframe repair): carry it as a snapshot at its time.
        const k = stream.book.toKeyframe(stream.book.t);
        if (k) held.timeline.append({ t: k.t, k: 'S', b: k.b, a: k.a });
      } else held.timeline.appendAll(events);
      this.scheduleFrame();
    });
    md.onFrame((frame, stream) => {
      const held = this.held;
      if (!held || stream.sourceId !== held.sourceId || !frame.ticks) return;
      held.ticks.pushColumns(frame.ticks);
      this.scheduleFrame();
    });
  }

  /** One redraw per animation frame however many frames arrived. */
  private scheduleFrame(): void {
    if (this.raf !== null) return;
    if (typeof requestAnimationFrame === 'undefined') {
      this.deps.changed();
      return;
    }
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.deps.changed();
    });
  }
}
