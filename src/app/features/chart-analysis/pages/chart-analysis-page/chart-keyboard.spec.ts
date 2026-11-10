import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { ChartKeyboard } from './chart-keyboard';

// The chart page's keyboard shortcuts — b10-ui: ChartKeyboard, built over just the page members it reads (these cases
// were in chart-analysis-page.dock.spec, driving the page's onKeydown on a prototype-built page).

function keyed(over: Record<string, unknown> = {}) {
  const page = {
    dockTab: signal<string | null>(null),
    setDockMode: vi.fn(),
    replayActive: signal(false),
    replay: { step: vi.fn(), togglePlay: vi.fn() },
    paletteOpen: signal(false),
    technicalsOpen: signal(false),
    seasonalsOpen: signal(false),
    tool: signal<string | null>(null),
    magnet: signal(false),
    magnetMenuOpen: signal(false),
    railFlyout: signal<string | null>(null),
    drawingMenu: signal<unknown>(null),
    openMenu: signal<string | null>(null),
    layoutMenuOpen: signal(false),
    symbolMenuOpen: signal(false),
    invertScale: signal(false),
    scaleMode: signal('normal'),
    resetScales: vi.fn(),
    openStudiesDialog: vi.fn(),
    layoutActions: { takeSnapshot: vi.fn() },
    chartUndo: { undo: vi.fn(), redo: vi.fn() },
    drawings: {
      selectedId: signal<string | null>('drawing:1'),
      selectedIds: () => new Set(['drawing:1']),
      removeSelectedUnlocked: vi.fn(),
      remove: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      copy: vi.fn(),
      hasClipboard: false,
    },
    ...over,
  };
  const openIntervalBox = vi.fn();
  const kb = new ChartKeyboard({ page: page as never, host: () => undefined, openIntervalBox });
  return { kb, p: page, openIntervalBox };
}
const key = (k: string, target: Partial<HTMLElement>, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });
  Object.defineProperty(ev, 'target', { value: target });
  return ev;
};
// jsdom implements no isContentEditable, so the editor's content is described, not rendered.
const editor = { tagName: 'DIV', isContentEditable: true };
const chart = { tagName: 'DIV', isContentEditable: false };

describe('chart page — keyboard shortcuts leave the Pine editor’s typing alone', () => {
  it('typing "m" in the editor does not toggle the magnet; on the chart it does', () => {
    const { kb, p } = keyed();
    kb.onKeydown(key('m', editor));
    expect(p.magnet()).toBe(false);
    kb.onKeydown(key('m', chart));
    expect(p.magnet()).toBe(true);
  });

  it('Backspace in the editor does not delete the selected drawing', () => {
    const { kb, p } = keyed();
    const ev = key('Backspace', editor);
    kb.onKeydown(ev);
    expect(p.drawings.removeSelectedUnlocked).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Ctrl+Shift+K on the chart opens its command palette — not the console’s (CC-I11)', () => {
    const { kb, p } = keyed();
    const ev = key('K', chart, { ctrlKey: true, shiftKey: true });
    const stop = vi.spyOn(ev, 'stopPropagation');
    kb.onKeydown(ev);
    expect(p.paletteOpen()).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('TradingView’s Alt keys drive the scale; "/" opens the indicators (CC-I11)', () => {
    const { kb, p } = keyed();
    kb.onKeydown(key('®', chart, { altKey: true, code: 'KeyR' }));
    expect(p.resetScales).toHaveBeenCalled();
    kb.onKeydown(key('ˆ', chart, { altKey: true, code: 'KeyI' }));
    expect(p.invertScale()).toBe(true);
    kb.onKeydown(key('¬', chart, { altKey: true, code: 'KeyL' }));
    expect(p.scaleMode()).toBe('log');
    kb.onKeydown(key('¬', chart, { altKey: true, code: 'KeyL' }));
    expect(p.scaleMode()).toBe('normal');
    kb.onKeydown(key('/', chart));
    expect(p.openStudiesDialog).toHaveBeenCalled();
    // Typing "/" in the editor stays text.
    kb.onKeydown(key('/', editor));
    expect(p.openStudiesDialog).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z in the editor undoes text, not a drawing', () => {
    const { kb, p } = keyed();
    kb.onKeydown(key('z', editor, { ctrlKey: true }));
    expect(p.drawings.undo).not.toHaveBeenCalled();
    expect(p.chartUndo.undo).not.toHaveBeenCalled();
  });
});

describe('chart page — keyboard shortcuts on the chart', () => {
  it('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y go to the one undo history', () => {
    const { kb, p } = keyed();
    kb.onKeydown(key('z', chart, { ctrlKey: true }));
    expect(p.chartUndo.undo).toHaveBeenCalledTimes(1);
    kb.onKeydown(key('z', chart, { ctrlKey: true, shiftKey: true }));
    kb.onKeydown(key('y', chart, { metaKey: true }));
    expect(p.chartUndo.redo).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+Shift+M maximises an open dock — even while typing in the editor', () => {
    const { kb, p } = keyed({ dockTab: signal('editor') });
    const ev = key('M', editor, { ctrlKey: true, shiftKey: true });
    kb.onKeydown(ev);
    expect(p.setDockMode).toHaveBeenCalledWith('max');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Esc closes an open toolbar menu first, then drops the tool and the selection', () => {
    const { kb, p } = keyed({ openMenu: signal('interval'), tool: signal('trendline') });
    const first = key('Escape', chart);
    kb.onKeydown(first);
    expect(p.openMenu()).toBeNull();
    expect(p.tool()).toBe('trendline');
    expect(first.defaultPrevented).toBe(true);
    kb.onKeydown(key('Escape', chart));
    expect(p.tool()).toBeNull();
    expect(p.drawings.selectedId()).toBeNull();
  });

  it('Delete removes the selected unlocked drawings; a digit opens the interval box', () => {
    const { kb, p, openIntervalBox } = keyed();
    kb.onKeydown(key('Delete', chart));
    expect(p.drawings.removeSelectedUnlocked).toHaveBeenCalled();
    kb.onKeydown(key('4', chart));
    expect(openIntervalBox).toHaveBeenCalledWith('4');
  });

  it('with Bar Replay on, Shift+arrows step and Shift+↓ plays', () => {
    const { kb, p } = keyed({ replayActive: signal(true) });
    kb.onKeydown(key('ArrowRight', chart, { shiftKey: true }));
    kb.onKeydown(key('ArrowLeft', chart, { shiftKey: true }));
    kb.onKeydown(key('ArrowDown', chart, { shiftKey: true }));
    expect(p.replay.step).toHaveBeenNthCalledWith(1, 1);
    expect(p.replay.step).toHaveBeenNthCalledWith(2, -1);
    expect(p.replay.togglePlay).toHaveBeenCalled();
  });

  it('the Technicals view swallows chart keys; Esc returns to the chart', () => {
    const { kb, p } = keyed({ technicalsOpen: signal(true) });
    kb.onKeydown(key('m', chart));
    expect(p.magnet()).toBe(false);
    kb.onKeydown(key('Escape', chart));
    expect(p.technicalsOpen()).toBe(false);
  });
});
