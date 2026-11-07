import { describe, expect, it } from 'vitest';
import { SYMBOL_MEMORY_LIMIT, recalled, rememberSymbol, restoredSymbolMemory } from './symbol-memory';

const view = { barSpacing: 8, rightOffset: -40, paneHeights: [400, 120] };

describe('layout memory per symbol (CC-I11)', () => {
  it('remembers what a symbol was left on, most recent first, and recalls it', () => {
    let m = rememberSymbol({}, 'eurusd', { resolution: '15', view });
    m = rememberSymbol(m, 'GBPUSD', { resolution: '240' });
    m = rememberSymbol(m, 'EURUSD', { resolution: '60' });
    expect(Object.keys(m)).toEqual(['EURUSD', 'GBPUSD']);
    expect(recalled(m, 'eurusd')).toEqual({ resolution: '60' });
    expect(recalled(m, 'USDJPY')).toBeNull();
  });

  it('keeps at most the limit', () => {
    let m = {};
    for (let i = 0; i < SYMBOL_MEMORY_LIMIT + 5; i++) m = rememberSymbol(m, `S${i}`, { resolution: '60' });
    expect(Object.keys(m)).toHaveLength(SYMBOL_MEMORY_LIMIT);
    expect(recalled(m, 'S0')).toBeNull();
  });

  it('restores a saved memory, dropping what is malformed', () => {
    expect(
      restoredSymbolMemory({
        eurusd: { resolution: '15', view },
        GBPUSD: { resolution: '7s' },
        'bad key!': { resolution: '60' },
        USDJPY: { resolution: '60', view: { barSpacing: 'x' } },
      }),
    ).toEqual({ EURUSD: { resolution: '15', view }, USDJPY: { resolution: '60' } });
    expect(restoredSymbolMemory(null)).toEqual({});
  });

  it('US07: remembers by instrument (ESZ6 and ESH7 are ES1!) and migrates older keys, the most recent first', () => {
    const m = rememberSymbol({}, 'ESZ6', { resolution: '15' });
    expect(Object.keys(m)).toEqual(['ES1!']);
    expect(recalled(m, 'ESH7')).toEqual({ resolution: '15' });
    expect(
      restoredSymbolMemory({
        ESH7: { resolution: '60' },
        ESZ6: { resolution: '240' },
        'RATIO(EURUSD,GBPUSD)': { resolution: '1D' },
        EURUSD: { resolution: '5' },
      }),
    ).toEqual({ 'ES1!': { resolution: '60' }, 'RATIO(EURUSD,GBPUSD)': { resolution: '1D' }, EURUSD: { resolution: '5' } });
  });
});
