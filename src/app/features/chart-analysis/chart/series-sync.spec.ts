import { describe, expect, it } from 'vitest';
import {
  SeriesSync,
  planTail,
  sameOhlcRow,
  sameValueRow,
  type SyncTarget,
} from './series-sync';

type Row = { time: number; open: number; high: number; low: number; close: number };

/** A stand-in series that records every call and holds the rows as the library would. */
class RecordingSeries implements SyncTarget<Row> {
  data: Row[] = [];
  calls: string[] = [];
  setData(data: Row[]): void {
    this.calls.push(`setData(${data.length})`);
    this.data = [...data];
  }
  update(row: Row, historical = false): void {
    this.calls.push(historical ? 'update(historical)' : 'update');
    const last = this.data[this.data.length - 1];
    if (!last || row.time > last.time) this.data.push(row);
    else if (row.time === last.time) this.data[this.data.length - 1] = row;
    else if (historical) {
      const i = this.data.findIndex((r) => r.time === row.time);
      if (i < 0) throw new Error('no such row');
      this.data[i] = row;
    } else throw new Error('Cannot update oldest data');
  }
  pop(count: number): Row[] {
    this.calls.push(`pop(${count})`);
    return this.data.splice(this.data.length - count, count);
  }
}

const bar = (t: number, c: number): Row => ({ time: t, open: c, high: c + 1, low: c - 1, close: c });
const history = (n: number) => Array.from({ length: n }, (_, i) => bar(i * 3600, 100 + i));

describe('planTail', () => {
  it('is empty when nothing changed', () => {
    const rows = history(5);
    expect(planTail(rows, [...rows], sameOhlcRow)).toEqual({ pop: 0, writes: [] });
  });

  it('writes only the newest row when a tick moved it', () => {
    const prev = history(5);
    const next = [...prev.slice(0, -1), { ...prev[4], close: 200 }];
    expect(planTail(prev, next, sameOhlcRow)).toEqual({
      pop: 0,
      writes: [{ row: next[4], historical: false }],
    });
  });

  it('appends a new bar after updating the one before it', () => {
    const prev = history(5);
    const next = [...prev.slice(0, -1), { ...prev[4], close: 200 }, bar(5 * 3600, 201)];
    const plan = planTail(prev, next, sameOhlcRow)!;
    expect(plan.pop).toBe(0);
    expect(plan.writes.map((w) => [w.row.time, w.historical])).toEqual([
      [4 * 3600, false],
      [5 * 3600, false],
    ]);
  });

  it('marks rows before the last as historical updates', () => {
    const prev = history(6);
    const next = prev.map((r, i) => (i >= 3 ? { ...r, close: r.close + 1 } : r));
    const plan = planTail(prev, next, sameOhlcRow)!;
    expect(plan.writes.map((w) => w.historical)).toEqual([true, true, false]);
  });

  it('pops rows gone off the end (replay stepping back)', () => {
    const prev = history(6);
    expect(planTail(prev, prev.slice(0, 4), sameOhlcRow)).toEqual({ pop: 2, writes: [] });
  });

  it('refuses a change that inserts a row before the tail', () => {
    const prev = [bar(0, 1), bar(3600, 2), bar(10800, 3)];
    const next = [bar(0, 1), bar(3600, 2), bar(7200, 9), bar(10800, 3)];
    expect(planTail(prev, next, sameOhlcRow)).toBeNull();
  });

  it('refuses more in-place changes than are worth updating one by one', () => {
    const prev = history(100);
    const next = prev.map((r) => ({ ...r, close: r.close + 1 }));
    expect(planTail(prev, next, sameOhlcRow, 32)).toBeNull();
  });
});

describe('SeriesSync — what a live price costs (CC-I1 harness)', () => {
  it('a tick is one update, never a setData', () => {
    const series = new RecordingSeries();
    const sync = new SeriesSync<Row>(series, sameOhlcRow);
    let rows = history(1500);
    sync.apply(rows);
    expect(series.calls).toEqual(['setData(1500)']);
    series.calls = [];

    // A minute of ticks on the forming bar, then the next bar opening.
    for (let s = 0; s < 60; s++) {
      rows = [...rows.slice(0, -1), { ...rows[rows.length - 1], close: 100 + s / 100 }];
      sync.apply(rows);
    }
    rows = [...rows, bar(1500 * 3600, 300)];
    sync.apply(rows);

    expect(series.calls.filter((c) => c.startsWith('setData'))).toEqual([]);
    expect(series.calls.length).toBe(61); // 60 ticks + the new bar
    expect(series.data).toEqual(rows);
    expect(sync.ops).toEqual({ setData: 1, update: 61, pop: 0 });
  });

  it('applies nothing for an equal copy of the same rows', () => {
    const series = new RecordingSeries();
    const sync = new SeriesSync<Row>(series, sameOhlcRow);
    const rows = history(10);
    sync.apply(rows);
    series.calls = [];
    expect(sync.apply(rows.map((r) => ({ ...r })))).toBe('none');
    expect(series.calls).toEqual([]);
  });

  it('sends everything again when history is prepended', () => {
    const series = new RecordingSeries();
    const sync = new SeriesSync<Row>(series, sameOhlcRow);
    const rows = history(10).slice(5);
    sync.apply(rows);
    expect(sync.apply(history(10))).toBe('full');
    expect(series.data).toEqual(history(10));
  });

  it('a new series starts whole, whatever the old one held', () => {
    const a = new RecordingSeries();
    const sync = new SeriesSync<Row>(a, sameOhlcRow);
    sync.apply(history(5));
    const b = new RecordingSeries();
    sync.attach(b);
    sync.apply(history(5));
    expect(b.calls).toEqual(['setData(5)']);
  });

  it('falls back to setData when the series refuses an update', () => {
    const series = new RecordingSeries();
    const sync = new SeriesSync<Row>(series, sameOhlcRow);
    sync.apply(history(5));
    // Something else replaced the series' rows behind the sync's back.
    series.data = history(3);
    const next = [...history(5).slice(0, 2), { ...bar(2 * 3600, 50) }, ...history(5).slice(3)];
    sync.apply(next);
    expect(series.data).toEqual(next);
  });

  it('whitespace rows compare by time and absence of value', () => {
    expect(sameValueRow({ time: 1 }, { time: 1 })).toBe(true);
    expect(sameValueRow({ time: 1 }, { time: 1, value: 2 })).toBe(false);
  });
});
