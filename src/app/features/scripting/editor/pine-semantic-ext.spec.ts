import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';

import type { ScriptSemantic } from '@core/api/scripting.types';
import { pineContextField } from './pine-context';
import { currentSemantic, semanticField, semanticState, setSemantic } from './pine-semantic-ext';
import { pineHoverInfo } from './pine-tooltips';

const SOURCE = '//@version=6\nindicator("x")\nlen = input.int(14)\nplot(ta.sma(close, len))\n';
const at = (text: string, n = 1) => {
  let i = -1;
  for (let k = 0; k < n; k++) i = SOURCE.indexOf(text, i + 1);
  return i;
};
const MODEL: ScriptSemantic = {
  symbols: [
    {
      id: 0,
      name: 'len',
      kind: 'variable',
      declaration: { line: 3, column: 1, endLine: 3, endColumn: 4, offset: at('len'), length: 3 },
      type: 'input int',
      exported: false,
    },
  ],
  references: [
    [0, at('len'), 3, 0],
    [0, at('len', 2), 3, 1],
  ],
  outline: [],
};

function stateWith(doc: string, model: ScriptSemantic | null, source: string | null): EditorState {
  const s = EditorState.create({ doc, extensions: [semanticField, pineContextField] });
  return s.update({ effects: setSemantic.of(semanticState(model, source)) }).state;
}

describe('the semantic model in the editor (PR-I8)', () => {
  it('is used only while the editor shows the source it was compiled from', () => {
    expect(currentSemantic(stateWith(SOURCE, MODEL, SOURCE))).not.toBeNull();
    expect(currentSemantic(stateWith(SOURCE + ' ', MODEL, SOURCE))).toBeNull();
    expect(currentSemantic(stateWith(SOURCE, null, SOURCE))).toBeNull();
  });

  it('hovers a script name with its type and declaration line', () => {
    const info = pineHoverInfo(stateWith(SOURCE, MODEL, SOURCE), at('len', 2) + 1);
    expect(info?.view.kind).toBe('variable');
    expect(info?.view.code).toEqual(['input int len']);
    expect(info?.view.notes).toEqual(['Declared on line 3.']);
    // A stale model is not used: the catalog-driven hover answers instead (or nothing).
    const stale = pineHoverInfo(stateWith(SOURCE + ' ', MODEL, SOURCE), at('len', 2) + 1);
    expect(stale?.view.code).not.toEqual(['input int len']);
  });
});
