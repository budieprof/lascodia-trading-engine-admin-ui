import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';

import type {
  PineCatalog,
  ScriptDiagnostic,
  ScriptDiagnosticFix,
  ScriptLibraryDto,
} from '@core/api/scripting.types';
import type { PineCatalogIndex } from '../pine/pine-catalog-index';
import {
  fixRange,
  shiftedFix,
  toEditorDiagnostics,
  type EditorDiagnostic,
} from '../pine/pine-diagnostics';
import { pineColorSwatches } from './pine-colors';
import { pineCompletionSource } from './pine-complete';
import { indexForCatalog, pineContextField, setPineContext } from './pine-context';
import { pineLanguageSupport, type PineTokenizerNames } from './pine-language';
import { pineTheme } from './pine-theme';
import { pineTooltips } from './pine-tooltips';

/**
 * The CodeMirror 6 Pine editor. This module (and everything it imports) is loaded on demand by
 * `PineEditorComponent`, so CodeMirror never lands in a bundle until an editor is on screen.
 */

export interface PineEditorOptions {
  doc: string;
  readOnly: boolean;
  dark: boolean;
  catalog: PineCatalog | null;
  libraries: readonly ScriptLibraryDto[];
  ariaLabel?: string;
  /** Shown while the document is empty. */
  placeholder?: string;
  onChange(doc: string): void;
  /** 1-based line and column of the main cursor. */
  onCursor(line: number, column: number): void;
  /** Mod-S inside the editor. */
  onSave?(): void;
}

export interface PineEditorHandle {
  readonly view: EditorView;
  getValue(): string;
  /** Replaces the document. External loads stay out of the undo history by default. */
  setValue(doc: string, addToHistory?: boolean): void;
  setReadOnly(readOnly: boolean): void;
  setDark(dark: boolean): void;
  setCatalog(catalog: PineCatalog | null): void;
  setLibraries(libraries: readonly ScriptLibraryDto[]): void;
  /** Shows the engine's diagnostics as lint markers (1-based line/column), quick fixes as their actions. */
  setDiagnostics(diagnostics: readonly ScriptDiagnostic[]): void;
  /** Applies a quick fix (1-based line/column range) as one edit the operator can undo. */
  applyFix(fix: ScriptDiagnosticFix): void;
  /** Moves the cursor to a 1-based line/column, scrolls it into view and focuses. */
  revealPosition(line: number, column: number): void;
  focus(): void;
  destroy(): void;
}

function tokenizerNames(index: PineCatalogIndex): PineTokenizerNames {
  return {
    functions: new Set(index.functions.keys()),
    variables: new Set(index.variables.keys()),
    constants: new Set(index.constants.keys()),
    namespaces: index.namespaces,
  };
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * A mapped diagnostic as a CodeMirror lint marker: each engine quick fix becomes one of its actions,
 * applied as a single undoable edit (and never on a read-only editor). `doc` is the document the
 * diagnostics were mapped onto.
 */
export function lintDiagnostic(d: EditorDiagnostic, doc?: unknown): Diagnostic {
  return {
    from: d.from,
    to: d.to,
    severity: d.severity,
    message: d.message,
    source: d.source,
    ...(d.fixes.length > 0
      ? {
          actions: d.fixes.map((fix) => ({
            name: fix.title,
            apply: (view: EditorView, from: number, to: number) => {
              if (view.state.readOnly) return;
              const range = shiftedFix(
                d,
                fix,
                from,
                to,
                doc === undefined || view.state.doc === doc,
              );
              if (!range) return;
              const end = view.state.doc.length;
              view.dispatch({
                changes: {
                  from: Math.min(range.from, end),
                  to: Math.min(range.to, end),
                  insert: fix.insert,
                },
                userEvent: 'input.quickfix',
              });
            },
          })),
        }
      : {}),
  };
}

export function createPineEditor(parent: HTMLElement, opts: PineEditorOptions): PineEditorHandle {
  const languageSlot = new Compartment();
  const themeSlot = new Compartment();
  const readOnlySlot = new Compartment();
  let index = indexForCatalog(opts.catalog);

  const extensions: Extension[] = [
    lineNumbers(),
    foldGutter(),
    lintGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({
      override: [pineCompletionSource],
      icons: true,
      activateOnTyping: true,
      maxRenderedOptions: 150,
    }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (opts.onSave?.(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    languageSlot.of(pineLanguageSupport(tokenizerNames(index))),
    themeSlot.of(pineTheme(opts.dark)),
    readOnlySlot.of(readOnlyExtension(opts.readOnly)),
    pineContextField.init(() => ({ index, libraries: opts.libraries })),
    pineTooltips(),
    pineColorSwatches,
    EditorView.contentAttributes.of({ 'aria-label': opts.ariaLabel ?? 'Pine Script editor' }),
    // A little air below the cursor when typing on the last visible lines.
    EditorView.scrollMargins.of(() => ({ bottom: 24 })),
    ...(opts.placeholder ? [placeholder(opts.placeholder)] : []),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
      if (u.docChanged || u.selectionSet) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        opts.onCursor(line.number, head - line.from + 1);
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions }),
    parent,
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(doc, addToHistory = false) {
      if (doc === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        annotations: Transaction.addToHistory.of(addToHistory),
      });
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: readOnlySlot.reconfigure(readOnlyExtension(readOnly)) });
    },
    setDark(dark) {
      view.dispatch({ effects: themeSlot.reconfigure(pineTheme(dark)) });
    },
    setCatalog(catalog) {
      index = indexForCatalog(catalog);
      view.dispatch({
        effects: [
          languageSlot.reconfigure(pineLanguageSupport(tokenizerNames(index))),
          setPineContext.of({ index }),
        ],
      });
    },
    setLibraries(libraries) {
      view.dispatch({ effects: setPineContext.of({ libraries }) });
    },
    setDiagnostics(diagnostics) {
      const doc = view.state.doc;
      const markers = toEditorDiagnostics(doc, diagnostics).map((d) => lintDiagnostic(d, doc));
      view.dispatch(setDiagnostics(view.state, markers));
    },
    applyFix(fix) {
      if (view.state.readOnly) return;
      const range = fixRange(view.state.doc, fix);
      if (!range) return;
      view.dispatch({
        changes: { ...range, insert: fix.replacement },
        selection: { anchor: range.from + fix.replacement.length },
        userEvent: 'input.quickfix',
        effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
      });
      view.focus();
    },
    revealPosition(line, column) {
      const doc = view.state.doc;
      const l = doc.line(Math.max(1, Math.min(doc.lines, Math.trunc(line) || 1)));
      const pos = l.from + Math.max(0, Math.min(l.length, (Math.trunc(column) || 1) - 1));
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
