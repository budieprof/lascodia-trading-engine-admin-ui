import { describe, expect, it } from 'vitest';

import {
  findCallContext,
  identifierPathAt,
  inferInitType,
  isInCommentOrString,
  lexicalRanges,
  maskCommentsAndStrings,
  readDeclarationHeader,
  scanPineSymbols,
  variablesInScope,
} from './pine-scan';

const SCRIPT = `//@version=6
strategy("Demo", overlay = true)
import alice/tools/2 as tools

//@type A 2-D point.
//@field x Horizontal.
type Point
    float x = 0.0
    varip int hits
    array<float> history

//@enum Signal direction.
enum Dir
    long = "Long only"
    short

//@function Midpoint of two values.
//@param a First value.
//@returns The midpoint.
mid(float a, float b = 2.0) => (a + b) / 2

method shifted(Point p, float dx) =>
    Point.new(p.x + dx)

length = input.int(14, "Length")
var array<float> vals = array.new<float>()
fast = ta.ema(close, length)
[lo, hi] = request.security("X", "D", [low, high])
plot(fast,
     title = "Fast",
     color = color.red)
if fast > close
    local = fast * 2
    for i = 0 to 3
        tmp = i
`;

describe('lexical ranges and masking', () => {
  it('finds comments, strings and multi-line strings', () => {
    const text = 'a = "x(y)" // c(\ns = """p\nq"""';
    const ranges = lexicalRanges(text);
    expect(ranges.map((r) => r.kind)).toEqual(['string', 'comment', 'string']);
    const masked = maskCommentsAndStrings(text);
    expect(masked.length).toBe(text.length);
    expect(masked).not.toContain('(y)');
    expect(masked).not.toContain('c(');
    expect(masked.split('\n')).toHaveLength(3);
  });

  it('knows when a cursor is inside a comment or between quotes', () => {
    const text = 'x = "ab" // note';
    const ranges = lexicalRanges(text);
    expect(isInCommentOrString(ranges, 5)).toBe(true); // after the opening quote
    expect(isInCommentOrString(ranges, 7)).toBe(true); // before the closing quote
    expect(isInCommentOrString(ranges, 8)).toBe(false); // after the closing quote
    expect(isInCommentOrString(ranges, 12)).toBe(true); // in the comment
    expect(isInCommentOrString(ranges, 2)).toBe(false);
  });

  it('treats an unterminated string as open to the end of the line', () => {
    const ranges = lexicalRanges('x = "abc');
    expect(isInCommentOrString(ranges, 8)).toBe(true);
  });
});

describe('scanPineSymbols', () => {
  const s = scanPineSymbols(SCRIPT);

  it('collects imports with their alias', () => {
    expect(s.imports).toEqual([
      { kind: 'import', publisher: 'alice', libraryName: 'tools', version: 2, alias: 'tools', line: 2 },
    ]);
  });

  it('collects a type with typed fields, defaults and docs', () => {
    const point = s.types.find((t) => t.name === 'Point')!;
    expect(point.doc).toBe('A 2-D point.');
    expect(point.fields.map((f) => [f.name, f.type])).toEqual([
      ['x', 'float'],
      ['hits', 'int'],
      ['history', 'array<float>'],
    ]);
    expect(point.fields[0]).toMatchObject({ defaultText: '0.0', doc: 'Horizontal.' });
    expect(point.fields[1].varip).toBe(true);
  });

  it('collects an enum with member titles', () => {
    const dir = s.enums.find((e) => e.name === 'Dir')!;
    expect(dir.doc).toBe('Signal direction.');
    expect(dir.members).toEqual([{ name: 'long', title: 'Long only' }, { name: 'short' }]);
  });

  it('collects functions with params, defaults and annotation docs', () => {
    const mid = s.functions.find((f) => f.name === 'mid')!;
    expect(mid.params).toEqual([
      { name: 'a', type: 'float' },
      { name: 'b', type: 'float', defaultText: '2.0' },
    ]);
    expect(mid.doc).toBe('Midpoint of two values.');
    expect(mid.paramDocs).toEqual({ a: 'First value.' });
    expect(mid.returnsDoc).toBe('The midpoint.');
    expect(mid.body).toBe('(a + b) / 2');
  });

  it('collects methods with their receiver type', () => {
    const m = s.methods.find((x) => x.name === 'shifted')!;
    expect(m.kind).toBe('method');
    expect(m.receiverType).toBe('Point');
    expect(m.endLine).toBeGreaterThan(m.line);
  });

  it('collects variables with explicit and inferred types', () => {
    const byName = (n: string) => s.variables.find((v) => v.name === n)!;
    expect(byName('length')).toMatchObject({ type: 'int', initCallee: 'input.int' });
    expect(byName('vals')).toMatchObject({ type: 'array<float>', declKeyword: 'var' });
    expect(byName('fast')).toMatchObject({ initCallee: 'ta.ema' });
    expect(byName('lo')).toBeDefined();
    expect(byName('hi')).toBeDefined();
  });

  it('never mistakes named arguments on wrapped lines for declarations', () => {
    expect(s.variables.some((v) => v.name === 'title' || v.name === 'color')).toBe(false);
  });

  it('scopes locals, loop variables and parameters to their blocks', () => {
    const lines = SCRIPT.split('\n');
    const ifLine = lines.findIndex((l) => l.startsWith('if fast'));
    const inFor = lines.findIndex((l) => l.includes('tmp = i'));
    const names = (line: number) => variablesInScope(s, line).map((v) => v.name);
    expect(names(inFor)).toEqual(expect.arrayContaining(['local', 'i', 'tmp', 'fast', 'length']));
    expect(names(ifLine)).not.toContain('local');
    const midLine = lines.findIndex((l) => l.startsWith('mid('));
    expect(names(midLine)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(names(ifLine)).not.toContain('a');
  });
});

describe('findCallContext', () => {
  const at = (text: string) => {
    const offset = text.indexOf('|');
    const clean = text.replace('|', '');
    return findCallContext(maskCommentsAndStrings(clean), offset);
  };

  it('finds the callee and the argument index', () => {
    expect(at('x = ta.ema(close, |')).toMatchObject({ callee: 'ta.ema', argIndex: 1, namedArg: null });
    expect(at('x = ta.ema(|')).toMatchObject({ callee: 'ta.ema', argIndex: 0 });
  });

  it('sees through nested calls, grouping parens, tuples and strings', () => {
    expect(at('plot(math.max(a, b), |')).toMatchObject({ callee: 'plot', argIndex: 1 });
    expect(at('plot((a + b) * 2, c, |')).toMatchObject({ callee: 'plot', argIndex: 2 });
    expect(at('f(a, [1, 2, |')).toMatchObject({ callee: 'f', argIndex: 1 });
    expect(at('label.new(x, y, "a, b, c", |')).toMatchObject({ callee: 'label.new', argIndex: 3 });
    expect(at('plot(a < b ? 1 : 0, |')).toMatchObject({ callee: 'plot', argIndex: 1 });
  });

  it('reads generic callees and method calls', () => {
    expect(at('a = array.new<float>(|')).toMatchObject({ callee: 'array.new' });
    expect(at('arr.push(|')).toMatchObject({ callee: 'arr.push' });
  });

  it('reports named arguments', () => {
    const ctx = at('plot(close, title = "x", color = |');
    expect(ctx).toMatchObject({ callee: 'plot', argIndex: 2, namedArg: 'color', usedNamedArgs: ['title'] });
  });

  it('ignores keyword parentheses and returns null outside calls', () => {
    expect(at('if (a and |')).toBeNull();
    expect(at('x = 1 + |')).toBeNull();
  });
});

describe('identifierPathAt / inferInitType / readDeclarationHeader', () => {
  it('returns the dotted path up to the hovered segment', () => {
    const text = 'x = strategy.risk.allow_entry_in(strategy.direction.long)';
    expect(identifierPathAt(text, text.indexOf('risk') + 1)?.path).toBe('strategy.risk');
    expect(identifierPathAt(text, text.indexOf('allow') + 2)?.path).toBe('strategy.risk.allow_entry_in');
    expect(identifierPathAt(text, 1)?.path).toBe('x');
    expect(identifierPathAt('a = 12', 5)).toBeNull();
  });

  it('infers types from literals and constructors', () => {
    expect(inferInitType('1.5')).toEqual({ type: 'float' });
    expect(inferInitType('42')).toEqual({ type: 'int' });
    expect(inferInitType('"s"')).toEqual({ type: 'string' });
    expect(inferInitType('#FF0000')).toEqual({ type: 'color' });
    expect(inferInitType('array.new<int>(3)')).toEqual({ type: 'array<int>', callee: 'array.new' });
    expect(inferInitType('array.new_float(0)')).toEqual({ type: 'array<float>', callee: 'array.new_float' });
    expect(inferInitType('Point.new(1)')).toEqual({ type: 'Point', callee: 'Point.new' });
    expect(inferInitType('line.new(a, b, c, d)')).toEqual({ type: 'line', callee: 'line.new' });
    expect(inferInitType('input.enum(Dir.long, "D")')).toEqual({ type: 'Dir', callee: 'input.enum' });
    expect(inferInitType('ta.rsi(close, 14)')).toEqual({ callee: 'ta.rsi' });
  });

  it('reads the declaration kind and title without compiling', () => {
    expect(readDeclarationHeader(SCRIPT)).toEqual({ kind: 'strategy', title: 'Demo' });
    expect(readDeclarationHeader('//@version=6\nindicator(title = "RSI")')).toEqual({ kind: 'indicator', title: 'RSI' });
    expect(readDeclarationHeader('// strategy("x")\nplot(1)')).toBeNull();
  });
});
