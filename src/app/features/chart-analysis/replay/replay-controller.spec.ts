import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import type { Bar } from '../datafeed/candle-feed.service';
import { ReplayController } from './replay-controller';

const H = 3_600_000;
const M = 60_000;
const T0 = Date.parse('2026-09-14T00:00:00Z');

const hour = (i: number, close = 1.1): Bar => ({
  time: T0 + i * H,
  open: close,
  high: close + 0.001,
  low: close - 0.001,
  close,
  volume: 60,
  spreadPoints: 10,
});
/** Three minutes per hour, the middle one dipping 30 pips. */
const minutesOf = (from: number, to: number): Bar[] => {
  const out: Bar[] = [];
  for (let t = from - (from % H); t < to; t += H) {
    if (t < from) continue;
    out.push({ time: t, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, volume: 1, spreadPoints: 6 });
    out.push({ time: t + M, open: 1.1, high: 1.1, low: 1.097, close: 1.098, volume: 1, spreadPoints: 7 });
    out.push({ time: t + 2 * M, open: 1.098, high: 1.1, low: 1.098, close: 1.099, volume: 1, spreadPoints: 8 });
  }
  return out;
};

function setup(n = 10) {
  const bars = signal<Bar[]>(Array.from({ length: n }, (_, i) => hour(i)));
  const fetchIntrabar = vi.fn((_res: string, from: number, to: number) => Promise.resolve(minutesOf(from, to + 1)));
  const c = new ReplayController({
    bars,
    resolution: () => '60',
    digits: () => 5,
    symbolFacts: () => ({ pipSize: 0.0001, contractSize: 100_000 }),
    fetchIntrabar,
  });
  return { c, bars, fetchIntrabar };
}

describe('ReplayController', () => {
  it('starts at a time and shows the bars up to it', () => {
    const { c } = setup();
    c.startAt(T0 + 4 * H + 30 * M);
    expect(c.active()).toBe(true);
    expect(c.view()).toHaveLength(5);
    expect(c.closedHead()?.time).toBe(T0 + 4 * H);
  });

  it('steps through the next bar’s 1m bars, loading them once, then closes it', async () => {
    const { c, fetchIntrabar } = setup();
    c.start(3);
    await c.ensureIntrabar(3);
    await c.step(1);
    expect(c.view()).toHaveLength(4);
    expect(c.view()[3]).toMatchObject({ time: T0 + 3 * H, close: 1.1 });
    // Scripts still run to the last closed bar.
    expect(c.closedHead()?.time).toBe(T0 + 2 * H);
    await c.step(1);
    expect(c.view()[3].close).toBe(1.098);
    await c.step(1);
    expect(c.cursor()).toEqual({ index: 4, sub: null });
    expect(c.view()[3]).toMatchObject({ close: 1.1 }); // the stored bar itself
    // One request covered this bar and the ones after it.
    expect(fetchIntrabar.mock.calls.filter((call) => call[1] === T0 + 3 * H)).toHaveLength(1);
  });

  it('steps whole bars with intrabar off', async () => {
    const { c, fetchIntrabar } = setup();
    c.intrabar.set(false);
    c.start(3);
    await c.step(1);
    expect(c.cursor()).toEqual({ index: 4, sub: null });
    expect(fetchIntrabar).not.toHaveBeenCalled();
  });

  it('fills paper trades on what each step reveals, at the ask for a buy, and undoes them on the way back', async () => {
    const { c } = setup();
    c.start(3);
    await c.ensureIntrabar(3);
    // Head: bar 2, close 1.1, 10 points of spread → a buy fills at 1.1001.
    expect(c.place('buy', 1, 20, null)).toBeNull();
    expect(c.trades()[0].entry).toBeCloseTo(1.1001, 10);
    expect(c.trades()[0].stop).toBeCloseTo(1.0981, 10);
    await c.step(1);
    expect(c.openRows()).toHaveLength(1);
    await c.step(1); // the minute dipping to 1.097 takes the stop
    expect(c.openRows()).toHaveLength(0);
    expect(c.tally()).toMatchObject({ trades: 1, losses: 1 });
    expect(c.tally().pips).toBeCloseTo(-20, 6);
    expect(c.markers().map((m) => m.text)).toEqual(['Paper buy 1', 'Stop -20.0p']);
    // Back one step: the stop has not happened yet.
    await c.step(-1);
    expect(c.openRows()).toHaveLength(1);
    expect(c.tally().trades).toBe(0);
  });

  it('refuses a size of zero and levels on the wrong side', () => {
    const { c } = setup();
    expect(c.place('buy', 1, null, null)).toMatch(/Start Bar Replay/);
    c.start(3);
    expect(c.place('sell', 0, null, null)).toMatch(/above 0 lots/);
  });

  it('keeps the head on its bar when history is prepended, and moves to the same instant on another series', () => {
    const { c, bars } = setup();
    c.start(5);
    bars.set([hour(-2), hour(-1), ...bars()]);
    c.shift(2);
    expect(c.closedHead()?.time).toBe(T0 + 4 * H);
    c.place('sell', 1, null, null);
    bars.set(Array.from({ length: 40 }, (_, i) => ({ ...hour(0), time: T0 + i * 30 * M })));
    c.reanchor(T0 + 4 * H);
    expect(c.closedHead()?.time).toBe(T0 + 4 * H);
    expect(c.trades()).toHaveLength(0);
  });

  it('says why when intrabar bars cannot be loaded, and steps whole bars', async () => {
    const { c, fetchIntrabar } = setup();
    fetchIntrabar.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    c.start(3);
    await c.step(1);
    expect(c.cursor()).toEqual({ index: 4, sub: null });
    expect(c.intrabarNote()).toMatch(/could not be loaded \(refused\)/);
  });

  it('ends cleanly: exit drops the paper trades', () => {
    const { c } = setup();
    c.start(3);
    c.place('buy', 1, null, null);
    c.exit();
    expect(c.active()).toBe(false);
    expect(c.trades()).toHaveLength(0);
    expect(c.view()).toHaveLength(10);
  });
});
