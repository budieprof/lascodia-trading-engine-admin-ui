import { describe, expect, it } from 'vitest';
import {
  addSection,
  tickParts,
  addSymbol,
  cycleFlag,
  flagCounts,
  flaggedItems,
  listSymbols,
  locate,
  moveSymbol,
  neighbour,
  nextSort,
  removeSection,
  removeSymbol,
  restoreSymbol,
  rowFor,
  setFlag,
  sortFromSettings,
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

  it('fills the optional columns from the quote, the live tick and the context (SP-I6)', () => {
    const now = Date.parse('2026-10-07T13:00:00Z');
    const r = rowFor(
      { symbol: 'EURUSD', flag: null },
      'a',
      quote({
        bid: 1.1,
        ask: 1.10012,
        dayHigh: 1.105,
        dayLow: 1.098,
        pipSize: 0.0001,
        adr: 0.007,
        atr: 0.0088,
        sparkline: [1.09, 1.1],
      }),
      1.1,
      undefined,
      5,
      {
        liveAsk: 1.10012,
        nowMs: now,
        legs: { base: 'EUR', quote: 'USD' },
        events: [{ title: 'NFP', currency: 'USD', scheduledAt: '2026-10-07T14:30:00Z' }],
        newsScores: new Map([
          ['EUR', 0.2],
          ['USD', -0.3],
        ]),
        pnl: new Map([['EURUSD', 12.5]]),
      },
    );
    expect(r.spread).toBe(1.2);
    expect(r.dayRange).toBe(70);
    expect(r.adr).toBe(70);
    expect(r.adrUsed).toBe(100);
    expect(r.atrPct).toBe(0.8);
    expect(r.sparkline).toEqual([1.09, 1.1]);
    expect(r.nextEvent?.title).toBe('NFP');
    expect(r.nextEventInMs).toBe(90 * 60_000);
    expect(r.news).toBe(0.5);
    expect(r.pnl).toBe(12.5);
    expect(r.session).toBe('LDN · NY');
    expect(r.homeSession).toBe(true);

    // A live tick beyond the day's high widens the range.
    expect(rowFor({ symbol: 'EURUSD', flag: null }, 'a', quote({ dayHigh: 1.105, dayLow: 1.098, pipSize: 0.0001 }), 1.107, undefined, 5).dayRange).toBe(90);
  });

  it('sorts by any column; the soonest event first, rows without one last', () => {
    const rows = [
      { symbol: 'A', nextEventInMs: null, spread: 3 },
      { symbol: 'B', nextEventInMs: 60_000, spread: 1 },
      { symbol: 'C', nextEventInMs: 30_000, spread: 2 },
    ] as WatchRow[];
    expect(nextSort({ key: 'none', dir: 1 }, 'nextEvent')).toEqual({ key: 'nextEvent', dir: 1 });
    expect(sortRows(rows, { key: 'nextEvent', dir: 1 }).map((r) => r.symbol)).toEqual(['C', 'B', 'A']);
    expect(sortRows(rows, { key: 'spread', dir: -1 }).map((r) => r.symbol)).toEqual(['A', 'C', 'B']);
  });

  it('a saved sort is validated', () => {
    expect(sortFromSettings({ columns: [], sort: { key: 'spread', dir: -1 } })).toEqual({ key: 'spread', dir: -1 });
    expect(sortFromSettings({ columns: [], sort: { key: 'sparkline', dir: 1 } })).toEqual({ key: 'none', dir: 1 });
    expect(sortFromSettings({ columns: [], sort: { key: 'bogus', dir: 1 } })).toEqual({ key: 'none', dir: 1 });
    expect(sortFromSettings(null)).toEqual({ key: 'none', dir: 1 });
  });

  it('flagged lists gather a flag across every list, once per symbol', () => {
    const a = setFlag(setFlag(list(), 'EURUSD', 'red'), 'EURGBP', 'red');
    const b: ChartWatchlist = {
      ...list(),
      id: 2,
      sections: [{ id: 'x', name: 'X', collapsed: false, items: [{ symbol: 'USDJPY', flag: 'red' }, { symbol: 'EURUSD', flag: 'red' }] }],
    };
    expect(flaggedItems([a, b], 'red').map((i) => i.symbol)).toEqual(['EURUSD', 'EURGBP', 'USDJPY']);
    expect(flagCounts([a, b]).red).toBe(3);
    expect(flagCounts([a, b]).blue).toBe(0);
  });

  it('an undone removal goes back exactly where it was (SP-11)', () => {
    const before = list();
    const where = locate(before, 'EURUSD')!;
    expect(where).toEqual({ item: { symbol: 'EURUSD', flag: null }, sectionId: 'a', index: 0 });
    const removed = removeSymbol(before, 'EURUSD');
    const back = restoreSymbol(removed, where);
    expect(back.sections[0].items.map((i) => i.symbol)).toEqual(['EURUSD', 'GBPUSD']);
    // Restoring twice is a no-op; a deleted section restores into the last one.
    expect(restoreSymbol(back, where)).toBe(back);
    const noSection = restoreSymbol(removeSection(removed, 'a'), where);
    expect(listSymbols(noSection)).toContain('EURUSD');
  });
});

describe('tickParts (TradingView colours the digits a tick changed)', () => {
  it('colours from the first changed digit to the end, the small pip included', () => {
    expect(tickParts(1.11973, 5, 1.11881)).toEqual({ head: '1.11', changed: '97', pip: '3', pipChanged: true });
    expect(tickParts(1.11973, 5, 1.11981)).toEqual({ head: '1.119', changed: '7', pip: '3', pipChanged: true });
    expect(tickParts(158.27, 3, 158.262)).toEqual({ head: '158.2', changed: '7', pip: '0', pipChanged: true });
  });

  it('colours only the small pip when only it changed', () => {
    expect(tickParts(1.12344, 5, 1.12341)).toEqual({ head: '1.1234', changed: '', pip: '4', pipChanged: true });
  });

  it('colours nothing before the first tick or when the price is unchanged', () => {
    expect(tickParts(1.12344, 5, null)).toEqual({ head: '1.1234', changed: '', pip: '4', pipChanged: false });
    expect(tickParts(1.12344, 5, 1.12344)).toEqual({ head: '1.1234', changed: '', pip: '4', pipChanged: false });
  });

  it('handles quotes without a fractional pip and a missing price', () => {
    expect(tickParts(1.2345, 4, 1.2355)).toEqual({ head: '1.23', changed: '45', pip: '', pipChanged: false });
    expect(tickParts(null, 5, 1.1)).toEqual({ head: '—', changed: '', pip: '', pipChanged: false });
  });
});
