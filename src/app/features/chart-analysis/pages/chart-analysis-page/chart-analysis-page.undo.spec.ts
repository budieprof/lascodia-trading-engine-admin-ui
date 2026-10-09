import { describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';

import { ChartAnalysisPageComponent } from './chart-analysis-page.component';
import { UndoHistory, sameUndoable, undoableOf, type UndoableChart } from '../../workspace/undo-history';
import type { ChartWorkspaceState, WorkspaceScript } from '../../workspace/workspace-state';

// The page's one undo history (CC-I11), driven on just the state it touches: a chart step recorded from a burst of
// changes, undone and redone — studies, settings and scripts — and drawing steps handed to the drawing store.

type Page = ChartAnalysisPageComponent & Record<string, any>;

const rsi = { uid: 'a', defId: 'rsi', params: { length: 14 }, visible: true };
const trend: WorkspaceScript = { key: 'mine:1', source: 'mine', name: 'Trend', kind: 'indicator', values: { len: 5 } };

function setup() {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  const style = signal<string>('candles');
  const active = signal<any[]>([]);
  const scripts = signal<WorkspaceScript[]>([]);
  const symbol = signal('EURUSD');
  const captured = computed<ChartWorkspaceState>(() => ({
    v: 1,
    symbol: symbol(),
    style: style() as ChartWorkspaceState['style'],
    indicators: active(),
    scripts: scripts(),
  }));
  const drawings = { undo: vi.fn(), redo: vi.fn(), canUndo: () => false, canRedo: () => false };
  Object.assign(p, {
    symbol,
    active,
    drawings,
    undoHistory: new UndoHistory(),
    undoableState: computed(() => undoableOf(captured()), { equal: sameUndoable }),
    undoBaseline: null,
    undoPending: null,
    undoTimer: undefined,
    undoing: false,
    restored: true,
    applyingState: false,
    undoApplies: (e: { kind: string; symbol?: string }) => e.kind === 'chart' || e.symbol === symbol(),
    labelFor: (i: { defId: string }) => i.defId.toUpperCase(),
    applyChartSettings: (s: UndoableChart['settings']) => style.set(s.style ?? 'candles'),
    workspaceScripts: () => scripts(),
    scriptRuns: signal<any[]>([]),
    restoringScripts: signal<WorkspaceScript[]>([]),
    removeScriptFromChart: vi.fn((key: string) => scripts.update((l) => l.filter((w) => w.key !== key))),
    runScript: vi.fn(),
    chartScripts: { savedScripts: () => [] },
  });
  const note = () => p['noteUndoable'](p['undoableState']());
  note(); // the baseline
  return { p, style, active, scripts, drawings, note };
}

describe('chart page — one undo history (CC-I11)', () => {
  it('records a burst of changes as one step and undoes / redoes it', async () => {
    const { p, style, active, note } = setup();
    active.set([rsi]);
    note();
    style.set('bars');
    note();
    p['commitUndoStep']();
    expect(p.undoHistory.peekUndo(p['undoApplies'])).toMatchObject({ kind: 'chart', label: 'add RSI' });
    p.undo();
    expect(active()).toEqual([]);
    expect(style()).toBe('candles');
    await Promise.resolve();
    p.redo();
    expect(active()).toEqual([rsi]);
    expect(style()).toBe('bars');
  });

  it('a script the step removed comes back with its inputs; one it added goes', async () => {
    const { p, scripts, note } = setup();
    scripts.set([trend]);
    note();
    p['commitUndoStep']();
    p.undo();
    expect(p.removeScriptFromChart).toHaveBeenCalledWith('mine:1');
    await Promise.resolve();
    p.redo();
    expect(p.runScript).toHaveBeenCalledWith(expect.objectContaining({ key: 'mine:1' }), { len: 5 }, true);
  });

  it('a drawing step is the drawing store’s to undo — this symbol’s only', () => {
    const { p, drawings } = setup();
    p.undoHistory.record({ kind: 'drawing', symbol: 'GBPUSD' });
    p.undo();
    expect(drawings.undo).not.toHaveBeenCalled();
    p.undoHistory.record({ kind: 'drawing', symbol: 'EURUSD' });
    p.undo();
    expect(drawings.undo).toHaveBeenCalledTimes(1);
  });
});
