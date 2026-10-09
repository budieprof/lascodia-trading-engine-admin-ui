import { describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';

import { ChartAnalysisPageComponent, type ChartScriptRun } from './chart-analysis-page.component';

// The page's own methods, run against just the state they touch (as chart-analysis-page.editor.spec
// does): the component's prototype with the dock's signals, derived as the page derives them.

const strategy = { item: { key: 'mine:7' }, result: { kind: 'strategy', title: 'MA Cross' } };

type Page = ChartAnalysisPageComponent & Record<string, any>;

function page(runs: unknown[] = []): Page {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  const scriptRuns = signal(runs as ChartScriptRun[]);
  const strategyRun = computed(
    () => scriptRuns().find((r) => r.result.kind === 'strategy') ?? null,
  );
  const testerOpen = signal(true);
  const testerPrompt = signal(false);
  const editorOpen = signal(false);
  const dockPreference = signal<'editor' | 'tester'>('tester');
  const testerShown = computed(() => testerOpen() && (!!strategyRun() || testerPrompt()));
  const logsFront = signal(false);
  const logsKey = signal<string | null>(null);
  const logsRun = computed(() => scriptRuns().find((r) => r.item.key === logsKey()) ?? null);
  Object.assign(p, {
    scriptRuns,
    strategyRun,
    testerOpen,
    testerPrompt,
    testerShown,
    editorOpen,
    dockPreference,
    logsFront,
    logsKey,
    logsRun,
    dockTab: computed(() => {
      const editor = editorOpen();
      const tester = testerShown();
      if (logsRun() && (logsFront() || (!editor && !tester))) return 'logs';
      if (editor && tester) return dockPreference();
      return editor ? 'editor' : tester ? 'tester' : null;
    }),
  });
  return p;
}

describe('chart page — the Strategy Tester tab with no strategy on the chart', () => {
  it('stays closed until the operator opens it: no empty dock on load', () => {
    const p = page();
    expect(p.testerOpen()).toBe(true); // the default that auto-shows a strategy's report
    expect(p.dockTab()).toBeNull();
  });

  it('opens on how to add a strategy, and the tab closes it again', () => {
    const p = page();

    p.toggleTester();
    expect(p.dockTab()).toBe('tester');
    expect(p.testerPrompt()).toBe(true);
    expect(p.strategyRun()).toBeNull(); // so the panel is the empty state, not a report

    p.toggleTester();
    expect(p.dockTab()).toBeNull();
    expect(p.testerPrompt()).toBe(false);
  });

  it('its close button closes it', () => {
    const p = page();
    p.toggleTester();
    p.closeTester();
    expect(p.dockTab()).toBeNull();
    expect(p.testerPrompt()).toBe(false);
  });

  it('a strategy added while it is open shows its report in place', () => {
    const p = page();
    p.toggleTester();
    p.scriptRuns.set([strategy as unknown as ChartScriptRun]);
    expect(p.dockTab()).toBe('tester');
    expect(p.strategyRun()).not.toBeNull();
  });

  it('beside an open editor it is a dock tab like the report', () => {
    const p = page();
    p.editorOpen.set(true);
    p.dockPreference.set('editor');

    p.toggleTester();
    expect(p.dockTab()).toBe('tester');
    expect(p.editorOpen() && p.testerShown()).toBe(true); // the dock's own tab strip shows

    p.toggleTester();
    expect(p.dockTab()).toBe('editor');
  });
});

describe('chart page — the Strategy Tester tab with a strategy on the chart (unchanged)', () => {
  it('toggles the report', () => {
    const p = page([strategy]);
    expect(p.dockTab()).toBe('tester');
    p.toggleTester();
    expect(p.dockTab()).toBeNull();
    p.toggleTester();
    expect(p.dockTab()).toBe('tester');
    expect(p.testerPrompt()).toBe(false);
  });

  it('closes when its strategy is removed, as before', () => {
    const p = page([strategy]);
    p.toggleTester();
    p.toggleTester(); // closed, then opened again with the strategy on the chart
    expect(p.dockTab()).toBe('tester');
    p.scriptRuns.set([]);
    expect(p.dockTab()).toBeNull();
  });

  it('the report’s close button also forgets an earlier empty-state open', () => {
    const p = page();
    p.toggleTester();
    p.scriptRuns.set([strategy as unknown as ChartScriptRun]);
    p.closeTester();
    p.testerOpen.set(true); // e.g. a later strategy auto-opens the tester
    p.scriptRuns.set([]);
    expect(p.dockTab()).toBeNull();
  });
});

describe('chart page — Pine Logs in the dock (PC-I6)', () => {
  const indicator = { item: { key: 'mine:9' }, result: { kind: 'indicator', title: 'RSI' } };

  it('opens in front of the tester, and either comes forward again from its tab', () => {
    const p = page([strategy, indicator]);
    expect(p.dockTab()).toBe('tester');
    p.openLogs('mine:9');
    expect(p.dockTab()).toBe('logs');
    // The tester brought up — its button or its tab.
    p.showDock('tester');
    expect(p.dockTab()).toBe('tester');
    p.showDock('logs');
    expect(p.dockTab()).toBe('logs');
    p.toggleTester(); // the bottom bar's Strategy Tester: the tester is not in front, so it comes
    expect(p.dockTab()).toBe('tester');
  });

  it('is the dock on its own when nothing else is open, and closes with its script', () => {
    const p = page([indicator]);
    p.openLogs('mine:9');
    expect(p.dockTab()).toBe('logs');
    p.logsFront.set(false);
    expect(p.dockTab()).toBe('logs');
    p.scriptRuns.set([]);
    expect(p.dockTab()).toBeNull();
  });

  it('its close button closes it; the tester behind it shows again', () => {
    const p = page([strategy, indicator]);
    p.openLogs('mine:9');
    p.closeLogs();
    expect(p.logsKey()).toBeNull();
    expect(p.dockTab()).toBe('tester');
  });
});

describe('chart page — keyboard shortcuts leave the Pine editor’s typing alone', () => {
  function keyed(): Page {
    const p = page();
    Object.assign(p, {
      technicalsOpen: signal(false),
      seasonalsOpen: signal(false),
      tool: signal(null),
      magnet: signal(false),
      host: () => null,
      drawings: {
        selectedId: signal<string | null>('drawing:1'),
        remove: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        copy: vi.fn(),
        hasClipboard: false,
      },
    });
    return p;
  }
  const key = (k: string, target: Partial<HTMLElement>, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });
    Object.defineProperty(ev, 'target', { value: target });
    return ev;
  };
  // jsdom implements no isContentEditable, so the editor's content is described, not rendered.
  const editor = { tagName: 'DIV', isContentEditable: true };
  const chart = { tagName: 'DIV', isContentEditable: false };

  it('typing "m" in the editor does not toggle the magnet; on the chart it does', () => {
    const p = keyed();
    p.onKeydown(key('m', editor));
    expect(p.magnet()).toBe(false);
    p.onKeydown(key('m', chart));
    expect(p.magnet()).toBe(true);
  });

  it('Backspace in the editor does not delete the selected drawing', () => {
    const p = keyed();
    const ev = key('Backspace', editor);
    p.onKeydown(ev);
    expect(p.drawings.remove).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Ctrl+Z in the editor undoes text, not a drawing', () => {
    const p = keyed();
    p.onKeydown(key('z', editor, { ctrlKey: true }));
    expect(p.drawings.undo).not.toHaveBeenCalled();
  });
});
