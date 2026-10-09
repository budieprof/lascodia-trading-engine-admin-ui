import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import type { ScriptSemantic } from '@core/api/scripting.types';
import { SemanticIndex, type Definition } from '../pine/pine-semantic';

/**
 * The engine's semantic model in the editor (PR-I8 / PE-I5): go to definition (F12, Ctrl/Cmd-click),
 * select every reference (Shift-F12) and rename (F2, through the host). The model describes the
 * source it was compiled from; it is used only while the editor shows exactly that text — after
 * an edit the commands wait for the next compile (the workbench compiles in the background).
 */

export interface SemanticState {
  index: SemanticIndex | null;
  /** The source the model was compiled from. */
  source: string | null;
}

export const setSemantic = StateEffect.define<SemanticState>();

export const semanticField = StateField.define<SemanticState>({
  create: () => ({ index: null, source: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSemantic)) return e.value;
    return value;
  },
});

const fresh = new WeakMap<object, boolean>();

/** The model when it describes the editor's current text, else null. */
export function currentSemantic(state: EditorState): SemanticIndex | null {
  const s = state.field(semanticField, false);
  if (!s?.index || s.source === null) return null;
  let ok = fresh.get(state.doc);
  if (ok === undefined) {
    ok = state.doc.length === s.source.length && state.doc.toString() === s.source;
    fresh.set(state.doc, ok);
  }
  return ok ? s.index : null;
}

export function semanticState(
  model: ScriptSemantic | null | undefined,
  source: string | null,
): SemanticState {
  return { index: model ? new SemanticIndex(model) : null, source: model ? source : null };
}

export interface SemanticHost {
  /** The name to rename is at `offset` (F2). */
  onRename?(offset: number, name: string): void;
  /** A definition in an imported library (read-only here). */
  onLibraryDefinition?(definition: Extract<Definition, { kind: 'library' }>): void;
  /** Nothing to act on at the cursor, said in plain words (the editor has no model for this text yet, …). */
  onNotice?(message: string): void;
}

const STALE = 'Waiting for the compile of this text — try again in a moment.';

function goToDefinition(view: EditorView, pos: number, host: SemanticHost): boolean {
  const index = currentSemantic(view.state);
  if (!index) {
    host.onNotice?.(STALE);
    return true;
  }
  const def = index.definitionAt(pos);
  if (!def) {
    host.onNotice?.(
      'No definition here: put the cursor on a name declared in this script or a library.',
    );
    return true;
  }
  if (def.kind === 'library') {
    host.onLibraryDefinition?.(def);
    return true;
  }
  view.dispatch({
    selection: EditorSelection.single(def.from, def.to),
    effects: EditorView.scrollIntoView(def.from, { y: 'center' }),
  });
  return true;
}

function selectReferences(view: EditorView, host: SemanticHost): boolean {
  const index = currentSemantic(view.state);
  if (!index) {
    host.onNotice?.(STALE);
    return true;
  }
  const at = index.referenceAt(view.state.selection.main.head);
  if (!at) {
    host.onNotice?.('No name of this script at the cursor.');
    return true;
  }
  const refs = index.referencesOf(at.symbol);
  const main = Math.max(
    0,
    refs.findIndex((r) => r.from === at.from),
  );
  view.dispatch({
    selection: EditorSelection.create(
      refs.map((r) => EditorSelection.range(r.from, r.to)),
      main,
    ),
  });
  host.onNotice?.(
    `${refs.length} reference${refs.length === 1 ? '' : 's'} of '${at.symbol.name}' selected.`,
  );
  return true;
}

function rename(view: EditorView, host: SemanticHost): boolean {
  if (view.state.readOnly) return false;
  const index = currentSemantic(view.state);
  if (!index) {
    host.onNotice?.(STALE);
    return true;
  }
  const at = index.referenceAt(view.state.selection.main.head);
  if (!at) {
    host.onNotice?.('No name of this script at the cursor to rename.');
    return true;
  }
  host.onRename?.(at.from, at.symbol.name);
  return true;
}

export function pineSemantic(host: SemanticHost): Extension {
  return [
    semanticField,
    keymap.of([
      { key: 'F12', run: (v) => goToDefinition(v, v.state.selection.main.head, host) },
      { key: 'Shift-F12', run: (v) => selectReferences(v, host) },
      { key: 'F2', run: (v) => rename(v, host) },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null || !currentSemantic(view.state)?.referenceAt(pos)) return false;
        event.preventDefault();
        return goToDefinition(view, pos, host);
      },
    }),
  ];
}
