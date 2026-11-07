import { computed, type Signal } from '@angular/core';

import { ChartDockState, type DockScriptRun } from './chart-dock-state';

/**
 * The dock state (U13 fu-ui: `ChartDockState`) for the page specs that build the page from its prototype
 * (`Object.create(ChartAnalysisPageComponent.prototype)`: class fields — the dock and its aliases — are not initialised
 * there). The real class over the spec's own `scriptRuns`, plus the page's alias names, so a spec reads and writes
 * `p.testerOpen`, `p.dockTab`, … as before.
 */
export function dockPageState<R extends DockScriptRun>(
  scriptRuns: Signal<readonly R[]>,
  init: { editorOpen?: boolean; dockPreference?: 'editor' | 'tester'; testerOpen?: boolean } = {},
) {
  const strategyRun = computed(() => scriptRuns().find((r) => r.result.kind === 'strategy') ?? null);
  const dock = new ChartDockState<R>({ scriptRuns, strategyRun });
  if (init.editorOpen !== undefined) dock.editorOpen.set(init.editorOpen);
  if (init.dockPreference !== undefined) dock.dockPreference.set(init.dockPreference);
  if (init.testerOpen !== undefined) dock.testerOpen.set(init.testerOpen);
  return {
    dock,
    strategyRun,
    testerOpen: dock.testerOpen,
    testerPrompt: dock.testerPrompt,
    testerShown: dock.testerShown,
    editorOpen: dock.editorOpen,
    dockPreference: dock.dockPreference,
    logsFront: dock.logsFront,
    logsKey: dock.logsKey,
    logsRun: dock.logsRun,
    dockTab: dock.dockTab,
    dockTabs: dock.dockTabs,
  };
}
