import { describe, expect, it } from 'vitest';

import type { ChartScriptItem, SavedChartScript } from '../scripts/chart-script.service';
import {
  dockStateOf,
  isWorkspaceState,
  linkGroupOf,
  migrateWorkspaceState,
  restoredDock,
  restoredSync,
  restoredPriceBased,
  restoredScriptItem,
  workspaceScriptOf,
  type ChartWorkspaceState,
  type DockView,
} from './workspace-state';

const V2: ChartScriptItem = {
  key: 'mine:20',
  source: 'mine',
  name: 'Smart Algo Signals Suite v2 [AlgoChief]',
  description: 'Indicator',
  kind: 'indicator',
  pineSource: 'v2 as added',
};
const COLOUR_OFF = { 'Display::Colour candles': false };

const saved = (over: Partial<SavedChartScript> = {}): SavedChartScript => ({
  id: '20',
  name: V2.name,
  source: 'v2 as added',
  kind: 'indicator',
  updatedAt: 0,
  ...over,
});

/** What the engine stores and a reload reads back. */
const throughTheEngine = (s: ChartWorkspaceState): ChartWorkspaceState =>
  JSON.parse(JSON.stringify(s));

describe('workspace persistence of script settings', () => {
  it('a script’s input overrides are saved with the layout and come back with it', () => {
    const state: ChartWorkspaceState = {
      v: 1,
      scripts: [workspaceScriptOf({ item: V2, values: COLOUR_OFF })],
    };
    const back = throughTheEngine(state);
    expect(isWorkspaceState(back)).toBe(true);
    const w = back.scripts![0];
    expect(w).toEqual({
      key: 'mine:20',
      source: 'mine',
      name: V2.name,
      kind: 'indicator',
      pineSource: 'v2 as added',
      values: COLOUR_OFF,
    });
    const item = restoredScriptItem(w, [saved()]);
    expect(item).toMatchObject({ key: 'mine:20', source: 'mine', pineSource: 'v2 as added' });
  });

  it('a saved script comes back as its newest version, with the layout’s values — not its defaults', () => {
    const w = workspaceScriptOf({ item: V2, values: COLOUR_OFF });
    const latest = saved({
      name: 'Smart Algo v2 (renamed)',
      source: 'v2 edited since',
      inputs: { 'Display::Colour candles': true, 'Signals::Sensitivity': 2 },
    });
    const item = restoredScriptItem(throughTheEngine({ v: 1, scripts: [w] }).scripts![0], [latest]);
    expect(item.pineSource).toBe('v2 edited since');
    expect(item.name).toBe('Smart Algo v2 (renamed)');
    // The values the chart runs it with are the layout's, untouched by the saved defaults.
    expect(w.values).toEqual(COLOUR_OFF);
  });

  it('a deleted saved script, an example or the editor’s script come back from the inline copy', () => {
    expect(restoredScriptItem(workspaceScriptOf({ item: V2, values: {} }), []).pineSource).toBe(
      'v2 as added',
    );
    const editor: ChartScriptItem = {
      key: 'editor:current',
      source: 'mine',
      name: 'Draft',
      description: '',
      kind: 'indicator',
      pineSource: 'typed',
    };
    const w = workspaceScriptOf({ item: editor, values: { 'Main::Length': 30 } });
    expect(restoredScriptItem(w, [saved()])).toMatchObject({
      key: 'editor:current',
      pineSource: 'typed',
    });
    expect(w.values).toEqual({ 'Main::Length': 30 });
  });

  it('an engine strategy comes back by id, without an inline source', () => {
    const strategy: ChartScriptItem = {
      key: 'strategy:1181',
      source: 'strategy',
      name: 'MeanRev v5',
      description: '',
      kind: 'strategy',
      strategyId: 1181,
    };
    const w = workspaceScriptOf({ item: strategy, values: { 'Risk::Stop (ATR)': 2 } });
    expect(w).not.toHaveProperty('pineSource');
    const item = restoredScriptItem(throughTheEngine({ v: 1, scripts: [w] }).scripts![0], []);
    expect(item).toEqual({
      key: 'strategy:1181',
      source: 'strategy',
      name: 'MeanRev v5',
      description: '',
      kind: 'strategy',
      strategyId: 1181,
    });
  });

  it('each script keeps its own values', () => {
    const other: ChartScriptItem = { ...V2, key: 'mine:5', name: 'v1', pineSource: 'v1' };
    const state = throughTheEngine({
      v: 1,
      scripts: [
        workspaceScriptOf({ item: V2, values: COLOUR_OFF }),
        workspaceScriptOf({
          item: other,
          values: { '🎨 Candle Coloring::Colour Candles': false },
        }),
      ],
    });
    expect(state.scripts!.map((s) => [s.key, s.values])).toEqual([
      ['mine:20', COLOUR_OFF],
      ['mine:5', { '🎨 Candle Coloring::Colour Candles': false }],
    ]);
  });
});

describe('workspace persistence of the dock', () => {
  const dock = (over: Partial<DockView> = {}): DockView => ({
    editorOpen: false,
    testerOpen: true,
    preference: 'tester',
    editorKey: null,
    editorText: null,
    editorCleared: false,
    ...over,
  });

  it('an editor cleared by removing its script stays cleared through a reload', () => {
    const saved = throughTheEngine({ v: 1, dock: dockStateOf(dock({ editorCleared: true })) });
    expect(saved.dock?.editorCleared).toBe(true);
    expect(restoredDock(saved.dock)).toEqual(dock({ editorCleared: true }));
  });

  it('is written only while set, so a layout that never cleared it reads as before', () => {
    const state = dockStateOf(dock({ editorOpen: true, editorKey: 'mine:20', editorText: 'x' }));
    expect(state).not.toHaveProperty('editorCleared');
    expect(state).toEqual({
      editorOpen: true,
      testerOpen: true,
      preference: 'tester',
      editorKey: 'mine:20',
      editorText: 'x',
    });
  });

  it('an older layout without the field — or without a dock — opens it as before: not cleared', () => {
    const old = {
      editorOpen: true,
      testerOpen: false,
      preference: 'editor' as const,
      editorKey: 'mine:5',
    };
    expect(restoredDock(old)).toEqual(
      dock({ editorOpen: true, testerOpen: false, preference: 'editor', editorKey: 'mine:5' }),
    );
    expect(restoredDock(undefined)).toEqual(dock());
  });
});

describe('restoredPriceBased (CC-I10)', () => {
  it('opens an older layout as the chart always drew it', () => {
    expect(restoredPriceBased(undefined)).toEqual({
      boxMethod: 'atr',
      boxSizeAtr: 1,
      boxPips: 10,
      renkoWicks: false,
      lineBreakLines: 3,
      pnfReversal: 3,
    });
  });

  it('keeps what the layout saved, survives the engine round trip', () => {
    const state: ChartWorkspaceState = {
      v: 1,
      priceBased: {
        boxMethod: 'pips',
        boxSizeAtr: 2,
        boxPips: 15,
        renkoWicks: true,
        lineBreakLines: 2,
        pnfReversal: 2,
      },
    };
    expect(restoredPriceBased(throughTheEngine(state).priceBased)).toEqual({
      boxMethod: 'pips',
      boxSizeAtr: 2,
      boxPips: 15,
      renkoWicks: true,
      lineBreakLines: 2,
      pnfReversal: 2,
    });
  });

  it('falls back on values out of range', () => {
    const pb = restoredPriceBased({ boxSizeAtr: -1, boxPips: 0, lineBreakLines: 40, pnfReversal: 0 });
    expect(pb).toMatchObject({ boxSizeAtr: 1, boxPips: 10, lineBreakLines: 3, pnfReversal: 3 });
  });
});

describe('workspace state v2 (CC-I5, multi-chart)', () => {
  /** A full v1 layout as the engine stores it today: every field a v1 console writes. */
  const v1: ChartWorkspaceState = {
    v: 1,
    symbol: 'EURUSD',
    resolution: '60',
    style: 'heikin-ashi',
    showVolume: false,
    scaleMode: 'log',
    invertScale: true,
    scaleSide: 'left',
    sessionBreaks: true,
    countdown: false,
    timezone: 'America/New_York',
    priceBased: { boxMethod: 'pips', boxSizeAtr: 2, boxPips: 15, renkoWicks: true, lineBreakLines: 2 },
    indicators: [{ uid: 'a', defId: 'rsi', params: { length: 14 }, visible: true }],
    scripts: [{ key: 'mine:20', source: 'mine', name: 'x', kind: 'indicator', values: { a: 1 } }],
    view: { barSpacing: 8, rightOffset: -3, paneHeights: [400, 120] },
    overlays: { showPositions: true, showEvents: false, minEventImpact: 'High' },
    split: { layout: '4', panels: [{ symbol: 'GBPUSD', resolution: '15' }, { symbol: 'USDJPY', resolution: '240' }] },
    panel: { watchlistOpen: false, width: 320, sidePane: 'news' },
    dock: { editorOpen: true, testerOpen: false, preference: 'editor', editorKey: 'mine:20', editorText: 'x' },
  };

  it('migrates a v1 layout losslessly: every field kept, the split panels become charts', () => {
    const v2 = migrateWorkspaceState(throughTheEngine(v1));
    expect(v2.v).toBe(2);
    expect(v2.charts).toEqual([
      { symbol: 'GBPUSD', resolution: '15' },
      { symbol: 'USDJPY', resolution: '240' },
    ]);
    expect(v2.split).toEqual({ layout: '4' });
    // Everything else is exactly the v1 layout's.
    const { v: _a, split: _b, charts: _c, ...kept } = v2;
    const { v: _d, split: _e, ...original } = v1;
    expect(kept).toEqual(original);
  });

  it('a v1 layout without a split stays without one; a v2 layout passes through untouched', () => {
    const plain = migrateWorkspaceState({ v: 1, symbol: 'EURUSD' });
    expect(plain).toEqual({ v: 2, symbol: 'EURUSD' });
    const v2: ChartWorkspaceState = { v: 2, symbol: 'EURUSD', charts: [{ symbol: 'GBPUSD', resolution: '60', link: 1 }] };
    expect(migrateWorkspaceState(v2)).toBe(v2);
  });

  it('reads both versions as workspace states, and nothing else', () => {
    expect(isWorkspaceState({ v: 1 })).toBe(true);
    expect(isWorkspaceState({ v: 2 })).toBe(true);
    expect(isWorkspaceState({ v: 3 })).toBe(false);
    expect(isWorkspaceState(null)).toBe(false);
  });

  it('link groups and sync defaults', () => {
    expect([linkGroupOf(1), linkGroupOf(3), linkGroupOf(4), linkGroupOf('2'), linkGroupOf(undefined)]).toEqual([1, 3, 0, 0, 0]);
    expect(restoredSync(undefined)).toEqual({ symbol: false, interval: false, crosshair: true, time: true });
    expect(restoredSync({ symbol: true, crosshair: false })).toMatchObject({ symbol: true, crosshair: false });
  });
});
