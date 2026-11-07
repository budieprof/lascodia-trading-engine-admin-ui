import { describe, expect, it } from 'vitest';
import { normaliseInstrument } from '@core/instruments/instrument-math';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { instrumentDescription, instrumentKindLabel, symbolChips } from './symbol-chips';

const NOW = Date.parse('2026-12-15T12:00:00Z');
const inst = (p: Partial<InstrumentDto>) => normaliseInstrument(p as InstrumentDto)!;

describe('symbolChips (UD07: where the bars come from, what they are)', () => {
  it('MT5 FX: Forex · MT5 broker · tick volume', () => {
    const chips = symbolChips(
      {
        assetClass: 'Fx',
        calendarCode: 'fx-24x5',
        volumeKind: 'tick',
        source: { id: 'mt5', kind: 'mt5', label: 'MT5 broker feed' },
        adjustment: 'none',
      },
      inst({ symbol: 'EURUSD', assetClass: 'Fx' }),
      NOW,
    );
    expect(chips.map((c) => c.text)).toEqual(['Forex', 'MT5 broker', 'tick volume']);
  });

  it('a crypto perpetual from a venue: kind, venue, exchange, PERP, base volume', () => {
    const btc = inst({
      symbol: 'BTC-USDT-PERP',
      assetClass: 'Crypto',
      exchange: 'OKX',
      baseCurrency: 'BTC',
      crypto: { kind: 'Perpetual', settleAsset: 'USDT', fundingIntervalHours: 8 },
    });
    const chips = symbolChips(
      {
        assetClass: 'Crypto',
        calendarCode: 'crypto-24x7',
        volumeKind: 'base',
        source: { id: 'crypto-okx', kind: 'venue', label: 'OKX' },
        adjustment: 'none',
      },
      btc,
      NOW,
    );
    expect(chips.map((c) => c.text)).toEqual([
      'Crypto perpetual',
      'OKX',
      'OKX',
      'PERP',
      'volume (BTC)',
    ]);
  });

  it('a futures contract: expiry, front month; an expiring one is flagged', () => {
    const es = inst({
      symbol: 'ESZ6',
      assetClass: 'Future',
      exchange: 'CME',
      future: {
        root: 'ES',
        contractCode: 'ESZ6',
        expiry: '2026-12-18',
        lastTradeDate: '2026-12-18',
        isFront: true,
        continuousSymbol: 'ES1!',
      },
    });
    const c = symbolChips(null, es, NOW).find((x) => x.id === 'contract')!;
    expect(c.text).toBe('ESZ6 · exp 2026-12-18 · front');
    expect(c.warn).toBe(true); // 3 days to the last trade
  });

  it('before any chart answer: the pinned candle source, else says it is unknown', () => {
    const pinned = symbolChips(
      null,
      inst({
        symbol: 'ETH-USD',
        assetClass: 'Crypto',
        candleSource: { id: 'crypto-kraken', kind: 'venue', label: 'Kraken' },
      }),
      NOW,
    );
    expect(pinned.find((c) => c.id === 'source')?.text).toBe('Kraken');
    expect(symbolChips(null, null, NOW).find((c) => c.id === 'source')?.text).toBe(
      'Source unknown',
    );
  });

  it('kinds and descriptions for the details panels (browser check b1-2)', () => {
    expect(instrumentKindLabel(inst({ symbol: 'AAPL', assetClass: 'Equity' }))).toBe('Equity CFD');
    expect(instrumentKindLabel(inst({ symbol: 'US500', assetClass: 'Index' }))).toBe('Index CFD');
    expect(
      instrumentKindLabel(
        inst({
          symbol: 'BTC-USD',
          assetClass: 'Crypto',
          crypto: { kind: 'Spot', settleAsset: null, fundingIntervalHours: null },
        }),
      ),
    ).toBe('Crypto spot');
    expect(instrumentDescription(inst({ symbol: 'AAPL', description: 'USD/USD' }))).toBeNull();
    expect(instrumentDescription(inst({ symbol: 'AAPL', description: 'Apple Inc.' }))).toBe(
      'Apple Inc.',
    );
  });
});
