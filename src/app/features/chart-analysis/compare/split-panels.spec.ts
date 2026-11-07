import { describe, expect, it } from 'vitest';
import type { CurrencyPairDto } from '@core/api/api.types';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import {
  panelCandidates,
  panelLoadError,
  panelLook,
  panelSymbolGroups,
  restoredPanelView,
  withView,
} from './split-panels';

const pair = (symbol: string) => ({ id: symbol.length, symbol }) as unknown as CurrencyPairDto;
const inst = (symbol: string, assetClass: InstrumentDto['assetClass'], extra: Partial<InstrumentDto> = {}) =>
  ({ symbol, assetClass, status: 'Active', hasCandles: true, ...extra }) as InstrumentDto;

describe('US03 split panels', () => {
  it('candidates: the broker symbols first in their order (as before), then the catalogue, never one taken', () => {
    const pairs = [pair('EURUSD'), pair('GBPUSD'), pair('USDJPY')];
    const catalogue = [
      inst('EURUSD', 'Fx'),
      inst('ETH-USD', 'Crypto', { candleSource: { id: 'crypto-coinbase', kind: 'venue', label: 'Coinbase' } }),
      inst('BTC-USD', 'Crypto'),
      inst('SOL-USD', 'Crypto', { hasCandles: false }),
      inst('OLD', 'Equity', { status: 'Inactive' }),
    ];
    expect(panelCandidates(pairs, catalogue, ['eurusd'])).toEqual(['GBPUSD', 'USDJPY', 'BTC-USD', 'ETH-USD']);
    // FX only: exactly the old list.
    expect(panelCandidates(pairs, [], ['GBPUSD'])).toEqual(['EURUSD', 'USDJPY']);
  });

  it('symbol groups: broker, then asset classes; the source in the label; the panel\'s own symbol always present', () => {
    const groups = panelSymbolGroups(
      [pair('EURUSD')],
      [inst('BTC-USD', 'Crypto', { candleSource: { id: 'crypto-coinbase', kind: 'venue', label: 'Coinbase' } }), inst('AAPL', 'Equity')],
      'ES1!',
    );
    expect(groups.map((g) => g.label)).toEqual(['This chart', 'MT5 broker', 'Crypto', 'Equities']);
    expect(groups[2].options[0]).toEqual({ symbol: 'BTC-USD', label: 'BTC-USD · Coinbase' });
  });

  it('look: the main chart\'s style and scale until the panel has its own; volume off by default', () => {
    const main = { style: 'candles' as const, scaleMode: 'normal' as const };
    expect(panelLook(undefined, main)).toEqual({ style: 'candles', scaleMode: 'normal', showVolume: false });
    const view = withView(withView(undefined, 'style', 'line'), 'showVolume', true);
    expect(panelLook(view, main)).toEqual({ style: 'line', scaleMode: 'normal', showVolume: true });
    expect(withView(withView(view, 'style', undefined), 'showVolume', undefined)).toBeUndefined();
  });

  it('a saved view keeps only what this console draws', () => {
    expect(restoredPanelView({ style: 'line', scaleMode: 'log', showVolume: true })).toEqual({
      style: 'line',
      scaleMode: 'log',
      showVolume: true,
    });
    expect(restoredPanelView({ style: 'nope', scaleMode: 7 })).toBeUndefined();
    expect(restoredPanelView(null)).toBeUndefined();
  });

  it('a failed load says so, in the engine\'s words when it has some', () => {
    expect(panelLoadError(new Error('timeout'))).toBe('Could not load candles: timeout');
    expect(panelLoadError('x')).toBe('Could not load candles.');
  });
});
