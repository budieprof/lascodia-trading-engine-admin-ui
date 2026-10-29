import { describe, expect, it } from 'vitest';
import type { StrategyVersionDto } from '@core/api/api.types';
import { savedEntries, versionChanges } from './edit-context.logic';

function v(n: number, over: Partial<StrategyVersionDto> = {}): StrategyVersionDto {
  return {
    id: n,
    strategyId: 1,
    versionNumber: n,
    name: 'S',
    description: null,
    parametersJson: '{}',
    riskProfileId: null,
    riskOverridesJson: null,
    sizingConfigJson: null,
    sessionFilterJson: null,
    regimeGateJson: null,
    multiTimeframeGateJson: null,
    capturedAt: '2026-10-01T00:00:00Z',
    changeReason: null,
    ...over,
  } as StrategyVersionDto;
}

describe('edit context logic', () => {
  it('flattens a saved sub-config and treats blank as nothing set', () => {
    expect(savedEntries(null)).toEqual([]);
    expect(savedEntries('{}')).toEqual([]);
    expect(
      savedEntries(
        '{"stopLoss":{"mode":"Atr","multiplier":1.5},"allowed":["Trending","Ranging"],"x":null}',
      ),
    ).toEqual([
      { path: 'stopLoss.mode', value: 'Atr' },
      { path: 'stopLoss.multiplier', value: '1.5' },
      { path: 'allowed', value: 'Trending, Ranging' },
    ]);
    expect(savedEntries('not json')[0].path).toBe('(raw)');
  });

  it('labels what each version changed against the one before it', () => {
    const out = versionChanges([
      v(1),
      v(3, { sizingConfigJson: '{"riskPct":1}', regimeGateJson: '{"a":1}' }),
      v(2, { sizingConfigJson: '{"riskPct":1}' }),
    ]);
    expect(out.map((c) => c.version.versionNumber)).toEqual([3, 2, 1]);
    expect(out[0].changed).toEqual(['Regime gate']);
    expect(out[1].changed).toEqual(['Sizing']);
    expect(out[2].changed).toEqual([]);
  });
});
