import { describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';
import { of } from 'rxjs';

import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ChartScriptItem } from '../../scripts/chart-script.service';
import { ScriptSettings } from '../../scripts/script-settings';
import { dockStateOf, restoredDock } from '../../workspace/workspace-state';
import { ChartAnalysisPageComponent, type ChartScriptRun } from './chart-analysis-page.component';

// The page's own methods, run against just the state they touch: the component's prototype with
// the editor's, the runs' and the settings' signals — no template, no chart, no engine. runScript
// is a spy: what matters here is what the editor shows and which script runs with which inputs.

const item = (key: string, pineSource = `// ${key}`): ChartScriptItem => ({
  key,
  source: 'mine',
  name: key,
  description: '',
  kind: 'indicator',
  pineSource,
});
const run = (it: ChartScriptItem, values: ScriptInputValues = {}): ChartScriptRun =>
  ({
    item: it,
    result: { title: it.name, kind: 'indicator', inputs: [] },
    values,
    symbol: 'EURUSD',
    resolution: '60',
    requestedBars: 1500,
  }) as unknown as ChartScriptRun;

type Page = ChartAnalysisPageComponent & Record<string, any>;

function page(runs: ChartScriptRun[]): Page {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  const scriptRuns = signal(runs);
  const editorKey = signal<string | null>(null);
  const editorOpen = signal(false);
  Object.assign(p, {
    scriptRuns,
    restoringScripts: signal([]),
    runsInFlight: new Map(),
    runningKeys: signal(new Map()),
    runScheduler: { cancel: vi.fn() },
    editorOpen,
    editorKey,
    editorDraft: signal(null),
    assistSource: signal(null),
    dockPreference: signal('tester'),
    testerOpen: signal(true),
    testerPrompt: signal(false),
    assistSeq: 0,
    strategySources: signal({}),
    editorCleared: signal(false),
    runScript: vi.fn(),
    chartScripts: {
      itemForSource: (source: string, kind: 'indicator' | 'strategy', name: string) => ({
        key: 'editor:current',
        source: 'mine',
        name,
        description: '',
        kind,
        pineSource: source,
      }),
    },
    // As the page derives them.
    editorTarget: computed(() => {
      const r = scriptRuns().find((x) => x.item.key === editorKey());
      return r
        ? {
            key: r.item.key,
            name: r.result.title || r.item.name,
            source: r.item.pineSource ?? null,
          }
        : null;
    }),
    dockTab: computed(() => (editorOpen() ? 'editor' : null)),
  });
  Object.assign(p, {
    settings: new ScriptSettings(scriptRuns, {
      run: vi.fn(),
      storedInputs: () => of({}),
      saveDefault: () => of(),
      notify: vi.fn(),
    }),
  });
  return p;
}

/** The editor showing a script, with unsaved edits and text the assistant wrote. */
function editing(p: Page, key: string, open = true): void {
  p.openScriptSource(key);
  p['editorDraft'].set({ key, text: 'edited, not saved' });
  p['assistSource'].set({ text: 'from the assistant', seq: 3 });
  if (!open) p.editorOpen.set(false);
}

describe('chart page — removing a Pine script from the chart clears the editor showing it', () => {
  it('removing the script the editor shows clears and closes the editor', () => {
    const p = page([run(item('mine:20')), run(item('mine:5'))]);
    editing(p, 'mine:20');
    expect(p.editorOpen()).toBe(true);

    p.removeScriptFromChart('mine:20');

    expect(p.scriptRuns().map((r) => r.item.key)).toEqual(['mine:5']);
    expect(p.editorOpen()).toBe(false);
    expect(p.editorKey()).toBeNull();
    expect(p['editorDraft']()).toBeNull();
    expect(p.assistSource()).toBeNull();
    // What the layout saves of the dock reads these: closed, unlinked, no buffer.
    expect(p.editorTarget()).toBeNull();
  });

  it('removing another script leaves the editor exactly as it is', () => {
    const p = page([run(item('mine:20')), run(item('mine:5'))]);
    editing(p, 'mine:20');
    const draft = p['editorDraft']();
    const assist = p.assistSource();

    p.removeScriptFromChart('mine:5');

    expect(p.editorOpen()).toBe(true);
    expect(p.editorKey()).toBe('mine:20');
    expect(p['editorDraft']()).toBe(draft);
    expect(p.assistSource()).toBe(assist);
  });

  it('a closed editor still linked to the removed script reopens blank, on the starter template', () => {
    const p = page([run(item('mine:20')), run(item('mine:5'))]);
    editing(p, 'mine:20', false);

    p.removeScriptFromChart('mine:20');
    expect(p.editorOpen()).toBe(false);
    p.toggleEditor(); // the toolbar's Pine Editor

    expect(p.editorOpen()).toBe(true);
    // Nothing to load into the new panel — not the removed code, not another script on the chart.
    expect(p.editorKey()).toBeNull();
    expect(p.editorTarget()).toBeNull();
    expect(p.assistSource()).toBeNull();
    expect(p['editorDraft']()).toBeNull();

    // Pointed at a script again, the editor shows it as before.
    p.openScriptSource('mine:5');
    expect(p.editorTarget()?.source).toBe('// mine:5');
  });

  it('an editor never linked still opens on the chart’s newest script', () => {
    const p = page([run(item('mine:20')), run(item('mine:5'))]);
    p.toggleEditor();
    expect(p.editorKey()).toBe('mine:5');
  });

  it('closes the removed script’s Settings too', () => {
    const p = page([run(item('mine:20'))]);
    p['settings'].open('mine:20');
    expect(p['settings'].run()).not.toBeNull();
    p.removeScriptFromChart('mine:20');
    expect(p['settings'].run()).toBeNull();
  });

  it('"Update on chart" still keeps the editor open, on the edited copy, with the inputs', () => {
    const v2 = item('mine:20');
    const p = page([run(v2, { 'Display::Colour candles': false }), run(item('mine:5'))]);
    editing(p, 'mine:20');

    p.onEditorAdd({ source: '// v2 edited', kind: 'indicator', name: 'v2' });

    expect(p.editorOpen()).toBe(true);
    expect(p.editorKey()).toBe('editor:current');
    expect(p.scriptRuns().map((r) => r.item.key)).toEqual(['mine:5']);
    expect(p['runScript']).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'editor:current', pineSource: '// v2 edited' }),
      { 'Display::Colour candles': false },
    );
  });

  it('the assistant’s run (runDraft) is unaffected: the editor stays open on the new copy', () => {
    const p = page([run(item('mine:20'), { 'Signals::Sensitivity': 2 })]);
    editing(p, 'mine:20');
    const done = vi.fn();

    p['runDraftOnChart']('// from the assistant', done);

    expect(p.editorOpen()).toBe(true);
    expect(p.editorKey()).toBe('editor:current');
    expect(p['editorDraft']()).toEqual({ key: 'editor:current', text: '// from the assistant' });
    expect(p['runScript']).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'editor:current' }),
      { 'Signals::Sensitivity': 2 },
      false,
      done,
    );
  });

  it('stays cleared through a reload: the layout saves it, and the reopened editor is blank', () => {
    const before = page([run(item('mine:20')), run(item('mine:5'))]);
    editing(before, 'mine:20');
    before.removeScriptFromChart('mine:20');
    // What the engine stores with the layout, and a reload reads back.
    const saved = JSON.parse(JSON.stringify(dockStateOf(before['dockView']())));
    expect(saved.editorCleared).toBe(true);

    // The reload: the layout's scripts are back on the chart, then its dock is applied.
    const after = page([run(item('mine:5'))]);
    after['applyDock'](restoredDock(saved));
    after.toggleEditor();
    expect(after.editorOpen()).toBe(true);
    expect(after.editorKey()).toBeNull(); // the starter template — not mine:5
    expect(after.editorTarget()).toBeNull();

    // Pointed at a script again, it is linked — and the next save no longer says cleared.
    after.openScriptSource('mine:5');
    expect(after.editorTarget()?.source).toBe('// mine:5');
    expect(dockStateOf(after['dockView']())).not.toHaveProperty('editorCleared');
  });

  it('a layout saved before the flag existed opens the editor on the chart’s newest script, as before', () => {
    const p = page([run(item('mine:20')), run(item('mine:5'))]);
    p['applyDock'](
      restoredDock({ editorOpen: false, testerOpen: true, preference: 'tester', editorKey: null }),
    );
    p.toggleEditor();
    expect(p.editorKey()).toBe('mine:5');
  });

  it('a script added from the cleared editor links it again, so the layout no longer clears it', () => {
    const p = page([run(item('mine:20'))]);
    editing(p, 'mine:20');
    p.removeScriptFromChart('mine:20');
    p.toggleEditor(); // the starter template
    p.onEditorAdd({ source: '// new', kind: 'indicator', name: 'New' });
    expect(p.editorKey()).toBe('editor:current');
    expect(dockStateOf(p['dockView']())).not.toHaveProperty('editorCleared');
  });
});
