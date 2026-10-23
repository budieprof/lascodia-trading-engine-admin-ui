import { BookState, type BookTimeline } from '@core/realtime/md-book';
import type { MdBookEventWire } from '@core/realtime/marketdata.types';
import { percentile } from '../heatmap-grid';

/**
 * The event-level liquidity heatmap's texture (Bookmap-style), pure and testable: EVERY book event of a window (C5
 * keyframe + S/D events, then live hub events) folded into a time × price grid whose columns are screen-pixel wide at
 * the zoom it was built for. A cell holds the LARGEST size resting in that price row at any moment of the column's
 * time span — so liquidity that flashed for 50 ms between two columns' ends is still painted, nothing is sampled away.
 *
 * Layout (what the GL layer uploads as an R32F texture, width = rows, height = cols): `data[col * rows + row]`, so one
 * column is one contiguous texture row and a live column is a single `texSubImage2D`.
 *
 * A column is left empty (unknown, never carried forward) where the book is unknown — before the first snapshot, after a
 * gap — or STALE: no event for {@link STALE_BOOK_MS} (the EA sends a full snapshot at least every 30 s, so silence
 * that long means the feed stopped, not that the book stood still).
 */

/** No book event for this long: the book is not known any more. */
export const STALE_BOOK_MS = 65_000;
/** Most price rows in one texture (a coarser row is chosen past it). */
export const MAX_ROWS = 2_048;
/** Most time columns in one texture. */
export const MAX_COLS = 8_192;

export interface HeatTextureSpec {
  /** Start of column 0 (epoch ms) and the width of one column (ms). */
  t0: number;
  colMs: number;
  cols: number;
  /** Row 0's price (row r covers p0 + r·rowStep ± rowStep/2). */
  p0: number;
  rowStep: number;
  rows: number;
}

/** Choose the grid for a window: columns ≈ px, rows covering [pLow, pHigh] (with margin) at ≥ the book's tick size. */
export function heatSpecFor(opts: {
  fromUtc: number;
  toUtc: number;
  /** Screen px the window spans at the current zoom. */
  widthPx: number;
  pLow: number;
  pHigh: number;
  /** The book's level spacing (or the symbol's point). */
  levelStep: number;
  /** Price per screen px now (rows finer than a pixel are wasted); null: unknown. */
  pricePerPx: number | null;
}): HeatTextureSpec | null {
  const span = opts.toUtc - opts.fromUtc;
  if (!(span > 0) || !(opts.widthPx > 0) || !(opts.levelStep > 0) || !(opts.pHigh >= opts.pLow))
    return null;
  const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(opts.widthPx)));
  const colMs = Math.max(1, span / cols);
  const margin = Math.max((opts.pHigh - opts.pLow) * 0.5, opts.levelStep * 20);
  const lo = opts.pLow - margin;
  const hi = opts.pHigh + margin;
  let rowStep = opts.levelStep;
  if (opts.pricePerPx && opts.pricePerPx > rowStep)
    rowStep = Math.ceil(opts.pricePerPx / opts.levelStep) * opts.levelStep;
  while ((hi - lo) / rowStep + 1 > MAX_ROWS) rowStep += opts.levelStep;
  const p0 = Math.floor(lo / rowStep) * rowStep;
  const rows = Math.max(1, Math.ceil((hi - p0) / rowStep) + 1);
  return { t0: opts.fromUtc, colMs, cols, p0, rowStep, rows };
}

/**
 * Folds book events into a {@link HeatTextureSpec} grid, incrementally: {@link advanceTo} folds everything up to an
 * instant (the initial build folds the whole window; live, each frame folds what arrived since). Tracks which columns
 * changed since the last {@link takeDirty} for the uploader.
 */
export class HeatFolder {
  readonly data: Float32Array;
  /** Best bid / ask at each column's end (NaN: unknown), for hover and the step lines' fallback. */
  readonly bestBid: Float64Array;
  readonly bestAsk: Float64Array;
  /** Rows outside the grid that held liquidity (a reason to rebuild with a wider range). */
  outOfRange = 0;
  /** Columns folded so far (column `filled - 1` may still be open). */
  filled = 0;
  /** Bumped by every change. */
  version = 0;

  private readonly rowSum: Float64Array;
  private readonly book = new BookState();
  /** Events of the timeline consumed. */
  private consumed = 0;
  /** The instant folded up to (exclusive). */
  private foldedTo: number;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;
  private seeded = -1;

  constructor(
    readonly spec: HeatTextureSpec,
    private readonly timeline: BookTimeline,
  ) {
    this.data = new Float32Array(spec.cols * spec.rows);
    this.rowSum = new Float64Array(spec.rows);
    this.bestBid = new Float64Array(spec.cols).fill(NaN);
    this.bestAsk = new Float64Array(spec.cols).fill(NaN);
    // The book as it stood when column 0 opens.
    const n = timeline.countBefore(spec.t0);
    const start = timeline.afterCount(n);
    this.consumed = n;
    if (start.known) {
      for (const [p, s] of start.bids) this.book.bids.set(p, s);
      for (const [p, s] of start.asks) this.book.asks.set(p, s);
      this.book.known = true;
      this.book.t = start.t;
      this.rebuildRowSums();
    }
    this.foldedTo = spec.t0;
  }

  /** End of the grid (exclusive). */
  get endUtc(): number {
    return this.spec.t0 + this.spec.cols * this.spec.colMs;
  }

  /** The column holding instant `t` (may be out of [0, cols)). */
  colOf(t: number): number {
    return Math.floor((t - this.spec.t0) / this.spec.colMs);
  }

  /** The row holding `price` (may be out of [0, rows)). */
  rowOf(price: number): number {
    return Math.round((price - this.spec.p0) / this.spec.rowStep);
  }

  private rebuildRowSums(): void {
    this.rowSum.fill(0);
    for (const m of [this.book.bids, this.book.asks])
      for (const [p, s] of m) {
        const r = this.rowOf(p);
        if (r >= 0 && r < this.spec.rows) this.rowSum[r] += s;
      }
  }

  private fresh(colStart: number): boolean {
    return this.book.known && colStart - this.book.t <= STALE_BOOK_MS;
  }

  /** Column `c` opens: every row with liquidity starts at its current size. */
  private seed(c: number): void {
    this.seeded = c;
    if (c < 0 || c >= this.spec.cols) return;
    const colStart = this.spec.t0 + c * this.spec.colMs;
    if (!this.fresh(colStart)) return;
    const base = c * this.spec.rows;
    for (const m of [this.book.bids, this.book.asks])
      for (const p of m.keys()) {
        const r = this.rowOf(p);
        if (r < 0 || r >= this.spec.rows) continue;
        const v = this.rowSum[r];
        if (v > this.data[base + r]) this.data[base + r] = v;
      }
    this.markDirty(c);
  }

  private markDirty(c: number): void {
    if (c < this.dirtyFrom) this.dirtyFrom = c;
    if (c > this.dirtyTo) this.dirtyTo = c;
    this.version++;
  }

  /** Rows an event touched (their max is taken once the WHOLE event is applied — a level moving from bid to ask
   *  at one price inside one event is never counted twice). */
  private touched: number[] = [];

  private setLevel(side: Map<number, number>, p: number, s: number): void {
    const old = side.get(p) ?? 0;
    if (s > 0) side.set(p, s);
    else side.delete(p);
    const r = this.rowOf(p);
    if (r < 0 || r >= this.spec.rows) {
      if (s > 0) this.outOfRange++;
      return;
    }
    this.rowSum[r] += s - old;
    if (this.rowSum[r] < 1e-9) this.rowSum[r] = 0;
    this.touched.push(r);
  }

  private applyEvent(e: MdBookEventWire, c: number): void {
    this.touched.length = 0;
    if (e.k === 'S') {
      this.book.bids.clear();
      this.book.asks.clear();
      this.book.known = true;
      this.rowSum.fill(0);
      for (const [p, s] of e.b ?? []) this.setLevel(this.book.bids, p, s);
      for (const [p, s] of e.a ?? []) this.setLevel(this.book.asks, p, s);
    } else {
      if (!this.book.known) return;
      for (const [p, s] of e.b ?? []) this.setLevel(this.book.bids, p, s);
      for (const [p, s] of e.a ?? []) this.setLevel(this.book.asks, p, s);
    }
    this.book.t = e.t;
    this.book.version++;
    if (c >= 0 && c < this.spec.cols) {
      const base = c * this.spec.rows;
      for (const r of this.touched)
        if (this.rowSum[r] > this.data[base + r]) this.data[base + r] = this.rowSum[r];
      this.markDirty(c);
    }
  }

  private closeColumn(c: number): void {
    if (c < 0 || c >= this.spec.cols) return;
    const colEnd = this.spec.t0 + (c + 1) * this.spec.colMs;
    if (this.book.known && colEnd - this.book.t <= STALE_BOOK_MS) {
      this.bestBid[c] = this.book.bestBid() ?? NaN;
      this.bestAsk[c] = this.book.bestAsk() ?? NaN;
    }
  }

  /** Fold every event before `t` (clamped to the grid's end) into the grid. */
  advanceTo(t: number): void {
    const end = Math.min(t, this.endUtc);
    if (!(end > this.foldedTo)) return;
    const { times, events } = this.timeline;
    let c = Math.max(0, this.colOf(this.foldedTo));
    if (this.seeded < c) this.seed(c);
    while (this.consumed < events.length && times[this.consumed] < end) {
      const et = times[this.consumed];
      const ec = this.colOf(et);
      while (c < ec) {
        this.closeColumn(c);
        c++;
        this.seed(c);
      }
      this.applyEvent(events[this.consumed], ec);
      this.consumed++;
    }
    const lastCol = Math.min(this.spec.cols - 1, this.colOf(end - 1e-9));
    while (c < lastCol) {
      this.closeColumn(c);
      c++;
      this.seed(c);
    }
    this.closeColumn(c);
    this.foldedTo = end;
    this.filled = Math.max(this.filled, Math.min(this.spec.cols, c + 1));
  }

  /** The columns changed since the last call ([from, to] inclusive), or null. */
  takeDirty(): { from: number; to: number } | null {
    if (this.dirtyTo < 0) return null;
    const out = { from: this.dirtyFrom, to: this.dirtyTo };
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    return out;
  }

  /** The colour scale's top: the 98th percentile of the non-empty cells (sampled to ≤ 200 000). */
  robustMax(): number {
    const n = this.filled * this.spec.rows;
    const step = Math.max(1, Math.floor(n / 200_000));
    const vals: number[] = [];
    for (let i = 0; i < n; i += step) if (this.data[i] > 0) vals.push(this.data[i]);
    return percentile(vals, 0.98);
  }

  /** The cell under (t, price): its column, row, price and the largest size painted there. */
  cellAt(
    t: number,
    price: number,
  ): { col: number; row: number; price: number; size: number } | null {
    const col = this.colOf(t);
    const row = this.rowOf(price);
    if (col < 0 || col >= this.filled || row < 0 || row >= this.spec.rows) return null;
    return {
      col,
      row,
      price: this.spec.p0 + row * this.spec.rowStep,
      size: this.data[col * this.spec.rows + row],
    };
  }
}

/** A run of the time axis drawn linearly: [t0, t1) between two x's. */
export interface TimeSegment {
  t0: number;
  t1: number;
}

/**
 * Where the time axis is linear on the chart: runs of bars whose opens are one bar apart. A chart lays bars by index,
 * so a session break or weekend (a jump between two opens) is a kink in time → x; each run is drawn as its own quad.
 * Before the first bar and after the last the axis extrapolates linearly (the live edge).
 */
export function timeSegments(
  barTimes: readonly number[],
  barMs: number,
  t0: number,
  t1: number,
): TimeSegment[] {
  if (!(t1 > t0)) return [];
  if (barTimes.length < 2 || !(barMs > 0)) return [{ t0, t1 }];
  const out: TimeSegment[] = [];
  let runStart = t0;
  // Index of the first bar after t0.
  let lo = 0;
  let hi = barTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid] <= t0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(1, lo); i < barTimes.length && barTimes[i - 1] < t1; i++) {
    const gap = barTimes[i] - barTimes[i - 1];
    if (gap > barMs * 1.5) {
      const breakAt = barTimes[i - 1] + barMs;
      if (breakAt > runStart && breakAt < t1) out.push({ t0: runStart, t1: breakAt });
      runStart = Math.max(runStart, barTimes[i]);
    }
  }
  if (t1 > runStart) out.push({ t0: runStart, t1 });
  return out;
}

/** The last bid / ask of each column from ticks (NaN where a column had none). */
export function quoteColumns(
  ticks: {
    size: number;
    timeAt(i: number): number;
    bidAt(i: number): number;
    askAt(i: number): number;
  },
  spec: Pick<HeatTextureSpec, 't0' | 'colMs' | 'cols'>,
): { bid: Float64Array; ask: Float64Array } {
  const bid = new Float64Array(spec.cols).fill(NaN);
  const ask = new Float64Array(spec.cols).fill(NaN);
  for (let i = 0; i < ticks.size; i++) {
    const c = Math.floor((ticks.timeAt(i) - spec.t0) / spec.colMs);
    if (c < 0 || c >= spec.cols) continue;
    bid[c] = ticks.bidAt(i);
    ask[c] = ticks.askAt(i);
  }
  return { bid, ask };
}

/** The book's level spacing: the median gap between neighbouring prices of the first snapshots (≥ `floor`). */
export function bookLevelStep(events: readonly MdBookEventWire[], floor: number): number {
  const gaps: number[] = [];
  for (const e of events) {
    if (e.k !== 'S') continue;
    for (const side of [e.b, e.a]) {
      const ps = side.map((l) => l[0]).sort((x, y) => x - y);
      for (let i = 1; i < ps.length; i++)
        if (ps[i] - ps[i - 1] > floor / 2) gaps.push(ps[i] - ps[i - 1]);
    }
    if (gaps.length > 200) break;
  }
  if (!gaps.length) return floor;
  gaps.sort((x, y) => x - y);
  const g = gaps[gaps.length >> 1];
  return Math.max(floor, Math.round(g / floor) * floor);
}

/** Price range the book's levels covered in a timeline (null: no levels). */
export function bookPriceRange(timeline: BookTimeline): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (levels: readonly [number, number][]) => {
    for (const [p, s] of levels)
      if (s > 0) {
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
  };
  if (timeline.keyframe) {
    take(timeline.keyframe.b);
    take(timeline.keyframe.a);
  }
  for (const e of timeline.events) {
    take(e.b);
    take(e.a);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}
