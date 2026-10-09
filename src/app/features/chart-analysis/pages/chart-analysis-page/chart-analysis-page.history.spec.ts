import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import type { Bar } from '../../datafeed/candle-feed.service';
import { ChartAnalysisPageComponent } from './chart-analysis-page.component';

// Scroll-back paging (`loadOlder`) run against just the state it touches, as the page's other
// specs do: the replay head keeps its bar when history is prepended (CC-11), and an empty page
// marks the start of history so the chart stops asking (CC-14).

type Page = ChartAnalysisPageComponent & Record<string, any>;

const H = 3_600_000;
const bar = (i: number): Bar => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, k) => bar(from + k));

function setup(older: Bar[]) {
  const feed = {
    getBars: vi.fn(() => Promise.resolve({ bars: older, noData: older.length === 0 })),
  };
  const host = { historyLoaded: vi.fn() };
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  Object.assign(p, {
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    bars: signal(range(100, 200)),
    barsFor: signal({ symbol: 'EURUSD', resolution: '60' }),
    loading: signal(false),
    replayActive: signal(false),
    replayIndex: signal(0),
    historyStart: signal<string | null>(null),
    compareBars: signal({}),
    compareRequest: 0,
    host: () => host,
    loadEvents: vi.fn(),
    feed,
  });
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
    p.replayActive.set(true);
    p.replayIndex.set(70); // the 70th bar: time 169 h
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
