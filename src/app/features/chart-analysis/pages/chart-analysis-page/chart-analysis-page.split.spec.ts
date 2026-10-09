import { describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';
import { of } from 'rxjs';

import type { Bar } from '../../datafeed/candle-feed.service';
import { ChartAnalysisPageComponent, type ComparePanel } from './chart-analysis-page.component';

// The split view (CC-12) run against just the state it touches, as the page's other specs do:
// panels restored from a layout, moved by live prices, and paged back on scroll.

type Page = ChartAnalysisPageComponent & Record<string, any>;

const H = 3_600_000;
const NOW = Date.parse('2026-10-07T13:30:00Z');
const bar = (t: number, c = 1.1): Bar => ({
  time: t,
  open: c,
  high: c,
  low: c,
  close: c,
  volume: 1,
});
const hours = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => bar(Date.parse('2026-10-07T13:00:00Z') - (from - k) * H));

function setup(getBars = vi.fn(() => Promise.resolve({ bars: hours(5, 6), noData: false }))) {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  const comparePanels = signal<ComparePanel[]>([]);
  Object.assign(p, {
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    symbols: signal([{ symbol: 'EURUSD' }, { symbol: 'GBPUSD' }, { symbol: 'USDJPY' }]),
    splitLayout: signal('1'),
    comparePanels,
    splitLayouts: [
      { id: '1', label: '', panels: 0 },
      { id: '2h', label: '', panels: 1 },
      { id: '4', label: '', panels: 3 },
    ],
    feed: { getBars, sessionOf: () => null },
    serverClock: { now: () => NOW },
    panelHosts: () => [],
    calendars: new Map(),
    chartScripts: { savedScripts: () => [], runOnChart: vi.fn(() => of({ title: 'run', error: null })) },
    destroyRef: { destroyed: false, onDestroy: () => () => undefined },
    panelRuns: new Set(),
    scriptCatalog: signal({
      mine: [{ key: 'mine:7', source: 'mine', name: 'Trend', description: '', kind: 'indicator', pineSource: 'x' }],
      examples: [],
      strategies: [],
      strategiesError: null,
    }),
  });
  Object.defineProperty(p, 'panelScriptChoices', {
    value: computed(() => [...p.scriptCatalog().mine, ...p.scriptCatalog().examples]),
  });
  // As the page derives the layout's other charts (v2 `charts`, CC-I5).
  Object.defineProperty(p, 'panelStates', {
    value: computed(() =>
      comparePanels().map((x) => ({
        symbol: x.symbol,
        resolution: x.resolution,
        ...(x.indicators.length ? { indicators: x.indicators } : {}),
        ...(x.link ? { link: x.link } : {}),
      })),
    ),
  });
  return { p, getBars };
}

describe('chart page — split panels (CC-12)', () => {
  it('restores the layout’s arrangement and each chart’s series, studies and link, and loads them', async () => {
    const { p, getBars } = setup();
    const rsi = { uid: 'r', defId: 'rsi', params: { length: 14 }, visible: true };
    p['restoreSplit']({ layout: '2h' }, [{ symbol: 'usdjpy', resolution: '240', indicators: [rsi], link: 2 }]);
    expect(p.splitLayout()).toBe('2h');
    expect(p.comparePanels().map((x: ComparePanel) => [x.symbol, x.resolution])).toEqual([
      ['USDJPY', '240'],
    ]);
    await Promise.resolve();
    expect(getBars).toHaveBeenCalledWith('USDJPY', '240', 0, expect.any(Number), 1500);
    expect(p['panelStates']()).toEqual([{ symbol: 'USDJPY', resolution: '240', indicators: [rsi], link: 2 }]);
  });

  it('fills an arrangement the layout saved short with new panels on other symbols', () => {
    const { p } = setup();
    p['restoreSplit']({ layout: '4' }, [{ symbol: 'GBPUSD', resolution: '60' }]);
    const symbols = p.comparePanels().map((x: ComparePanel) => x.symbol);
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toBe('GBPUSD');
  });

  it('a live price moves the panels that show its symbol', () => {
    const { p } = setup();
    p.comparePanels.set([
      { id: 'a', symbol: 'GBPUSD', resolution: '60', bars: hours(2, 3), indicators: [], link: 0, scripts: [] },
      { id: 'b', symbol: 'USDJPY', resolution: '60', bars: hours(2, 3), indicators: [], link: 0, scripts: [] },
    ]);
    p['applyPanelTick']({ symbol: 'gbpusd', bid: 1.3 });
    const [a, b] = p.comparePanels();
    expect(a.bars.at(-1)).toMatchObject({ close: 1.3, high: 1.3 });
    expect(b.bars.at(-1)).toMatchObject({ close: 1.1 });
  });

  it('scroll-back prepends the panel’s older page; an empty page ends its history', async () => {
    const older = vi.fn(() => Promise.resolve({ bars: hours(10, 5), noData: false }));
    const { p } = setup(older);
    p.comparePanels.set([
      { id: 'a', symbol: 'GBPUSD', resolution: '60', bars: hours(4, 5), indicators: [], link: 0, scripts: [] },
    ]);
    await p.loadPanelOlder('a');
    expect(p.comparePanels()[0].bars).toHaveLength(10);

    older.mockImplementation(() => Promise.resolve({ bars: [], noData: true }));
    await p.loadPanelOlder('a');
    expect(p.comparePanels()[0].historyComplete).toBe(true);
  });
});

describe('chart page — the other charts’ studies and scripts (CC-I5)', () => {
  const panel = (over = {}) => ({
    id: 'a',
    symbol: 'GBPUSD',
    resolution: '60',
    bars: hours(2, 3),
    indicators: [],
    link: 0,
    scripts: [],
    ...over,
  });

  it('adds a study and a script to one chart, and removes them', () => {
    const { p } = setup();
    p.comparePanels.set([panel()]);
    p.panelAdd('a', 'study:rsi');
    p.panelAdd('a', 'script:mine:7');
    p.panelAdd('a', 'script:mine:7'); // once
    const [a] = p.comparePanels();
    expect(a.indicators.map((i: { defId: string }) => i.defId)).toEqual(['rsi']);
    expect(a.scripts.map((s: { item: { key: string } }) => s.item.key)).toEqual(['mine:7']);
    p.removePanelStudy('a', a.indicators[0].uid);
    p.removePanelScript('a', 'mine:7');
    expect(p.comparePanels()[0]).toMatchObject({ indicators: [], scripts: [] });
  });

  it('runs a chart’s script on its own series to its last bar, and keeps the run', () => {
    const { p } = setup();
    p.comparePanels.set([panel()]);
    p.panelAdd('a', 'script:mine:7');
    p['runPanelScript']('a', 'mine:7');
    expect(p.chartScripts.runOnChart).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mine:7' }),
      'GBPUSD',
      '60',
      {},
      1500,
      { chartType: 'standard' },
    );
    const s = p.comparePanels()[0].scripts[0];
    expect(s.result).toMatchObject({ title: 'run' });
    expect(s.ranTo).toBe(p.comparePanels()[0].bars.at(-1).time);
  });
});
