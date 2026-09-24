import { describe, expect, it } from 'vitest';
import { StringStream, getIndentation, IndentContext, foldable } from '@codemirror/language';
import { EditorState } from '@codemirror/state';

import { createPineStreamParser, pineLanguageSupport, type PineTokenizerNames } from './pine-language';
import { PineCatalogIndex } from '../pine/pine-catalog-index';
import { TEST_CATALOG } from '../testing/pine-test-catalog';

const index = PineCatalogIndex.fromCatalog(TEST_CATALOG);
const names: PineTokenizerNames = {
  functions: new Set(index.functions.keys()),
  variables: new Set(index.variables.keys()),
  constants: new Set(index.constants.keys()),
  namespaces: index.namespaces,
};

/** Tokenizes lines the way StreamLanguage does: [text, token][] per line. */
function tokenize(lines: string[]): [string, string | null][][] {
  const parser = createPineStreamParser(names);
  const state = parser.startState!(4);
  return lines.map((line) => {
    const out: [string, string | null][] = [];
    if (line === '') {
      parser.blankLine?.(state, 4);
      return out;
    }
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = parser.token(stream, state);
      if (stream.pos === stream.start) throw new Error(`no progress at ${stream.pos} in "${line}"`);
      out.push([line.slice(stream.start, stream.pos), style]);
    }
    return out;
  });
}

/** Non-whitespace tokens of one line. */
const tokens = (line: string) => tokenize([line])[0].filter(([, s]) => s !== null);
const styleOf = (line: string, text: string) => tokens(line).find(([t]) => t === text)?.[1];

describe('Pine stream tokenizer', () => {
  it('reads the version annotation and the rest of the line as a doc comment', () => {
    expect(tokens('//@version=6')).toEqual([
      ['//@version=', 'pineAnnotation'],
      ['6', 'pineDocComment'],
    ]);
  });

  it('highlights the declaration call, strings and literals', () => {
    const line = 'strategy("My strategy", overlay = true)';
    expect(styleOf(line, 'strategy')).toBe('pineBuiltinFunction');
    expect(styleOf(line, '"My strategy"')).toBe('pineString');
    expect(styleOf(line, 'overlay')).toBe('pineProperty');
    expect(styleOf(line, 'true')).toBe('pineBool');
  });

  it('reads a namespaced built-in as one token and built-in variables as variables', () => {
    const line = 'fast = ta.ema(close, 9)';
    expect(tokens(line)).toEqual([
      ['fast', 'pineVariable'],
      ['=', 'pineOperator'],
      ['ta.ema', 'pineBuiltinFunction'],
      ['(', 'pineParen'],
      ['close', 'pineBuiltinVariable'],
      [',', 'pineSeparator'],
      ['9', 'pineNumber'],
      [')', 'pineParen'],
    ]);
  });

  it('reads constants, and an unknown member of a namespace as namespace + property', () => {
    expect(styleOf('c = color.red', 'color.red')).toBe('pineBuiltinConstant');
    expect(tokens('x = ta.nosuchfn(close)').slice(2, 5)).toEqual([
      ['ta', 'pineNamespace'],
      ['.', 'pinePunctuation'],
      ['nosuchfn', 'pineMethodCall'],
    ]);
  });

  it('tells a name that is both variable and function apart by the call', () => {
    expect(styleOf('t = time', 'time')).toBe('pineBuiltinVariable');
    expect(styleOf('t = time("D")', 'time')).toBe('pineBuiltinFunction');
  });

  it('reads type keywords, generics and qualifiers', () => {
    const line = 'var array<float> values = array.new<float>(0)';
    const t = tokens(line);
    expect(t[0]).toEqual(['var', 'pineDefinitionKeyword']);
    expect(t[1]).toEqual(['array', 'pineType']);
    expect(t[2]).toEqual(['<', 'pineOperator']);
    expect(t[3]).toEqual(['float', 'pineType']);
    expect(styleOf(line, 'array.new')).toBe('pineBuiltinFunction');
    expect(styleOf('series float x = 1.5', 'series')).toBe('pineModifier');
    expect(styleOf('chart.point p = na', 'chart.point')).toBe('pineType');
  });

  it('reads colour literals with and without alpha', () => {
    expect(styleOf('c = #FF000080', '#FF000080')).toBe('pineColor');
    expect(styleOf('c = #1e90ff', '#1e90ff')).toBe('pineColor');
  });

  it('reads numbers in every form', () => {
    for (const n of ['1', '1.5', '.5', '1e10', '2.5e-3']) {
      expect(styleOf(`x = ${n}`, n)).toBe('pineNumber');
    }
  });

  it('carries a multi-line string across lines', () => {
    const result = tokenize(['s = """first', 'second', 'third""" + "x"']);
    expect(result[0].at(-1)).toEqual(['"""first', 'pineString']);
    expect(result[1]).toEqual([['second', 'pineString']]);
    expect(result[2][0]).toEqual(['third"""', 'pineString']);
    expect(result[2].at(-1)).toEqual(['"x"', 'pineString']);
  });

  it('reads comments, region markers and doc annotations', () => {
    expect(tokens('x = 1 // trailing')).toContainEqual(['// trailing', 'pineComment']);
    expect(tokens('//#region Inputs')[0]).toEqual(['//#region', 'pineRegion']);
    expect(tokens('// @param length The length')).toEqual([
      ['// @param', 'pineAnnotation'],
      [' ', 'pineDocComment'],
      ['length', 'pineVariable'],
      [' The length', 'pineDocComment'],
    ]);
  });

  it('marks user definitions: functions, types, methods and import aliases', () => {
    expect(styleOf('f(x) => x * 2', 'f')).toBe('pineFunctionDefinition');
    expect(styleOf('f(x) => x * 2', '=>')).toBe('pineArrow');
    expect(styleOf('y = f(3)', 'f')).toBe('pineFunctionCall');
    expect(tokens('type Point')).toEqual([
      ['type', 'pineDefinitionKeyword'],
      ['Point', 'pineTypeDefinition'],
    ]);
    expect(styleOf('method area(Rect r) =>', 'area')).toBe('pineFunctionDefinition');
    expect(styleOf('import user/lib/1 as mylib', 'mylib')).toBe('pineNamespace');
  });

  it('reads keywords and word operators', () => {
    const line = 'if close > open and not na';
    expect(styleOf(line, 'if')).toBe('pineControl');
    expect(styleOf(line, 'and')).toBe('pineOperatorKeyword');
    expect(styleOf(line, 'not')).toBe('pineOperatorKeyword');
    expect(styleOf(line, 'na')).toBe('pineNa');
  });

  it('reads member access and method calls', () => {
    const line = 'n = pts.last.size()';
    expect(tokens(line)).toEqual([
      ['n', 'pineVariable'],
      ['=', 'pineOperator'],
      ['pts', 'pineVariable'],
      ['.', 'pinePunctuation'],
      ['last', 'pineProperty'],
      ['.', 'pinePunctuation'],
      ['size', 'pineMethodCall'],
      ['(', 'pineParen'],
      [')', 'pineParen'],
    ]);
  });
});

describe('Pine language support (indentation + folding)', () => {
  const state = (doc: string) =>
    EditorState.create({ doc, extensions: [pineLanguageSupport(names), EditorState.tabSize.of(4)] });

  /** Indentation for a new line typed at the end of `doc` (what Enter does). */
  const enterIndent = (doc: string) => {
    const s = state(doc);
    const cx = new IndentContext(s, { simulateBreak: doc.length });
    return getIndentation(cx, doc.length);
  };

  it('indents after a block header and a function arrow', () => {
    expect(enterIndent('if close > open')).toBe(4);
    expect(enterIndent('f(x) =>')).toBe(4);
    expect(enterIndent('plotColor = if up')).toBe(4);
    expect(enterIndent('x = 1')).toBe(0);
  });

  it('keeps the block level inside a block and wraps continuations off the 4-grid', () => {
    expect(enterIndent('if a\n    x = 1')).toBe(4);
    expect(enterIndent('float x = open +')).toBe(2);
    expect(enterIndent('plot(close,')).toBe(4);
  });

  it('folds indented blocks and //#region … //#endregion', () => {
    const s = state('if a\n    x = 1\n    y = 2\nz = 3\n//#region R\nq = 1\n//#endregion');
    const ifLine = s.doc.line(1);
    expect(foldable(s, ifLine.from, ifLine.to)).toEqual({ from: ifLine.to, to: s.doc.line(3).to });
    const region = s.doc.line(5);
    expect(foldable(s, region.from, region.to)).toEqual({ from: region.to, to: s.doc.line(7).to });
    const flat = s.doc.line(4);
    expect(foldable(s, flat.from, flat.to)).toBeNull();
  });
});
