import { describe, expect, it } from 'vitest';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState, Text } from '@codemirror/state';

import type { ScriptDiagnostic, ScriptLibraryDto } from '@core/api/scripting.types';
import { PineCatalogIndex } from '../pine/pine-catalog-index';
import { toEditorDiagnostics, countDiagnostics, sortDiagnostics } from '../pine/pine-diagnostics';
import { formatOverload } from '../pine/pine-signature';
import { TEST_CATALOG } from '../testing/pine-test-catalog';
import { pineCompletionSource } from './pine-complete';
import { fallbackCatalogIndex, pineContextField } from './pine-context';
import { pineHoverInfo, pineSignatureAt } from './pine-tooltips';

const index = PineCatalogIndex.fromCatalog(TEST_CATALOG);

const LIBRARIES: ScriptLibraryDto[] = [
  {
    id: 7,
    publisher: 'alice',
    name: 'tools',
    version: 2,
    visibility: 'Shared',
    description: 'Helpers',
    exports: [
      { kind: 'function', name: 'clamp', signature: 'clamp(float x, float lo = 0, float hi = 1) → float', doc: 'Clamps x.' },
      { kind: 'type', name: 'Box2', signature: null, doc: null },
    ],
  },
];

/** A state whose cursor is at `|`, with the catalog and libraries loaded. */
function stateAt(docWithCursor: string, idx = index): { state: EditorState; pos: number } {
  const pos = docWithCursor.indexOf('|');
  const doc = docWithCursor.replace('|', '');
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [pineContextField.init(() => ({ index: idx, libraries: LIBRARIES }))],
  });
  return { state, pos };
}

function complete(docWithCursor: string, explicit = false): CompletionResult | null {
  const { state, pos } = stateAt(docWithCursor);
  return pineCompletionSource(new CompletionContext(state, pos, explicit)) as CompletionResult | null;
}

const labels = (r: CompletionResult | null) => (r?.options ?? []).map((o) => o.label);

const SCRIPT_HEAD = `//@version=6
strategy("S")
import alice/tools/2 as tools
type Point
    float x = 0.0
    int hits
enum Dir
    long = "Long"
    short
mid(float a, float b) => (a + b) / 2
method grow(Point p, float by) =>
    p.x + by
var array<float> vals = array.new<float>()
Point pt = Point.new()
length = input.int(14, "Length")
`;

describe('pine completion', () => {
  it('completes namespace members with signatures after `ta.`', () => {
    const r = complete(`${SCRIPT_HEAD}x = ta.|`);
    expect(labels(r)).toEqual(expect.arrayContaining(['ema', 'sma', 'crossover']));
    const ema = r!.options.find((o) => o.label === 'ema')!;
    expect(ema.type).toBe('function');
    expect(ema.detail).toBe('(source, length) → series float');
    expect(r!.from).toBe(`${SCRIPT_HEAD}x = ta.`.length);
  });

  it('narrows by the typed prefix position and nested namespaces', () => {
    const r = complete(`${SCRIPT_HEAD}x = ta.cr|`);
    expect(r!.from).toBe(`${SCRIPT_HEAD}x = ta.`.length);
    expect(labels(complete(`${SCRIPT_HEAD}strategy.|`))).toEqual(expect.arrayContaining(['entry', 'long', 'short']));
    expect(complete(`${SCRIPT_HEAD}c = color.|`)!.options.find((o) => o.label === 'red')!.detail).toBe('#F23645');
  });

  it('offers the user own declarations, keywords, types and top-level built-ins', () => {
    const r = complete(`${SCRIPT_HEAD}y = |`, true);
    const l = labels(r);
    expect(l).toEqual(expect.arrayContaining(['length', 'vals', 'pt', 'mid', 'grow', 'Point', 'Dir', 'tools']));
    expect(l).toEqual(expect.arrayContaining(['if', 'var', 'float', 'array', 'close', 'plot', 'ta', 'strategy']));
    expect(r!.options.find((o) => o.label === 'Point')!.type).toBe('class');
    expect(r!.options.find((o) => o.label === 'tools')!.type).toBe('namespace');
  });

  it('completes UDT fields and user methods on a typed variable', () => {
    const l = labels(complete(`${SCRIPT_HEAD}v = pt.|`));
    expect(l).toEqual(expect.arrayContaining(['x', 'hits', 'grow', 'copy']));
  });

  it('completes built-in methods on a collection variable', () => {
    const r = complete(`${SCRIPT_HEAD}vals.|`);
    expect(labels(r)).toEqual(expect.arrayContaining(['push', 'size']));
    expect(r!.options.find((o) => o.label === 'push')!.detail).toBe('(value) → void');
  });

  it('completes constructors, enum members and library exports', () => {
    expect(labels(complete(`${SCRIPT_HEAD}p2 = Point.|`))).toEqual(['new', 'copy']);
    expect(labels(complete(`${SCRIPT_HEAD}d = Dir.|`))).toEqual(['long', 'short']);
    const lib = complete(`${SCRIPT_HEAD}z = tools.|`);
    expect(labels(lib)).toEqual(['clamp', 'Box2']);
    expect(lib!.options[0].detail).toBe('clamp(float x, float lo = 0, float hi = 1) → float');
  });

  it('offers named arguments inside a call, minus those already given', () => {
    const l = labels(complete(`${SCRIPT_HEAD}plot(close, title = "t", |`, true));
    expect(l).toEqual(expect.arrayContaining(['color =', 'linewidth =']));
    expect(l).not.toContain('title =');
  });

  it('completes import paths from the libraries list', () => {
    const r = complete('import al|');
    expect(labels(r)).toEqual(['alice/tools/2']);
    expect(r!.options[0].apply).toBe('alice/tools/2 as tools');
  });

  it('stays quiet in comments and strings, except for annotations', () => {
    expect(complete(`${SCRIPT_HEAD}// ta|`)).toBeNull();
    expect(complete(`${SCRIPT_HEAD}s = "ta.|"`)).toBeNull();
    expect(labels(complete('//@ver|'))).toContain('@version=');
  });

  it('offers snippets, statement ones only at the start of a line', () => {
    const snippets = (r: CompletionResult | null) =>
      (r?.options ?? []).filter((o) => o.type === 'text').map((o) => o.label);
    expect(snippets(complete('str|'))).toEqual(expect.arrayContaining(['strategy skeleton', 'strategy.entry']));
    expect(snippets(complete('x = f|'))).not.toContain('for');
    expect(snippets(complete('x = f|'))).toContain('input.float');
    expect(snippets(complete('fo|'))).toContain('for');
  });

  it('works on the offline index before the catalog loads', () => {
    const { state, pos } = stateAt('x = ta.|', fallbackCatalogIndex());
    const r = pineCompletionSource(new CompletionContext(state, pos, false)) as CompletionResult;
    expect(labels(r)).toEqual(expect.arrayContaining(['ema', 'rsi', 'atr']));
  });
});

describe('pine signature help', () => {
  const sig = (docWithCursor: string) => {
    const { state, pos } = stateAt(docWithCursor);
    return pineSignatureAt(state, pos);
  };

  it('shows the callee, all overloads and the active parameter', () => {
    const s = sig(`${SCRIPT_HEAD}x = ta.ema(close, |`)!;
    expect(s.callee).toBe('ta.ema');
    expect(s.activeParam).toBe(1);
    expect(s.overloads.map(formatOverload)).toEqual(['ta.ema(source, length) → series float']);
    expect(s.doc).toBe('Exponential moving average.');
  });

  it('lists every overload of an overloaded built-in', () => {
    const s = sig(`${SCRIPT_HEAD}m = math.max(1, |`)!;
    expect(s.overloads).toHaveLength(2);
    expect(s.activeParam).toBe(1);
  });

  it('follows a named argument to its parameter', () => {
    const s = sig(`${SCRIPT_HEAD}plot(close, linewidth = |`)!;
    expect(s.overloads[s.activeOverload].params[s.activeParam].name).toBe('linewidth');
  });

  it('drops the receiver for method calls and knows user functions and constructors', () => {
    const push = sig(`${SCRIPT_HEAD}vals.push(|`)!;
    expect(push.overloads[0].params.map((p) => p.name)).toEqual(['value']);
    const mid = sig(`${SCRIPT_HEAD}m = mid(1, |`)!;
    expect(mid.overloads[0].params.map((p) => p.name)).toEqual(['a', 'b']);
    expect(mid.activeParam).toBe(1);
    const grow = sig(`${SCRIPT_HEAD}pt.grow(|`)!;
    expect(grow.overloads[0].params.map((p) => p.name)).toEqual(['by']);
    const ctor = sig(`${SCRIPT_HEAD}q = Point.new(1.0, |`)!;
    expect(ctor.overloads[0].params.map((p) => p.name)).toEqual(['x', 'hits']);
    const lib = sig(`${SCRIPT_HEAD}c = tools.clamp(v, |`)!;
    expect(lib.overloads[0].params.map((p) => p.name)).toEqual(['x', 'lo', 'hi']);
    expect(lib.activeParam).toBe(1);
  });

  it('is absent outside a call and inside strings', () => {
    expect(sig(`${SCRIPT_HEAD}x = |`)).toBeNull();
    expect(sig(`${SCRIPT_HEAD}plot(close, title = "a|b")`)).toBeNull();
  });
});

describe('pine hover docs', () => {
  const hover = (docWithCursor: string) => {
    const { state, pos } = stateAt(docWithCursor);
    return pineHoverInfo(state, pos);
  };

  it('documents built-in functions, variables and constants', () => {
    const fn = hover(`${SCRIPT_HEAD}x = ta.e|ma(close, 9)`)!;
    expect(fn.view.kind).toBe('function');
    expect(fn.view.code).toEqual(['ta.ema(source, length) → series float']);
    expect(fn.view.doc).toBe('Exponential moving average.');
    expect(hover(`${SCRIPT_HEAD}x = cl|ose`)!.view.code).toEqual(['close : series float']);
    expect(hover(`${SCRIPT_HEAD}c = color.r|ed`)!.view.code).toEqual(['color.red : const color = #F23645']);
  });

  it('documents the user own symbols', () => {
    const mid = hover(`${SCRIPT_HEAD}z = m|id(1, 2)`)!;
    expect(mid.view.kind).toBe('function');
    expect(mid.view.code).toEqual(['mid(a, b)']);
    const v = hover(`${SCRIPT_HEAD}z = len|gth * 2`)!;
    expect(v.view.kind).toBe('variable');
    expect(v.view.code[0]).toContain('length = input.int(14, "Length")');
    expect(hover(`${SCRIPT_HEAD}z = pt.h|its`)!.view.kind).toBe('field');
    expect(hover(`${SCRIPT_HEAD}d = Dir.lo|ng`)!.view.code).toEqual(['Dir.long = "Long"']);
    expect(hover(`${SCRIPT_HEAD}t = to|ols.clamp(1)`)!.view.kind).toBe('library');
  });

  it('documents keywords and type keywords, and not comments', () => {
    expect(hover(`${SCRIPT_HEAD}i|f close > 1`)!.view.kind).toBe('keyword');
    expect(hover(`${SCRIPT_HEAD}fl|oat f = 1.0`)!.view.kind).toBe('type');
    expect(hover(`${SCRIPT_HEAD}// cl|ose`)).toBeNull();
  });
});

describe('diagnostics → lint markers', () => {
  const doc = Text.of(['//@version=6', 'x = ta.ema(close)', 'plot(x)']);
  const d = (partial: Partial<ScriptDiagnostic>): ScriptDiagnostic => ({
    code: 'PS2003',
    severity: 'error',
    message: 'm',
    line: 2,
    column: 5,
    endLine: 2,
    endColumn: 11,
    ...partial,
  });

  it('maps 1-based line/column spans onto offsets with the code as source', () => {
    const [m] = toEditorDiagnostics(doc, [d({})]);
    expect(doc.sliceString(m.from, m.to)).toBe('ta.ema');
    expect(m).toMatchObject({ severity: 'error', source: 'PS2003', message: 'm' });
  });

  it('widens empty ranges to the word and clamps out-of-range positions', () => {
    const [empty] = toEditorDiagnostics(doc, [d({ column: 5, endColumn: 5, severity: 'warning' })]);
    expect(doc.sliceString(empty.from, empty.to)).toBe('ta.ema');
    expect(empty.severity).toBe('warning');
    const [past] = toEditorDiagnostics(doc, [d({ line: 99, column: 99, endLine: 99, endColumn: 120 })]);
    expect(past.from).toBeLessThanOrEqual(doc.length);
    expect(past.to).toBeLessThanOrEqual(doc.length);
  });

  it('keeps every severity and counts them', () => {
    const list = [d({ severity: 'info', line: 3 }), d({}), d({ severity: 'warning', line: 1, column: 1 })];
    expect(toEditorDiagnostics(doc, list).map((x) => x.severity)).toEqual(['warning', 'error', 'info']);
    expect(countDiagnostics(list)).toEqual({ errors: 1, warnings: 1, infos: 1 });
    expect(sortDiagnostics(list).map((x) => x.line)).toEqual([1, 2, 3]);
  });
});
