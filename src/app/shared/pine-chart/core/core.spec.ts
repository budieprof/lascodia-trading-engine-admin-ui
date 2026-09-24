import { describe, expect, it } from 'vitest';
import { buildColorTrack, contrastText, cssColor, parsePineColor, trackColor, withAlpha } from './color';
import { DISPLAY_ALL, DISPLAY_NONE, isDisplayedAnywhere, parseDisplay } from './display';
import {
  formatBarTime,
  formatIsoInZone,
  formatValue,
  formatVolume,
  inferPricePrecision,
  resolveFormat,
  zoneOffsetMinutes,
} from './format';
import { BlockMinMax } from './range-minmax';
import { BarTimeline, timeframeMs, typicalStepMs } from './timeline';

describe('color', () => {
  it('parses #RRGGBBAA, #RRGGBB and short forms', () => {
    expect(parsePineColor('#FF000080')).toEqual({ r: 255, g: 0, b: 0, a: 0.502 });
    expect(parsePineColor('#00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parsePineColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parsePineColor('nope')).toBeNull();
    expect(parsePineColor(null)).toBeNull();
  });

  it('converts to CSS, treating na and fully transparent as invisible', () => {
    expect(cssColor('#2962FFFF')).toBe('rgb(41, 98, 255)');
    expect(cssColor('#2962FF33')).toBe('rgba(41, 98, 255, 0.2)');
    expect(cssColor('#2962FF00')).toBeNull();
    expect(cssColor(null)).toBeNull();
  });

  it('scales alpha and picks readable text colors', () => {
    expect(withAlpha('#FF0000FF', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(withAlpha('rgb(0, 0, 255)', 0.25)).toBe('rgba(0, 0, 255, 0.25)');
    expect(contrastText('#FFFFFFFF')).toBe('#131722');
    expect(contrastText('#000000FF')).toBe('#FFFFFF');
  });

  it('builds palette-indexed tracks with a shift and a keep filter', () => {
    const t = buildColorTrack(null, ['#FF0000FF', null, '#FF0000FF', '#0000FFFF'], 5, 1, (i) => i !== 2);
    expect(t.palette).toEqual(['', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)']);
    expect(trackColor(t, 0)).toBeNull();
    expect(trackColor(t, 1)).toBe('rgb(255, 0, 0)');
    expect(trackColor(t, 3)).toBeNull(); // wire index 2 filtered
    expect(trackColor(t, 4)).toBe('rgb(0, 0, 255)');
    expect(trackColor(t, 99)).toBeNull();
    expect(trackColor(buildColorTrack('#00FF00FF', null, 3), 2)).toBe('rgb(0, 255, 0)');
  });
});

describe('display', () => {
  it('reads all / none / explicit lists and defaults to all', () => {
    expect(parseDisplay(['all'])).toBe(DISPLAY_ALL);
    expect(parseDisplay(undefined)).toBe(DISPLAY_ALL);
    expect(parseDisplay(['none'])).toBe(DISPLAY_NONE);
    expect(parseDisplay(['pane', 'status_line'])).toEqual({ pane: true, dataWindow: false, priceScale: false, statusLine: true });
    expect(isDisplayedAnywhere(parseDisplay(['pine_screener']))).toBe(false);
  });
});

describe('format', () => {
  it('an output format and precision win over the declaration, then the symbol', () => {
    expect(resolveFormat({ format: 'percent' }, { format: 'price', precision: 4 }, 5)).toEqual({ format: 'percent', precision: 4 });
    expect(resolveFormat({}, { format: 'inherit', precision: null }, 5)).toEqual({ format: 'price', precision: 5 });
    expect(resolveFormat({ precision: 1 }, null, 5)).toEqual({ format: 'price', precision: 1 });
    expect(resolveFormat({ format: 'volume' }, null, 5).format).toBe('volume');
  });

  it('formats prices, percents, volumes and na', () => {
    expect(formatValue(1.085234, { format: 'price', precision: 5 })).toBe('1.08523');
    expect(formatValue(-0.0000001, { format: 'price', precision: 2 })).toBe('0.00');
    expect(formatValue(12.346, { format: 'percent', precision: 2 })).toBe('12.35%');
    expect(formatValue(null, { format: 'price', precision: 2 })).toBe('∅');
    expect(formatValue(NaN, { format: 'price', precision: 2 })).toBe('∅');
    expect(formatVolume(812)).toBe('812');
    expect(formatVolume(1234)).toBe('1.23K');
    expect(formatVolume(45_670_000)).toBe('45.67M');
  });

  it('infers price decimals ignoring float noise', () => {
    expect(inferPricePrecision([1.08523, 1.0851])).toBe(5);
    expect(inferPricePrecision([2345.1, 2350])).toBe(1);
    expect(inferPricePrecision([1.1 + 2.2])).toBe(1);
  });

  it('formats bar times and Pine Logs ISO stamps in a zone', () => {
    const t = Date.UTC(2026, 6, 1, 13, 30);
    expect(formatBarTime(t)).toBe('2026-07-01 13:30');
    expect(formatIsoInZone(t)).toBe('2026-07-01T13:30:00.000+00:00');
    expect(zoneOffsetMinutes(t, 'Europe/London')).toBe(60);
    expect(formatIsoInZone(t, 'America/New_York')).toBe('2026-07-01T09:30:00.000-04:00');
  });
});

describe('BlockMinMax', () => {
  it('matches a brute-force scan on random ranges, ignoring na', () => {
    const n = 1000;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const lows = Float64Array.from({ length: n }, () => (rand() < 0.1 ? NaN : rand() * 100));
    const highs = Float64Array.from(lows, (v) => v + 5);
    const mm = new BlockMinMax(lows, highs, 16);
    for (let k = 0; k < 200; k++) {
      const a = Math.floor(rand() * n);
      const b = a + Math.floor(rand() * 300);
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = a; i <= Math.min(b, n - 1); i++) {
        if (lows[i] === lows[i]) {
          mn = Math.min(mn, lows[i]);
          mx = Math.max(mx, highs[i]);
        }
      }
      const r = mm.range(a, b);
      if (mn === Infinity) expect(r).toBeNull();
      else expect(r).toEqual({ min: mn, max: mx });
    }
    expect(mm.range(-50, -1)).toBeNull();
  });
});

describe('BarTimeline', () => {
  const H = 3_600_000;
  // Friday 20:00..23:00, then Monday 00:00.. (a weekend gap).
  const times = [0, 1, 2, 3].map((i) => Date.UTC(2026, 5, 5, 20 + i)).concat([0, 1].map((i) => Date.UTC(2026, 5, 8, i)));
  const tl = new BarTimeline(times, 1000, H);

  it('converts between bar_index and logical index', () => {
    expect(tl.logicalOfBarIndex(1003)).toBe(3);
    expect(tl.barIndexOfLogical(3)).toBe(1003);
    expect(tl.lastBarIndex).toBe(1005);
  });

  it('maps times inside, between and beyond the bars', () => {
    expect(tl.logicalOfTime(times[2])).toBe(2);
    expect(tl.logicalOfTime(times[2] + H / 4)).toBeCloseTo(2.25);
    // Across the weekend gap: fraction of the gap, not of an hour.
    expect(tl.logicalOfTime(times[3] + (times[4] - times[3]) / 2)).toBeCloseTo(3.5);
    expect(tl.logicalOfTime(times[5] + 3 * H)).toBe(8);
    expect(tl.logicalOfTime(times[0] - 2 * H)).toBe(-2);
    expect(tl.indexOfTime(times[4])).toBe(4);
    expect(tl.indexOfTime(times[4] + 1)).toBe(-1);
  });

  it('extrapolates times past both ends by the step', () => {
    expect(tl.timeOfLogical(7)).toBe(times[5] + 2 * H);
    expect(tl.timeOfLogical(-1)).toBe(times[0] - H);
    expect(tl.timeOfLogical(1.5)).toBe(times[1] + H / 2);
  });

  it('reads Pine and engine timeframes and infers a step from bar times', () => {
    expect(timeframeMs('60')).toBe(H);
    expect(timeframeMs('1D')).toBe(24 * H);
    expect(timeframeMs('D')).toBe(24 * H);
    expect(timeframeMs('15S')).toBe(15_000);
    expect(timeframeMs('1W')).toBe(7 * 24 * H);
    expect(timeframeMs('M15')).toBe(15 * 60_000);
    expect(timeframeMs('H4')).toBe(4 * H);
    expect(timeframeMs('D1')).toBe(24 * H);
    expect(timeframeMs('bogus')).toBeNull();
    expect(typicalStepMs(times)).toBe(H);
  });
});
