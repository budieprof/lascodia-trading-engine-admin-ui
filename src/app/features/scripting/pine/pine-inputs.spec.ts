import { describe, expect, it } from 'vitest';

import type { ScriptInputDto } from '@core/api/scripting.types';
import {
  alphaToOpacity,
  coerceInputValue,
  colorToCss,
  engineToPineTimeframe,
  formatColor,
  formatSession,
  inputDefault,
  inputOptions,
  inputOverrides,
  isInputActive,
  layoutInputs,
  msToUtcInput,
  opacityToAlpha,
  parseColor,
  parseSavedInputs,
  parseSession,
  resolveInputValues,
  timeframeLabel,
  utcInputToMs,
} from './pine-inputs';

const input = (partial: Partial<ScriptInputDto> & Pick<ScriptInputDto, 'id' | 'kind'>): ScriptInputDto => ({
  title: partial.id,
  defaultValue: null,
  ...partial,
});

describe('input defaults and coercion — every kind', () => {
  it('int: rounds and clamps to min/max', () => {
    const i = input({ id: 'len', kind: 'int', defaultValue: 14, minValue: 1, maxValue: 500 });
    expect(inputDefault(i)).toBe(14);
    expect(coerceInputValue(i, '20.6')).toBe(21);
    expect(coerceInputValue(i, 0)).toBe(1);
    expect(coerceInputValue(i, 9999)).toBe(500);
    expect(coerceInputValue(i, 'abc')).toBe(14);
  });

  it('float / price: clamp without rounding', () => {
    const f = input({ id: 'f', kind: 'float', defaultValue: 1.5, minValue: 0, maxValue: 3 });
    expect(coerceInputValue(f, '2.25')).toBe(2.25);
    expect(coerceInputValue(f, -1)).toBe(0);
    const p = input({ id: 'p', kind: 'price', defaultValue: 1.0842 });
    expect(coerceInputValue(p, '1.1')).toBe(1.1);
  });

  it('bool', () => {
    const b = input({ id: 'b', kind: 'bool', defaultValue: true });
    expect(inputDefault(b)).toBe(true);
    expect(coerceInputValue(b, false)).toBe(false);
    expect(coerceInputValue(b, 'true')).toBe(true);
    expect(inputDefault(input({ id: 'b2', kind: 'bool', defaultText: 'false' }))).toBe(false);
  });

  it('string / textArea / symbol / session: strings', () => {
    expect(coerceInputValue(input({ id: 's', kind: 'string', defaultValue: 'A' }), 'B')).toBe('B');
    expect(coerceInputValue(input({ id: 't', kind: 'textArea', defaultValue: '' }), 'a\nb')).toBe('a\nb');
    expect(coerceInputValue(input({ id: 'y', kind: 'symbol', defaultValue: '' }), 'EURUSD')).toBe('EURUSD');
    expect(coerceInputValue(input({ id: 'x', kind: 'session', defaultValue: '0930-1600' }), '0800-1700:23456')).toBe(
      '0800-1700:23456',
    );
  });

  it('timeframe: normalises D/W/M', () => {
    const tf = input({ id: 'tf', kind: 'timeframe', defaultValue: 'D' });
    expect(inputDefault(tf)).toBe('1D');
    expect(coerceInputValue(tf, '60')).toBe('60');
    expect(coerceInputValue(tf, 'w')).toBe('1W');
  });

  it('source: series names only, default from defaultText', () => {
    const src = input({ id: 'src', kind: 'source', defaultValue: null, defaultText: 'hl2' });
    expect(inputDefault(src)).toBe('hl2');
    expect(coerceInputValue(src, 'close')).toBe('close');
    expect(coerceInputValue(src, 'nonsense')).toBe('hl2');
  });

  it('color: #RRGGBBAA on the wire', () => {
    const c = input({ id: 'c', kind: 'color', defaultValue: '#FF0000', defaultText: '#FF0000' });
    expect(inputDefault(c)).toBe('#FF0000FF');
    expect(coerceInputValue(c, '#00ff0080')).toBe('#00FF0080');
    expect(coerceInputValue(c, 'red')).toBe('#FF0000FF');
  });

  it('time: milliseconds, from a UTC datetime-local string or a number', () => {
    const t = input({ id: 't', kind: 'time', defaultValue: 1735291800000 });
    expect(coerceInputValue(t, '2024-12-27T09:30')).toBe(Date.UTC(2024, 11, 27, 9, 30));
    expect(coerceInputValue(t, 1700000000000)).toBe(1700000000000);
  });

  it('enum: member names, restricted to the options', () => {
    const e = input({
      id: 'e',
      kind: 'enum',
      defaultValue: 'SignalType.long',
      options: ['long', 'short'],
      optionTexts: ['Only long', 'Only short'],
      enumName: 'SignalType',
    });
    expect(inputDefault(e)).toBe('long');
    expect(coerceInputValue(e, 'short')).toBe('short');
    expect(coerceInputValue(e, 'both')).toBe('long');
    expect(inputOptions(e)).toEqual([
      { value: 'long', label: 'Only long' },
      { value: 'short', label: 'Only short' },
    ]);
  });
});

describe('values round-trip', () => {
  const inputs: ScriptInputDto[] = [
    input({ id: 'len', kind: 'int', defaultValue: 14, minValue: 1, maxValue: 100 }),
    input({ id: 'show', kind: 'bool', defaultValue: true }),
    input({ id: 'col', kind: 'color', defaultValue: '#089981FF' }),
    input({ id: 'avgLen', kind: 'int', defaultValue: 20, activeWhenInputId: 'show' }),
  ];

  it('resolves saved overrides (coerced) over defaults, ignoring unknown ids', () => {
    const values = resolveInputValues(inputs, { len: 500, col: '#ff0000', stale: 1 });
    expect(values).toEqual({ len: 100, show: true, col: '#FF0000FF', avgLen: 20 });
  });

  it('stores only what differs from the defaults', () => {
    const values = resolveInputValues(inputs, { len: 30 });
    expect(inputOverrides(inputs, values)).toEqual({ len: 30 });
    expect(inputOverrides(inputs, { ...values, col: '#089981ff' })).toEqual({ len: 30 });
  });

  it('greys out inputs whose active bool is off', () => {
    const on = resolveInputValues(inputs, {});
    expect(isInputActive(inputs[3], on)).toBe(true);
    expect(isInputActive(inputs[3], { ...on, show: false })).toBe(false);
    expect(isInputActive(inputs[0], on)).toBe(true);
  });

  it('parses scriptInputs sent as JSON text', () => {
    expect(parseSavedInputs('{"len":3}')).toEqual({ len: 3 });
    expect(parseSavedInputs('not json')).toEqual({});
    expect(parseSavedInputs({ a: true })).toEqual({ a: true });
    expect(parseSavedInputs(null)).toEqual({});
  });
});

describe('layoutInputs — Pine settings dialog layout', () => {
  it('groups by `group` (at first appearance) and joins `inline` rows', () => {
    const list: ScriptInputDto[] = [
      input({ id: 'a', kind: 'int' }),
      input({ id: 'b', kind: 'int', group: 'MA', inline: 'l1' }),
      input({ id: 'c', kind: 'color', group: 'MA', inline: 'l1', tooltip: 'row tip' }),
      input({ id: 'd', kind: 'bool' }),
      input({ id: 'e', kind: 'int', group: 'MA' }),
    ];
    const sections = layoutInputs(list);
    expect(sections.map((s) => s.group)).toEqual([null, 'MA', null]);
    expect(sections[1].rows.map((r) => r.inputs.map((i) => i.id))).toEqual([['b', 'c'], ['e']]);
    expect(sections[1].rows[0]).toMatchObject({ inline: 'l1', tooltip: 'row tip' });
    expect(sections[2].rows[0].inputs[0].id).toBe('d');
  });
});

describe('color / session / time / timeframe helpers', () => {
  it('parses and formats colors', () => {
    expect(parseColor('#abc')).toEqual({ hex: '#AABBCC', alpha: 255 });
    expect(parseColor('#11223344')).toEqual({ hex: '#112233', alpha: 0x44 });
    expect(parseColor('blue')).toBeNull();
    expect(formatColor({ hex: '#112233', alpha: 128 })).toBe('#11223380');
    expect(alphaToOpacity(255)).toBe(100);
    expect(opacityToAlpha(50)).toBe(128);
    expect(colorToCss('#FF000080')).toBe('rgba(255, 0, 0, 0.502)');
  });

  it('parses and formats sessions', () => {
    expect(parseSession('0930-1600:23456')).toEqual({ start: '09:30', end: '16:00', days: '23456' });
    expect(parseSession('24x7')).toEqual({ start: '00:00', end: '00:00', days: null });
    expect(formatSession({ start: '08:00', end: '17:30', days: '6542' })).toBe('0800-1730:2456');
    expect(formatSession({ start: '08:00', end: '17:30', days: null })).toBe('0800-1730');
  });

  it('converts UTC datetime-local strings and ms', () => {
    const ms = Date.UTC(2025, 0, 2, 3, 4);
    expect(msToUtcInput(ms)).toBe('2025-01-02T03:04');
    expect(utcInputToMs('2025-01-02T03:04')).toBe(ms);
    expect(Number.isNaN(utcInputToMs('bad'))).toBe(true);
  });

  it('labels timeframes and maps the engine timeframes', () => {
    expect(timeframeLabel('60')).toBe('1 hour');
    expect(timeframeLabel('D')).toBe('1 day');
    expect(timeframeLabel('90')).toBe('90 minutes');
    expect(timeframeLabel('480')).toBe('8 hours');
    expect(engineToPineTimeframe('H4')).toBe('240');
    expect(engineToPineTimeframe('D1')).toBe('1D');
  });
});
