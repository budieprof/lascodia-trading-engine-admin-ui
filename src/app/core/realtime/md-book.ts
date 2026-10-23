import type { MdBookEventWire, MdKeyframeWire, MdLevel } from './marketdata.types';

/**
 * Order-book state rebuilt from C2 events, exactly as the engine's `BookFold` does it: an `S` replaces the whole book,
 * a `D` sets each listed level's ABSOLUTE size (0 removes it). A `D` with no book underneath (nothing since a gap) is
 * not applied — the book is unknown until the next `S` / keyframe — and is counted as a gap.
 */
export class BookState {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  /** A snapshot (or keyframe) has been applied since the last reset: the levels are the real book. */
  known = false;
  /** Time (epoch ms) of the last event applied; NaN before any. */
  t = NaN;
  /** Bumped by every change (renderers cache by it). */
  version = 0;
  /** `D` events dropped because there was no book under them. */
  orphanDeltas = 0;

  private sortedAt = -1;
  private bidsSorted: MdLevel[] = [];
  private asksSorted: MdLevel[] = [];

  /** Forget everything (a gap: the book is unknown until the next snapshot). */
  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.known = false;
    this.version++;
  }

  /** A keyframe (C5) or snapshot: the book IS these levels. */
  setSnapshot(t: number, b: readonly MdLevel[], a: readonly MdLevel[]): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of b) if (l[1] > 0 && Number.isFinite(l[0])) this.bids.set(l[0], l[1]);
    for (const l of a) if (l[1] > 0 && Number.isFinite(l[0])) this.asks.set(l[0], l[1]);
    this.known = true;
    this.t = t;
    this.version++;
  }

  applyKeyframe(k: MdKeyframeWire): void {
    this.setSnapshot(k.t, k.b ?? [], k.a ?? []);
  }

  /** Apply one event; false when it could not be (a delta on an unknown book). */
  apply(e: MdBookEventWire): boolean {
    if (e.k === 'S') {
      this.setSnapshot(e.t, e.b ?? [], e.a ?? []);
      return true;
    }
    if (!this.known) {
      this.orphanDeltas++;
      return false;
    }
    for (const [p, s] of e.b ?? []) {
      if (s > 0) this.bids.set(p, s);
      else this.bids.delete(p);
    }
    for (const [p, s] of e.a ?? []) {
      if (s > 0) this.asks.set(p, s);
      else this.asks.delete(p);
    }
    this.t = e.t;
    this.version++;
    return true;
  }

  private sort(): void {
    if (this.sortedAt === this.version) return;
    this.bidsSorted = [...this.bids.entries()].sort((x, y) => y[0] - x[0]) as MdLevel[];
    this.asksSorted = [...this.asks.entries()].sort((x, y) => x[0] - y[0]) as MdLevel[];
    this.sortedAt = this.version;
  }

  /** Bids best (highest) first. */
  bidLevels(): readonly MdLevel[] {
    this.sort();
    return this.bidsSorted;
  }

  /** Asks best (lowest) first. */
  askLevels(): readonly MdLevel[] {
    this.sort();
    return this.asksSorted;
  }

  bestBid(): number | null {
    return this.known ? (this.bidLevels()[0]?.[0] ?? null) : null;
  }

  bestAsk(): number | null {
    return this.known ? (this.askLevels()[0]?.[0] ?? null) : null;
  }

  /** Size resting at exactly `price` on either side (0: none). */
  sizeAt(price: number): number {
    return (this.bids.get(price) ?? 0) + (this.asks.get(price) ?? 0);
  }

  clone(): BookState {
    const c = new BookState();
    for (const [p, s] of this.bids) c.bids.set(p, s);
    for (const [p, s] of this.asks) c.asks.set(p, s);
    c.known = this.known;
    c.t = this.t;
    c.version = this.version;
    return c;
  }

  /** The book as a C5 keyframe stamped `t` (bids best first, asks best first); null while unknown. */
  toKeyframe(t: number): MdKeyframeWire | null {
    if (!this.known) return null;
    return { t, b: this.bidLevels().map((l) => [l[0], l[1]]), a: this.askLevels().map((l) => [l[0], l[1]]) };
  }
}

/** How many events between two stored book copies (bounded fold cost for {@link BookTimeline.at}). */
export const CHECKPOINT_EVERY = 256;

/**
 * A book's history: an optional keyframe, then events in time order, with a stored copy of the book every
 * {@link CHECKPOINT_EVERY} events so the book at any instant is a short fold away. Events are appended (history first,
 * then live); one older than the newest held is dropped (it would rewrite the past) and counted.
 */
export class BookTimeline {
  readonly times: number[] = [];
  readonly events: MdBookEventWire[] = [];
  /** Book after events[0 .. index-1] (index multiple of CHECKPOINT_EVERY; index 0 = the keyframe or nothing). */
  private readonly checkpoints: BookState[] = [];
  /** The book after every event appended (the live edge). */
  readonly head = new BookState();
  droppedOutOfOrder = 0;
  /** Cursor cache for sequential reads (replay steps, column folds). */
  private cursor: { index: number; state: BookState } | null = null;

  constructor(readonly keyframe: MdKeyframeWire | null = null) {
    if (keyframe) this.head.applyKeyframe(keyframe);
    this.checkpoints.push(this.head.clone());
  }

  get length(): number {
    return this.events.length;
  }

  /** First and last time covered (keyframe included); NaN when empty. */
  get firstTime(): number {
    return this.keyframe?.t ?? this.times[0] ?? NaN;
  }
  get lastTime(): number {
    return this.times.length ? this.times[this.times.length - 1] : (this.keyframe?.t ?? NaN);
  }

  append(e: MdBookEventWire): boolean {
    const last = this.times.length ? this.times[this.times.length - 1] : -Infinity;
    if (!(e.t >= last)) {
      this.droppedOutOfOrder++;
      return false;
    }
    this.times.push(e.t);
    this.events.push(e);
    this.head.apply(e);
    if (this.events.length % CHECKPOINT_EVERY === 0) this.checkpoints.push(this.head.clone());
    return true;
  }

  appendAll(events: readonly MdBookEventWire[]): void {
    for (const e of events) this.append(e);
  }

  /** Number of events with time ≤ `t`. */
  countAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The book after every event at or before `t` (a fresh copy is NOT made — treat the result as read-only; it is
   * valid until the next call). Sequential calls with a growing `t` fold only the new events.
   */
  at(t: number): BookState {
    const n = this.countAtOrBefore(t);
    return this.afterCount(n);
  }

  /** The book after the first `n` events (read-only, valid until the next call). */
  afterCount(n: number): BookState {
    const c = this.cursor;
    if (c && c.index <= n && n - c.index <= CHECKPOINT_EVERY * 2) {
      for (let i = c.index; i < n; i++) c.state.apply(this.events[i]);
      c.index = n;
      return c.state;
    }
    const k = Math.min(Math.floor(n / CHECKPOINT_EVERY), this.checkpoints.length - 1);
    const state = this.checkpoints[k].clone();
    for (let i = k * CHECKPOINT_EVERY; i < n; i++) state.apply(this.events[i]);
    this.cursor = { index: n, state };
    return state;
  }
}
