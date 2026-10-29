import { describe, expect, it } from 'vitest';

import {
  GENERATOR_SWITCH,
  LAST_CYCLE_MARKER_KEY,
  POLICY_TRAINER_SWITCH,
  ageText,
  datasetStatus,
  nextWiderLookback,
  parseBool,
  stateFromConfigRows,
  summarisePipeline,
  utcText,
  type PipelineState,
} from './composite-ml-pipeline.logic';

const NOW = Date.parse('2026-10-28T18:00:00Z');

function liveLikeState(): PipelineState {
  return {
    generatorEnabled: false,
    generatorSwitchChangedAtUtc: '2026-10-02T00:45:07Z',
    lastCycleAtUtc: '2026-10-02T00:18:25Z',
    lastCycleId: 'c-220',
    lastCycleLayerCount: 15,
    lastCycleLayersEnabled: 11,
    cyclesRecorded: 138,
    strategiesLive: 3,
    strategiesEverGenerated: 108,
    strategiesByStatus: [{ status: 'Paused', count: 3 }],
    switches: [
      {
        key: GENERATOR_SWITCH,
        value: 'false',
        enabled: false,
        lastUpdatedAtUtc: '2026-10-02T00:45:07Z',
      },
      {
        key: POLICY_TRAINER_SWITCH,
        value: 'true',
        enabled: true,
        lastUpdatedAtUtc: '2026-09-12T10:20:22Z',
      },
      {
        key: 'MLCpc:Enabled',
        value: 'false',
        enabled: false,
        lastUpdatedAtUtc: '2026-07-08T17:06:58Z',
      },
    ],
    datasets: [
      {
        key: 'layerStates',
        label: 'Per-cycle layer state',
        producer: 'gen',
        rows: 2070,
        oldestUtc: '2026-09-13T14:02:47Z',
        latestUtc: '2026-10-02T00:18:25Z',
      },
      {
        key: 'generationAudits',
        label: 'Generation decisions',
        producer: 'gen',
        rows: 60,
        oldestUtc: '2026-05-19T10:45:21Z',
        latestUtc: '2026-10-02T00:18:25Z',
      },
      {
        key: 'layerSkill',
        label: 'Layer skill snapshots',
        producer: 'CompositeMLLayerSkillEvaluatorWorker',
        rows: 0,
        oldestUtc: null,
        latestUtc: null,
      },
      {
        key: 'catalogueDrift',
        label: 'Evidence drift snapshots',
        producer: 'drift',
        rows: 12496,
        oldestUtc: '2026-05-10T11:14:44Z',
        latestUtc: '2026-10-28T17:08:22Z',
      },
    ],
    generatedAtUtc: '2026-10-28T18:00:00Z',
  };
}

describe('composite-ml pipeline logic', () => {
  it('parses booleans strictly', () => {
    expect(parseBool(' True ')).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool('D1,H4')).toBeNull();
    expect(parseBool(null)).toBeNull();
  });

  it('classifies datasets as updating, stopped or never written', () => {
    const s = liveLikeState();
    expect(datasetStatus(s.datasets[0], NOW)).toBe('stopped');
    expect(datasetStatus(s.datasets[2], NOW)).toBe('never');
    expect(datasetStatus(s.datasets[3], NOW)).toBe('updating');
  });

  it('formats ages and UTC times', () => {
    expect(ageText('2026-10-02T00:45:07Z', NOW)).toBe('26 days ago');
    expect(ageText('2026-10-28T15:00:00Z', NOW)).toBe('3 h ago');
    expect(ageText(null, NOW)).toBe('—');
    expect(utcText('2026-10-02T00:45:07Z')).toBe('2 Oct 2026 00:45 UTC');
  });

  it('explains an off generator with the real switch, its date and the last cycle', () => {
    const sum = summarisePipeline(liveLikeState(), ['layerSkill'], NOW);
    expect(sum.kind).toBe('off');
    expect(sum.stateLabel).toBe('Generator off');
    expect(sum.detail).toContain('switched off 2 Oct 2026 00:45 UTC');
    expect(sum.detail).toContain('recorded 15 layers (11 enabled)');
    expect(sum.detail).toContain('evidence drift snapshots');
    const labels = sum.requirements.map((r) => r.label);
    expect(labels[0]).toBe('Generator worker switched on');
    expect(sum.requirements[0].ok).toBe(false);
    expect(labels).toContain('Layer skill snapshots');
    const skill = sum.requirements.find((r) => r.label === 'Layer skill snapshots')!;
    expect(skill.ok).toBe(false);
    expect(skill.detail).toContain('CompositeMLLayerSkillEvaluatorWorker');
    expect(labels).toContain('CPC encoder (MLCpc)');
    expect(sum.compactLine).toContain('Generator off since 2 Oct 2026');
    expect(sum.compactLine).toContain('3 of 108 generated strategies remain');
  });

  it('a focus dataset that stopped is neither ok nor missing', () => {
    const sum = summarisePipeline(liveLikeState(), ['layerStates'], NOW);
    const r = sum.requirements.find((x) => x.label === 'Per-cycle layer state')!;
    expect(r.ok).toBeNull();
    expect(r.detail).toContain('2,070 rows');
    expect(sum.datasetRows.find((d) => d.key === 'layerStates')!.focus).toBe(true);
  });

  it('builds a reduced state from config rows when pipeline-state is not deployed', () => {
    const s = stateFromConfigRows(
      {
        [GENERATOR_SWITCH]: {
          key: GENERATOR_SWITCH,
          value: 'false',
          lastUpdatedAt: '2026-10-02T00:45:07Z',
        },
        [POLICY_TRAINER_SWITCH]: null,
        'MLCpc:Enabled': {
          key: 'MLCpc:Enabled',
          value: 'false',
          lastUpdatedAt: '2026-07-08T17:06:58Z',
        },
        [LAST_CYCLE_MARKER_KEY]: {
          key: LAST_CYCLE_MARKER_KEY,
          value: '220',
          lastUpdatedAt: '2026-10-02T00:18:25Z',
        },
      },
      '2026-10-28T18:00:00Z',
    );
    expect(s.generatorEnabled).toBe(false);
    expect(s.lastCycleAtUtc).toBe('2026-10-02T00:18:25Z');
    expect(s.datasets).toEqual([]);
    expect(s.switches.map((x) => x.key)).toEqual([GENERATOR_SWITCH, 'MLCpc:Enabled']);
    const sum = summarisePipeline(s, ['layerSkill'], NOW);
    expect(sum.kind).toBe('off');
    expect(sum.detail).toContain('The last cycle ran 2 Oct 2026 00:18 UTC.');
  });

  it('widens the lookback one step at a time up to the engine limit', () => {
    expect(nextWiderLookback(7)).toBe(30);
    expect(nextWiderLookback(30)).toBe(90);
    expect(nextWiderLookback(90)).toBeNull();
  });
});
