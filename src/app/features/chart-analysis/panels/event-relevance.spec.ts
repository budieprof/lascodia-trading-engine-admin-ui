import { describe, expect, it } from 'vitest';
import {
  blackoutCurrenciesOf,
  eventRelevance,
  normalizeSymbol,
  sameRelevance,
} from './event-relevance';
import type { InstrumentDto } from '@core/instruments/instrument.types';

/** The page's pairCurrencies before UA01 — pinned: FX must ask for exactly these. */
function legacyPairCurrencies(
  symbol: string,
  base?: string | null,
  quote?: string | null,
): string[] {
  const fromPair = [base, quote].filter((c): c is string => !!c).map((c) => c.toUpperCase());
  if (fromPair.length) return fromPair;
  const s = symbol.toUpperCase();
  return s.length >= 6 ? [s.slice(0, 3), s.slice(3, 6)] : [];
}

const inst = (over: Partial<InstrumentDto> = {}) =>
  ({
    symbol: 'X',
    baseCurrency: null,
    quoteCurrency: null,
    future: null,
    crypto: null,
    ...over,
  }) as InstrumentDto;

describe('event relevance (UA01): which events concern a symbol', () => {
  it('FX is unchanged: the pair row, else the two halves — events and blackout alike', () => {
    for (const [sym, b, q] of [
      ['EURUSD', 'EUR', 'USD'],
      ['USDJPY', 'USD', 'JPY'],
      ['GBPJPY', 'GBP', 'JPY'],
      ['EURUSDm', 'EUR', 'USD'],
      ['AUDNZD', null, null],
    ] as const) {
      const r = eventRelevance({
        symbol: sym,
        assetClass: 'Fx',
        pairBase: b,
        pairQuote: q,
        instrument: inst(),
      });
      const legacy = legacyPairCurrencies(sym, b, q);
      expect(r.kind).toBe('fx');
      expect(r.currencies).toEqual(legacy);
      expect(r.blackoutCurrencies).toEqual(legacy);
      expect(r.marketKeys).toEqual([]);
      expect(r.funding).toBe(false);
    }
  });

  it('metals with a pair row read as a pair (XAUUSD → XAU, USD)', () => {
    const r = eventRelevance({
      symbol: 'XAUUSD',
      assetClass: 'Commodity',
      pairBase: 'XAU',
      pairQuote: 'USD',
    });
    expect(r.currencies).toEqual(['XAU', 'USD']);
    expect(r.blackoutCurrencies).toEqual(['XAU', 'USD']);
  });

  it('equities: the quote currency + earnings; live blocks nothing for a short ticker', () => {
    const r = eventRelevance({
      symbol: 'AAPL',
      assetClass: 'Equity',
      pairBase: 'USD',
      pairQuote: 'USD',
      instrument: inst({ quoteCurrency: 'USD' }),
    });
    expect(r.kind).toBe('equity');
    expect(r.currencies).toEqual(['USD']);
    expect(r.marketKeys).toEqual(['EQ:AAPL']);
    expect(r.blackoutCurrencies).toEqual([]);
    expect(r.summary).toBe('USD releases · AAPL earnings');
  });

  it('indices: their own currency + expiries; blackout as the engine (core three only)', () => {
    const us500 = eventRelevance({
      symbol: 'US500',
      assetClass: 'Index',
      instrument: inst({ quoteCurrency: 'USD' }),
    });
    expect(us500.currencies).toEqual(['USD']);
    expect(us500.marketKeys).toEqual(['IDX:US500']);
    expect(us500.blackoutCurrencies).toEqual(['USD']);
    const ger = eventRelevance({ symbol: 'GER40', assetClass: 'Index' });
    expect(ger.currencies).toEqual(['EUR']);
    expect(ger.marketKeys).toEqual(['IDX:DE40']);
    const uk = eventRelevance({ symbol: 'UK100', assetClass: 'Index' });
    expect(uk.currencies).toEqual(['GBP']);
    expect(uk.blackoutCurrencies).toEqual([]);
  });

  it('crypto: the quote fiat (stablecoin → its fiat), the coin, funding for perpetuals', () => {
    const spot = eventRelevance({
      symbol: 'BTC-USD',
      assetClass: 'Crypto',
      instrument: inst({
        baseCurrency: 'BTC',
        quoteCurrency: 'USD',
        crypto: { kind: 'Spot', settleAsset: null, fundingIntervalHours: null },
      }),
    });
    expect(spot.currencies).toEqual(['USD']);
    expect(spot.marketKeys).toEqual(['CR:BTC']);
    expect(spot.funding).toBe(false);
    const perp = eventRelevance({
      symbol: 'ETH-USDT-PERP',
      assetClass: 'Crypto',
      instrument: inst(),
    });
    expect(perp.currencies).toEqual(['USD']);
    expect(perp.marketKeys).toEqual(['CR:ETH']);
    expect(perp.funding).toBe(true);
    const cross = eventRelevance({ symbol: 'ETH-BTC', assetClass: 'Crypto', instrument: inst() });
    expect(cross.currencies).toEqual([]);
    expect(cross.marketKeys).toEqual(['CR:ETH', 'CR:BTC']);
  });

  it('energy: USD + the commodity key', () => {
    const r = eventRelevance({ symbol: 'USOIL', assetClass: 'Commodity' });
    expect(r.currencies).toEqual(['USD']);
    expect(r.marketKeys).toEqual(['WTI']);
  });

  it('futures: a currency future both currencies; the last trading day marked', () => {
    const r = eventRelevance({
      symbol: '6EZ6',
      assetClass: 'Future',
      instrument: inst({
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        future: {
          root: '6E',
          contractCode: '6EZ6',
          expiry: null,
          lastTradeDate: '2026-12-14T14:16:00Z',
          isFront: true,
          continuousSymbol: null,
        },
      }),
    });
    expect(r.currencies).toEqual(['EUR', 'USD']);
    expect(r.expiryMs).toBe(Date.parse('2026-12-14T14:16:00Z'));
    const es = eventRelevance({
      symbol: 'ESZ6',
      assetClass: 'Future',
      instrument: inst({ quoteCurrency: 'USD' }),
    });
    expect(es.currencies).toEqual(['USD']);
    expect(es.expiryMs).toBeNull();
  });

  it('an unplaced symbol listens to nothing unless its halves are real currencies', () => {
    expect(eventRelevance({ symbol: 'FOOBAR', assetClass: null }).currencies).toEqual([]);
    expect(eventRelevance({ symbol: 'EURUSD', assetClass: null }).currencies).toEqual([
      'EUR',
      'USD',
    ]);
    expect(eventRelevance({ symbol: 'FOOBAR', assetClass: null }).summary).toBe(
      'no scheduled events are linked to this symbol',
    );
  });

  it('blackout currencies mirror NewsBlackoutRules.LegacyCurrenciesOf', () => {
    expect(blackoutCurrenciesOf('EURUSD')).toEqual(['EUR', 'USD']);
    expect(blackoutCurrenciesOf('NAS100')).toEqual(['USD']);
    expect(blackoutCurrenciesOf('US30')).toEqual([]);
    expect(blackoutCurrenciesOf('BTC/USD')).toEqual(['BTC', 'USD']);
    expect(normalizeSymbol('EURUSD.pro')).toBe('EURUSD');
    expect(normalizeSymbol('EURUSDm')).toBe('EURUSD');
  });

  it('sameRelevance compares content', () => {
    const a = eventRelevance({
      symbol: 'AAPL',
      assetClass: 'Equity',
      instrument: inst({ quoteCurrency: 'USD' }),
    });
    const b = eventRelevance({
      symbol: 'AAPL',
      assetClass: 'Equity',
      instrument: inst({ quoteCurrency: 'USD' }),
    });
    expect(sameRelevance(a, b)).toBe(true);
    expect(
      sameRelevance(
        a,
        eventRelevance({
          symbol: 'MSFT',
          assetClass: 'Equity',
          instrument: inst({ quoteCurrency: 'USD' }),
        }),
      ),
    ).toBe(false);
  });
});
