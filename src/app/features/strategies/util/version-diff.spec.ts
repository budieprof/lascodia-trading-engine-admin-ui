import { describe, it, expect } from 'vitest';

import {
  StrategyVersionFields,
  diffScriptVersion,
  diffStrategyVersion,
  versionScriptFields,
} from './version-diff';

const base: StrategyVersionFields = {
  name: 'EURUSD H1 Rule',
  description: 'RSI dip',
  parametersJson: JSON.stringify({
    Name: 'x',
    EntryConditionsRoot: {
      Op: 'And',
      Children: [
        {
          Leaf: {
            Type: 'IndicatorThreshold',
            IndicatorThreshold: { Indicator: 'Rsi', Period: 14, Value: 30 },
          },
        },
        { Leaf: { Type: 'PriceVsMa', PriceVsMa: { MaPeriod: 200 } } },
      ],
    },
  }),
  riskProfileId: 3,
  riskOverridesJson: null,
  sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
  sessionFilterJson: '',
  regimeGateJson: null,
  multiTimeframeGateJson: null,
};

describe('diffStrategyVersion', () => {
  it('is empty when nothing changed', () => {
    expect(diffStrategyVersion(base, { ...base })).toEqual([]);
  });

  it('reports a one-number DSL edit as one row, however long the DSL — even re-cased', () => {
    const after = {
      ...base,
      parametersJson: JSON.stringify({
        name: 'x',
        entryConditionsRoot: {
          op: 'And',
          children: [
            {
              leaf: {
                type: 'IndicatorThreshold',
                indicatorThreshold: { indicator: 'Rsi', period: 14, value: 25 },
              },
            },
            { leaf: { type: 'PriceVsMa', priceVsMa: { maPeriod: 200 } } },
          ],
        },
      }),
    };
    const groups = diffStrategyVersion(base, after);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Parameters / rules');
    expect(groups[0].rows).toEqual([
      {
        path: 'parametersJson.entryConditionsRoot.children[0].leaf.indicatorThreshold.value',
        relPath: 'entryConditionsRoot.children[0].leaf.indicatorThreshold.value',
        kind: 'changed',
        before: 30,
        after: 25,
      },
    ]);
  });

  it('groups scalar and sub-config changes by field', () => {
    const groups = diffStrategyVersion(base, {
      ...base,
      name: 'Renamed',
      riskProfileId: null,
      sizingConfigJson: '{"mode":"FixedLot","value":0.2}',
      sessionFilterJson: '{"sessionStartUtc":"08:00"}',
    });
    expect(groups.map((g) => g.field)).toEqual([
      'name',
      'riskProfileId',
      'sizingConfigJson',
      'sessionFilterJson',
    ]);
    expect(groups[0].rows[0]).toMatchObject({
      kind: 'changed',
      relPath: '',
      before: 'EURUSD H1 Rule',
      after: 'Renamed',
    });
    expect(groups[1].rows[0]).toMatchObject({ kind: 'removed', before: 3 });
    expect(groups[2].rows[0]).toMatchObject({ relPath: 'value', before: 0.1, after: 0.2 });
    expect(groups[3].rows[0]).toMatchObject({
      kind: 'added',
      relPath: '',
      after: { sessionStartUtc: '08:00' },
    });
  });
});

describe('diffScriptVersion — PE-02', () => {
  const v1 =
    '//@version=6\nstrategy("S")\nlen = input.int(14, "Length")\nplot(ta.ema(close, len))\n';

  it('a script-only change is a difference, with its lines counted', () => {
    const change = diffScriptVersion(
      { scriptSource: v1, scriptInputs: { Length: 20 } },
      { scriptSource: v1.replace('ta.ema', 'ta.sma'), scriptInputs: { Length: 20 } },
    );
    expect(change).toMatchObject({ sourceChanged: true, added: 1, removed: 1, inputChanges: [] });
  });

  it('an inputs-only change is a difference too, by input id', () => {
    const change = diffScriptVersion(
      { scriptSource: v1, scriptInputs: { Length: 20 } },
      { scriptSource: v1, scriptInputs: { Length: 30 } },
    );
    expect(change?.sourceChanged).toBe(false);
    expect(change?.inputChanges).toEqual([
      { id: 'Length', kind: 'changed', before: 20, after: 30 },
    ]);
  });

  it('inputs are compared as they run when a normaliser is given (defaults dropped)', () => {
    const dropDefault = (v: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(Object.entries(v).filter(([, x]) => x !== 14));
    expect(
      diffScriptVersion(
        { scriptSource: v1, scriptInputs: { Length: 14 } },
        { scriptSource: v1, scriptInputs: {} },
        dropDefault,
      ),
    ).toBeNull();
  });

  it('is null for non-script strategies and identical scripts', () => {
    expect(diffScriptVersion({ scriptSource: null }, { scriptSource: null })).toBeNull();
    expect(diffScriptVersion({ scriptSource: v1 }, { scriptSource: v1 })).toBeNull();
  });

  it('reads a captured version’s stored inputs JSON', () => {
    expect(versionScriptFields({ scriptSource: v1, scriptInputsJson: '{"Length":20}' })).toEqual({
      scriptSource: v1,
      scriptInputs: { Length: 20 },
    });
    expect(versionScriptFields({}).scriptInputs).toBeNull();
  });
});
