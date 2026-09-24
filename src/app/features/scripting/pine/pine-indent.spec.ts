import { describe, expect, it } from 'vitest';

import { computePineIndent, pineFoldEnd } from './pine-indent';

/** Indentation for line `n` (0-based) of the given lines. */
const indentOf = (lines: string[], n: number) => computePineIndent((i) => lines[i] ?? '', n);

describe('computePineIndent', () => {
  it('opens a block after every Pine block header', () => {
    for (const header of [
      'if close > open',
      'else',
      'else if a',
      'for i = 0 to 9',
      'for [i, x] in arr',
      'while n < 3',
      'switch mode',
      'type Point',
      'export enum Dir',
      'f(x) =>',
      'method m(Point p) =>',
      'c = if up',
      '[a, b] = switch k',
    ]) {
      expect(indentOf([header, ''], 1), header).toBe(4);
    }
  });

  it('does not open a block after a single-line function or a switch case expression', () => {
    expect(indentOf(['f(x) => x * 2', ''], 1)).toBe(0);
    expect(indentOf(['switch s', '    "a" => 1', ''], 2)).toBe(4);
    expect(indentOf(['switch s', '    "a" =>', ''], 2)).toBe(8);
  });

  it('wraps an operator continuation off the four-space grid, then returns', () => {
    expect(indentOf(['x = open +', ''], 1)).toBe(2);
    expect(indentOf(['if a', '    x = open +', ''], 2)).toBe(6);
    expect(indentOf(['x = open +', '  high', ''], 2)).toBe(0);
    expect(indentOf(['if a and', '  b', ''], 2)).toBe(4);
  });

  it('indents inside open brackets and dedents a closing bracket', () => {
    expect(indentOf(['plot(', ''], 1)).toBe(4);
    expect(indentOf(['plot(', '    close,', ''], 2)).toBe(4);
    expect(indentOf(['plot(', '    close,', ')'], 2)).toBe(0);
    expect(indentOf(['plot(close, title = "x",', '     color = c)', ''], 2)).toBe(0);
  });

  it('aligns else with its if', () => {
    expect(indentOf(['if a', '    x = 1', 'else'], 2)).toBe(0);
    expect(indentOf(['c = if up', '    color.green', 'else'], 2)).toBe(0);
    expect(indentOf(['if a', '    if b', '        x = 1', '    else'], 3)).toBe(4);
  });

  it('ignores brackets and arrows inside strings and comments', () => {
    expect(indentOf(['x = "(" // =>', ''], 1)).toBe(0);
  });
});

describe('pineFoldEnd', () => {
  const lines = [
    '//#region Inputs', // 0
    'a = 1', // 1
    '//#region Nested', // 2
    'b = 2', // 3
    '//#endregion', // 4
    '//#endregion', // 5
    'if a', // 6
    '    x = 1', // 7
    '', // 8
    '    y = 2', // 9
    'z = 3', // 10
  ];
  const fold = (n: number) => pineFoldEnd((i) => lines[i], lines.length, n);

  it('folds regions to their matching end, nesting included', () => {
    expect(fold(0)).toBe(5);
    expect(fold(2)).toBe(4);
  });

  it('folds an indented block through blank lines, not the next statement', () => {
    expect(fold(6)).toBe(9);
    expect(fold(10)).toBeNull();
    expect(fold(8)).toBeNull();
  });
});
