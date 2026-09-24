import { describe, expect, it } from 'vitest';

import type { ScriptInputDef } from '../api/scripting-api.types';
import {
  diffOverrides,
  displayValue,
  effectiveValue,
  fieldFor,
  groupFields,
  isInactive,
  normalizeInputKind,
  parseInputValue,
  parseLooseValue,
} from './script-inputs';

function def(over: Partial<ScriptInputDef>): ScriptInputDef {
  return { id: 'in_1', kind: 'int', title: 'Length', defaultValue: 14, ...over };
}

describe('script inputs', () => {
  it('normalises the kind from either casing', () => {
    expect(normalizeInputKind('Int')).toBe('int');
    expect(normalizeInputKind('TextArea')).toBe('textArea');
    expect(normalizeInputKind(null)).toBe('string');
  });

  it('picks a control per kind, options first', () => {
    expect(fieldFor(def({ kind: 'int' })).control).toBe('integer');
    expect(fieldFor(def({ kind: 'Float' })).control).toBe('number');
    expect(fieldFor(def({ kind: 'bool', defaultValue: true })).control).toBe('checkbox');
    expect(fieldFor(def({ kind: 'time', defaultValue: 0 })).control).toBe('datetime');
    expect(fieldFor(def({ kind: 'textArea', defaultValue: '' })).control).toBe('textarea');
    const opts = fieldFor(def({ kind: 'string', defaultValue: 'EMA', options: ['EMA', 'SMA'] }));
    expect(opts.control).toBe('select');
    expect(opts.options.map((o) => o.label)).toEqual(['EMA', 'SMA']);
    const src = fieldFor(def({ kind: 'source', defaultValue: 'hl2' }));
    expect(src.options.map((o) => o.label)).toContain('hlc3');
  });

  it('uses the saved override, else the default', () => {
    expect(effectiveValue(def({}), {})).toBe(14);
    expect(effectiveValue(def({}), { in_1: 20 })).toBe(20);
    expect(effectiveValue(def({}), { in_1: null })).toBeNull();
  });

  it('parses numbers within the input’s bounds', () => {
    const f = fieldFor(def({ minValue: 1, maxValue: 500 }));
    expect(parseInputValue(f, '20')).toEqual({ value: 20, error: null });
    expect(parseInputValue(f, '2.5').error).toMatch(/whole/);
    expect(parseInputValue(f, '0').error).toMatch(/at least 1/);
    expect(parseInputValue(f, '501').error).toMatch(/at most 500/);
    expect(parseInputValue(f, 'x').error).toMatch(/number/);
    expect(parseInputValue(fieldFor(def({ kind: 'float' })), '0.25')).toEqual({
      value: 0.25,
      error: null,
    });
  });

  it('parses selects, booleans, colours and times to wire values', () => {
    const sel = fieldFor(def({ kind: 'int', defaultValue: 1, options: [1, 2, 3] }));
    expect(parseInputValue(sel, '2')).toEqual({ value: 2, error: null });
    expect(parseInputValue(fieldFor(def({ kind: 'bool' })), false)).toEqual({
      value: false,
      error: null,
    });
    const color = fieldFor(def({ kind: 'color', defaultValue: '#FF0000FF' }));
    expect(parseInputValue(color, '#00FF00').error).toBeNull();
    expect(parseInputValue(color, 'red').error).toMatch(/#RRGGBB/);
    const time = fieldFor(def({ kind: 'time', defaultValue: 0 }));
    expect(parseInputValue(time, '2026-01-05T08:00')).toEqual({
      value: Date.UTC(2026, 0, 5, 8),
      error: null,
    });
    expect(displayValue(time, Date.UTC(2026, 0, 5, 8))).toBe('2026-01-05T08:00');
  });

  it('sends only what differs from the baseline', () => {
    expect(diffOverrides({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: true })).toEqual({ b: 'y' });
    expect(diffOverrides({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('groups inputs, ungrouped first, in declaration order', () => {
    const groups = groupFields([
      fieldFor(def({ id: 'a', group: 'Exits' })),
      fieldFor(def({ id: 'b' })),
      fieldFor(def({ id: 'c', group: 'Exits' })),
    ]);
    expect(groups.map((g) => [g.title, g.fields.map((f) => f.def.id)])).toEqual([
      [null, ['b']],
      ['Exits', ['a', 'c']],
    ]);
  });

  it('honours active= inputs', () => {
    const d = def({ id: 'tp', activeWhenInputId: 'useTp' });
    expect(isInactive(d, { useTp: false })).toBe(true);
    expect(isInactive(d, { useTp: true })).toBe(false);
  });

  it('reads free-form values as JSON literals or text', () => {
    expect(parseLooseValue('20')).toBe(20);
    expect(parseLooseValue('-1.5')).toBe(-1.5);
    expect(parseLooseValue('true')).toBe(true);
    expect(parseLooseValue('"quoted"')).toBe('quoted');
    expect(parseLooseValue('close')).toBe('close');
  });
});
