import { describe, expect, it } from 'vitest';
import { isVenueTick, tickPrice, tickTimeMs } from './live-tick';

describe('tickPrice / tickTimeMs (UD04, UD05: venue prices on the chart; FX = bid, unchanged)', () => {
  it('MT5 ticks move the chart by the bid, as always', () => {
    expect(tickPrice({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002 })).toBe(1.1);
    expect(tickPrice({ symbol: 'EURUSD', price: 1.2 })).toBe(1.2);
    expect(tickPrice({ symbol: 'EURUSD', ask: 1.3 })).toBe(1.3);
    expect(tickPrice({ symbol: 'US500', bid: 5000.5, ask: 5001, sourceId: 'mt5' })).toBe(5000.5);
    expect(isVenueTick({ bid: 1 })).toBe(false);
  });

  it('venue ticks move it by the last trade, else the mid; a trades-only source has null bid/ask', () => {
    expect(
      tickPrice({
        symbol: 'BTC-USD',
        bid: null,
        ask: null,
        mid: null,
        last: 65000.5,
        sourceId: 'crypto-coinbase',
      }),
    ).toBe(65000.5);
    expect(
      tickPrice({ symbol: 'BTC-USD', bid: 100, ask: 102, mid: 101, sourceId: 'crypto-okx' }),
    ).toBe(101);
    expect(tickPrice({ symbol: 'BTC-USD', bid: 100, ask: 102, sourceId: 'crypto-okx' })).toBe(101);
    expect(
      tickPrice({ symbol: 'BTC-USD', bid: null, ask: null, last: null, sourceId: 'x' }),
    ).toBeNull();
  });

  it('a tick is placed at its own time within a minute behind / two seconds ahead of the engine clock', () => {
    const now = Date.parse('2026-10-06T11:00:00.300Z');
    expect(tickTimeMs({ timeUtc: '2026-10-06T10:59:59.800Z' }, now)).toBe(
      Date.parse('2026-10-06T10:59:59.800Z'),
    );
    expect(tickTimeMs({ timeUtc: '2026-10-06T10:30:00Z' }, now)).toBe(now); // stale broker clock
    expect(tickTimeMs({ timeUtc: '2026-10-06T12:00:00Z' }, now)).toBe(now); // future broker clock
    expect(tickTimeMs({}, now)).toBe(now);
    expect(tickTimeMs({ timeUtc: 'garbage' }, now)).toBe(now);
  });
});
