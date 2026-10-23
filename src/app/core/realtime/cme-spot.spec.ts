import { describe, expect, it } from 'vitest';

import { BookState } from './md-book';
import {
  cmeSpotLabel,
  futuresSymbolOf,
  mapBookEvent,
  mapFrame,
  mapPrice,
  mapTicks,
  mapTrades,
} from './cme-spot';
import type { MdSource } from './marketdata.types';
import { loadCmeFixture } from './testing/md-fixture';

/** The engine's CmeTier2UnitTests vectors (TEST values, labelled) — both sides must agree. */
describe('CME futures → spot mapping (pinned to the engine)', () => {
  it('direct: subtracts the basis, keeps sides and sizes', () => {
    const e = mapBookEvent({ t: 1, k: 'D', b: [[1.1652, 31]], a: [[1.16525, 4]] }, { inverted: false, basis: 0.0008 });
    expect(e.b[0][0]).toBeCloseTo(1.1644, 10);
    expect(e.b[0][1]).toBe(31);
    expect(e.a[0][0]).toBeCloseTo(1.16445, 10);
  });

  it('inverted (6J): sides swap, prices are reciprocals minus the basis, best first, not crossed', () => {
    const m = { inverted: true, basis: 0.05 };
    const e = mapBookEvent(
      { t: 1, k: 'S', b: [[0.0066495, 10], [0.006649, 7]], a: [[0.00665, 11], [0.0066505, 3]] },
      m,
    );
    expect(e.b[0][0]).toBeCloseTo(1 / 0.00665 - 0.05, 9);
    expect(e.b[0][1]).toBe(11);
    expect(e.b[0][0]).toBeGreaterThan(e.b[1][0]);
    expect(e.a[0][0]).toBeCloseTo(1 / 0.0066495 - 0.05, 9);
    expect(e.a[0][0]).toBeLessThan(e.a[1][0]);
    expect(e.b[0][0]).toBeLessThan(e.a[0][0]);
    const t = mapTicks({ t: [1], b: [0.0066495], a: [0.00665], f: [2], v: [0] }, { inverted: true, basis: 0 });
    expect(t.b[0]).toBeCloseTo(1 / 0.00665, 9);
    expect(t.f![0]).toBe(4);
    expect(mapTrades({ t: [1, 2], p: [0.00665, 0.0066495], s: [2, 5], side: ['B', 'S'] }, m).side).toEqual(['S', 'B']);
  });

  it('an unknown basis maps without it; non-positive prices pass', () => {
    expect(mapPrice(1.1652, { inverted: false, basis: null })).toBe(1.1652);
    expect(mapPrice(0, { inverted: true, basis: 1 })).toBe(0);
    expect(cmeSpotLabel('6E', true, '6EM6')).toBe('CME 6E 6EM6 (futures, basis-adjusted)');
    expect(cmeSpotLabel('6J', false)).toBe('CME 6J (futures, not basis-adjusted)');
  });

  it('finds the futures spec of a symbol on a CME source only', () => {
    const cme = {
      sourceId: 'cme-databento',
      kind: 'CmeFutures',
      symbols: [{ symbol: 'USDJPY', sourceSymbol: '6J', priceTransform: 'Invert', contractSize: 12_500_000, contractCurrency: 'JPY', tickSize: 0.0000005, frontContract: '6JZ6', spotLabel: '' }],
    } as unknown as MdSource;
    expect(futuresSymbolOf(cme, 'usdjpy')?.sourceSymbol).toBe('6J');
    expect(futuresSymbolOf(cme, 'EURUSD')).toBeNull();
    expect(futuresSymbolOf({ ...cme, kind: 'Mt5Broker' } as MdSource, 'USDJPY')).toBeNull();
  });
});

describe('CME mapping on the RECORDED 6E payrolls excerpt', () => {
  const fx = loadCmeFixture();
  // The basis the engine estimated for these minutes from the same data (CmeRecordedSliceTests): +4.65 pips.
  const m = { inverted: false, basis: 0.000465 };

  it('folds the mapped book exactly like the raw one, shifted by the basis', () => {
    const raw = new BookState();
    const spot = new BookState();
    for (const e of fx.book) {
      raw.apply(e);
      spot.apply(mapBookEvent(e, m));
    }
    expect(spot.known).toBe(true);
    expect(spot.bestBid()!).toBeCloseTo(raw.bestBid()! - 0.000465, 10);
    expect(spot.bestAsk()!).toBeCloseTo(raw.bestAsk()! - 0.000465, 10);
    expect(spot.bidLevels().length).toBe(raw.bidLevels().length);
    expect(spot.bestBid()!).toBeLessThan(spot.bestAsk()!);
  });

  it('maps a whole hub frame: trades keep their size and aggressor (direct contract), ticks stay ordered', () => {
    const f = mapFrame(
      { symbol: 'EURUSD', sourceId: fx.sourceId, trades: fx.trades, ticks: fx.ticks, book: fx.book.slice(0, 5) },
      m,
    );
    expect(f.trades!.s).toEqual(fx.trades.s);
    expect(f.trades!.side).toEqual(fx.trades.side);
    expect(f.trades!.p[0]).toBeCloseTo(fx.trades.p[0] - 0.000465, 10);
    expect(f.ticks!.t).toEqual(fx.ticks.t);
    f.ticks!.b.forEach((b, i) => expect(b).toBeLessThanOrEqual(f.ticks!.a[i]));
    // Real tape: buyer- and seller-initiated prints both present, sizes in contracts.
    expect(new Set(fx.trades.side)).toContain('B');
    expect(new Set(fx.trades.side)).toContain('S');
  });
});
