import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import type { Bar } from '../../datafeed/candle-feed.service';
import { ChartHistoryPager } from './chart-history-pager';
import { ReplayController } from '../../replay/replay-controller';

// Scroll-back paging (`loadOlder`) — U13: moved from the page into ChartHistoryPager, cases unchanged: the replay head keeps its bar when history is prepended (CC-11), and an empty page
// marks the start of history so the chart stops asking (CC-14).

const H = 3_600_000;
const bar = (i: number): Bar => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, k) => bar(from + k));

function setup(older: Bar[]) {
  const feed = {
    getBars: vi.fn(() => Promise.resolve({ bars: older, noData: older.length === 0 })),
  };
  const host = { historyLoaded: vi.fn() };
  const bars = signal(range(100, 200));
  const replay = new ReplayController({
    bars,
    resolution: () => '60',
    digits: () => 5,
    symbolFacts: () => ({ pipSize: 0.0001, contractSize: 100_000 }),
    fetchIntrabar: () => Promise.resolve([]),
  });
  const historyStart = signal<string | null>(null);
  const loadEvents = vi.fn();
  const pager = new ChartHistoryPager({
    symbol: () => 'EURUSD',
    resolution: () => '60',
    bars,
    barsFor: () => ({ symbol: 'EURUSD', resolution: '60' }),
    loading: signal(false),
    historyStart,
    feed,
    replay: () => replay,
    host: () => host,
    loadEvents,
    extendCompareBars: () => Promise.resolve(),
  });
  // The shape the cases were written against (the page's members of the same names).
  const p = {
    loadOlder: () => pager.loadOlder(),
    bars,
    replay,
    replayIndex: replay.index,
    historyStart,
    loadEvents,
  } as Record<string, any>;
  return { p, feed, host };
}

describe('chart page — scroll-back', () => {
  it('prepends the older page and asks for the events of it', async () => {
    const { p, feed, host } = setup(range(40, 100));
    await p.loadOlder();
    expect(feed.getBars).toHaveBeenCalledWith('EURUSD', '60', 0, 100 * H - 1, 1500);
    expect(p.bars().length).toBe(160);
    expect(p.bars()[0].time).toBe(40 * H);
    expect(p['loadEvents']).toHaveBeenCalledWith(true);
    expect(host.historyLoaded).toHaveBeenCalled();
  });

  it('keeps the replay head on its bar when history is prepended (CC-11)', async () => {
    const { p } = setup(range(40, 100));
    p.replay.intrabar.set(false);
    p.replay.start(70); // the 70th bar: time 169 h
    const before = p.bars()[69].time;
    await p.loadOlder();
    expect(p.replayIndex()).toBe(130);
    expect(p.bars()[129].time).toBe(before);
  });

  it('an empty page is the start of history: the chart stops asking (CC-14)', async () => {
    const { p } = setup([]);
    await p.loadOlder();
    expect(p['historyStart']()).toBe('EURUSD|60');
    expect(p.bars().length).toBe(100);
  });

  it('a page with nothing older than the oldest bar is the start of history too', async () => {
    const { p } = setup(range(100, 120));
    await p.loadOlder();
    expect(p['historyStart']()).toBe('EURUSD|60');
  });
});
