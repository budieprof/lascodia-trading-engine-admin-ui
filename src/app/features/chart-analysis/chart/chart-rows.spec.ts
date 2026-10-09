import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  firstChangedValue,
  ohlcRows,
  priceRowsFrom,
  samePriceRow,
  valueRowsFrom,
  volumeRowsFrom,
  type PriceRow,
  type ValueRow,
  type VolumeRow,
} from './chart-rows';
import { PlottedBars } from './plotted-bars';
import { toKagi, toPointAndFigure } from './price-transforms';
import { SeriesSync, sameValueRow, type SyncTarget } from './series-sync';

const H = 3_600_000;
const PALETTE = {
  up: '#089981',
  down: '#F23645',
  volumeUp: 'rgba(8,153,129,0.5)',
  volumeDown: 'rgba(242,54,69,0.5)',
};

const bar = (i: number, c = 1.1 + i / 1000, volume = 10): Bar => ({
  time: i * H,
  open: c - 0.0005,
  high: c + 0.001,
  low: c - 0.001,
  close: c,
  volume,
});
const history = (n: number) => Array.from({ length: n }, (_, i) => bar(i));

/** A stand-in series: records every call, holds rows as the library would. */
class Recording<T extends { time: unknown }> implements SyncTarget<T> {
  data: T[] = [];
  calls: string[] = [];
  setData(data: T[]): void {
    this.calls.push(`setData(${data.length})`);
    this.data = [...data];
  }
  update(row: T, historical = false): void {
    this.calls.push('update');
    const last = this.data[this.data.length - 1];
    if (!last || (row.time as number) > (last.time as number)) this.data.push(row);
    else if (row.time === last.time) this.data[this.data.length - 1] = row;
    else if (historical) this.data[this.data.findIndex((r) => r.time === row.time)] = row;
    else throw new Error('Cannot update oldest data');
  }
  pop(count: number): T[] {
    this.calls.push(`pop(${count})`);
    return this.data.splice(this.data.length - count, count);
  }
}

describe('priceRowsFrom', () => {
  it('reuses the rows before the first changed bar by reference', () => {
    const bars = history(10);
    const first = priceRowsFrom('candles', bars, null, PALETTE, 0, []);
    const ticked = [...bars.slice(0, -1), { ...bars[9], close: 2 }];
    const next = priceRowsFrom('candles', ticked, null, PALETTE, 9, first);
    expect(next.slice(0, 9).every((r, i) => r === first[i])).toBe(true);
    expect(next[9].close).toBe(2);
  });

  it('builds the same candle rows as the scripts’ colour refresh (ohlcRows)', () => {
    const bars = history(5);
    const colors = [null, '#ff0000', null, '#00ff00', '#0000ff'];
    const rows = priceRowsFrom('candles', bars, colors, PALETTE, 0, []);
    const refresh = ohlcRows(bars, colors, 'candle');
    expect(rows.every((r, i) => samePriceRow(r, refresh[i] as PriceRow))).toBe(true);
  });

  it('keeps the forming bar’s script colour on a tick', () => {
    const bars = history(5);
    const colors = [null, null, null, null, '#ff00ff'];
    const rows = priceRowsFrom('candles', bars, colors, PALETTE, 0, []);
    const ticked = [...bars.slice(0, -1), { ...bars[4], close: 9 }];
    const next = priceRowsFrom('candles', ticked, colors, PALETTE, 4, rows);
    expect(next[4]).toMatchObject({ close: 9, color: '#ff00ff', borderColor: '#ff00ff' });
  });

  it('writes a value row for line styles and an up/down colour for columns', () => {
    const bars = [bar(0, 1), { ...bar(1, 2), open: 3 }];
    expect(priceRowsFrom('line', bars, null, PALETTE, 0, [])[1]).toEqual({ time: 3600, value: 2 });
    expect(priceRowsFrom('column', bars, null, PALETTE, 0, [])[1]).toMatchObject({
      value: 2,
      color: PALETTE.down,
    });
  });

  it('gives the HLC area its high, low and close (CC-23: it was the area series)', () => {
    const row = priceRowsFrom('hlc-area', [bar(0, 1)], null, PALETTE, 0, [])[0];
    expect(row).toMatchObject({ high: 1.001, low: 0.999, close: 1 });
  });
});

describe('valueRowsFrom — gaps (DR-17)', () => {
  const times = history(5);
  const values = [1, null, null, 4, 5];

  it('join leaves the bars without a value out, so the line runs across them', () => {
    expect(valueRowsFrom(times, values, 'join', 0, []).map((r) => r.time)).toEqual([
      0, 10800, 14400,
    ]);
  });

  it('break writes whitespace, so the line stops and starts again', () => {
    const rows = valueRowsFrom(times, values, 'break', 0, []);
    expect(rows).toEqual([
      { time: 0, value: 1 },
      { time: 3600 },
      { time: 7200 },
      { time: 10800, value: 4 },
      { time: 14400, value: 5 },
    ]);
  });

  it('a tail rewrite keeps the earlier rows by reference', () => {
    const first = valueRowsFrom(times, values, 'join', 0, []);
    const next = valueRowsFrom(times, [1, null, null, 4, 6], 'join', 4, first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(next[2]).toEqual({ time: 14400, value: 6 });
  });

  it('a rebuild from bar 0 keeps nothing — rows on another zone’s clock could precede the new first bar', () => {
    // New York rows (4 h earlier), then the chart back on UTC: rows at 20:00–23:00 NY are all
    // before 00:00 UTC's first bar … and must not survive.
    const ny = history(10).map((b) => ({ ...b, time: b.time - 4 * H }));
    const first = valueRowsFrom(
      ny,
      history(10).map((b) => b.close),
      'join',
      0,
      [],
    );
    const utc = history(10);
    const rebuilt = valueRowsFrom(
      utc,
      utc.map((b) => b.close),
      'join',
      0,
      first,
    );
    expect(rebuilt.map((r) => r.time)).toEqual(utc.map((b) => b.time / 1000));
  });

  it('bars taken off the end take their rows with them', () => {
    const first = valueRowsFrom(times, values, 'break', 0, []);
    const shorter = times.slice(0, 3);
    expect(valueRowsFrom(shorter, values.slice(0, 3), 'break', 3, first).length).toBe(3);
  });
});

describe('firstChangedValue', () => {
  it('treats null, undefined and NaN as the same gap', () => {
    expect(firstChangedValue([1, null, NaN], [1, undefined as unknown as null, null])).toBe(3);
  });
  it('finds the first difference', () => {
    expect(firstChangedValue([1, 2, 3], [1, 2, 4])).toBe(2);
    expect(firstChangedValue([1, 2], [1, 2, 3])).toBe(2);
  });
});

describe('what a live price costs the chart (CC-I1 harness)', () => {
  /**
   * The chart's whole tick path, as chart-host runs it: plotted bars from the first changed bar,
   * then the price, volume and one study written from there. Before CC-I1 each tick removed and
   * re-added the price series and re-sent every row of every series (setData × 3 + addSeries × 1).
   */
  function harness(style: 'candles' | 'heikin-ashi', zone: ((t: number) => number) | null) {
    const plotter = new PlottedBars();
    const price = new Recording<PriceRow>();
    const volume = new Recording<VolumeRow>();
    const study = new Recording<ValueRow>();
    const priceSync = new SeriesSync<PriceRow>(price, samePriceRow);
    const volumeSync = new SeriesSync<VolumeRow>(volume, sameValueRow);
    const studySync = new SeriesSync<ValueRow>(study, sameValueRow);
    let values: (number | null)[] = [];
    const transform =
      style === 'heikin-ashi' ? { kind: 'heikin-ashi' as const } : { kind: 'none' as const };
    const apply = (raw: Bar[]) => {
      const u = plotter.update(raw, `EURUSD|60|${style}`, transform, zone);
      const from = u.rebuild ? 0 : u.from;
      priceSync.apply(priceRowsFrom(style, plotter.plotted, null, PALETTE, from, priceSync.rows()));
      volumeSync.apply(volumeRowsFrom(plotter.plotted, PALETTE, from, volumeSync.rows()));
      // A 3-bar moving average of the close.
      const next = plotter.plotted.map((_, i, a) =>
        i < 2 ? null : (a[i].close + a[i - 1].close + a[i - 2].close) / 3,
      );
      const vFrom = Math.min(from, firstChangedValue(values, next));
      values = next;
      studySync.apply(valueRowsFrom(plotter.plotted, next, 'join', vFrom, studySync.rows()));
    };
    return { apply, price, volume, study };
  }

  for (const [style, zone, label] of [
    ['candles', null, 'candles, UTC'],
    ['heikin-ashi', () => -4 * H, 'Heikin-Ashi, New York'],
  ] as const) {
    it(`${label}: one setData per series at load, then one update per series per tick`, () => {
      const h = harness(style, zone);
      let raw = history(1500);
      h.apply(raw);
      for (const s of [h.price, h.volume, h.study]) {
        expect(s.calls).toEqual([expect.stringMatching(/^setData/)]);
        s.calls = [];
      }

      // A minute of ticks on the forming bar, then the next bar opening.
      for (let s = 0; s < 60; s++) {
        raw = [...raw.slice(0, -1), { ...raw[raw.length - 1], close: 1.6 + s / 10_000 }];
        h.apply(raw);
      }
      raw = [...raw, bar(1500, 1.7)];
      h.apply(raw);

      for (const s of [h.price, h.volume, h.study])
        expect(s.calls.filter((c) => c !== 'update')).toEqual([]);
      // The price row and the study's value move on every tick; the volume row only when its
      // volume or colour does.
      expect(h.price.calls.length).toBe(61);
      expect(h.study.calls.length).toBe(61);
      expect(h.volume.calls.length).toBeLessThanOrEqual(61);
      expect(h.price.data.length).toBe(1501);
      // The new bar is on the display clock (New York: four hours before its UTC open).
      expect(h.price.data[1500].time).toBe((1500 * H + (zone ? zone() : 0)) / 1000);
    });
  }

  it('history loaded on the left rebuilds: one setData per series', () => {
    const h = harness('candles', null);
    h.apply(history(20).slice(10));
    for (const s of [h.price, h.volume, h.study]) s.calls = [];
    h.apply(history(20));
    for (const s of [h.price, h.volume, h.study])
      expect(s.calls).toEqual([expect.stringMatching(/^setData\(/)]);
  });

  it('replay stepping back pops the rows, with no setData', () => {
    const h = harness('candles', null);
    const all = history(100);
    h.apply(all.slice(0, 80));
    h.price.calls = [];
    h.apply(all.slice(0, 79));
    expect(h.price.calls).toEqual(['pop(1)']);
    expect(h.price.data.length).toBe(79);
  });
});

describe('price rows of the P&F and Kagi custom series (CC-I10)', () => {
  const palette = { up: '#0f0', down: '#f00', volumeUp: '#0f0', volumeDown: '#f00' };
  const H = 3_600_000;
  const closes = [100, 101.5, 103.4, 101.2, 100.0, 102.5, 104.0, 110, 104, 108, 101];
  const bars = closes.map((c, i) => ({ time: i * H, open: c, high: c, low: c, close: c, volume: 1 }));

  it('P&F rows carry the box and the column’s direction', () => {
    const rows = priceRowsFrom('pnf', toPointAndFigure(bars, 1, 3), null, palette, 0, []);
    expect(rows[0]).toMatchObject({ low: 100, high: 103, box: 1, up: true });
    expect(rows[1]).toMatchObject({ box: 1, up: false });
  });

  it('Kagi rows carry the thickness and where it changes, and a change of it is a changed row', () => {
    const rows = priceRowsFrom('kagi', toKagi(bars, 3), null, palette, 0, []);
    expect(rows.every((r) => typeof r.thickStart === 'boolean' && r.switchAt !== undefined)).toBe(true);
    expect(samePriceRow(rows[0], { ...rows[0], switchAt: 1 })).toBe(false);
  });
});
