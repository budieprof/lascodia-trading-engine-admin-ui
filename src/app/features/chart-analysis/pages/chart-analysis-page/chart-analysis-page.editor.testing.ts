import type { Signal } from '@angular/core';

import {
  ChartEditorState,
  type ChartEditorStateDeps,
  type EditorScriptItem,
  type EditorScriptRun,
} from './chart-editor-state';

/**
 * The Pine Editor state (U13 fu-ui: `ChartEditorState`) for the page specs that build the page from its prototype
 * (`Object.create(ChartAnalysisPageComponent.prototype)`: class fields — the editor state and its aliases — are not
 * initialised there). The real class over the spec's own runs, pending scripts and dock, plus the page's alias names, so
 * a spec reads and writes `p.editorKey`, `p['editorDraft']`, … as before. Engine strategy sources are never fetched
 * unless the spec says how.
 */
export function editorPageState<I extends EditorScriptItem, R extends EditorScriptRun<I>>(
  scriptRuns: Signal<readonly R[]>,
  pendingScripts: Signal<ReadonlyMap<string, { item: I }>>,
  dock: ChartEditorStateDeps<I, R>['dock'],
  fetchStrategySource: ChartEditorStateDeps<I, R>['fetchStrategySource'] = () => undefined,
) {
  const editor = new ChartEditorState<I, R>({ scriptRuns, pendingScripts, dock, fetchStrategySource });
  return {
    editor,
    editorKey: editor.editorKey,
    editorTarget: editor.editorTarget,
    strategySources: editor.strategySources,
    editorCleared: editor.editorCleared,
    editorDraft: editor.editorDraft,
    assistSource: editor.assistSource,
  };
}
