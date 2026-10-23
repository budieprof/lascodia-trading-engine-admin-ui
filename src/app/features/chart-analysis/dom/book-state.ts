/**
 * One source's order book, kept from the market-data hub's C2 events (engine contract C2/C4): an `S` event is a full
 * snapshot (it replaces everything), a `D` event carries changed levels only, with size 0 = the level is gone. Pure and
 * allocation-light: two Maps keyed by price, mutated in place, so a renderer can read them every frame.
 */

/** One C2 book event as the hub sends it. */
export interface MdBookEvent {
  /** EA clock, epoch ms UTC. */
  t: number;
  k: 'S' | 'D' | string;
  b: ReadonlyArray<readonly [number, number] | number[]>;
  a: ReadonlyArray<readonly [number, number] | number[]>;
}

/** C1 columnar ticks. */
export interface MdTicks {
  t: readonly number[];
  b: readonly number[];
  a: readonly number[];
  f?: readonly number[];
  v?: readonly number[];
}

/** One `md` frame of the hub. */
export interface MdFrame {
  symbol: string;
  sourceId: string;
  ticks?: MdTicks | null;
  book?: MdBookEvent[] | null;
  trades?: unknown;
}

export interface BookState {
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  /** Time of the last event applied (epoch ms); 0 = none. */
  t: number;
  /** False until the first `S`: deltas before a snapshot cannot be placed and are dropped. */
  hasSnapshot: boolean;
}

export function emptyBook(): BookState {
  return { bids: new Map(), asks: new Map(), t: 0, hasSnapshot: false };
}

function applySide(side: Map<number, number>, levels: MdBookEvent['b']): void {
  for (const level of levels) {
    const price = Number(level[0]);
    const size = Number(level[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) continue;
    if (size <= 0) side.delete(price);
    else side.set(price, size);
  }
}

/**
 * Applies events in order. Returns false when a delta arrived with no snapshot to apply it to (the caller should
 * wait for the next `S` — the engine re-sends one after any drop).
 */
export function applyBookEvents(book: BookState, events: readonly MdBookEvent[]): boolean {
  let ok = true;
  for (const e of events) {
    if (e.k === 'S') {
      book.bids.clear();
      book.asks.clear();
      applySide(book.bids, e.b);
      applySide(book.asks, e.a);
      book.hasSnapshot = true;
      book.t = e.t;
    } else if (e.k === 'D') {
      if (!book.hasSnapshot) {
        ok = false;
        continue;
      }
      applySide(book.bids, e.b);
      applySide(book.asks, e.a);
      book.t = e.t;
    }
  }
  return ok;
}

/** The highest bid and lowest ask in the book (null when a side is empty). */
export function bestPrices(book: BookState): { bid: number | null; ask: number | null } {
  let bid: number | null = null;
  let ask: number | null = null;
  for (const p of book.bids.keys()) if (bid === null || p > bid) bid = p;
  for (const p of book.asks.keys()) if (ask === null || p < ask) ask = p;
  return { bid, ask };
}

/** The book replaced by a polled snapshot (the 1.5 s fallback when the hub is not available). */
export function bookFromLevels(
  bids: ReadonlyArray<{ price: number; volume: number }>,
  asks: ReadonlyArray<{ price: number; volume: number }>,
  t: number,
): BookState {
  const book = emptyBook();
  for (const l of bids) if (l.price > 0 && l.volume > 0) book.bids.set(l.price, l.volume);
  for (const l of asks) if (l.price > 0 && l.volume > 0) book.asks.set(l.price, l.volume);
  book.t = t;
  book.hasSnapshot = true;
  return book;
}
