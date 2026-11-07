import { describe, expect, it, vi } from 'vitest';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import {
  RemoteSymbolSearch,
  SEARCH_PAGE,
  groupSearch,
  mergeSearch,
  searchRowOf,
} from './symbol-search';

const inst = (p: Partial<InstrumentDto>) =>
  ({ description: null, exchange: null, assetClass: 'Fx', ...p }) as InstrumentDto;

describe('symbol search (UD09: the whole catalogue, honest about data)', () => {
  const local = [
    searchRowOf(inst({ symbol: 'EURUSD', assetClass: 'Fx' }), true),
    searchRowOf(inst({ symbol: 'BTC-USD', assetClass: 'Crypto', exchange: 'COINBASE' }), true),
  ];

  it('the loaded catalogue first (ranked as before), then the engine’s further matches — with data before without', () => {
    const remote = [
      searchRowOf(
        inst({ symbol: 'BTC-USD', assetClass: 'Crypto', exchange: 'COINBASE', hasCandles: true }),
        false,
      ),
      searchRowOf(
        inst({
          symbol: 'BTC-USD',
          assetClass: 'Crypto',
          exchange: 'KRAKEN',
          hasCandles: false,
          candleSource: null,
        }),
        false,
      ),
      searchRowOf(
        inst({
          symbol: 'BTC-EUR',
          assetClass: 'Crypto',
          exchange: 'KRAKEN',
          hasCandles: true,
          candleSource: { id: 'crypto-kraken', kind: 'venue', label: 'Kraken' },
        }),
        false,
      ),
    ];
    const rows = mergeSearch(local, remote, 'btc', null);
    expect(rows.map((r) => r.key)).toEqual([
      'BTC-USD|COINBASE',
      'BTC-EUR|KRAKEN',
      'BTC-USD|KRAKEN',
    ]);
    expect(rows[2].noDataReason).toBe('no data yet (no candle source enabled)');
    expect(rows[1].source).toBe('Kraken');
    expect(mergeSearch(local, remote, 'btc', 'Fx')).toEqual([]);
    // Typing "usd" keeps the old ranking of the loaded rows.
    expect(mergeSearch(local, [], '', null).map((r) => r.symbol)).toEqual(['EURUSD', 'BTC-USD']);
  });

  it('groups by asset class in a fixed order', () => {
    const groups = groupSearch(mergeSearch(local, [], '', null));
    expect(groups.map((g) => g.assetClass)).toEqual(['Fx', 'Crypto']);
  });

  it('asks the engine from two characters, debounced; newest query wins; pages with "more"', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (q: string, o: { skip: number; take: number }) => ({
      rows: Array.from({ length: o.skip === 0 ? SEARCH_PAGE : 10 }, (_, i) =>
        inst({
          symbol: `${q.toUpperCase()}${o.skip + i}`,
          assetClass: 'Equity',
          hasCandles: false,
        }),
      ),
      total: SEARCH_PAGE + 10,
    }));
    const s = new RemoteSymbolSearch(fetch, 100);
    s.set('a', null);
    expect(s.rows()).toEqual([]);
    s.set('ap', null);
    s.set('aap', null);
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('aap');
    expect(s.rows()).toHaveLength(SEARCH_PAGE);
    expect(s.hasMore()).toBe(true);
    s.more();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls[1][1]).toMatchObject({ skip: SEARCH_PAGE });
    expect(s.rows()).toHaveLength(SEARCH_PAGE + 10);
    expect(s.hasMore()).toBe(false);
    vi.useRealTimers();
  });

  it('a failed search says so and keeps nothing stale', async () => {
    vi.useFakeTimers();
    const s = new RemoteSymbolSearch(async () => {
      throw new Error('engine down');
    }, 10);
    s.set('btc', null);
    await vi.advanceTimersByTimeAsync(20);
    expect(s.error()).toBe('engine down');
    expect(s.loading()).toBe(false);
    vi.useRealTimers();
  });
});
