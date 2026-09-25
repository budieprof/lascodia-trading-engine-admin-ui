import { describe, it, expect } from 'vitest';

import { StrategyVersionFields, diffStrategyVersion } from './version-diff';

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
