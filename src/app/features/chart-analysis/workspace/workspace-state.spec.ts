import { describe, expect, it } from 'vitest';

import type { ChartScriptItem, SavedChartScript } from '../scripts/chart-script.service';
import {
  dockStateOf,
  isWorkspaceState,
  restoredDock,
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
      },
    };
    expect(restoredPriceBased(throughTheEngine(state).priceBased)).toEqual({
      boxMethod: 'pips',
      boxSizeAtr: 2,
      boxPips: 15,
      renkoWicks: true,
      lineBreakLines: 2,
    });
  });

  it('falls back on values out of range', () => {
    const pb = restoredPriceBased({ boxSizeAtr: -1, boxPips: 0, lineBreakLines: 40 });
    expect(pb).toMatchObject({ boxSizeAtr: 1, boxPips: 10, lineBreakLines: 3 });
  });
});
