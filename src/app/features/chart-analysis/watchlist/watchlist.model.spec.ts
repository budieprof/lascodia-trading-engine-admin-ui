import { describe, expect, it } from 'vitest';
import {
  addSection,
  addSymbol,
  cycleFlag,
  listSymbols,
  moveSymbol,
  neighbour,
  nextSort,
  removeSection,
  removeSymbol,
  rowFor,
  setFlag,
  sortRows,
  splitPrice,
  type ChartWatchlist,
  type WatchQuote,
  type WatchRow,
} from './watchlist.model';

const list = (): ChartWatchlist => ({
  id: 1,
  name: 'W',
  isActive: true,
  sortOrder: 0,
  sections: [
    {
      id: 'a',
      name: 'Majors',
      collapsed: false,
      items: [
        { symbol: 'EURUSD', flag: null },
        { symbol: 'GBPUSD', flag: null },
      ],
    },
    { id: 'b', name: 'Crosses', collapsed: true, items: [{ symbol: 'EURGBP', flag: null }] },
  ],
});

const quote = (over: Partial<WatchQuote> = {}): WatchQuote => ({
  symbol: 'EURUSD',
  bid: 1.1,
  ask: 1.1001,
  last: 1.1,
  prevClose: 1.0,
  dayOpen: 1.0,
  dayHigh: 1.2,
  dayLow: 0.9,
  change: 0.1,
  changePct: 10,
  digits: 5,
  marketOpen: true,
  asOfUtc: null,
  ...over,
});

describe('watchlist model', () => {
  it('computes change against the previous close, preferring the live tick', () => {
    const r = rowFor({ symbol: 'EURUSD', flag: null }, 'a', quote(), 1.05, 1.04, 5);
    expect(r.last).toBe(1.05);
    expect(r.change).toBeCloseTo(0.05);
    expect(r.changePct).toBeCloseTo(5);
    expect(r.tick).toBe('up');
    const flat = rowFor(
      { symbol: 'EURUSD', flag: null },
      'a',
      quote({ prevClose: null }),
      undefined,
      undefined,
      5,
    );
    expect(flat.last).toBe(1.1);
    expect(flat.change).toBeNull();
    expect(flat.tick).toBeNull();
  });

  it('sorts with nulls last and cycles headers like TradingView', () => {
    const rows = [
      { symbol: 'B', changePct: 1 },
      { symbol: 'A', changePct: null },
      { symbol: 'C', changePct: 3 },
    ] as WatchRow[];
    expect(sortRows(rows, { key: 'changePct', dir: -1 }).map((r) => r.symbol)).toEqual([
      'C',
      'B',
      'A',
    ]);
    expect(sortRows(rows, { key: 'changePct', dir: 1 }).map((r) => r.symbol)).toEqual([
      'B',
      'C',
      'A',
    ]);
    let s = nextSort({ key: 'none', dir: 1 }, 'last');
    expect(s).toEqual({ key: 'last', dir: -1 });
    s = nextSort(s, 'last');
    expect(s).toEqual({ key: 'last', dir: 1 });
    expect(nextSort(s, 'last').key).toBe('none');
    expect(nextSort(s, 'symbol')).toEqual({ key: 'symbol', dir: 1 });
  });

  it('adds without duplicates, removes, flags', () => {
    let l = addSymbol(list(), 'eurusd');
    expect(listSymbols(l)).toEqual(['EURUSD', 'GBPUSD', 'EURGBP']);
    l = addSymbol(l, 'usdjpy', 'b');
    expect(l.sections[1].items.map((i) => i.symbol)).toEqual(['EURGBP', 'USDJPY']);
    expect(l.sections[1].collapsed).toBe(false);
    l = removeSymbol(l, 'GBPUSD');
    expect(listSymbols(l)).toEqual(['EURUSD', 'EURGBP', 'USDJPY']);
    l = setFlag(l, 'EURUSD', cycleFlag(null));
    expect(l.sections[0].items[0].flag).toBe('red');
    expect(cycleFlag('purple')).toBeNull();
  });

  it('moves within and across sections', () => {
    let l = moveSymbol(list(), 'GBPUSD', 'a', 'EURUSD');
    expect(l.sections[0].items.map((i) => i.symbol)).toEqual(['GBPUSD', 'EURUSD']);
    l = moveSymbol(l, 'EURUSD', 'b', null);
    expect(l.sections[0].items.map((i) => i.symbol)).toEqual(['GBPUSD']);
    expect(l.sections[1].items.map((i) => i.symbol)).toEqual(['EURGBP', 'EURUSD']);
  });

  it('removing a section keeps its symbols', () => {
    const l = removeSection(addSection(list(), 'Mine'), 'b');
    expect(l.sections.map((s) => s.name)).toEqual(['Majors', 'Mine']);
    expect(l.sections[0].items.map((i) => i.symbol)).toEqual(['EURUSD', 'GBPUSD', 'EURGBP']);
  });

  it('splits the fractional pip and navigates', () => {
    expect(splitPrice(1.12848, 5)).toEqual(['1.1284', '8']);
    expect(splitPrice(157.985, 3)).toEqual(['157.98', '5']);
    expect(splitPrice(4170.37, 2)).toEqual(['4170.37', '']);
    expect(splitPrice(null, 5)).toEqual(['—', '']);
    expect(neighbour(['A', 'B', 'C'], 'B', 1)).toBe('C');
    expect(neighbour(['A', 'B', 'C'], 'A', -1)).toBeNull();
    expect(neighbour(['A', 'B'], 'Z', 1)).toBe('A');
  });
});
