import { describe, expect, it } from 'vitest';
import { foldBars, lastCompleteBarTime, mergeForming, type FoldBar } from './aggregate';

/**
 * The bar that is still forming.
 *
 * <p>The engine stores a bar only once it has closed, so the newest bar on any timeframe above M1
 * is never in the history. The chart used to invent it from the first live tick after the page
 * loaded: open the chart forty minutes into an H1 bar and the candle opened wherever price was at
 * that moment — visibly jumping away from the previous close, with a high and low covering seconds
 * instead of the hour. It is now folded from M1, which trails the market by at most a minute.</p>
 */

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 8, 21, 12, 0); // 12:00Z, an H1 boundary

const m1 = (minute: number, o: number, h: number, l: number, c: number, v = 10): FoldBar => ({
  time: T0 + minute * MIN,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('foldBars', () => {
  it('builds an H1 bar with the true open, extremes and summed volume', () => {
    const minutes = [
      m1(60, 1.15, 1.1505, 1.1498, 1.1502), // 13:00 — the real open of the 13:00 bar
      m1(61, 1.1502, 1.152, 1.1501, 1.1515), // the high
      m1(95, 1.147, 1.1471, 1.1455, 1.146), // the low, 13:35
      m1(99, 1.146, 1.1466, 1.1459, 1.1462), // the latest close
    ];
    const [bar] = foldBars(minutes, '60');
    expect(bar).toEqual({
      time: T0 + H,
      open: 1.15,
      high: 1.152,
      low: 1.1455,
      close: 1.1462,
      volume: 40,
    });
  });

  it('splits minutes across bucket boundaries', () => {
    const bars = foldBars([m1(10, 1, 1, 1, 1), m1(70, 2, 2, 2, 2)], '60');
    expect(bars.map((b) => b.time)).toEqual([T0, T0 + H]);
  });
});

describe('mergeForming', () => {
  // History ends at the last CLOSED H1 bar, 12:00, closing at 1.1540.
  const history: FoldBar[] = [
    { time: T0 - H, open: 1.151, high: 1.153, low: 1.15, close: 1.152, volume: 500 },
    { time: T0, open: 1.152, high: 1.156, low: 1.1515, close: 1.154, volume: 600 },
  ];

  it('replaces a tick-built forming bar with the real open — the screenshot case', () => {
    // The page loaded at 13:40 and the first tick it saw was 1.1460, so the 13:00 bar opened
    // there: 80 pips away from the 12:00 close, with no history behind it.
    const tickBuilt: FoldBar = {
      time: T0 + H,
      open: 1.146,
      high: 1.1462,
      low: 1.1458,
      close: 1.1461,
      volume: 0,
    };
    const folded = foldBars(
      [m1(60, 1.154, 1.1545, 1.1535, 1.1538), m1(99, 1.1462, 1.1463, 1.1455, 1.1459)],
      '60',
    );

    const merged = mergeForming([...history, tickBuilt], folded, T0);
    const forming = merged[merged.length - 1];

    // Opens where the previous bar closed, as it did in the market.
    expect(forming.open).toBe(1.154);
    expect(forming.high).toBe(1.1545);
    expect(forming.low).toBe(1.1455);
    // Ticks are newer than M1, so the live close is kept.
    expect(forming.close).toBe(1.1461);
  });

  it('never rewrites a stored, closed bar', () => {
    const folded = foldBars([m1(0, 9, 9, 9, 9)], '60'); // M1 disagreeing with a stored bar
    const merged = mergeForming(history, folded, T0);
    expect(merged.find((b) => b.time === T0)).toEqual(history[1]);
  });

  it('keeps a live bar M1 has not reached yet', () => {
    // A bucket that opened seconds ago: no M1 row exists for it, so the tick-built bar stays until
    // the next sync can correct it.
    const justOpened: FoldBar = {
      time: T0 + 2 * H,
      open: 1.15,
      high: 1.15,
      low: 1.15,
      close: 1.15,
      volume: 0,
    };
    const folded = foldBars([m1(60, 1.154, 1.1545, 1.1535, 1.1538)], '60');
    const merged = mergeForming([...history, justOpened], folded, T0);
    expect(merged.map((b) => b.time)).toEqual([T0 - H, T0, T0 + H, T0 + 2 * H]);
  });

  it('fills a closed bar the engine has not written yet, rather than leaving a hole', () => {
    // The 13:00 bar closed at 14:00 but is not stored yet; the page is on the 14:00 bar.
    const folded = foldBars(
      [m1(60, 1.154, 1.155, 1.153, 1.1535), m1(125, 1.1535, 1.154, 1.153, 1.1538)],
      '60',
    );
    const merged = mergeForming(history, folded, T0);
    expect(merged.map((b) => b.time)).toEqual([T0 - H, T0, T0 + H, T0 + 2 * H]);
    expect(merged[2].open).toBe(1.154);
  });
});

describe('lastCompleteBarTime', () => {
  it('trusts the last bar of a stored timeframe — the engine only writes closed bars', () => {
    expect(lastCompleteBarTime([{ time: T0 } as FoldBar], '60')).toBe(T0);
  });

  it('does not trust the last bar of an aggregated timeframe, which is usually still open', () => {
    // 30m is built from M15; a 30m bucket holding one closed M15 bar is half a bar.
    expect(lastCompleteBarTime([{ time: T0 } as FoldBar], '30')).toBe(T0 - 1);
  });

  it('is null with no history', () => {
    expect(lastCompleteBarTime([], '60')).toBeNull();
  });
});
