import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';

import { ChartAnalysisPageComponent, type ChartScriptRun } from './chart-analysis-page.component';
import { dockPageState } from './chart-analysis-page.dock.testing';

// The page's own methods, run against just the state they touch (as chart-analysis-page.editor.spec
// does): the component's prototype with the dock's signals, derived as the page derives them.

const strategy = { item: { key: 'mine:7' }, result: { kind: 'strategy', title: 'MA Cross' } };

type Page = ChartAnalysisPageComponent & Record<string, any>;

function page(runs: unknown[] = []): Page {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  const scriptRuns = signal(runs as ChartScriptRun[]);
  // U13 (fu-ui): the dock is ChartDockState — the real class, where this spec used to re-derive dockTab.
  Object.assign(p, { scriptRuns, ...dockPageState(scriptRuns) });
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

// The keyboard shortcuts (CC-I11, the editor's typing left alone) are ChartKeyboard's — chart-keyboard.spec (b10-ui).
