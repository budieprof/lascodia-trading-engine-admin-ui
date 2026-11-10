import { describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';

import type { UndoableChart } from '../../workspace/undo-history';
import type { ChartWorkspaceState, WorkspaceScript } from '../../workspace/workspace-state';
import { ChartUndoController } from './chart-undo-controller';

// The page's one undo history (CC-I11) — b10-ui: ChartUndoController, built over just the state it touches (it was
// driven through page privates before the move): a chart step recorded from a burst of changes, undone and redone —
// studies, settings and scripts — drawing steps handed to the drawing store, and a layout switch rebasing it.

const rsi = { uid: 'a', defId: 'rsi', params: { length: 14 }, visible: true };
const trend: WorkspaceScript = { key: 'mine:1', source: 'mine', name: 'Trend', kind: 'indicator', values: { len: 5 } };

function setup() {
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
  const flags = { restored: true, applyingState: false };
  const removeScriptFromChart = vi.fn((key: string) => scripts.update((l) => l.filter((w) => w.key !== key)));
  const runScript = vi.fn();
  const u = new ChartUndoController({
    captureState: () => captured(),
    symbol,
    drawings: drawings as never,
    restored: () => flags.restored,
    applyingState: () => flags.applyingState,
    labelFor: (i) => i.defId.toUpperCase(),
    applyChartSettings: (s: UndoableChart['settings']) => style.set(s.style ?? 'candles'),
    active,
    workspaceScripts: () => scripts(),
    removeScriptFromChart,
    scriptRuns: signal<any[]>([]),
    restoringScripts: signal<WorkspaceScript[]>([]),
    runScript,
    savedScripts: () => [],
  });
  // As the page's effect feeds it.
  const note = () => u.noteUndoable(u.undoableState());
  note(); // the baseline
  return { u, style, active, scripts, drawings, flags, note, removeScriptFromChart, runScript };
}

describe('chart page — one undo history (CC-I11)', () => {
  it('records a burst of changes as one step and undoes / redoes it', async () => {
    const { u, style, active, note } = setup();
    active.set([rsi]);
    note();
    style.set('bars');
    note();
    u.commitUndoStep();
    expect(u.undoHistory.peekUndo(u.undoApplies)).toMatchObject({ kind: 'chart', label: 'add RSI' });
    expect(u.undoTitle()).toBe('Undo add RSI (⌘Z)');
    expect(u.canUndo()).toBe(true);
    u.undo();
    expect(active()).toEqual([]);
    expect(style()).toBe('candles');
    await Promise.resolve();
    expect(u.redoTitle()).toBe('Redo add RSI (⇧⌘Z)');
    u.redo();
    expect(active()).toEqual([rsi]);
    expect(style()).toBe('bars');
  });

  it('a script the step removed comes back with its inputs; one it added goes', async () => {
    const { u, scripts, note, removeScriptFromChart, runScript } = setup();
    scripts.set([trend]);
    note();
    u.commitUndoStep();
    u.undo();
    expect(removeScriptFromChart).toHaveBeenCalledWith('mine:1');
    await Promise.resolve();
    u.redo();
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({ key: 'mine:1' }), { len: 5 }, true);
  });

  it('a drawing step is the drawing store’s to undo — this symbol’s only', () => {
    const { u, drawings } = setup();
    u.undoHistory.record({ kind: 'drawing', symbol: 'GBPUSD' });
    u.undo();
    expect(drawings.undo).not.toHaveBeenCalled();
    u.undoHistory.record({ kind: 'drawing', symbol: 'EURUSD' });
    u.undo();
    expect(drawings.undo).toHaveBeenCalledTimes(1);
  });

  it('nothing is a step while a layout is applied; a layout switch drops the chart steps', () => {
    const { u, active, note, flags } = setup();
    flags.applyingState = true;
    active.set([rsi]);
    note();
    u.commitUndoStep();
    expect(u.canUndo()).toBe(false);
    expect(u.undoTitle()).toBe('Nothing to undo');
    flags.applyingState = false;
    active.set([]);
    note();
    u.commitUndoStep();
    expect(u.canUndo()).toBe(true);
    u.undoHistory.record({ kind: 'drawing', symbol: 'EURUSD' });
    u.rebase();
    // The chart step went; the drawing step (per symbol) stays.
    expect(u.undoHistory.peekUndo(u.undoApplies)).toEqual({ kind: 'drawing', symbol: 'EURUSD' });
  });
});
