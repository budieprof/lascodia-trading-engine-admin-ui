import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  PlottedBars,
  barContaining,
  firstChangedBar,
  heikinAshiFrom,
  indexAtTime,
  isPrepend,
  shiftedFrom,
} from './plotted-bars';
import { toRenko } from './price-transforms';

const H = 3_600_000;
const bar = (i: number, c = 1 + i / 100): Bar => ({
  time: i * H,
  open: c - 0.005,
  high: c + 0.01,
  low: c - 0.01,
  close: c,
  volume: 5,
});
const history = (n: number) => Array.from({ length: n }, (_, i) => bar(i));

describe('PlottedBars', () => {
  it('rebuilds on the first data, a new key and history prepended; diffs everything else', () => {
    const p = new PlottedBars();
    const raw = history(10);
    expect(p.update(raw, 'k', { kind: 'none' }, null).rebuild).toBe(true);
    const ticked = [...raw.slice(0, -1), { ...raw[9], close: 5 }];
    expect(p.update(ticked, 'k', { kind: 'none' }, null)).toEqual({
      rebuild: false,
      fromRaw: 9,
      from: 9,
    });
    expect(p.update(ticked, 'other', { kind: 'none' }, null).rebuild).toBe(true);
    expect(p.update([bar(-1), ...ticked], 'other', { kind: 'none' }, null).rebuild).toBe(true);
  });

  it('shifts only the changed tail into the display zone, keeping the rest by reference', () => {
    const p = new PlottedBars();
    const ny = () => -4 * H;
    const raw = history(5);
    p.update(raw, 'k', { kind: 'none' }, ny);
    const before = p.plotted;
    expect(before[0].time).toBe(-4 * H);
    const ticked = [...raw.slice(0, -1), { ...raw[4], close: 3 }];
    p.update(ticked, 'k', { kind: 'none' }, ny);
    expect(p.plotted.slice(0, 4).every((b, i) => b === before[i])).toBe(true);
    expect(p.plotted[4]).toMatchObject({ time: 4 * H - 4 * H, close: 3 });
    expect(p.utc).toBe(ticked);
  });

  it('Heikin-Ashi from the first change equals a full recompute', () => {
    const p = new PlottedBars();
    const raw = history(30);
    p.update(raw, 'k', { kind: 'heikin-ashi' }, null);
    const ticked = [...raw.slice(0, -1), { ...raw[29], close: 0.5, low: 0.4 }];
    p.update(ticked, 'k', { kind: 'heikin-ashi' }, null);
    expect(p.utc).toEqual(heikinAshiFrom(ticked, [], 0));
  });

  it('a price-based style is rebuilt whole and diffed from its first changed brick', () => {
    const p = new PlottedBars();
    const build = (raw: readonly Bar[]) => toRenko(raw as Bar[], 0.02);
    const raw = history(40);
    p.update(raw, 'renko', { kind: 'full', build }, null);
    const bricks = p.utc.length;
    // A quiet tick adds no brick: nothing changed.
    const quiet = [...raw.slice(0, -1), { ...raw[39], close: raw[39].close + 0.001 }];
    const u = p.update(quiet, 'renko', { kind: 'full', build }, null);
    expect(u.rebuild).toBe(false);
    expect(u.from).toBe(bricks);
    // A move of two bricks adds two.
    const run = [...raw.slice(0, -1), { ...raw[39], close: raw[39].close + 0.05, high: 2 }];
    const v = p.update(run, 'renko', { kind: 'full', build }, null);
    expect(v.from).toBe(bricks);
    expect(p.utc.length).toBeGreaterThan(bricks);
  });

  it('replay stepping back drops the plotted tail', () => {
    const p = new PlottedBars();
    const raw = history(10);
    p.update(raw, 'k', { kind: 'none' }, () => H);
    const u = p.update(raw.slice(0, 7), 'k', { kind: 'none' }, () => H);
    expect(u).toEqual({ rebuild: false, fromRaw: 7, from: 7 });
    expect(p.plotted.length).toBe(7);
  });
});

describe('barContaining (CC-05, CC-06)', () => {
  const bars = history(4); // 00:00 … 03:00, H1
  const end = 4 * H;

  it('pins an instant to the bar that opened at or before it — 10:37 is the 10:00 bar', () => {
    expect(barContaining(bars, 1 * H + 37 * 60_000, end)).toBe(1);
    expect(barContaining(bars, 2 * H, end)).toBe(2);
  });

  it('drops an instant before the first bar or after the last bar’s close', () => {
    expect(barContaining(bars, -1, end)).toBe(-1);
    expect(barContaining(bars, end, end)).toBe(-1);
    expect(barContaining(bars, 3 * H + 59 * 60_000, end)).toBe(3);
  });

  it('drops everything after a replay head', () => {
    const head = bars.slice(0, 2);
    expect(barContaining(head, 2 * H + 5, 2 * H)).toBe(-1);
  });
});

describe('helpers', () => {
  it('firstChangedBar / isPrepend / indexAtTime / shiftedFrom', () => {
    const a = history(5);
    expect(firstChangedBar(a, a)).toBe(5);
    expect(firstChangedBar(a, [...a.slice(0, 3), { ...a[3], close: 9 }, a[4]])).toBe(3);
    expect(isPrepend(a.slice(2), a)).toBe(true);
    expect(isPrepend(a, a.slice(2))).toBe(false);
    expect(indexAtTime(a, 3 * H)).toBe(3);
    expect(indexAtTime(a, 3 * H + 1)).toBe(-1);
    expect(shiftedFrom(a, [], 0, null)).toBe(a);
  });
});
