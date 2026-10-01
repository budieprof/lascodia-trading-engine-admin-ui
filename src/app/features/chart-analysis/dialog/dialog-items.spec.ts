import { describe, expect, it } from 'vitest';
import { ALL, FAVOURITES, categoriesFor, filterItems, itemKey, type DialogItem } from './dialog-items';

const items: DialogItem[] = [
  { kind: 'indicator', id: 'rsi', name: 'Relative Strength Index', category: 'Oscillators', keywords: ['rsi'] },
  { kind: 'indicator', id: 'stoch-rsi', name: 'Stoch RSI', category: 'Oscillators' },
  { kind: 'indicator', id: 'sma', name: 'Moving Average (Simple)', category: 'Moving Averages' },
  { kind: 'strategy', id: '7', name: 'RSI Mean Reversion', category: 'My strategies' },
  { kind: 'candle-pattern', id: 'doji', name: 'Doji', category: 'Candlestick' },
];
const none = new Set<string>();

describe('dialog filtering', () => {
  it('restricts to the tab when no query', () => {
    const r = filterItems(items, { tab: 'indicators', category: ALL, query: '', favourites: none });
    expect(r.map((i) => i.id)).toEqual(['rsi', 'stoch-rsi', 'sma']);
  });

  it('search spans every tab and ranks prefix matches first', () => {
    const r = filterItems(items, { tab: 'patterns', category: ALL, query: 'rsi', favourites: none });
    expect(r.map((i) => i.id)).toEqual(['rsi', '7', 'stoch-rsi']);
  });

  it('all terms must match', () => {
    const r = filterItems(items, { tab: 'indicators', category: ALL, query: 'stoch rsi', favourites: none });
    expect(r.map((i) => i.id)).toEqual(['stoch-rsi']);
  });

  it('category and favourites', () => {
    expect(
      filterItems(items, { tab: 'indicators', category: 'Moving Averages', query: '', favourites: none }).map((i) => i.id),
    ).toEqual(['sma']);
    const fav = new Set([itemKey(items[1])]);
    expect(
      filterItems(items, { tab: 'indicators', category: FAVOURITES, query: '', favourites: fav }).map((i) => i.id),
    ).toEqual(['stoch-rsi']);
  });

  it('lists categories per tab', () => {
    expect(categoriesFor(items, 'indicators')).toEqual([ALL, FAVOURITES, 'Oscillators', 'Moving Averages']);
  });
});
