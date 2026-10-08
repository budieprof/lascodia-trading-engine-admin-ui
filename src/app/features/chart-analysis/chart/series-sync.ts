/**
 * Keeps a Lightweight Charts series in step with a list of rows by the least the library has to
 * redraw (CC-I1): nothing when the rows are the same; the changed tail through `update()` — and
 * `pop()` for rows gone off the end — when only the newest rows moved; `setData()` only when
 * something further back changed, or there is nothing on the series yet.
 *
 * <p>A live price moves the newest bar once a second. Re-sending every bar for that (and before this,
 * removing and re-adding the whole price series) cost a full redraw per tick, reset resized panes and
 * jumped the legend. A tick is one `update()` now.</p>
 *
 * <p>Pure apart from the series it is handed, so the rules are tested with a recording stand-in —
 * which is also how the per-tick cost is measured (`series-sync.spec.ts`).</p>
 */

/** A row of any series: its time, in the library's seconds. */
export interface TimedRow {
  time: unknown;
}

/** The part of a series a sync drives. */
export interface SyncTarget<T> {
  setData(data: T[]): void;
  update(row: T, historicalUpdate?: boolean): void;
  pop(count: number): unknown;
}

/** What one {@link SeriesSync.apply} asked the series to do. */
export type SyncOutcome = 'none' | 'tail' | 'full';

/**
 * Rows changed in place further back than this many from the end are re-sent whole: a historical
 * update costs the library more than an append, and past a few dozen `setData` is cheaper.
 */
export const MAX_TAIL_UPDATES = 32;

/** The plan for one change: rows to drop from the end, then rows to write in order. */
export interface TailPlan<T> {
  pop: number;
  /** Rows to write; `historical` when the row replaces one before the series' last. */
  writes: { row: T; historical: boolean }[];
}

/**
 * How to turn `prev` (on the series) into `next` with `pop` and `update`, or null when only
 * `setData` can: a row inserted or removed before the tail, more than {@link MAX_TAIL_UPDATES} rows
 * changed in place, or rows that are not in ascending time.
 */
export function planTail<T extends TimedRow>(
  prev: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean,
  maxTail = MAX_TAIL_UPDATES,
): TailPlan<T> | null {
  const common = Math.min(prev.length, next.length);
  let d = 0;
  while (d < common && same(prev[d], next[d])) d++;
  if (d === prev.length && d === next.length) return { pop: 0, writes: [] };
  // Rows changed in place must keep their times: update() replaces the row AT a time, it cannot
  // move one. A changed time before the end means rows were inserted or removed in between.
  const inPlaceEnd = common;
  if (inPlaceEnd - d > maxTail) return null;
  for (let i = d; i < inPlaceEnd; i++) if (prev[i].time !== next[i].time) return null;
  const pop = Math.max(0, prev.length - next.length);
  const lastKept = prev.length - pop - 1;
  const writes: TailPlan<T>['writes'] = [];
  for (let i = d; i < next.length; i++) {
    // A row past the ones kept must come after the row before it, or the library rejects it.
    if (i > 0 && !((next[i].time as number) > (next[i - 1].time as number))) return null;
    writes.push({ row: next[i], historical: i < lastKept });
  }
  return { pop, writes };
}

/** One series and the rows last written to it. */
export class SeriesSync<T extends TimedRow> {
  private applied: readonly T[] = [];
  /** Calls made on the series since this sync was created, for the per-tick harness. */
  readonly ops = { setData: 0, update: 0, pop: 0 };

  constructor(
    private target: SyncTarget<T> | null,
    private readonly same: (a: T, b: T) => boolean,
    private readonly maxTail = MAX_TAIL_UPDATES,
  ) {}

  /** The rows the series holds as far as this sync knows. */
  rows(): readonly T[] {
    return this.applied;
  }

  /** A new series (or none): the next {@link apply} sets its data whole. */
  attach(target: SyncTarget<T> | null): void {
    this.target = target;
    this.applied = [];
  }

  /**
   * The series was given exactly `rows` by someone else (a colour refresh that re-sent the same
   * bars): take them as applied, so the next change is diffed against what is really on it.
   */
  adopt(rows: readonly T[]): void {
    this.applied = rows;
  }

  apply(rows: readonly T[]): SyncOutcome {
    const target = this.target;
    if (!target) {
      this.applied = rows;
      return 'none';
    }
    const plan = this.applied.length ? planTail(this.applied, rows, this.same, this.maxTail) : null;
    if (plan && plan.pop === 0 && plan.writes.length === 0) {
      this.applied = rows;
      return 'none';
    }
    if (!plan) {
      target.setData([...rows]);
      this.ops.setData++;
      this.applied = rows;
      return 'full';
    }
    try {
      if (plan.pop > 0) {
        target.pop(plan.pop);
        this.ops.pop++;
      }
      for (const w of plan.writes) {
        target.update(w.row, w.historical);
        this.ops.update++;
      }
    } catch {
      // The series refused an update (it held other rows than this sync thought): send it whole.
      target.setData([...rows]);
      this.ops.setData++;
    }
    this.applied = rows;
    return 'tail';
  }
}

/** Equality of candle / bar rows, script colours included. */
export function sameOhlcRow(
  a: {
    time: unknown;
    open: number;
    high: number;
    low: number;
    close: number;
    color?: string;
    borderColor?: string;
    wickColor?: string;
  },
  b: typeof a,
): boolean {
  return (
    a === b ||
    (a.time === b.time &&
      a.open === b.open &&
      a.high === b.high &&
      a.low === b.low &&
      a.close === b.close &&
      a.color === b.color &&
      a.borderColor === b.borderColor &&
      a.wickColor === b.wickColor)
  );
}

/** Equality of the custom series' rows (HiLo, volume candles), volume included. */
export function sameOhlcvRow(
  a: {
    time: unknown;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    color?: string;
  },
  b: typeof a,
): boolean {
  return a === b || (sameOhlcRow(a, b) && a.volume === b.volume);
}

/** Equality of single-value rows (line, area, histogram), whitespace (no value) included. */
export function sameValueRow(
  a: { time: unknown; value?: number; color?: string },
  b: typeof a,
): boolean {
  return a === b || (a.time === b.time && a.value === b.value && a.color === b.color);
}
