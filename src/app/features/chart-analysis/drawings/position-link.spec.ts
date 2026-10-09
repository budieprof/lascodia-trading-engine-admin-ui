import { describe, expect, it } from 'vitest';
import { positionAccountFacts, positionOrderPrefill, quoteToAccountRate } from './position-link';
import { positionStats } from './tools/forecast-math';
import { styleFor, type Drawing } from './model';

const T = Date.UTC(2026, 9, 5, 8);
const H = 3_600_000;

function position(
  kind: 'long-position' | 'short-position',
  entry: number,
  target: number,
  stop: number,
  options?: Record<string, unknown>,
): Drawing {
  return {
    id: 'p1',
    kind,
    symbol: 'eurusd',
    resolution: '60',
    points: [
      { time: T, price: entry },
      { time: T + 10 * H, price: target },
      { time: T + 10 * H, price: stop },
    ],
    style: styleFor(kind),
    locked: false,
    createdAt: 0,
    ...(options ? { options } : {}),
  };
}

describe('position tool linked to trading (DR-I9)', () => {
  it('turns the quote currency into the account currency', () => {
    expect(quoteToAccountRate('USD', 'EUR', 'USD', 1.1)).toBe(1);
    expect(quoteToAccountRate('USD', 'USD', 'JPY', 150)).toBeCloseTo(1 / 150, 12);
    expect(quoteToAccountRate('USD', 'EUR', 'GBP', 0.85)).toBeNull();
    expect(
      quoteToAccountRate('USD', 'EUR', 'GBP', 0.85, (f, t) =>
        f === 'GBP' && t === 'USD' ? 1.27 : null,
      ),
    ).toBe(1.27);
    expect(quoteToAccountRate(null, 'EUR', 'USD', 1.1)).toBeNull();
  });

  it('places the tool with the account’s equity and the symbol’s contract size, pip and rate', () => {
    const facts = positionAccountFacts({
      account: { equity: 10_250.456, balance: 10_000, currency: 'usd', leverage: 500 },
      pair: { contractSize: 100_000, baseCurrency: 'USD', quoteCurrency: 'JPY' },
      pipSize: 0.01,
      price: 150,
    });
    expect(facts).toEqual({
      lotSize: 100_000,
      pipSize: 0.01,
      accountSize: 10_250.46,
      accountCurrency: 'USD',
      quoteRate: 1 / 150,
      leverage: 500,
    });
  });

  it('without a conversion rate, gives only the symbol’s facts (money in another currency would mis-size)', () => {
    expect(
      positionAccountFacts({
        account: { equity: 5000, balance: 5000, currency: 'USD', leverage: 100 },
        pair: { contractSize: 100_000, baseCurrency: 'EUR', quoteCurrency: 'GBP' },
        pipSize: 0.0001,
        price: 0.85,
      }),
    ).toEqual({ lotSize: 100_000, pipSize: 0.0001 });
    expect(positionAccountFacts({ account: null, pair: null, pipSize: 0, price: 0 })).toBeNull();
  });

  it('sizes in lots from the risk in the account currency', () => {
    // 1% of 10,000 USD = 100 USD at risk; 20 pips on USDJPY at 150 = 0.20 JPY × 100,000 = 20,000 JPY = 133.33 USD a lot.
    const stats = positionStats({
      side: 'long',
      entry: 150,
      target: 150.4,
      stop: 149.8,
      accountSize: 10_000,
      lotSize: 100_000,
      risk: 1,
      riskUnit: '%',
      leverage: 100,
      qtyPrecision: 2,
      quoteRate: 1 / 150,
    });
    expect(stats.qty).toBe(0.75);
    expect(stats.stopAmount).toBeCloseTo(100, 6);
    expect(stats.targetAmount).toBeCloseTo(200, 6);
  });

  it('stages a linked position as the manual-signal dialog’s values', () => {
    const linked = position('long-position', 1.1, 1.104, 1.098, {
      accountSize: 10_000,
      accountCurrency: 'USD',
      lotSize: 100_000,
      pipSize: 0.0001,
      quoteRate: 1,
      risk: 1,
      leverage: 100,
    });
    expect(positionOrderPrefill(linked)).toEqual({
      symbol: 'EURUSD',
      direction: 'Buy',
      entryPrice: 1.1,
      stopLoss: 1.098,
      takeProfit: 1.104,
      lotSize: 0.5,
    });
    const short = position('short-position', 1.1, 1.096, 1.102);
    expect(positionOrderPrefill(short)).toMatchObject({ direction: 'Sell', lotSize: null });
    expect(positionOrderPrefill({ ...linked, kind: 'trend-line' })).toBeNull();
    expect(positionOrderPrefill({ ...linked, pane: 'rsi-1' })).toBeNull();
  });
});
