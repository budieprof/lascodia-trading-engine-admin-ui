import { describe, expect, it } from 'vitest';
import type { ActiveIndicator } from '../chart/chart-host.component';
import { UndoHistory, describeChange, sameUndoable, undoableOf, type UndoEntry } from './undo-history';
import type { ChartWorkspaceState } from './workspace-state';

const rsi = { uid: 'a', defId: 'rsi', params: { length: 14 }, visible: true } as unknown as ActiveIndicator;
const state = (over: Partial<ChartWorkspaceState> = {}): ChartWorkspaceState => ({
  v: 1,
  symbol: 'EURUSD',
  resolution: '60',
  style: 'candles',
  view: { logicalRange: null } as unknown as ChartWorkspaceState['view'],
  panel: { watchlistOpen: true },
  indicators: [],
  scripts: [],
  ...over,
});
const name = (i: ActiveIndicator) => i.defId.toUpperCase();

describe('undoableOf', () => {
  it('keeps what the operator edits and leaves where the chart looks', () => {
    const u = undoableOf(state({ indicators: [rsi] }));
    expect(u.settings).toEqual({ style: 'candles' });
    expect(u.indicators).toEqual([rsi]);
    expect(u.indicators[0]).not.toBe(rsi);
    // Another symbol, zoom or side panel is not a change to undo.
    expect(sameUndoable(u, undoableOf(state({ indicators: [rsi], symbol: 'GBPUSD', panel: {} })))).toBe(true);
  });
});

describe('describeChange', () => {
  it('names what a step did', () => {
    const empty = undoableOf(state());
    const withRsi = undoableOf(state({ indicators: [rsi] }));
    expect(describeChange(empty, withRsi, name)).toBe('add RSI');
    expect(describeChange(withRsi, empty, name)).toBe('remove RSI');
    const longer = undoableOf(state({ indicators: [{ ...rsi, params: { length: 21 } }] }));
    expect(describeChange(withRsi, longer, name)).toBe('RSI settings');
    const script = { key: 'mine:1', source: 'mine', name: 'Trend', kind: 'indicator', values: {} } as const;
    expect(describeChange(empty, undoableOf(state({ scripts: [script] })), name)).toBe('add Trend');
    expect(describeChange(empty, undoableOf(state({ style: 'bars' })), name)).toBe('chart settings');
  });
});

describe('UndoHistory', () => {
  const chart = (label: string): UndoEntry => ({
    kind: 'chart',
    label,
    before: undoableOf(state()),
    after: undoableOf(state()),
  });
  const onEurusd = (e: UndoEntry) => e.kind === 'chart' || e.symbol === 'EURUSD';

  it('undoes in the order the steps were made, across drawings and chart steps', () => {
    const h = new UndoHistory();
    h.record({ kind: 'drawing', symbol: 'EURUSD' });
    h.record(chart('add RSI'));
    expect(h.undo(onEurusd)).toMatchObject({ kind: 'chart', label: 'add RSI' });
    expect(h.undo(onEurusd)).toMatchObject({ kind: 'drawing' });
    expect(h.undo(onEurusd)).toBeNull();
    expect(h.redo(onEurusd)).toMatchObject({ kind: 'drawing' });
    expect(h.peekRedo(onEurusd)).toMatchObject({ label: 'add RSI' });
  });

  it('skips another symbol’s drawing steps and keeps them for it', () => {
    const h = new UndoHistory();
    h.record({ kind: 'drawing', symbol: 'EURUSD' });
    h.record({ kind: 'drawing', symbol: 'GBPUSD' });
    expect(h.undo(onEurusd)).toEqual({ kind: 'drawing', symbol: 'EURUSD' });
    expect(h.peekUndo((e) => e.kind === 'drawing' && e.symbol === 'GBPUSD')).not.toBeNull();
  });

  it('a new step ends redo; a drawing step taken back drops its marker; a layout switch forgets chart steps', () => {
    const h = new UndoHistory();
    h.record(chart('a'));
    h.undo(onEurusd);
    h.record({ kind: 'drawing', symbol: 'EURUSD' });
    expect(h.peekRedo(onEurusd)).toBeNull();
    h.dropDrawing('EURUSD');
    expect(h.peekUndo(onEurusd)).toBeNull();
    h.record(chart('b'));
    h.record({ kind: 'drawing', symbol: 'EURUSD' });
    h.clearChart();
    expect(h.undo(onEurusd)).toMatchObject({ kind: 'drawing' });
    expect(h.undo(onEurusd)).toBeNull();
  });
});
