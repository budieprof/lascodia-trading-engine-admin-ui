import { EditorState, StateEffect, StateField, type Text } from '@codemirror/state';

import type { PineCatalog, ScriptLibraryDto } from '@core/api/scripting.types';
import { PineCatalogIndex } from '../pine/pine-catalog-index';
import {
  EMPTY_SYMBOLS,
  isInCommentOrString,
  lexicalRanges,
  maskCommentsAndStrings,
  scanPineSymbols,
  type LexicalRange,
  type PineDocSymbols,
} from '../pine/pine-scan';
import {
  FALLBACK_CONSTANTS,
  FALLBACK_FUNCTIONS,
  FALLBACK_VARIABLES,
} from './pine-builtins-fallback';

/**
 * What the editor's intelligence (completion, signature help, hover, highlighting) knows beyond
 * the document: the language catalog and the libraries an `import` can name.
 */
export interface PineEditorContext {
  index: PineCatalogIndex;
  libraries: readonly ScriptLibraryDto[];
}

let fallbackIndex: PineCatalogIndex | null = null;

/** The offline index built from the bundled v6 names — until (or unless) the catalog loads. */
export function fallbackCatalogIndex(): PineCatalogIndex {
  fallbackIndex ??= PineCatalogIndex.fromNames(
    FALLBACK_FUNCTIONS,
    FALLBACK_VARIABLES,
    FALLBACK_CONSTANTS,
  );
  return fallbackIndex;
}

export function indexForCatalog(catalog: PineCatalog | null): PineCatalogIndex {
  return catalog ? PineCatalogIndex.fromCatalog(catalog) : fallbackCatalogIndex();
}

export const setPineContext = StateEffect.define<Partial<PineEditorContext>>();

export const pineContextField = StateField.define<PineEditorContext>({
  create: () => ({ index: fallbackCatalogIndex(), libraries: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPineContext)) value = { ...value, ...e.value };
    return value;
  },
});

export function pineContext(state: EditorState): PineEditorContext {
  return state.field(pineContextField, false) ?? { index: fallbackCatalogIndex(), libraries: [] };
}

// Documents are immutable, so every derived view of one is cached per document instance.
interface DocAnalysis {
  text: string;
  ranges: LexicalRange[];
  masked?: string;
  symbols?: PineDocSymbols;
}
const analyses = new WeakMap<Text, DocAnalysis>();

function analysis(state: EditorState): DocAnalysis {
  let a = analyses.get(state.doc);
  if (!a) {
    const text = state.doc.toString();
    a = { text, ranges: lexicalRanges(text) };
    analyses.set(state.doc, a);
  }
  return a;
}

/** The user's declarations in the current document. */
export function docSymbols(state: EditorState): PineDocSymbols {
  const a = analysis(state);
  if (!a.symbols) {
    try {
      a.symbols = scanPineSymbols(a.text);
    } catch {
      a.symbols = EMPTY_SYMBOLS;
    }
  }
  return a.symbols;
}

/** The document with comments and string contents blanked. */
export function maskedDoc(state: EditorState): string {
  const a = analysis(state);
  a.masked ??= maskCommentsAndStrings(a.text, a.ranges);
  return a.masked;
}

/** True when a cursor at `pos` is inside a comment or a string literal. */
export function inCommentOrString(state: EditorState, pos: number): boolean {
  return isInCommentOrString(analysis(state).ranges, pos);
}
