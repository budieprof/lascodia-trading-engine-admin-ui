import { describe, it, expect } from 'vitest';

import {
  MTF_GATE_SCHEMA,
  REGIME_GATE_SCHEMA,
  RISK_OVERRIDES_SCHEMA,
  SESSION_FILTER_SCHEMA,
  SIZING_SCHEMA,
  SubConfigSchema,
  parseSubConfig,
  serializeSubConfig,
} from './sub-config-schema';

const roundTrip = (raw: string, schema: SubConfigSchema) => {
  const p = parseSubConfig(raw, schema);
  return serializeSubConfig(schema, p.values, p.source, p.unrepresentable);
};

describe('sub-config schema round-trip', () => {
  it('reads every RiskOverridesConfig field and writes it back unchanged', () => {
    const raw =
      '{"slMode":"Atr","slMultiplier":1.5,"tpMode":"Pips","tpMultiplier":30,"trailingStopAtrMultiplier":1,"trailingStopAtrPeriod":21,"maxOpenPositions":3}';
    const p = parseSubConfig(raw, RISK_OVERRIDES_SCHEMA);
    expect(p.error).toBeNull();
    expect(p.values).toEqual({
      slMode: 'Atr',
      slMultiplier: 1.5,
      tpMode: 'Pips',
      tpMultiplier: 30,
      trailingStopAtrMultiplier: 1,
      trailingStopAtrPeriod: 21,
      maxOpenPositions: 3,
    });
    expect(roundTrip(raw, RISK_OVERRIDES_SCHEMA)).toBe(raw);
  });

  it('covers every key the engine reads for each column', () => {
    const keys = (s: SubConfigSchema) => s.fields.map((f) => f.key);
    expect(keys(RISK_OVERRIDES_SCHEMA)).toEqual([
      'slMode',
      'slMultiplier',
      'tpMode',
      'tpMultiplier',
      'trailingStopAtrMultiplier',
      'trailingStopAtrPeriod',
      'maxOpenPositions',
    ]);
    expect(keys(SIZING_SCHEMA)).toEqual(['mode', 'value', 'riskPerTradePct', 'atrMultiplier']);
    expect(keys(SESSION_FILTER_SCHEMA)).toEqual([
      'sessionStartUtc',
      'sessionEndUtc',
      'tradeWeekends',
      'newsEmbargoMinutesBefore',
      'newsEmbargoMinutesAfter',
    ]);
    expect(keys(REGIME_GATE_SCHEMA)).toEqual(['allowedRegimes']);
    expect(keys(MTF_GATE_SCHEMA)).toEqual(['timeframe', 'indicator', 'period', 'comparator']);
  });

  it('blank, null and {} are "not configured" and serialise to the empty string', () => {
    for (const raw of ['', '   ', 'null', '{}']) {
      const p = parseSubConfig(raw, SIZING_SCHEMA);
      expect(p.error).toBeNull();
      expect(p.values).toEqual({});
      expect(serializeSubConfig(SIZING_SCHEMA, p.values, p.source)).toBe('');
    }
  });

  it('clearing every field nulls the whole blob', () => {
    const p = parseSubConfig('{"mode":"FixedLot","value":0.1}', SIZING_SCHEMA);
    expect(serializeSubConfig(SIZING_SCHEMA, {}, p.source)).toBe('');
  });

  it('omits unset fields instead of writing null', () => {
    const p = parseSubConfig('{"slMode":"Atr","slMultiplier":1.5}', RISK_OVERRIDES_SCHEMA);
    const out = serializeSubConfig(RISK_OVERRIDES_SCHEMA, { slMode: 'Atr' }, p.source);
    expect(out).toBe('{"slMode":"Atr"}');
  });

  it('preserves unknown keys in place, even when every known field is cleared', () => {
    const raw = '{"mode":"Cash","x_note":"keep me","value":500}';
    const p = parseSubConfig(raw, SIZING_SCHEMA);
    expect(p.unknownKeys).toEqual(['x_note']);
    expect(roundTrip(raw, SIZING_SCHEMA)).toBe(raw);
    expect(serializeSubConfig(SIZING_SCHEMA, { ...p.values, value: 750 }, p.source)).toBe(
      '{"mode":"Cash","x_note":"keep me","value":750}',
    );
    expect(serializeSubConfig(SIZING_SCHEMA, {}, p.source)).toBe('{"x_note":"keep me"}');
  });

  it('reads keys and enum values case-insensitively, writing canonical names', () => {
    const p = parseSubConfig('{"SlMode":"pips","SLMULTIPLIER":20}', RISK_OVERRIDES_SCHEMA);
    expect(p.values).toEqual({ slMode: 'Pips', slMultiplier: 20 });
    expect(serializeSubConfig(RISK_OVERRIDES_SCHEMA, p.values, p.source)).toBe(
      '{"slMode":"Pips","slMultiplier":20}',
    );
  });

  it('maps the legacy sizing mode names the engine still accepts', () => {
    expect(parseSubConfig('{"mode":"PercentEquity"}', SIZING_SCHEMA).values['mode']).toBe(
      'RiskPercentOfEquity',
    );
    expect(parseSubConfig('{"mode":"KellyFraction"}', SIZING_SCHEMA).values['mode']).toBe(
      'BaseLotMultiplier',
    );
  });

  it('keeps a value the form cannot represent verbatim until it is edited', () => {
    const raw = '{"mode":"Martingale","value":2}';
    const p = parseSubConfig(raw, SIZING_SCHEMA);
    expect(p.unrepresentable).toEqual(['mode']);
    expect(roundTrip(raw, SIZING_SCHEMA)).toBe(raw);
    // Editing another field keeps it…
    expect(serializeSubConfig(SIZING_SCHEMA, { value: 3 }, p.source, p.unrepresentable)).toBe(
      '{"mode":"Martingale","value":3}',
    );
    // …replacing it writes the new value in place.
    expect(serializeSubConfig(SIZING_SCHEMA, { mode: 'FixedLot', value: 2 }, p.source, [])).toBe(
      '{"mode":"FixedLot","value":2}',
    );
  });

  it('round-trips session filter and regime gate', () => {
    const session =
      '{"sessionStartUtc":"22:00","sessionEndUtc":"06:00","tradeWeekends":false,"newsEmbargoMinutesBefore":15,"newsEmbargoMinutesAfter":30}';
    expect(roundTrip(session, SESSION_FILTER_SCHEMA)).toBe(session);
    const regime = '{"allowedRegimes":["Trending","Breakout"]}';
    expect(parseSubConfig(regime, REGIME_GATE_SCHEMA).values['allowedRegimes']).toEqual([
      'Trending',
      'Breakout',
    ]);
    expect(roundTrip(regime, REGIME_GATE_SCHEMA)).toBe(regime);
    // An empty allowlist is no gate.
    expect(serializeSubConfig(REGIME_GATE_SCHEMA, { allowedRegimes: [] }, null)).toBe('');
  });

  it('reports malformed JSON and non-objects without throwing', () => {
    expect(parseSubConfig('{"mode":', SIZING_SCHEMA).error).toMatch(/Not valid JSON/);
    expect(parseSubConfig('[1,2]', SIZING_SCHEMA).error).toMatch(/JSON object/);
  });

  it('mirrors the engine MTF gate rules: all four fields, a higher timeframe', () => {
    const ctx = { strategyTimeframe: 'H1' };
    expect(MTF_GATE_SCHEMA.problems!({}, ctx)).toEqual([]);
    expect(MTF_GATE_SCHEMA.problems!({ timeframe: 'D1' }, ctx)[0]).toMatch(
      /missing: indicator, period, comparator/,
    );
    expect(
      MTF_GATE_SCHEMA.problems!(
        { timeframe: 'M15', indicator: 'EMA', period: 200, comparator: 'PriceAbove' },
        ctx,
      ),
    ).toEqual(["M15 is not higher than the strategy's timeframe H1."]);
    const p = parseSubConfig(
      '{"timeframe":"d1","indicator":"ema","period":200,"comparator":"priceabove"}',
      MTF_GATE_SCHEMA,
    );
    expect(p.values).toEqual({
      timeframe: 'D1',
      indicator: 'EMA',
      period: 200,
      comparator: 'PriceAbove',
    });
  });

  it('mirrors the sizing and session rules', () => {
    expect(SIZING_SCHEMA.problems!({ value: 1 }, {})[0]).toMatch(/mode is required/);
    expect(SIZING_SCHEMA.problems!({ mode: 'AtrBased', riskPerTradePct: 1 }, {})).toEqual([
      'Stop distance (× ATR) is required for ATR-based sizing.',
    ]);
    expect(SESSION_FILTER_SCHEMA.problems!({ sessionStartUtc: '08:00' }, {})[0]).toMatch(/both/);
    expect(
      SESSION_FILTER_SCHEMA.problems!({ sessionStartUtc: '08:00', sessionEndUtc: '08:00' }, {})[0],
    ).toMatch(/empty/);
  });
});
