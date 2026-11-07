import { describe, expect, it } from 'vitest';
import { ChartAnnouncer, PRICE_EVERY_MS } from './chart-announcer';

describe('US05 chart announcer (polite live region)', () => {
  const at = (price: string | null, market: string | null = 'Market open', symbol = 'EURUSD') => ({
    symbol,
    interval: '1 hour',
    market,
    price,
  });

  it('says the symbol, its state and price on a switch; then the price at most every 30 s, only when it moved', () => {
    const a = new ChartAnnouncer();
    expect(a.next(at('1.08452'), 0)).toBe('EURUSD, 1 hour. Market open. Last 1.08452.');
    expect(a.next(at('1.08455'), 1_000)).toBeNull();
    expect(a.next(at('1.08460'), PRICE_EVERY_MS)).toBe('EURUSD 1.08460.');
    expect(a.next(at('1.08460'), 3 * PRICE_EVERY_MS)).toBeNull();
  });

  it('a market state change is said at once', () => {
    const a = new ChartAnnouncer();
    a.next(at('1.1'), 0);
    expect(a.next(at('1.1', 'Market closed'), 10)).toBe('EURUSD: Market closed.');
  });

  it('a new symbol starts over', () => {
    const a = new ChartAnnouncer();
    a.next(at('1.1'), 0);
    expect(a.next(at(null, null, 'BTC-USD'), 5)).toBe('BTC-USD, 1 hour.');
  });
});
