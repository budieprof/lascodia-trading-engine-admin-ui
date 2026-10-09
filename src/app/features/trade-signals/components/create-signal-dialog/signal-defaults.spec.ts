import { describe, expect, it } from 'vitest';

import type { CandleDto } from '@core/api/api.types';
import { atrFromCandles, atrLevels, atrTimeframe, orderStrategies, pipSizeFor, roundTo } from './signal-defaults';

const candle = (i: number, range: number, isClosed = true): CandleDto => ({
  id: i,
  symbol: 'EURUSD',
  timeframe: 'H1',
  open: 1.1,
  high: 1.1 + range / 2,
  low: 1.1 - range / 2,
  close: 1.1,
  volume: 100,
  timestamp: new Date(Date.UTC(2026, 9, 8, 0) + i * 3_600_000).toISOString(),
  isClosed,
});

describe('create-signal defaults (SP-13)', () => {
  it('ATR from closed candles in any order, null with too few', () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(29 - i, 0.002)); // newest first, as the API sends
    expect(atrFromCandles(candles)).toBeCloseTo(0.002, 10);
    expect(atrFromCandles(candles.slice(0, 14))).toBeNull();
    // A forming candle is not used.
    const withForming = [candle(30, 0.05, false), ...candles];
    expect(atrFromCandles(withForming)).toBeCloseTo(0.002, 10);
  });

  it('stop 1.5 ATR beyond the entry, target 2R on the other side, rounded to the digits', () => {
    expect(atrLevels(1.1, 'Buy', 0.002, 5)).toEqual({ stopLoss: 1.097, takeProfit: 1.106, stopDistance: 0.003 });
    const sell = atrLevels(150.123, 'Sell', 0.4, 3);
    expect(sell.stopLoss).toBe(150.723);
    expect(sell.takeProfit).toBe(148.923);
    expect(roundTo(1.234567, 5)).toBe(1.23457);
    expect(pipSizeFor(5)).toBeCloseTo(0.0001);
    expect(pipSizeFor(3)).toBeCloseTo(0.01);
    expect(pipSizeFor(2)).toBeCloseTo(0.01);
  });

  it('lists the symbol’s strategies first and never picks one', () => {
    const list = [
      { id: 3, symbol: 'GBPUSD' },
      { id: 7, symbol: 'EURUSD' },
      { id: 1, symbol: 'USDJPY' },
      { id: 5, symbol: 'eurusd' },
    ];
    expect(orderStrategies(list, 'EURUSD').map((s) => s.id)).toEqual([5, 7, 1, 3]);
    expect(orderStrategies(list, '').map((s) => s.id)).toEqual([1, 3, 5, 7]);
    expect(atrTimeframe({ timeframe: 'H4' })).toBe('H4');
    expect(atrTimeframe(null)).toBe('H1');
  });
});
