import { describe, expect, it } from 'vitest';

import { intrabarEvidence, manifestView } from './run-manifest.model';

describe('run manifest (C9)', () => {
  const manifest = {
    schema: 1,
    runId: 900,
    rerunOfRunId: 812,
    elapsedMs: 12_500,
    engine: {
      buildId: 'mvid',
      informationalVersion: '1.0+cfefbf53',
      sourceRevision: 'cfefbf53',
      role: 'research',
    },
    simulator: 'script',
    scriptRuntimeVersion: 'pine-rt-7',
    strategy: {
      strategyConfigHash: 'c'.repeat(64),
      symbol: 'EURUSD',
      timeframe: 'H1',
      fromUtc: '2024-09-30T00:00:00Z',
      toUtc: '2026-10-01T00:00:00Z',
      initialBalance: 10000,
    },
    libraries: [{ publisher: 'lascodia', name: 'risk', version: 3, sourceSha256: 'x' }],
    data: {
      fingerprint: 'f'.repeat(64),
      series: [
        { key: 'EURUSD:H1', count: 12000, firstMs: 0, lastMs: 3_600_000, sha256: 'e'.repeat(64) },
      ],
    },
    costs: {
      costModel: 'Snapshot',
      calibration: { mode: 'PointInTime', brokerKey: '*', fitVersion: 'v1' },
    },
    config: {
      hash: 'h'.repeat(64),
      keys: { 'Backtest:Evidence:IntrabarResolution': 'Pessimistic', 'A:B': '1' },
    },
  };

  it('reads engine, strategy, data and costs; libraries, series and config keys', () => {
    const v = manifestView(JSON.stringify(manifest))!;
    const section = (t: string) =>
      Object.fromEntries(
        v.sections.find((s) => s.title === t)!.rows.map((r) => [r.label, r.value]),
      );
    expect(section('Engine')['Build']).toBe('1.0+cfefbf53');
    expect(section('Engine')['Elapsed']).toBe('12.5 s');
    expect(section('Strategy')['Configuration (C1)']).toBe('c'.repeat(64));
    expect(section('Strategy')['Window (UTC)']).toBe('2024-09-30 → 2026-10-01');
    expect(section('Data and costs')['Calibration']).toBe('PointInTime · * · v1');
    expect(v.libraries).toEqual(['lascodia/risk/3']);
    expect(v.series[0].count).toBe(12000);
    expect(v.configKeys.map((k) => k.key)).toEqual(['A:B', 'Backtest:Evidence:IntrabarResolution']);
    expect(v.rerunOfRunId).toBe(812);
  });

  it('is null without a manifest', () => {
    expect(manifestView(null)).toBeNull();
    expect(manifestView('not json')).toBeNull();
  });
});

describe('intrabar evidence (C3)', () => {
  it('reads PascalCase result fields as fractions', () => {
    const e = intrabarEvidence(
      JSON.stringify({
        AmbiguousBars: 73,
        MagnifierCoverage: { Tick: 0, M1: 0.979, Lower: 0.01, Ohlc: 0.011, Bars: 12000 },
        script: { intrabarResolution: 'Pessimistic' },
      }),
    )!;
    expect(e.ambiguousBars).toBe(73);
    expect(e.coverage!.m1).toBe(0.979);
    expect(e.coverage!.bars).toBe(12000);
    expect(e.resolution).toBe('Pessimistic');
  });
  it('is null for a result without any of them (rule runs, old rows)', () => {
    expect(intrabarEvidence(JSON.stringify({ TotalTrades: 3 }))).toBeNull();
  });
});
