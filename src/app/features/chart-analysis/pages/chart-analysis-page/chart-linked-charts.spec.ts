import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import type { Bar } from '../../datafeed/candle-feed.service';
import { SplitPanelsController, type ComparePanel } from '../../compare/split-panels.controller';
import { noDataMessage } from '../../datafeed/data-availability';
import type { ChartSync } from '../../workspace/workspace-state';
import { ChartLinkedCharts } from './chart-linked-charts';

// b10-ui: the split view's linked charts and the other charts' studies / scripts (CC-I5), moved out of the page into
// ChartLinkedCharts with these cases (they were in chart-analysis-page.split.spec, driving page privates). Built as the
// page wires it: over the split controller's panels, a panel's switch reaching its link group through `linkSymbol`.

const H = 3_600_000;
const NOW = Date.parse('2026-10-07T13:30:00Z');
const bar = (t: number, c = 1.1): Bar => ({ time: t, open: c, high: c, low: c, close: c, volume: 1 });
const hours = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => bar(Date.parse('2026-10-07T13:00:00Z') - (from - k) * H));

type Host = { syncCrosshair: ReturnType<typeof vi.fn>; syncRange: ReturnType<typeof vi.fn> };
const fakeHost = (): Host => ({ syncCrosshair: vi.fn(), syncRange: vi.fn() });

function setup(sync: Partial<Required<ChartSync>> = {}) {
  const symbol = signal('EURUSD');
  const resolution = signal('60');
  const mainLink = signal(0);
  const chartSync = signal<Required<ChartSync>>({
    symbol: false,
    interval: false,
    crosshair: true,
    time: true,
    ...sync,
  });
  const main = fakeHost();
  const hosts: Host[] = [fakeHost(), fakeHost()];
  const runOnChart = vi.fn(() => of({ title: 'run', error: null }));
  const selectSymbol = vi.fn();
  const selectResolution = vi.fn();
  const scriptCatalog = signal({
    mine: [{ key: 'mine:7', source: 'mine', name: 'Trend', description: '', kind: 'indicator', pineSource: 'x' }],
    examples: [],
    strategies: [],
    strategiesError: null,
  });
  // eslint-disable-next-line prefer-const -- the split controller's link deps reach `linked`, built after it
  let linked: ChartLinkedCharts;
  const split = new SplitPanelsController({
    feed: {
      getBars: vi.fn(() => Promise.resolve({ bars: hours(5, 6), noData: false })),
      sessionOf: () => null,
      gridOf: () => ({ kind: 'epoch' }),
      learnSession: () => Promise.resolve(null),
    } as never,
    isSessionResolution: () => false,
    noDataMessage: (s: string, r: string) => noDataMessage(s, r, null),
    candidates: () => [],
    mainSymbol: () => symbol(),
    mainResolution: () => resolution() as never,
    hostAt: () => undefined,
    now: () => NOW,
    calendarOf: () => null,
    calendarCodeOf: () => null,
    loadCalendar: () => Promise.resolve(null),
    linkSymbol: (id: string, s: string) => linked.linkSymbol(id, s),
    linkInterval: (id: string, r: string) => linked.linkInterval(id, r),
  });
  linked = new ChartLinkedCharts({
    comparePanels: split.panels,
    mainLink,
    chartSync,
    symbol,
    resolution,
    host: () => main as never,
    panelHosts: () => hosts as never,
    selectSymbol,
    selectResolution,
    setPanelSymbol: (id, s, propagate) => split.setSymbol(id, s, propagate),
    setPanelResolution: (id, r, propagate) => split.setResolution(id, r, propagate),
    scriptCatalog: () => scriptCatalog() as never,
    scriptRuns: () => [],
    chartScripts: { runOnChart } as never,
    destroyRef: { destroyed: false, onDestroy: () => () => undefined } as never,
  });
  return { linked, split, mainLink, chartSync, main, hosts, runOnChart, selectSymbol, selectResolution };
}

describe('chart page — the other charts’ studies and scripts (CC-I5)', () => {
  const panel = (over = {}): ComparePanel =>
    ({
      id: 'a',
      symbol: 'GBPUSD',
      resolution: '60',
      bars: hours(2, 3),
      indicators: [],
      link: 0,
      scripts: [],
      ...over,
    }) as ComparePanel;

  it('adds a study and a script to one chart, and removes them', () => {
    const { linked, split } = setup();
    split.panels.set([panel()]);
    linked.panelAdd('a', 'study:rsi');
    linked.panelAdd('a', 'script:mine:7');
    linked.panelAdd('a', 'script:mine:7'); // once
    const [a] = split.panels();
    expect(a.indicators.map((i) => i.defId)).toEqual(['rsi']);
    expect(a.scripts.map((s) => s.item.key)).toEqual(['mine:7']);
    linked.removePanelStudy('a', a.indicators[0].uid);
    linked.removePanelScript('a', 'mine:7');
    expect(split.panels()[0]).toMatchObject({ indicators: [], scripts: [] });
  });

  it('runs a chart’s script on its own series to its last bar, and keeps the run', () => {
    const { linked, split, runOnChart } = setup();
    split.panels.set([panel()]);
    linked.panelAdd('a', 'script:mine:7');
    linked.runPanelScript('a', 'mine:7');
    expect(runOnChart).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mine:7' }),
      'GBPUSD',
      '60',
      {},
      1500,
      { chartType: 'standard' },
    );
    const s = split.panels()[0].scripts[0];
    expect(s.result).toMatchObject({ title: 'run' });
    expect(s.ranTo).toBe(split.panels()[0].bars.at(-1)!.time);
  });

  it('offers only the Pine indicators of the catalogue, and the studies that read a chart’s own bars', () => {
    const { linked } = setup();
    expect(linked.panelScriptChoices().map((i) => i.key)).toEqual(['mine:7']);
    expect(linked.panelStudyDefs.length).toBeGreaterThan(0);
    expect(linked.panelLayerMap().size).toBe(0);
  });
});

describe('chart page — linked charts (CC-I5)', () => {
  const panel = (id: string, link: number, symbol = 'GBPUSD') =>
    ({ id, symbol, resolution: '60', bars: hours(2, 3), indicators: [], link, scripts: [] }) as ComparePanel;
  function linkedSetup(sync: Partial<Required<ChartSync>>) {
    const s = setup(sync);
    s.mainLink.set(1);
    s.split.panels.set([panel('a', 1), panel('b', 2, 'USDJPY')]);
    return s;
  }

  it('the crosshair and the time range move on the charts of the same group only', () => {
    const { linked, hosts, main } = linkedSetup({});
    linked.onChartCrosshair('main', 1234);
    expect(hosts[0].syncCrosshair).toHaveBeenCalledWith(1234);
    expect(hosts[1].syncCrosshair).not.toHaveBeenCalled();
    linked.onChartRange('a', { fromMs: 1, toMs: 2 });
    expect(main.syncRange).toHaveBeenCalledWith(1, 2);
    expect(hosts[1].syncRange).not.toHaveBeenCalled();
  });

  it('with crosshair sync off nothing follows', () => {
    const { linked, hosts } = linkedSetup({ crosshair: false });
    linked.onChartCrosshair('main', 1234);
    expect(hosts[0].syncCrosshair).not.toHaveBeenCalled();
  });

  it('symbol and interval sync carry a switch across the group, once', () => {
    const { split, selectSymbol, selectResolution } = linkedSetup({ symbol: true, interval: true });
    split.setSymbol('a', 'audusd');
    expect(selectSymbol).toHaveBeenCalledWith('AUDUSD', false);
    expect(split.panels()[1].symbol).toBe('USDJPY'); // another group
    split.setResolution('a', '240');
    expect(selectResolution).toHaveBeenCalledWith('240', false);
  });

  it('a chart without a link follows nothing', () => {
    const { linked, main } = linkedSetup({ symbol: true });
    linked.setPanelLink('a', 0);
    linked.onChartCrosshair('a', 5);
    expect(main.syncCrosshair).not.toHaveBeenCalled();
  });

  it('the layout menu sets the main chart’s group and each sync switch', () => {
    const { linked, mainLink, chartSync } = setup();
    linked.setMainLink(2);
    expect(mainLink()).toBe(2);
    linked.setSync('symbol', true);
    expect(chartSync().symbol).toBe(true);
    expect(linked.syncKeys.map((k) => k.key)).toEqual(['symbol', 'interval', 'crosshair', 'time']);
  });
});
