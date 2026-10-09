import { describe, expect, it } from 'vitest';

import type { ScriptSemantic } from '@core/api/scripting.types';
import { SemanticIndex, applyRename, flattenOutline, symbolDocView } from './pine-semantic';

const loc = (offset: number, length: number, line: number, unit?: string) => ({
  line,
  column: 1,
  endLine: line,
  endColumn: 1 + length,
  offset,
  length,
  ...(unit ? { unit } : {}),
});

// "len = 14\nplot(scale(len))" with `scale` from a library.
const SOURCE = 'len = 14\nplot(scale(len))';
const MODEL: ScriptSemantic = {
  symbols: [
    {
      id: 0,
      name: 'len',
      kind: 'variable',
      declaration: loc(0, 3, 1),
      type: 'const int',
      exported: false,
    },
    {
      id: 1,
      name: 'scale',
      kind: 'function',
      declaration: loc(120, 5, 12, 'alice/points/1'),
      detail: 'scale(float v)',
      type: 'series float',
      doc: 'Scales a value.',
      exported: true,
    },
  ],
  references: [
    [0, 0, 3, 0],
    [1, 14, 5, 3],
    [0, 20, 3, 1],
  ],
  outline: [
    {
      name: 'Inputs',
      kind: 'region',
      range: loc(0, 8, 1),
      nameRange: loc(0, 8, 1),
      children: [
        {
          name: 'len',
          kind: 'variable',
          range: loc(0, 8, 1),
          nameRange: loc(0, 3, 1),
          children: [],
        },
      ],
    },
  ],
};

describe('semantic index (PR-I8)', () => {
  const index = new SemanticIndex(MODEL);

  it('finds the name at a position, ends included', () => {
    expect(index.referenceAt(0)?.symbol.name).toBe('len');
    expect(index.referenceAt(3)?.symbol.name).toBe('len');
    expect(index.referenceAt(16)?.symbol.name).toBe('scale');
    expect(index.referenceAt(6)).toBeNull();
    expect(index.referenceAt(21)?.kind).toBe('read');
  });

  it('lists every reference of a symbol and goes to its definition, in the script or a library', () => {
    expect(index.referencesOf(MODEL.symbols[0]).map((r) => SOURCE.slice(r.from, r.to))).toEqual([
      'len',
      'len',
    ]);
    expect(index.definitionAt(21)).toMatchObject({ kind: 'local', from: 0, to: 3 });
    expect(index.definitionAt(15)).toMatchObject({
      kind: 'library',
      unit: 'alice/points/1',
      line: 12,
    });
    expect(index.definitionAt(6)).toBeNull();
  });

  it('describes a user symbol for the hover', () => {
    expect(symbolDocView(MODEL.symbols[0])).toEqual({
      kind: 'variable',
      code: ['const int len'],
      doc: null,
      notes: ['Declared on line 1.'],
    });
    const fn = symbolDocView(MODEL.symbols[1]);
    expect(fn.code).toEqual(['scale(float v)', '→ series float']);
    expect(fn.notes).toEqual(['Declared in library alice/points/1, line 12.']);
  });

  it('flattens the outline and applies a rename', () => {
    expect(flattenOutline(MODEL.outline).map((x) => `${x.depth}:${x.item.name}`)).toEqual([
      '0:Inputs',
      '1:len',
    ]);
    const edit = (offset: number) => ({
      offset,
      length: 3,
      text: 'period',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 4,
    });
    expect(applyRename(SOURCE, [edit(0), edit(20)])).toBe('period = 14\nplot(scale(period))');
  });
});
