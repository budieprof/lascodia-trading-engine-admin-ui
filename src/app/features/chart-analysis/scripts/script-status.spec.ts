import { describe, expect, it } from 'vitest';
import type { ScriptInputDto } from '@core/api/scripting.types';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import { toChartScriptResult } from './chart-script.model';
import { chartScriptLayers, sameLayers } from './script-layers';
import { inputsSummary } from './script-status';

const input = (over: Partial<ScriptInputDto> & Pick<ScriptInputDto, 'id' | 'kind'>): ScriptInputDto => ({
  title: over.id,
  defaultValue: null,
  ...over,
});

describe('inputsSummary (PC-I2)', () => {
  const inputs = [
    input({ id: 'len', kind: 'int', defaultValue: 20 }),
    input({ id: 'mult', kind: 'float', defaultValue: 2 }),
    input({ id: 'src', kind: 'source', defaultValue: 'close' }),
    input({ id: 'col', kind: 'color', defaultValue: '#2962FFFF' }),
    input({ id: 'on', kind: 'bool', defaultValue: true }),
    input({ id: 'hidden', kind: 'int', defaultValue: 9, display: 'none' }),
    input({
      id: 'mode',
      kind: 'string',
      defaultValue: 'a',
      options: ['a', 'b'],
      optionTexts: ['Fast', 'Slow'],
    }),
  ];

  it('prints the values an operator reads a study by, as TradingView’s status line does', () => {
    expect(inputsSummary(inputs, {})).toBe('20 2 close Fast');
  });

  it('takes the chart’s overrides over the defaults', () => {
    expect(inputsSummary(inputs, { len: 50, src: 'hl2', mode: 'b' })).toBe('50 2 hl2 Slow');
  });

  it('cuts a long one short', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      input({ id: `s${i}`, kind: 'string', defaultValue: 'longvalue' }),
    );
    const text = inputsSummary(many, {});
    expect(text.length).toBe(60);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('the status line’s label on the chart layers', () => {
  const raw = structuredClone(BOLLINGER_RUN);
  const result = toChartScriptResult(raw);
  const EURUSD = { symbol: 'EURUSD', resolution: '60' as const };
  const run = { item: { key: 'a' }, result, symbol: 'EURUSD', resolution: '60' as const };

  const on = { chart: EURUSD, bars: EURUSD, basis: 'standard' as const, unavailable: null };

  it('carries the page’s title, inputs and failure, and a change of them is a change', () => {
    const label = { title: 'BB', inputs: '20 2', failure: null };
    const a = chartScriptLayers([run], on, () => label);
    expect(a[0].label).toEqual(label);
    const same = chartScriptLayers([run], on, () => ({ ...label }));
    expect(sameLayers(a, same)).toBe(true);
    const failed = chartScriptLayers([run], on, () => ({
      ...label,
      failure: { kind: 'stale', message: 'x', where: null, unit: null, callStack: [], atMs: 0 },
    }));
    expect(sameLayers(a, failed)).toBe(false);
  });

  it('a replay note coming or going is a change (PC-08)', () => {
    const bars = result.run!.bars;
    const last = bars[bars.length - 1].t;
    const atHead = chartScriptLayers([{ ...run, until: last }], { ...on, replayHead: last });
    const behind = chartScriptLayers([{ ...run, until: last }], {
      ...on,
      replayHead: last + 3_600_000,
    });
    expect(behind[0].note).not.toBeNull();
    expect(sameLayers(atHead, behind)).toBe(false);
  });
});
