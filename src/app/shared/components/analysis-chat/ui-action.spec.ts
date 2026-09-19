import { describe, expect, it } from 'vitest';
import { parseUiAction, describeUiAction } from './ui-action';

/**
 * This parser is the first thing between model output and a command call, so its job is to
 * refuse cleanly rather than to be generous.
 */
describe('parseUiAction', () => {
  it('reads a command with arguments', () => {
    expect(parseUiAction('{"command":"chart.setTimeframe","args":{"timeframe":"240"}}')).toEqual({
      command: 'chart.setTimeframe',
      args: { timeframe: '240' },
    });
  });

  it('reads a command that takes no arguments', () => {
    expect(parseUiAction('{"command":"chart.describe"}')).toEqual({
      command: 'chart.describe',
      args: {},
    });
  });

  it('copies args rather than aliasing them', () => {
    const json = '{"command":"x","args":{"a":1}}';
    const a = parseUiAction(json)!;
    a.args['a'] = 99;
    expect(parseUiAction(json)!.args['a']).toBe(1);
  });

  for (const [label, input] of [
    ['null', null],
    ['empty', ''],
    ['not JSON', '{oops'],
    ['an array', '[1,2]'],
    ['a bare string', '"chart.describe"'],
    ['no command', '{"args":{}}'],
    ['an empty command', '{"command":"   "}'],
    ['a non-string command', '{"command":123}'],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(parseUiAction(input)).toBeNull();
    });
  }

  it('refuses args that are not an object', () => {
    // Malformed, NOT empty. Reading `"args": "timeframe=240"` as {} would run the command
    // with no arguments — a different command than the one proposed.
    expect(parseUiAction('{"command":"x","args":"timeframe=240"}')).toBeNull();
    expect(parseUiAction('{"command":"x","args":[1]}')).toBeNull();
  });

  it('treats an explicit null args as no arguments', () => {
    expect(parseUiAction('{"command":"x","args":null}')).toEqual({ command: 'x', args: {} });
  });

  it('describes a call in one line', () => {
    expect(describeUiAction({ command: 'chart.setTimeframe', args: { timeframe: '240' } })).toBe(
      'chart.setTimeframe timeframe=240',
    );
    expect(describeUiAction({ command: 'chart.describe', args: {} })).toBe('chart.describe');
  });
});
