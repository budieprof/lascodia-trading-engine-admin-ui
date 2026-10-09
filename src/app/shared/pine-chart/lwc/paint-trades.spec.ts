import { describe, expect, it } from 'vitest';
import { mergeFills, tradeMarkers } from './paint-trades';
import type { TradeDrawing } from '../render/render-model';

const trade = (over: Partial<TradeDrawing>): TradeDrawing =>
  ({
    number: 1,
    direction: 'short',
    entryX: 10,
    entryPrice: 1.1,
    entrySignal: 'Short',
    exitX: 20,
    exitPrice: 1.09,
    exitSignal: 'Long',
    qty: 10000,
    profit: 100,
    profitPercent: 1,
    isOpen: false,
    lineColor: '#089981',
    ...over,
  }) as TradeDrawing;

describe('mergeFills (one arrow per order, as TradingView)', () => {
  it('merges a reversal into a single order with the summed quantity', () => {
    const shortT = trade({});
    const longT = trade({ number: 2, direction: 'long', entryX: 20, entryPrice: 1.09, entrySignal: 'Long', exitX: null, exitPrice: null, exitSignal: null, isOpen: true });
    const merged = mergeFills([...tradeMarkers(shortT), ...tradeMarkers(longT)]);
    const at20 = merged.filter((m) => Math.round(m.logical) === 20);
    expect(at20).toHaveLength(1);
    expect(at20[0].text).toBe('Long\n+20,000 units');
    expect(at20[0].side).toBe('buy');
    expect(at20[0].tooltip.split('\n')).toHaveLength(2);
    // The one arrow stands for both trades: a click on it can select either row.
    expect([...at20[0].trades].sort()).toEqual([1, 2]);
  });

  it('names the trade each fill belongs to', () => {
    expect(tradeMarkers(trade({ number: 7 })).map((m) => m.trades)).toEqual([[7], [7]]);
  });

  it('keeps separate orders on different bars, sides or prices', () => {
    const a = trade({});
    const b = trade({ number: 2, entryX: 30, exitX: 40 });
    expect(mergeFills([...tradeMarkers(a), ...tradeMarkers(b)])).toHaveLength(4);
  });
});
