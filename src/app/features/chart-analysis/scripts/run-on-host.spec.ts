import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RIGHT_OFFSET,
  MAX_SCRIPT_RIGHT_OFFSET,
  barColorsOnHost,
  futureBarsOnHost,
  marginCap,
  marginMovesView,
  mergeBarColors,
  restoredRightOffset,
  runOffsetOnHost,
  sameBarColors,
  savedRightOffset,
  scriptRightOffset,
  withBarColor,
} from './run-on-host';

/** Host bar times (seconds), hourly from `from`. */
const hours = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * 3600);

describe('runOffsetOnHost', () => {
  const host = hours(1_000_000, 10);

  it("is the host index of the run's bar 0, found from its last bar's time", () => {
    // A 4-bar run ending on host bar 9: run bar 0 = host bar 6.
    expect(runOffsetOnHost(host, host[9], 3)).toBe(6);
    // A run longer than the host's window starts before it.
    expect(runOffsetOnHost(host, host[9], 14)).toBe(-5);
    // The host opened a bar since the run: its last bar is the host's second-to-last.
    expect(runOffsetOnHost(host, host[8], 3)).toBe(5);
  });

  it("is null when the run's last bar is not on the host axis", () => {
    expect(runOffsetOnHost(host, host[9] + 3600, 3)).toBeNull();
    expect(runOffsetOnHost(host, host[4] + 60, 3)).toBeNull();
    expect(runOffsetOnHost([], 5, 0)).toBeNull();
  });
});

describe('barColorsOnHost', () => {
  it("puts each run bar's colour on the host bar at the offset", () => {
    expect(barColorsOnHost(['#a', null, '#c'], 2, 6)).toEqual([null, null, '#a', null, '#c', null]);
  });

  it("drops run bars off the host's window on either side", () => {
    // Run bars 0..1 fall before the host's first bar; run bar 4 after its last.
    expect(barColorsOnHost(['#x', '#y', '#a', '#b', '#z'], -2, 2)).toEqual(['#a', '#b']);
  });

  it('is null when nothing lands: no offset, no colour, or no overlap', () => {
    expect(barColorsOnHost(['#a'], null, 3)).toBeNull();
    expect(barColorsOnHost([null, null], 0, 3)).toBeNull();
    expect(barColorsOnHost(['#a'], 5, 3)).toBeNull();
  });
});

describe('mergeBarColors', () => {
  it('lets a later-added script win on every bar it colours, and only there', () => {
    const first = ['#1', '#1', null, '#1'];
    const second = [null, '#2', '#2', null];
    expect(mergeBarColors([first, second])).toEqual(['#1', '#2', '#2', '#1']);
    expect(mergeBarColors([second, first])).toEqual(['#1', '#1', '#2', '#1']);
  });

  it('skips scripts that colour nothing and does not alias a layer', () => {
    const only = ['#1', null];
    const merged = mergeBarColors([null, only, null]);
    expect(merged).toEqual(['#1', null]);
    expect(merged).not.toBe(only);
    expect(mergeBarColors([null, null])).toBeNull();
    expect(mergeBarColors([])).toBeNull();
  });
});

describe('sameBarColors', () => {
  it('compares entry by entry', () => {
    expect(sameBarColors(null, null)).toBe(true);
    expect(sameBarColors(['#a', null], ['#a', null])).toBe(true);
    expect(sameBarColors(['#a', null], ['#a', '#b'])).toBe(false);
    expect(sameBarColors(['#a'], ['#a', null])).toBe(false);
    expect(sameBarColors(null, [null])).toBe(false);
  });
});

describe('withBarColor', () => {
  const row = { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 };

  it('paints a candle body, border and wick', () => {
    expect(withBarColor(row, '#f00', 'candle')).toEqual({
      ...row,
      color: '#f00',
      borderColor: '#f00',
      wickColor: '#f00',
    });
  });

  it('keeps a hollow candle hollow: border and wick only', () => {
    const r = withBarColor(row, '#f00', 'hollow');
    expect(r).toEqual({ ...row, borderColor: '#f00', wickColor: '#f00' });
    expect('color' in r).toBe(false);
  });

  it("gives a bar its one colour, and leaves an uncoloured bar to the style's up/down", () => {
    expect(withBarColor(row, '#f00', 'bar')).toEqual({ ...row, color: '#f00' });
    expect(withBarColor(row, null, 'candle')).toBe(row);
    expect(withBarColor(row, undefined, 'bar')).toBe(row);
  });
});

describe('futureBarsOnHost', () => {
  it('counts future slots from where the run ends on the host', () => {
    // A 50-bar run aligned with a 50-bar host, labels 16 bars out.
    expect(futureBarsOnHost(0, 49, 16, 50)).toBe(16);
    // The host has opened a bar since the run: one bar less to show.
    expect(futureBarsOnHost(0, 49, 16, 51)).toBe(15);
  });

  it('is 0 with nothing in the future or no alignment', () => {
    expect(futureBarsOnHost(0, 49, 0, 50)).toBe(0);
    expect(futureBarsOnHost(null, 49, 16, 50)).toBe(0);
    expect(futureBarsOnHost(0, 49, 1, 60)).toBe(0);
  });
});

describe('scriptRightOffset', () => {
  it('fits the furthest drawing plus two bars, between the default and the cap', () => {
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, 16)).toBe(18);
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, 1)).toBe(DEFAULT_RIGHT_OFFSET);
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, 400)).toBe(MAX_SCRIPT_RIGHT_OFFSET);
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, 30, 20)).toBe(20);
  });

  it('returns to the default once nothing reaches the future', () => {
    expect(scriptRightOffset(18, 0)).toBe(DEFAULT_RIGHT_OFFSET);
  });

  it('grows at once but keeps a little slack before shrinking', () => {
    expect(scriptRightOffset(18, 17)).toBe(19);
    // A bar opening before the re-run brings the drawing one bar closer: no step back.
    expect(scriptRightOffset(18, 15)).toBe(18);
    expect(scriptRightOffset(18, 14)).toBe(18);
    expect(scriptRightOffset(18, 13)).toBe(15);
  });
});

describe('marginCap', () => {
  it('is the cap, or half the bars on screen when that is less', () => {
    expect(marginCap(1200, 6)).toBe(MAX_SCRIPT_RIGHT_OFFSET);
    expect(marginCap(300, 6)).toBe(25);
    expect(marginCap(40, 6)).toBe(DEFAULT_RIGHT_OFFSET);
    expect(marginCap(0, 6)).toBe(MAX_SCRIPT_RIGHT_OFFSET);
  });
});

describe('marginMovesView', () => {
  it('grows the view only at the live edge, and only when it shows less', () => {
    expect(marginMovesView(5, 18, 5)).toBe(true);
    expect(marginMovesView(5, 18, 0)).toBe(true);
    // Scrolled into history: the operator's view.
    expect(marginMovesView(5, 18, -40)).toBe(false);
    // Already showing more room than needed.
    expect(marginMovesView(5, 18, 25)).toBe(false);
  });

  it('shrinks the view only while it sits where the margin put it', () => {
    expect(marginMovesView(18, 5, 18)).toBe(true);
    expect(marginMovesView(18, 5, 11)).toBe(false);
    expect(marginMovesView(18, 5, -40)).toBe(false);
  });
});

describe('saved / restored right offset', () => {
  it("saves the margin's live edge as the default one, any other position as is", () => {
    expect(savedRightOffset(18, 18)).toBe(DEFAULT_RIGHT_OFFSET);
    expect(savedRightOffset(18.2, 18)).toBe(DEFAULT_RIGHT_OFFSET);
    expect(savedRightOffset(-120, 18)).toBe(-120);
    expect(savedRightOffset(25, 18)).toBe(25);
    expect(savedRightOffset(5, DEFAULT_RIGHT_OFFSET)).toBe(5);
  });

  it("reopens a saved live edge at the chart's current one", () => {
    expect(restoredRightOffset(DEFAULT_RIGHT_OFFSET, 18)).toBe(18);
    expect(restoredRightOffset(DEFAULT_RIGHT_OFFSET, DEFAULT_RIGHT_OFFSET)).toBe(5);
    expect(restoredRightOffset(-120, 18)).toBe(-120);
  });
});
