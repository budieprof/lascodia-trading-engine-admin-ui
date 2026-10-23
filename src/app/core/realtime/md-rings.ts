import type { MdTicksWire, MdTradesWire } from './marketdata.types';

/**
 * Fixed-capacity ring buffers of typed arrays for the live stream: renderers read them per frame without allocating,
 * and nothing in them goes through Angular change detection. Indexes are logical: 0 = the oldest held, size−1 = the
 * newest. Pushing past capacity overwrites the oldest.
 */
abstract class Ring {
  protected head = 0;
  size = 0;
  /** Everything ever pushed (a cheap "changed?" key). */
  pushed = 0;

  constructor(readonly capacity: number) {}

  /** Physical slot of logical index `i`. */
  protected slot(i: number): number {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return (start + i) % this.capacity;
  }

  protected advance(): number {
    const s = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.pushed++;
    return s;
  }

  abstract timeAt(i: number): number;

  /** Logical index of the first item with time ≥ `t` (size when none). Items are pushed in time order. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  get lastTime(): number {
    return this.size ? this.timeAt(this.size - 1) : NaN;
  }
}

/** Ticks: time, bid, ask, flags, volume. */
export class TickRing extends Ring {
  private readonly t: Float64Array;
  private readonly b: Float64Array;
  private readonly a: Float64Array;
  private readonly v: Float64Array;
  private readonly f: Int32Array;

  constructor(capacity = 65_536) {
    super(capacity);
    this.t = new Float64Array(capacity);
    this.b = new Float64Array(capacity);
    this.a = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.f = new Int32Array(capacity);
  }

  /** Append one tick; one older than the newest held is dropped (false). */
  push(t: number, bid: number, ask: number, flags = 0, volume = 0): boolean {
    if (this.size && t < this.lastTime) return false;
    const s = this.advance();
    this.t[s] = t;
    this.b[s] = bid;
    this.a[s] = ask;
    this.f[s] = flags;
    this.v[s] = volume;
    return true;
  }

  /** Append C1 columns; returns how many were kept. */
  pushColumns(c: MdTicksWire): number {
    let kept = 0;
    const n = Math.min(c.t?.length ?? 0, c.b?.length ?? 0, c.a?.length ?? 0);
    for (let i = 0; i < n; i++)
      if (this.push(c.t[i], c.b[i], c.a[i], c.f?.[i] ?? 0, c.v?.[i] ?? 0)) kept++;
    return kept;
  }

  timeAt(i: number): number {
    return this.t[this.slot(i)];
  }
  bidAt(i: number): number {
    return this.b[this.slot(i)];
  }
  askAt(i: number): number {
    return this.a[this.slot(i)];
  }
  flagsAt(i: number): number {
    return this.f[this.slot(i)];
  }
  volumeAt(i: number): number {
    return this.v[this.slot(i)];
  }

  /** The newest tick, or null. */
  last(): { t: number; bid: number; ask: number } | null {
    if (!this.size) return null;
    const i = this.size - 1;
    return { t: this.timeAt(i), bid: this.bidAt(i), ask: this.askAt(i) };
  }

  /** The ticks in [from, to) as C1 columns (a copy). */
  slice(from: number, to: number): MdTicksWire {
    const i0 = this.lowerBound(from);
    const i1 = this.lowerBound(to);
    const out: MdTicksWire = { t: [], b: [], a: [], f: [], v: [] };
    for (let i = i0; i < i1; i++) {
      out.t.push(this.timeAt(i));
      out.b.push(this.bidAt(i));
      out.a.push(this.askAt(i));
      out.f!.push(this.flagsAt(i));
      out.v!.push(this.volumeAt(i));
    }
    return out;
  }
}

/** Aggressor side as stored: 1 buyer-initiated, −1 seller-initiated, 0 unknown. */
export function sideCode(side: string | null | undefined): number {
  return side === 'B' ? 1 : side === 'S' ? -1 : 0;
}

/** Trades: time, price, size, aggressor side. */
export class TradeRing extends Ring {
  private readonly t: Float64Array;
  private readonly p: Float64Array;
  private readonly s: Float64Array;
  private readonly side: Int8Array;

  constructor(capacity = 32_768) {
    super(capacity);
    this.t = new Float64Array(capacity);
    this.p = new Float64Array(capacity);
    this.s = new Float64Array(capacity);
    this.side = new Int8Array(capacity);
  }

  push(t: number, price: number, size: number, side: number): boolean {
    if (this.size && t < this.lastTime) return false;
    const k = this.advance();
    this.t[k] = t;
    this.p[k] = price;
    this.s[k] = size;
    this.side[k] = side;
    return true;
  }

  pushColumns(c: MdTradesWire): number {
    let kept = 0;
    const n = Math.min(c.t?.length ?? 0, c.p?.length ?? 0, c.s?.length ?? 0);
    for (let i = 0; i < n; i++)
      if (this.push(c.t[i], c.p[i], c.s[i], sideCode(c.side?.[i]))) kept++;
    return kept;
  }

  timeAt(i: number): number {
    return this.t[this.slot(i)];
  }
  priceAt(i: number): number {
    return this.p[this.slot(i)];
  }
  sizeAt(i: number): number {
    return this.s[this.slot(i)];
  }
  sideAt(i: number): number {
    return this.side[this.slot(i)];
  }
}
