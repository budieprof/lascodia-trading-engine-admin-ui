import { describe, expect, it, vi } from 'vitest';

import type { Bar } from '../../datafeed/candle-feed.service';
import { EPOCH_GRID } from '../../datafeed/aggregate';
import { ChartSessionStore, type ChartSessionFeed } from './chart-session-store';

// US02b: the page's main series, moved out of the page. These cases pin the guards the page relied on; the
// page's own specs (route, history, runs) still drive it through the page.

const H = 3_600_000;
const bar = (i: number, close = 1.1): Bar => ({
  time: i * H,
  open: 1.1,
  high: Math.max(1.1, close),
  low: Math.min(1.1, close),
  close,
  volume: 1,
});

function setup() {
  const feed = {
    invalidate: vi.fn(),
    getBars: vi.fn(() => Promise.resolve({ bars: [] as Bar[] })),
    sessionOf: vi.fn(() => null),
    gridOf: vi.fn(() => EPOCH_GRID),
    minuteBarsSince: vi.fn(() => Promise.resolve(null)),
    sessionTail: vi.fn(() => Promise.resolve(null)),
  };
  const host = { historyLoaded: vi.fn() };
  const store = new ChartSessionStore({
    feed: feed as unknown as ChartSessionFeed,
    host: () => host,
    replay: () => ({ shift: () => undefined }),
    loadEvents: vi.fn(),
    extendCompareBars: () => Promise.resolve(),
  });
  return { store, feed, host };
}

describe('ChartSessionStore', () => {
  it('a load names the requested series, drops its cache and starts loading', () => {
    const { store, feed } = setup();
    store.beginLoad('USDJPY', '240');
    expect(store.requested).toEqual({ symbol: 'USDJPY', resolution: '240' });
    expect(store.loading()).toBe(true);
    expect(store.error()).toBeNull();
    expect(feed.invalidate).toHaveBeenCalledWith('USDJPY', '240');
    expect(store.isCurrent('EURUSD', '60')).toBe(true);
    expect(store.isCurrent('USDJPY', '240')).toBe(false);
  });

  it('accepted bars are the series on screen; history start is cleared', () => {
    const { store } = setup();
    store.historyStart.set('EURUSD|60');
    store.acceptBars('EURUSD', '60', [bar(1), bar(2)]);
    expect(store.dataKey()).toBe('EURUSD|60');
    expect(store.historyComplete()).toBe(false);
    expect(store.bars().length).toBe(2);
  });

  it('a live price moves the newest bar of the series on screen', () => {
    const { store } = setup();
    store.acceptBars('EURUSD', '60', [bar(1), bar(2)]);
    store.applyPrice(1.2, 2 * H + 60_000);
    expect(store.bars()[1].close).toBe(1.2);
    expect(store.bars()[1].high).toBe(1.2);
  });

  it('right after a switch a price is not laid on the previous series’ bars', () => {
    const { store } = setup();
    store.acceptBars('EURUSD', '60', [bar(1), bar(2)]);
    store.symbol.set('USDJPY');
    const before = store.bars();
    store.applyPrice(150, 2 * H + 60_000);
    expect(store.bars()).toBe(before);
  });

  it('scroll-back hands off to the pager with the series on screen', async () => {
    const { store, feed, host } = setup();
    store.acceptBars('EURUSD', '60', [bar(100), bar(101)]);
    await store.loadOlder();
    expect(feed.getBars).toHaveBeenCalledWith('EURUSD', '60', 0, 100 * H - 1, 1500);
    expect(store.historyComplete()).toBe(true);
    expect(host.historyLoaded).toHaveBeenCalled();
  });
});
