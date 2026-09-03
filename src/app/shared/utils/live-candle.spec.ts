import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@core/api/api.types';
import { applyTickToCandles, bucketStartMs, preserveFormingBar } from './live-candle';

function candle(timestamp: string, o: number, h: number, l: number, c: number): CandleDto {
  return {
    id: 1,
    symbol: 'EURUSD',
    timeframe: 'M1',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 0,
    timestamp,
    isClosed: true,
  };
}

const ms = (iso: string) => Date.parse(iso);

describe('bucketStartMs', () => {
  it('floors intraday timeframes to their UTC-aligned bucket', () => {
    expect(bucketStartMs('M1', ms('2026-09-03T08:55:41Z'))).toBe(ms('2026-09-03T08:55:00Z'));
    expect(bucketStartMs('M5', ms('2026-09-03T08:57:00Z'))).toBe(ms('2026-09-03T08:55:00Z'));
    expect(bucketStartMs('M15', ms('2026-09-03T08:57:00Z'))).toBe(ms('2026-09-03T08:45:00Z'));
    expect(bucketStartMs('M30', ms('2026-09-03T08:57:00Z'))).toBe(ms('2026-09-03T08:30:00Z'));
    expect(bucketStartMs('H1', ms('2026-09-03T08:57:00Z'))).toBe(ms('2026-09-03T08:00:00Z'));
    expect(bucketStartMs('H4', ms('2026-09-03T09:30:00Z'))).toBe(ms('2026-09-03T08:00:00Z'));
  });

  it('floors D1 to UTC midnight, not local midnight', () => {
    // 00:30Z belongs to the 3rd. A local-time implementation west of UTC would
    // wrongly place this in the 2nd.
    expect(bucketStartMs('D1', ms('2026-09-03T00:30:00Z'))).toBe(ms('2026-09-03T00:00:00Z'));
    expect(bucketStartMs('D1', ms('2026-09-03T23:59:59Z'))).toBe(ms('2026-09-03T00:00:00Z'));
  });

  it('is case-insensitive', () => {
    expect(bucketStartMs('h1', ms('2026-09-03T08:57:00Z'))).toBe(ms('2026-09-03T08:00:00Z'));
  });

  it('returns null where the boundary is a broker convention or unknown', () => {
    // W1 depends on Sunday-vs-Monday week open; guessing is worse than declining.
    expect(bucketStartMs('W1', ms('2026-09-03T08:57:00Z'))).toBeNull();
    expect(bucketStartMs('MN1', ms('2026-09-03T08:57:00Z'))).toBeNull();
    expect(bucketStartMs(null, ms('2026-09-03T08:57:00Z'))).toBeNull();
    expect(bucketStartMs('M1', Number.NaN)).toBeNull();
  });
});

describe('applyTickToCandles', () => {
  // The reported bug: at 08:55 the newest stored bar is the CLOSED 08:54 one.
  it('opens a new forming bar instead of mutating the last closed bar', () => {
    const series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const out = applyTickToCandles(series, 'M1', 1.1615, ms('2026-09-03T08:55:41Z'));

    expect(out).toHaveLength(2);
    // The closed bar must be left exactly as it was.
    expect(out[0]).toEqual(series[0]);

    const forming = out[1];
    expect(forming.timestamp).toBe('2026-09-03T08:55:00.000Z');
    expect(forming.isClosed).toBe(false);
    // Opens at the previous bar's CLOSE, not at the tick — otherwise
    // open=high=low=close and the bar renders as a zero-height line.
    expect(forming.open).toBe(1.16111);
    expect(forming.close).toBe(1.1615);
    expect(forming.high).toBe(1.1615);
    expect(forming.low).toBe(1.16111);
  });

  it('gives the forming bar visible body from its very first tick', () => {
    const series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const out = applyTickToCandles(series, 'M1', 1.1615, ms('2026-09-03T08:55:41Z'));
    const forming = out[1];
    expect(forming.high).toBeGreaterThan(forming.low);
  });

  it('opens downward correctly when the first tick is below the prior close', () => {
    const series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const forming = applyTickToCandles(series, 'M1', 1.1605, ms('2026-09-03T08:55:41Z'))[1];
    expect(forming.open).toBe(1.16111);
    expect(forming.high).toBe(1.16111);
    expect(forming.low).toBe(1.1605);
    expect(forming.close).toBe(1.1605);
  });

  it('extends the forming bar on subsequent ticks in the same bucket', () => {
    const series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const afterFirst = applyTickToCandles(series, 'M1', 1.1615, ms('2026-09-03T08:55:10Z'));
    const afterUp = applyTickToCandles(afterFirst, 'M1', 1.162, ms('2026-09-03T08:55:20Z'));
    const afterDown = applyTickToCandles(afterUp, 'M1', 1.1608, ms('2026-09-03T08:55:30Z'));

    expect(afterDown).toHaveLength(2);
    const forming = afterDown[1];
    // Open stays pinned to the prior bar's close for the whole bucket; only
    // high/low/close move as ticks arrive.
    expect(forming.open).toBe(1.16111);
    expect(forming.high).toBe(1.162);
    expect(forming.low).toBe(1.1608);
    expect(forming.close).toBe(1.1608);
  });

  it('rolls into a fresh bar when the bucket advances', () => {
    let series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    series = applyTickToCandles(series, 'M1', 1.1615, ms('2026-09-03T08:55:10Z'));
    series = applyTickToCandles(series, 'M1', 1.1618, ms('2026-09-03T08:56:05Z'));

    expect(series).toHaveLength(3);
    expect(series[1].timestamp).toBe('2026-09-03T08:55:00.000Z');
    expect(series[2].timestamp).toBe('2026-09-03T08:56:00.000Z');
    // Each new bar opens where the previous one closed, so the series stays
    // visually continuous across the boundary rather than gapping to the tick.
    expect(series[2].open).toBe(series[1].close);
    expect(series[2].close).toBe(1.1618);
  });

  it('patches in place when the server already serves an open bar', () => {
    // Same bucket as `now` — nothing to append.
    const series = [candle('2026-09-03T08:55:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const out = applyTickToCandles(series, 'M1', 1.162, ms('2026-09-03T08:55:41Z'));

    expect(out).toHaveLength(1);
    expect(out[0].high).toBe(1.162);
    expect(out[0].close).toBe(1.162);
  });

  it('returns the same reference when the tick changes nothing', () => {
    const series = [candle('2026-09-03T08:55:00Z', 1.161, 1.1612, 1.1609, 1.1612)];
    const out = applyTickToCandles(series, 'M1', 1.1612, ms('2026-09-03T08:55:41Z'));
    expect(out).toBe(series);
  });

  it('falls back to patching for a timeframe it cannot bucket', () => {
    const series = [candle('2026-08-30T00:00:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    const out = applyTickToCandles(series, 'W1', 1.162, ms('2026-09-03T08:55:41Z'));
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.162);
  });

  it('keeps its accumulated range across a server refresh', () => {
    // The regression that made the active bar look broken: each refresh returns
    // closed bars only, and rebuilding the forming bar from one tick reset its
    // range, flattening it every cycle.
    const closed = candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111);
    let series = applyTickToCandles([closed], 'M1', 1.1615, ms('2026-09-03T08:55:05Z'));
    series = applyTickToCandles(series, 'M1', 1.1622, ms('2026-09-03T08:55:20Z')); // high
    series = applyTickToCandles(series, 'M1', 1.1603, ms('2026-09-03T08:55:35Z')); // low

    const refreshed = preserveFormingBar([closed], series, 'M1', ms('2026-09-03T08:55:40Z'));

    expect(refreshed).toHaveLength(2);
    expect(refreshed[1].high).toBe(1.1622);
    expect(refreshed[1].low).toBe(1.1603);
  });

  it('drops the forming bar once the server serves that bucket for real', () => {
    const closed = candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111);
    const withForming = applyTickToCandles([closed], 'M1', 1.1615, ms('2026-09-03T08:55:05Z'));
    // The 08:55 bar has now closed and arrived from the server.
    const server = [closed, candle('2026-09-03T08:55:00Z', 1.16111, 1.1625, 1.1601, 1.1618)];

    const out = preserveFormingBar(server, withForming, 'M1', ms('2026-09-03T08:55:50Z'));

    expect(out).toHaveLength(2);
    expect(out[1].isClosed).toBe(true); // real data wins over the approximation
    expect(out[1].high).toBe(1.1625);
  });

  it('drops a forming bar whose bucket has elapsed', () => {
    const closed = candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111);
    const withForming = applyTickToCandles([closed], 'M1', 1.1615, ms('2026-09-03T08:55:05Z'));
    // Clock has moved to 08:57 — the stale 08:55 synthetic must not linger.
    const out = preserveFormingBar([closed], withForming, 'M1', ms('2026-09-03T08:57:10Z'));
    expect(out).toHaveLength(1);
  });

  it('leaves a server refresh untouched when there was no forming bar', () => {
    const server = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    expect(preserveFormingBar(server, [], 'M1', ms('2026-09-03T08:55:05Z'))).toBe(server);
    expect(preserveFormingBar(server, server, 'M1', ms('2026-09-03T08:55:05Z'))).toBe(server);
  });

  it('ignores junk ticks and empty history', () => {
    const series = [candle('2026-09-03T08:54:00Z', 1.161, 1.1612, 1.1609, 1.16111)];
    expect(applyTickToCandles(series, 'M1', 0, ms('2026-09-03T08:55:00Z'))).toBe(series);
    expect(applyTickToCandles(series, 'M1', Number.NaN, ms('2026-09-03T08:55:00Z'))).toBe(series);
    expect(applyTickToCandles([], 'M1', 1.16, ms('2026-09-03T08:55:00Z'))).toEqual([]);
  });
});
