import { describe, expect, it } from 'vitest';

import { FONT_DEFAULT } from '@shared/pine-chart/render/build-render-model';
import {
  DEFAULT_RIGHT_OFFSET,
  MAX_SCRIPT_RIGHT_OFFSET,
  barColorsOnHost,
  estimateTextWidth,
  futureBarsOnHost,
  labelRightPx,
  marginCap,
  marginMovesView,
  mergeBarColors,
  placeRun,
  restoredRightOffset,
  runOffsetOnHost,
  sameBarColors,
  savedRightOffset,
  scriptRightOffset,
  withBarColor,
  type LabelBox,
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

  it("paints a candle's body only: border and wick keep the style's up/down colours (TradingView barcolor)", () => {
    const r = withBarColor(row, '#f00', 'candle');
    expect(r).toEqual({ ...row, color: '#f00' });
    expect('borderColor' in r).toBe(false);
    expect('wickColor' in r).toBe(false);
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

  it("adds labels' text at the chart's zoom: 150 px of bubble is 25 bars at 6 px a bar", () => {
    const labels = [{ x: 52, px: 150 }]; // anchored 3 bars past a 50-bar run's last bar
    expect(futureBarsOnHost(0, 49, 3, 50, labels, 6)).toBeCloseTo(28);
    // Zoomed in to 12 px a bar, the same text takes half the bars.
    expect(futureBarsOnHost(0, 49, 3, 50, labels, 12)).toBeCloseTo(15.5);
    // No spacing given: anchors only.
    expect(futureBarsOnHost(0, 49, 3, 50, labels)).toBe(3);
  });

  it('counts a label near the last bar whose text runs past it, not one far back', () => {
    // label_left on the last bar, nothing anchored in the future: 60 px of bubble = 10 bars.
    expect(futureBarsOnHost(0, 49, 0, 50, [{ x: 49, px: 60 }], 6)).toBeCloseTo(10);
    expect(futureBarsOnHost(0, 49, 0, 50, [{ x: 20, px: 60 }], 6)).toBe(0);
    // The host opened a bar since the run: one bar less.
    expect(futureBarsOnHost(0, 49, 0, 51, [{ x: 49, px: 60 }], 6)).toBeCloseTo(9);
    expect(futureBarsOnHost(null, 49, 0, 50, [{ x: 49, px: 60 }], 6)).toBe(0);
  });
});

describe('estimateTextWidth', () => {
  /** canvas measureText() widths in the chart's font stack (Chromium on macOS), px. */
  const MEASURED: [text: string, size: number, bold: boolean, width: number][] = [
    ['Short 1.12388  now +1.7R', 10, false, 121.4],
    ['Stop 1.12671  -1R', 10, false, 82.7],
    ['✓ 1R 1.12105', 10, false, 61.7],
    ['Reverse -0.8R', 10, false, 68.1],
    ['BUY', 12, false, 24.6],
    ['1234567890', 12, false, 72.6],
    ['Bullish Engulfing', 12, false, 93.8],
    ['Short 1.12388  now +1.7R', 12, true, 151.9],
  ];

  it('errs wide of the measured width of label text, but not by much', () => {
    for (const [text, size, bold, width] of MEASURED) {
      const estimate = estimateTextWidth(text, size, { bold });
      expect(estimate, text).toBeGreaterThanOrEqual(width);
      expect(estimate, text).toBeLessThanOrEqual(width * 1.25);
    }
  });

  it('counts characters, not UTF-16 units, and every monospace character alike', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
    expect(estimateTextWidth('😀', 10)).toBeCloseTo(estimateTextWidth('✓', 10));
    expect(estimateTextWidth('iii', 10, { monospace: true })).toBeCloseTo(
      estimateTextWidth('WWW', 10, { monospace: true }),
    );
    expect(estimateTextWidth('abc', 12, { bold: true })).toBeGreaterThan(
      estimateTextWidth('abc', 12),
    );
  });
});

describe('labelRightPx', () => {
  const TEXT = 'Short 1.12388  now +1.7R';
  /** A size.small (10 px) price label, as the v2 script draws its trade levels. */
  const label = (style: string, text = TEXT): LabelBox => ({
    style: style as LabelBox['style'],
    text,
    fontSize: 10,
    fontFamily: FONT_DEFAULT,
    bold: false,
    yloc: 'price',
  });
  const textW = estimateTextWidth(TEXT, 10);

  it('reaches the whole bubble right of the anchor for label_left', () => {
    // A 5 px pointer, then 5 px of padding either side of the text.
    expect(labelRightPx(label('label_left'))).toBeCloseTo(5 + 5 + textW + 5);
    expect(labelRightPx(label('label_upper_left'))).toBeGreaterThan(textW);
  });

  it('reaches half a centred bubble, and nothing past the anchor for label_right', () => {
    for (const style of ['label_center', 'label_down', 'label_up', 'none'])
      expect(labelRightPx(label(style)), style).toBeCloseTo((textW + 10) / 2, 0);
    expect(labelRightPx(label('label_right'))).toBe(0);
    expect(labelRightPx(label('label_lower_right'))).toBe(0);
  });

  it('measures the widest line, bold wider, and the shape of a shape style', () => {
    expect(labelRightPx(label('label_left', `a\n${TEXT}`))).toBeCloseTo(
      labelRightPx(label('label_left')),
    );
    expect(labelRightPx({ ...label('label_left'), bold: true })).toBeGreaterThan(
      labelRightPx(label('label_left')),
    );
    // An xcross with no text: half the 13 px shape (size = round(10 × 1.3)).
    expect(labelRightPx(label('xcross', ''))).toBeCloseTo(6.5);
  });

  it("fits the v2 script's level labels: anchored 3 bars out at 6 px a bar", () => {
    const reach = (anchor: number) =>
      futureBarsOnHost(
        0,
        49,
        anchor,
        50,
        [{ x: 49 + anchor, px: labelRightPx(label('label_left')) }],
        6,
      );
    // The margin stayed at the default 5 bars with only the anchor counted; the text needs ~25 more.
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, reach(3))).toBe(30);
    // Anchored 14 bars out it would need 41: the cap holds.
    expect(scriptRightOffset(DEFAULT_RIGHT_OFFSET, reach(14), marginCap(1744, 6))).toBe(
      MAX_SCRIPT_RIGHT_OFFSET,
    );
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

describe('placeRun', () => {
  const run = (key: string, kind: 'indicator' | 'strategy' = 'indicator', tag = '') => ({
    item: { key },
    result: { kind },
    tag,
  });

  it('a re-run keeps its place; a new script goes last', () => {
    const a = run('a');
    const b = run('b');
    expect(placeRun([a, b], run('a', 'indicator', 'v2')).runs.map((r) => r.item.key + r.tag)).toEqual([
      'av2',
      'b',
    ]);
    expect(placeRun([a, b], run('c')).runs.map((r) => r.item.key)).toEqual(['a', 'b', 'c']);
  });

  it('one strategy at a time: another strategy comes back as replaced', () => {
    const s1 = run('s1', 'strategy');
    const placed = placeRun([s1, run('a')], run('s2', 'strategy'));
    expect(placed.runs.map((r) => r.item.key)).toEqual(['a', 's2']);
    expect(placed.replaced).toEqual([s1]);
    expect(placed.swapped).toBeNull();
  });

  it('PC-06: an edit takes the place of the script it was edited from, offering nothing back', () => {
    const s1 = run('strategy:9', 'strategy');
    const placed = placeRun([run('a'), s1, run('b')], run('editor:x', 'strategy'), 'strategy:9');
    expect(placed.runs.map((r) => r.item.key)).toEqual(['a', 'editor:x', 'b']);
    expect(placed.swapped).toBe(s1);
    expect(placed.replaced).toEqual([]);
  });

  it('an edit under its own key is a re-run in place; a missing target places it as new', () => {
    const e = run('editor:x');
    expect(placeRun([e, run('b')], run('editor:x', 'indicator', 'v2'), 'editor:x')).toMatchObject({
      swapped: null,
    });
    expect(placeRun([run('b')], run('editor:y'), 'gone').runs.map((r) => r.item.key)).toEqual([
      'b',
      'editor:y',
    ]);
  });
});
