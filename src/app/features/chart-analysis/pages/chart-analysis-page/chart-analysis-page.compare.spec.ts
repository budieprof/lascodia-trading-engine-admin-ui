import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { ChartCompareState } from './chart-compare-state';

// Compare overlays (CC-I12) — U13: moved from the page into ChartCompareState, cases unchanged.

function setup(mode = 'normal') {
  const scaleMode = signal(mode as any);
  const notify = { info: vi.fn() };
  const state = new ChartCompareState({
    feed: { getBars: vi.fn() },
    resolution: () => '60',
    oldestBarTime: () => undefined,
    now: () => 0,
    calendarOf: () => null,
    scaleMode: () => scaleMode,
    notify: (text) => notify.info(text),
  });
  // The page's member names the cases were written against.
  return {
    addCompare: (spec: any) => state.add(spec),
    removeCompare: (id: string) => state.remove(id),
    compareSeries: state.series,
    scaleMode,
    notify,
  } as Record<string, any>;
}

describe('chart page — compare overlays (CC-I12)', () => {
  it('a compare symbol turns the scale to Percent and says so', () => {
    const p = setup();
    p.addCompare({ id: 'a', kind: 'compare', symbols: ['GBPUSD'], color: '#FF6D00' });
    expect(p.compareSeries()).toHaveLength(1);
    expect(p.scaleMode()).toBe('percent');
    expect(p['notify'].info).toHaveBeenCalled();
  });

  it('indexed to 100 already compares; a ratio in its own pane leaves the scale alone', () => {
    const p = setup('indexed');
    p.addCompare({ id: 'a', kind: 'compare', symbols: ['GBPUSD'], color: '#FF6D00' });
    expect(p.scaleMode()).toBe('indexed');
    const q = setup('log');
    q.addCompare({ id: 'b', kind: 'ratio', symbols: ['EURUSD', 'GBPUSD'], color: '#FF6D00' });
    expect(q.scaleMode()).toBe('log');
    q.removeCompare('b');
    expect(q.compareSeries()).toEqual([]);
  });
});

describe('ChartCompareState — other symbols’ bars (CC-13, moved with the state)', () => {
  const H = 3_600_000;
  const bar = (i: number) => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 });

  it('loads each symbol, then extends it back to the chart’s oldest bar', async () => {
    const getBars = vi.fn((_s: string, _r: string, _f: number, to: number) =>
      Promise.resolve({
        bars: to > 150 * H ? [bar(150), bar(151)] : [bar(120), bar(149)],
      }),
    );
    const state = new ChartCompareState({
      feed: { getBars },
      resolution: () => '60',
      oldestBarTime: () => 100 * H,
      now: () => 200 * H,
      calendarOf: () => null,
      scaleMode: () => signal('normal' as any),
      notify: vi.fn(),
    });
    await state.loadBars(['GBPUSD'], '60');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.bars()['GBPUSD'].map((b) => b.time / H)).toEqual([120, 149, 150, 151]);
  });
});
