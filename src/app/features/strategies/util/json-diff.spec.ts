import { describe, it, expect } from 'vitest';

import { diffJson, diffTextField, formatDiffValue, jsonEqual } from './json-diff';

describe('diffJson', () => {
  it('returns nothing for equal values', () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it('reports one row per changed leaf, with the full path', () => {
    const before = {
      entryConditionsRoot: {
        op: 'And',
        children: [
          {
            leaf: {
              type: 'IndicatorThreshold',
              indicatorThreshold: { indicator: 'Rsi', period: 14, value: 30 },
            },
          },
          { leaf: { type: 'PriceVsMa', priceVsMa: { maPeriod: 200 } } },
        ],
      },
    };
    const after: any = structuredClone(before);
    after.entryConditionsRoot.children[0].leaf.indicatorThreshold.value = 25;
    expect(diffJson(before, after)).toEqual([
      {
        path: 'entryConditionsRoot.children[0].leaf.indicatorThreshold.value',
        kind: 'changed',
        before: 30,
        after: 25,
      },
    ]);
  });

  it('reports added and removed keys', () => {
    expect(diffJson({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { path: 'b', kind: 'removed', before: 2 },
      { path: 'c', kind: 'added', after: 3 },
    ]);
  });

  it('matches keys case-insensitively, so a re-cased rule is not a rewrite', () => {
    const before = { StopLossAtrMultiplier: 1.5, EntryConditionsRoot: { Op: 'And' } };
    const after = { stopLossAtrMultiplier: 2, entryConditionsRoot: { op: 'And' } };
    expect(diffJson(before, after)).toEqual([
      { path: 'stopLossAtrMultiplier', kind: 'changed', before: 1.5, after: 2 },
    ]);
    expect(jsonEqual({ A: { B: 1 } }, { a: { b: 1 } })).toBe(true);
  });

  it('shows an inserted array element as one addition', () => {
    const x = { leaf: { type: 'X' } };
    const y = { leaf: { type: 'Y' } };
    const z = { leaf: { type: 'Z' } };
    expect(diffJson({ children: [x, z] }, { children: [x, y, z] })).toEqual([
      { path: 'children[1]', kind: 'added', after: y },
    ]);
    expect(diffJson({ children: [x, y, z] }, { children: [x, z] })).toEqual([
      { path: 'children[1]', kind: 'removed', before: y },
    ]);
  });

  it('diffs an edited array element field by field', () => {
    const rows = diffJson({ list: [{ a: 1, b: 2 }, 'keep'] }, { list: [{ a: 1, b: 3 }, 'keep'] });
    expect(rows).toEqual([{ path: 'list[0].b', kind: 'changed', before: 2, after: 3 }]);
  });

  it('reports a type change as one changed row', () => {
    expect(diffJson({ a: [1] }, { a: { x: 1 } })).toEqual([
      { path: 'a', kind: 'changed', before: [1], after: { x: 1 } },
    ]);
  });
});

describe('diffTextField', () => {
  it('diffs JSON fields structurally under the field name', () => {
    expect(
      diffTextField('parametersJson', '{"a":{"b":1}}', '{ "a": { "b": 2 } }', { json: true }),
    ).toEqual([{ path: 'parametersJson.a.b', kind: 'changed', before: 1, after: 2 }]);
  });

  it('ignores whitespace-only JSON differences', () => {
    expect(diffTextField('x', '{"a":1}', '{\n  "a": 1\n}', { json: true })).toEqual([]);
  });

  it('falls back to full text when a side is not JSON — never truncated', () => {
    const long = 'x'.repeat(500);
    const rows = diffTextField('parametersJson', long, '{"a":1}', { json: true });
    expect(rows).toEqual([
      { path: 'parametersJson', kind: 'changed', before: long, after: '{"a":1}' },
    ]);
  });

  it('treats empty and null as absent', () => {
    expect(diffTextField('description', '', null)).toEqual([]);
    expect(diffTextField('description', null, 'new')).toEqual([
      { path: 'description', kind: 'added', after: 'new' },
    ]);
    expect(diffTextField('sizingConfigJson', '{"mode":"FixedLot"}', '', { json: true })).toEqual([
      { path: 'sizingConfigJson', kind: 'removed', before: { mode: 'FixedLot' } },
    ]);
  });
});

describe('formatDiffValue', () => {
  it('renders JSON literals and pretty structures', () => {
    expect(formatDiffValue('Rsi')).toBe('"Rsi"');
    expect(formatDiffValue(30)).toBe('30');
    expect(formatDiffValue(null)).toBe('null');
    expect(formatDiffValue(undefined)).toBe('∅');
    expect(formatDiffValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
