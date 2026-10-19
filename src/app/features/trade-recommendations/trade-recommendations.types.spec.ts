import { describe, expect, it } from 'vitest';
import {
  recFormatPrice,
  recOutcomeView,
  recParseJson,
  recPips,
  recPrettyJson,
  recSplitReason,
  recTriggerText,
} from './trade-recommendations.types';

describe('recommendation display helpers', () => {
  it('measures pips by instrument family', () => {
    expect(recPips('EURUSD', 1.1214, 1.1232)).toBe(18);
    expect(recPips('USDJPY', 150.25, 149.75)).toBe(50);
    expect(recPips('XAUUSD', 2400, 2390.5)).toBe(95);
    expect(recPips('EURUSD', null, 1.1)).toBeNull();
  });

  it('formats prices to the instrument precision', () => {
    expect(recFormatPrice('EURUSD', 1.1214)).toBe('1.12140');
    expect(recFormatPrice('GBPJPY', 190.1)).toBe('190.100');
    expect(recFormatPrice('EURUSD', null)).toBe('—');
  });

  it('splits a gate code from its detail, and leaves plain reasons alone', () => {
    expect(recSplitReason('[RewardRiskTooLow] Reward:risk is 1.44')).toEqual({
      code: 'RewardRiskTooLow',
      detail: 'Reward:risk is 1.44',
    });
    expect(recSplitReason('Filed by monitor #1220.')).toEqual({
      code: null,
      detail: 'Filed by monitor #1220.',
    });
  });

  it('labels outcomes with a tone', () => {
    expect(recOutcomeView('Won').tone).toBe('good');
    expect(recOutcomeView('Lost').tone).toBe('bad');
    expect(recOutcomeView('Rejected').label).toBe('Refused');
    expect(recOutcomeView('SomethingNew').label).toBe('SomethingNew');
  });

  it('reads a watch trigger written as prose or as the monitor DSL', () => {
    expect(recTriggerText('hourly close below 1.1179')).toBe('hourly close below 1.1179');
    expect(
      recTriggerText({
        v: 2,
        all: [
          { metric: 'close', op: 'below', value: 1.1179 },
          { metric: 'close', op: 'above', value: 1.117 },
        ],
      }),
    ).toBe('close below 1.1179 and close above 1.117');
    expect(
      recTriggerText({
        any: [
          { metric: 'close', op: 'crossesUp', value: 1.2 },
          {
            all: [
              { metric: 'rsi', op: 'lt', value: 30 },
              { metric: 'close', op: 'gt', ref: 'ema50' },
            ],
          },
        ],
      }),
    ).toBe('close crosses above 1.2 or (rsi < 30 and close > ema50)');
    expect(recTriggerText({ odd: true })).toBe('{"odd":true}');
    expect(recTriggerText(null)).toBe('');
  });

  it('parses and pretty-prints JSON without throwing on prose', () => {
    expect(recParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(recParseJson('not json')).toBeNull();
    expect(recPrettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(recPrettyJson('plain text')).toBe('plain text');
  });
});
