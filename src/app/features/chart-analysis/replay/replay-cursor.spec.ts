import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  barEndMs,
  clampCursor,
  formingBar,
  indexAt,
  intrabarResolution,
  minutesIn,
  replayView,
  revealedUnits,
  stepCursor,
  type IntrabarLookup,
  type ReplayCursor,
} from './replay-cursor';

const H = 3_600_000;
const M = 60_000;
const T0 = Date.parse('2026-09-14T10:00:00Z');

function bar(time: number, o: number, h: number, l: number, c: number, extra: Partial<Bar> = {}): Bar {
  return { time, open: o, high: h, low: l, close: c, volume: 1, ...extra };
}

// Three H1 bars; the second has three "minutes" (shortened for the test), the others none.
const bars = [bar(T0, 1, 2, 0.5, 1.5), bar(T0 + H, 1.5, 3, 1, 2.5), bar(T0 + 2 * H, 2.5, 2.6, 2, 2.2)];
const minutes = [
  bar(T0 + H, 1.5, 1.8, 1.2, 1.6, { spreadPoints: 7 }),
  bar(T0 + H + M, 1.6, 3, 1.5, 2.9, { spreadPoints: 9 }),
  bar(T0 + H + 2 * M, 2.9, 2.95, 1, 2.5, { spreadPoints: 8 }),
];
const lookup: IntrabarLookup = (t) => (t === T0 + H ? minutes : null);

describe('intrabarResolution', () => {
  it('steps 1m bars up to a day, 1h bars above, none on a 1m chart', () => {
    expect(intrabarResolution('1')).toBeNull();
    expect(intrabarResolution('60')).toBe('1');
    expect(intrabarResolution('1D')).toBe('1');
    expect(intrabarResolution('1W')).toBe('60');
  });
});

describe('barEndMs / minutesIn', () => {
  it('ends a bar at its own close, the next bar or its width, whichever is first', () => {
    expect(barEndMs(bars, 0, '60')).toBe(T0 + H);
    expect(barEndMs([bar(T0, 1, 1, 1, 1, { closeTime: T0 + 30 * M })], 0, '60')).toBe(T0 + 30 * M);
  });

  it('takes the intrabar bars of a period', () => {
    expect(minutesIn(minutes, T0 + H, T0 + H + 2 * M).map((m) => m.close)).toEqual([1.6, 2.9]);
    expect(minutesIn(minutes, T0, T0 + H)).toEqual([]);
  });
});

describe('formingBar', () => {
  it('folds the first n intrabar bars and keeps the bar’s open time and the last spread', () => {
    const f = formingBar(bars[1], minutes, 2);
    expect(f).toMatchObject({ time: T0 + H, open: 1.5, high: 3, low: 1.2, close: 2.9, volume: 2, spreadPoints: 9 });
  });
});

describe('stepCursor', () => {
  it('walks a bar through its intrabar bars, then closes it — and back again', () => {
    let c: ReplayCursor = { index: 1, sub: null };
    const seen: ReplayCursor[] = [];
    for (let k = 0; k < 4; k++) seen.push((c = stepCursor(c, 1, bars, lookup, true)));
    expect(seen).toEqual([
      { index: 1, sub: 1 },
      { index: 1, sub: 2 },
      { index: 2, sub: null }, // the last intrabar bar shows the bar itself
      { index: 3, sub: null }, // no intrabar bars known: the whole bar
    ]);
    expect(stepCursor(c, 1, bars, lookup, true)).toEqual(c); // at the end
    expect(stepCursor({ index: 1, sub: 2 }, -1, bars, lookup, true)).toEqual({ index: 1, sub: 1 });
    expect(stepCursor({ index: 1, sub: 1 }, -1, bars, lookup, true)).toEqual({ index: 1, sub: null });
    expect(stepCursor({ index: 1, sub: null }, -1, bars, lookup, true)).toEqual({ index: 1, sub: null });
  });

  it('steps whole bars with intrabar off', () => {
    expect(stepCursor({ index: 1, sub: null }, 1, bars, lookup, false)).toEqual({ index: 2, sub: null });
  });
});

describe('replayView', () => {
  it('shows the closed bars and the bar forming at the head', () => {
    const v = replayView(bars, { index: 1, sub: 2 }, lookup);
    expect(v).toHaveLength(2);
    expect(v[0]).toBe(bars[0]);
    expect(v[1]).toMatchObject({ time: T0 + H, close: 2.9 });
    expect(replayView(bars, { index: 2, sub: null }, lookup)).toEqual(bars.slice(0, 2));
  });

  it('clamps a cursor to the bars held', () => {
    expect(clampCursor({ index: 9, sub: 2 }, 3)).toEqual({ index: 3, sub: null });
    expect(clampCursor({ index: 0, sub: null }, 3)).toEqual({ index: 1, sub: null });
  });
});

describe('revealedUnits', () => {
  it('lists what a forward move revealed, intrabar bars where they were shown', () => {
    expect(revealedUnits(bars, { index: 1, sub: null }, { index: 1, sub: 2 }, lookup).map((u) => u.close)).toEqual([1.6, 2.9]);
    expect(revealedUnits(bars, { index: 1, sub: 2 }, { index: 3, sub: null }, lookup).map((u) => u.close)).toEqual([2.5, 2.2]);
    expect(revealedUnits(bars, { index: 2, sub: null }, { index: 1, sub: null }, lookup)).toEqual([]);
  });
});

describe('indexAt', () => {
  it('puts the bar containing an instant at the head', () => {
    expect(indexAt(bars, T0 + H + 5 * M)).toBe(2);
    expect(indexAt(bars, T0 - H)).toBe(1);
    expect(indexAt(bars, T0 + 9 * H)).toBe(3);
  });
});
