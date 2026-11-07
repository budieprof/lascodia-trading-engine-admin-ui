import { describe, expect, it } from 'vitest';

import { coverageNote, cvdTitle, flowOrigin, flowUnitWord, footprintCaption } from './flow-labels';
import type { TickBarsDto } from './orderflow.types';

type D = Pick<TickBarsDto, 'deltaSource' | 'volumeUnit' | 'source'>;
const mt5: D = { deltaSource: 'tickRule', volumeUnit: 'ticks', source: { id: 'mt5', kind: 'mt5', label: 'MT5 broker ticks' } };
const legacy: D = {};
const trades: D = { deltaSource: 'trades', volumeUnit: 'base', source: { id: 'crypto-coinbase', kind: 'venue', label: 'Coinbase' } };
const unsided: D = { deltaSource: 'tickRule', volumeUnit: 'base', source: { id: 'crypto-x', kind: 'venue', label: 'X' } };
const quotes: D = { deltaSource: 'tickRule', volumeUnit: 'ticks', source: { id: 'venue-y', kind: 'venue', label: 'Y' } };
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe('flow-labels (UF02)', () => {
  it('names the origin: trades only with a volume unit and deltaSource trades', () => {
    expect(flowOrigin(mt5)).toBe('tickRuleQuotes');
    expect(flowOrigin(legacy)).toBe('tickRuleQuotes');
    expect(flowOrigin(trades)).toBe('trades');
    expect(flowOrigin(unsided)).toBe('tickRuleTrades');
    expect(flowOrigin(quotes)).toBe('tickRuleQuotes');
  });

  it('unit words', () => {
    expect(flowUnitWord(trades, 'btc')).toBe('BTC');
    expect(flowUnitWord(trades, null)).toBe('base units');
    expect(flowUnitWord({ volumeUnit: 'contracts' })).toBe('contracts');
    expect(flowUnitWord({ volumeUnit: 'shares' })).toBe('shares');
    expect(flowUnitWord(mt5)).toBe('ticks');
  });

  it('CVD titles say estimated everywhere the tick rule made the delta', () => {
    expect(cvdTitle(mt5)).toBe('Tick delta (CVD) — estimated (tick rule)');
    expect(cvdTitle(legacy)).toBe('Tick delta (CVD) — estimated (tick rule)');
    expect(cvdTitle(trades, 'BTC')).toBe('Trade delta (CVD) — Coinbase trades, BTC (aggressor side as reported)');
    expect(cvdTitle(unsided, 'ETH')).toBe('Delta (CVD) — estimated (tick rule over X trade prices), ETH');
    expect(cvdTitle(quotes)).toBe('Tick delta (CVD) — estimated (tick rule over Y quotes)');
  });

  it('footprint captions', () => {
    expect(footprintCaption(mt5, 'rows of 1 pip (auto)')).toBe(
      'Footprint — estimated (tick rule on broker quotes): tick counts (down × up), rows of 1 pip (auto); shaded: 3:1 diagonal imbalance',
    );
    expect(footprintCaption(trades, 'rows of 5 ticks', 'BTC')).toContain('Coinbase trades: BTC traded (sell × buy');
    expect(footprintCaption(unsided, 'rows of 1 tick')).toContain('estimated (tick rule over X trade prices');
    expect(footprintCaption(quotes, 'rows of 1 tick')).toContain('estimated (tick rule over Y quotes): tick counts');
  });

  it('coverage: MT5 text unchanged; venues read the last 24 h', () => {
    const c = Date.parse('2026-11-06T00:00:00Z');
    expect(coverageNote(mt5, 'cvd', null, 0, when)).toBe('no ticks retained for this symbol');
    expect(coverageNote(mt5, 'cvd', c, c - 1, when)).toBe('no ticks before 2026-11-06T00:00 (ticks are kept 14 days)');
    expect(coverageNote(mt5, 'ribbon', c, c - 1, when)).toBe(
      'ticks from 2026-11-06T00:00 (kept 14 days); older bars: candle spread only',
    );
    expect(coverageNote(mt5, 'cvd', c, c, when)).toBeNull();
    expect(coverageNote(trades, 'cvd', null, 0, when)).toBe('no Coinbase trades or quotes stored for this window');
    expect(coverageNote(trades, 'cvd', c, c - 1, when)).toContain('the last 24 h are read; older bars: candle trade counts only');
  });
});
