import { describe, expect, it } from 'vitest';

import type { MdSource } from '@core/realtime/marketdata.types';
import {
  cryptoCarries,
  cryptoFlowLabel,
  formatFlowVolume,
  realFlowSource,
  realFlowUnit,
  sourceCarries,
} from './flow-source';

const src = (over: Partial<MdSource>): MdSource => ({
  sourceId: 'x',
  kind: 'Mt5Broker',
  displayName: 'X',
  feedId: 'f',
  feeds: {},
  enabled: true,
  sizeUnit: 'Units',
  contractSize: 0,
  priceTransform: 'None',
  symbolMap: {},
  ...over,
});

const mt5 = src({ sourceId: 'mt5-demo', feeds: { ticks: 'broker-ticks', book: 'broker-dom' } });
const coinbase = src({
  sourceId: 'crypto-coinbase',
  kind: 'CryptoExchange',
  displayName: 'Coinbase Advanced Trade (spot)',
  feeds: { ticks: 'crypto:coinbase', book: 'crypto:coinbase', trades: 'crypto:coinbase' },
  sizeUnit: 'Coins',
  symbolMap: { 'BTC-USD': 'BTC-USD', 'ETH-USD': 'ETH-USD' },
});
const kraken = src({
  sourceId: 'crypto-kraken',
  kind: 'CryptoExchange',
  displayName: 'Kraken',
  feeds: { trades: 'crypto:kraken' },
  symbolMap: { 'BTC-USD': 'spot:BTC/USD', 'BTC-USD-PERP': 'futures:PF_XBTUSD' },
});
const cme = src({
  sourceId: 'cme-6e',
  kind: 'CmeFutures',
  displayName: 'CME',
  feeds: { trades: 'cme-trades', book: 'cme-l2' },
  symbols: [
    {
      symbol: 'EURUSD',
      sourceSymbol: '6E',
      priceTransform: 'None',
      contractSize: 125_000,
      contractCurrency: 'EUR',
      tickSize: 0.00005,
      frontContract: '6EZ6',
      spotLabel: 'CME 6E',
    },
  ],
});
const list = [mt5, coinbase, kraken, cme];

describe('flow-source', () => {
  it('a crypto source carries only the symbols in its map; MT5 with an empty map carries all', () => {
    expect(cryptoCarries(coinbase, 'btc-usd')).toBe(true);
    expect(cryptoCarries(coinbase, 'EURUSD')).toBe(false);
    expect(sourceCarries(mt5, 'EURUSD')).toBe(true);
    expect(sourceCarries(cme, 'EURUSD')).toBe(true);
    expect(sourceCarries(cme, 'GBPUSD')).toBe(false);
    expect(sourceCarries(kraken, 'BTC-USD-PERP')).toBe(true);
  });

  it('FX keeps CME: the picked CME source drives, else CME for markers only', () => {
    expect(realFlowSource(list, 'EURUSD', 'cme-6e')).toMatchObject({ venue: 'cme', picked: true });
    expect(realFlowSource(list, 'EURUSD', null)).toMatchObject({ venue: 'cme', picked: false });
    // A crypto source picked on an FX chart carries nothing: CME, not picked.
    expect(realFlowSource(list, 'EURUSD', 'crypto-coinbase')).toMatchObject({ venue: 'cme', picked: false });
    expect(realFlowSource([mt5], 'EURUSD', null)).toBeNull();
  });

  it('crypto: the picked exchange, else the pinned venue, else the first that streams the symbol', () => {
    expect(realFlowSource(list, 'BTC-USD', 'crypto-kraken')).toMatchObject({
      venue: 'crypto',
      picked: true,
      source: { sourceId: 'crypto-kraken' },
    });
    expect(realFlowSource(list, 'BTC-USD', null, 'crypto-kraken')).toMatchObject({
      picked: false,
      source: { sourceId: 'crypto-kraken' },
    });
    expect(realFlowSource(list, 'BTC-USD', null)).toMatchObject({ source: { sourceId: 'crypto-coinbase' } });
    expect(realFlowSource(list, 'BTC-USD-PERP', 'crypto-coinbase')).toMatchObject({
      picked: false,
      source: { sourceId: 'crypto-kraken' },
    });
    expect(realFlowSource(list, 'SOL-USD', null)).toBeNull();
    expect(realFlowSource(null, 'BTC-USD', null)).toBeNull();
  });

  it('units and labels', () => {
    expect(realFlowUnit({ venue: 'cme' }, 'BTC')).toBe('contracts');
    expect(realFlowUnit({ venue: 'crypto' }, 'btc')).toBe('BTC');
    expect(realFlowUnit({ venue: 'crypto' }, null)).toBe('coins');
    expect(cryptoFlowLabel(coinbase, 'btc-usd')).toBe('Coinbase Advanced Trade BTC-USD (exchange trades)');
  });

  it('formats traded volumes without scientific notation', () => {
    expect(formatFlowVolume(0)).toBe('0');
    expect(formatFlowVolume(12)).toBe('12');
    expect(formatFlowVolume(0.0153)).toBe('0.0153');
    expect(formatFlowVolume(9.019e-5)).toBe('0.0000902');
    expect(formatFlowVolume(1.2549)).toBe('1.25');
    expect(formatFlowVolume(12.44)).toBe('12.4');
    expect(formatFlowVolume(153.2)).toBe('153');
    expect(formatFlowVolume(1250.4)).toBe('1,250');
    expect(formatFlowVolume(-4.5719)).toBe('-4.57');
    expect(formatFlowVolume(2e-8)).toBe('0.00000002');
    expect(formatFlowVolume(Number.NaN)).toBe('—');
  });
});
