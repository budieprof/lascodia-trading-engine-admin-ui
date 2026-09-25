import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { hoverTooltip, showTooltip, type Tooltip } from '@codemirror/view';

import { docViewFor, type PineDocView } from '../pine/pine-docs';
import { resolvePinePath } from '../pine/pine-resolve';
import { identifierPathAt } from '../pine/pine-scan';
import { signatureHelpAt, type SignatureHelpInfo } from '../pine/pine-signature';
import { docSymbols, inCommentOrString, maskedDoc, pineContext } from './pine-context';
import { renderDocView, renderSignatureHelp } from './pine-dom';

// ── Hover ──────────────────────────────────────────────────────────────────

/** The hover document for the name under `pos`, with the range it covers. */
export function pineHoverInfo(
  state: EditorState,
  pos: number,
): { from: number; to: number; view: PineDocView } | null {
  if (inCommentOrString(state, pos)) return null;
  const text = state.doc.toString();
  const hit = identifierPathAt(text, pos);
  if (!hit) return null;
  const { index, libraries } = pineContext(state);
  const line = state.doc.lineAt(pos).number - 1;
  const after = text.slice(hit.to, hit.to + 60);
  const preferCall = /^\s*(?:<[^()]*>)?\s*\(/.test(after);
  const resolved = resolvePinePath(
    hit.path,
    { index, symbols: docSymbols(state), libraries, line },
    preferCall,
  );
  if (!resolved) return null;
  return { from: hit.wordFrom, to: hit.to, view: docViewFor(resolved, hit.path) };
}

const pineHover = hoverTooltip(
  (view, pos) => {
    const info = pineHoverInfo(view.state, pos);
    if (!info) return null;
    return {
      pos: info.from,
      end: info.to,
      above: true,
      create: () => ({ dom: renderDocView(info.view) }),
    };
  },
  { hoverTime: 350 },
);

// ── Signature help ─────────────────────────────────────────────────────────

/** Signature help for the cursor, or null outside a call. */
export function pineSignatureAt(state: EditorState, pos: number): SignatureHelpInfo | null {
  if (inCommentOrString(state, pos)) return null;
  const { index, libraries } = pineContext(state);
  const line = state.doc.lineAt(pos).number - 1;
  return signatureHelpAt(
    { index, symbols: docSymbols(state), libraries },
    maskedDoc(state),
    pos,
    line,
  );
}

function signatureTooltip(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const info = pineSignatureAt(state, sel.head);
  if (!info) return null;
  return {
    pos: sel.head,
    above: true,
    strictSide: false,
    arrow: false,
    create: () => ({ dom: renderSignatureHelp(info) }),
  };
}

/**
 * Parameter hints while typing inside a call: every overload, the active parameter highlighted.
 * Recomputed on every edit and cursor move. It sits above the line; the completion list opens
 * below it, so the two never cover each other.
 */
const signatureField = StateField.define<Tooltip | null>({
  create: (state) => signatureTooltip(state),
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.length) return tooltip;
    return signatureTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});

/** Hover docs + signature help. */
export function pineTooltips(): Extension {
  return [pineHover, signatureField];
}
